#!/usr/bin/env python3
"""Repo-owned Chatterbox multilingual API server with named prompt voices."""

from __future__ import annotations

import argparse
import gc
import io
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from chatterbox_voice_library import available_voice_names, build_voice_catalog, resolve_voice

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("chatterbox_api_server")
os.environ.setdefault("CHATTERBOX_DISABLE_ALIGNMENT_ANALYZER", "1")

try:
    from flask import Flask, jsonify, request, send_file
    from flask_cors import CORS
except ImportError:
    logger.error("Flask and flask-cors required. Install with: pip install flask flask-cors")
    sys.exit(1)

try:
    from chatterbox import ChatterboxMultilingualTTS
except ImportError:
    logger.error("chatterbox package not found. Install with: pip install chatterbox-tts s3tokenizer")
    sys.exit(1)


FFMPEG_PATH = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
DICTA_PYTHON = os.path.expanduser(os.getenv("DICTA_PYTHON", "~/venvs/dicta-onnx/bin/python"))
DICTA_MODEL = os.path.expanduser(
    os.getenv("DICTA_MODEL", "~/models/voice/diacritizers/dicta-onnx/dicta-1.0.int8.onnx")
)
DEFAULT_VOICE = str(os.getenv("CHATTERBOX_DEFAULT_VOICE", "builtin")).strip() or "builtin"
DEFAULT_EXAGGERATION = float(os.getenv("CHATTERBOX_DEFAULT_EXAGGERATION", "0.5"))
DEFAULT_CFG_WEIGHT = float(os.getenv("CHATTERBOX_DEFAULT_CFG_WEIGHT", "0.5"))
DEFAULT_TEMPERATURE = float(os.getenv("CHATTERBOX_DEFAULT_TEMPERATURE", "0.8"))
DEFAULT_REPETITION_PENALTY = float(os.getenv("CHATTERBOX_DEFAULT_REPETITION_PENALTY", "2.0"))
DEFAULT_MIN_P = float(os.getenv("CHATTERBOX_DEFAULT_MIN_P", "0.05"))
DEFAULT_TOP_P = float(os.getenv("CHATTERBOX_DEFAULT_TOP_P", "1.0"))
MPS_MEMORY_FRACTION = float(os.getenv("CHATTERBOX_MPS_MEMORY_FRACTION", "0.30") or "0.30")
GC_AFTER_REQUEST = os.getenv("CHATTERBOX_GC_AFTER_REQUEST", "true").strip().lower() in {"1", "true", "yes"}
MPS_EMPTY_CACHE_AFTER_REQUEST = os.getenv("CHATTERBOX_MPS_EMPTY_CACHE_AFTER_REQUEST", "true").strip().lower() in {"1", "true", "yes"}
DEFAULT_HEBREW_REF_AUDIO = os.path.expanduser(
    os.getenv("CHATTERBOX_HEBREW_REF_AUDIO", "~/models/voice/voice-tts/f5-tts-hebrew/refs/carmit-hebrew.wav")
)
DEFAULT_ARABIC_REF_AUDIO = os.path.expanduser(os.getenv("CHATTERBOX_ARABIC_REF_AUDIO", ""))
SECONDARY_ARABIC_REF_AUDIO = os.path.expanduser(os.getenv("CHATTERBOX_ARABIC_REF_AUDIO_2", ""))
DEFAULT_ENGLISH_REF_AUDIO = os.path.expanduser(
    os.getenv("CHATTERBOX_ENGLISH_REF_AUDIO", "~/models/voice/voice-tts/xtts-v2/samples/en_sample.wav")
)
DEFAULT_BUTCHER_REF_AUDIO = os.path.expanduser(
    os.getenv("CHATTERBOX_BUTCHER_REF_AUDIO", "~/models/voice/voice-tts/chatterbox-multilingual/butcher.wav")
)
CHATTERBOX_MIN_AUDIO_FOR_TAIL_TRIM_S = float(os.getenv("CHATTERBOX_MIN_AUDIO_FOR_TAIL_TRIM_S", "0.75"))
CHATTERBOX_TAIL_RMS_WINDOW_S = float(os.getenv("CHATTERBOX_TAIL_RMS_WINDOW_S", "0.02"))
CHATTERBOX_TAIL_ACTIVE_THRESHOLD_RATIO = float(os.getenv("CHATTERBOX_TAIL_ACTIVE_THRESHOLD_RATIO", "0.035"))
CHATTERBOX_TAIL_ACTIVE_THRESHOLD_FLOOR = float(os.getenv("CHATTERBOX_TAIL_ACTIVE_THRESHOLD_FLOOR", "0.0008"))
CHATTERBOX_TAIL_KEEP_S = float(os.getenv("CHATTERBOX_TAIL_KEEP_S", "0.12"))
CHATTERBOX_TAIL_MIN_TRIM_S = float(os.getenv("CHATTERBOX_TAIL_MIN_TRIM_S", "0.05"))
CHATTERBOX_TAIL_FADE_S = float(os.getenv("CHATTERBOX_TAIL_FADE_S", "0.08"))

app = Flask(__name__)
CORS(app)

tts_model = None
model_dir = None
sample_rate = 24000
_TTS_INFERENCE_SEMAPHORE = threading.Semaphore(1)
_MPS_MEMORY_LIMIT_CONFIGURED = False


@dataclass(frozen=True)
class VoicePreset:
    name: str
    language: str | None
    prompt_path: str | None
    aliases: tuple[str, ...] = ()

    @property
    def available(self) -> bool:
        return bool(self.prompt_path and os.path.exists(self.prompt_path))


def _build_voice_presets() -> dict[str, VoicePreset]:
    presets = [
        VoicePreset(
            name="he-carmit",
            language="he",
            prompt_path=DEFAULT_HEBREW_REF_AUDIO or None,
            aliases=("hebrew", "carmit", "hebrew-carmit"),
        ),
        VoicePreset(
            name="en-default",
            language="en",
            prompt_path=DEFAULT_ENGLISH_REF_AUDIO or None,
            aliases=("english", "english-default"),
        ),
        VoicePreset(
            name="ar-default",
            language="ar",
            prompt_path=DEFAULT_ARABIC_REF_AUDIO or None,
            aliases=("arabic", "arabic-default"),
        ),
        VoicePreset(
            name="ar-alt",
            language="ar",
            prompt_path=SECONDARY_ARABIC_REF_AUDIO or None,
            aliases=("arabic-alt",),
        ),
        VoicePreset(
            name="butcher",
            language=None,
            prompt_path=DEFAULT_BUTCHER_REF_AUDIO or None,
            aliases=("butcher",),
        ),
    ]
    voice_map: dict[str, VoicePreset] = {"builtin": VoicePreset("builtin", None, None, ("default",))}
    for preset in presets:
        voice_map[preset.name.lower()] = preset
        for alias in preset.aliases:
            voice_map[alias.lower()] = preset
    return voice_map


VOICE_PRESETS = _build_voice_presets()


def _legacy_voice_entries() -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    seen: set[str] = set()
    root = Path(model_dir or "").expanduser() if model_dir else Path(os.getenv("CHATTERBOX_MODEL_DIR", "")).expanduser()
    for preset in VOICE_PRESETS.values():
        if preset.name in seen:
            continue
        seen.add(preset.name)
        deletable = False
        if preset.prompt_path:
            try:
                deletable = root.exists() and str(Path(preset.prompt_path).expanduser().resolve()).startswith(str(root.resolve()))
            except Exception:
                deletable = False
        entries.append({
            "name": preset.name,
            "language": preset.language,
            "prompt_path": preset.prompt_path,
            "aliases": list(preset.aliases),
            "builtin": preset.name == "builtin",
            "deletable": deletable,
        })
    return entries


def voice_catalog() -> dict[str, object]:
    root = Path(model_dir or os.getenv("CHATTERBOX_MODEL_DIR", "")).expanduser()
    return build_voice_catalog(root, legacy_voices=_legacy_voice_entries(), default_voice=DEFAULT_VOICE)


def preset_status() -> dict[str, dict[str, object]]:
    status: dict[str, dict[str, object]] = {}
    for entry in voice_catalog().get("voices") or []:
        if not isinstance(entry, dict):
            continue
        status[str(entry.get("name") or "")] = {
            "language": entry.get("language") or "",
            "prompt_path": entry.get("prompt_path") or "",
            "available": bool(entry.get("exists")),
            "aliases": list(entry.get("aliases") or []),
            "builtin": bool(entry.get("builtin")),
            "deletable": bool(entry.get("deletable")),
        }
    return status


def load_model(path: str) -> None:
    global tts_model, model_dir, sample_rate, _MPS_MEMORY_LIMIT_CONFIGURED
    model_dir = path
    logger.info("Loading Chatterbox model from %s...", path)
    start = time.time()
    import torch

    device = os.getenv("CHATTERBOX_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
    if device == "mps" and not _MPS_MEMORY_LIMIT_CONFIGURED and MPS_MEMORY_FRACTION > 0:
        try:
            torch.mps.set_per_process_memory_fraction(MPS_MEMORY_FRACTION)
            logger.info("Configured Chatterbox MPS memory fraction to %.3f", MPS_MEMORY_FRACTION)
        except Exception as exc:
            logger.warning("Could not configure Chatterbox MPS memory fraction: %s", exc)
        _MPS_MEMORY_LIMIT_CONFIGURED = True
    original_torch_load = torch.load

    def load_with_local_map_location(*args, **kwargs):
        kwargs.setdefault("map_location", torch.device("cpu"))
        return original_torch_load(*args, **kwargs)

    # Multilingual T3 checkpoint selection (chatterbox-tts >= 0.1.7). "v3" maps to
    # t3_mtl23ls_v3.safetensors; override via CHATTERBOX_T3_MODEL (e.g. "v2" or a filename).
    t3_model = (os.getenv("CHATTERBOX_T3_MODEL", "v3") or "").strip() or None
    torch.load = load_with_local_map_location
    try:
        try:
            tts_model = (
                ChatterboxMultilingualTTS.from_local(path, device=device, t3_model=t3_model)
                if t3_model
                else ChatterboxMultilingualTTS.from_local(path, device=device)
            )
        except TypeError:
            # Older chatterbox without the t3_model kwarg (e.g. shared voice-models venv).
            logger.warning("Chatterbox build lacks t3_model selection; loading default checkpoint.")
            t3_model = None
            tts_model = ChatterboxMultilingualTTS.from_local(path, device=device)
    finally:
        torch.load = original_torch_load
    elapsed = time.time() - start
    sample_rate = tts_model.sr
    logger.info(
        "Chatterbox model loaded in %.1fs (device=%s, sr=%s, t3_model=%s)",
        elapsed, device, sample_rate, t3_model or "default",
    )


def has_hebrew(text: str) -> bool:
    return any("\u0590" <= char <= "\u05ff" for char in text or "")


def has_hebrew_diacritics(text: str) -> bool:
    return any("\u05b0" <= char <= "\u05c7" for char in text or "")


def has_arabic(text: str) -> bool:
    return any("\u0600" <= char <= "\u06ff" for char in text or "")


def vocalize_hebrew(text: str) -> str:
    if not has_hebrew(text) or has_hebrew_diacritics(text):
        return text
    if not os.path.exists(DICTA_PYTHON) or not os.path.exists(DICTA_MODEL):
        logger.warning("Dicta ONNX is unavailable; using unvocalized Hebrew text.")
        return text
    script = (
        "import sys\n"
        "from dicta_onnx import Dicta\n"
        f"d = Dicta({DICTA_MODEL!r})\n"
        "print(d.add_diacritics(sys.stdin.read().strip()))\n"
    )
    try:
        completed = subprocess.run(
            [DICTA_PYTHON, "-c", script],
            input=text,
            text=True,
            capture_output=True,
            timeout=45,
            check=True,
        )
        vocalized = completed.stdout.strip()
        if vocalized:
            logger.info("Applied Hebrew vocalization before synthesis.")
            return vocalized
    except Exception as exc:
        logger.warning("Hebrew vocalization failed: %s", exc)
    return text


def detect_language(text: str) -> str:
    if has_hebrew(text):
        return "he"
    if has_arabic(text):
        return "ar"
    return "en"


def resolve_voice_request(voice_name: str | None, explicit_prompt_path: str | None) -> tuple[str | None, str | None, str]:
    if explicit_prompt_path:
        prompt_path = os.path.expanduser(str(explicit_prompt_path))
        return prompt_path, None, str(voice_name or prompt_path)
    requested = str(voice_name or "").strip() or DEFAULT_VOICE
    prompt_path, resolved_name = resolve_voice(
        Path(model_dir or os.getenv("CHATTERBOX_MODEL_DIR", "")).expanduser(),
        requested,
        legacy_voices=_legacy_voice_entries(),
        default_voice=DEFAULT_VOICE,
    )
    preset = preset_status().get(resolved_name, {})
    language = str(preset.get("language") or "").strip() or None
    return prompt_path, language, resolved_name


def wav_to_mp3(wav_bytes: bytes, target_sample_rate: int) -> tuple[bytes, int, str]:
    try:
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as wav_tmp:
            wav_tmp.write(wav_bytes)
            wav_path = wav_tmp.name
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as mp3_tmp:
            mp3_path = mp3_tmp.name

        proc = subprocess.run(
            [
                FFMPEG_PATH,
                "-y",
                "-i",
                wav_path,
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "128k",
                "-ar",
                str(target_sample_rate),
                "-ac",
                "1",
                mp3_path,
            ],
            capture_output=True,
            timeout=30,
        )
        if proc.returncode != 0:
            logger.warning("ffmpeg MP3 conversion failed (rc=%s): %s", proc.returncode, proc.stderr.decode()[:500])
            os.unlink(wav_path)
            os.unlink(mp3_path)
            return wav_bytes, target_sample_rate, "audio/wav"
        with open(mp3_path, "rb") as handle:
            mp3_bytes = handle.read()
        os.unlink(wav_path)
        os.unlink(mp3_path)
        return mp3_bytes, target_sample_rate, "audio/mpeg"
    except FileNotFoundError:
        logger.warning("ffmpeg not found, returning raw WAV")
        return wav_bytes, target_sample_rate, "audio/wav"
    except subprocess.TimeoutExpired:
        logger.warning("ffmpeg MP3 conversion timed out")
        return wav_bytes, target_sample_rate, "audio/wav"


def cleanup_chatterbox_tail(audio_np: np.ndarray, sr: int) -> np.ndarray:
    if sr <= 0:
        return audio_np
    samples = np.asarray(audio_np, dtype=np.float32).flatten()
    if samples.size < int(sr * CHATTERBOX_MIN_AUDIO_FOR_TAIL_TRIM_S):
        return samples
    window = max(1, int(sr * CHATTERBOX_TAIL_RMS_WINDOW_S))
    envelope = np.sqrt(np.convolve(samples * samples, np.ones(window, dtype=np.float32) / window, mode="same"))
    peak = float(np.max(envelope)) if envelope.size else 0.0
    if peak <= 0.0:
        return samples
    threshold = max(peak * CHATTERBOX_TAIL_ACTIVE_THRESHOLD_RATIO, CHATTERBOX_TAIL_ACTIVE_THRESHOLD_FLOOR)
    active = np.flatnonzero(envelope >= threshold)
    if active.size == 0:
        return samples

    keep_padding = max(0, int(sr * CHATTERBOX_TAIL_KEEP_S))
    target_end = min(samples.size, int(active[-1]) + keep_padding)
    trim_samples = samples.size - target_end
    if trim_samples < int(sr * CHATTERBOX_TAIL_MIN_TRIM_S):
        return samples

    trimmed = samples[:target_end].copy()
    fade_samples = min(trimmed.size, int(sr * CHATTERBOX_TAIL_FADE_S))
    if fade_samples > 1:
        fade = np.linspace(1.0, 0.0, fade_samples, dtype=np.float32)
        trimmed[-fade_samples:] *= fade

    logger.info(
        "Trimmed Chatterbox tail by %.3fs (peak_rms=%.5f, threshold=%.5f, keep_padding=%.3fs)",
        trim_samples / sr,
        peak,
        threshold,
        keep_padding / sr,
    )
    return trimmed


def audio_to_mp3_bytes(audio_tensor) -> tuple[bytes, int, str]:
    from scipy.io import wavfile

    audio_np = audio_tensor.cpu().numpy()
    audio_np = np.clip(audio_np, -1.0, 1.0).flatten()
    audio_int16 = np.int16(audio_np * 32767.0)
    sr = audio_tensor.sr if hasattr(audio_tensor, "sr") else sample_rate
    audio_int16 = np.int16(cleanup_chatterbox_tail(audio_np, sr) * 32767.0)
    wav_buf = io.BytesIO()
    wavfile.write(wav_buf, sr, audio_int16)
    return wav_to_mp3(wav_buf.getvalue(), sr)


@app.route("/health", methods=["GET"])
def health():
    return {"status": "ok", "model": "chatterbox", "loaded": tts_model is not None, "default_voice": DEFAULT_VOICE}, 200


@app.route("/", methods=["GET"])
def index():
    return {
        "service": "chatterbox-api",
        "model": "chatterbox-multilingual",
        "endpoints": ["/tts", "/status"],
    }, 200


@app.route("/status", methods=["GET"])
def status():
    if tts_model is None:
        return {"loaded": False}, 503
    catalog = voice_catalog()
    return {
        "loaded": True,
        "model_dir": model_dir,
        "sample_rate": sample_rate,
        "languages": 23,
        "multilingual": True,
        "default_voice": str(catalog.get("default_voice") or DEFAULT_VOICE),
        "voices": available_voice_names(catalog, include_unavailable=True),
        "voice_presets": preset_status(),
    }, 200


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
        }
    })


@app.route("/tts", methods=["POST"])
def tts():
    if tts_model is None:
        return {"error": "Model not loaded"}, 503
    import torch

    data = request.get_json(force=True) or {}
    text = str(data.get("text") or "").strip()
    if not text:
        return {"error": "No text provided"}, 400

    request_language = str(data.get("language") or data.get("language_id") or "").strip().lower() or None
    request_voice = str(data.get("voice") or DEFAULT_VOICE).strip() or DEFAULT_VOICE
    explicit_prompt_path = data.get("audio_prompt_path") or data.get("voice_prompt_path") or None
    speed = data.get("speed", 1.0)

    try:
        audio_prompt_path, preset_language, resolved_voice = resolve_voice_request(request_voice, explicit_prompt_path)
        language = request_language or preset_language or detect_language(text)
        if request_language and preset_language and request_language != preset_language:
            logger.warning(
                "Voice preset %s suggests language %s but request forced %s; honoring request language.",
                resolved_voice,
                preset_language,
                request_language,
            )

        processed_text = vocalize_hebrew(text) if language == "he" else text
        kwargs = {
            "repetition_penalty": float(data.get("repetition_penalty", DEFAULT_REPETITION_PENALTY)),
            "min_p": float(data.get("min_p", DEFAULT_MIN_P)),
            "top_p": float(data.get("top_p", DEFAULT_TOP_P)),
            "cfg_weight": float(data.get("cfg_weight", DEFAULT_CFG_WEIGHT)),
            "temperature": float(data.get("temperature", DEFAULT_TEMPERATURE)),
            "exaggeration": float(data.get("exaggeration", DEFAULT_EXAGGERATION)),
        }
        if audio_prompt_path and os.path.exists(audio_prompt_path):
            kwargs["audio_prompt_path"] = audio_prompt_path

        audio_tensor = None
        audio_cpu = None
        with _TTS_INFERENCE_SEMAPHORE:
            try:
                with torch.inference_mode():
                    audio_tensor = tts_model.generate(processed_text, language_id=language, **kwargs)
                if hasattr(audio_tensor, "detach"):
                    audio_cpu = audio_tensor.detach().to(device="cpu")
                else:
                    audio_cpu = audio_tensor
            finally:
                if audio_tensor is not None:
                    del audio_tensor
                if GC_AFTER_REQUEST:
                    gc.collect()
                if MPS_EMPTY_CACHE_AFTER_REQUEST and torch.backends.mps.is_available():
                    try:
                        torch.mps.empty_cache()
                    except Exception:
                        pass

        mp3_bytes, final_sr, mime = audio_to_mp3_bytes(audio_cpu)
        logger.info(
            "Generated TTS: %s bytes (%s, %sHz), lang=%s, voice=%s, prompt=%s, text=%s",
            len(mp3_bytes),
            mime,
            final_sr,
            language,
            resolved_voice,
            os.path.basename(kwargs.get("audio_prompt_path", "")) if kwargs.get("audio_prompt_path") else "none",
            processed_text[:80],
        )
        return send_file(
            io.BytesIO(mp3_bytes),
            mimetype=mime,
            as_attachment=False,
            download_name="tts.mp3",
        )
    except ValueError as exc:
        logger.warning("Bad TTS request: %s", exc)
        return {"error": str(exc)}, 400
    except Exception as exc:
        logger.error("TTS error: %s", exc, exc_info=True)
        return {"error": str(exc)}, 500


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Chatterbox multilingual TTS API Server")
    parser.add_argument("--model_dir", required=True, help="Path to Chatterbox model directory")
    parser.add_argument("--port", type=int, default=18040, help="Port to listen on")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    args = parser.parse_args()

    load_model(args.model_dir)
    logger.info("Starting Chatterbox API server on %s:%s", args.host, args.port)
    app.run(host=args.host, port=args.port, threaded=True)
