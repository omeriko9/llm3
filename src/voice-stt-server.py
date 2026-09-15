#!/usr/bin/env python3
"""Small local STT HTTP server for llm3 voice slots.

Supports two backends:
  * openai-whisper  — whisper.load_model() on a .pt checkpoint (default).
  * faster-whisper  — CTranslate2 WhisperModel on a model.bin directory
                      (used by the ivrit.ai Hebrew models).

The backend is auto-detected from the model directory (a ``model.bin`` means a
CTranslate2 / faster-whisper model), with the ``.llm3-voice.json`` runtime field
and the ``VOICE_STT_BACKEND`` env var as overrides.
"""

import argparse
import json
import logging
import os
import tempfile
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS

from llm3_voice_common import DEFAULT_MAX_UPLOAD_BYTES, INFERENCE_LOCK, limit_request_size

LOGGER = logging.getLogger("voice-stt-server")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

APP = Flask(__name__)
CORS(APP)

MODEL = None
MODEL_KEY = ""
MODEL_PATH = ""
BACKEND = "openai-whisper"
# Language forced when a transcription request omits one (e.g. "he" for the
# Hebrew ivrit.ai model, whose language auto-detection was degraded in training).
DEFAULT_LANGUAGE = None

_FASTER_ALIASES = {"faster-whisper", "faster", "ctranslate2", "ct2"}
_OPENAI_ALIASES = {"openai-whisper", "openai", "whisper"}


def detect_backend(model_key: str, model_path: str) -> str:
    """Decide which STT backend to use for the given model."""
    override = (os.getenv("VOICE_STT_BACKEND") or "").strip().lower()
    if override in _FASTER_ALIASES:
        return "faster-whisper"
    if override in _OPENAI_ALIASES:
        return "openai-whisper"

    direct = Path(model_path)
    if direct.is_dir():
        # Authoritative: a CTranslate2 model ships weights as model.bin.
        if (direct / "model.bin").is_file():
            return "faster-whisper"
        meta = direct / ".llm3-voice.json"
        if meta.is_file():
            try:
                runtime = str(json.loads(meta.read_text()).get("runtime", "")).strip().lower()
            except Exception:  # pragma: no cover - metadata is best-effort
                runtime = ""
            if runtime in _FASTER_ALIASES:
                return "faster-whisper"
            if runtime in _OPENAI_ALIASES:
                return "openai-whisper"

    key = (model_key or "").lower()
    if "ct2" in key or "faster" in key:
        return "faster-whisper"
    return "openai-whisper"


def resolve_whisper_source(model_key: str, model_path: str) -> str:
    direct_path = Path(model_path)
    if direct_path.is_file():
      return str(direct_path)
    if direct_path.is_dir():
      for candidate in ("small.pt", "base.pt", "tiny.pt", "large-v3.pt", "large-v3-turbo.pt", "model.pt"):
        candidate_path = direct_path / candidate
        if candidate_path.is_file():
          return str(candidate_path)

    mapping = {
      "whisper-v3-tiny": "tiny",
      "whisper-v3-base": "base",
      "whisper-v3-small": "small",
      "whisper-v3-large": "large-v3",
      "whisper-v3": "large-v3",
      "whisper-large-v3-turbo": "large-v3-turbo",
      "faster-whisper": "small",
    }
    return mapping.get(model_key, model_key)


def load_model(model_key: str, model_path: str) -> None:
    global MODEL, MODEL_KEY, MODEL_PATH, BACKEND
    BACKEND = detect_backend(model_key, model_path)
    if BACKEND == "faster-whisper":
        from faster_whisper import WhisperModel

        # CTranslate2 has no Metal backend, so Apple Silicon runs on CPU. int8
        # keeps memory/latency low with negligible accuracy loss for Whisper.
        device = os.getenv("VOICE_STT_CT2_DEVICE", "cpu")
        compute_type = os.getenv("VOICE_STT_CT2_COMPUTE_TYPE", "int8")
        source = model_path if Path(model_path).is_dir() else model_key
        LOGGER.info(
            "Loading STT model %s via faster-whisper from %s (device=%s, compute_type=%s)",
            model_key, source, device, compute_type,
        )
        # CTranslate2 defaults to 4 CPU threads; this Mac has 12 performance
        # cores. Measured on the ivrit turbo model with a real 2.76s clip:
        # 4 threads = 4.14s, 12 threads = 2.19s, identical transcription. That
        # difference is paid on every single voice-assistant turn.
        cpu_threads = int(os.getenv("VOICE_STT_CT2_THREADS", "0") or 0)
        if cpu_threads <= 0:
            cpu_threads = max(4, (os.cpu_count() or 8) - 4)  # leave the efficiency cores alone
        LOGGER.info("faster-whisper cpu_threads=%d", cpu_threads)
        MODEL = WhisperModel(source, device=device, compute_type=compute_type,
                             cpu_threads=cpu_threads)
    else:
        import whisper

        source = resolve_whisper_source(model_key, model_path)
        LOGGER.info("Loading STT model %s via openai-whisper from %s", model_key, source)
        MODEL = whisper.load_model(source)
    MODEL_KEY = model_key
    MODEL_PATH = model_path
    LOGGER.info("STT model loaded (backend=%s, default_language=%s)", BACKEND, DEFAULT_LANGUAGE or "auto")


@APP.get("/health")
def health():
    return jsonify({"status": "ok", "loaded": MODEL is not None, "model": MODEL_KEY, "backend": BACKEND})


@APP.get("/")
def root():
    return jsonify({"service": "voice-stt", "loaded": MODEL is not None, "model": MODEL_KEY, "backend": BACKEND})


def _transcribe(tmp_path: str, language):
    """Run the loaded backend and return the transcribed text."""
    # One request at a time: the model is not safe to call from two threads.
    with INFERENCE_LOCK:
        if BACKEND == "faster-whisper":
            segments, _info = MODEL.transcribe(tmp_path, language=language)
            return "".join(segment.text for segment in segments).strip()
        result = MODEL.transcribe(tmp_path, language=language, fp16=False)
        return str(result.get("text", "")).strip()


def transcribe_uploaded_file(field_name: str):
    if MODEL is None:
        return jsonify({"error": "Model not loaded"}), 503
    upload = request.files.get(field_name)
    if upload is None:
        return jsonify({"error": f"Missing file field: {field_name}"}), 400

    language = (request.form.get("language") or "").strip() or DEFAULT_LANGUAGE
    with tempfile.NamedTemporaryFile(delete=False, suffix=Path(upload.filename or "audio.wav").suffix or ".wav") as handle:
        upload.save(handle)
        tmp_path = handle.name

    try:
        text = _transcribe(tmp_path, language)
        response = {"text": text}
        if language:
            response["language"] = language
        return jsonify(response)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@APP.post("/audio/transcriptions")
def audio_transcriptions():
    return transcribe_uploaded_file("file")


@APP.post("/stt")
def stt():
    return transcribe_uploaded_file("file")


def main():
    global DEFAULT_LANGUAGE
    parser = argparse.ArgumentParser(description="llm3 STT server")
    parser.add_argument("--model-key", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18042)
    parser.add_argument(
        "--default-language",
        default=os.getenv("VOICE_STT_DEFAULT_LANGUAGE", ""),
        help="Language forced when a request omits one (e.g. 'he' for Hebrew models).",
    )
    args = parser.parse_args()

    DEFAULT_LANGUAGE = (args.default_language or "").strip() or None
    load_model(args.model_key, args.model_path)
    limit_request_size(APP, DEFAULT_MAX_UPLOAD_BYTES)
    APP.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
