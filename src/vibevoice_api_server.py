#!/usr/bin/env python3
"""HTTP wrapper for Microsoft VibeVoice TTS that matches llm3's /tts contract.

Architecture: next-token diffusion with Qwen2.5-1.5B decoder, 7.5 Hz speech tokens.
Supports multi-speaker (up to 4), long-form (90 min), voice cloning from WAV.

Usage:
    python3 vibevoice_api_server.py --port 18040 --host 127.0.0.1 --voice Alice
"""
from __future__ import annotations

import argparse
import base64
import io
import os
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from llm3_voice_common import INFERENCE_LOCK, DEFAULT_MAX_JSON_BYTES, DEFAULT_MAX_TEXT_CHARS, ModelLoader, limit_request_size, text_too_long

# ---------------------------------------------------------------------------
# Model paths
# ---------------------------------------------------------------------------
MODEL_ROOT = os.path.expanduser("~/models/voice/voice-tts/vibevoice-1.5b")
# HF cache snapshot (already downloaded by the install step)
HF_SNAPSHOT = os.path.expanduser(
    "~/.cache/huggingface/hub/models--microsoft--VibeVoice-1.5B/snapshots/c00898d257e6b46004e3e2866a47534085fb685a"
)
# Voices from the VibeVoice repo (or use the HF snapshot's voices if available)
VOICES_DIR = os.path.expanduser("~/VibeVoice-tts/demo/voices")
if not os.path.isdir(VOICES_DIR):
    VOICES_DIR = os.path.join(HF_SNAPSHOT, "voices")
if not os.path.isdir(VOICES_DIR):
    VOICES_DIR = os.path.join(MODEL_ROOT, "voices")

# Model path: local model dir or HF cache snapshot
MODEL_PATH = MODEL_ROOT if os.path.isdir(MODEL_ROOT) else HF_SNAPSHOT

FFMPEG_PATH = os.getenv("FFMPEG_PATH") or "/opt/homebrew/bin/ffmpeg"

VOICE_LIST = []
if os.path.isdir(VOICES_DIR):
    for f in sorted(os.listdir(VOICES_DIR)):
        if f.lower().endswith(".wav"):
            # Strip extension → "en-Alice_woman"
            voice_name = Path(f).stem
            # Derive a short label: "en-Alice_woman" → "Alice (en)"
            parts = voice_name.split("_")
            lang = parts[0]
            label = "_".join(parts[1:]) if len(parts) > 1 else voice_name
            VOICE_LIST.append(voice_name)

DEFAULT_VOICE = VOICE_LIST[0] if VOICE_LIST else "en-Alice_woman"

# ---------------------------------------------------------------------------
# Model globals (lazy-loaded)
# ---------------------------------------------------------------------------
MODEL = None
PROCESSOR = None
TOKENIZER = None


def pick_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _load_model():
    """Load the VibeVoice model and processor (called once by LOADER)."""
    global MODEL, PROCESSOR, TOKENIZER

    device = pick_device()
    dtype = torch.float32  # MPS requires float32

    # Import inside the function to avoid heavy imports at module level
    from vibevoice.modular.modeling_vibevoice_inference import (
        VibeVoiceForConditionalGenerationInference,
    )
    from vibevoice.processor.vibevoice_processor import VibeVoiceProcessor

    print(f"[VibeVoice] Loading model from {MODEL_PATH} on {device} ({dtype})...")
    MODEL = VibeVoiceForConditionalGenerationInference.from_pretrained(
        MODEL_PATH,
        torch_dtype=dtype,
        attn_implementation="sdpa",
        device_map=None,
    )
    MODEL.to(device)
    MODEL.eval()

    PROCESSOR = VibeVoiceProcessor.from_pretrained(MODEL_PATH)
    TOKENIZER = PROCESSOR.tokenizer

    # Fix: bos_token_id is None in the Qwen2 tokenizer used by VibeVoice
    if TOKENIZER.bos_token_id is None and TOKENIZER.eos_token_id is not None:
        TOKENIZER.bos_token_id = TOKENIZER.eos_token_id
        TOKENIZER.init_kwargs["bos_token"] = TOKENIZER.decode(TOKENIZER.eos_token_id)

    # Use SDE solver (faster, better quality)
    MODEL.model.noise_scheduler = MODEL.model.noise_scheduler.from_config(
        MODEL.model.noise_scheduler.config,
        algorithm_type="sde-dpmsolver++",
        beta_schedule="squaredcos_cap_v2",
    )
    MODEL.set_ddpm_inference_steps(num_steps=5)  # 5 steps for speed, 20 for quality

    print(f"[VibeVoice] Model loaded. Device={MODEL.device}, dtype={MODEL.dtype}")
    return MODEL


LOADER = ModelLoader(_load_model, name="vibevoice")


def ensure_model():
    global MODEL
    MODEL = LOADER.get()
    return MODEL


def voice_file_path(voice_name: str) -> str | None:
    """Resolve a voice name to a .wav file path."""
    if not voice_name:
        return None
    # Exact match
    candidate = os.path.join(VOICES_DIR, f"{voice_name}.wav")
    if os.path.isfile(candidate):
        return candidate
    # Partial match
    for f in os.listdir(VOICES_DIR):
        if f.lower().startswith(voice_name.lower()):
            return os.path.join(VOICES_DIR, f)
    return None


def synthesize(text: str, voice: str, output_format: str = "wav",
               seed=None) -> tuple[bytes, str, int]:
    """Run VibeVoice inference and return audio bytes + MIME type + sample rate."""
    model = ensure_model()
    proc = PROCESSOR
    tok = TOKENIZER

    # Resolve voice file
    voice_file = voice_file_path(voice) if voice else None
    # Always provide a voice file - VibeVoice requires it
    if voice_file is None:
        voice_file = voice_file_path(DEFAULT_VOICE)
    voice_samples = [voice_file] if voice_file else None

    # Build script text
    script = f"Speaker 1: {text}"

    # Process input
    inputs = proc(
        text=[script],
        voice_samples=voice_samples,
        padding=True,
        return_tensors="pt",
        return_attention_mask=True,
    )

    # Move to device
    device = model.device
    for k, v in inputs.items():
        if torch.is_tensor(v):
            inputs[k] = v.to(device)

    # Generate.
    # The diffusion head samples freely, so the same text synthesised twice comes back
    # as different audio in a different voice. That is harmless for one-shot narration
    # but fatal when a single reply is streamed as several chunks, because each chunk
    # lands on its own voice. Callers that stream pass a seed -- constant across all
    # chunks of one reply -- to pin the sampler. Omitted means unchanged behaviour.
    if seed is not None:
        torch.manual_seed(int(seed))
        mps = getattr(torch, "mps", None)
        if mps is not None and hasattr(mps, "manual_seed"):
            mps.manual_seed(int(seed))

    output = model.generate(
        **inputs,
        max_new_tokens=None,
        cfg_scale=1.3,
        tokenizer=tok,
        generation_config={"do_sample": False},
        verbose=False,
    )

    # Extract audio
    if not output.speech_outputs or output.speech_outputs[0] is None:
        raise RuntimeError("VibeVoice produced no audio output")

    audio_tensor = output.speech_outputs[0]
    if isinstance(audio_tensor, torch.Tensor):
        audio_np = audio_tensor.detach().cpu().numpy()
    else:
        audio_np = np.array(audio_tensor)

    sample_rate = 24000

    # Encode to requested format
    if output_format == "wav":
        # Use processor's save_audio which handles file writing correctly
        import tempfile as tf
        with tf.TemporaryDirectory() as tmpdir:
            output_path = os.path.join(tmpdir, "output.wav")
            result = proc.save_audio(audio_np, output_path=output_path, sampling_rate=sample_rate)
            wav_bytes = Path(result[0]).read_bytes()
        return wav_bytes, "audio/wav", sample_rate

    # For json format, return WAV bytes (client will base64-encode)
    if output_format == "json":
        import tempfile as tf
        with tf.TemporaryDirectory() as tmpdir:
            output_path = os.path.join(tmpdir, "output.wav")
            result = proc.save_audio(audio_np, output_path=output_path, sampling_rate=sample_rate)
            wav_bytes = Path(result[0]).read_bytes()
        return wav_bytes, "audio/wav", sample_rate

    # Transcode via ffmpeg for other formats (mp3, ogg, pcm16)
    suffix = f".{output_format}"
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as src:
        src_path = src.name
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as dst:
        dst_path = dst.name

    try:
        sf.write(src_path, audio_np, sample_rate, format="WAV")
        codec_args = {
            "mp3": ["-codec:a", "libmp3lame", "-b:a", "128k"],
            "ogg": ["-codec:a", "libvorbis", "-q:a", "4"],
            "pcm16": ["-f", "s16le"],
        }[output_format]
        command = [FFMPEG_PATH, "-y", "-i", src_path, "-ar", str(sample_rate), "-ac", "1", *codec_args, dst_path]
        import subprocess as sp
        completed = sp.run(command, capture_output=True, timeout=120)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.decode("utf-8", errors="replace")[:500] or "ffmpeg failed")
        audio_bytes = Path(dst_path).read_bytes()
        mime = {
            "mp3": "audio/mpeg",
            "ogg": "audio/ogg",
            "pcm16": "application/octet-stream",
        }[output_format]
        return audio_bytes, mime, sample_rate
    finally:
        Path(src_path).unlink(missing_ok=True)
        Path(dst_path).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)
CORS(app)


@app.route("/health", methods=["GET"])
def health():
    payload, code = LOADER.health(
        model="vibevoice-1.5b",
        default_voice=DEFAULT_VOICE,
        device=MODEL.device.type if MODEL is not None else pick_device(),
    )
    return jsonify(payload), code


@app.route("/status", methods=["GET"])
def status():
    return jsonify({
        "loaded": MODEL is not None,
        "voices": VOICE_LIST,
        "default_voice": DEFAULT_VOICE,
        "device": MODEL.device.type if MODEL is not None else pick_device(),
        "sample_rate": 24000,
        "model_size_gb": 5.41,
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
    output_format = str(data.get("response_format") or data.get("format") or "wav").lower()
    raw_seed = data.get("seed")
    try:
        seed = int(raw_seed) if raw_seed is not None and str(raw_seed).strip() != "" else None
    except (TypeError, ValueError):
        seed = None

    try:
        with INFERENCE_LOCK:
            wav_bytes, mime, sr = synthesize(text, voice, output_format, seed=seed)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

    if output_format == "json":
        return jsonify({
            "status": "ok",
            "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
            "sample_rate": sr,
            "format": "wav",
            "voice": voice,
        })

    return send_file(io.BytesIO(wav_bytes), mimetype=mime, as_attachment=False, download_name=f"vibevoice.{output_format}")


def main() -> None:
    parser = argparse.ArgumentParser(description="VibeVoice llm3 API server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18040)
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    args = parser.parse_args()
    limit_request_size(app, DEFAULT_MAX_JSON_BYTES)
    # Load in the background: /health answers 503 "loading" until the model is
    # ready, so the launcher's readiness poll waits for the real thing.
    LOADER.start_background()
    app.run(host=args.host, port=args.port)


if __name__ == "__main__":
    main()
