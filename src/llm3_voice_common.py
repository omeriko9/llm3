"""Shared pieces for the llm3 voice servers (kokoro, omnivoice, vibevoice, stt).

Each server is one Flask process that owns one PyTorch/CTranslate2 model.
Flask serves requests on threads, so without help two requests would call the
model at the same time (which crashes on MPS) and two first requests would
both try to load it. This module gives every server the same three guards:

  ModelLoader     loads the model exactly once, optionally in the background,
                  and reports idle/loading/ready/error for /health.
  INFERENCE_LOCK  serialises calls into the model.
  limit_request_size / text_too_long  cap what a client may send.

It imports nothing heavy, so the self-test at the bottom runs on any python3:

    python3 src/llm3_voice_common.py --selftest
"""

from __future__ import annotations

import os
import threading
import traceback
from typing import Callable, Optional

INFERENCE_LOCK = threading.Lock()

DEFAULT_MAX_TEXT_CHARS = int(os.getenv("LLM3_VOICE_MAX_TEXT_CHARS", "20000") or 20000)
DEFAULT_MAX_JSON_BYTES = int(os.getenv("LLM3_VOICE_MAX_JSON_BYTES", str(2 * 1024 * 1024)) or 2 * 1024 * 1024)
DEFAULT_MAX_UPLOAD_BYTES = int(os.getenv("LLM3_VOICE_MAX_UPLOAD_BYTES", str(64 * 1024 * 1024)) or 64 * 1024 * 1024)


class ModelLoader:
    """Loads a model once and exposes the load state.

    ``load_fn`` does the actual work and returns the model. ``get()`` loads
    synchronously on first use (double-checked under a lock, so concurrent
    first requests wait for one load instead of starting two).
    ``start_background()`` kicks the load off from ``main()`` so the server
    answers /health with ``loading`` right away and the launcher keeps
    polling until the model is ready.
    """

    def __init__(self, load_fn: Callable[[], object], name: str = "model") -> None:
        self._load_fn = load_fn
        self._lock = threading.Lock()
        self.name = name
        self.model: Optional[object] = None
        self.state = "idle"  # idle | loading | ready | error
        self.error = ""

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def get(self):
        if self.model is not None:
            return self.model
        with self._lock:
            if self.model is None:
                self.state = "loading"
                try:
                    self.model = self._load_fn()
                except Exception as exc:  # noqa: BLE001 - surface any load failure
                    self.state = "error"
                    self.error = "".join(traceback.format_exception_only(type(exc), exc)).strip()
                    raise
                self.state = "ready"
                self.error = ""
        return self.model

    def start_background(self) -> threading.Thread:
        def run() -> None:
            try:
                self.get()
            except Exception:  # noqa: BLE001 - already recorded in self.error
                traceback.print_exc()

        thread = threading.Thread(target=run, name=f"load-{self.name}", daemon=True)
        thread.start()
        return thread

    def health(self, **extra) -> tuple[dict, int]:
        """(payload, http_status) for /health. 503 until the model is ready."""
        payload = {
            "status": {"ready": "ok", "error": "error"}.get(self.state, "loading"),
            "loaded": self.loaded,
            "load_state": self.state,
        }
        if self.error:
            payload["error"] = self.error
        payload.update(extra)
        if self.state == "ready":
            return payload, 200
        if self.state == "error":
            return payload, 500
        return payload, 503


def limit_request_size(app, max_bytes: int) -> None:
    """Make Flask reject bodies over ``max_bytes`` with 413 before handlers run."""
    app.config["MAX_CONTENT_LENGTH"] = int(max_bytes)


def text_too_long(text: str, max_chars: int = DEFAULT_MAX_TEXT_CHARS) -> bool:
    return len(text or "") > int(max_chars)


def _selftest() -> None:
    import time

    calls = []

    def slow_load():
        calls.append(1)
        time.sleep(0.05)
        return object()

    loader = ModelLoader(slow_load, name="t")
    assert loader.health()[1] == 503 and loader.health()[0]["status"] == "loading"
    results = []
    threads = [threading.Thread(target=lambda: results.append(loader.get())) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1, f"loaded {len(calls)} times"
    assert all(r is results[0] for r in results)
    payload, code = loader.health(model="x")
    assert code == 200 and payload["loaded"] and payload["model"] == "x"

    def bad_load():
        raise RuntimeError("no weights")

    failing = ModelLoader(bad_load)
    try:
        failing.get()
    except RuntimeError:
        pass
    payload, code = failing.health()
    assert code == 500 and "no weights" in payload["error"], payload

    bg = ModelLoader(slow_load)
    bg.start_background().join()
    assert bg.loaded and bg.health()[1] == 200

    assert text_too_long("x" * 5, 4) and not text_too_long("x" * 4, 4)
    print("llm3_voice_common selftest: ok")


if __name__ == "__main__":
    import sys

    if "--selftest" in sys.argv:
        _selftest()
    else:
        print(__doc__)
