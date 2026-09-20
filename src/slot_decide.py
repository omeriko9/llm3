"""Decision calls ("local Jev") for the llm3 slot proxy.

A decision call asks the model to select one answer from a known list. The
model writes no text. The proxy sends one chat completion with max_tokens=1,
reads the log-probabilities of the first output token, and returns one
probability for each answer.

Each answer gets a one-letter label (A, B, C, ...). The prompt ends at the
position where the model gives the label, so the first output token is the
decision. The label map stays here: the caller sends answer names and gets
answer names.

Two methods, selected from what the backend returns:

  * "logprobs": the response carries choices[0].logprobs.content[0].top_logprobs.
    llama-server gives this as a standard function. mlx-dspark gives it in the
    dspark and baseline modes, and in the dflash mode only through
    src/mlx-dspark-shim.py (see docs/DECIDE_ENDPOINT.md).
  * "greedy": the response has no logprobs. The first token is the decision and
    there are no probabilities. With rotations > 1 the votes are counted.

This module has no I/O. src/slot-api-proxy.py owns the HTTP side. It must stay
compatible with Python 3.9, which is what the proxy runs on.
"""

import json
import math

LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
MAX_CHOICES = len(LABELS)
DEFAULT_TOP_LOGPROBS = 20
MAX_TOP_LOGPROBS = 100
MAX_ROTATIONS = 8
# log-odds are clipped to this range, so a probability of 1.0 stays finite.
LOG_ODDS_LIMIT = 30.0


class DecideError(ValueError):
    """A request that the caller must correct (HTTP 400)."""


def parse_request(payload) -> dict:
    if not isinstance(payload, dict):
        raise DecideError("The body must be a JSON object.")
    question = str(payload.get("question") or "").strip()
    if not question:
        raise DecideError("'question' is required.")
    raw = payload.get("choices")
    if isinstance(raw, list):
        raw = {str(name): str(name) for name in raw}
    if not isinstance(raw, dict) or len(raw) < 2:
        raise DecideError("'choices' must be an object or a list with a minimum of 2 entries.")
    if len(raw) > MAX_CHOICES:
        raise DecideError(
            f"One call holds a maximum of {MAX_CHOICES} choices. Use two levels for more."
        )
    choices = {}
    for name, meaning in raw.items():
        name = str(name).strip()
        if not name:
            raise DecideError("A choice name must not be empty.")
        choices[name] = str(meaning if meaning not in (None, "") else name).strip()
    if len(choices) != len(raw):
        raise DecideError("The choice names must be different from each other.")

    def bounded_int(key, fallback, low, high):
        value = payload.get(key)
        if value in (None, ""):
            return fallback
        try:
            number = int(value)
        except (TypeError, ValueError):
            raise DecideError(f"'{key}' must be an integer.")
        return max(low, min(high, number))

    return {
        "context": str(payload.get("context") or "").strip(),
        "question": question,
        "choices": choices,
        "rotations": bounded_int("rotations", 1, 1, min(MAX_ROTATIONS, len(choices))),
        "top_logprobs": bounded_int("top_logprobs", DEFAULT_TOP_LOGPROBS, len(choices), MAX_TOP_LOGPROBS),
        "model": str(payload.get("model") or "").strip(),
    }


def rotation_orders(names, rotations: int):
    """The answer orders for each call. Spread the start points across the list."""
    orders = []
    for index in range(rotations):
        shift = (index * len(names)) // rotations
        orders.append(names[shift:] + names[:shift])
    return orders


def build_prompt(context: str, question: str, order, choices: dict) -> str:
    lines = "\n".join(f"{label} = {choices[name]}" for label, name in zip(LABELS, order))
    head = f"{context}\n\n" if context else ""
    # The ending matters. "Return only the label.\nLabel:" made Gemma 4 echo the
    # word "Label" as its first token on long prompts: measured label coverage
    # 0.35 (minimum 0.00) against 1.00 with this wording, and 0.90 against 0.99
    # on Qwen3.8. Do not end the prompt with a word the model can repeat.
    return (
        f"{head}Question:\n{question}\n\n"
        f"Allowed labels:\n{lines}\n\n"
        "Reply with exactly one letter from the allowed labels and nothing else."
    )


def build_backend_body(model: str, prompt: str, top_logprobs: int, pin_slot: int = -1) -> bytes:
    """`pin_slot` >= 0 adds llama-server's `id_slot` (see DECIDE_ENDPOINT.md,
    "Decision calls and the prompt cache"). Other backends ignore the key."""
    body = {
        "model": model or "default",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 1,
        "temperature": 0,
        "stream": False,
        "logprobs": True,
        "top_logprobs": top_logprobs,
        # The first token must be the label, so the thinking mode must be off.
        # mlx-dspark reads the top-level key, llama-server reads the kwargs.
        "enable_thinking": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if pin_slot >= 0:
        body["id_slot"] = pin_slot
    return json.dumps(body, ensure_ascii=False).encode("utf-8")


def _label_of(token_text, labels: str):
    text = str(token_text or "").strip()
    return text if len(text) == 1 and text in labels else None


def read_response(response_json, labels: str) -> dict:
    """Pull the first-token data out of one chat completion.

    Returns {"first": label or None, "mass": {label: probability} or None,
    "floor": probability}. "mass" is None when the backend gave no logprobs.
    "A" and " A" are different tokens for some tokenizers, so their
    probabilities are added.
    """
    choice = ((response_json or {}).get("choices") or [{}])[0] or {}
    message = choice.get("message") or {}
    first = _label_of(message.get("content"), labels)
    content = ((choice.get("logprobs") or {}).get("content") or [])
    entries = (content[0] or {}).get("top_logprobs") if content else None
    if not entries:
        return {"first": first, "mass": None, "floor": 0.0}
    mass = {}
    lowest = 1.0
    for entry in entries:
        try:
            probability = math.exp(float(entry.get("logprob")))
        except (TypeError, ValueError, OverflowError):
            continue
        lowest = min(lowest, probability)
        label = _label_of(entry.get("token"), labels)
        if label:
            mass[label] = mass.get(label, 0.0) + probability
    return {"first": first, "mass": mass, "floor": lowest}


def _log_odds(probability: float) -> float:
    if probability <= 0.0:
        return -LOG_ODDS_LIMIT
    if probability >= 1.0:
        return LOG_ODDS_LIMIT
    value = math.log(probability / (1.0 - probability))
    return max(-LOG_ODDS_LIMIT, min(LOG_ODDS_LIMIT, value))


def combine(names, orders, readings) -> dict:
    """Merge one reading for each rotation into the response body."""
    if any(reading["mass"] is None for reading in readings):
        return _combine_greedy(names, orders, readings)

    totals = {name: 0.0 for name in names}
    floored = set()
    coverage = 1.0
    for order, reading in zip(orders, readings):
        labels = LABELS[: len(order)]
        mass = reading["mass"]
        coverage = min(coverage, sum(mass.get(label, 0.0) for label in labels))
        # A label that is not in the top list has a probability below the
        # lowest listed one. Use that bound, not zero: zero makes every strong
        # answer an identical 1.0 and removes the sort order of a ranking.
        values = {}
        for label, name in zip(labels, order):
            if label in mass:
                values[name] = mass[label]
            else:
                values[name] = reading["floor"]
                floored.add(name)
        total = sum(values.values()) or 1.0
        for name in order:
            totals[name] += values[name] / total / len(orders)

    ranked = sorted(names, key=lambda name: totals[name], reverse=True)
    return {
        "method": "logprobs",
        "choice": ranked[0],
        "margin": round(totals[ranked[0]] - totals[ranked[1]], 6),
        "probabilities": {name: round(totals[name], 6) for name in names},
        "log_odds": {name: round(_log_odds(totals[name]), 4) for name in names},
        "coverage": round(coverage, 6),
        "floored": sorted(floored),
        "rotations": len(orders),
    }


def _combine_greedy(names, orders, readings) -> dict:
    votes = {name: 0 for name in names}
    for order, reading in zip(orders, readings):
        labels = LABELS[: len(order)]
        if reading["first"] and reading["first"] in labels:
            votes[order[labels.index(reading["first"])]] += 1
    ranked = sorted(names, key=lambda name: votes[name], reverse=True)
    winner = ranked[0] if votes[ranked[0]] > 0 else None
    return {
        "method": "greedy",
        "choice": winner,
        "margin": None,
        "probabilities": None,
        "log_odds": None,
        "coverage": None,
        "floored": [],
        "votes": votes,
        "rotations": len(orders),
    }
