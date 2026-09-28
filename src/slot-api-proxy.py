#!/usr/bin/env python3
"""llm3 slot API proxy.

One process fronts a slot's public port and forwards /v1/* to the backend
server on the slot's backend port. It is the single proxy for every launcher:

  * bin/qwen_llama (GGUF slots on 8036+): configures it through QWEN_PROXY_*
    environment variables (see the argparse defaults below).
  * bin/run-optiq-api.sh (the optiq provider): configures it through flags and
    additionally uses --advertised-model-id / --backend-model-id to remap model
    ids, and --context-size to answer /props locally.

What it does on the way through:

  * Injects the slot's configured sampling (temperature, top_p, ...) into every
    generation request that leaves the field unset. /responses counts as a
    generation path: agent clients use it instead of chat/completions, and
    without this they silently ran on llama.cpp's stock defaults.
  * Skips those sampling defaults with --no-sampling-defaults, for a backend
    that has its own (mlx-dspark, mlx-vlm): the request reaches it unchanged.
  * Optionally strips reasoning_content from responses (--hide-reasoning).
    Only meaningful when the backend runs with the think block open, because
    that is the only case where reasoning is tagged and separable.
  * Writes one JSON line per request to the traffic log and a readable trace
    of the stream to stdout (the proxy log).
  * Answers POST /v1/decide itself (src/slot_decide.py): a decision call that
    returns one probability for each permitted answer and generates no text.
    GET /llm3/capabilities reports which decide method the backend supports.

It must emit RFC-compliant HTTP or strict clients (Node undici/fetch) reject it
with "400 (no body)" while curl tolerates it: exactly one Server header, no
empty or hop-by-hop headers forwarded, SSE with Transfer-Encoding: chunked, a
single correct Content-Length otherwise, and the inbound Content-Length dropped
case-insensitively before setting our own.
"""

import argparse
import http.client
import http.server
import json
import os
import socket
import socketserver
import sys
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import slot_decide  # noqa: E402


def env_text(name: str, fallback: str = "") -> str:
    return str(os.environ.get(name, "") or "").strip() or fallback


def env_float(name: str, fallback: float) -> float:
    raw = env_text(name)
    if not raw:
        return fallback
    try:
        return float(raw)
    except ValueError:
        return fallback


def env_int(name: str, fallback: int) -> int:
    raw = env_text(name)
    if not raw:
        return fallback
    try:
        return int(raw)
    except ValueError:
        return fallback


def env_flag(name: str, fallback: bool = False) -> bool:
    raw = env_text(name).lower()
    if not raw:
        return fallback
    return raw in {"1", "true", "yes", "on"}


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="llm3 slot API proxy")
    parser.add_argument("--host", default=env_text("QWEN_PROXY_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=env_int("QWEN_PROXY_PORT", 0))
    parser.add_argument("--backend-host", default=env_text("QWEN_PROXY_TARGET_HOST", "127.0.0.1"))
    parser.add_argument("--backend-port", type=int, default=env_int("QWEN_PROXY_TARGET_PORT", 0))
    parser.add_argument("--traffic-log", default=env_text("QWEN_PROXY_LOG"))
    parser.add_argument("--backend-api-key", default="")
    parser.add_argument("--advertised-model-id", default="")
    parser.add_argument("--advertised-model-label", default="")
    parser.add_argument("--backend-model-id", default="")
    # When > 0 the proxy answers GET /props itself with this context size
    # instead of forwarding it (the optiq backend has no /props).
    parser.add_argument("--context-size", type=int, default=0)
    parser.add_argument("--default-temperature", type=float, default=env_float("QWEN_PROXY_DEFAULT_TEMPERATURE", 0.6))
    parser.add_argument("--default-top-p", type=float, default=env_float("QWEN_PROXY_DEFAULT_TOP_P", 0.95))
    parser.add_argument("--default-top-k", type=int, default=env_int("QWEN_PROXY_DEFAULT_TOP_K", 20))
    parser.add_argument("--default-min-p", type=float, default=env_float("QWEN_PROXY_DEFAULT_MIN_P", 0.0))
    parser.add_argument("--default-presence-penalty", type=float, default=env_float("QWEN_PROXY_DEFAULT_PRESENCE_PENALTY", 0.0))
    parser.add_argument("--default-repetition-penalty", type=float, default=env_float("QWEN_PROXY_DEFAULT_REPETITION_PENALTY", 1.0))
    # Bodies are truncated to this many chars in the traffic log. 12000 cut a
    # large agent request off inside "messages", so the tools array and every
    # sampling field were invisible, and responses were cut before
    # finish_reason or any tool_calls delta, which made stalls undiagnosable.
    parser.add_argument("--max-capture", type=int, default=env_int("QWEN_PROXY_MAX_CAPTURE", 200000))
    # llama-server gives a request with no matching prompt to its least recently
    # used slot. A burst of decision calls therefore walks over every slot and
    # pushes each agent's context out to the host prompt cache. Pinning them to
    # one slot leaves the others alone. -1 = do not pin (the default, and the
    # right value for a backend that is not llama-server).
    parser.add_argument("--decide-slot", type=int, default=env_int("QWEN_PROXY_DECIDE_SLOT", -1))
    parser.add_argument(
        "--no-sampling-defaults",
        action="store_true",
        help="forward generation requests without adding sampling keys the client left out",
    )
    parser.add_argument(
        "--hide-reasoning",
        action="store_true",
        default=env_flag("QWEN_PROXY_HIDE_REASONING"),
        help="drop reasoning_content from responses",
    )
    args = parser.parse_args(argv)
    if not args.port or not args.backend_port or not args.traffic_log:
        parser.error("--port, --backend-port and --traffic-log are required (or QWEN_PROXY_PORT, QWEN_PROXY_TARGET_PORT, QWEN_PROXY_LOG)")
    return args


ARGS = parse_args() if __name__ == "__main__" else None
TRAFFIC_LOG = Path(ARGS.traffic_log) if ARGS else Path("traffic.log")
MAX_CAPTURE = ARGS.max_capture if ARGS else 200000
HIDE_REASONING = bool(ARGS.hide_reasoning) if ARGS else False
DEFAULT_SAMPLING = {
    "temperature": ARGS.default_temperature,
    "top_p": ARGS.default_top_p,
    "top_k": ARGS.default_top_k,
    "min_p": ARGS.default_min_p,
    "presence_penalty": ARGS.default_presence_penalty,
    "repetition_penalty": ARGS.default_repetition_penalty,
} if ARGS and not ARGS.no_sampling_defaults else {}


HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
# Headers we always set ourselves; never copy these from upstream or we get
# duplicate/empty values and bad framing that strict clients (undici) reject.
SKIP_RESPONSE_HEADERS = HOP_BY_HOP_HEADERS | {
    "server",
    "date",
    "content-length",
    "access-control-allow-origin",
}

# Endpoints that take generation params and therefore need the slot's
# configured sampling applied (and, for optiq, the model id remapped).
GENERATION_PATH_MARKERS = ("chat/completions", "completions", "responses")


# Requests the proxy is holding open right now, per slot.
#
# "Is a model generating?" was answered only by a decode counter moving between
# two polls, which is blind to the whole first half of a request: a long prefill
# commits no tokens, and neither does a request queued behind another or one
# stalled on memory. The dashboard spinner sat dark through all of it. An open
# generation request is the honest signal for "llm3 is working".
_INFLIGHT_LOCK = threading.Lock()
_INFLIGHT = {"count": 0, "since": 0.0}


def inflight_begin() -> None:
    with _INFLIGHT_LOCK:
        if _INFLIGHT["count"] <= 0:
            _INFLIGHT["since"] = time.time()
        _INFLIGHT["count"] += 1


def inflight_end() -> None:
    with _INFLIGHT_LOCK:
        _INFLIGHT["count"] = max(0, _INFLIGHT["count"] - 1)
        if _INFLIGHT["count"] == 0:
            _INFLIGHT["since"] = 0.0


def build_local_activity_payload() -> bytes:
    with _INFLIGHT_LOCK:
        count = int(_INFLIGHT["count"])
        since = float(_INFLIGHT["since"])
    return json.dumps({
        "inflight": count,
        "busy": count > 0,
        "openForMs": round((time.time() - since) * 1000) if since else 0,
        # Rides on the probe the dashboard polls already: no second request.
        "decide": _DECIDE_STATE["decide"],
    }).encode("utf-8")


# Which decide method this backend gave on the most recent decision call:
# "logprobs", "greedy", or "unknown" before the first call. It is measured from
# a real response, not read from a launcher table, so it is correct for every
# backend and it shows at once when an mlx-dspark update disables the shim.
_DECIDE_LOCK = threading.Lock()
_DECIDE_STATE = {"decide": "unknown", "checkedAt": 0.0, "calls": 0}
DECIDE_ROUTES = {"/v1/decide", "/decide"}
DECIDE_PROBE = {
    "context": "Text:\nThe sky is blue.",
    "question": "Is the text about the sky?",
    "choices": {"yes": "yes", "no": "no"},
}


def decide_state_update(method: str) -> None:
    with _DECIDE_LOCK:
        _DECIDE_STATE["decide"] = method
        _DECIDE_STATE["checkedAt"] = time.time()
        _DECIDE_STATE["calls"] += 1


def build_local_capabilities_payload() -> bytes:
    with _DECIDE_LOCK:
        state = dict(_DECIDE_STATE)
    return json.dumps({
        "decide": state["decide"],
        "decideCheckedAt": round(state["checkedAt"] * 1000) if state["checkedAt"] else 0,
        "decideCalls": state["calls"],
        "maxChoices": slot_decide.MAX_CHOICES,
    }).encode("utf-8")


def backend_chat_completion(body: bytes) -> dict:
    """One non-streamed chat completion, sent by the proxy itself."""
    headers = {"Content-Type": "application/json", "Content-Length": str(len(body))}
    if ARGS.backend_api_key:
        headers["Authorization"] = f"Bearer {ARGS.backend_api_key}"
        headers["X-API-Key"] = ARGS.backend_api_key
    conn = http.client.HTTPConnection(ARGS.backend_host, ARGS.backend_port, timeout=3600)
    resp = None
    try:
        conn.request("POST", "/v1/chat/completions", body=body, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status >= 400:
            raise RuntimeError(f"backend status {resp.status}: {safe_text(raw)[:500]}")
        return json.loads(raw.decode("utf-8"))
    finally:
        close_backend(resp, conn)


def run_decide(payload) -> dict:
    """Do the rotations of one decision call against the backend."""
    request = slot_decide.parse_request(payload)
    names = list(request["choices"])
    orders = slot_decide.rotation_orders(names, request["rotations"])
    model = str(ARGS.backend_model_id or "").strip() or request["model"]
    readings = []
    for order in orders:
        prompt = slot_decide.build_prompt(request["context"], request["question"], order, request["choices"])
        body = slot_decide.build_backend_body(model, prompt, request["top_logprobs"], int(ARGS.decide_slot))
        response = backend_chat_completion(body)
        readings.append(slot_decide.read_response(response, slot_decide.LABELS[: len(order)]))
    result = slot_decide.combine(names, orders, readings)
    decide_state_update(result["method"])
    return result


def is_generation_path(path: str) -> bool:
    route = path.split("?", 1)[0].rstrip("/")
    return any(route.endswith(marker) for marker in GENERATION_PATH_MARKERS)


def copy_upstream_headers(handler, response_headers) -> None:
    for key, value in response_headers:
        if key.lower() in SKIP_RESPONSE_HEADERS:
            continue
        if value is None or value == "":
            continue
        handler.send_header(key, value)


def safe_text(payload: bytes) -> str:
    try:
        return payload.decode("utf-8", errors="replace")
    except Exception:
        return repr(payload)


def prettify(payload: bytes) -> str:
    text = safe_text(payload)
    try:
        parsed = json.loads(text)
    except Exception:
        return text[:MAX_CAPTURE]
    return json.dumps(parsed, ensure_ascii=False, indent=2)[:MAX_CAPTURE]


def rewrite_models_payload(path: str, body: bytes) -> bytes:
    advertised_model_id = str(ARGS.advertised_model_id or "").strip()
    if not advertised_model_id or path.rstrip("/") != "/v1/models":
        return body
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    payload["object"] = "list"
    payload["data"] = [{
        "id": advertised_model_id,
        "object": "model",
        "owned_by": str(ARGS.advertised_model_label or "").strip() or "llm3-optiq",
    }]
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def build_local_props_payload() -> bytes:
    context_size = int(ARGS.context_size or 0)
    payload = {
        "default_generation_settings": {
            "n_ctx": context_size,
            "params": {
                "n_ctx": context_size,
            },
        },
    }
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def append_log(entry: dict) -> None:
    entry["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    TRAFFIC_LOG.parent.mkdir(parents=True, exist_ok=True)
    with TRAFFIC_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def proxy_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# The server is threaded, so several requests share one stdout. Stream text is
# written without a newline, and it used to be each stream's own business to
# close its line. A second request's "[response]" line or its own "[thinking]"
# header then started mid-line, glued to the first stream's text, and the
# Thinking tab showed the timestamp on the previous line. One lock and one
# record of who owns the open line keep every timestamp at a line start.
_STDOUT_LOCK = threading.Lock()
_open_line_owner = None


def _close_open_line_locked() -> None:
    global _open_line_owner
    if _open_line_owner is not None:
        sys.stdout.write("\n")
        _open_line_owner = None


def append_proxy_line(message: str) -> None:
    with _STDOUT_LOCK:
        _close_open_line_locked()
        sys.stdout.write(f"{proxy_timestamp()} {message}\n")
        sys.stdout.flush()


def end_stream_line(stream_state: dict) -> None:
    with _STDOUT_LOCK:
        if _open_line_owner is stream_state:
            _close_open_line_locked()
            sys.stdout.flush()
        stream_state["open_line"] = False


def write_stream_text(stream_state: dict, kind: str, text: str) -> None:
    global _open_line_owner
    if not text:
        return
    with _STDOUT_LOCK:
        # A header again when another writer took the line, so the text that
        # follows is still labelled (and still extracted as thinking).
        if stream_state.get("last_kind") != kind or _open_line_owner is not stream_state:
            _close_open_line_locked()
            label = "thinking" if kind == "thinking" else "answer"
            sys.stdout.write(f"{proxy_timestamp()} [{label}] ")
            stream_state["last_kind"] = kind
            stream_state["open_line"] = True
            _open_line_owner = stream_state
        sys.stdout.write(text)
        sys.stdout.flush()


def split_visible_thinking(content: str, stream_state: dict) -> None:
    remaining = content
    while remaining:
        lowered = remaining.lower()
        if stream_state.get("in_think"):
            end_index = lowered.find("</think>")
            if end_index < 0:
                write_stream_text(stream_state, "thinking", remaining)
                return
            write_stream_text(stream_state, "thinking", remaining[:end_index])
            remaining = remaining[end_index + len("</think>") :]
            stream_state["in_think"] = False
            continue

        start_index = lowered.find("<think>")
        if start_index < 0:
            write_stream_text(stream_state, "answer", remaining)
            return
        write_stream_text(stream_state, "answer", remaining[:start_index])
        remaining = remaining[start_index + len("<think>") :]
        stream_state["in_think"] = True


def message_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(message_text(item) for item in value)
    if isinstance(value, dict):
        if "text" in value:
            return message_text(value.get("text"))
        if "content" in value:
            return message_text(value.get("content"))
    return str(value)


def _drop_reasoning(node) -> bool:
    """Remove reasoning fields in place. Returns True if anything was removed."""
    hit = False
    for choice in (node.get("choices") or []):
        if not isinstance(choice, dict):
            continue
        for holder_key in ("delta", "message"):
            holder = choice.get(holder_key)
            if isinstance(holder, dict):
                for field in ("reasoning_content", "reasoning"):
                    if holder.pop(field, None) is not None:
                        hit = True
    return hit


def strip_reasoning_sse_line(line: bytes) -> bytes:
    """Drop reasoning deltas from one SSE line, preserving framing exactly."""
    try:
        text = line.decode("utf-8")
    except Exception:
        return line
    stripped = text.strip()
    if not stripped.startswith("data:"):
        return line
    payload = stripped[5:].strip()
    if not payload or payload == "[DONE]":
        return line
    try:
        node = json.loads(payload)
    except Exception:
        return line
    if not isinstance(node, dict) or not _drop_reasoning(node):
        return line
    newline = "\r\n" if text.endswith("\r\n") else ("\n" if text.endswith("\n") else "")
    return ("data: " + json.dumps(node, ensure_ascii=False) + newline).encode("utf-8")


def strip_reasoning_json_body(body: bytes) -> bytes:
    """Drop reasoning fields from a non-streamed chat completion body."""
    try:
        node = json.loads(body.decode("utf-8"))
    except Exception:
        return body
    if not isinstance(node, dict) or not _drop_reasoning(node):
        return body
    return json.dumps(node, ensure_ascii=False).encode("utf-8")


def observe_stream_line(line: bytes, stream_state: dict) -> None:
    text = safe_text(line).strip()
    if not text.startswith("data:"):
        return
    data = text[5:].strip()
    if not data:
        return
    if data == "[DONE]":
        stream_state["saw_done"] = True
        end_stream_line(stream_state)
        append_proxy_line("[stream done]")
        return
    try:
        payload = json.loads(data)
    except Exception:
        return
    choices = payload.get("choices")
    if not isinstance(choices, list):
        return
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        finish = choice.get("finish_reason")
        if isinstance(finish, str) and finish:
            stream_state["finish_reason"] = finish
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            continue
        reasoning = message_text(delta.get("reasoning_content")) or message_text(delta.get("reasoning"))
        if reasoning:
            stream_state["reasoning_chars"] = stream_state.get("reasoning_chars", 0) + len(reasoning)
            write_stream_text(stream_state, "thinking", reasoning)
        content = message_text(delta.get("content")) or message_text(delta.get("text"))
        if content:
            stream_state["visible_chars"] = stream_state.get("visible_chars", 0) + len(content)
            split_visible_thinking(content, stream_state)


def describe_silent_cut(stream_state: dict, *, streamed: bool, status: int,
                       client_disconnected: bool) -> str:
    """Name a generation that ended without ever saying why, or "".

    llama.cpp ends a task when it hits --reasoning-budget. It closes the stream
    without a terminal finish_reason and without [DONE], and its own log says
    `stop processing ... truncated = 0`, so nothing anywhere reports a problem:
    the client just shows a reply that stops mid-sentence. Three of 23 requests
    on a DeepSeek-V4 slot ended this way, every one of them with 0 visible
    characters after ~1024 reasoning tokens, and the Logs tab showed nothing.
    """
    if not streamed or status != 200 or client_disconnected:
        return ""
    if stream_state.get("saw_done") or stream_state.get("finish_reason"):
        return ""
    reasoning = int(stream_state.get("reasoning_chars", 0))
    visible = int(stream_state.get("visible_chars", 0))
    if not reasoning and not visible:
        return ""
    detail = (
        f"reasoning={reasoning} chars, visible={visible} chars, "
        "no finish_reason and no [DONE]"
    )
    if reasoning and not visible:
        return (
            "[cut off] the model was still thinking and never wrote an answer -- "
            f"{detail}. This is what hitting --reasoning-budget looks like; raise "
            "the slot's Thinking budget."
        )
    return f"[cut off] the stream ended without completing -- {detail}."


def observe_json_body(body: bytes, stream_state: dict) -> None:
    """Log the reasoning and answer of a non-streamed completion, like a stream.

    Without this a client that does not stream (many agents) left the Thinking
    tab empty even though the response carried reasoning_content.
    """
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        return
    if not isinstance(payload, dict):
        return
    for choice in payload.get("choices") or []:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict):
            text = message_text(choice.get("text"))
            if text:
                split_visible_thinking(text, stream_state)
            continue
        reasoning = message_text(message.get("reasoning_content")) or message_text(message.get("reasoning"))
        if reasoning:
            write_stream_text(stream_state, "thinking", reasoning)
        content = message_text(message.get("content"))
        if content:
            split_visible_thinking(content, stream_state)
    end_stream_line(stream_state)


def is_client_disconnect(exc) -> bool:
    if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
        return True
    if isinstance(exc, OSError) and getattr(exc, "errno", None) in {32, 54, 57}:
        return True
    return False


def close_backend(response, conn) -> None:
    if response is not None:
        try:
            response.close()
        except Exception:
            pass
    if conn is not None:
        sock = getattr(conn, "sock", None)
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass


# "No thinking" spelled as a reasoning effort. OpenAI-style clients send
# reasoning_effort "none" (or "minimal"); hermes does so on its own when a turn
# spent its whole token budget on thinking and it retries without. mlx-dspark
# knows only low / medium / high / xhigh and answers 400, which turned that
# recovery into a failed episode (podG dbf3dc21, 2026-09-21). What the client
# means is "do not think", and every backend here has a switch for exactly that.
REASONING_EFFORT_MEANS_OFF = {"none", "minimal", "off"}


def thinking_off_requested(payload: dict) -> bool:
    """Rewrite reasoning_effort none/minimal/off into the thinking switch. True if it did."""
    effort = payload.get("reasoning_effort")
    if not isinstance(effort, str) or effort.strip().lower() not in REASONING_EFFORT_MEANS_OFF:
        return False
    del payload["reasoning_effort"]
    payload["enable_thinking"] = False  # mlx-dspark reads this key
    kwargs = payload.get("chat_template_kwargs")
    kwargs = dict(kwargs) if isinstance(kwargs, dict) else {}
    kwargs["enable_thinking"] = False  # llama-server reads this one
    payload["chat_template_kwargs"] = kwargs
    return True


# A reasoning effort the backend does not offer. Levels differ per model: the
# Sushi runtime serves Qwen3.8-Flash-Next with off / low / medium / xhigh and
# answers 400 to "high", which hermes does not retry -- a podG Tell-me turn
# failed on it (2026-09-28). A backend that lists its levels in /v1/models
# ("reasoning_efforts") gets the nearest one it has; a tie goes to the lower
# level, because the lower one costs less time. A backend that lists nothing
# gets the request unchanged.
REASONING_EFFORT_ORDER = ("low", "medium", "high", "xhigh", "max")
BACKEND_EFFORTS_TTL_SECONDS = 60.0
_backend_efforts = {"levels": None, "checkedAt": 0.0}
_backend_efforts_lock = threading.Lock()


def backend_reasoning_efforts() -> "list | None":
    """The effort levels the backend's model lists in /v1/models, cached for a minute."""
    with _backend_efforts_lock:
        if time.time() - _backend_efforts["checkedAt"] < BACKEND_EFFORTS_TTL_SECONDS:
            return _backend_efforts["levels"]
        levels = None
        conn = http.client.HTTPConnection(ARGS.backend_host, ARGS.backend_port, timeout=5)
        resp = None
        try:
            headers = {"Authorization": f"Bearer {ARGS.backend_api_key}"} if ARGS.backend_api_key else {}
            conn.request("GET", "/v1/models", headers=headers)
            resp = conn.getresponse()
            payload = json.loads(resp.read().decode("utf-8")) if resp.status == 200 else {}
            entries = payload.get("data") if isinstance(payload, dict) else None
            entries = [e for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []
            wanted = str(ARGS.backend_model_id or "").strip()
            entry = next((e for e in entries if wanted and e.get("id") == wanted), entries[0] if entries else {})
            listed = entry.get("reasoning_efforts")
            if isinstance(listed, list) and listed:
                levels = [str(level).strip().lower() for level in listed if isinstance(level, str)]
        except Exception:
            levels = None
        finally:
            close_backend(resp, conn)
        _backend_efforts["levels"] = levels
        _backend_efforts["checkedAt"] = time.time()
        return levels


def nearest_reasoning_effort(effort: str, levels: "list | None") -> "str | None":
    """The offered level closest to `effort`, or None when no change is needed or possible."""
    effort = effort.strip().lower()
    if not levels or effort in levels or effort not in REASONING_EFFORT_ORDER:
        return None
    offered = [level for level in levels if level in REASONING_EFFORT_ORDER]
    if not offered:
        return None
    wanted = REASONING_EFFORT_ORDER.index(effort)
    return min(offered, key=lambda level: (abs(REASONING_EFFORT_ORDER.index(level) - wanted), REASONING_EFFORT_ORDER.index(level)))


def map_unsupported_reasoning_effort(payload: dict) -> bool:
    """Replace a reasoning_effort the backend does not offer. True if it did."""
    effort = payload.get("reasoning_effort")
    if not isinstance(effort, str) or not effort.strip():
        return False
    replacement = nearest_reasoning_effort(effort, backend_reasoning_efforts())
    if replacement is None:
        return False
    append_proxy_line(f"[proxy] reasoning_effort {effort!r} is not offered by the model; sent {replacement!r}")
    payload["reasoning_effort"] = replacement
    return True


def normalize_request(path: str, body: bytes) -> "tuple[bytes, dict | None]":
    """Apply the slot's sampling defaults and the optiq model-id remap.

    Returns the (possibly rewritten) body and the parsed JSON, or the original
    body and None when the request is not a JSON generation request.
    """
    if not is_generation_path(path) or not body:
        return body, None
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        return body, None
    if not isinstance(payload, dict):
        return body, None
    changed = False
    advertised_model_id = str(ARGS.advertised_model_id or "").strip()
    backend_model_id = str(ARGS.backend_model_id or "").strip()
    current_model = str(payload.get("model") or "").strip()
    if backend_model_id and (not current_model or current_model == advertised_model_id):
        payload["model"] = backend_model_id
        changed = True
    for key, value in DEFAULT_SAMPLING.items():
        if payload.get(key) in (None, ""):
            payload[key] = value
            changed = True
    if thinking_off_requested(payload):
        changed = True
    elif map_unsupported_reasoning_effort(payload):
        changed = True
    if not changed:
        # Byte-for-byte what the client sent.
        return body, payload
    return json.dumps(payload, ensure_ascii=False).encode("utf-8"), payload


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, _request, _client_address) -> None:
        exc = sys.exc_info()[1]
        if is_client_disconnect(exc):
            return
        return super().handle_error(_request, _client_address)


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _fmt: str, *_args) -> None:
        return

    def do_GET(self) -> None:
        self.handle_proxy()

    def do_POST(self) -> None:
        self.handle_proxy()

    def do_PUT(self) -> None:
        self.handle_proxy()

    def do_PATCH(self) -> None:
        self.handle_proxy()

    def do_DELETE(self) -> None:
        self.handle_proxy()

    def do_OPTIONS(self) -> None:
        self.handle_proxy()

    def send_local_json(self, started: float, body: bytes, status: int = 200, request: str = "") -> None:
        """Answer a request from the proxy itself."""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(body)
        self.wfile.flush()
        append_log(
            {
                "method": self.command,
                "path": self.path,
                "status": status,
                "durationMs": round((time.time() - started) * 1000, 2),
                "model": None,
                "stream": False,
                "request": request,
                "response": safe_text(body)[:MAX_CAPTURE],
                "client": self.client_address[0],
            }
        )

    def handle_decide(self, started: float, body: bytes, probe: bool = False) -> None:
        """POST /v1/decide, and the probe behind GET /llm3/capabilities?probe=1."""
        status = 200
        try:
            payload = DECIDE_PROBE if probe else json.loads(body.decode("utf-8") or "{}")
        except Exception:
            payload = None
        # A decision call is model work: the dashboard must show the slot busy.
        inflight_begin()
        try:
            if payload is None:
                raise slot_decide.DecideError("The body is not valid JSON.")
            result = run_decide(payload)
            answer = build_local_capabilities_payload() if probe else json.dumps(result, ensure_ascii=False).encode("utf-8")
            append_proxy_line(
                f"[decide] method={result['method']} choice={result['choice']} "
                f"coverage={result['coverage']} rotations={result['rotations']} "
                f"durationMs={round((time.time() - started) * 1000, 2)} client={self.client_address[0]}"
            )
        except slot_decide.DecideError as exc:
            status = 400
            answer = json.dumps({"error": str(exc)}).encode("utf-8")
        except Exception as exc:
            status = 502
            answer = json.dumps({"error": "".join(traceback.format_exception_only(type(exc), exc)).strip()}).encode("utf-8")
            append_proxy_line(f"[decide] failed status=502 {safe_text(answer)[:300]}")
        finally:
            inflight_end()
        self.send_local_json(started, answer, status, "" if probe else prettify(body))

    def handle_proxy(self) -> None:
        started = time.time()
        content_length = int(self.headers.get("Content-Length", "0") or "0")
        original_body = self.rfile.read(content_length) if content_length else b""
        route = self.path.split("?", 1)[0].rstrip("/")

        if self.command == "GET" and route == "/v1/models" and str(ARGS.advertised_model_id or "").strip():
            self.send_local_json(started, rewrite_models_payload(route, b"{}"))
            return
        if self.command == "GET" and route == "/props" and int(ARGS.context_size or 0) > 0:
            self.send_local_json(started, build_local_props_payload())
            return
        # llm3's own probe. Namespaced so it can never collide with a backend
        # route, and answered here because only the proxy knows what it holds.
        if self.command == "GET" and route == "/llm3/activity":
            self.send_local_json(started, build_local_activity_payload())
            return
        if self.command == "GET" and route == "/llm3/capabilities":
            # ?probe=1 sends one small decision call when the method is not
            # known yet. The result stays valid until the slot starts again.
            query = self.path.split("?", 1)[1] if "?" in self.path else ""
            if "probe=1" in query.split("&") and _DECIDE_STATE["decide"] == "unknown":
                self.handle_decide(started, b"", probe=True)
                return
            self.send_local_json(started, build_local_capabilities_payload())
            return
        if self.command == "POST" and route in DECIDE_ROUTES:
            self.handle_decide(started, original_body)
            return

        request_body, request_json = normalize_request(self.path, original_body)
        request_preview = prettify(request_body)
        status = 502
        response_preview = ""
        stream_mode = False
        model = request_json.get("model") if isinstance(request_json, dict) else None
        conn = None
        resp = None
        client_disconnected = False
        response_started = False
        stream_state = {"last_kind": "", "open_line": False, "in_think": False,
                        "saw_done": False, "finish_reason": "",
                        "reasoning_chars": 0, "visible_chars": 0}
        proxy_log_request = is_generation_path(self.path)

        headers = {}
        # Strip hop-by-hop + the inbound Content-Length: we always recompute our
        # own below. Skipping it case-insensitively avoids a duplicate header
        # when the client (e.g. undici) sends a lowercase "content-length",
        # which would otherwise collide by case and forward two conflicting
        # Content-Length lines -> upstream 400.
        skip_request_headers = HOP_BY_HOP_HEADERS | {"host", "accept-encoding", "content-length"}
        for key, value in self.headers.items():
            if key.lower() in skip_request_headers:
                continue
            headers[key] = value
        if request_body or self.command in {"POST", "PUT", "PATCH"}:
            headers["Content-Length"] = str(len(request_body))
        if ARGS.backend_api_key:
            if not any(key.lower() == "authorization" for key in headers):
                headers["Authorization"] = f"Bearer {ARGS.backend_api_key}"
            if not any(key.lower() == "x-api-key" for key in headers):
                headers["X-API-Key"] = ARGS.backend_api_key

        if proxy_log_request:
            inflight_begin()
        try:
            if proxy_log_request:
                append_proxy_line(f"[request] {self.command} {self.path} model={model or '-'} client={self.client_address[0]}")
            conn = http.client.HTTPConnection(ARGS.backend_host, ARGS.backend_port, timeout=3600)
            conn.request(self.command, self.path, body=request_body if request_body else None, headers=headers)
            resp = conn.getresponse()
            status = resp.status

            response_headers = resp.getheaders()
            content_type = next((v for k, v in response_headers if k.lower() == "content-type"), "")
            stream_mode = "text/event-stream" in content_type.lower()

            captured = bytearray()
            if stream_mode:
                # Faithfully forward the SSE stream with chunked transfer
                # encoding: write each upstream line as its own chunk and flush
                # so tokens reach the client as they arrive (no buffering).
                self.send_response(resp.status)
                copy_upstream_headers(self, response_headers)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                response_started = True
                while True:
                    line = resp.readline()
                    if not line:
                        break
                    # Observe and log the ORIGINAL line, so reasoning still
                    # reaches the proxy console and traffic.log for debugging;
                    # only what goes back to the client is stripped.
                    if len(captured) < MAX_CAPTURE:
                        captured.extend(line[: MAX_CAPTURE - len(captured)])
                    observe_stream_line(line, stream_state)
                    if HIDE_REASONING:
                        line = strip_reasoning_sse_line(line)
                    try:
                        self.wfile.write(b"%X\r\n" % len(line))
                        self.wfile.write(line)
                        self.wfile.write(b"\r\n")
                        self.wfile.flush()
                    except Exception as exc:
                        if is_client_disconnect(exc):
                            client_disconnected = True
                            response_preview = "client disconnected"
                            self.close_connection = True
                            break
                        raise
                if not client_disconnected:
                    try:
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    except Exception as exc:
                        if is_client_disconnect(exc):
                            client_disconnected = True
                            response_preview = "client disconnected"
                            self.close_connection = True
                        else:
                            raise
            else:
                body = resp.read()
                if len(captured) < MAX_CAPTURE:
                    captured.extend(body[: MAX_CAPTURE - len(captured)])
                if proxy_log_request and status < 400:
                    observe_json_body(body, stream_state)
                body = rewrite_models_payload(route, body)
                if HIDE_REASONING:
                    body = strip_reasoning_json_body(body)
                self.send_response(resp.status)
                copy_upstream_headers(self, response_headers)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                response_started = True
                if body:
                    try:
                        self.wfile.write(body)
                        self.wfile.flush()
                    except Exception as exc:
                        if is_client_disconnect(exc):
                            client_disconnected = True
                            response_preview = "client disconnected"
                            self.close_connection = True
                        else:
                            raise

            if not client_disconnected:
                response_preview = safe_text(bytes(captured))[:MAX_CAPTURE]
        except Exception as exc:
            if is_client_disconnect(exc):
                client_disconnected = True
                response_preview = "client disconnected"
                self.close_connection = True
            else:
                response_preview = "".join(traceback.format_exception_only(type(exc), exc)).strip()
                if response_started:
                    # Headers already on the wire; cannot send a fresh status.
                    self.close_connection = True
                else:
                    self.send_response(502)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    payload = json.dumps({"error": response_preview}).encode("utf-8")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    self.wfile.flush()
        finally:
            if proxy_log_request:
                inflight_end()
            end_stream_line(stream_state)
            cut_notice = ""
            if proxy_log_request:
                cut_notice = describe_silent_cut(
                    stream_state,
                    streamed=stream_mode,
                    status=status,
                    client_disconnected=client_disconnected,
                )
                if cut_notice:
                    # Goes to the proxy log, which is what the Logs tab reads, so
                    # the run is named instead of leaving a blank where the reason
                    # should be.
                    append_proxy_line(cut_notice)
            if proxy_log_request or status >= 400:
                append_proxy_line(
                    f"[response] {self.command} {self.path} status={status} stream={str(stream_mode).lower()} durationMs={round((time.time() - started) * 1000, 2)}"
                )
            close_backend(resp, conn)
            append_log(
                {
                    "method": self.command,
                    "path": self.path,
                    "status": status,
                    "durationMs": round((time.time() - started) * 1000, 2),
                    "model": model,
                    "stream": stream_mode,
                    "request": request_preview,
                    "response": response_preview,
                    **({"cutOff": cut_notice} if cut_notice else {}),
                    "client": self.client_address[0],
                }
            )


if __name__ == "__main__":
    server = ThreadingServer((ARGS.host, ARGS.port), ProxyHandler)
    server.serve_forever()
