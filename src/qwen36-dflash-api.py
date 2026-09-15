#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import traceback
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import mlx.core as mx
from dflash_mlx.api import DFlashGenerator


NO_THINKING_GUIDANCE = (
    "Thinking is disabled on this server. Never reveal internal reasoning, planning, "
    "or chain-of-thought. Reply with only the final answer for the user."
)
THINK_BLOCK_RE = re.compile(r"<think>\s*.*?\s*</think>", re.IGNORECASE | re.DOTALL)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OpenAI-compatible DFlash server for MLX models.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8036)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--target-model", required=True)
    parser.add_argument("--draft-model", required=True)
    parser.add_argument("--context-size", type=int, default=131072)
    parser.add_argument("--parallel", type=int, default=1)
    parser.add_argument("--max-speculative-tokens", type=int, default=None)
    parser.add_argument(
        "--verify-mode",
        choices=["stream", "chunked", "parallel-replay", "parallel-lazy-logits", "parallel-greedy-argmax"],
        default="parallel-replay",
    )
    parser.add_argument("--verify-chunk-size", type=int, default=4)
    parser.add_argument("--seed", type=int, default=0)
    return parser.parse_args(argv)


def sanitize_assistant_content(content: str) -> str:
    cleaned = THINK_BLOCK_RE.sub("", content or "")
    return cleaned.replace("<think>", "").replace("</think>", "").strip()


def extract_text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type", "text") != "text":
                continue
            text = item.get("text")
            if isinstance(text, str) and text:
                parts.append(text)
        return "\n".join(parts)
    return ""


def append_system_guidance(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cloned = [dict(message) for message in messages]
    guidance = {"role": "system", "content": NO_THINKING_GUIDANCE}
    if cloned and cloned[0].get("role") == "system" and isinstance(cloned[0].get("content"), str):
        if NO_THINKING_GUIDANCE not in cloned[0]["content"]:
            cloned[0]["content"] = f"{NO_THINKING_GUIDANCE}\n\n{cloned[0]['content']}"
        return cloned
    return [guidance, *cloned]


def normalize_tools(tools: Any) -> Any:
    if not isinstance(tools, list):
        return tools

    normalized: list[Any] = []
    for tool in tools:
        if not isinstance(tool, dict):
            normalized.append(tool)
            continue
        if tool.get("type") == "function" and isinstance(tool.get("function"), dict):
            normalized.append(tool["function"])
            continue
        normalized.append(tool)
    return normalized


def normalize_chat_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").strip().lower()
        if role == "tool":
            continue
        if role not in {"system", "user", "assistant"}:
            continue

        content = extract_text_content(message.get("content"))
        if role == "assistant" and message.get("tool_calls"):
            if not content:
                continue
        if not content and role != "assistant":
            continue

        normalized.append({"role": role, "content": content})
    return normalized


@dataclass
class GenerationChunk:
    delta: str
    text: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    finish_reason: str | None = None
    finished: bool = False


class ServerRuntime:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.parallel = max(1, int(args.parallel or 1))
        # The DFlash MLX generator is not safe to run concurrently against one
        # shared model instance. Queue generations instead of overlapping them.
        self.generation_lock = threading.Lock()
        self.generator = DFlashGenerator(
            target_model=args.target_model,
            draft_model=args.draft_model,
            seed=args.seed,
        )

    @property
    def tokenizer(self) -> Any:
        return self.generator.target.tokenizer

    def _tokenize_messages(self, messages: list[dict[str, Any]], tools: Any = None) -> list[int]:
        normalized = append_system_guidance(normalize_chat_messages(messages))
        kwargs: dict[str, Any] = {
            "tokenize": True,
            "add_generation_prompt": True,
        }
        normalized_tools = normalize_tools(tools)
        if normalized_tools:
            kwargs["tools"] = normalized_tools
        try:
            tokens = self.tokenizer.apply_chat_template(
                normalized,
                enable_thinking=False,
                **kwargs,
            )
        except TypeError:
            try:
                tokens = self.tokenizer.apply_chat_template(normalized, **kwargs)
            except Exception:
                if "tools" in kwargs:
                    kwargs.pop("tools", None)
                    tokens = self.tokenizer.apply_chat_template(normalized, **kwargs)
                else:
                    raise
        except Exception:
            if "tools" in kwargs:
                kwargs.pop("tools", None)
                try:
                    tokens = self.tokenizer.apply_chat_template(
                        normalized,
                        enable_thinking=False,
                        **kwargs,
                    )
                except TypeError:
                    tokens = self.tokenizer.apply_chat_template(normalized, **kwargs)
            else:
                raise
        if hasattr(tokens, "tolist"):
            tokens = tokens.tolist()
        return [int(token) for token in tokens]

    def _tokenize_prompt(self, prompt: str) -> list[int]:
        return self._tokenize_messages([{"role": "user", "content": prompt}])

    def estimate_chat_tokens(self, payload: dict[str, Any]) -> int | None:
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            return None
        try:
            return len(self._tokenize_messages(messages, payload.get("tools")))
        except Exception:
            return None

    def enforce_context_limit(self, payload: dict[str, Any]) -> None:
        prompt_tokens = None
        if isinstance(payload.get("messages"), list):
            prompt_tokens = self.estimate_chat_tokens(payload)
        elif isinstance(payload.get("prompt"), str):
            prompt_tokens = len(self._tokenize_prompt(payload["prompt"]))
        if prompt_tokens is None:
            return
        max_tokens = int(
            payload.get("max_tokens")
            or payload.get("max_completion_tokens")
            or 512
        )
        if prompt_tokens + max_tokens > self.args.context_size:
            raise ValueError(
                f"Requested prompt ({prompt_tokens} tokens) plus max output ({max_tokens}) "
                f"exceeds configured context size {self.args.context_size}."
            )

    def _finish_reason(self, metrics: dict[str, Any]) -> str:
        finish_reason = str(metrics.get("finish_reason", "stop"))
        return "length" if finish_reason == "max_tokens" else finish_reason

    def generate_chat(self, payload: dict[str, Any]) -> dict[str, Any]:
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("'messages' must be a non-empty list.")
        prompt_tokens = self._tokenize_messages(messages, payload.get("tools"))
        with self.generation_lock:
            result = self.generator.generate_from_tokens(
                prompt_tokens=mx.array(prompt_tokens, dtype=mx.uint32),
                max_new_tokens=int(payload.get("max_tokens") or payload.get("max_completion_tokens") or 256),
                temperature=float(payload.get("temperature", 0.0)),
                speculative_tokens=self.args.max_speculative_tokens,
                verify_mode=self.args.verify_mode,
                verify_chunk_size=self.args.verify_chunk_size,
                skip_special_tokens=True,
            )
        model = str(payload.get("model") or self.args.model_id)
        content = sanitize_assistant_content(result.text)
        created = int(time.time())
        return {
            "id": f"chatcmpl-{uuid.uuid4().hex}",
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": content,
                    },
                    "finish_reason": self._finish_reason(result.metrics),
                }
            ],
            "usage": {
                "prompt_tokens": int(result.metrics.get("num_input_tokens", len(prompt_tokens))),
                "completion_tokens": len(result.generated_tokens),
                "total_tokens": int(result.metrics.get("num_input_tokens", len(prompt_tokens))) + len(result.generated_tokens),
            },
        }

    def stream_chat(self, payload: dict[str, Any]) -> Iterator[GenerationChunk]:
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("'messages' must be a non-empty list.")
        prompt_tokens = self._tokenize_messages(messages, payload.get("tools"))
        with self.generation_lock:
            for event in self.generator.stream_from_tokens(
                prompt_tokens=mx.array(prompt_tokens, dtype=mx.uint32),
                max_new_tokens=int(payload.get("max_tokens") or payload.get("max_completion_tokens") or 256),
                temperature=float(payload.get("temperature", 0.0)),
                speculative_tokens=self.args.max_speculative_tokens,
                verify_mode=self.args.verify_mode,
                verify_chunk_size=self.args.verify_chunk_size,
                skip_special_tokens=True,
            ):
                if event.finished:
                    metrics = event.metrics or {}
                    yield GenerationChunk(
                        delta="",
                        text=sanitize_assistant_content(event.text),
                        prompt_tokens=int(metrics.get("num_input_tokens", len(prompt_tokens))),
                        completion_tokens=len(event.generated_tokens),
                        finish_reason=self._finish_reason(metrics),
                        finished=True,
                    )
                    continue
                if event.delta:
                    yield GenerationChunk(
                        delta=event.delta,
                        text=event.text,
                        completion_tokens=len(event.generated_tokens),
                    )


def make_handler(runtime: ServerRuntime):
    class Handler(BaseHTTPRequestHandler):
        server_version = "qwen36-dflash/0.1"

        def _model_payload(self) -> dict[str, Any]:
            return {
                "id": runtime.args.model_id,
                "object": "model",
                "created": 0,
                "owned_by": "local-dflash",
            }

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
            self.close_connection = True

        def _send_sse_headers(self) -> None:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.flush()

        def _write_sse(self, payload: dict[str, Any] | str) -> None:
            text = payload if isinstance(payload, str) else json.dumps(payload)
            self.wfile.write(f"data: {text}\n\n".encode("utf-8"))
            self.wfile.flush()

        def _read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            if not raw:
                raise ValueError("Request body is required.")
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON: {exc.msg}") from exc
            if not isinstance(payload, dict):
                raise ValueError("JSON body must be an object.")
            return payload

        def do_GET(self) -> None:
            if self.path in {"/health", "/version", "/v1/health", "/v1/healthz"}:
                self._send_json(HTTPStatus.OK, {"ok": True, "model": runtime.args.model_id})
                return
            if self.path in {"/", "/models", "/v1/models", "/api/v1/models"}:
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "object": "list",
                        "data": [self._model_payload()],
                    },
                )
                return
            model_prefixes = ("/models/", "/v1/models/", "/api/v1/models/")
            for prefix in model_prefixes:
                if self.path.startswith(prefix):
                    requested_id = self.path[len(prefix):].strip()
                    if requested_id == runtime.args.model_id:
                        self._send_json(HTTPStatus.OK, self._model_payload())
                        return
                    self._send_json(
                        HTTPStatus.NOT_FOUND,
                        {"error": {"message": f"Model '{requested_id}' not found", "type": "not_found_error"}},
                    )
                    return
            self._send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "Not found", "type": "not_found_error"}})

        def _chat_stream(self, payload: dict[str, Any]) -> None:
            chunk_id = f"chatcmpl-{uuid.uuid4().hex}"
            created = int(time.time())
            model = str(payload.get("model") or runtime.args.model_id)
            self._send_sse_headers()
            self._write_sse(
                {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                }
            )
            final_chunk: GenerationChunk | None = None
            try:
                for chunk in runtime.stream_chat(payload):
                    if chunk.finished:
                        final_chunk = chunk
                        continue
                    if not chunk.delta:
                        continue
                    self._write_sse(
                        {
                            "id": chunk_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model,
                            "choices": [{"index": 0, "delta": {"content": chunk.delta}, "finish_reason": None}],
                        }
                    )
                if final_chunk is None:
                    raise RuntimeError("Streaming generation did not produce a final chunk.")
                usage = {
                    "prompt_tokens": final_chunk.prompt_tokens,
                    "completion_tokens": final_chunk.completion_tokens,
                    "total_tokens": final_chunk.prompt_tokens + final_chunk.completion_tokens,
                }
                self._write_sse(
                    {
                        "id": chunk_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [{"index": 0, "delta": {}, "finish_reason": final_chunk.finish_reason or "stop"}],
                        "usage": usage,
                    }
                )
            except Exception as exc:
                self._write_sse({"error": {"message": str(exc), "type": "server_error"}})
            finally:
                self._write_sse("[DONE]")

        def do_POST(self) -> None:
            try:
                payload = self._read_json()
                runtime.enforce_context_limit(payload)
                if self.path == "/v1/chat/completions":
                    if payload.get("stream"):
                        self._chat_stream(payload)
                        return
                    self._send_json(HTTPStatus.OK, runtime.generate_chat(payload))
                    return
                if self.path == "/v1/completions":
                    prompt = payload.get("prompt")
                    if not isinstance(prompt, str) or not prompt:
                        raise ValueError("'prompt' must be a non-empty string.")
                    chat_payload = {
                        "messages": [{"role": "user", "content": prompt}],
                        "model": payload.get("model") or runtime.args.model_id,
                        "max_tokens": payload.get("max_tokens"),
                        "max_completion_tokens": payload.get("max_completion_tokens"),
                        "temperature": payload.get("temperature", 0.0),
                    }
                    response = runtime.generate_chat(chat_payload)
                    message = response["choices"][0]["message"]["content"]
                    self._send_json(
                        HTTPStatus.OK,
                        {
                            "id": f"cmpl-{uuid.uuid4().hex}",
                            "object": "text_completion",
                            "created": response["created"],
                            "model": response["model"],
                            "choices": [
                                {
                                    "index": 0,
                                    "text": message,
                                    "finish_reason": response["choices"][0]["finish_reason"],
                                }
                            ],
                            "usage": response["usage"],
                        },
                    )
                    return
                self._send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "Not found", "type": "not_found_error"}})
            except ValueError as exc:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": {"message": str(exc), "type": "invalid_request_error"}},
                )
            except Exception as exc:
                traceback.print_exc()
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": {"message": str(exc), "type": "server_error"}},
                )

        def log_message(self, format: str, *args: Any) -> None:
            sys.stderr.write("[qwen36-dflash] " + format % args + "\n")

    return Handler


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    runtime = ServerRuntime(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(runtime))
    print(f"Serving Qwen DFlash API on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
