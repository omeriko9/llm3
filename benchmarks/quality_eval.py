#!/usr/bin/env python3
"""Quality evaluator for chat-completion endpoints.

Loads benchmark questions directly from Hugging Face datasets and evaluates
them against a local OpenAI-compatible API endpoint.

Tasks: mmlu_stem / mmlu_social_sciences / mmlu_humanities (balanced sampling
across the canonical MMLU subject lists), hellaswag, arc_challenge, gsm8k.
"""
from __future__ import annotations

import argparse
import http.client
import json
import socket
import os
import re
import sys
import time
from pathlib import Path


LETTER_CHOICES = ("A", "B", "C", "D")
# MMLU-Pro ships up to ten options per question, which is most of why it
# separates models that all sit at 0.9+ on the four-option sets.
EXTENDED_LETTER_CHOICES = ("A", "B", "C", "D", "E", "F", "G", "H", "I", "J")

# Canonical MMLU subject taxonomy (Hendrycks et al. / lm-evaluation-harness).
# The previous lists mixed categories and contained subjects that do not exist
# in the dataset, and sampling drained the limit from the first subject only.
MMLU_CATEGORIES = {
    "mmlu_stem": [
        "abstract_algebra", "anatomy", "astronomy", "college_biology",
        "college_chemistry", "college_computer_science", "college_mathematics",
        "college_physics", "computer_security", "conceptual_physics",
        "electrical_engineering", "elementary_mathematics",
        "high_school_biology", "high_school_chemistry",
        "high_school_computer_science", "high_school_mathematics",
        "high_school_physics", "high_school_statistics", "machine_learning",
    ],
    "mmlu_social_sciences": [
        "econometrics", "high_school_geography",
        "high_school_government_and_politics", "high_school_macroeconomics",
        "high_school_microeconomics", "high_school_psychology",
        "human_sexuality", "professional_psychology", "public_relations",
        "security_studies", "sociology", "us_foreign_policy",
    ],
    "mmlu_humanities": [
        "formal_logic", "high_school_european_history",
        "high_school_us_history", "high_school_world_history",
        "international_law", "jurisprudence", "logical_fallacies",
        "moral_disputes", "moral_scenarios", "philosophy", "prehistory",
        "professional_law", "world_religions",
    ],
}


def build_multiple_choice_prompt(
    question: str,
    options: list[str],
    instruction: str | None = None,
    letters: tuple[str, ...] = LETTER_CHOICES,
) -> str:
    usable = [str(option).strip() for option in options[: len(letters)]]
    lines = [question.strip(), ""]
    for index, option in enumerate(usable):
        lines.append(f"{letters[index]}. {option}")
    lines.append("")
    if instruction:
        lines.append(instruction)
    elif len(usable) > 1:
        lines.append(f"Reply with only one letter: {', '.join(letters[:len(usable) - 1])}, or {letters[len(usable) - 1]}.")
    return "\n".join(lines)


def load_datasets_module():
    try:
        import datasets

        return datasets
    except ImportError:
        print(
            "ERROR: datasets library not installed (pip install -r benchmarks/requirements.txt)",
            file=sys.stderr,
        )
        return None


def load_mmlu_examples(task_name: str, limit: int) -> list[tuple[str, str, str]]:
    """Load MMLU examples balanced across the category's subjects."""
    if task_name not in MMLU_CATEGORIES:
        print(f"ERROR: unknown MMLU task: {task_name}", file=sys.stderr)
        return []

    subset_names = MMLU_CATEGORIES[task_name]
    wanted = set(subset_names)

    datasets = load_datasets_module()
    if datasets is None:
        return []

    ds = datasets.load_dataset("cais/mmlu", "all", split="test")

    # One pass over the dataset, bucketed per subject, so the sample is spread
    # across the whole category instead of draining the first subject.
    per_subject_cap = max(1, -(-limit // len(subset_names)))  # ceil division
    buckets: dict[str, list[tuple[str, str, str]]] = {name: [] for name in subset_names}
    for ex in ds:
        subject = str(ex.get("subject") or "")
        if subject not in wanted:
            continue
        bucket = buckets[subject]
        if len(bucket) >= per_subject_cap:
            continue
        question = str(ex["question"]).strip()
        choices = ex["choices"]
        answer_idx = int(ex["answer"])
        answer_letter = LETTER_CHOICES[answer_idx] if 0 <= answer_idx < len(LETTER_CHOICES) else None
        if question and answer_letter and len(choices) >= 4:
            prompt = build_multiple_choice_prompt(question, list(choices)[:4])
            bucket.append((prompt, answer_letter, "letter"))

    # Round-robin across subjects until the limit is reached.
    examples: list[tuple[str, str, str]] = []
    for depth in range(per_subject_cap):
        for name in subset_names:
            bucket = buckets[name]
            if depth < len(bucket):
                examples.append(bucket[depth])
                if len(examples) >= limit:
                    return examples
    return examples[:limit]


def load_hellaswag_examples(limit: int) -> list[tuple[str, str, str]]:
    datasets = load_datasets_module()
    if datasets is None:
        return []

    ds = datasets.load_dataset("Rowan/hellaswag", split="validation")
    examples = []

    for ex in ds:
        label_raw = ex.get("label")
        try:
            answer_idx = int(label_raw)
        except (TypeError, ValueError):
            continue
        endings = [str(item).strip() for item in (ex.get("endings") or [])[:4]]
        if len(endings) != 4 or answer_idx < 0 or answer_idx >= 4:
            continue
        context = " ".join(
            part.strip()
            for part in [str(ex.get("activity_label") or "").strip(), str(ex.get("ctx") or "").strip()]
            if part and part.strip()
        ).strip()
        if not context:
            continue
        prompt = build_multiple_choice_prompt(
            "Choose the most plausible continuation.\n\n" + context,
            endings,
        )
        examples.append((prompt, LETTER_CHOICES[answer_idx], "letter"))
        if len(examples) >= limit:
            break

    return examples


MMLU_PRO_CATEGORIES = (
    "biology", "business", "chemistry", "computer science", "economics",
    "engineering", "health", "history", "law", "math", "other",
    "philosophy", "physics", "psychology",
)


def load_mmlu_pro_examples(limit: int) -> list[tuple[str, str, str]]:
    """MMLU-Pro, sampled round-robin across all 14 categories.

    Replaces HellaSwag, which had saturated the way ARC-Challenge did before
    it: 9 of 13 recorded rows scored 0.9 or above, so the column ranked
    nothing. MMLU-Pro asks the same multiple-choice shape with up to ten
    options and harder, reasoning-heavy questions.
    """
    datasets = load_datasets_module()
    if datasets is None:
        return []

    ds = datasets.load_dataset("TIGER-Lab/MMLU-Pro", split="test")
    per_category_cap = max(1, -(-limit // len(MMLU_PRO_CATEGORIES)))
    buckets: dict[str, list[tuple[str, str, str]]] = {name: [] for name in MMLU_PRO_CATEGORIES}

    for ex in ds:
        category = str(ex.get("category") or "").strip().lower()
        bucket = buckets.get(category)
        if bucket is None or len(bucket) >= per_category_cap:
            continue
        question = str(ex.get("question") or "").strip()
        options = [str(item).strip() for item in (ex.get("options") or []) if str(item).strip()]
        answer = str(ex.get("answer") or "").strip().upper()
        if not question or len(options) < 2 or answer not in EXTENDED_LETTER_CHOICES:
            continue
        if EXTENDED_LETTER_CHOICES.index(answer) >= len(options):
            continue
        prompt = build_multiple_choice_prompt(question, options, letters=EXTENDED_LETTER_CHOICES)
        bucket.append((prompt, answer, "letter10"))

    examples: list[tuple[str, str, str]] = []
    for depth in range(per_category_cap):
        for name in MMLU_PRO_CATEGORIES:
            bucket = buckets[name]
            if depth < len(bucket):
                examples.append(bucket[depth])
                if len(examples) >= limit:
                    return examples
    return examples[:limit]


MATH500_SUBJECTS = (
    "Algebra", "Counting & Probability", "Geometry", "Intermediate Algebra",
    "Number Theory", "Prealgebra", "Precalculus",
)
MATH500_LEVELS = (1, 2, 3, 4, 5)


def load_math500_examples(limit: int) -> list[tuple[str, str, str]]:
    """MATH-500, sampled round-robin across its seven subjects.

    Added because every multiple-choice metric here is saturating and none of
    them move when thinking is switched on. Competition maths does both: it has
    headroom on this fleet and it is the metric a reasoning phase actually
    changes, which is what makes the think / no-think rows worth comparing.
    """
    datasets = load_datasets_module()
    if datasets is None:
        return []

    ds = datasets.load_dataset("HuggingFaceH4/MATH-500", split="test")
    # Sampled across subject AND difficulty. Taking the first N of each subject
    # drew whatever order the dataset happens to be in, and MATH-500's
    # discriminating power is in levels 4 and 5 -- a sample that skews easy
    # measures arithmetic, not reasoning.
    keys = [(subject, level) for subject in MATH500_SUBJECTS for level in MATH500_LEVELS]
    per_bucket_cap = max(1, -(-limit // len(keys)))
    buckets: dict[tuple[str, int], list[tuple[str, str, str]]] = {key: [] for key in keys}

    for ex in ds:
        key = (str(ex.get("subject") or "").strip(), int(ex.get("level") or 0))
        bucket = buckets.get(key)
        if bucket is None or len(bucket) >= per_bucket_cap:
            continue
        problem = str(ex.get("problem") or "").strip()
        answer = str(ex.get("answer") or "").strip()
        if not problem or not answer:
            continue
        bucket.append((problem, answer, "math"))

    # Hardest first within each pass, so a sample cut short by the limit is
    # still a hard one rather than the easy tail of every subject.
    examples: list[tuple[str, str, str]] = []
    for depth in range(per_bucket_cap):
        for level in reversed(MATH500_LEVELS):
            for subject in MATH500_SUBJECTS:
                bucket = buckets[(subject, level)]
                if depth < len(bucket):
                    examples.append(bucket[depth])
                    if len(examples) >= limit:
                        return examples
    return examples[:limit]


# MATH-500 answers are LaTeX fragments, so "3/2", "\frac{3}{2}" and "\dfrac 3 2"
# are the same answer written three ways. Normalizing both sides is the
# difference between measuring maths and measuring formatting.
_MATH_STRIP_PATTERNS = (
    (re.compile(r"\\left|\\right|\\!|\\,|\\;|\\ "), ""),
    (re.compile(r"\\d?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}"), r"(\1)/(\2)"),
    (re.compile(r"\\d?frac\s*(\d)\s*(\d)"), r"(\1)/(\2)"),
    (re.compile(r"\\(?:text|mbox|mathrm)\s*\{([^{}]*)\}"), r"\1"),
    (re.compile(r"\\sqrt\s*\{([^{}]+)\}"), r"sqrt(\1)"),
    (re.compile(r"[\\$\s]"), ""),
    (re.compile(r"^\((.*)\)$"), r"\1"),
)


def normalize_math_answer(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = text.replace("\\%", "").replace("%", "")
    text = re.sub(r"\\boxed\s*\{(.*)\}", r"\1", text, flags=re.DOTALL)
    text = text.replace("^{\\circ}", "").replace("^\\circ", "")
    text = re.sub(r"\\?(?:dollar|,)", "", text)
    for pattern, replacement in _MATH_STRIP_PATTERNS:
        text = pattern.sub(replacement, text)
    text = text.rstrip(".")
    # 0.50 and .5 and 1/2 are all the same number; compare numerically when both
    # sides parse, and fall back to the normalized string when they do not.
    return text.lower()


def math_answers_equal(left: str | None, right: str | None) -> bool:
    normalized_left = normalize_math_answer(left)
    normalized_right = normalize_math_answer(right)
    if not normalized_left or not normalized_right:
        return False
    if normalized_left == normalized_right:
        return True
    try:
        return abs(float(eval_simple_fraction(normalized_left)) - float(eval_simple_fraction(normalized_right))) < 1e-6
    except Exception:
        return False


def eval_simple_fraction(text: str) -> float:
    """Parse the handful of shapes normalize_math_answer can leave behind.

    Deliberately not eval(): the strings come from a model, and a benchmark
    grader is the last place to hand one an interpreter.
    """
    cleaned = str(text or "").replace("(", "").replace(")", "")
    if re.fullmatch(r"-?\d+(?:\.\d+)?/-?\d+(?:\.\d+)?", cleaned):
        numerator, _, denominator = cleaned.partition("/")
        return float(numerator) / float(denominator)
    return float(cleaned)


def extract_math_answer(text: str, *, truncated: bool = False) -> str | None:
    content = strip_think_blocks(str(text or ""))
    if not content.strip():
        return None
    boxed = re.findall(r"\\boxed\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}", content)
    if boxed:
        return boxed[-1].strip()
    labelled = re.findall(r"(?:answer|Answer)\s*[:=]\s*(.+)", content)
    if labelled:
        return labelled[-1].strip().split("\n")[0].strip()
    if truncated:
        return None
    tail = content.strip().split("\n")[-1].strip()
    return tail or None


def normalize_arc_answer_key(answer_key: str) -> str | None:
    value = str(answer_key or "").strip().upper()
    numeric_map = {"1": "A", "2": "B", "3": "C", "4": "D"}
    if value in LETTER_CHOICES:
        return value
    return numeric_map.get(value)


def load_arc_challenge_examples(limit: int) -> list[tuple[str, str, str]]:
    datasets = load_datasets_module()
    if datasets is None:
        return []

    ds = datasets.load_dataset("allenai/ai2_arc", "ARC-Challenge", split="validation")
    examples = []

    for ex in ds:
        question = str(ex.get("question") or "").strip()
        choices = ex.get("choices") or {}
        labels = [str(item).strip().upper() for item in (choices.get("label") or [])]
        texts = [str(item).strip() for item in (choices.get("text") or [])]
        answer = normalize_arc_answer_key(ex.get("answerKey"))
        if not question or len(labels) != len(texts) or not answer:
            continue

        label_to_text = {label: text for label, text in zip(labels, texts) if label and text}
        if not all(label in label_to_text for label in LETTER_CHOICES):
            continue
        if answer not in LETTER_CHOICES:
            continue

        ordered_choices = [label_to_text[label] for label in LETTER_CHOICES]
        prompt = build_multiple_choice_prompt(question, ordered_choices)
        examples.append((prompt, answer, "letter"))
        if len(examples) >= limit:
            break

    return examples


def extract_gsm8k_answer(answer_text: str) -> str | None:
    match = re.search(r"####\s*([-+]?[\d,\.]+)", str(answer_text or ""))
    if not match:
        return None
    return match.group(1).replace(",", "").strip().rstrip(".")


def load_gsm8k_examples(limit: int) -> list[tuple[str, str, str]]:
    datasets = load_datasets_module()
    if datasets is None:
        return []

    ds = datasets.load_dataset("openai/gsm8k", "main", split="test")
    examples = []

    for ex in ds:
        question = str(ex.get("question") or "").strip()
        answer = extract_gsm8k_answer(ex.get("answer"))
        if not question or answer is None:
            continue
        prompt = (
            f"{question}\n\n"
            "Work the problem out briefly, then give the final numeric answer on the "
            "last line in exactly this form:\nAnswer: <number>"
        )
        examples.append((prompt, answer, "number"))
        if len(examples) >= limit:
            break

    return examples


TRANSLATION_DIR = Path(__file__).resolve().parent / "translation"
TRANSLATION_SOURCE_PATH = TRANSLATION_DIR / "source_en.txt"
TRANSLATION_REFERENCE_PATH = TRANSLATION_DIR / "reference_he.txt"
# Replaced arc_challenge, which had saturated: 31 of 36 recorded rows scored
# exactly 1.000 and the whole spread was 0.900-1.000, so it separated nothing.
TRANSLATION_TASK = "hebrew_translation"
TRANSLATION_MAX_TOKENS = 2048
TRANSLATION_SYSTEM_PROMPT = (
    "You are a professional English-to-Hebrew translator. Reply with the Hebrew "
    "translation only: no transliteration, no commentary, no English, and no "
    "markdown. Preserve the paragraph structure of the source exactly."
)


def run_translation_task(
    url: str,
    model_id: str,
    *,
    request_timeout: float,
    disable_thinking: bool,
) -> dict:
    """Translate a fixed English passage to Hebrew and score it against a fixed
    reference with chrF. The stored text is what the UI shows side by side; the
    score exists so the results column can still sort."""
    from chrf import chrf_score, hebrew_ratio

    source = TRANSLATION_SOURCE_PATH.read_text(encoding="utf-8").strip()
    reference = TRANSLATION_REFERENCE_PATH.read_text(encoding="utf-8").strip()
    prompt = "Translate the following English article into Hebrew.\n\n" + source

    started_at = time.monotonic()
    resp = chat_request(
        url,
        model_id,
        prompt,
        timeout=request_timeout,
        disable_thinking=disable_thinking,
        system_prompt=TRANSLATION_SYSTEM_PROMPT,
        max_tokens=TRANSLATION_MAX_TOKENS,
    )
    elapsed = round(time.monotonic() - started_at, 2)

    translation = ""
    if resp:
        choices = resp.get("choices", [])
        if choices:
            translation = str(choices[0].get("message", {}).get("content") or "").strip()

    score = round(chrf_score(translation, reference), 4) if translation else None
    ratio = round(hebrew_ratio(translation), 4) if translation else 0.0
    return {
        "score": score,
        "chrF": score,
        "hebrewRatio": ratio,
        "translation": translation,
        "sourceChars": len(source),
        "translationChars": len(translation),
        "elapsedSeconds": elapsed,
        "referencePath": str(TRANSLATION_REFERENCE_PATH.relative_to(Path(__file__).resolve().parent)),
        "sourcePath": str(TRANSLATION_SOURCE_PATH.relative_to(Path(__file__).resolve().parent)),
    }


HUMANEVAL_TASK = "humaneval"
# The grader runs model-written Python. It is opt-in for exactly that reason,
# and everything here is about keeping that blast radius small: a fresh
# temporary directory as the cwd, `-I -S` so the interpreter ignores PYTHONPATH,
# user site-packages and the environment generally, a scrubbed env, a hard
# timeout, and the whole process group killed if it overruns. It is a sandbox in
# the sense of a fence, not a jail: a determined program could still touch the
# filesystem or the network, which is why this never runs unless it was asked
# for.
HUMANEVAL_TIMEOUT_SECONDS = 10
HUMANEVAL_OUTPUT_CAP = 4000


def extract_python_code(text: str) -> str:
    content = strip_think_blocks(str(text or ""))
    fenced = re.findall(r"```(?:python|py)?\s*\n(.*?)```", content, flags=re.DOTALL)
    if fenced:
        # Models often narrate, show the answer, then restate it; the last full
        # block is the one they settled on.
        return max(fenced, key=len).strip()
    return content.strip()


def build_humaneval_program(example: dict, completion: str) -> str:
    prompt = str(example.get("prompt") or "")
    entry_point = str(example.get("entry_point") or "")
    test = str(example.get("test") or "")
    code = completion
    # Either the model rewrote the whole function (common) or it returned just
    # the body (also common). Only prepend the stub when the definition is
    # missing, or the file ends up with two copies of the signature.
    if f"def {entry_point}" not in code:
        indented = code if code.startswith((" ", "\t")) else "\n".join(
            f"    {line}" if line.strip() else line for line in code.splitlines()
        )
        code = prompt + "\n" + indented
    return f"{code}\n\n{test}\n\ncheck({entry_point})\n"


def run_humaneval_program(program: str) -> tuple[bool, str]:
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory(prefix="humaneval-") as workdir:
        script_path = Path(workdir) / "candidate.py"
        script_path.write_text(program, encoding="utf-8")
        env = {
            "PATH": "/usr/bin:/bin",
            "HOME": workdir,
            "TMPDIR": workdir,
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        try:
            result = subprocess.run(
                [sys.executable, "-I", "-S", str(script_path)],
                cwd=workdir,
                env=env,
                capture_output=True,
                text=True,
                timeout=HUMANEVAL_TIMEOUT_SECONDS,
                start_new_session=True,
            )
        except subprocess.TimeoutExpired:
            return False, "timeout"
        except Exception as exc:  # noqa: BLE001 - a broken candidate is a failed test, not a crashed run
            return False, f"harness-error: {str(exc)[:120]}"
        if result.returncode == 0:
            return True, ""
        return False, str(result.stderr or result.stdout or "")[-240:]


def run_humaneval_task(url: str, model: str, *, limit: int, request_timeout: int,
                       disable_thinking: bool, max_tokens: int, deadline: float,
                       live_log: Path | None = None) -> dict:
    datasets = load_datasets_module()
    if datasets is None:
        return {"score": None, "missingReason": "datasets-unavailable"}

    ds = datasets.load_dataset("openai/openai_humaneval", split="test")
    examples = [ex for ex in ds][:limit]
    if not examples:
        return {"score": None, "missingReason": "no-examples"}

    passed = 0
    scored = 0
    truncated = 0
    unparsed = 0
    timeouts = 0
    failures: list[dict] = []

    for index, example in enumerate(examples):
        if time.monotonic() > deadline:
            break
        prompt = (
            "Complete this Python function. Reply with the finished function in a single "
            "```python code block and nothing else -- no explanation, no tests.\n\n"
            + str(example.get("prompt") or "")
        )
        resp = chat_request(
            url,
            model,
            prompt,
            timeout=min(request_timeout, max(5, deadline - time.monotonic())),
            disable_thinking=disable_thinking,
            system_prompt="You are a precise Python programmer. Return only code.",
            max_tokens=max_tokens,
        )
        choices = (resp or {}).get("choices") or []
        if not choices:
            unparsed += 1
            scored += 1
            continue
        content = choices[0].get("message", {}).get("content", "")
        if str(choices[0].get("finish_reason") or "") == "length":
            truncated += 1
        completion = extract_python_code(content)
        if not completion:
            unparsed += 1
            scored += 1
            continue
        ok, detail = run_humaneval_program(build_humaneval_program(example, completion))
        scored += 1
        append_live_record(live_log, {
            "ts": time.time(),
            "task": HUMANEVAL_TASK,
            "index": index + 1,
            "total": len(examples),
            "correct": bool(ok),
            "expected": str(example.get("task_id") or ""),
            "answer": "passes tests" if ok else clip(detail, 120),
            "finishReason": str(choices[0].get("finish_reason") or ""),
            "elapsedSeconds": None,
            "question": clip(example.get("prompt"), 700),
            "reply": clip(completion, 700),
        })
        if ok:
            passed += 1
        else:
            if detail == "timeout":
                timeouts += 1
            if len(failures) < 3:
                failures.append({
                    "taskId": str(example.get("task_id") or ""),
                    "detail": detail[:HUMANEVAL_OUTPUT_CAP],
                })
        if (index + 1) % 5 == 0 or index + 1 == len(examples):
            print(f"  [{index + 1}/{len(examples)}] passed={passed}/{scored}", file=sys.stderr)

    return {
        "score": round(passed / scored, 4) if scored else None,
        "requested": len(examples),
        "scored": scored,
        "correct": passed,
        "truncated": truncated,
        "unparsed": unparsed,
        "timeouts": timeouts,
        "failureSamples": failures,
        "complete": scored == len(examples),
    }


# Per-question results, appended as they happen. The task JSON is only written
# when a task finishes, so during a run -- which for a thinking model is tens of
# minutes -- there was no way to see what the model was actually getting wrong.
def append_live_record(path: Path | None, record: dict) -> None:
    if not path:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
    except Exception:
        # Losing the live feed must never take the benchmark down with it.
        pass


def clip(value: object, limit: int) -> str:
    text = str(value or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def load_examples(task_name: str, limit: int) -> list[tuple[str, str, str]]:
    # Before the mmlu_ prefix branch: MMLU-Pro is a separate dataset, and the
    # prefix check would send it to the subject-based MMLU loader.
    if task_name == "mmlu_pro":
        return load_mmlu_pro_examples(limit)
    if task_name.startswith("mmlu_"):
        return load_mmlu_examples(task_name, limit)
    if task_name == "hellaswag":
        return load_hellaswag_examples(limit)
    if task_name == "arc_challenge":
        return load_arc_challenge_examples(limit)
    if task_name == "gsm8k":
        return load_gsm8k_examples(limit)
    if task_name == "math500":
        return load_math500_examples(limit)
    print(f"ERROR: unknown task: {task_name}", file=sys.stderr)
    return []


# Set by chat_request so the caller can tell "slow" from "gone".
LAST_REQUEST_FAILURE = {"reason": ""}
UNREACHABLE_ABORT_STREAK = 3


def chat_request(
    url: str,
    model_id: str,
    prompt: str,
    timeout: float = 30,
    disable_thinking: bool = False,
    *,
    system_prompt: str | None = None,
    max_tokens: int = 256,
) -> dict | None:
    """Send a chat completion request."""
    parsed = re.match(r"(https?://)?([^:/]+)(?::(\d+))?(.*)", url)
    if parsed:
        host = parsed.group(2)
        port = int(parsed.group(3)) if parsed.group(3) else 80
        path = parsed.group(4) or "/v1/chat/completions"
    else:
        return None

    payload = {
        "model": model_id,
        "messages": [
            {
                "role": "system",
                "content": system_prompt
                or "You are a helpful assistant. Reply with only the letter of the correct answer (A, B, C, or D).",
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": False,
    }
    if disable_thinking:
        payload["chat_template_kwargs"] = {"enable_thinking": False}

    body = json.dumps(payload).encode("utf-8")

    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        api_key = str(os.environ.get("BENCHMARK_API_KEY") or "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
            headers["X-API-Key"] = api_key
        conn.request("POST", path, body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read().decode("utf-8")
        return json.loads(data)
    except socket.timeout:
        print("  ERROR: timed out", file=sys.stderr)
        LAST_REQUEST_FAILURE["reason"] = "timeout"
        return None
    except (ConnectionError, OSError) as exc:
        # The endpoint is gone, not slow. Told apart from a timeout because they
        # need opposite responses: a timeout means give it longer, an unreachable
        # server means stop -- every remaining question will fail the same way in
        # milliseconds and record a wrong answer for a model that never saw it.
        print(f"  ERROR: unreachable: {exc}", file=sys.stderr)
        LAST_REQUEST_FAILURE["reason"] = "unreachable"
        return None
    except Exception as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        LAST_REQUEST_FAILURE["reason"] = "error"
        return None
    finally:
        conn.close()


def strip_think_blocks(text: str) -> str:
    return re.sub(r"<think>.*?(?:</think>|$)", " ", str(text or ""), flags=re.IGNORECASE | re.DOTALL)


def extract_letter(text: str, letters: tuple[str, ...] = LETTER_CHOICES) -> str | None:
    """Extract the intended multiple-choice answer from a response.

    The original implementation returned the first A-D character anywhere, so
    "The answer is B" scored as "A" (the 'a' in "answer"). Match standalone
    letters and explicit "answer is X" phrasing instead.
    """
    cleaned = strip_think_blocks(text).strip()
    if not cleaned:
        return None
    letter_class = "".join(letters)
    upper = cleaned.upper()

    # 1a. The whole reply is the letter: "B", "(C)", "D."
    bare = upper.strip(" \t*_\"'`()[].,;:")
    if len(bare) == 1 and bare in letters:
        return bare

    # 1b. Reply opens with a delimited letter: "(C)", "D.", "B) because ...".
    # The delimiter is required: without it, "I think the third one" opened
    # with a valid MMLU-Pro letter and scored as answer I.
    match = re.match(rf"^[\s*_\"'`]*(?:\(([{letter_class}])\)|([{letter_class}])[.):,;])", upper)
    if match:
        return match.group(1) or match.group(2)

    # 2. Explicit phrasing: "the answer is C", "answer: D", "correct option B".
    match = re.search(rf"(?:ANSWER|OPTION|CHOICE)\s*(?:IS|:)?\s*\(?([{letter_class}])\b", upper)
    if match:
        return match.group(1)

    # 3. First standalone letter anywhere — matched case-sensitively on the
    # ORIGINAL text. Searching the uppercased copy made the English article "a"
    # a valid answer, so any prose reply containing "a" scored as "A" ("He
    # picks up a towel and dries off." parsed as A). "A" and "I" are also whole
    # English words in their own right, so they only count here when the reply
    # is short enough to be an answer rather than a sentence about one.
    for match in re.finditer(rf"\b([{letter_class}])\b", cleaned):
        candidate = match.group(1)
        if candidate in {"A", "I"} and len(cleaned.split()) > 3:
            continue
        return candidate
    return None


def extract_number(text: str, *, truncated: bool = False) -> str | None:
    """Extract the final numeric answer from a GSM8K-style response.

    `truncated` marks a reply the server cut off at max_tokens. Such a reply has
    no final answer in it, and the last-number fallback would grab whatever
    digit the model happened to be mid-sentence on ("increased the value by
    150%" scored as 150), turning a token-budget problem into a wrong answer.
    """
    cleaned = strip_think_blocks(text)
    match = re.search(r"ANSWER\s*[:=]\s*\$?([-+]?[\d,]+(?:\.\d+)?)", cleaned, flags=re.IGNORECASE)
    if not match:
        if truncated:
            return None
        numbers = re.findall(r"[-+]?[\d,]+(?:\.\d+)?", cleaned)
        if not numbers:
            return None
        candidate = numbers[-1]
    else:
        candidate = match.group(1)
    return candidate.replace(",", "").strip().rstrip(".")


def numbers_equal(left: str | None, right: str | None) -> bool:
    if left is None or right is None:
        return False
    try:
        return abs(float(left) - float(right)) < 1e-6
    except ValueError:
        return left == right


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--tasks", nargs="+", required=True)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--request-timeout", type=int, default=60, help="Per-request timeout in seconds.")
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--disable-thinking", action="store_true", help="Request non-thinking answers even if the server default enables thinking.")
    # 128 tokens truncated every model that showed its work on GSM8K: measured
    # live on Qwen3.8-27B, 4/8 correct at 128 vs 8/8 at 512 on the same
    # questions, with every miss a finish_reason=length cut-off.
    parser.add_argument("--numeric-max-tokens", type=int, default=512, help="Token budget for numeric (GSM8K-style) answers.")
    # 256 measured verbosity, not knowledge: a thinking model spends the whole
    # budget reasoning and gets cut off before it states a letter. Muse-Glimmer
    # hit the cap on 48 of 60 MMLU-Pro questions and scored 0.18 as a result.
    parser.add_argument("--choice-max-tokens", type=int, default=1024, help="Token budget for multiple-choice answers.")
    # Competition maths needs room to work: 512 truncates a thinking model
    # mid-derivation and scores it as wrong for running out of budget.
    parser.add_argument("--math-max-tokens", type=int, default=2048, help="Token budget for MATH-500 answers.")
    parser.add_argument("--code-max-tokens", type=int, default=1536, help="Token budget for HumanEval completions.")
    parser.add_argument("--live-log", type=Path, default=None, help="Append one JSON line per question as it is scored, for live monitoring.")
    args = parser.parse_args()

    deadline = time.monotonic() + args.timeout
    scores = {}
    artifacts = {}
    diagnostics: dict[str, dict[str, int | bool]] = {}

    for task_name in args.tasks:
        if time.monotonic() > deadline:
            print("TIMEOUT", file=sys.stderr)
            break

        if task_name == HUMANEVAL_TASK:
            print(f"[{task_name}] Running {args.limit} problems (executes model code locally)...", file=sys.stderr)
            try:
                outcome = run_humaneval_task(
                    args.url,
                    args.model,
                    limit=args.limit,
                    request_timeout=args.request_timeout,
                    disable_thinking=args.disable_thinking,
                    max_tokens=args.code_max_tokens,
                    deadline=deadline,
                    live_log=args.live_log,
                )
            except Exception as exc:  # noqa: BLE001 - one task must not sink the run
                print(f"[{task_name}] error: {exc}", file=sys.stderr)
                scores[task_name] = None
                diagnostics[task_name] = {"missingReason": f"error: {str(exc)[:120]}"}
                continue
            scores[task_name] = outcome.get("score")
            diagnostics[task_name] = {key: value for key, value in outcome.items() if key != "score"}
            print(
                f"[{task_name}] Result: {outcome.get('correct')}/{outcome.get('scored')} = {outcome.get('score')} "
                f"(truncated={outcome.get('truncated')} unparsed={outcome.get('unparsed')} timeouts={outcome.get('timeouts')})",
                file=sys.stderr,
            )
            continue

        if task_name == TRANSLATION_TASK:
            print(f"[{task_name}] Translating fixed passage...", file=sys.stderr)
            try:
                outcome = run_translation_task(
                    args.url,
                    args.model,
                    request_timeout=max(args.request_timeout, 120),
                    disable_thinking=args.disable_thinking,
                )
            except Exception as exc:  # noqa: BLE001 - one task must not sink the run
                print(f"[{task_name}] error: {exc}", file=sys.stderr)
                scores[task_name] = None
                continue
            scores[task_name] = outcome["score"]
            artifacts[task_name] = outcome
            print(
                f"[{task_name}] chrF={outcome['score']} hebrew={outcome['hebrewRatio']} "
                f"chars={outcome['translationChars']} elapsed={outcome['elapsedSeconds']}s",
                file=sys.stderr,
            )
            continue

        print(f"[{task_name}] Loading examples...", file=sys.stderr)
        examples = load_examples(task_name, args.limit)
        if not examples:
            print(f"[{task_name}] No examples, skipping.", file=sys.stderr)
            scores[task_name] = None
            continue

        print(f"[{task_name}] Evaluating {len(examples)} examples...", file=sys.stderr)
        correct = 0
        total = 0
        truncated = 0
        unparsed = 0
        no_response = 0
        empty_content = 0
        # Counting unparsed replies told us a model scored badly but never why.
        # Keep the first few verbatim so a suspicious score can be explained
        # (empty content? thinking block? prose with no letter?) instead of
        # re-running the model blind.
        unparsed_samples = []
        task_started_at = time.monotonic()

        attempted = 0
        unreachable_streak = 0
        aborted_reason = ""
        for i, (prompt, answer, kind) in enumerate(examples):
            if time.monotonic() > deadline:
                break
            attempted += 1
            question_started_at = time.monotonic()

            is_numeric = kind == "number"
            is_math = kind == "math"
            letters = EXTENDED_LETTER_CHOICES if kind == "letter10" else LETTER_CHOICES
            if is_numeric or is_math:
                print(
                    f"  [{i+1}/{len(examples)}] starting "
                    f"correct={correct}/{total} elapsed={time.monotonic() - task_started_at:.1f}s",
                    file=sys.stderr,
                )
            resp = chat_request(
                args.url,
                args.model,
                prompt,
                timeout=min(args.request_timeout, max(5, deadline - time.monotonic())),
                disable_thinking=args.disable_thinking,
                system_prompt=(
                    # Competition maths answers are expressions, not numbers, so
                    # this asks for the convention the dataset itself uses.
                    "Solve the problem. Give the final answer on its own line in the form "
                    "'Answer: <answer>', using LaTeX only where the answer needs it."
                    if is_math
                    else "Solve the problem silently and reply with only the final numeric answer "
                    "in the exact form 'Answer: <number>'."
                    if is_numeric
                    # The default system prompt names A-D, which would tell a
                    # ten-option MMLU-Pro question to answer outside its own
                    # choices.
                    else f"You are a helpful assistant. Reply with only the letter of the correct answer ({letters[0]} through {letters[-1]})."
                ),
                max_tokens=(
                    args.math_max_tokens if is_math
                    else args.numeric_max_tokens if is_numeric
                    else args.choice_max_tokens
                ),
            )

            if not resp:
                no_response += 1
                failure = LAST_REQUEST_FAILURE.get("reason") or "no-response"
                if failure == "unreachable":
                    unreachable_streak += 1
                else:
                    unreachable_streak = 0
                append_live_record(args.live_log, {
                    "ts": time.time(),
                    "task": task_name,
                    "index": i + 1,
                    "total": len(examples),
                    "correct": False,
                    "expected": clip(answer, 120),
                    "answer": None,
                    "finishReason": failure,
                    "elapsedSeconds": round(time.monotonic() - question_started_at, 1),
                    "question": clip(prompt, 700),
                    "reply": "",
                })
                # Three unreachable replies in a row is a dead endpoint, not a
                # struggling model. One recorded run lost its slot to another
                # benchmark and then charged through 57 more questions in 27
                # seconds, scoring every one of them wrong.
                if unreachable_streak >= UNREACHABLE_ABORT_STREAK:
                    print(
                        f"[{task_name}] endpoint unreachable {unreachable_streak} times in a row; "
                        f"abandoning this task after {attempted} of {len(examples)} questions",
                        file=sys.stderr,
                    )
                    aborted_reason = "endpoint-unreachable"
                    break
            if resp:
                unreachable_streak = 0
                choices = resp.get("choices", [])
                if not choices:
                    no_response += 1
                if choices:
                    content = choices[0].get("message", {}).get("content", "")
                    was_truncated = str(choices[0].get("finish_reason") or "") == "length"
                    if was_truncated:
                        truncated += 1
                    was_correct = False
                    if is_math:
                        model_answer = extract_math_answer(content, truncated=was_truncated)
                        was_correct = math_answers_equal(model_answer, answer)
                    elif is_numeric:
                        model_answer = extract_number(content, truncated=was_truncated)
                        was_correct = numbers_equal(model_answer, answer)
                    else:
                        model_answer = extract_letter(content, letters=letters)
                        was_correct = bool(model_answer) and model_answer == answer
                    if was_correct:
                        correct += 1
                    if not str(content or "").strip():
                        empty_content += 1
                    # Tokens per second per question is what explains a slow or
                    # cut-off answer: a truncation at 30 tok/s and one at 3 tok/s
                    # are different problems.
                    question_seconds = round(time.monotonic() - question_started_at, 1)
                    usage = resp.get("usage") or {}
                    completion_tokens = int(usage.get("completion_tokens") or 0)
                    append_live_record(args.live_log, {
                        "ts": time.time(),
                        "task": task_name,
                        "index": i + 1,
                        "total": len(examples),
                        "correct": bool(was_correct),
                        "expected": clip(answer, 120),
                        "answer": clip(model_answer, 120),
                        "finishReason": str(choices[0].get("finish_reason") or ""),
                        "completionTokens": completion_tokens,
                        "tokensPerSecond": (
                            round(completion_tokens / question_seconds, 1)
                            if completion_tokens and question_seconds > 0 else None
                        ),
                        "elapsedSeconds": question_seconds,
                        "question": clip(prompt, 700),
                        "reply": clip(strip_think_blocks(content), 700),
                    })
                    if model_answer is None:
                        unparsed += 1
                        if len(unparsed_samples) < 3:
                            unparsed_samples.append({
                                "finishReason": str(choices[0].get("finish_reason") or ""),
                                "replyChars": len(str(content or "")),
                                "reply": str(content or "")[:300],
                                "expected": answer,
                            })
                    total += 1
                    progress_every = 5 if (is_numeric or is_math) else 10
                    if (i + 1) % progress_every == 0 or i + 1 == len(examples):
                        print(
                            f"  [{i+1}/{len(examples)}] correct={correct}/{total} "
                            f"elapsed={time.monotonic() - task_started_at:.1f}s",
                            file=sys.stderr,
                        )

        acc = round(correct / total, 4) if total > 0 else None
        scores[task_name] = acc
        # A score over 12 of 30 questions is not the same measurement as one
        # over 30, and a run full of truncated replies is a token-budget
        # problem rather than a dumb model. Record both so the summary can say
        # so instead of printing a bare accuracy.
        diagnostics[task_name] = {
            "requested": len(examples),
            "scored": total,
            "correct": correct,
            "attempted": attempted,
            **({"abortedReason": aborted_reason} if aborted_reason else {}),
            "truncated": truncated,
            "unparsed": unparsed,
            "noResponse": no_response,
            "emptyContent": empty_content,
            "unparsedSamples": unparsed_samples,
            "complete": total == len(examples),
        }
        print(
            f"[{task_name}] Result: {correct}/{total} = {acc} "
            f"(requested={len(examples)} truncated={truncated} unparsed={unparsed} "
            f"no_response={no_response} empty_content={empty_content})",
            file=sys.stderr,
        )
        for i, sample in enumerate(unparsed_samples, 1):
            print(
                f"[{task_name}] unparsed sample {i}: finish={sample['finishReason']} "
                f"chars={sample['replyChars']} expected={sample['expected']} reply={sample['reply']!r}",
                file=sys.stderr,
            )

    valid = [v for v in scores.values() if v is not None]
    avg = round(sum(valid) / len(valid), 4) if valid else None

    result = {"scores": scores, "avgMmlu": avg, "overallAverage": avg, "diagnostics": diagnostics}
    if artifacts:
        result["artifacts"] = artifacts
    print(json.dumps(result))

    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
