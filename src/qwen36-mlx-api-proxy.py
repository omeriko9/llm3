#!/usr/bin/env python3

import argparse
import asyncio
import atexit
import json
import os
import re
import signal
import shutil
import subprocess
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from transformers import AutoTokenizer, PreTrainedTokenizerFast


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--model-name", required=True)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8036)
    parser.add_argument("--backend-host", default="127.0.0.1")
    parser.add_argument("--backend-port", type=int, default=18036)
    parser.add_argument("--context-size", type=int, default=262144)
    parser.add_argument("--prefill-step-size", type=int, default=1024)
    parser.add_argument("--parallel", type=int, default=1)
    parser.add_argument("--default-temperature", type=float, default=0.6)
    parser.add_argument("--default-top-p", type=float, default=0.95)
    parser.add_argument("--default-top-k", type=int, default=20)
    parser.add_argument("--default-min-p", type=float, default=0.0)
    parser.add_argument("--default-presence-penalty", type=float, default=0.0)
    parser.add_argument("--default-repetition-penalty", type=float, default=1.0)
    return parser.parse_args()


ARGS = parse_args()
BACKEND_URL = f"http://{ARGS.backend_host}:{ARGS.backend_port}"
MODEL_ID = ARGS.model_name
BACKEND_PROCESS: subprocess.Popen | None = None
ENABLE_NARRATED_TOOL_CALL_RECOVERY = os.environ.get(
    "QWEN36_ENABLE_NARRATED_TOOL_RECOVERY", ""
).strip().lower() in {"1", "true", "yes", "on"}
NO_THINKING_GUIDANCE = (
    "Thinking is disabled on this server. Never reveal internal reasoning, planning, "
    "or chain-of-thought. Reply with only the final answer for the user."
)
THINK_BLOCK_RE = re.compile(r"<think>\s*.*?\s*</think>", re.IGNORECASE | re.DOTALL)
FINAL_ANSWER_PREFIX_RE = re.compile(r"^\s*(?:final answer|thus answer|answer)\s*:\s*", re.IGNORECASE)
PARAGRAPH_STEP_HEADING_RE = re.compile(r"^\s*\d+\.\s+\*\*[^*]+\*\*:\s*$")
CALLING_TOOL_MARKER_RE = re.compile(
    r"(?:^|\[)\s*Calling(?:\s+tool)?\s*(?:[:=])\s*",
    re.IGNORECASE | re.MULTILINE,
)
XMLISH_PARAMETER_RE = re.compile(
    r"(?s)<parameter=(?P<name>[\w.-]+)>\s*(?P<value>.*?)\s*</parameter>"
)
META_REASONING_RE = re.compile(
    r"^\s*(?:"
    r"thinking process\b|"
    r"chain[- ]of[- ]thought\b|"
    r"internal (?:draft|reasoning)\b|"
    r"analyze the request\b|"
    r"drafting the paragraph\b|"
    r"the user\b|"
    r"the question\b|"
    r"we need\b|"
    r"we should\b|"
    r"we must\b|"
    r"i need\b|"
    r"i should\b|"
    r"i must\b|"
    r"let'?s\b|"
    r"probably\b|"
    r"make sure\b|"
    r"first[,:\s]|"
    r"next[,:\s]|"
    r"finally[,:\s]|"
    r"thus answer\b|"
    r"final answer\b|"
    r"answer\b"
    r")",
    re.IGNORECASE,
)
MODEL_ROOT = Path(ARGS.model_dir).resolve()
STATE_ROOT = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))).expanduser()
OVERLAY_ROOT = STATE_ROOT / "qwen36_mlx" / "template_overlays"


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def has_chat_template(config: dict | None) -> bool:
    template = (config or {}).get("chat_template")
    return isinstance(template, str) and bool(template.strip())


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def resolve_local_chat_template(model_path: Path) -> tuple[str, str] | None:
    metadata = read_json(model_path / ".llm3-hf.json") or {}
    configured_path = metadata.get("chatTemplateFile")
    candidate_paths: list[Path] = []
    if isinstance(configured_path, str) and configured_path.strip():
        candidate_paths.append(model_path / configured_path.strip())
    candidate_paths.extend([
        model_path / "chat_template.jinja",
        model_path / ".llm3-chat-template.jinja",
    ])

    seen: set[Path] = set()
    for candidate in candidate_paths:
        resolved = candidate.resolve()
        if resolved in seen or not resolved.is_file():
            continue
        seen.add(resolved)
        template = read_text(resolved).strip()
        if template:
            return template, resolved.name
    return None


def candidate_template_sources(model_path: Path) -> list[Path]:
    name = model_path.name
    lower = name.lower()
    candidates: list[Path] = []

    for suffix in ("-mlx-4bit", "-mlx-6bit", "-mlx-8bit"):
        if lower.endswith(suffix):
            candidates.append(model_path.with_name(name[: -len(suffix)]))
            break

    if name.startswith("Qwen3.6-35B-A3B-") and name != "Qwen3.6-35B-A3B-mxfp4":
        candidates.append(model_path.with_name("Qwen3.6-35B-A3B-mxfp4"))

    deduped: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved == model_path or resolved in seen:
            continue
        seen.add(resolved)
        deduped.append(resolved)
    return deduped


def resolve_template_source(model_path: Path) -> Path | None:
    for candidate in candidate_template_sources(model_path):
        if not candidate.is_dir():
            continue
        config = read_json(candidate / "tokenizer_config.json")
        if has_chat_template(config):
            return candidate
    return None


def materialize_model_overlay(model_path: Path) -> Path:
    target_config = read_json(model_path / "tokenizer_config.json") or {}
    if has_chat_template(target_config):
        return model_path

    local_template = resolve_local_chat_template(model_path)
    if local_template is not None:
        chat_template, template_source_name = local_template
        source_config = target_config
    else:
        template_source = resolve_template_source(model_path)
        if template_source is None:
            return model_path

        source_config = read_json(template_source / "tokenizer_config.json") or {}
        chat_template = source_config.get("chat_template")
        if not isinstance(chat_template, str) or not chat_template.strip():
            return model_path
        template_source_name = template_source.name

    overlay_dir = OVERLAY_ROOT / model_path.name
    if overlay_dir.exists():
        shutil.rmtree(overlay_dir)
    overlay_dir.mkdir(parents=True, exist_ok=True)

    for child in model_path.iterdir():
        if child.name == "tokenizer_config.json":
            continue
        os.symlink(child, overlay_dir / child.name, target_is_directory=child.is_dir())

    merged_config = dict(target_config)
    merged_config["chat_template"] = chat_template
    if not merged_config.get("tool_parser_type") and source_config.get("tool_parser_type"):
        merged_config["tool_parser_type"] = source_config["tool_parser_type"]

    (overlay_dir / "tokenizer_config.json").write_text(
        json.dumps(merged_config, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"[mlx-template] Injected chat_template for {model_path.name} from {template_source_name}",
        flush=True,
    )
    return overlay_dir


EFFECTIVE_MODEL_PATH = materialize_model_overlay(MODEL_ROOT)
MODEL_PATH = str(EFFECTIVE_MODEL_PATH)
MODEL_CONFIG = read_json(EFFECTIVE_MODEL_PATH / "config.json") or read_json(MODEL_ROOT / "config.json") or {}
MODEL_IDS = {
    MODEL_ID,
    MODEL_PATH,
    str(MODEL_ROOT),
    os.path.basename(MODEL_PATH),
    MODEL_ROOT.name,
}


def _text_config(config: dict | None) -> dict:
    value = (config or {}).get("text_config")
    return value if isinstance(value, dict) else {}


def model_uses_hybrid_cache(config: dict | None) -> bool:
    architectures = list((config or {}).get("architectures") or [])
    text_architectures = list(_text_config(config).get("architectures") or [])
    candidates = [str(value).lower() for value in [*architectures, *text_architectures]]
    if any("moe" in value for value in candidates):
        return True
    if any("qwen3_5" in value or "qwen3.5" in value or "qwen3_6" in value or "qwen3.6" in value for value in candidates):
        return True
    if int(_text_config(config).get("num_experts") or 0) > 0:
        return True
    return False


def backend_prefill_step_size() -> int:
    requested = max(128, int(ARGS.prefill_step_size or 1024))
    if model_uses_hybrid_cache(MODEL_CONFIG):
        return min(requested, 512)
    if ARGS.context_size >= 262144:
        return min(requested, 768)
    return requested


def backend_chunked_prefill_tokens(prefill_step_size: int) -> int:
    if model_uses_hybrid_cache(MODEL_CONFIG):
        return 0
    return max(128, int(prefill_step_size))


def backend_should_use_paged_cache() -> bool:
    return model_uses_hybrid_cache(MODEL_CONFIG) or ARGS.context_size >= 262144


def backend_max_cache_blocks() -> int:
    requested = max(2048, (int(ARGS.context_size) + 63) // 64)
    return min(requested, 16384)


def _token_value(value):
    if isinstance(value, dict):
        content = value.get("content")
        return str(content).strip() if content else None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def load_tokenizer(model_path: str):
    try:
        return AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    except Exception as exc:
        config = read_json(Path(model_path) / "tokenizer_config.json") or {}
        tokenizer_file = Path(model_path) / "tokenizer.json"
        if not tokenizer_file.is_file():
            raise
        kwargs = {
            "tokenizer_file": str(tokenizer_file),
            "model_max_length": int(config.get("model_max_length") or 0) or None,
            "bos_token": _token_value(config.get("bos_token")),
            "eos_token": _token_value(config.get("eos_token")),
            "pad_token": _token_value(config.get("pad_token")),
            "unk_token": _token_value(config.get("unk_token")),
        }
        kwargs = {key: value for key, value in kwargs.items() if value is not None}
        tokenizer = PreTrainedTokenizerFast(**kwargs)
        chat_template = config.get("chat_template")
        if isinstance(chat_template, str) and chat_template.strip():
            tokenizer.chat_template = chat_template
        print(
            f"[mlx-tokenizer] AutoTokenizer failed for {model_path}: {exc}. "
            "Falling back to PreTrainedTokenizerFast(tokenizer.json).",
            flush=True,
        )
        return tokenizer


TOKENIZER = load_tokenizer(MODEL_PATH)


def _append_system_guidance(messages: list[dict], guidance_text: str) -> None:
    guidance = {"role": "system", "content": guidance_text}
    if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system":
        content = messages[0].get("content")
        if isinstance(content, str):
            if guidance_text not in content:
                messages[0]["content"] = f"{guidance_text}\n\n{content}"
        else:
            messages.insert(0, guidance)
    else:
        messages.insert(0, guidance)


def _looks_like_meta_reasoning(paragraph: str) -> bool:
    return bool(META_REASONING_RE.match(paragraph.strip()))


def _extract_answer_candidate(paragraph: str) -> str | None:
    lines = [line.strip() for line in paragraph.splitlines() if line.strip()]
    if not lines:
        return None

    if len(lines) == 1 and _looks_like_meta_reasoning(lines[0]):
        return None

    if PARAGRAPH_STEP_HEADING_RE.match(lines[0]):
        lines = lines[1:]
    elif _looks_like_meta_reasoning(lines[0]) and len(lines) > 1:
        lines = lines[1:]

    if not lines:
        return None

    if all(line.startswith("*") for line in lines):
        return None

    candidate = " ".join(lines).strip()
    candidate = re.sub(r"^\s*\d+\.\s+\*\*[^*]+\*\*\s*", "", candidate)
    candidate = FINAL_ANSWER_PREFIX_RE.sub("", candidate).strip().strip('"')
    if not candidate or _looks_like_meta_reasoning(candidate):
        return None
    return candidate


def sanitize_assistant_content(content: str | None) -> str | None:
    if not isinstance(content, str) or not content.strip():
        return content

    cleaned = THINK_BLOCK_RE.sub("", content)
    cleaned = cleaned.replace("<think>", "").replace("</think>", "").strip()
    if not cleaned:
        return ""

    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", cleaned) if part.strip()]
    answer_candidates = [candidate for part in paragraphs if (candidate := _extract_answer_candidate(part))]
    has_reasoning_scaffold = any(
        _looks_like_meta_reasoning(part)
        or PARAGRAPH_STEP_HEADING_RE.match(part.splitlines()[0].strip() if part.splitlines() else "")
        for part in paragraphs[:-1]
    )
    if has_reasoning_scaffold and answer_candidates:
        return answer_candidates[-1]

    if len(paragraphs) >= 2 and all(_looks_like_meta_reasoning(part) for part in paragraphs[:-1]):
        tail = FINAL_ANSWER_PREFIX_RE.sub("", paragraphs[-1]).strip().strip('"')
        if tail and not _looks_like_meta_reasoning(tail):
            return tail

    marker_matches = list(re.finditer(r"\b(?:final answer|thus answer|answer)\s*:\s*", cleaned, re.IGNORECASE))
    if marker_matches:
        tail = cleaned[marker_matches[-1].end() :].strip().strip('"')
        if tail:
            return tail

    return cleaned


def _extract_json_object_prefix(value: str) -> dict | None:
    start = value.find("{")
    if start < 0:
        return None
    candidate = value[start:]
    attempts = [candidate]
    trimmed = re.sub(r"[\]\)\s]+$", "", candidate)
    if trimmed != candidate:
        attempts.append(trimmed)
    attempts.extend([trimmed + "}", trimmed + "}}", candidate + "}", candidate + "}}"])

    seen = set()
    for attempt in attempts:
        if attempt in seen:
            continue
        seen.add(attempt)
        try:
            parsed, _ = json.JSONDecoder().raw_decode(attempt)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _coerce_xmlish_parameter_value(value: str) -> object:
    value = value.strip()
    if not value:
        return ""

    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered == "null":
        return None

    if re.fullmatch(r"-?\d+", value):
        try:
            return int(value)
        except ValueError:
            pass

    if re.fullmatch(r"-?\d+\.\d+", value):
        try:
            return float(value)
        except ValueError:
            pass

    if value[:1] in "{[":
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            pass

    return value


def _extract_xmlish_parameters(value: str) -> dict[str, object]:
    params: dict[str, object] = {}
    for match in XMLISH_PARAMETER_RE.finditer(value):
        params[match.group("name")] = _coerce_xmlish_parameter_value(match.group("value"))
    return params


def _normalize_narrated_tool_name(name: str) -> str:
    normalized = re.sub(r"[\s-]+", "_", name.strip()).lower()
    aliases = {
        "terminal_command": "terminal",
        "write_file_command": "write_file",
    }
    return aliases.get(normalized, normalized)


def _build_narrated_tool_call(name: str, arguments: dict[str, object]) -> dict:
    return {
        "id": f"call_proxy_{uuid.uuid4().hex[:8]}",
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(arguments, ensure_ascii=False),
        },
    }


def extract_narrated_tool_calls(content: str | None) -> list[dict]:
    if not ENABLE_NARRATED_TOOL_CALL_RECOVERY or not isinstance(content, str):
        return []

    matches = list(CALLING_TOOL_MARKER_RE.finditer(content))
    if not matches:
        return []

    tool_calls: list[dict] = []
    for index, match in enumerate(matches):
        segment_end = matches[index + 1].start() if index + 1 < len(matches) else len(content)
        body = content[match.end() : segment_end].strip().rstrip("]")
        if not body:
            continue

        name_match = re.match(r"(?P<name>[A-Za-z_][\w.-]*(?:[\s-]+[A-Za-z_][\w.-]*)*)", body)
        if not name_match:
            continue

        name = _normalize_narrated_tool_name(name_match.group("name"))
        remainder = body[name_match.end() :].strip()
        while remainder[:1] in {"(", ">", ":", "="}:
            remainder = remainder[1:].lstrip()

        arguments: dict[str, object] = {}
        if remainder:
            if "<parameter=" in remainder:
                arguments = _extract_xmlish_parameters(remainder)
                if not arguments:
                    continue
            else:
                parsed_arguments = _extract_json_object_prefix(remainder)
                if parsed_arguments is None:
                    if remainder.strip().strip(")]}"):
                        continue
                else:
                    arguments = parsed_arguments

        tool_calls.append(_build_narrated_tool_call(name, arguments))

    return tool_calls


def extract_narrated_tool_call(content: str | None) -> dict | None:
    tool_calls = extract_narrated_tool_calls(content)
    return tool_calls[0] if tool_calls else None


def terminate_backend() -> None:
    global BACKEND_PROCESS
    if BACKEND_PROCESS is None:
        return
    if BACKEND_PROCESS.poll() is not None:
        BACKEND_PROCESS = None
        return
    BACKEND_PROCESS.terminate()
    try:
        BACKEND_PROCESS.wait(timeout=10)
    except subprocess.TimeoutExpired:
        BACKEND_PROCESS.kill()
        BACKEND_PROCESS.wait(timeout=5)
    BACKEND_PROCESS = None


def signal_handler(signum, _frame) -> None:
    terminate_backend()
    raise SystemExit(128 + signum)


def start_backend() -> subprocess.Popen:
    env = os.environ.copy()
    prefill_step_size = backend_prefill_step_size()
    chunked_prefill_tokens = backend_chunked_prefill_tokens(prefill_step_size)
    cmd = [
        os.path.expanduser("~/.venvs/rapid-mlx/bin/rapid-mlx"),
        "serve",
        MODEL_PATH,
        "--served-model-name",
        MODEL_ID,
        "--host",
        ARGS.backend_host,
        "--port",
        str(ARGS.backend_port),
        "--max-num-seqs",
        str(ARGS.parallel),
        "--prefill-step-size",
        str(prefill_step_size),
        "--prefill-batch-size",
        str(ARGS.parallel),
        "--completion-batch-size",
        str(ARGS.parallel),
        "--kv-cache-quantization",
        "--kv-cache-quantization-bits",
        "8",
        "--gpu-memory-utilization",
        "0.95",
        "--enable-auto-tool-choice",
        "--tool-call-parser",
        "qwen3_coder_xml",
        "--no-thinking",
        "--api-key",
        "api",
        "--log-level",
        "INFO",
    ]
    if chunked_prefill_tokens > 0:
        cmd.extend([
            "--chunked-prefill-tokens",
            str(chunked_prefill_tokens),
        ])
    if backend_should_use_paged_cache():
        cmd.extend([
            "--use-paged-cache",
            "--paged-cache-block-size",
            "64",
            "--max-cache-blocks",
            str(backend_max_cache_blocks()),
            "--pin-system-prompt",
        ])
    return subprocess.Popen(cmd, env=env)


async def wait_for_backend() -> None:
    async with httpx.AsyncClient(timeout=5.0, headers={"Authorization": "Bearer api"}) as client:
        for _ in range(180):
            if BACKEND_PROCESS is not None and BACKEND_PROCESS.poll() is not None:
                raise RuntimeError(f"Backend exited with code {BACKEND_PROCESS.returncode}")
            try:
                response = await client.get(f"{BACKEND_URL}/v1/models")
                if response.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(1)
    raise RuntimeError("Timed out waiting for backend server")


def normalize_payload(payload: object) -> object:
    if not isinstance(payload, dict):
        return payload

    payload["model"] = MODEL_ID
    payload["enable_thinking"] = False
    messages = payload.get("messages")
    if isinstance(messages, list):
        _append_system_guidance(messages, NO_THINKING_GUIDANCE)

    if isinstance(payload.get("tools"), list) and payload["tools"]:
        payload.setdefault("temperature", 0)
        payload.setdefault("top_p", 1)

    for key, value in (
        ("temperature", ARGS.default_temperature),
        ("top_p", ARGS.default_top_p),
        ("top_k", ARGS.default_top_k),
        ("min_p", ARGS.default_min_p),
        ("presence_penalty", ARGS.default_presence_penalty),
        ("repetition_penalty", ARGS.default_repetition_penalty),
    ):
        if payload.get(key) in (None, ""):
            payload[key] = value

    return payload


def estimate_chat_tokens(payload: dict) -> int | None:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return None

    fallback_count = None
    try:
        serialized = json.dumps(
            {
                "messages": messages,
                "tools": payload.get("tools"),
            },
            ensure_ascii=False,
        )
        fallback_tokens = TOKENIZER(
            serialized,
            add_special_tokens=True,
            return_attention_mask=False,
            return_token_type_ids=False,
        )["input_ids"]
        fallback_count = len(fallback_tokens)
    except Exception:
        fallback_count = None

    try:
        tokens = TOKENIZER.apply_chat_template(
            messages,
            tools=payload.get("tools"),
            tokenize=True,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        primary_count = len(tokens)
        if fallback_count is not None:
            return max(primary_count, fallback_count)
        return primary_count
    except Exception:
        return fallback_count


def enforce_context_limit(payload: dict) -> None:
    prompt_tokens = estimate_chat_tokens(payload)
    if prompt_tokens is None:
        return

    max_tokens = (
        payload.get("max_tokens")
        or payload.get("max_completion_tokens")
        or 512
    )

    effective_limit = ARGS.context_size
    if prompt_tokens + int(max_tokens) > effective_limit:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Requested prompt ({prompt_tokens} tokens) plus max output ({int(max_tokens)}) "
                f"exceeds configured context size {effective_limit}."
            ),
        )


def models_payload() -> dict:
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_ID,
                "object": "model",
                "created": 0,
                "owned_by": "local-mlx",
            }
        ],
    }


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global BACKEND_PROCESS
    BACKEND_PROCESS = start_backend()
    await wait_for_backend()
    yield
    terminate_backend()


app = FastAPI(lifespan=lifespan)


@app.get("/")
@app.get("/models")
@app.get("/v1/models")
@app.get("/api/v1/models")
async def list_models() -> dict:
    return models_payload()


@app.get("/version")
@app.get("/v1/health")
@app.get("/v1/healthz")
async def basic_health() -> dict:
    return {"ok": True, "model": MODEL_ID}


def rewrite_chat_response(raw: bytes) -> bytes:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return raw

    choices = payload.get("choices")
    if not isinstance(choices, list):
        return raw

    for choice in choices:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict):
            continue
        message.pop("reasoning_content", None)
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list) and tool_calls:
            message["content"] = None
        else:
            narrated_tool_calls = extract_narrated_tool_calls(message.get("content"))
            if narrated_tool_calls:
                message["content"] = None
                message["tool_calls"] = narrated_tool_calls
                if choice.get("finish_reason") == "stop":
                    choice["finish_reason"] = "tool_calls"
            else:
                message["content"] = sanitize_assistant_content(message.get("content"))

    return json.dumps(payload).encode("utf-8")


def rewrite_chat_stream_response(raw: bytes) -> bytes:
    lines = raw.decode("utf-8", errors="replace").splitlines(keepends=True)
    saw_tool_calls = False
    parsed_lines: list[tuple[str, object]] = []
    full_content_parts: list[str] = []

    for line in lines:
        if not line.startswith("data: "):
            parsed_lines.append(("raw", line))
            continue
        payload_text = line[6:].strip()
        if not payload_text or payload_text == "[DONE]":
            parsed_lines.append(("raw", line))
            continue
        try:
            payload = json.loads(payload_text)
        except json.JSONDecodeError:
            parsed_lines.append(("raw", line))
            continue
        choices = payload.get("choices")
        if isinstance(choices, list):
            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta")
                if isinstance(delta, dict) and isinstance(delta.get("tool_calls"), list) and delta["tool_calls"]:
                    saw_tool_calls = True
                if isinstance(delta, dict) and isinstance(delta.get("content"), str):
                    full_content_parts.append(delta["content"])
        parsed_lines.append(("json", payload))

    sanitized_stream_content = sanitize_assistant_content("".join(full_content_parts))
    narrated_tool_calls = None if saw_tool_calls else extract_narrated_tool_calls("".join(full_content_parts))
    replace_stream_content = (
        not saw_tool_calls
        and not narrated_tool_calls
        and full_content_parts
        and isinstance(sanitized_stream_content, str)
        and sanitized_stream_content != "".join(full_content_parts)
    )
    emitted_sanitized_content = False

    if narrated_tool_calls:
        first_payload = next((value for kind, value in parsed_lines if kind == "json"), None)
        last_payload = next((value for kind, value in reversed(parsed_lines) if kind == "json"), None)
        if not isinstance(first_payload, dict) or not isinstance(last_payload, dict):
            return raw

        first_choice = ((first_payload.get("choices") or [{}])[0]) if isinstance(first_payload.get("choices"), list) else {}
        last_choice = ((last_payload.get("choices") or [{}])[0]) if isinstance(last_payload.get("choices"), list) else {}
        role = None
        if isinstance(first_choice, dict):
            delta = first_choice.get("delta")
            if isinstance(delta, dict):
                role = delta.get("role")

        usage = last_payload.get("usage")
        index = first_choice.get("index", 0) if isinstance(first_choice, dict) else 0
        stream_id = first_payload.get("id")
        stream_object = first_payload.get("object")
        stream_created = first_payload.get("created")
        stream_model = first_payload.get("model")

        rewritten = []
        if role is not None:
            rewritten.append(
                "data: "
                + json.dumps(
                    {
                        "id": stream_id,
                        "object": stream_object,
                        "created": stream_created,
                        "model": stream_model,
                        "choices": [{"index": index, "delta": {"role": role}}],
                    }
                )
                + "\n"
            )
        rewritten.append(
            "data: "
            + json.dumps(
                {
                    "id": stream_id,
                    "object": stream_object,
                    "created": stream_created,
                    "model": stream_model,
                    "choices": [
                        {
                            "index": index,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": tool_index,
                                        "id": narrated_tool_call["id"],
                                        "type": "function",
                                        "function": narrated_tool_call["function"],
                                    }
                                    for tool_index, narrated_tool_call in enumerate(narrated_tool_calls)
                                ]
                            },
                        }
                    ],
                }
            )
            + "\n"
        )
        finish_payload = {
            "id": stream_id,
            "object": stream_object,
            "created": stream_created,
            "model": stream_model,
            "choices": [{"index": index, "delta": {}, "finish_reason": "tool_calls"}],
        }
        if usage is not None:
            finish_payload["usage"] = usage
        rewritten.append("data: " + json.dumps(finish_payload) + "\n")
        rewritten.append("data: [DONE]\n")
        return "\n".join(rewritten).encode("utf-8")

    rewritten: list[str] = []
    for kind, value in parsed_lines:
        if kind == "raw":
            rewritten.append(value)
            continue
        payload = value
        choices = payload.get("choices")
        if isinstance(choices, list):
            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta")
                if not isinstance(delta, dict):
                    continue
                delta.pop("reasoning_content", None)
                if saw_tool_calls:
                    delta.pop("content", None)
                elif replace_stream_content and "content" in delta:
                    if not emitted_sanitized_content:
                        delta["content"] = sanitized_stream_content
                        emitted_sanitized_content = True
                    else:
                        delta.pop("content", None)
        rewritten.append(f"data: {json.dumps(payload)}\n")

    return "".join(rewritten).encode("utf-8")


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy(path: str, request: Request) -> Response:
    normalized_path = "/" + path.lstrip("/")
    url = f"{BACKEND_URL}/{path}"
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in {"host", "content-length", "connection", "transfer-encoding"}
    }
    headers["authorization"] = "Bearer api"
    body = await request.body()
    payload = None

    if normalized_path.endswith("/chat/completions") or normalized_path.endswith("/completions"):
        payload = normalize_payload(await request.json())
        enforce_context_limit(payload)
        body = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"

    timeout = httpx.Timeout(connect=30.0, read=600.0, write=600.0, pool=30.0)

    if normalized_path.endswith("/chat/completions") and isinstance(payload, dict) and payload.get("stream") is True:
        client = httpx.AsyncClient(timeout=timeout)
        try:
            upstream_request = client.build_request(
                request.method,
                url,
                headers=headers,
                content=body,
                params=request.query_params,
            )
            upstream = await client.send(upstream_request, stream=True)
        except httpx.HTTPError as exc:
            await client.aclose()
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        response_headers = {
            key: value
            for key, value in upstream.headers.items()
            if key.lower() not in {"content-length", "content-encoding", "transfer-encoding", "connection"}
        }
        media_type = upstream.headers.get("content-type")

        async def iter_stream():
            raw_chunks: list[bytes] = []
            try:
                async for chunk in upstream.aiter_raw():
                    raw_chunks.append(chunk)
            finally:
                await upstream.aclose()
                await client.aclose()
            yield rewrite_chat_stream_response(b"".join(raw_chunks))

        return StreamingResponse(
            iter_stream(),
            status_code=upstream.status_code,
            headers=response_headers,
            media_type=media_type,
        )

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            upstream = await client.request(
                request.method,
                url,
                headers=headers,
                content=body,
                params=request.query_params,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    response_headers = {
        key: value
        for key, value in upstream.headers.items()
        if key.lower() not in {"content-length", "content-encoding", "transfer-encoding", "connection"}
    }
    content = upstream.content
    if normalized_path.endswith("/chat/completions") and upstream.headers.get("content-type", "").startswith("application/json"):
        content = rewrite_chat_response(upstream.content)
    elif normalized_path.endswith("/chat/completions") and upstream.headers.get("content-type", "").startswith("text/event-stream"):
        content = rewrite_chat_stream_response(upstream.content)
    return Response(
        content=content,
        status_code=upstream.status_code,
        headers=response_headers,
        media_type=upstream.headers.get("content-type"),
    )


def main() -> None:
    atexit.register(terminate_backend)
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    uvicorn.run(app, host=ARGS.host, port=ARGS.port, log_level="info")


if __name__ == "__main__":
    main()
