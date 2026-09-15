#!/usr/bin/env python3
"""HTTP wrapper for Kokoro TTS that matches llm3's /tts contract."""

from __future__ import annotations

import argparse
import base64
import io
import os
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from kokoro import KModel, KPipeline
from llm3_voice_common import INFERENCE_LOCK, DEFAULT_MAX_JSON_BYTES, DEFAULT_MAX_TEXT_CHARS, ModelLoader, limit_request_size, text_too_long

app = Flask(__name__)
CORS(app)

DEFAULT_REPO = os.getenv("KOKORO_REPO_ID", "hexgrad/Kokoro-82M")
DEFAULT_VOICE = os.getenv("KOKORO_DEFAULT_VOICE", "af_heart")
DEFAULT_SPEED = float(os.getenv("KOKORO_DEFAULT_SPEED", "1.0"))
FFMPEG_PATH = os.getenv("FFMPEG_PATH") or "/opt/homebrew/bin/ffmpeg"
VOICE_LIST = [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah",
    "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "ef_dora", "em_alex",
    "em_santa", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola", "jf_alpha", "jf_gongitsune",
    "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa", "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
    "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
]
VOICE_LANGUAGE_CODES = {
    "a": "en",
    "b": "en",
    "e": "es",
    "f": "fr",
    "h": "hi",
    "i": "it",
    "j": "ja",
    "p": "pt",
    "z": "zh",
}
SUPPORTED_LANGUAGE_CODES = {"en", "es", "fr", "hi", "it", "ja", "pt", "zh"}

MODEL: KModel | None = None
PIPELINES: dict[str, KPipeline] = {}


def pick_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _load_model() -> KModel:
    device = pick_device()
    return KModel(repo_id=DEFAULT_REPO).to(device).eval()


LOADER = ModelLoader(_load_model, name="kokoro")


def ensure_model() -> KModel:
    global MODEL
    MODEL = LOADER.get()
    return MODEL


def language_code_for_voice(voice: str) -> str:
    return (voice or DEFAULT_VOICE).split("_", 1)[0][:1].lower()


def detect_text_language(text: str) -> str:
    if re.search(r"[\u0590-\u05FF]", text):
        return "he"
    if re.search(r"[\u0600-\u06FF]", text):
        return "ar"
    if re.search(r"[\u0900-\u097F]", text):
        return "hi"
    if re.search(r"[\u3040-\u30FF]", text):
        return "ja"
    if re.search(r"[\u4E00-\u9FFF]", text):
        return "zh"
    return ""


def primary_language_for_voice(voice: str) -> str:
    prefix = (voice or DEFAULT_VOICE).split("_", 1)[0][:1].lower()
    return VOICE_LANGUAGE_CODES.get(prefix, "")


def ensure_pipeline(lang_code: str) -> KPipeline:
    if lang_code not in PIPELINES:
        PIPELINES[lang_code] = KPipeline(lang_code=lang_code, model=ensure_model())
    return PIPELINES[lang_code]


def synthesize_to_wav_bytes(text: str, voice: str, speed: float) -> tuple[bytes, int]:
    pipeline = ensure_pipeline(language_code_for_voice(voice))
    segments = []
    for result in pipeline(text, voice=voice, speed=speed, split_pattern=r"\n+"):
        if result.audio is not None:
            segments.append(result.audio.detach().cpu().numpy())
    if not segments:
        raise RuntimeError("Kokoro did not return audio")
    audio = np.concatenate(segments).astype(np.float32)
    wav_buffer = io.BytesIO()
    sf.write(wav_buffer, audio, 24000, format="WAV")
    return wav_buffer.getvalue(), 24000


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
        completed = subprocess.run(command, capture_output=True, timeout=120)
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
    payload, code = LOADER.health(model="kokoro", default_voice=DEFAULT_VOICE)
    return jsonify(payload), code


@app.route("/status", methods=["GET"])
def status():
    return jsonify({
        "loaded": MODEL is not None,
        "repo": DEFAULT_REPO,
        "voices": VOICE_LIST,
        "default_voice": DEFAULT_VOICE,
        "device": MODEL.device.type if MODEL is not None else pick_device(),
        "sample_rate": 24000,
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
    if voice not in VOICE_LIST and not voice.endswith(".pt") and "," not in voice:
        return jsonify({"error": f"unknown Kokoro voice '{voice}'"}), 400
    output_format = str(data.get("response_format") or data.get("format") or "wav").lower()
    speed = float(data.get("speed") or DEFAULT_SPEED)
    text_language = detect_text_language(text)
    if text_language and text_language not in SUPPORTED_LANGUAGE_CODES:
        return jsonify({
            "error": f"Kokoro 82M does not support {text_language} text. Supported languages: en, es, fr, hi, it, ja, pt, zh."
        }), 400
    voice_language = primary_language_for_voice(voice)
    if text_language and text_language in SUPPORTED_LANGUAGE_CODES and voice_language and voice_language != text_language:
        return jsonify({
            "error": f"Kokoro voice '{voice}' targets {voice_language}; choose a voice for {text_language} text."
        }), 400

    with INFERENCE_LOCK:
        wav_bytes, sample_rate = synthesize_to_wav_bytes(text, voice, speed)
    if output_format == "json":
        return jsonify({
            "status": "ok",
            "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
            "sample_rate": sample_rate,
            "format": "wav",
            "voice": voice,
        })

    audio_bytes, mime = transcode_audio(wav_bytes, sample_rate, output_format)
    return send_file(io.BytesIO(audio_bytes), mimetype=mime, as_attachment=False, download_name=f"kokoro.{output_format}")


def main() -> None:
    global DEFAULT_VOICE
    parser = argparse.ArgumentParser(description="Kokoro llm3 API server")
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
