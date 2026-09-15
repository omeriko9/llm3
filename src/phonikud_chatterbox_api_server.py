#!/usr/bin/env python3
"""HTTP wrapper for Phonikud Chatterbox Hebrew TTS matching llm3's /tts contract."""

from __future__ import annotations

import argparse
import base64
import gc
import io
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import soundfile as sf
import torch
import chatterbox.mtl_tts as chatterbox_mtl
from chatterbox_voice_library import available_voice_names, build_voice_catalog, resolve_voice
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from chatterbox.models.t3.inference.alignment_stream_analyzer import AlignmentStreamAnalyzer
from chatterbox.models.t3.inference.t3_hf_backend import T3HuggingfaceBackend
from chatterbox.models.t3.t3 import T3
from phonikud import lexicon
from phonikud_onnx import Phonikud
from chatterbox.models.tokenizers import tokenizer as chatterbox_tokenizer_module
from tqdm import tqdm
from transformers.modeling_outputs import CausalLMOutputWithCrossAttentions
from transformers.generation.logits_process import (
    MinPLogitsWarper,
    RepetitionPenaltyLogitsProcessor,
    TopPLogitsWarper,
)

ChatterboxMultilingualTTS = chatterbox_mtl.ChatterboxMultilingualTTS

app = Flask(__name__)
CORS(app)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("phonikud-chatterbox")

DEFAULT_MODEL_ROOT = Path(os.path.expanduser(os.getenv("PHONIKUD_CHATTERBOX_MODEL_ROOT", "~/models/voice/voice-tts/phonikud-chatterbox")))
DEFAULT_CHECKPOINT_DIR = Path(
    os.path.expanduser(os.getenv("PHONIKUD_CHATTERBOX_CHECKPOINT_DIR", "~/models/voice/voice-tts/chatterbox-multilingual"))
)
DEFAULT_PHONIKUD_MODEL = Path(
    os.path.expanduser(os.getenv("PHONIKUD_CHATTERBOX_ONNX_PATH", str(DEFAULT_MODEL_ROOT / "phonikud-1.0.int8.onnx")))
)
DEFAULT_REF_AUDIO = Path(
    os.path.expanduser(os.getenv("PHONIKUD_CHATTERBOX_REF_AUDIO", str(DEFAULT_MODEL_ROOT / "female1.wav")))
)
DEFAULT_VOICE = os.getenv("PHONIKUD_CHATTERBOX_DEFAULT_VOICE", "female1")
DEFAULT_SPEED = float(os.getenv("PHONIKUD_CHATTERBOX_DEFAULT_SPEED", "1.0"))
DEFAULT_EXAGGERATION = float(os.getenv("PHONIKUD_CHATTERBOX_DEFAULT_EXAGGERATION", "0.5"))
DEFAULT_CFG_WEIGHT = float(os.getenv("PHONIKUD_CHATTERBOX_DEFAULT_CFG_WEIGHT", "0.5"))
DEFAULT_TEMPERATURE = float(os.getenv("PHONIKUD_CHATTERBOX_DEFAULT_TEMPERATURE", "0.8"))
DEFAULT_REPETITION_PENALTY = float(os.getenv("PHONIKUD_CHATTERBOX_DEFAULT_REPETITION_PENALTY", "2.0"))
DEFAULT_MIN_P = float(os.getenv("PHONIKUD_CHATTERBOX_DEFAULT_MIN_P", "0.05"))
DEFAULT_TOP_P = float(os.getenv("PHONIKUD_CHATTERBOX_DEFAULT_TOP_P", "1.0"))
# RNG seed for the autoregressive token sampler. >= 0 seeds every generate() call so
# output is reproducible (consistent delivery across chunks); < 0 leaves the global RNG
# untouched (legacy random-per-request behavior).
DEFAULT_SEED = int(os.getenv("PHONIKUD_CHATTERBOX_DEFAULT_SEED", "1234"))
ENABLE_ATEMPO_SPEED = os.getenv("PHONIKUD_CHATTERBOX_ENABLE_ATEMPO_SPEED", "true").strip().lower() in {"1", "true", "yes"}
FFMPEG_PATH = os.getenv("FFMPEG_PATH") or "/opt/homebrew/bin/ffmpeg"
CLONE_CONDITIONALS = os.getenv("PHONIKUD_CHATTERBOX_CLONE_CONDITIONALS", "false").strip().lower() in {"1", "true", "yes"}
ENABLE_ALIGNMENT_ANALYZER = os.getenv("PHONIKUD_CHATTERBOX_ENABLE_ALIGNMENT", "false").strip().lower() in {"1", "true", "yes"}
GC_AFTER_REQUEST = os.getenv("PHONIKUD_CHATTERBOX_GC_AFTER_REQUEST", "true").strip().lower() in {"1", "true", "yes"}
MPS_EMPTY_CACHE_AFTER_REQUEST = os.getenv("PHONIKUD_CHATTERBOX_MPS_EMPTY_CACHE_AFTER_REQUEST", "true").strip().lower() in {"1", "true", "yes"}
LOG_DEVICE_MEMORY = os.getenv("PHONIKUD_CHATTERBOX_LOG_DEVICE_MEMORY", "true").strip().lower() in {"1", "true", "yes"}
MPS_MEMORY_FRACTION = float(os.getenv("PHONIKUD_CHATTERBOX_MPS_MEMORY_FRACTION", "0.12") or "0.12")
TOKEN_REPEAT_LIMIT = max(0, int(os.getenv("PHONIKUD_CHATTERBOX_TOKEN_REPEAT_LIMIT", "64")))
_MAX_NEW_TOKENS_ENV = int(os.getenv("PHONIKUD_CHATTERBOX_MAX_NEW_TOKENS", "550") or "550")
MAX_NEW_TOKENS = _MAX_NEW_TOKENS_ENV if _MAX_NEW_TOKENS_ENV > 0 else None
SLOW_TAIL_TOKEN_THRESHOLD = max(0, int(os.getenv("PHONIKUD_CHATTERBOX_SLOW_TAIL_TOKEN_THRESHOLD", "420") or "420"))
SLOW_TAIL_MAX_SECONDS = max(0.0, float(os.getenv("PHONIKUD_CHATTERBOX_SLOW_TAIL_MAX_SECONDS", "120") or "120"))

_original_add_hebrew_diacritics = chatterbox_tokenizer_module.add_hebrew_diacritics


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
MODEL: ChatterboxMultilingualTTS | None = None
PHONIKUD_MODEL: Phonikud | None = None
CONDITIONALS_CACHE: dict[tuple[str, float], object] = {}
_CONDITIONALS_LOCK = threading.Lock()
# Semaphore to limit concurrent MPS inference.
# MPS on Apple Silicon cannot safely handle concurrent GPU operations for this model.
# The HTTP layer remains threaded; this serializes only the GPU-bound generate() call.
_TTS_INFERENCE_SEMAPHORE = threading.Semaphore(1)
_MPS_MEMORY_LIMIT_CONFIGURED = False


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


def voice_catalog() -> dict[str, object]:
    return build_voice_catalog(DEFAULT_MODEL_ROOT, legacy_voices=_legacy_voice_entries(), default_voice=DEFAULT_VOICE)


class PassthroughWatermarker:
    def apply_watermark(self, wav, sample_rate=None):  # noqa: D401 - matches Perth interface
        return wav


if getattr(chatterbox_mtl.perth, "PerthImplicitWatermarker", None) is None:
    chatterbox_mtl.perth.PerthImplicitWatermarker = PassthroughWatermarker


def has_hebrew_diacritics(text: str) -> bool:
    return any("\u05b0" <= char <= "\u05c7" for char in text or "")


def add_hebrew_diacritics_if_needed(text: str) -> str:
    if has_hebrew_diacritics(text):
        return text
    return _original_add_hebrew_diacritics(text)


chatterbox_tokenizer_module.add_hebrew_diacritics = add_hebrew_diacritics_if_needed


def _patched_add_attention_spy(self, tfmr, buffer_idx, layer_idx, head_idx):
    """Track hook handles so each request can remove its analyzer hooks cleanly."""

    def attention_forward_hook(module, input, output):
        if isinstance(output, tuple) and len(output) > 1 and output[1] is not None:
            step_attention = output[1].cpu()
            self.last_aligned_attns[buffer_idx] = step_attention[0, head_idx]

    target_layer = tfmr.layers[layer_idx].self_attn
    handle = target_layer.register_forward_hook(attention_forward_hook)
    handles = getattr(self, "_hook_handles", None)
    if handles is None:
        handles = []
        self._hook_handles = handles
    handles.append(handle)
    self._tfmr_config = getattr(tfmr, "config", None)
    if self._tfmr_config is not None and hasattr(self._tfmr_config, "output_attentions"):
        if not hasattr(self, "original_output_attentions"):
            self.original_output_attentions = self._tfmr_config.output_attentions
        self._tfmr_config.output_attentions = True


def _close_alignment_analyzer(self):
    for handle in getattr(self, "_hook_handles", []) or []:
        try:
            handle.remove()
        except Exception:
            pass
    self._hook_handles = []
    tfmr_config = getattr(self, "_tfmr_config", None)
    if tfmr_config is not None and hasattr(tfmr_config, "output_attentions") and hasattr(self, "original_output_attentions"):
        tfmr_config.output_attentions = self.original_output_attentions


AlignmentStreamAnalyzer._add_attention_spy = _patched_add_attention_spy
AlignmentStreamAnalyzer.close = _close_alignment_analyzer


def _patched_backend_forward(
    self,
    inputs_embeds: torch.Tensor,
    past_key_values=None,
    use_cache=True,
    output_attentions=False,
    output_hidden_states=False,
    return_dict=True,
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


def _close_existing_alignment_analyzer(t3_model) -> None:
    patched_model = getattr(t3_model, "patched_model", None)
    analyzer = getattr(patched_model, "alignment_stream_analyzer", None) if patched_model is not None else None
    if analyzer is not None and hasattr(analyzer, "close"):
        analyzer.close()
    if patched_model is not None:
        patched_model.alignment_stream_analyzer = None


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
    start = time.perf_counter()
    text_tokens = torch.atleast_2d(text_tokens).to(dtype=torch.long, device=self.device)
    use_cfg = abs(float(cfg_weight)) > 1e-6
    if not use_cfg and text_tokens.size(0) > 1:
        text_tokens = text_tokens[:1]

    if initial_speech_tokens is None:
        initial_speech_tokens = self.hp.start_speech_token * torch.ones_like(text_tokens[:, :1])

    embeds, len_cond = self.prepare_input_embeds(
        t3_cond=t3_cond,
        text_tokens=text_tokens,
        speech_tokens=initial_speech_tokens,
        cfg_weight=cfg_weight,
    )

    use_alignment = bool(ENABLE_ALIGNMENT_ANALYZER and self.hp.is_multilingual)
    needs_new_backend = (
        getattr(self, "patched_model", None) is None
        or getattr(self, "_llm3_alignment_enabled", None) != use_alignment
        or use_alignment
    )
    if needs_new_backend:
        _close_existing_alignment_analyzer(self)
        alignment_stream_analyzer = None
        if use_alignment:
            alignment_stream_analyzer = AlignmentStreamAnalyzer(
                self.tfmr,
                None,
                text_tokens_slice=(len_cond, len_cond + text_tokens.size(-1)),
                alignment_layer_idx=9,
                eos_idx=self.hp.stop_speech_token,
            )
            assert alignment_stream_analyzer.eos_idx == self.hp.stop_speech_token

        self.patched_model = T3HuggingfaceBackend(
            config=self.cfg,
            llama=self.tfmr,
            speech_enc=self.speech_emb,
            speech_head=self.speech_head,
            alignment_stream_analyzer=alignment_stream_analyzer,
        )
        self._llm3_alignment_enabled = use_alignment

    if not use_alignment:
        _close_existing_alignment_analyzer(self)

    max_tokens = int(max_new_tokens or self.hp.max_speech_tokens)
    if MAX_NEW_TOKENS is not None:
        max_tokens = min(max_tokens, MAX_NEW_TOKENS)

    device = embeds.device
    bos_token = torch.tensor([[self.hp.start_speech_token]], dtype=torch.long, device=device)
    bos_embed = self.speech_emb(bos_token) + self.speech_pos_emb.get_fixed_embedding(0)
    if use_cfg:
        bos_embed = torch.cat([bos_embed, bos_embed])
    inputs_embeds = torch.cat([embeds, bos_embed], dim=1)

    generated_ids = bos_token.clone()
    predicted = []

    top_p_warper = TopPLogitsWarper(top_p=top_p)
    min_p_warper = MinPLogitsWarper(min_p=min_p)
    repetition_penalty_processor = RepetitionPenaltyLogitsProcessor(penalty=float(repetition_penalty))

    output = self.patched_model(
        inputs_embeds=inputs_embeds,
        past_key_values=None,
        use_cache=True,
        output_attentions=use_alignment,
        output_hidden_states=False,
        return_dict=True,
    )
    past = output.past_key_values

    eos = False
    previous_token_id = None
    repeat_run = 0
    for i in tqdm(range(max_tokens), desc="Sampling", dynamic_ncols=True):
        logits_step = output.logits[:, -1, :]
        if use_cfg:
            cond = logits_step[0:1, :]
            uncond = logits_step[1:2, :]
            cfg = torch.as_tensor(cfg_weight, device=cond.device, dtype=cond.dtype)
            logits = cond + cfg * (cond - uncond)
        else:
            logits = logits_step[0:1, :]

        analyzer = getattr(self.patched_model, "alignment_stream_analyzer", None)
        if analyzer is not None:
            if logits.dim() == 1:
                logits = logits.unsqueeze(0)
            last_token = generated_ids[0, -1].item() if generated_ids.size(1) > 0 else None
            logits = analyzer.step(logits, next_token=last_token)

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

        elapsed = time.perf_counter() - start
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
        if use_cfg:
            next_token_embed = torch.cat([next_token_embed, next_token_embed])
        output = self.patched_model(
            inputs_embeds=next_token_embed,
            past_key_values=past,
            output_attentions=use_alignment,
            output_hidden_states=False,
            return_dict=True,
        )
        past = output.past_key_values

    if not predicted:
        predicted_tokens = torch.empty((1, 0), dtype=torch.long, device=device)
    else:
        predicted_tokens = torch.cat(predicted, dim=1)
    elapsed = time.perf_counter() - start
    self._llm3_last_inference_stats = {
        "alignment": use_alignment,
        "cfg": use_cfg,
        "tokens": int(predicted_tokens.size(1)),
        "max_tokens": int(max_tokens),
        "eos": eos,
        "seconds": elapsed,
    }
    logger.info(
        "T3 inference timing: tokens=%s/%s alignment=%s cfg=%s eos=%s seconds=%.3f tokens_per_s=%.2f",
        predicted_tokens.size(1),
        max_tokens,
        use_alignment,
        use_cfg,
        eos,
        elapsed,
        (predicted_tokens.size(1) / elapsed) if elapsed > 0 else 0.0,
    )
    return predicted_tokens


T3.inference = torch.inference_mode()(_patched_t3_inference)


def pick_device() -> torch.device:
    explicit = str(os.getenv("PHONIKUD_CHATTERBOX_DEVICE") or os.getenv("CHATTERBOX_DEVICE") or "").strip().lower()
    if explicit:
        return torch.device(explicit)
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


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


def configure_mps_memory_limit(device: torch.device | None = None) -> None:
    global _MPS_MEMORY_LIMIT_CONFIGURED
    active_device = device or pick_device()
    if _MPS_MEMORY_LIMIT_CONFIGURED or active_device.type != "mps" or MPS_MEMORY_FRACTION <= 0:
        return
    try:
        torch.mps.set_per_process_memory_fraction(MPS_MEMORY_FRACTION)
        logger.info("Configured Phonikud Chatterbox MPS memory fraction to %.3f", MPS_MEMORY_FRACTION)
    except Exception as exc:
        logger.warning("Could not configure Phonikud Chatterbox MPS memory fraction: %s", exc)
    _MPS_MEMORY_LIMIT_CONFIGURED = True


def _format_bytes(value: int | None) -> str | None:
    if value is None:
        return None
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    size = float(value)
    unit_index = 0
    while size >= 1024.0 and unit_index < len(units) - 1:
        size /= 1024.0
        unit_index += 1
    if unit_index == 0:
        return f"{int(size)} {units[unit_index]}"
    return f"{size:.2f} {units[unit_index]}"


def collect_device_memory_snapshot(device: torch.device | None = None) -> dict[str, object]:
    active_device = device or pick_device()
    snapshot: dict[str, object] = {"device": str(active_device)}
    if active_device.type != "mps" or not torch.backends.mps.is_available():
        return snapshot

    for source_name, metric_name in (
        ("current_allocated_memory", "current_allocated_bytes"),
        ("driver_allocated_memory", "driver_allocated_bytes"),
        ("recommended_max_memory", "recommended_max_bytes"),
    ):
        getter = getattr(torch.mps, source_name, None)
        if getter is None:
            continue
        try:
            value = getter()
        except Exception:
            continue
        if value is not None:
            snapshot[metric_name] = int(value)
    return snapshot


def log_device_memory(phase: str, device: torch.device | None = None, **details: object) -> None:
    if not LOG_DEVICE_MEMORY:
        return

    snapshot = collect_device_memory_snapshot(device)
    message_parts = [f"phase={phase}", f"device={snapshot.get('device', 'unknown')}"]
    for metric_name in ("current_allocated_bytes", "driver_allocated_bytes", "recommended_max_bytes"):
        formatted = _format_bytes(snapshot.get(metric_name) if isinstance(snapshot.get(metric_name), int) else None)
        if formatted is not None:
            message_parts.append(f"{metric_name}={formatted}")
    for key, value in details.items():
        if value is not None:
            message_parts.append(f"{key}={value}")
    logger.info("TTS device memory: %s", " ".join(message_parts))


def ensure_assets() -> None:
    if not DEFAULT_CHECKPOINT_DIR.exists():
        raise FileNotFoundError(f"Missing Chatterbox checkpoint directory: {DEFAULT_CHECKPOINT_DIR}")
    if not DEFAULT_PHONIKUD_MODEL.exists():
        raise FileNotFoundError(f"Missing Phonikud ONNX model: {DEFAULT_PHONIKUD_MODEL}")


def ensure_models() -> tuple[Phonikud, ChatterboxMultilingualTTS]:
    global MODEL, PHONIKUD_MODEL
    ensure_assets()
    configure_mps_memory_limit()
    if PHONIKUD_MODEL is None:
        PHONIKUD_MODEL = Phonikud(str(DEFAULT_PHONIKUD_MODEL))
    if MODEL is None:
        MODEL = ChatterboxMultilingualTTS.from_local(DEFAULT_CHECKPOINT_DIR, pick_device())
        if MODEL.conds is not None:
            CONDITIONALS_CACHE[("builtin", float(MODEL.conds.t3.emotion_adv[0, 0, 0].item()))] = clone_conditionals(MODEL.conds)
    return PHONIKUD_MODEL, MODEL


def clone_conditionals(conds):
    if conds is None:
        return None
    cloned_t3 = conds.t3.__class__(
        **{
            field_name: clone_conditionals_value(field_value)
            for field_name, field_value in conds.t3.__dict__.items()
        }
    )
    cloned = conds.__class__(
        t3=cloned_t3,
        gen={
            key: clone_conditionals_value(value)
            for key, value in conds.gen.items()
        },
    )
    return cloned.to(device=pick_device())


def clone_conditionals_value(value):
    if torch.is_tensor(value):
        return value.detach().clone()
    if isinstance(value, dict):
        return {
            key: clone_conditionals_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [clone_conditionals_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(clone_conditionals_value(item) for item in value)
    return value


def resolve_conditionals_cache_key(prompt_path: str | None, exaggeration: float) -> tuple[str, float]:
    if not prompt_path:
        return ("builtin", float(exaggeration))
    return (f"prompt:{os.path.realpath(prompt_path)}", float(exaggeration))


def get_conditionals_for_voice(model: ChatterboxMultilingualTTS, prompt_path: str | None, exaggeration: float):
    cache_key = resolve_conditionals_cache_key(prompt_path, exaggeration)
    with _CONDITIONALS_LOCK:
        cached = CONDITIONALS_CACHE.get(cache_key)
        if cached is not None:
            return clone_conditionals(cached) if CLONE_CONDITIONALS else cached

        if prompt_path is None:
            if model.conds is None:
                raise RuntimeError("builtin Chatterbox conditionals are unavailable")
            prepared = clone_conditionals(model.conds) if CLONE_CONDITIONALS else model.conds
        else:
            original_conds = model.conds
            try:
                model.prepare_conditionals(prompt_path, exaggeration=exaggeration)
                prepared = clone_conditionals(model.conds) if CLONE_CONDITIONALS else model.conds
            finally:
                model.conds = original_conds

        CONDITIONALS_CACHE[cache_key] = clone_conditionals(prepared) if CLONE_CONDITIONALS else prepared
        return clone_conditionals(prepared) if CLONE_CONDITIONALS else prepared


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
    device = pick_device()
    log_device_memory("request_start", device, chars=len(text), voice=voice)
    phonikud, model = ensure_models()
    models_ready_s = time.perf_counter() - total_start
    log_device_memory("post_models_ready", device, models_s=f"{models_ready_s:.3f}", loaded=MODEL is not None)
    norm_start = time.perf_counter()
    normalized = normalize_hebrew_text(phonikud, text)
    norm_s = time.perf_counter() - norm_start
    cond_start = time.perf_counter()
    prompt_path = resolve_prompt_path(voice)
    conds = get_conditionals_for_voice(model, prompt_path, exaggeration)
    cond_s = time.perf_counter() - cond_start
    log_device_memory(
        "pre_generate",
        device,
        normalized_chars=len(normalized),
        norm_s=f"{norm_s:.3f}",
        conds_s=f"{cond_s:.3f}",
        voice=voice,
    )
    # Serialize GPU work on MPS and swap in the prepared conditionals only for this request.
    wav = None
    audio = None
    generate_s = 0.0
    transfer_s = 0.0
    with _TTS_INFERENCE_SEMAPHORE:
        original_conds = model.conds
        analyzer = None
        patched_model = None
        generate_start = time.perf_counter()
        try:
            model.conds = conds
            if seed is not None and int(seed) >= 0:
                seed_rng(int(seed))
            with torch.inference_mode():
                wav = model.generate(
                    language_id="he",
                    text=normalized,
                    audio_prompt_path=None,
                    exaggeration=exaggeration,
                    cfg_weight=cfg_weight,
                    temperature=temperature,
                    repetition_penalty=repetition_penalty,
                    min_p=min_p,
                    top_p=top_p,
                )
            patched_model = getattr(model.t3, "patched_model", None)
            analyzer = getattr(patched_model, "alignment_stream_analyzer", None)
            stats = getattr(model.t3, "_llm3_last_inference_stats", {}) or {}
            log_device_memory(
                "post_generate",
                device,
                generate_s=f"{time.perf_counter() - generate_start:.3f}",
                wav_device=str(getattr(wav, "device", "unknown")),
                wav_shape=tuple(wav.shape) if torch.is_tensor(wav) else None,
                tokens=stats.get("tokens"),
                eos=stats.get("eos"),
            )
            transfer_start = time.perf_counter()
            audio = wav.squeeze(0).detach().to(device="cpu", dtype=torch.float32).numpy()
            transfer_s = time.perf_counter() - transfer_start
            log_device_memory(
                "post_cpu_transfer",
                device,
                transfer_s=f"{transfer_s:.3f}",
                audio_samples=len(audio) if audio is not None else None,
            )
        finally:
            generate_s = time.perf_counter() - generate_start
            model.conds = original_conds
            if patched_model is None:
                patched_model = getattr(model.t3, "patched_model", None)
            if analyzer is None and patched_model is not None:
                analyzer = getattr(patched_model, "alignment_stream_analyzer", None)
            if analyzer is not None and hasattr(analyzer, "close"):
                analyzer.close()
            if patched_model is not None:
                patched_model.alignment_stream_analyzer = None
            if wav is not None:
                del wav
            if GC_AFTER_REQUEST:
                gc.collect()
            if MPS_EMPTY_CACHE_AFTER_REQUEST and torch.backends.mps.is_available():
                try:
                    torch.mps.empty_cache()
                except Exception:
                    pass
            log_device_memory("post_cleanup", device, generate_s=f"{generate_s:.3f}")
    encode_start = time.perf_counter()
    wav_buffer = io.BytesIO()
    sf.write(wav_buffer, audio, model.sr, format="WAV")
    wav_bytes = adjust_wav_speed(wav_buffer.getvalue(), model.sr, speed)
    encode_s = time.perf_counter() - encode_start
    stats = getattr(model.t3, "_llm3_last_inference_stats", {}) or {}
    logger.info(
        "TTS timing: chars=%s normalized_chars=%s voice=%s models=%.3f norm=%.3f conds=%.3f generate=%.3f encode=%.3f total=%.3f tokens=%s alignment=%s",
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
        stats.get("alignment"),
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
    return jsonify({
        "status": "ok",
        "model": "phonikud-chatterbox",
        "loaded": MODEL is not None,
        "default_voice": str(catalog.get("default_voice") or DEFAULT_VOICE),
    })


@app.route("/status", methods=["GET"])
def status():
    assets_ok = DEFAULT_CHECKPOINT_DIR.exists() and DEFAULT_PHONIKUD_MODEL.exists()
    catalog = voice_catalog()
    return jsonify({
        "loaded": MODEL is not None,
        "assets_ok": assets_ok,
        "checkpoint_dir": str(DEFAULT_CHECKPOINT_DIR),
        "phonikud_model": str(DEFAULT_PHONIKUD_MODEL),
        "default_voice": str(catalog.get("default_voice") or DEFAULT_VOICE),
        "voices": available_voice_names(catalog, include_unavailable=True),
        "voice_presets": catalog.get("voices") or [],
        "device": str(pick_device()),
        "sample_rate": MODEL.sr if MODEL is not None else 24000,
        "clone_conditionals": CLONE_CONDITIONALS,
        "alignment_analyzer": ENABLE_ALIGNMENT_ANALYZER,
        "token_repeat_limit": TOKEN_REPEAT_LIMIT,
        "max_new_tokens": MAX_NEW_TOKENS,
        "slow_tail_token_threshold": SLOW_TAIL_TOKEN_THRESHOLD,
        "slow_tail_max_seconds": SLOW_TAIL_MAX_SECONDS,
        "gc_after_request": GC_AFTER_REQUEST,
        "mps_empty_cache_after_request": MPS_EMPTY_CACHE_AFTER_REQUEST,
        "log_device_memory": LOG_DEVICE_MEMORY,
        "device_memory": collect_device_memory_snapshot(),
        "pid": os.getpid(),
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
            "alignment_analyzer": ENABLE_ALIGNMENT_ANALYZER,
            "token_repeat_limit": TOKEN_REPEAT_LIMIT,
            "max_new_tokens": MAX_NEW_TOKENS,
            "slow_tail_token_threshold": SLOW_TAIL_TOKEN_THRESHOLD,
            "slow_tail_max_seconds": SLOW_TAIL_MAX_SECONDS,
        }
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
        })

    transcode_start = time.perf_counter()
    audio_bytes, mime = transcode_audio(wav_bytes, sample_rate, output_format)
    logger.info(
        "TTS response timing: format=%s transcode=%.3f total=%.3f bytes=%s",
        output_format,
        time.perf_counter() - transcode_start,
        time.perf_counter() - request_start,
        len(audio_bytes),
    )
    return send_file(
        io.BytesIO(audio_bytes),
        mimetype=mime,
        as_attachment=False,
        download_name=f"phonikud-chatterbox.{output_format}",
    )


def main() -> None:
    global DEFAULT_MODEL_ROOT, DEFAULT_PHONIKUD_MODEL, DEFAULT_REF_AUDIO, DEFAULT_VOICE

    parser = argparse.ArgumentParser(description="Phonikud Chatterbox Hebrew llm3 API server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18040)
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--model-root", default=str(DEFAULT_MODEL_ROOT))
    args = parser.parse_args()

    DEFAULT_MODEL_ROOT = Path(os.path.expanduser(args.model_root))
    DEFAULT_PHONIKUD_MODEL = Path(os.path.expanduser(os.getenv("PHONIKUD_CHATTERBOX_ONNX_PATH", str(DEFAULT_MODEL_ROOT / "phonikud-1.0.int8.onnx"))))
    DEFAULT_REF_AUDIO = Path(os.path.expanduser(os.getenv("PHONIKUD_CHATTERBOX_REF_AUDIO", str(DEFAULT_MODEL_ROOT / "female1.wav"))))
    DEFAULT_VOICE = args.voice or DEFAULT_VOICE
    VOICE_PRESETS["default"] = DEFAULT_REF_AUDIO
    VOICE_PRESETS["female1"] = DEFAULT_REF_AUDIO
    VOICE_PRESETS["female2"] = voice_asset_path("female2.wav")
    VOICE_PRESETS["male1"] = voice_asset_path("male1.wav")
    VOICE_PRESETS["butcher"] = voice_asset_path("Butcher.wav")
    VOICE_PRESETS["london"] = voice_asset_path("London.wav")
    VOICE_PRESETS.update(extra_voice_presets())

    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
