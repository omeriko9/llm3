#!/usr/bin/env python3
"""HTTP wrapper for upstream Chatterbox Multilingual + Phonikud Hebrew TTS."""

from __future__ import annotations

import argparse
import atexit
import base64
import gc
import io
import json
import logging
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path

import soundfile as sf
import torch
from chatterbox.mtl_tts import ChatterboxMultilingualTTS, punc_norm
from chatterbox.models.s3tokenizer import S3_TOKEN_RATE, drop_invalid_tokens
from chatterbox.models.s3gen import S3GEN_SR
from chatterbox_voice_library import available_voice_names, build_voice_catalog, resolve_voice
from chatterbox.models.t3.inference.t3_hf_backend import T3HuggingfaceBackend
from chatterbox.models.t3.t3 import T3, _ensure_BOT_EOT
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from phonikud import lexicon
from phonikud_onnx import Phonikud
from tqdm import tqdm
from transformers.modeling_outputs import CausalLMOutputWithCrossAttentions
from transformers.generation.logits_process import (
    MinPLogitsWarper,
    RepetitionPenaltyLogitsProcessor,
    TopPLogitsWarper,
)
from chatterbox.models.tokenizers import tokenizer as chatterbox_tokenizer_module

app = Flask(__name__)
CORS(app)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("phonikud-upstream")

DEFAULT_MODEL_ROOT = Path(os.path.expanduser(os.getenv("PHONIKUD_UPSTREAM_MODEL_ROOT", "~/models/voice/voice-tts/phonikud-upstream")))
DEFAULT_PHONIKUD_MODEL = Path(
    os.path.expanduser(os.getenv("PHONIKUD_UPSTREAM_ONNX_PATH", str(DEFAULT_MODEL_ROOT / "phonikud-1.0.int8.onnx")))
)
DEFAULT_REF_AUDIO = Path(
    os.path.expanduser(os.getenv("PHONIKUD_UPSTREAM_REF_AUDIO", str(DEFAULT_MODEL_ROOT / "female1.wav")))
)
DEFAULT_VOICE = os.getenv("PHONIKUD_UPSTREAM_DEFAULT_VOICE", "female1")
DEFAULT_SPEED = float(os.getenv("PHONIKUD_UPSTREAM_DEFAULT_SPEED", "1.0"))
DEFAULT_EXAGGERATION = float(os.getenv("PHONIKUD_UPSTREAM_DEFAULT_EXAGGERATION", "0.5"))
DEFAULT_CFG_WEIGHT = float(os.getenv("PHONIKUD_UPSTREAM_DEFAULT_CFG_WEIGHT", "0.5"))
DEFAULT_TEMPERATURE = float(os.getenv("PHONIKUD_UPSTREAM_DEFAULT_TEMPERATURE", "0.8"))
DEFAULT_REPETITION_PENALTY = float(os.getenv("PHONIKUD_UPSTREAM_DEFAULT_REPETITION_PENALTY", "1.2"))
DEFAULT_MIN_P = float(os.getenv("PHONIKUD_UPSTREAM_DEFAULT_MIN_P", "0.05"))
DEFAULT_TOP_P = float(os.getenv("PHONIKUD_UPSTREAM_DEFAULT_TOP_P", "1.0"))
# RNG seed for the autoregressive token sampler. >= 0 seeds every generate() call so
# output is reproducible (consistent delivery across chunks); < 0 leaves the global RNG
# untouched (legacy random-per-request behavior).
DEFAULT_SEED = int(os.getenv("PHONIKUD_UPSTREAM_DEFAULT_SEED", "1234"))
DEFAULT_T3_MODEL = str(os.getenv("PHONIKUD_UPSTREAM_T3_MODEL", "v3") or "v3").strip()
ENABLE_ATEMPO_SPEED = os.getenv("PHONIKUD_UPSTREAM_ENABLE_ATEMPO_SPEED", "true").strip().lower() in {"1", "true", "yes"}
GC_AFTER_REQUEST = os.getenv("PHONIKUD_UPSTREAM_GC_AFTER_REQUEST", "true").strip().lower() in {"1", "true", "yes"}
MPS_EMPTY_CACHE_AFTER_REQUEST = os.getenv("PHONIKUD_UPSTREAM_MPS_EMPTY_CACHE_AFTER_REQUEST", "true").strip().lower() in {"1", "true", "yes"}
MPS_MEMORY_FRACTION = float(os.getenv("PHONIKUD_UPSTREAM_MPS_MEMORY_FRACTION", "0.12") or "0.12")
TOKEN_REPEAT_LIMIT = max(0, int(os.getenv("PHONIKUD_UPSTREAM_TOKEN_REPEAT_LIMIT", "64") or "64"))
_MAX_NEW_TOKENS_ENV = int(os.getenv("PHONIKUD_UPSTREAM_MAX_NEW_TOKENS", "1000") or "1000")
MAX_NEW_TOKENS = _MAX_NEW_TOKENS_ENV if _MAX_NEW_TOKENS_ENV > 0 else None
SLOW_TAIL_TOKEN_THRESHOLD = max(0, int(os.getenv("PHONIKUD_UPSTREAM_SLOW_TAIL_TOKEN_THRESHOLD", "420") or "420"))
SLOW_TAIL_MAX_SECONDS = max(0.0, float(os.getenv("PHONIKUD_UPSTREAM_SLOW_TAIL_MAX_SECONDS", "120") or "120"))
FFMPEG_PATH = os.getenv("FFMPEG_PATH") or "/opt/homebrew/bin/ffmpeg"

# --- Speed knobs (all default to legacy behavior) ---------------------------
# T3 backbone dtype: float32 (legacy) | float16 | bfloat16. The s3gen vocoder
# and voice encoder always stay float32; sampling math runs on float32 logits.
T3_DTYPE_NAME = str(os.getenv("PHONIKUD_UPSTREAM_T3_DTYPE", "float32")).strip().lower()
T3_DTYPE = {"float16": torch.float16, "half": torch.float16, "bfloat16": torch.bfloat16}.get(T3_DTYPE_NAME)
# Fast sampling keeps the exact same sampling math (penalty -> temperature ->
# min_p -> top_p -> categorical draw) but samples on-GPU via the Gumbel-max
# trick and defers the GPU->CPU EOS check to every K tokens (post-EOS tokens
# are discarded, so the emitted sequence is unchanged).
FAST_SAMPLING = os.getenv("PHONIKUD_UPSTREAM_FAST_SAMPLING", "false").strip().lower() in {"1", "true", "yes"}
FAST_SAMPLING_SYNC_EVERY = max(1, int(os.getenv("PHONIKUD_UPSTREAM_FAST_SAMPLING_SYNC_EVERY", "8") or "8"))
# The Perth watermarker runs on CPU per chunk; disabling it skips that pass.
DISABLE_WATERMARK = os.getenv("PHONIKUD_UPSTREAM_DISABLE_WATERMARK", "false").strip().lower() in {"1", "true", "yes"}
# Full gc.collect() + torch.mps.empty_cache() after every request costs real
# time per chunk; raise to amortize (1 = legacy behavior).
GC_EVERY_N_REQUESTS = max(1, int(os.getenv("PHONIKUD_UPSTREAM_GC_EVERY_N_REQUESTS", "1") or "1"))
_REQUEST_COUNTER_LOCK = threading.Lock()
_REQUEST_COUNTER = 0
# tqdm progress bars in a daemonized server only spam the log file.
PROGRESS_BAR_ENABLED = sys.stderr.isatty()
# Micro-batching: coalesce up to N concurrent /tts requests into ONE batched
# T3 decode (the decode loop is dispatch-bound on MPS, so 3 chunks per forward
# cost ~1.4x one chunk = ~2x throughput). 1 = legacy serial behavior.
BATCH_MAX_REQUESTS = max(1, int(os.getenv("PHONIKUD_UPSTREAM_BATCH_MAX_REQUESTS", "1") or "1"))
BATCH_WINDOW_MS = max(0, int(os.getenv("PHONIKUD_UPSTREAM_BATCH_WINDOW_MS", "250") or "250"))


class _NoopWatermarker:
    def apply_watermark(self, wav, sample_rate=None, **_kwargs):
        return wav

MODEL: ChatterboxMultilingualTTS | None = None
PHONIKUD_MODEL: Phonikud | None = None
CONDITIONALS_CACHE: dict[tuple[str, float], object] = {}
_MODEL_LOCK = threading.Lock()
_CONDITIONALS_LOCK = threading.Lock()
_TTS_INFERENCE_SEMAPHORE = threading.Semaphore(1)
_MPS_MEMORY_LIMIT_CONFIGURED = False
PROCESS_STARTED_AT = time.time()
EXIT_MARKER_PATH = Path(os.path.expanduser(os.getenv("PHONIKUD_UPSTREAM_EXIT_MARKER_FILE", ""))).expanduser() if os.getenv("PHONIKUD_UPSTREAM_EXIT_MARKER_FILE") else None
_EXIT_MARKER_LOCK = threading.Lock()
_EXIT_MARKER_WRITTEN = False
_original_add_hebrew_diacritics = chatterbox_tokenizer_module.add_hebrew_diacritics


def _write_exit_marker(reason: str, **extra: object) -> None:
    global _EXIT_MARKER_WRITTEN
    payload = {
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "reason": str(reason or "unknown"),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "uptime_seconds": round(max(0.0, time.time() - PROCESS_STARTED_AT), 3),
    }
    payload.update(extra)
    logger.error("Phonikud upstream exit marker: %s", payload)
    if EXIT_MARKER_PATH is None:
        return
    with _EXIT_MARKER_LOCK:
        if _EXIT_MARKER_WRITTEN and payload.get("reason") == "atexit":
            return
        EXIT_MARKER_PATH.parent.mkdir(parents=True, exist_ok=True)
        EXIT_MARKER_PATH.write_text(f"{json.dumps(payload, ensure_ascii=True)}\n", encoding="utf-8")
        _EXIT_MARKER_WRITTEN = True


def _signal_handler(signum: int, _frame) -> None:
    signal_name = signal.Signals(signum).name
    _write_exit_marker("signal", signal=signal_name, signum=signum)
    raise SystemExit(128 + int(signum))


def _excepthook(exc_type, exc_value, exc_traceback) -> None:
    formatted = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback))
    _write_exit_marker(
        "uncaught_exception",
        exception_type=getattr(exc_type, "__name__", str(exc_type)),
        exception=str(exc_value),
        traceback=formatted[-8000:],
    )
    sys.__excepthook__(exc_type, exc_value, exc_traceback)


def _atexit_handler() -> None:
    _write_exit_marker("atexit")


sys.excepthook = _excepthook
for _sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(_sig, _signal_handler)
faulthandler_enabled = False
try:
    import faulthandler

    faulthandler.enable(all_threads=True)
    faulthandler_enabled = True
except Exception:
    faulthandler_enabled = False
atexit.register(_atexit_handler)


def _legacy_voice_entries() -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for name, prompt in VOICE_PRESETS.items():
        if name == "default":
            continue
        entries.append({
            "name": name,
            "prompt_path": str(prompt) if prompt else None,
            "aliases": ["default"] if name == "female1" else [],
            "builtin": prompt is None,
            "deletable": bool(prompt),
        })
    return entries


def has_hebrew_diacritics(text: str) -> bool:
    return any("\u05b0" <= char <= "\u05c7" for char in text or "")


def add_hebrew_diacritics_if_needed(text: str) -> str:
    if has_hebrew_diacritics(text):
        return text
    return _original_add_hebrew_diacritics(text)


chatterbox_tokenizer_module.add_hebrew_diacritics = add_hebrew_diacritics_if_needed


def voice_catalog() -> dict[str, object]:
    return build_voice_catalog(DEFAULT_MODEL_ROOT, legacy_voices=_legacy_voice_entries(), default_voice=DEFAULT_VOICE)


def voice_asset_path(file_name: str) -> Path:
    return DEFAULT_MODEL_ROOT / file_name


def extra_voice_presets() -> dict[str, Path]:
    """Personal reference voices from VOICE_EXTRA_PRESETS="name:file.wav,...".

    The files live in the model root. Kept out of the code because the preset
    names are private.
    """
    presets: dict[str, Path] = {}
    for item in os.getenv("VOICE_EXTRA_PRESETS", "").split(","):
        name, _, file_name = item.strip().partition(":")
        if name.strip() and file_name.strip():
            presets[name.strip()] = voice_asset_path(file_name.strip())
    return presets


VOICE_PRESETS = {
    "default": DEFAULT_REF_AUDIO,
    "female1": DEFAULT_REF_AUDIO,
    "female2": voice_asset_path("female2.wav"),
    "male1": voice_asset_path("male1.wav"),
    "butcher": voice_asset_path("Butcher.wav"),
    "london": voice_asset_path("London.wav"),
    **extra_voice_presets(),
    "builtin": None,
}


def pick_device() -> str:
    explicit = str(os.getenv("PHONIKUD_UPSTREAM_DEVICE") or os.getenv("CHATTERBOX_DEVICE") or "").strip().lower()
    if explicit:
        return explicit
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def seed_rng(seed: int) -> None:
    """Seed every torch RNG so the multinomial token sampler is reproducible.

    Without this the global RNG advances continuously across requests, so each chunk
    is an independent random draw and successive chunks sound like different takes even
    with identical tuning. Seeding before each generate() anchors the sampler.
    """
    torch.manual_seed(seed)
    try:
        if torch.backends.mps.is_available():
            torch.mps.manual_seed(seed)
    except Exception:
        pass
    try:
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except Exception:
        pass


def configure_mps_memory_limit(device: str | None = None) -> None:
    global _MPS_MEMORY_LIMIT_CONFIGURED
    active_device = str(device or pick_device())
    if _MPS_MEMORY_LIMIT_CONFIGURED or active_device != "mps" or MPS_MEMORY_FRACTION <= 0:
        return
    try:
        torch.mps.set_per_process_memory_fraction(MPS_MEMORY_FRACTION)
        logger.info("Configured Phonikud upstream MPS memory fraction to %.3f", MPS_MEMORY_FRACTION)
    except Exception as exc:
        logger.warning("Could not configure Phonikud upstream MPS memory fraction: %s", exc)
    _MPS_MEMORY_LIMIT_CONFIGURED = True


def ensure_assets() -> None:
    if not DEFAULT_MODEL_ROOT.exists():
        raise FileNotFoundError(f"Missing upstream model root: {DEFAULT_MODEL_ROOT}")
    if not DEFAULT_PHONIKUD_MODEL.exists():
        raise FileNotFoundError(f"Missing Phonikud ONNX model: {DEFAULT_PHONIKUD_MODEL}")


def _apply_model_speed_options(model: ChatterboxMultilingualTTS) -> ChatterboxMultilingualTTS:
    if T3_DTYPE is not None:
        model.t3 = model.t3.to(dtype=T3_DTYPE)
        logger.info("Cast T3 backbone to %s (s3gen/vocoder stays float32)", T3_DTYPE_NAME)
    if DISABLE_WATERMARK:
        model.watermarker = _NoopWatermarker()
        logger.info("Perth watermarker disabled")
    return model


def load_chatterbox_model() -> ChatterboxMultilingualTTS:
    device = pick_device()
    if DEFAULT_T3_MODEL:
        try:
            logger.info("Loading upstream Chatterbox with t3_model=%s on %s", DEFAULT_T3_MODEL, device)
            return _apply_model_speed_options(ChatterboxMultilingualTTS.from_pretrained(device=device, t3_model=DEFAULT_T3_MODEL))
        except TypeError:
            logger.info("Installed upstream Chatterbox does not accept t3_model; falling back to default loader.")
        except Exception as exc:
            logger.warning("Could not load t3_model=%s: %s. Falling back to default multilingual model.", DEFAULT_T3_MODEL, exc)
    logger.info("Loading upstream Chatterbox default multilingual model on %s", device)
    return _apply_model_speed_options(ChatterboxMultilingualTTS.from_pretrained(device=device))


def ensure_models() -> tuple[Phonikud, ChatterboxMultilingualTTS]:
    global MODEL, PHONIKUD_MODEL
    ensure_assets()
    configure_mps_memory_limit()
    with _MODEL_LOCK:
        if PHONIKUD_MODEL is None:
            PHONIKUD_MODEL = Phonikud(str(DEFAULT_PHONIKUD_MODEL))
        if MODEL is None:
            MODEL = load_chatterbox_model()
    return PHONIKUD_MODEL, MODEL


def _get_or_create_t3_backend(t3_model: T3) -> T3HuggingfaceBackend:
    backend = getattr(t3_model, "patched_model", None)
    if backend is None:
        backend = T3HuggingfaceBackend(
            config=t3_model.cfg,
            llama=t3_model.tfmr,
            speech_enc=t3_model.speech_emb,
            speech_head=t3_model.speech_head,
        )
        t3_model.patched_model = backend
    return backend


def _patched_backend_forward(
    self,
    inputs_embeds: torch.Tensor,
    past_key_values=None,
    use_cache=True,
    output_attentions=False,
    output_hidden_states=False,
    return_dict=True,
    attention_mask=None,
    position_ids=None,
):
    is_large_input = inputs_embeds.size(1) != 1
    has_cache = past_key_values is not None and len(past_key_values) > 0
    assert not (is_large_input and has_cache)
    assert return_dict

    tfmr_out = self.model(
        inputs_embeds=inputs_embeds,
        past_key_values=past_key_values,
        use_cache=use_cache,
        output_attentions=output_attentions,
        output_hidden_states=output_hidden_states,
        return_dict=True,
        attention_mask=attention_mask,
        position_ids=position_ids,
    )
    hidden_states = tfmr_out.hidden_states[-1] if output_hidden_states else tfmr_out.last_hidden_state
    logits = self.speech_head(hidden_states)
    return CausalLMOutputWithCrossAttentions(
        logits=logits,
        past_key_values=tfmr_out.past_key_values,
        hidden_states=tfmr_out.hidden_states if output_hidden_states else None,
        attentions=tfmr_out.attentions,
    )


T3HuggingfaceBackend.forward = torch.inference_mode()(_patched_backend_forward)


def _patched_t3_inference(
    self,
    *,
    t3_cond,
    text_tokens,
    initial_speech_tokens=None,
    prepend_prompt_speech_tokens=None,
    num_return_sequences=1,
    max_new_tokens=None,
    stop_on_eos=True,
    do_sample=True,
    temperature=0.8,
    top_p=0.95,
    min_p=0.05,
    length_penalty=1.0,
    repetition_penalty=1.2,
    cfg_weight=0.5,
):
    del prepend_prompt_speech_tokens, num_return_sequences, stop_on_eos, do_sample, length_penalty
    _ensure_BOT_EOT(text_tokens, self.hp)
    text_tokens = torch.atleast_2d(text_tokens).to(dtype=torch.long, device=self.device)

    if initial_speech_tokens is None:
        initial_speech_tokens = self.hp.start_speech_token * torch.ones_like(text_tokens[:, :1])

    # Keep conditionals aligned with a half-precision backbone even when the
    # caller rebuilt them in float32 (e.g. an exaggeration update).
    _cast_t3_cond_dtype(t3_cond)
    embeds, _len_cond = self.prepare_input_embeds(
        t3_cond=t3_cond,
        text_tokens=text_tokens,
        speech_tokens=initial_speech_tokens,
        cfg_weight=cfg_weight,
    )
    backend = _get_or_create_t3_backend(self)

    device = embeds.device
    bos_token = torch.tensor([[self.hp.start_speech_token]], dtype=torch.long, device=device)
    bos_embed = self.speech_emb(bos_token) + self.speech_pos_emb.get_fixed_embedding(0)
    bos_embed = torch.cat([bos_embed, bos_embed])
    inputs_embeds = torch.cat([embeds, bos_embed], dim=1)

    output = backend(
        inputs_embeds=inputs_embeds,
        past_key_values=None,
        use_cache=True,
        output_attentions=False,
        output_hidden_states=False,
        return_dict=True,
    )
    past = output.past_key_values

    top_p_warper = TopPLogitsWarper(top_p=top_p)
    min_p_warper = MinPLogitsWarper(min_p=min_p)
    repetition_penalty_processor = RepetitionPenaltyLogitsProcessor(penalty=float(repetition_penalty))

    max_tokens = int(max_new_tokens or self.hp.max_speech_tokens)
    if MAX_NEW_TOKENS is not None:
        max_tokens = min(max_tokens, MAX_NEW_TOKENS)

    generated_ids = bos_token.clone()
    predicted = []
    previous_token_id = None
    repeat_run = 0
    eos = False
    started_at = time.perf_counter()

    if FAST_SAMPLING:
        # Same sampling math as the legacy loop (penalty -> temperature ->
        # min_p -> top_p -> categorical draw), but the draw happens on-GPU via
        # the Gumbel-max trick and the GPU->CPU EOS/repeat check runs every
        # FAST_SAMPLING_SYNC_EVERY tokens. Post-EOS tokens are truncated, so
        # the emitted sequence matches what the legacy loop would emit.
        pending_window: list[torch.Tensor] = []
        stop_token_id = int(self.hp.stop_speech_token)
        for i in range(max_tokens):
            logits_step = output.logits[:, -1, :].float()
            cond = logits_step[0:1, :]
            uncond = logits_step[1:2, :]
            logits = cond + cfg_weight * (cond - uncond)

            ids_for_proc = generated_ids[:1, ...]
            logits = repetition_penalty_processor(ids_for_proc, logits)
            if temperature != 1.0:
                logits = logits / temperature
            logits = min_p_warper(ids_for_proc, logits)
            logits = top_p_warper(ids_for_proc, logits)

            probs = torch.softmax(logits, dim=-1)
            gumbel_noise = torch.empty_like(probs).exponential_(1.0)
            next_token = torch.argmax(probs / gumbel_noise, dim=-1, keepdim=True)

            predicted.append(next_token)
            pending_window.append(next_token)
            generated_ids = torch.cat([generated_ids, next_token], dim=1)

            window_full = len(pending_window) >= FAST_SAMPLING_SYNC_EVERY
            last_step = (i + 1) >= max_tokens
            if window_full or last_step:
                window_ids = [int(t) for t in torch.cat(pending_window, dim=1)[0].tolist()]
                window_base = len(predicted) - len(pending_window)
                cut_at = None
                for offset, token_id in enumerate(window_ids):
                    if TOKEN_REPEAT_LIMIT:
                        if token_id == previous_token_id:
                            repeat_run += 1
                        else:
                            previous_token_id = token_id
                            repeat_run = 1
                        if repeat_run >= TOKEN_REPEAT_LIMIT and token_id != stop_token_id:
                            logger.warning("forcing EOS after %s repeated speech tokens: token=%s", repeat_run, token_id)
                            predicted = predicted[: window_base + offset]
                            predicted.append(torch.tensor([[stop_token_id]], dtype=torch.long, device=device))
                            cut_at = window_base + offset + 1
                            break
                    if token_id == stop_token_id:
                        logger.info("EOS token detected at step %s", window_base + offset + 1)
                        cut_at = window_base + offset + 1
                        break
                if cut_at is not None:
                    predicted = predicted[:cut_at]
                    eos = True
                    break
                pending_window = []

            elapsed = time.perf_counter() - started_at
            if (
                SLOW_TAIL_TOKEN_THRESHOLD
                and SLOW_TAIL_MAX_SECONDS > 0
                and (i + 1) >= SLOW_TAIL_TOKEN_THRESHOLD
                and elapsed >= SLOW_TAIL_MAX_SECONDS
            ):
                eos = True
                logger.warning(
                    "forcing EOS for slow tail at step %s after %.3fs (threshold=%s tokens, limit=%.3fs)",
                    i + 1,
                    elapsed,
                    SLOW_TAIL_TOKEN_THRESHOLD,
                    SLOW_TAIL_MAX_SECONDS,
                )
                break

            if last_step:
                break

            next_token_embed = self.speech_emb(next_token) + self.speech_pos_emb.get_fixed_embedding(i + 1)
            next_token_embed = torch.cat([next_token_embed, next_token_embed])
            output = backend(
                inputs_embeds=next_token_embed,
                past_key_values=past,
                output_attentions=False,
                output_hidden_states=False,
                return_dict=True,
            )
            past = output.past_key_values
    else:
        for i in tqdm(range(max_tokens), desc="Sampling", dynamic_ncols=True, disable=not PROGRESS_BAR_ENABLED):
            logits_step = output.logits[:, -1, :].float()
            cond = logits_step[0:1, :]
            uncond = logits_step[1:2, :]
            cfg = torch.as_tensor(cfg_weight, device=cond.device, dtype=cond.dtype)
            logits = cond + cfg * (cond - uncond)

            ids_for_proc = generated_ids[:1, ...]
            logits = repetition_penalty_processor(ids_for_proc, logits)
            if temperature != 1.0:
                logits = logits / temperature
            logits = min_p_warper(ids_for_proc, logits)
            logits = top_p_warper(ids_for_proc, logits)

            probs = torch.softmax(logits, dim=-1)
            next_token = torch.multinomial(probs, num_samples=1)
            token_id = int(next_token.item())

            if TOKEN_REPEAT_LIMIT:
                if token_id == previous_token_id:
                    repeat_run += 1
                else:
                    previous_token_id = token_id
                    repeat_run = 1
                if repeat_run >= TOKEN_REPEAT_LIMIT:
                    logger.warning("forcing EOS after %s repeated speech tokens: token=%s", repeat_run, token_id)
                    next_token = torch.tensor([[self.hp.stop_speech_token]], dtype=torch.long, device=device)
                    token_id = self.hp.stop_speech_token

            predicted.append(next_token)
            generated_ids = torch.cat([generated_ids, next_token], dim=1)

            if token_id == self.hp.stop_speech_token:
                eos = True
                logger.info("EOS token detected at step %s", i + 1)
                break

            elapsed = time.perf_counter() - started_at
            if (
                SLOW_TAIL_TOKEN_THRESHOLD
                and SLOW_TAIL_MAX_SECONDS > 0
                and (i + 1) >= SLOW_TAIL_TOKEN_THRESHOLD
                and elapsed >= SLOW_TAIL_MAX_SECONDS
            ):
                eos = True
                logger.warning(
                    "forcing EOS for slow tail at step %s after %.3fs (threshold=%s tokens, limit=%.3fs)",
                    i + 1,
                    elapsed,
                    SLOW_TAIL_TOKEN_THRESHOLD,
                    SLOW_TAIL_MAX_SECONDS,
                )
                break

            next_token_embed = self.speech_emb(next_token) + self.speech_pos_emb.get_fixed_embedding(i + 1)
            next_token_embed = torch.cat([next_token_embed, next_token_embed])
            output = backend(
                inputs_embeds=next_token_embed,
                past_key_values=past,
                output_attentions=False,
                output_hidden_states=False,
                return_dict=True,
            )
            past = output.past_key_values

    if predicted:
        predicted_tokens = torch.cat(predicted, dim=1)
    else:
        predicted_tokens = torch.empty((1, 0), dtype=torch.long, device=device)

    elapsed = time.perf_counter() - started_at
    self._llm3_last_inference_stats = {
        "tokens": int(predicted_tokens.size(1)),
        "max_tokens": int(max_tokens),
        "eos": eos,
        "seconds": elapsed,
    }
    logger.info(
        "Upstream T3 inference timing: tokens=%s/%s eos=%s seconds=%.3f tokens_per_s=%.2f",
        predicted_tokens.size(1),
        max_tokens,
        eos,
        elapsed,
        (predicted_tokens.size(1) / elapsed) if elapsed > 0 else 0.0,
    )
    return predicted_tokens


T3.inference = torch.inference_mode()(_patched_t3_inference)


# --- Micro-batched generation ------------------------------------------------
# The T3 decode loop is dispatch-bound on MPS: a forward at batch 6 (3 CFG
# request pairs) costs ~1.4x a batch-2 forward. Coalescing the already-
# concurrent /tts requests into one batched decode therefore ~doubles
# throughput without touching the sampling math.


@torch.inference_mode()
def _batched_t3_decode(t3: T3, job_embeds: list[torch.Tensor], params: dict[str, float]) -> list[torch.Tensor]:
    """Decode several requests in one loop.

    job_embeds: per request, the (2, L_i, D) cond/uncond prefill embeddings
    (already including the trailing BOS embed, exactly like the serial path).
    Returns per request a 1-D LongTensor of speech tokens (EOS excluded).
    """
    device = t3.device
    n_jobs = len(job_embeds)
    stop_token_id = int(t3.hp.stop_speech_token)
    cfg_weight = float(params["cfg_weight"])
    temperature = float(params["temperature"])

    embed_dtype = job_embeds[0].dtype
    dim = job_embeds[0].size(-1)
    lengths = [e.size(1) for e in job_embeds]
    max_len = max(lengths)
    rows = 2 * n_jobs

    inputs = torch.zeros(rows, max_len, dim, dtype=embed_dtype, device=device)
    attention_mask = torch.zeros(rows, max_len, dtype=torch.long, device=device)
    for j, embeds in enumerate(job_embeds):
        pad = max_len - lengths[j]
        inputs[2 * j: 2 * j + 2, pad:, :] = embeds
        attention_mask[2 * j: 2 * j + 2, pad:] = 1
    position_ids = (attention_mask.cumsum(dim=1) - 1).clamp(min=0)

    # SDPA + left padding: a pad-position query has every key masked, its
    # softmax row becomes NaN, and the NaN K/V poison the whole sequence
    # (verified on transformers 5.2 / MPS). Build an explicit 4D float mask
    # and unmask key 0 for fully-masked query rows — their finite garbage
    # output stays excluded from real queries by the key padding mask.
    mask_min = torch.finfo(embed_dtype).min
    causal = torch.full((max_len, max_len), mask_min, dtype=embed_dtype, device=device).triu(diagonal=1)
    key_padding = (1 - attention_mask).to(embed_dtype)[:, None, None, :] * mask_min  # (2B,1,1,L)
    prefill_mask = causal[None, None, :, :] + key_padding  # (2B,1,L,L)
    pad_queries = attention_mask == 0  # (2B, L)
    if bool(pad_queries.any()):
        rows_idx, query_idx = pad_queries.nonzero(as_tuple=True)
        prefill_mask[rows_idx, 0, query_idx, :] = mask_min
        prefill_mask[rows_idx, 0, query_idx, 0] = 0

    backend = _get_or_create_t3_backend(t3)
    output = backend(
        inputs_embeds=inputs,
        past_key_values=None,
        use_cache=True,
        output_attentions=False,
        output_hidden_states=False,
        return_dict=True,
        attention_mask=prefill_mask,
        position_ids=position_ids,
    )
    past = output.past_key_values
    row_real_len = attention_mask.sum(dim=1)  # (2B,) positions consumed so far

    top_p_warper = TopPLogitsWarper(top_p=float(params["top_p"]))
    min_p_warper = MinPLogitsWarper(min_p=float(params["min_p"]))
    repetition_penalty_processor = RepetitionPenaltyLogitsProcessor(penalty=float(params["repetition_penalty"]))

    max_tokens = int(t3.hp.max_speech_tokens)
    if MAX_NEW_TOKENS is not None:
        max_tokens = min(max_tokens, MAX_NEW_TOKENS)

    bos_column = torch.full((n_jobs, 1), t3.hp.start_speech_token, dtype=torch.long, device=device)
    generated_ids = bos_column.clone()  # (B, 1+steps) for the repetition processor
    sampled_steps: list[torch.Tensor] = []  # each (B, 1)
    finished = torch.zeros(n_jobs, dtype=torch.bool, device=device)
    eos_step = [None] * n_jobs  # first index in sampled_steps whose token is EOS
    prev_token = [None] * n_jobs
    repeat_run = [0] * n_jobs
    forced_eos = [False] * n_jobs
    synced_steps = 0
    started_at = time.perf_counter()

    def _sync_window(upto: int) -> bool:
        """Run EOS/repeat bookkeeping on steps [synced_steps, upto). Returns True when all rows are done."""
        nonlocal synced_steps
        if upto <= synced_steps:
            return bool(finished.all().item())
        window = torch.cat(sampled_steps[synced_steps:upto], dim=1).cpu()  # (B, K)
        for j in range(n_jobs):
            if eos_step[j] is not None:
                continue
            for offset in range(window.size(1)):
                token_id = int(window[j, offset])
                step_index = synced_steps + offset
                if TOKEN_REPEAT_LIMIT:
                    if token_id == prev_token[j]:
                        repeat_run[j] += 1
                    else:
                        prev_token[j] = token_id
                        repeat_run[j] = 1
                    if repeat_run[j] >= TOKEN_REPEAT_LIMIT and token_id != stop_token_id:
                        logger.warning("forcing EOS after %s repeated speech tokens (job %s): token=%s", repeat_run[j], j, token_id)
                        eos_step[j] = step_index
                        forced_eos[j] = True
                        finished[j] = True
                        break
                if token_id == stop_token_id:
                    eos_step[j] = step_index
                    finished[j] = True
                    break
        synced_steps = upto
        return bool(finished.all().item())

    step_attention = attention_mask
    for i in range(max_tokens):
        logits_step = output.logits[:, -1, :].float()
        cond = logits_step[0::2, :]
        uncond = logits_step[1::2, :]
        logits = cond + cfg_weight * (cond - uncond)  # (B, V)

        logits = repetition_penalty_processor(generated_ids, logits)
        if temperature != 1.0:
            logits = logits / temperature
        logits = min_p_warper(generated_ids, logits)
        logits = top_p_warper(generated_ids, logits)

        probs = torch.softmax(logits, dim=-1)
        gumbel_noise = torch.empty_like(probs).exponential_(1.0)
        next_token = torch.argmax(probs / gumbel_noise, dim=-1, keepdim=True)  # (B, 1)

        sampled_steps.append(next_token)
        generated_ids = torch.cat([generated_ids, next_token], dim=1)

        if (i + 1) % FAST_SAMPLING_SYNC_EVERY == 0 or (i + 1) >= max_tokens:
            if _sync_window(i + 1):
                break

        elapsed = time.perf_counter() - started_at
        if (
            SLOW_TAIL_TOKEN_THRESHOLD
            and SLOW_TAIL_MAX_SECONDS > 0
            and (i + 1) >= SLOW_TAIL_TOKEN_THRESHOLD
            and elapsed >= SLOW_TAIL_MAX_SECONDS
        ):
            logger.warning(
                "forcing EOS for slow tail at step %s after %.3fs (batched, %s jobs)",
                i + 1,
                elapsed,
                n_jobs,
            )
            _sync_window(i + 1)
            break

        if (i + 1) >= max_tokens:
            break

        next_embed = t3.speech_emb(next_token) + t3.speech_pos_emb.get_fixed_embedding(i + 1)  # (B, 1, D)
        step_inputs = next_embed.repeat_interleave(2, dim=0).to(dtype=embed_dtype)  # (2B, 1, D)
        step_attention = torch.cat(
            [step_attention, torch.ones(rows, 1, dtype=torch.long, device=device)], dim=1
        )
        step_positions = (row_real_len + i).unsqueeze(1)  # (2B, 1)
        output = backend(
            inputs_embeds=step_inputs,
            past_key_values=past,
            use_cache=True,
            output_attentions=False,
            output_hidden_states=False,
            return_dict=True,
            attention_mask=step_attention,
            position_ids=step_positions,
        )
        past = output.past_key_values

    _sync_window(len(sampled_steps))
    elapsed = time.perf_counter() - started_at
    all_steps = torch.cat(sampled_steps, dim=1).cpu() if sampled_steps else torch.empty((n_jobs, 0), dtype=torch.long)
    results: list[tuple[torch.Tensor, dict[str, object]]] = []
    per_job_eos = [eos_step[j] is not None and not forced_eos[j] for j in range(n_jobs)]
    for j in range(n_jobs):
        cut = eos_step[j] if eos_step[j] is not None else all_steps.size(1)
        tokens = all_steps[j, :cut].clone()
        results.append((tokens, {
            "tokens": int(tokens.size(0)),
            "max_tokens": int(max_tokens),
            "eos": bool(per_job_eos[j]),
            "seconds": elapsed,
            "batched_jobs": n_jobs,
        }))
    token_counts = [int(r[0].size(0)) for r in results]
    logger.info(
        "Batched T3 inference timing: jobs=%s tokens=%s eos=%s seconds=%.3f combined_tokens_per_s=%.2f",
        n_jobs,
        token_counts,
        per_job_eos,
        elapsed,
        (sum(token_counts) / elapsed) if elapsed > 0 else 0.0,
    )
    t3._llm3_last_inference_stats = {
        "tokens": sum(token_counts),
        "max_tokens": int(max_tokens),
        "eos": all(eos_step[j] is not None for j in range(n_jobs)),
        "seconds": elapsed,
        "batched_jobs": n_jobs,
    }
    return results


@torch.inference_mode()
def _prepare_job_prefill_embeds(model: ChatterboxMultilingualTTS, normalized_text: str, conds, cfg_weight: float) -> torch.Tensor:
    """Replicates the serial path's prefill construction for one request:
    cond + text + initial speech BOS embeds, plus the trailing fixed-position
    BOS embed, duplicated for CFG. Returns (2, L, D)."""
    t3 = model.t3
    text = punc_norm(normalized_text)
    text_tokens = model.tokenizer.text_to_tokens(text, language_id="he").to(model.device)
    text_tokens = torch.cat([text_tokens, text_tokens], dim=0)
    sot = t3.hp.start_text_token
    eot = t3.hp.stop_text_token
    text_tokens = torch.nn.functional.pad(text_tokens, (1, 0), value=sot)
    text_tokens = torch.nn.functional.pad(text_tokens, (0, 1), value=eot)
    _ensure_BOT_EOT(text_tokens, t3.hp)
    text_tokens = torch.atleast_2d(text_tokens).to(dtype=torch.long, device=t3.device)

    initial_speech_tokens = t3.hp.start_speech_token * torch.ones_like(text_tokens[:, :1])
    _cast_t3_cond_dtype(conds.t3)
    embeds, _len_cond = t3.prepare_input_embeds(
        t3_cond=conds.t3,
        text_tokens=text_tokens,
        speech_tokens=initial_speech_tokens,
        cfg_weight=cfg_weight,
    )
    bos_token = torch.tensor([[t3.hp.start_speech_token]], dtype=torch.long, device=t3.device)
    bos_embed = t3.speech_emb(bos_token) + t3.speech_pos_emb.get_fixed_embedding(0)
    bos_embed = torch.cat([bos_embed, bos_embed])
    return torch.cat([embeds, bos_embed], dim=1)


@torch.inference_mode()
def _vocode_speech_tokens(model: ChatterboxMultilingualTTS, speech_tokens: torch.Tensor, conds) -> torch.Tensor:
    """speech tokens -> waveform, mirroring the serial generate() tail."""
    speech_tokens = drop_invalid_tokens(speech_tokens)
    speech_tokens = speech_tokens.to(model.device)
    wav, _ = model.s3gen.inference(speech_tokens=speech_tokens, ref_dict=conds.gen)
    wav = wav.squeeze(0).detach().cpu().numpy()
    n_tokens = int(speech_tokens.shape[-1])
    st_len = max(1, n_tokens - 1)
    wav = wav[: st_len * (S3GEN_SR // S3_TOKEN_RATE)]
    watermarked = model.watermarker.apply_watermark(wav, sample_rate=model.sr)
    return torch.from_numpy(watermarked).unsqueeze(0)


class _TTSBatchJob:
    __slots__ = ("normalized", "conds", "params", "event", "result", "stats", "error", "enqueued_at")

    def __init__(self, normalized: str, conds, params: dict[str, float]):
        self.normalized = normalized
        self.conds = conds
        self.params = params
        self.event = threading.Event()
        self.result = None
        self.stats: dict[str, object] = {}
        self.error: Exception | None = None
        self.enqueued_at = time.perf_counter()


class _TTSBatcher:
    """Coalesces concurrent requests with identical sampling params into one
    batched T3 decode; the vocoder still runs per request."""

    def __init__(self, model: ChatterboxMultilingualTTS):
        self.model = model
        self._jobs: list[_TTSBatchJob] = []
        self._lock = threading.Lock()
        self._wakeup = threading.Event()
        self._worker = threading.Thread(target=self._run, name="tts-batcher", daemon=True)
        self._worker.start()

    def submit(self, normalized: str, conds, params: dict[str, float]) -> tuple[torch.Tensor, dict[str, object]]:
        job = _TTSBatchJob(normalized, conds, params)
        with self._lock:
            self._jobs.append(job)
        self._wakeup.set()
        job.event.wait()
        if job.error is not None:
            raise job.error
        return job.result, job.stats

    def _take_batch(self) -> list[_TTSBatchJob]:
        with self._lock:
            if not self._jobs:
                return []
            key = tuple(sorted(self._jobs[0].params.items()))
            batch = []
            remaining = []
            for job in self._jobs:
                if len(batch) < BATCH_MAX_REQUESTS and tuple(sorted(job.params.items())) == key:
                    batch.append(job)
                else:
                    remaining.append(job)
            self._jobs = remaining
            return batch

    def _run(self) -> None:
        while True:
            self._wakeup.wait()
            # Give the other already-in-flight client requests a moment to
            # land so they join this batch instead of the next one.
            if BATCH_WINDOW_MS > 0:
                time.sleep(BATCH_WINDOW_MS / 1000.0)
            self._wakeup.clear()
            while True:
                batch = self._take_batch()
                if not batch:
                    break
                self._process(batch)

    def _process(self, batch: list[_TTSBatchJob]) -> None:
        try:
            with _TTS_INFERENCE_SEMAPHORE:
                params = batch[0].params
                job_embeds = [
                    _prepare_job_prefill_embeds(self.model, job.normalized, job.conds, float(params["cfg_weight"]))
                    for job in batch
                ]
                decoded = _batched_t3_decode(self.model.t3, job_embeds, params)
                for job, (tokens, stats) in zip(batch, decoded):
                    try:
                        job.result = _vocode_speech_tokens(self.model, tokens, job.conds)
                        job.stats = stats
                    except Exception as exc:  # vocoder failure should not sink siblings
                        job.error = exc
        except Exception as exc:
            for job in batch:
                if job.error is None and job.result is None:
                    job.error = exc
        finally:
            for job in batch:
                job.event.set()


_TTS_BATCHER: _TTSBatcher | None = None
_TTS_BATCHER_LOCK = threading.Lock()
# Per-request generation stats (the model-level attribute is batch-global).
_LAST_REQUEST_STATS = threading.local()


def _get_tts_batcher(model: ChatterboxMultilingualTTS) -> _TTSBatcher:
    global _TTS_BATCHER
    with _TTS_BATCHER_LOCK:
        if _TTS_BATCHER is None:
            _TTS_BATCHER = _TTSBatcher(model)
        return _TTS_BATCHER


def resolve_conditionals_cache_key(prompt_path: str | None, exaggeration: float) -> tuple[str, float]:
    if not prompt_path:
        return ("builtin", float(exaggeration))
    return (f"prompt:{os.path.realpath(prompt_path)}", float(exaggeration))


def _cast_t3_cond_dtype(t3_cond) -> None:
    """Align the T3 conditional tensors with the (possibly half) T3 backbone."""
    if T3_DTYPE is None:
        return
    for name, value in list(vars(t3_cond).items()):
        if torch.is_tensor(value) and value.is_floating_point() and value.dtype != T3_DTYPE:
            setattr(t3_cond, name, value.to(dtype=T3_DTYPE))


def get_conditionals_for_voice(model: ChatterboxMultilingualTTS, prompt_path: str | None, exaggeration: float):
    cache_key = resolve_conditionals_cache_key(prompt_path, exaggeration)
    with _CONDITIONALS_LOCK:
        cached = CONDITIONALS_CACHE.get(cache_key)
        if cached is not None:
            return cached

        if prompt_path is None:
            if model.conds is None:
                raise RuntimeError("builtin Chatterbox conditionals are unavailable")
            prepared = model.conds
        else:
            original_conds = model.conds
            try:
                model.prepare_conditionals(prompt_path, exaggeration=exaggeration)
                prepared = model.conds
            finally:
                model.conds = original_conds

        _cast_t3_cond_dtype(prepared.t3)
        CONDITIONALS_CACHE[cache_key] = prepared
        return prepared


def resolve_prompt_path(voice: str) -> str | None:
    prompt_path, _resolved_name = resolve_voice(
        DEFAULT_MODEL_ROOT,
        str(voice or DEFAULT_VOICE).strip() or DEFAULT_VOICE,
        legacy_voices=_legacy_voice_entries(),
        default_voice=DEFAULT_VOICE,
    )
    return prompt_path


def normalize_hebrew_text(phonikud: Phonikud, text: str) -> str:
    with_diacritics = phonikud.add_diacritics(text)
    return re.sub(fr"[{lexicon.NON_STANDARD_DIAC}]", "", with_diacritics)


def adjust_wav_speed(input_bytes: bytes, sample_rate: int, speed: float) -> bytes:
    speed = float(speed)
    if not ENABLE_ATEMPO_SPEED or abs(speed - 1.0) < 0.001:
        return input_bytes

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as src:
        src.write(input_bytes)
        src_path = src.name
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as dst:
        dst_path = dst.name

    try:
        command = [
            FFMPEG_PATH,
            "-y",
            "-i",
            src_path,
            "-filter:a",
            f"atempo={speed:.4f}",
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
            dst_path,
        ]
        completed = subprocess.run(command, capture_output=True, timeout=240)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.decode("utf-8", errors="replace")[:500] or "ffmpeg speed adjustment failed")
        return Path(dst_path).read_bytes()
    finally:
        Path(src_path).unlink(missing_ok=True)
        Path(dst_path).unlink(missing_ok=True)


def _maybe_collect_after_request() -> None:
    global _REQUEST_COUNTER
    with _REQUEST_COUNTER_LOCK:
        _REQUEST_COUNTER += 1
        run_cleanup = (_REQUEST_COUNTER % GC_EVERY_N_REQUESTS) == 0
    if GC_AFTER_REQUEST and run_cleanup:
        gc.collect()
    if MPS_EMPTY_CACHE_AFTER_REQUEST and run_cleanup and torch.backends.mps.is_available():
        try:
            torch.mps.empty_cache()
        except Exception:
            pass


def synthesize_to_wav_bytes(
    text: str,
    voice: str,
    speed: float,
    exaggeration: float = DEFAULT_EXAGGERATION,
    cfg_weight: float = DEFAULT_CFG_WEIGHT,
    temperature: float = DEFAULT_TEMPERATURE,
    repetition_penalty: float = DEFAULT_REPETITION_PENALTY,
    min_p: float = DEFAULT_MIN_P,
    top_p: float = DEFAULT_TOP_P,
    seed: int = DEFAULT_SEED,
) -> tuple[bytes, int, str]:
    total_start = time.perf_counter()
    phonikud, model = ensure_models()
    models_ready_s = time.perf_counter() - total_start
    norm_start = time.perf_counter()
    normalized = normalize_hebrew_text(phonikud, text)
    norm_s = time.perf_counter() - norm_start
    cond_start = time.perf_counter()
    prompt_path = resolve_prompt_path(voice)
    conds = get_conditionals_for_voice(model, prompt_path, exaggeration)
    cond_s = time.perf_counter() - cond_start

    wav = None
    audio = None
    generate_s = 0.0
    if BATCH_MAX_REQUESTS > 1:
        generate_start = time.perf_counter()
        try:
            # Best-effort in batch mode: concurrent requests share the global RNG, so
            # deterministic seeding is only guaranteed with PHONIKUD_UPSTREAM_BATCH_MAX_REQUESTS=1.
            if seed is not None and int(seed) >= 0:
                seed_rng(int(seed))
            sampling_params = {
                "cfg_weight": float(cfg_weight),
                "temperature": float(temperature),
                "repetition_penalty": float(repetition_penalty),
                "min_p": float(min_p),
                "top_p": float(top_p),
            }
            wav, request_stats = _get_tts_batcher(model).submit(normalized, conds, sampling_params)
            _LAST_REQUEST_STATS.value = request_stats
            audio = wav.squeeze(0).detach().to(device="cpu", dtype=torch.float32).numpy()
        finally:
            generate_s = time.perf_counter() - generate_start
            if wav is not None:
                del wav
            _maybe_collect_after_request()
    else:
        with _TTS_INFERENCE_SEMAPHORE:
            original_conds = model.conds
            generate_start = time.perf_counter()
            try:
                model.conds = conds
                if seed is not None and int(seed) >= 0:
                    seed_rng(int(seed))
                with torch.inference_mode():
                    wav = model.generate(
                        text=normalized,
                        language_id="he",
                        audio_prompt_path=None,
                        exaggeration=exaggeration,
                        cfg_weight=cfg_weight,
                        temperature=temperature,
                        repetition_penalty=repetition_penalty,
                        min_p=min_p,
                        top_p=top_p,
                    )
                audio = wav.squeeze(0).detach().to(device="cpu", dtype=torch.float32).numpy()
                _LAST_REQUEST_STATS.value = dict(getattr(model.t3, "_llm3_last_inference_stats", {}) or {})
            finally:
                generate_s = time.perf_counter() - generate_start
                model.conds = original_conds
                if wav is not None:
                    del wav
                _maybe_collect_after_request()

    encode_start = time.perf_counter()
    wav_buffer = io.BytesIO()
    sf.write(wav_buffer, audio, model.sr, format="WAV")
    wav_bytes = adjust_wav_speed(wav_buffer.getvalue(), model.sr, speed)
    encode_s = time.perf_counter() - encode_start
    stats = getattr(_LAST_REQUEST_STATS, "value", None) or getattr(model.t3, "_llm3_last_inference_stats", {}) or {}
    logger.info(
        "Upstream TTS timing: chars=%s normalized_chars=%s voice=%s models=%.3f norm=%.3f conds=%.3f generate=%.3f encode=%.3f total=%.3f tokens=%s eos=%s cache_entries=%s",
        len(text),
        len(normalized),
        voice,
        models_ready_s,
        norm_s,
        cond_s,
        generate_s,
        encode_s,
        time.perf_counter() - total_start,
        stats.get("tokens"),
        stats.get("eos"),
        len(CONDITIONALS_CACHE),
    )
    return wav_bytes, model.sr, normalized


def transcode_audio(input_bytes: bytes, sample_rate: int, output_format: str) -> tuple[bytes, str]:
    if output_format == "wav":
        return input_bytes, "audio/wav"

    suffix = f".{output_format}"
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as src:
        src.write(input_bytes)
        src_path = src.name
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as dst:
        dst_path = dst.name

    try:
        codec_args = {
            "mp3": ["-codec:a", "libmp3lame", "-b:a", "128k"],
            "ogg": ["-codec:a", "libvorbis", "-q:a", "4"],
            "pcm16": ["-f", "s16le"],
        }[output_format]
        command = [FFMPEG_PATH, "-y", "-i", src_path, "-ar", str(sample_rate), "-ac", "1", *codec_args, dst_path]
        completed = subprocess.run(command, capture_output=True, timeout=240)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.decode("utf-8", errors="replace")[:500] or "ffmpeg failed")
        return Path(dst_path).read_bytes(), {
            "mp3": "audio/mpeg",
            "ogg": "audio/ogg",
            "pcm16": "application/octet-stream",
        }[output_format]
    finally:
        Path(src_path).unlink(missing_ok=True)
        Path(dst_path).unlink(missing_ok=True)


@app.route("/health", methods=["GET"])
def health():
    catalog = voice_catalog()
    payload = {
        "status": "ok",
        "model": "phonikud-upstream",
        "loaded": MODEL is not None,
        "default_voice": str(catalog.get("default_voice") or DEFAULT_VOICE),
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "device": str(pick_device()),
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(PROCESS_STARTED_AT)),
        "faulthandler_enabled": faulthandler_enabled,
    }
    status_code = 200 if MODEL is not None else 503
    return jsonify(payload), status_code


@app.route("/status", methods=["GET"])
def status():
    catalog = voice_catalog()
    return jsonify({
        "loaded": MODEL is not None,
        "model_root": str(DEFAULT_MODEL_ROOT),
        "phonikud_model": str(DEFAULT_PHONIKUD_MODEL),
        "default_voice": str(catalog.get("default_voice") or DEFAULT_VOICE),
        "voices": available_voice_names(catalog, include_unavailable=True),
        "voice_presets": catalog.get("voices") or [],
        "device": str(pick_device()),
        "sample_rate": MODEL.sr if MODEL is not None else 24000,
        "t3_model": DEFAULT_T3_MODEL,
        "gc_after_request": GC_AFTER_REQUEST,
        "mps_empty_cache_after_request": MPS_EMPTY_CACHE_AFTER_REQUEST,
        "conditionals_cache_entries": len(CONDITIONALS_CACHE),
        "token_repeat_limit": TOKEN_REPEAT_LIMIT,
        "max_new_tokens": MAX_NEW_TOKENS,
        "slow_tail_token_threshold": SLOW_TAIL_TOKEN_THRESHOLD,
        "slow_tail_max_seconds": SLOW_TAIL_MAX_SECONDS,
    })


@app.route("/config", methods=["GET"])
def config():
    return jsonify({
        "defaults": {
            "exaggeration": DEFAULT_EXAGGERATION,
            "cfg_weight": DEFAULT_CFG_WEIGHT,
            "temperature": DEFAULT_TEMPERATURE,
            "repetition_penalty": DEFAULT_REPETITION_PENALTY,
            "min_p": DEFAULT_MIN_P,
            "top_p": DEFAULT_TOP_P,
            "seed": DEFAULT_SEED,
            "speed_filter_enabled": ENABLE_ATEMPO_SPEED,
            "t3_model": DEFAULT_T3_MODEL,
        },
        "guardrails": {
            "conditionals_cache_entries": len(CONDITIONALS_CACHE),
            "token_repeat_limit": TOKEN_REPEAT_LIMIT,
            "max_new_tokens": MAX_NEW_TOKENS,
            "slow_tail_token_threshold": SLOW_TAIL_TOKEN_THRESHOLD,
            "slow_tail_max_seconds": SLOW_TAIL_MAX_SECONDS,
        },
        "speed_options": {
            "t3_dtype": T3_DTYPE_NAME if T3_DTYPE is not None else "float32",
            "fast_sampling": FAST_SAMPLING,
            "fast_sampling_sync_every": FAST_SAMPLING_SYNC_EVERY,
            "watermark_disabled": DISABLE_WATERMARK,
            "gc_every_n_requests": GC_EVERY_N_REQUESTS,
            "batch_max_requests": BATCH_MAX_REQUESTS,
            "batch_window_ms": BATCH_WINDOW_MS,
        },
    })


@app.route("/tts", methods=["POST"])
def tts():
    request_start = time.perf_counter()
    data = request.get_json(force=True) or {}
    text = str(data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "no text provided"}), 400

    voice = str(data.get("voice") or DEFAULT_VOICE).strip() or DEFAULT_VOICE
    output_format = str(data.get("response_format") or data.get("format") or "wav").lower()
    speed = float(data.get("speed") or DEFAULT_SPEED)
    exaggeration = float(data.get("exaggeration", DEFAULT_EXAGGERATION))
    cfg_weight = float(data.get("cfg_weight", DEFAULT_CFG_WEIGHT))
    temperature = float(data.get("temperature", DEFAULT_TEMPERATURE))
    repetition_penalty = float(data.get("repetition_penalty", DEFAULT_REPETITION_PENALTY))
    min_p = float(data.get("min_p", DEFAULT_MIN_P))
    top_p = float(data.get("top_p", DEFAULT_TOP_P))
    try:
        seed = int(data.get("seed", DEFAULT_SEED))
    except (TypeError, ValueError):
        seed = DEFAULT_SEED

    try:
        wav_bytes, sample_rate, normalized = synthesize_to_wav_bytes(
            text,
            voice,
            speed,
            exaggeration=exaggeration,
            cfg_weight=cfg_weight,
            temperature=temperature,
            repetition_penalty=repetition_penalty,
            min_p=min_p,
            top_p=top_p,
            seed=seed,
        )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as error:
        return jsonify({"error": str(error)}), 500

    if output_format == "json":
        return jsonify({
            "status": "ok",
            "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
            "sample_rate": sample_rate,
            "format": "wav",
            "voice": voice,
            "normalized_text": normalized,
            "generation_stats": getattr(_LAST_REQUEST_STATS, "value", None)
            or (getattr(MODEL.t3, "_llm3_last_inference_stats", {}) if MODEL is not None else {}),
        })

    audio_bytes, mime = transcode_audio(wav_bytes, sample_rate, output_format)
    logger.info(
        "Upstream TTS response timing: format=%s total=%.3f bytes=%s",
        output_format,
        time.perf_counter() - request_start,
        len(audio_bytes),
    )
    response = send_file(
        io.BytesIO(audio_bytes),
        mimetype=mime,
        as_attachment=False,
        download_name=f"phonikud-upstream.{output_format}",
    )
    stats = getattr(_LAST_REQUEST_STATS, "value", None) or (
        getattr(MODEL.t3, "_llm3_last_inference_stats", {}) if MODEL is not None else {}
    )
    if stats:
        response.headers["X-Chatterbox-EOS"] = "true" if stats.get("eos") else "false"
        response.headers["X-Chatterbox-Tokens"] = str(int(stats.get("tokens") or 0))
        response.headers["X-Chatterbox-Max-Tokens"] = str(int(stats.get("max_tokens") or 0))
    return response


def main() -> None:
    global DEFAULT_MODEL_ROOT, DEFAULT_PHONIKUD_MODEL, DEFAULT_REF_AUDIO, DEFAULT_VOICE

    parser = argparse.ArgumentParser(description="Phonikud upstream Chatterbox Hebrew llm3 API server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18040)
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--model-root", default=str(DEFAULT_MODEL_ROOT))
    args = parser.parse_args()

    DEFAULT_MODEL_ROOT = Path(os.path.expanduser(args.model_root))
    DEFAULT_PHONIKUD_MODEL = Path(os.path.expanduser(os.getenv("PHONIKUD_UPSTREAM_ONNX_PATH", str(DEFAULT_MODEL_ROOT / "phonikud-1.0.int8.onnx"))))
    DEFAULT_REF_AUDIO = Path(os.path.expanduser(os.getenv("PHONIKUD_UPSTREAM_REF_AUDIO", str(DEFAULT_MODEL_ROOT / "female1.wav"))))
    DEFAULT_VOICE = args.voice or DEFAULT_VOICE
    VOICE_PRESETS["default"] = DEFAULT_REF_AUDIO
    VOICE_PRESETS["female1"] = DEFAULT_REF_AUDIO
    VOICE_PRESETS["female2"] = voice_asset_path("female2.wav")
    VOICE_PRESETS["male1"] = voice_asset_path("male1.wav")
    VOICE_PRESETS["butcher"] = voice_asset_path("Butcher.wav")
    VOICE_PRESETS["london"] = voice_asset_path("London.wav")
    VOICE_PRESETS.update(extra_voice_presets())

    logger.info(
        "Starting Phonikud upstream backend pid=%s ppid=%s host=%s port=%s model_root=%s default_voice=%s",
        os.getpid(),
        os.getppid(),
        args.host,
        args.port,
        DEFAULT_MODEL_ROOT,
        DEFAULT_VOICE,
    )
    if EXIT_MARKER_PATH is not None:
        EXIT_MARKER_PATH.unlink(missing_ok=True)
    ensure_models()
    logger.info("Phonikud upstream models preloaded successfully on %s", pick_device())
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
