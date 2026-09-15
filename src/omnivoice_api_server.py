#!/usr/bin/env python3
"""HTTP wrapper for OmniVoice that matches llm3's /tts contract."""

from __future__ import annotations

import argparse
import base64
import io
import os
import re
import subprocess
import tempfile
import threading
from pathlib import Path

import soundfile as sf
import torch
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from omnivoice.models.omnivoice import OmniVoice
from llm3_voice_common import INFERENCE_LOCK, DEFAULT_MAX_JSON_BYTES, DEFAULT_MAX_TEXT_CHARS, ModelLoader, limit_request_size, text_too_long

app = Flask(__name__)
CORS(app)

DEFAULT_MODEL = os.getenv("OMNIVOICE_MODEL_ID", "k2-fsa/OmniVoice")
DEFAULT_VOICE = os.getenv("OMNIVOICE_DEFAULT_VOICE", "hebrew_carmit_clone")
DEFAULT_SPEED = float(os.getenv("OMNIVOICE_DEFAULT_SPEED", "1.0"))
DICTA_PYTHON = os.path.expanduser(os.getenv("DICTA_PYTHON", "~/venvs/dicta-onnx/bin/python"))
DICTA_MODEL = os.path.expanduser(
    os.getenv("DICTA_MODEL", "~/models/voice/diacritizers/dicta-onnx/dicta-1.0.int8.onnx")
)
DEFAULT_REF_AUDIO = os.path.expanduser(os.getenv("OMNIVOICE_HEBREW_REF_AUDIO", "~/models/voice/voice-tts/f5-tts-hebrew/refs/carmit-hebrew.wav"))
DEFAULT_REF_TEXT = os.getenv(
    "OMNIVOICE_HEBREW_REF_TEXT",
    "שָׁלוֹם, אֲנִי כַּרְמִית. אֶפְשָׁר לְדַבֵּר אִיתִּי בְּעִבְרִית בְּרוּרָה וְטִבְעִית.",
)
FFMPEG_PATH = os.getenv("FFMPEG_PATH") or "/opt/homebrew/bin/ffmpeg"
VOICE_PRESETS = {
    "hebrew_carmit_clone": {"mode": "clone", "ref_audio": DEFAULT_REF_AUDIO, "ref_text": DEFAULT_REF_TEXT, "language": "he"},
    "female_young": {"mode": "design", "instruct": "female, young adult, moderate pitch"},
    "male_british": {"mode": "design", "instruct": "male, middle-aged, low pitch, british accent", "language": "en"},
    "female_whisper": {"mode": "design", "instruct": "female, young adult, high pitch, whisper"},
    "male_deep": {"mode": "design", "instruct": "male, middle-aged, very low pitch"},
    "female_warm": {"mode": "design", "instruct": "female, middle-aged, moderate pitch"},
    "male_calm": {"mode": "design", "instruct": "male, young adult, low pitch"},
}

MODEL: OmniVoice | None = None

# Voice-design presets ("instruct") invent a new speaker on every call, so a
# book narrated chunk by chunk changed voice 45 times in 5 minutes. Fix: design
# the voice once into an anchor clip (fixed seed), then clone that clip for
# every later request. Anchors live next to the model manifest so they survive
# restarts and stay identical across a whole book.
ANCHOR_DIR = Path(os.path.expanduser(os.getenv("OMNIVOICE_ANCHOR_DIR", "~/models/voice/voice-tts/omnivoice/.llm3-design-anchors")))
ANCHOR_TEXT = os.getenv(
    "OMNIVOICE_ANCHOR_TEXT",
    "This is the narrator's voice for the whole book. Every chapter, from the first page to the last, is read in this same voice.",
)
ANCHOR_SEED = int(os.getenv("OMNIVOICE_ANCHOR_SEED", "1234"))
ANCHOR_LOCK = threading.Lock()


def has_hebrew(text: str) -> bool:
    return any("\u0590" <= char <= "\u05ff" for char in text or "")


def has_hebrew_diacritics(text: str) -> bool:
    return any("\u05b0" <= char <= "\u05c7" for char in text or "")


def vocalize_hebrew(text: str) -> str:
    if not has_hebrew(text) or has_hebrew_diacritics(text):
        return text
    if not os.path.exists(DICTA_PYTHON) or not os.path.exists(DICTA_MODEL):
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
    except Exception:
        return text
    vocalized = completed.stdout.strip()
    return vocalized or text


def pick_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _load_model() -> OmniVoice:
    device = pick_device()
    dtype = torch.float16 if device in {"cuda", "mps"} else torch.float32
    return OmniVoice.from_pretrained(DEFAULT_MODEL, device_map=device, dtype=dtype)


LOADER = ModelLoader(_load_model, name="omnivoice")


def ensure_model() -> OmniVoice:
    global MODEL
    MODEL = LOADER.get()
    return MODEL


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


def _anchor_paths(voice: str) -> tuple[Path, Path]:
    safe = re.sub(r"[^0-9A-Za-z_-]", "_", voice)
    return ANCHOR_DIR / f"{safe}.wav", ANCHOR_DIR / f"{safe}.txt"


def ensure_design_anchor(model: OmniVoice, voice: str, preset: dict) -> tuple[str, str]:
    """Return (ref_audio_path, ref_text) for a design preset, creating it once."""
    wav_path, txt_path = _anchor_paths(voice)
    with ANCHOR_LOCK:
        if wav_path.exists() and txt_path.exists() and wav_path.stat().st_size > 0:
            return str(wav_path), txt_path.read_text(encoding="utf-8").strip() or ANCHOR_TEXT
        ANCHOR_DIR.mkdir(parents=True, exist_ok=True)
        torch.manual_seed(ANCHOR_SEED)
        kwargs: dict[str, object] = {"text": ANCHOR_TEXT, "instruct": preset["instruct"], "postprocess_output": True}
        if preset.get("language"):
            kwargs["language"] = preset["language"]
        with INFERENCE_LOCK:
            audio = model.generate(**kwargs)[0]
        sf.write(str(wav_path), audio, model.sampling_rate, format="WAV")
        txt_path.write_text(ANCHOR_TEXT + "\n", encoding="utf-8")
        app.logger.info("OmniVoice: designed anchor clip for '%s' at %s", voice, wav_path)
        return str(wav_path), ANCHOR_TEXT


def build_generation_kwargs(text: str, voice: str, model: OmniVoice | None = None) -> dict:
    preset = VOICE_PRESETS.get(voice, VOICE_PRESETS[DEFAULT_VOICE])
    request_text = vocalize_hebrew(text) if preset.get("language") == "he" else text
    kwargs: dict[str, object] = {"text": request_text}
    if preset.get("language"):
        kwargs["language"] = preset["language"]
    if preset["mode"] == "clone":
        kwargs["ref_audio"] = preset["ref_audio"]
        kwargs["ref_text"] = preset["ref_text"]
    elif preset["mode"] == "design":
        if model is not None and os.getenv("OMNIVOICE_DESIGN_EVERY_CALL", "").lower() not in {"1", "true", "yes"}:
            ref_audio, ref_text = ensure_design_anchor(model, voice, preset)
            kwargs["ref_audio"] = ref_audio
            kwargs["ref_text"] = ref_text
        else:
            kwargs["instruct"] = preset["instruct"]
    return kwargs


@app.route("/health", methods=["GET"])
def health():
    payload, code = LOADER.health(model="omnivoice", default_voice=DEFAULT_VOICE)
    return jsonify(payload), code


@app.route("/status", methods=["GET"])
def status():
    return jsonify({
        "loaded": MODEL is not None,
        "model_id": DEFAULT_MODEL,
        "voices": list(VOICE_PRESETS.keys()),
        "default_voice": DEFAULT_VOICE,
        "device": pick_device(),
    })


@app.route("/tts", methods=["POST"])
def tts():
    data = request.get_json(force=True) or {}
    text = str(data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "no text provided"}), 400
    if text_too_long(text):
        return jsonify({"error": f"text exceeds {DEFAULT_MAX_TEXT_CHARS} characters"}), 413

    voice = str(data.get("voice") or DEFAULT_VOICE).strip() or DEFAULT_VOICE
    if voice not in VOICE_PRESETS:
        return jsonify({"error": f"unknown OmniVoice preset '{voice}'"}), 400
    output_format = str(data.get("response_format") or data.get("format") or "wav").lower()
    speed = float(data.get("speed") or DEFAULT_SPEED)

    model = ensure_model()
    kwargs = build_generation_kwargs(text, voice, model)
    kwargs["speed"] = speed
    kwargs["postprocess_output"] = True
    with INFERENCE_LOCK:
        audio = model.generate(**kwargs)[0]
    sample_rate = model.sampling_rate
    wav_buffer = io.BytesIO()
    sf.write(wav_buffer, audio, sample_rate, format="WAV")
    wav_bytes = wav_buffer.getvalue()

    if output_format == "json":
        return jsonify({
            "status": "ok",
            "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
            "sample_rate": sample_rate,
            "format": "wav",
            "voice": voice,
        })

    audio_bytes, mime = transcode_audio(wav_bytes, sample_rate, output_format)
    return send_file(io.BytesIO(audio_bytes), mimetype=mime, as_attachment=False, download_name=f"omnivoice.{output_format}")


def main() -> None:
    global DEFAULT_VOICE
    parser = argparse.ArgumentParser(description="OmniVoice llm3 API server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18040)
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    args = parser.parse_args()
    DEFAULT_VOICE = args.voice or DEFAULT_VOICE
    limit_request_size(app, DEFAULT_MAX_JSON_BYTES)
    # Load in the background: /health answers 503 "loading" until the model is
    # ready, so the launcher's readiness poll waits for the real thing.
    LOADER.start_background()
    app.run(host=args.host, port=args.port)


if __name__ == "__main__":
    main()
