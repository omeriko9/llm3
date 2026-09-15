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
  * Optionally strips reasoning_content from responses (--hide-reasoning).
    Only meaningful when the backend runs with the think block open, because
    that is the only case where reasoning is tagged and separable.
  * Writes one JSON line per request to the traffic log and a readable trace
    of the stream to stdout (the proxy log).

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
import time
import traceback
from pathlib import Path


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
} if ARGS else {}


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


def append_proxy_line(message: str) -> None:
    print(f"{proxy_timestamp()} {message}", flush=True)


def write_stream_text(stream_state: dict, kind: str, text: str) -> None:
    if not text:
        return
    if stream_state.get("last_kind") != kind:
        if stream_state.get("open_line"):
            print("", flush=True)
        label = "thinking" if kind == "thinking" else "answer"
        print(f"{proxy_timestamp()} [{label}] ", end="", flush=True)
        stream_state["last_kind"] = kind
        stream_state["open_line"] = True
    print(text, end="", flush=True)


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
        if stream_state.get("open_line"):
            print("", flush=True)
            stream_state["open_line"] = False
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
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            continue
        reasoning = message_text(delta.get("reasoning_content")) or message_text(delta.get("reasoning"))
        if reasoning:
            write_stream_text(stream_state, "thinking", reasoning)
        content = message_text(delta.get("content")) or message_text(delta.get("text"))
        if content:
            split_visible_thinking(content, stream_state)


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
    advertised_model_id = str(ARGS.advertised_model_id or "").strip()
    backend_model_id = str(ARGS.backend_model_id or "").strip()
    current_model = str(payload.get("model") or "").strip()
    if backend_model_id and (not current_model or current_model == advertised_model_id):
        payload["model"] = backend_model_id
    for key, value in DEFAULT_SAMPLING.items():
        if payload.get(key) in (None, ""):
            payload[key] = value
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

    def send_local_json(self, started: float, body: bytes) -> None:
        """Answer a request from the proxy itself, without touching the backend."""
        self.send_response(200)
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
                "status": 200,
                "durationMs": round((time.time() - started) * 1000, 2),
                "model": None,
                "stream": False,
                "request": "",
                "response": safe_text(body)[:MAX_CAPTURE],
                "client": self.client_address[0],
            }
        )

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
        stream_state = {"last_kind": "", "open_line": False, "in_think": False}
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
            if stream_state.get("open_line"):
                print("", flush=True)
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
                    "client": self.client_address[0],
                }
            )


if __name__ == "__main__":
    server = ThreadingServer((ARGS.host, ARGS.port), ProxyHandler)
    server.serve_forever()
