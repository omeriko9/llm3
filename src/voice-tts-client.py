#!/usr/bin/env python3
"""Hermes command-provider bridge for llm3 local TTS endpoints."""

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def synthesize(
    base_url: str,
    input_path: str,
    output_path: str,
    voice: str = "",
    model: str = "",
    exaggeration: float = 0.5,
    cfg_weight: float = 0.5,
    temperature: float = 0.8,
    repetition_penalty: float = 2.0,
    min_p: float = 0.05,
    top_p: float = 1.0,
) -> None:
    text = Path(input_path).read_text(encoding="utf-8").strip()
    if not text:
        raise SystemExit("input text is empty")

    payload = {
        "text": text,
        "voice": voice,
        "model": model,
        "language": "he" if any("\u0590" <= char <= "\u05ff" for char in text) else "en",
        "exaggeration": float(exaggeration),
        "cfg_weight": float(cfg_weight),
        "temperature": float(temperature),
        "repetition_penalty": float(repetition_penalty),
        "min_p": float(min_p),
        "top_p": float(top_p),
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    endpoint = base_url.rstrip("/") + "/tts"
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            content_type = response.headers.get("Content-Type", "")
            data = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"TTS request failed ({exc.code}): {detail}") from exc

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    if "application/json" in content_type:
        parsed = json.loads(data.decode("utf-8"))
        audio_b64 = parsed.get("audio_base64")
        if not audio_b64:
            raise SystemExit(f"TTS JSON response did not include audio_base64: {parsed}")
        output.write_bytes(base64.b64decode(audio_b64))
        return

    output.write_bytes(data)


def main() -> None:
    parser = argparse.ArgumentParser(description="Call an llm3 local TTS endpoint.")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--voice", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--exaggeration", type=float, default=0.5)
    parser.add_argument("--cfg-weight", type=float, default=0.5)
    parser.add_argument("--temperature", type=float, default=0.8)
    parser.add_argument("--repetition-penalty", type=float, default=2.0)
    parser.add_argument("--min-p", type=float, default=0.05)
    parser.add_argument("--top-p", type=float, default=1.0)
    args = parser.parse_args()
    synthesize(
        args.base_url,
        args.input,
        args.output,
        args.voice,
        args.model,
        exaggeration=args.exaggeration,
        cfg_weight=args.cfg_weight,
        temperature=args.temperature,
        repetition_penalty=args.repetition_penalty,
        min_p=args.min_p,
        top_p=args.top_p,
    )


if __name__ == "__main__":
    main()
