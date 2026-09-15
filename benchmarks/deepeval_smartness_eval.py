#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from quality_eval import chat_request, strip_think_blocks

try:
    from deepeval.benchmarks import IFEval
    from deepeval.models import DeepEvalBaseLLM
except ImportError:
    print(
        "ERROR: deepeval not installed (pip install -r benchmarks/requirements.txt)",
        file=sys.stderr,
    )
    raise SystemExit(2)


def message_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(message_text(item.get("text")))
                parts.append(message_text(item.get("content")))
        return "".join(parts)
    if isinstance(value, dict):
        return message_text(value.get("text")) or message_text(value.get("content"))
    return str(value)


class LocalBenchmarkModel(DeepEvalBaseLLM):
    def __init__(
        self,
        *,
        url: str,
        model_name: str,
        request_timeout: int,
        max_tokens: int,
        disable_thinking: bool,
    ) -> None:
        self.url = url
        self.model_name = model_name
        self.request_timeout = request_timeout
        self.max_tokens = max_tokens
        self.disable_thinking = disable_thinking

    def load_model(self) -> "LocalBenchmarkModel":
        return self

    def generate(self, prompt: str) -> str:
        response = chat_request(
            self.url,
            self.model_name,
            str(prompt),
            timeout=self.request_timeout,
            disable_thinking=self.disable_thinking,
            system_prompt=(
                "You are a careful assistant. Follow the user's instructions exactly "
                "and reply only in the format the prompt asks for."
            ),
            max_tokens=self.max_tokens,
        )
        if not isinstance(response, dict):
            raise RuntimeError("No JSON response received from the benchmark model.")
        choices = response.get("choices")
        if not isinstance(choices, list) or not choices:
            raise RuntimeError("No choices returned from the benchmark model.")
        message = choices[0].get("message")
        if not isinstance(message, dict):
            raise RuntimeError("Missing message payload in benchmark response.")
        content = message_text(message.get("content"))
        if not content.strip():
            raise RuntimeError("Benchmark response content was empty.")
        stripped = strip_think_blocks(content).strip()
        return stripped or content.strip()

    async def a_generate(self, prompt: str) -> str:
        return self.generate(prompt)

    def get_model_name(self) -> str:
        return self.model_name


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--request-timeout", type=int, default=60)
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--disable-thinking", action="store_true")
    args = parser.parse_args()

    benchmark = IFEval(n_problems=args.limit)
    model = LocalBenchmarkModel(
        url=args.url,
        model_name=args.model,
        request_timeout=args.request_timeout,
        max_tokens=args.max_tokens,
        disable_thinking=args.disable_thinking,
    )
    result = benchmark.evaluate(model=model)

    score = benchmark.overall_score
    payload = {
        "benchmark": "IFEval",
        "score": round(float(score), 4) if score is not None else None,
        "nProblems": len(benchmark.predictions.index) if getattr(benchmark, "predictions", None) is not None else args.limit,
        "instructionBreakdown": benchmark.instruction_breakdown or {},
        "overallAccuracy": round(float(result.overall_accuracy), 4),
    }

    output = json.dumps(payload)
    print(output)
    if args.output:
        args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
