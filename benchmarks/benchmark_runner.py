#!/usr/bin/env python3
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import http.client
import json
import math
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import textwrap
import time
import traceback
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit
import select


BENCHMARK_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = BENCHMARK_ROOT.parent
BIN_ROOT = PROJECT_ROOT / "bin"
RESULTS_ROOT = BENCHMARK_ROOT / "results"
SUMMARY_PATH = BENCHMARK_ROOT / "SUMMARY.md"
HOME = Path.home()
MODELS_ROOT = HOME / "models"
HF_ROOT = MODELS_ROOT / "hf"
DFLASH_ROOT = MODELS_ROOT / "dflash"
TINY_GRAMMAR_PATH = Path(
    os.environ.get("QWEN_LLAMA_TINY_GRAMMAR_FILE") or (HOME / "models" / "grammar" / "qwen-structured-cot.gbnf")
)
STRUCTURED_GBNF_PATH = Path(
    os.environ.get("QWEN_LLAMA_STRUCTURED_GBNF_FILE")
    or (HOME / "models" / "grammar" / "qwen3.6-35b-gbnf-structured-cot.gbnf")
)

GGUF_LAUNCHER = BIN_ROOT / "qwen_llama"
GGUF_TQ3_LAUNCHER = BIN_ROOT / "qwen_llama_tq3"
BEELLAMA_LAUNCHER = BIN_ROOT / "qwen_llama_beellama"
BEELLAMA_METAL_SERVER = PROJECT_ROOT / "vendor" / "beellama.cpp" / "build-metal" / "bin" / "llama-server"
MLX_LAUNCHER = BIN_ROOT / "run-qwen36-mlx-api.sh"
RAPID_MLX_LAUNCHER = BIN_ROOT / "run-qwen36-rapid-mlx-api.sh"
MTPLX_LAUNCHER = BIN_ROOT / "run-qwen36-mtplx-api.sh"
DFLASH_LAUNCHER = BIN_ROOT / "run-qwen36-dflash-api.sh"
# Not behind LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS, mirroring src/server.js: the
# older MLX launchers are opt-in because they lost their head-to-heads, but
# mlx-dspark is current. Without this the MLX weights are invisible to every
# consumer of --discover-json, which is why they never appeared in the scene
# tests even though llm3 itself can load them.
MLX_DSPARK_LAUNCHER = BIN_ROOT / "run-mlx-dspark-api.sh"
MLX_DSPARK_BIN = Path.home() / ".venvs" / "mlx-dspark" / "bin" / "mlx-dspark"

DEFAULT_CONTEXT_SIZE = 128000
DEFAULT_PARALLEL = 1
DEFAULT_LOAD_TIMEOUT = 300
DEFAULT_GLOBAL_TIMEOUT = 300
# Quality tasks and DeepEval used to borrow --global-timeout, which is sized for
# a single request. 30 questions never fit in it: DeepEval timed out on 6 of the
# 13 recorded rows — every one a dense model under ~35 tok/s — so the column
# silently measured only the fast models, and Overall renormalized around the
# hole, making the two sets of rows incomparable.
DEFAULT_QUALITY_TASK_TIMEOUT = 900
DEFAULT_DEEPEVAL_TIMEOUT = 1200
# 30s windows made close calls meaningless (the record run finished in <2s);
# 60s gives every model a >=700-token generation window to average over.
DEFAULT_THROUGHPUT_WINDOW = 60
DEFAULT_THROUGHPUT_STALL_TIMEOUT = 10
# One throughput request is one sample. Run-to-run noise on this hardware is
# about +/-10% (docs/SPEED_OPTIMIZATION_FINDINGS.md), so the stage repeats the
# request and reports the median with the min/max spread.
DEFAULT_THROUGHPUT_REPEATS = 3
# Every request that does not need randomness pins a seed so a re-run of the
# same row is comparable to the last one.
BENCHMARK_SEED = 20260904
# Bumped when benchmark.json gains or changes fields the dashboard reads.
#   1: unversioned rows (before September 2026)
#   2: schemaVersion, host, environment, throughput samples/median,
#      promptProcessing, seeded requests, launchConfig.sampling
SCHEMA_VERSION = 2
# Roughly how many tokens the prompt-processing probe sends (a fixed passage
# repeated); the measurement divides the server's prompt token count by the
# time to first token on a cold cache.
PROMPT_PROCESSING_TARGET_CHARS = 8000
# The decode probe asks for exactly this many tokens with ignore_eos, so the
# decode rate does not depend on how long a model chooses to answer. The
# scenario prompt alone cannot do that: a no-think model finishes it in about
# 90 tokens, which is a window of only a few seconds.
DECODE_PROBE_TOKENS = 512
# Discarded request before the timed ones. The first generation after a load
# pays for cold caches and lazy allocation that no later request repeats.
DEFAULT_THROUGHPUT_WARMUP = 1
DEFAULT_SLOT_COUNT = 3
# 60 questions put the 95% interval at +/-11.6 points at p=0.70 -- wider than a
# third of this fleet's entire 0.43-0.73 spread, which is why every model looked
# equally clever and several printed byte-identical scores. 200 halves it to
# +/-6.4, for about 4 minutes per dense model and one per MoE.
DEFAULT_QUALITY_LIMIT = 200
STOP_GRACE_SECONDS = 30
LISTENER_KILL_GRACE_SECONDS = 10
MAX_AGENTIC_ROUNDS = 6
JSON_CAPTURE_LIMIT = 12000
LOCAL_API_KEY = str(os.environ.get("LLM3_LOCAL_API_KEY") or "llm3-local-api-key").strip() or "llm3-local-api-key"
DEEPEVAL_SMARTNESS_BENCHMARK = "IFEval"
# Which quality metrics a run measures. Only MMLU-Pro is on by default: on the
# recorded rows it is the one metric with real headroom (0.68 vs 0.73 between
# two models the rest of the suite scored identically), and at ~1.1s per
# question it is also the cheapest. MMLU, GSM8K, DeepEval and the Hebrew
# translation are opt-in — GSM8K and DeepEval alone cost ~22 of the ~35 minutes
# a dense 27B used to spend here, while separating nothing.
# Tasks whose answers are worked out rather than picked, so they run long.
NUMERIC_QUALITY_TASKS = ("math500", "gsm8k")
QUALITY_METRIC_CHOICES = ("mmlu_pro", "math500", "humaneval", "mmlu", "gsm8k", "deepeval", "translation")
# HumanEval executes model-written Python locally, so it is never on by default
# -- it has to be asked for.
DEFAULT_QUALITY_METRICS = ("mmlu_pro", "math500")
QUALITY_METRIC_WEIGHT_KEYS = {
    "mmlu": "avgMmlu",
    "mmlu_pro": "mmluPro",
    "math500": "math500",
    "humaneval": "humanEval",
    "gsm8k": "gsm8k",
    "deepeval": "deepEval",
    "translation": "hebrewTranslation",
}
# Relative weights, renormalized over whatever a row actually measured.
#
# The old table gave 0.30 to MMLU and 0.25 to DeepEval while the only metric
# that ran by default -- MMLU-Pro -- carried 0.10, so "Overall" was a relabelled
# MMLU-Pro wearing a weighted average's clothes. This table weights what
# actually separates models on this hardware: broad reasoning, maths (the metric
# that moves when thinking is switched on), and code that either runs or does
# not. ARC and HellaSwag were already deleted for saturation; MMLU and GSM8K are
# kept for continuity at a token weight.
#
# Keep in step with BENCHMARK_CATALOG in src/perf-dashboard-routes.js, which is
# what the dashboard scores rows with and explains them from.
# The four supporting metrics sit at 0.025 apiece so the table adds to 1.00 and
# a weight reads as "share of the score when everything runs".
QUALITY_OVERALL_WEIGHTS = {
    "mmluPro": 0.30,
    "math500": 0.25,
    "humanEval": 0.25,
    "deepEval": 0.10,
    # chrF against a fixed reference translation. Thinking-dependent, so it is
    # evaluated per thinking bucket rather than shared across all variants.
    "hebrewTranslation": 0.025,
    "avgMmlu": 0.025,
    "gsm8k": 0.025,
    # Filled in by the dashboard from the scene runs, never by the runner; it is
    # listed here so both tables renormalize over the same denominators.
    "scenes": 0.025,
}
# Thinking rows generate several times more tokens per question, so measuring
# them over the full sample would turn an overnight run into a multi-day one.
# They get a reduced sample instead: the delta is real, its interval is wider,
# and the dashboard prints that interval next to the score.
THINKING_SAMPLE_DIVISOR = 2
MIN_THINKING_SAMPLE = 20
# High enough not to bind on any model here; the per-request timeout below is
# the real limit. At the recorded decode rates 300s buys ~6,000 tokens on the
# slowest dense model and the full budget on the fastest.
THINKING_MAX_TOKENS = 16384
THINKING_REQUEST_TIMEOUT_SECONDS = 300
# Non-thinking budgets, kept here so nothing sets a token cap in one place and a
# clock in another.
CHOICE_MAX_TOKENS = 1024
MATH_MAX_TOKENS = 4096
# The slowest model on this machine decodes at ~20 tok/s (measured across the
# recorded throughput results, 19.7 to 93.4). A request timeout below
# tokens / that rate is a cap the model can never reach: it gets killed
# mid-answer and scored wrong for the clock rather than for the answer.
ASSUMED_FLOOR_DECODE_TOKENS_PER_SECOND = 20
REQUEST_TIMEOUT_OVERHEAD_SECONDS = 30
NON_THINKING_REQUEST_TIMEOUT_CEILING = 240


def request_timeout_for(max_tokens: int, *, thinking: bool) -> int:
    """Seconds a single question may take, derived from its token budget.

    Raising a token budget without raising this converts truncations into
    timeouts, which is strictly worse: a truncated reply is at least a reply.
    Deriving one from the other is what stops the two drifting apart again.
    """
    needed = int(max_tokens / ASSUMED_FLOOR_DECODE_TOKENS_PER_SECOND) + REQUEST_TIMEOUT_OVERHEAD_SECONDS
    ceiling = THINKING_REQUEST_TIMEOUT_SECONDS if thinking else NON_THINKING_REQUEST_TIMEOUT_CEILING
    return max(60, min(needed, ceiling))

TRANSLATION_TASK = "hebrew_translation"
# The grammar variants force ASCII-only output (see SPEED_OPTIMIZATION_FINDINGS.md),
# so they cannot emit Hebrew at all. They reuse the plain "think" result instead
# of running a translation that could only produce garbage.
TRANSLATION_THINKING_VARIANTS = {"think", "think-tiny", "think-gbnf"}


def translation_bucket_for_variant(variant: str) -> str:
    """Which of the two translation runs a variant belongs to."""
    return "think" if str(variant or "") in TRANSLATION_THINKING_VARIANTS else "no-think"


def attach_translation_result(payload: dict, artifact: dict | None) -> dict:
    """Insert the Hebrew-translation score into a quality payload and recompute
    the weighted overall. Kept separate from run_quality_step because the other
    quality tasks are shared across every variant while this one is not."""
    if not isinstance(payload, dict):
        return payload
    score = (artifact or {}).get("score")
    payload.setdefault("scores", {})[TRANSLATION_TASK] = score
    payload["hebrewTranslation"] = score
    payload["translationArtifact"] = artifact or None
    components = dict(payload.get("overallComponents") or {})
    components["hebrewTranslation"] = score
    components.pop("arcChallenge", None)
    payload["overallComponents"] = components
    weighted_total = 0.0
    total_weight = 0.0
    for key, weight in QUALITY_OVERALL_WEIGHTS.items():
        value = components.get(key)
        if value is None:
            continue
        weighted_total += float(value) * weight
        total_weight += weight
    payload["overallAverage"] = round(weighted_total / total_weight, 4) if total_weight > 0 else None
    payload["overallWeights"] = dict(QUALITY_OVERALL_WEIGHTS)
    return payload

EXPECTED_PRODUCT = 5754
EXPECTED_FACTORS = [2, 3, 7, 137]

BASIC_PROMPT = "hi"
THROUGHPUT_SCENARIO = "reasoning-code-v1"
THROUGHPUT_SYSTEM_PROMPT = (
    "You are running a deterministic reasoning-throughput benchmark. Solve the user's coding task "
    "carefully, keep the final answer concise, and return only Python 3 code in the final answer."
)
THROUGHPUT_VISIBLE_THINK_SYSTEM_PROMPT = (
    "You are running a deterministic reasoning-throughput benchmark. First emit a visible "
    "<think> scratchpad, then emit the final answer. Keep both sections concise and useful, and "
    "return only Python 3 code outside the <think> block."
)
THROUGHPUT_PROMPT = textwrap.dedent(
    """\
    Solve this Python problem.

    Write a function `two_sum(nums, target)` that returns the indices of the two numbers whose
    sum equals `target`.

    Requirements:
    - Target O(n) time.
    - Exactly one valid pair exists.
    - Return the indices in increasing order.
    - The final answer must be valid Python 3 code only.
    """
).strip()
AGENTIC_PROMPT = (
    "I need you to do the following multi-step task: First, calculate the result of 42 * 137. "
    "Then, take that result and explain what prime factors it has. Finally, write a short "
    "paragraph connecting those factors to a real-world example. Use your available tools to "
    "compute the math accurately — do not guess."
)

TOOLS_PAYLOAD = [
    {
        "type": "function",
        "function": {
            "name": "multiply",
            "description": "Multiply two integers accurately.",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {"type": "integer"},
                    "b": {"type": "integer"},
                },
                "required": ["a", "b"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prime_factorize",
            "description": "Return the prime factors of a positive integer in ascending order.",
            "parameters": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer", "minimum": 2},
                },
                "required": ["n"],
                "additionalProperties": False,
            },
        },
    },
]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


OVERALL_WEIGHT_LABELS = {
    "mmluPro": "MMLU-Pro",
    "math500": "MATH-500",
    "humanEval": "HumanEval",
    "deepEval": "DeepEval",
    "hebrewTranslation": "HE chrF",
    "avgMmlu": "MMLU",
    "gsm8k": "GSM8K",
    "scenes": "Scenes",
}


def overall_legend() -> str:
    """The SUMMARY.md legend, generated from the live weights so it cannot drift."""
    parts = []
    for key, weight in sorted(QUALITY_OVERALL_WEIGHTS.items(), key=lambda item: -item[1]):
        pct = weight * 100
        label = OVERALL_WEIGHT_LABELS.get(key, key)
        parts.append(f"{label} {pct:g}%")
    return (
        "*Overall = weighted smartness score: " + ", ".join(parts)
        + ". Missing metrics are re-normalized across the available weights; "
        "scores carry a 95% interval, and n is the questions answered per metric.*"
    )


def runner_provenance() -> dict[str, Any]:
    runner_path = Path(__file__).resolve()
    stat = runner_path.stat()
    return {
        "path": str(runner_path),
        "sha256": file_sha256(runner_path),
        "modifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime)),
        "python": sys.version.split()[0],
    }


RUNNER_PROVENANCE = runner_provenance()


def _sysctl(name: str) -> str:
    try:
        return subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


def host_provenance() -> dict[str, Any]:
    """The machine the numbers came from. No hostname: it may name a person."""
    info: dict[str, Any] = {
        "platform": sys.platform,
        "cpuCount": os.cpu_count(),
    }
    if sys.platform == "darwin":
        info["chip"] = _sysctl("machdep.cpu.brand_string")
        memsize = _sysctl("hw.memsize")
        info["memoryBytes"] = int(memsize) if memsize.isdigit() else None
        try:
            info["osVersion"] = subprocess.run(["sw_vers", "-productVersion"], capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            info["osVersion"] = ""
    return info


HOST_PROVENANCE = host_provenance()


def environment_snapshot() -> dict[str, Any]:
    """Load at the moment a model starts; a busy machine explains a slow row."""
    try:
        one, five, fifteen = os.getloadavg()
        load = {"1m": round(one, 2), "5m": round(five, 2), "15m": round(fifteen, 2)}
    except OSError:
        load = None
    return {"loadAverage": load, "capturedAt": iso_now()}


def probe_engine(public_port: int) -> dict[str, Any] | None:
    """llama-server answers /props with build_info; other backends may not."""
    try:
        status, _headers, body = http_request_json("GET", f"http://127.0.0.1:{public_port}/props", timeout=5)
        if status >= 400:
            return None
        parsed = json.loads(body.decode("utf-8", errors="replace"))
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    engine: dict[str, Any] = {}
    for key in ("build_info", "model_path", "chat_template", "total_slots"):
        if key in parsed and key != "chat_template":
            engine[key] = parsed[key]
    settings = parsed.get("default_generation_settings")
    if isinstance(settings, dict) and "n_ctx" in settings:
        engine["n_ctx"] = settings.get("n_ctx")
    return engine or None


def build_prompt_processing_prompt() -> str:
    paragraph = (
        "The quick brown fox jumps over the lazy dog while the orchestra tunes its instruments, "
        "the river carries autumn leaves past the old stone bridge, and a lighthouse keeper writes "
        "the evening's weather into a leather-bound logbook."
    )
    lines = ["Read the following passage carefully and reply with the single word OK."]
    index = 1
    while sum(len(line) + 1 for line in lines) < PROMPT_PROCESSING_TARGET_CHARS:
        lines.append(f"Paragraph {index}: {paragraph}")
        index += 1
    lines.append("Reply with the single word OK.")
    return "\n".join(lines)


SAMPLING_PROFILE = {
    "basic": {"temperature": 0.7, "max_tokens": 256, "seed": BENCHMARK_SEED},
    "agentic": {"temperature": 0.0, "max_tokens": 2048, "seed": BENCHMARK_SEED},
    "throughput": {"temperature": 0.0, "max_tokens": 6144, "seed": BENCHMARK_SEED},
    "promptProcessing": {"temperature": 0.0, "max_tokens": 1, "seed": BENCHMARK_SEED, "cache_prompt": False},
    "decodeProbe": {
        "temperature": 0.0,
        "max_tokens": DECODE_PROBE_TOKENS,
        "seed": BENCHMARK_SEED,
        # llama.cpp keeps generating past the end-of-sequence token, so every
        # model is measured over the same token count. Backends that do not
        # know the field ignore it; the result records whether the cap was hit.
        "ignore_eos": True,
        "cache_prompt": False,
    },
}

# Short on purpose: prompt processing should be a rounding error next to the
# decode window this probe measures.
DECODE_PROBE_PROMPT = "Count upward from one, writing each number as an English word, separated by commas."


@dataclasses.dataclass(frozen=True)
class Slot:
    name: str
    public_port: int
    gguf_backend_port: int
    gguf_tq3_backend_port: int
    beellama_backend_port: int
    mlx_backend_port: int
    mtplx_backend_port: int
    dflash_backend_port: int

    def backend_port(self, runtime: str) -> int:
        if runtime == "gguf":
            return self.gguf_backend_port
        if runtime == "gguf-tq3":
            return self.gguf_tq3_backend_port
        if runtime == "beellama":
            return self.beellama_backend_port
        if runtime in {"mlx", "rapid-mlx"}:
            return self.mlx_backend_port
        if runtime == "mtplx":
            return self.mtplx_backend_port
        if runtime == "dflash":
            return self.dflash_backend_port
        if runtime in {"mlx-dspark", "mlx-vlm"}:
            # These serve the OpenAI API directly on the public port: there is
            # no separate backend behind a proxy, unlike the GGUF launchers.
            # Discovery has produced mlx-dspark models since it was added, but
            # this map never learned the name, so every run that reached one
            # died here -- which is why no MLX row has ever been recorded.
            return self.public_port
        raise ValueError(f"Unknown runtime {runtime!r}")

    def all_ports(self) -> list[int]:
        return [
            self.public_port,
            self.gguf_backend_port,
            self.gguf_tq3_backend_port,
            self.beellama_backend_port,
            self.mlx_backend_port,
            self.mtplx_backend_port,
            self.dflash_backend_port,
        ]


@dataclasses.dataclass
class ModelSpec:
    runtime: str
    launcher: str
    key: str
    label: str
    family: str
    path: str
    launch_ref: str
    hf_url: str = ""
    size_label: str = ""
    size_bytes: int | None = None
    aliases: list[str] = dataclasses.field(default_factory=list)
    discovery_source: str = "disk"
    discovery_index: int = 0
    result_dir_name: str = ""
    # Thinking-variant runs: "" (legacy single run), "no-think", "think",
    # "think-tiny", "think-gbnf". Affects launch flags, throughput grammar,
    # and the results directory key.
    variant: str = ""

    def canonical_id(self) -> str:
        resolved = normalize_ref(self.launch_ref)
        return f"{self.runtime}:{self.launcher}:{resolved}"

    def backend_port_or_none(self, slot: Slot) -> int | None:
        try:
            return slot.backend_port(self.launcher)
        except ValueError:
            print(
                f"warning: no backend port mapped for launcher {self.launcher!r};"
                " recording null in metadata.json",
                file=sys.stderr,
            )
            return None

    def metadata(self, slot: Slot) -> dict[str, Any]:
        return {
            "modelKey": self.key,
            "modelLabel": self.label,
            "runtime": self.runtime,
            "launcher": self.launcher,
            "family": self.family,
            "path": self.path,
            "launchRef": self.launch_ref,
            "sizeLabel": self.size_label,
            "sizeBytes": self.size_bytes,
            "hfUrl": self.hf_url,
            "aliases": self.aliases,
            "slotUsed": slot.name,
            "publicPort": slot.public_port,
            # Informational only. A launcher this map has not learned yet must
            # not abort the run before the model is even started.
            "backendPort": self.backend_port_or_none(slot),
            "discoverySource": self.discovery_source,
        }

    def supports_tiny_grammar(self) -> bool:
        haystack = " ".join([self.label, self.family, *self.aliases]).lower()
        return self.runtime == "gguf" and self.launcher != "gguf-tq3" and "qwen" in haystack

    def supports_structured_gbnf(self) -> bool:
        # Mirrors src/server.js supportsStructuredGbnf: Qwen 3.6 35B/A3B only.
        haystack = " ".join([self.label, self.family, self.key, *self.aliases]).lower()
        return (
            self.supports_tiny_grammar()
            and "3.6" in haystack
            and ("35b" in haystack or "a3b" in haystack)
        )

    def supports_thinking_toggle(self) -> bool:
        return self.runtime == "gguf" and self.launcher != "gguf-tq3"

    def thinking_variants(self, *, include_grammar: bool = True) -> list[str]:
        if not self.supports_thinking_toggle():
            return []
        variants = ["no-think", "think"]
        if include_grammar and self.supports_tiny_grammar():
            variants.append("think-tiny")
        if include_grammar and self.supports_structured_gbnf():
            variants.append("think-gbnf")
        return variants

    def launch_command(
        self,
        slot: Slot,
        context_size: int,
        parallel: int,
        thinking: bool = False,
        enable_tiny_grammar: bool = False,
    ) -> list[str]:
        if self.launcher in {"gguf", "gguf-tq3", "beellama"}:
            use_tiny_grammar = enable_tiny_grammar and self.supports_tiny_grammar()
            launcher_path = {
                "gguf": GGUF_LAUNCHER,
                "gguf-tq3": GGUF_TQ3_LAUNCHER,
                "beellama": BEELLAMA_LAUNCHER,
            }[self.launcher]
            cmd = [
                str(launcher_path),
                "--slot",
                slot.name,
                self.launch_ref,
                "--ctx-size",
                str(context_size),
                "--parallel",
                str(parallel),
                "--thinking" if thinking and self.launcher != "gguf-tq3" else "--no-thinking",
            ]
            if use_tiny_grammar:
                cmd.append("--enable-tiny-grammar")
            else:
                # Explicitly disable any grammar so saved defaults (e.g.
                # enableTinyGrammar=true) cannot cause llama-server to crash
                # on characters the grammar doesn't expect (e.g. '@' in tool
                # calls or quality-eval answers).
                cmd.append("--no-grammar-file")
            return cmd
        if self.launcher == "mlx":
            return [
                str(MLX_LAUNCHER),
                "--slot",
                slot.name,
                "--model",
                self.launch_ref,
                "--context-size",
                str(context_size),
                "--parallel",
                str(parallel),
            ]
        if self.launcher == "mlx-dspark":
            return [
                str(MLX_DSPARK_LAUNCHER),
                "--slot",
                slot.name,
                "--model",
                self.launch_ref,
                "--context-size",
                str(context_size),
                "--parallel",
                str(parallel),
            ]
        if self.launcher == "rapid-mlx":
            return [
                str(RAPID_MLX_LAUNCHER),
                "--slot",
                slot.name,
                "--model",
                self.launch_ref,
                "--context-size",
                str(context_size),
                "--parallel",
                str(parallel),
            ]
        if self.launcher == "mtplx":
            return [
                str(MTPLX_LAUNCHER),
                "--slot",
                slot.name,
                "--model",
                self.launch_ref,
                "--context-size",
                str(context_size),
                "--parallel",
                str(parallel),
                "--port",
                str(slot.public_port),
            ]
        if self.launcher == "dflash":
            return [
                str(DFLASH_LAUNCHER),
                "--slot",
                slot.name,
                "--model",
                self.launch_ref,
                "--context-size",
                str(context_size),
                "--parallel",
                str(parallel),
            ]
        raise ValueError(f"Unsupported launcher {self.launcher!r}")


@dataclasses.dataclass
class RunnerConfig:
    results_dir: Path
    summary_path: Path
    context_size: int
    parallel: int
    load_timeout: int
    global_timeout: int
    throughput_window: int
    throughput_stall_timeout: int
    throughput_repeats: int
    throughput_warmup: int
    quality_limit: int
    variant: str | None
    quality_metrics: tuple[str, ...]
    deepeval_limit: int
    quality_task_timeout: int
    deepeval_timeout: int
    force: bool
    dry_run: bool
    limit: int | None
    runtime_filter: set[str] | None
    model_filters: list[str]
    exclude_model_filters: list[str]
    slot_count: int
    selected_slot: str | None
    thinking: bool = False
    enable_tiny_grammar: bool = False
    simple_thinking_variants: bool = False
    thinking_variants: bool = False
    include_apple_tq3_cpu: bool = False


@dataclasses.dataclass
class StreamResult:
    text: str
    reasoning_text: str
    answer_text: str
    ttft_seconds: float | None
    total_seconds: float
    usage: dict[str, Any] | None
    token_count_method: str
    tokens_generated: int
    reasoning_tokens_generated: int
    answer_tokens_generated: int
    finish_reason: str | None
    raw_events: list[dict[str, Any]]
    # Seconds from request start until the first answer-phase token (after any
    # reasoning/<think> phase). None when no answer phase was observed.
    first_answer_seconds: float | None = None


@dataclasses.dataclass
class CurlStreamResponse:
    process: subprocess.Popen[bytes]
    status: int
    headers: dict[str, str]
    initial_body: bytes


class BenchmarkError(Exception):
    def __init__(self, code: str, message: str, *, details: Any | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


class StepTimeout(BenchmarkError):
    pass


class StreamStall(BenchmarkError):
    pass


class ApiResponseError(BenchmarkError):
    def __init__(self, status: int, message: str, body: str, *, details: Any | None = None) -> None:
        super().__init__("api-error", message, details=details)
        self.status = status
        self.body = body


class InterruptRequested(SystemExit):
    pass


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def normalize_ref(value: str) -> str:
    path = Path(value).expanduser()
    if path.is_absolute():
        try:
            return str(path.resolve())
        except FileNotFoundError:
            return str(path)
    return value


def format_bytes(value: int | None) -> str:
    if value is None:
        return ""
    amount = float(value)
    units = ["B", "KB", "MB", "GB", "TB"]
    unit_index = 0
    while amount >= 1024 and unit_index < len(units) - 1:
        amount /= 1024
        unit_index += 1
    if unit_index == 0:
        return f"{int(amount)} B"
    if amount >= 100:
        return f"{amount:.0f} {units[unit_index]}"
    if amount >= 10:
        return f"{amount:.1f} {units[unit_index]}"
    return f"{amount:.2f} {units[unit_index]}"


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^\w .+-]+", "-", value, flags=re.ASCII).strip(" .-_")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or "model"


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(content, encoding="utf-8")
    temp_path.replace(path)


def atomic_write_json(path: Path, payload: Any) -> None:
    atomic_write_text(path, json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=False) + "\n")


def append_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", errors="replace") as handle:
        handle.write(text)


def count_tokens_estimate(text: str) -> int:
    stripped = text.strip()
    if not stripped:
        return 0
    return max(1, math.ceil(len(stripped) / 4))


def load_json_file(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def run_subprocess(
    command: list[str],
    *,
    timeout: int | None = None,
    check: bool = False,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=check,
        env=env,
    )


def subprocess_log_blob(command: list[str], result: subprocess.CompletedProcess[str] | subprocess.TimeoutExpired, started_at: float) -> str:
    duration = time.monotonic() - started_at
    lines = [
        f"[{iso_now()}] command: {' '.join(shlex.quote(part) for part in command)}",
        f"duration_seconds: {duration:.3f}",
    ]
    if isinstance(result, subprocess.TimeoutExpired):
        lines.append("returncode: timeout")
        stdout = result.stdout or ""
        stderr = result.stderr or ""
    else:
        lines.append(f"returncode: {result.returncode}")
        stdout = result.stdout or ""
        stderr = result.stderr or ""
    if stdout:
        lines.extend(["--- stdout ---", stdout.rstrip("\n")])
    if stderr:
        lines.extend(["--- stderr ---", stderr.rstrip("\n")])
    lines.append("")
    return "\n".join(lines)


def read_command_json(command: list[str]) -> list[dict[str, Any]]:
    started_at = time.monotonic()
    try:
        result = run_subprocess(command, timeout=30, check=False)
    except Exception as exc:
        print(f"warning: failed to run {' '.join(command)}: {exc}", file=sys.stderr)
        return []
    if result.returncode != 0:
        print(
            f"warning: {' '.join(command)} exited with {result.returncode}: {(result.stderr or result.stdout).strip()}",
            file=sys.stderr,
        )
        return []
    try:
        payload = json.loads(result.stdout or "[]")
    except json.JSONDecodeError as exc:
        print(f"warning: invalid JSON from {' '.join(command)}: {exc}", file=sys.stderr)
        return []
    if not isinstance(payload, list):
        print(f"warning: unexpected JSON payload from {' '.join(command)}", file=sys.stderr)
        return []
    _ = started_at
    return [item for item in payload if isinstance(item, dict)]


def build_slot(index: int) -> Slot:
    return Slot(
        name=f"slot{index}",
        public_port=8035 + index,
        gguf_backend_port=18035 + index,
        gguf_tq3_backend_port=18635 + index,
        beellama_backend_port=18735 + index,
        mlx_backend_port=18135 + index,
        mtplx_backend_port=18535 + index,
        dflash_backend_port=18235 + index,
    )


def slot_from_name(name: str) -> Slot:
    match = re.fullmatch(r"slot(\d+)", str(name).strip(), flags=re.IGNORECASE)
    if not match:
        raise SystemExit(f"Invalid slot name {name!r}; expected slotN.")
    index = int(match.group(1))
    if index <= 0:
        raise SystemExit("slot number must be positive")
    return build_slot(index)


def discover_slots(slot_count: int, selected_slot: str | None = None) -> list[Slot]:
    if selected_slot:
        return [slot_from_name(selected_slot)]
    return [build_slot(index) for index in range(1, slot_count + 1)]


def choose_file_label(metadata: dict[str, Any], file_path: Path, sibling_count: int) -> str:
    label = str(metadata.get("label") or "").strip()
    if not label:
        return file_path.stem
    if sibling_count <= 1:
        return label
    if file_path.stem.lower() in label.lower():
        return label
    return f"{label} ({file_path.stem})"


def load_hf_metadata(path: Path) -> dict[str, Any]:
    metadata_path = path / ".llm3-hf.json"
    if not metadata_path.is_file():
        return {}
    return load_json_file(metadata_path)


def load_model_config(path: Path) -> dict[str, Any]:
    config_path = path / "config.json"
    if not config_path.is_file():
        return {}
    return load_json_file(config_path)


def experimental_launchers_enabled() -> bool:
    """MLX/rapid-mlx/MTPLX/DFlash lost every head-to-head against llama.cpp
    Metal on this hardware (see SPEED_OPTIMIZATION_FINDINGS.md), so their
    discovery is opt-in. Mirrors src/server.js experimentalMlxLaunchersEnabled."""
    return os.environ.get("LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS", "").strip().lower() in {"1", "true", "yes"}


def is_mtp_draft_gguf(path: Path) -> bool:
    """MTP draft heads (mtp-*.gguf, MTP/*.gguf, *-MTP-*.gguf) are speculative
    companions, not servable models — never benchmark them standalone."""
    lower = str(path).lower()
    name = path.name.lower()
    # NOTE: main models can embed MTP in their filename (Qwen3.6-35BA3B-MTP.gguf);
    # actual draft heads live in an MTP/ subdir or use the mtp- prefix.
    return "/mtp/" in lower or name.startswith("mtp-")


SPLIT_GGUF_RE = re.compile(r"-\d{5}-of-\d{5}\.gguf$", re.IGNORECASE)


def split_gguf_group_key(path: Path) -> str:
    """Shards of one split model collapse to a single key."""
    return SPLIT_GGUF_RE.sub(".gguf", str(path))


def gguf_group_size_bytes(path: Path) -> int | None:
    """Size of a GGUF model, counting every shard of a split set.

    Sizing a split model from shard 00001 alone reported unsloth's 77GB
    DeepSeek-V4-Flash sets as 5.01 MB, because that shard holds only the
    metadata block.
    """
    try:
        if not SPLIT_GGUF_RE.search(path.name):
            return path.stat().st_size
        pattern = SPLIT_GGUF_RE.sub("-*-of-*.gguf", path.name)
        shards = sorted(path.parent.glob(pattern))
        if not shards:
            return path.stat().st_size
        return sum(shard.stat().st_size for shard in shards if shard.is_file())
    except OSError:
        return None


def candidate_gguf_files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    found = sorted(
        [
            path
            for path in root.rglob("*.gguf")
            if path.is_file()
            and not path.name.lower().startswith("mmproj")
            and not is_mtp_draft_gguf(path)
        ]
    )
    # A split GGUF is ONE model: llama.cpp loads it through shard 00001 and
    # pulls in the rest. Listing every shard offered several entries for the
    # same model, all but the first of which cannot be loaded.
    grouped: dict[str, Path] = {}
    for path in found:
        key = split_gguf_group_key(path)
        if key not in grouped:
            grouped[key] = path
    return sorted(grouped.values())


def is_mlx_directory(path: Path) -> bool:
    if not path.is_dir():
        return False
    if not (path / "config.json").is_file():
        return False
    return any(path.glob("*.safetensors"))


def has_mtplx_artifacts(path: Path) -> bool:
    if not path.is_dir():
        return False
    return (path / "mtplx_runtime.json").is_file() or (path / "mtp.safetensors").is_file()


def launcher_trait_text(model: ModelSpec) -> str:
    return " ".join(
        str(part)
        for part in [
            model.key,
            model.label,
            model.family,
            model.path,
            model.launch_ref,
            model.hf_url,
            *model.aliases,
        ]
        if str(part).strip()
    ).lower()


def is_tq3_model(model: ModelSpec) -> bool:
    return any(token in launcher_trait_text(model) for token in ("tq3", "turboquant"))


def is_apple_tq3_cpu_only(model: ModelSpec) -> bool:
    return sys.platform == "darwin" and model.launcher == "gguf-tq3" and is_tq3_model(model)


def is_mtp_gguf_model(model: ModelSpec) -> bool:
    text = launcher_trait_text(model)
    return "mtp" in text or "speculative" in text


def is_gemma4_model_spec(model: ModelSpec) -> bool:
    text = launcher_trait_text(model)
    compact = text.replace(" ", "").replace("-", "").replace("_", "").replace("/", "").replace(".", "")
    return "gemma4" in compact


def gguf_compatible_launchers(model: ModelSpec, available: set[str]) -> list[str]:
    if is_tq3_model(model):
        return ["gguf-tq3"] if "gguf-tq3" in available else []
    if is_mtp_gguf_model(model):
        return ["gguf"] if "gguf" in available else []

    launchers = ["gguf"] if "gguf" in available else []
    # Benchmarks (2026-06): beellama decodes 15-30% slower than upstream
    # llama.cpp on every model it loads, so it must be opted into explicitly;
    # the metal build existing on disk no longer auto-enables it.
    beellama_ready = (
        os.environ.get("LLM3_ENABLE_EXPERIMENTAL_BEELLAMA", "").strip().lower() in {"1", "true", "yes"}
    )
    # Keep this matrix aligned with src/server.js getLaunchersForModel: Gemma 4
    # crashes beellama fatally during warmup, so the pair is never real-world.
    if beellama_ready and "beellama" in available and not is_gemma4_model_spec(model):
        launchers.append("beellama")
    return launchers


def preferred_mlx_launcher(path: Path) -> str:
    config = load_model_config(path)
    model_type = str(config.get("model_type") or "").strip().lower()
    if model_type == "deepseek_v4":
        return "mlx"
    return "rapid-mlx"


def mlx_launcher_supported(path: Path) -> bool:
    config = load_model_config(path)
    model_type = str(config.get("model_type") or "").strip().lower()
    return model_type not in {"deepseek_v4"}


def sum_directory_bytes(path: Path) -> int:
    total = 0
    for file_path in path.rglob("*"):
        if file_path.is_file() and file_path.name != ".llm3-hf.json":
            try:
                total += file_path.stat().st_size
            except OSError:
                continue
    return total


def discover_models() -> list[ModelSpec]:
    discovered: dict[str, ModelSpec] = {}
    discovery_order = 0
    gguf_launchers = [
        ("gguf", GGUF_LAUNCHER),
        ("gguf-tq3", GGUF_TQ3_LAUNCHER),
        ("beellama", BEELLAMA_LAUNCHER),
    ]
    available_gguf_launchers = {name for name, path in gguf_launchers if path.exists()}

    def add_model(model: ModelSpec) -> None:
        nonlocal discovery_order
        model.discovery_index = discovery_order
        discovery_order += 1
        canonical = model.canonical_id()
        existing = discovered.get(canonical)
        if existing is None:
            discovered[canonical] = model
            return
        source_rank = {"launcher": 2, "disk": 1}
        if source_rank.get(model.discovery_source, 0) > source_rank.get(existing.discovery_source, 0):
            discovered[canonical] = model

    def add_gguf_variants(base: ModelSpec) -> None:
        for launcher in gguf_compatible_launchers(base, available_gguf_launchers):
            add_model(dataclasses.replace(base, launcher=launcher))

    def add_mlx_launcher(base: ModelSpec, launcher: str) -> None:
        # The disk scan now runs whenever mlx-dspark is installed, so the older
        # launchers have to be gated here rather than at the scan: otherwise
        # every MLX directory would be listed once per launcher.
        if launcher != "mlx-dspark" and not experimental_launchers_enabled():
            return
        launcher_path = {
            "mlx": MLX_LAUNCHER,
            "rapid-mlx": RAPID_MLX_LAUNCHER,
            "mtplx": MTPLX_LAUNCHER,
            "mlx-dspark": MLX_DSPARK_LAUNCHER,
        }.get(launcher)
        if launcher_path and launcher_path.exists():
            add_model(dataclasses.replace(base, runtime="mlx", launcher=launcher))

    for row in read_command_json([str(GGUF_LAUNCHER), "--list-json"]):
        path = normalize_ref(str(row.get("path") or row.get("key") or ""))
        if not path:
            continue
        candidate = Path(path)
        size_bytes = None
        try:
            size_bytes = candidate.stat().st_size
        except OSError:
            pass
        add_gguf_variants(
            ModelSpec(
                runtime="gguf",
                launcher="gguf",
                key=str(row.get("key") or path),
                label=str(row.get("label") or candidate.stem),
                family=str(row.get("family") or "Downloaded GGUF"),
                path=path,
                launch_ref=str(row.get("key") or path),
                hf_url=str(row.get("hfUrl") or ""),
                size_label=str(row.get("sizeLabel") or format_bytes(size_bytes)),
                size_bytes=size_bytes,
                aliases=[str(item) for item in row.get("aliases") or [] if str(item).strip()],
                discovery_source="launcher",
            )
        )

    if HF_ROOT.is_dir():
        for model_dir in sorted(path for path in HF_ROOT.iterdir() if path.is_dir()):
            metadata = load_hf_metadata(model_dir)
            runtime = str(metadata.get("runtime") or "").strip().lower()
            gguf_files = candidate_gguf_files(model_dir)
            if runtime in {"", "gguf"} or gguf_files:
                for gguf_path in gguf_files:
                    size_bytes = gguf_group_size_bytes(gguf_path)
                    add_gguf_variants(
                        ModelSpec(
                            runtime="gguf",
                            launcher="gguf",
                            key=str(gguf_path.resolve()),
                            label=choose_file_label(metadata, gguf_path, len(gguf_files)),
                            family=str(metadata.get("family") or "Downloaded GGUF"),
                            path=str(gguf_path.resolve()),
                            launch_ref=str(gguf_path.resolve()),
                            hf_url=str(metadata.get("hfUrl") or ""),
                            size_label=format_bytes(size_bytes),
                            size_bytes=size_bytes,
                            aliases=[str(item) for item in metadata.get("aliases") or [] if str(item).strip()],
                            discovery_source="disk",
                        )
                    )

    mlx_rows = read_command_json([str(MLX_LAUNCHER), "--list-json"]) if experimental_launchers_enabled() else []
    for row in mlx_rows:
        path = normalize_ref(str(row.get("path") or row.get("key") or ""))
        if not path:
            continue
        candidate = Path(path)
        if has_mtplx_artifacts(candidate):
            continue
        if candidate.is_dir() and not mlx_launcher_supported(candidate):
            continue
        size_bytes = sum_directory_bytes(candidate) if candidate.is_dir() else None
        add_mlx_launcher(
            ModelSpec(
                runtime="mlx",
                launcher="mlx",
                key=str(row.get("key") or path),
                label=str(row.get("label") or candidate.name),
                family=str(row.get("family") or "Downloaded MLX"),
                path=path,
                launch_ref=path,
                hf_url=str(row.get("hfUrl") or ""),
                size_label=str(row.get("sizeLabel") or format_bytes(size_bytes)),
                size_bytes=size_bytes,
                discovery_source="launcher",
            ),
            "mlx",
        )

    rapid_mlx_rows = read_command_json([str(RAPID_MLX_LAUNCHER), "--list-json"]) if experimental_launchers_enabled() else []
    for row in rapid_mlx_rows:
        path = normalize_ref(str(row.get("path") or row.get("key") or ""))
        if not path:
            continue
        candidate = Path(path)
        if candidate.is_dir() and not mlx_launcher_supported(candidate):
            continue
        size_bytes = sum_directory_bytes(candidate) if candidate.is_dir() else None
        add_mlx_launcher(
            ModelSpec(
                runtime="mlx",
                launcher="rapid-mlx",
                key=str(row.get("key") or path),
                label=str(row.get("label") or candidate.name),
                family=str(row.get("family") or "Rapid MLX"),
                path=path,
                launch_ref=path,
                hf_url=str(row.get("hfUrl") or ""),
                size_label=str(row.get("sizeLabel") or format_bytes(size_bytes)),
                size_bytes=size_bytes,
                discovery_source="launcher",
            ),
            "rapid-mlx",
        )

    mtplx_rows = read_command_json([str(MTPLX_LAUNCHER), "--list-json"]) if experimental_launchers_enabled() else []
    mtplx_launchable_paths = {
        normalize_ref(str(row.get("path") or row.get("key") or ""))
        for row in mtplx_rows
        if str(row.get("path") or row.get("key") or "").strip()
    }

    # mlx-dspark is not experimental, so the scan has to happen whenever it is
    # installed -- not only when the opt-in flag is set for the older launchers.
    dspark_available = MLX_DSPARK_LAUNCHER.exists() and MLX_DSPARK_BIN.exists()
    scan_mlx_dirs = experimental_launchers_enabled() or dspark_available
    mlx_scan_roots: list[Path] = []
    if scan_mlx_dirs and MODELS_ROOT.is_dir():
        skip_names = {"hf", "dflash", "voice", "voice-stt", "voice-tts"}
        mlx_scan_roots.extend(
            path
            for path in sorted(MODELS_ROOT.iterdir())
            if path.is_dir() and path.name not in skip_names and not path.name.startswith(".")
        )
    if scan_mlx_dirs and HF_ROOT.is_dir():
        mlx_scan_roots.extend(path for path in sorted(HF_ROOT.iterdir()) if path.is_dir())

    for model_dir in mlx_scan_roots:
        metadata = load_hf_metadata(model_dir)
        runtime = str(metadata.get("runtime") or "").strip().lower()
        if runtime not in {"", "mlx", "mtplx"} and metadata:
            continue
        if not is_mlx_directory(model_dir):
            continue
        if not mlx_launcher_supported(model_dir):
            continue
        resolved_model_dir = str(model_dir.resolve())
        if resolved_model_dir in mtplx_launchable_paths:
            continue
        size_bytes = sum_directory_bytes(model_dir)
        add_mlx_launcher(
            ModelSpec(
                runtime="mlx",
                launcher="mlx",
                key=resolved_model_dir,
                label=str(metadata.get("label") or model_dir.name),
                family=str(metadata.get("family") or "Downloaded MLX"),
                path=resolved_model_dir,
                launch_ref=resolved_model_dir,
                hf_url=str(metadata.get("hfUrl") or ""),
                size_label=format_bytes(size_bytes),
                size_bytes=size_bytes,
                aliases=[str(item) for item in metadata.get("aliases") or [] if str(item).strip()],
                discovery_source="disk",
            ),
            "mlx",
        )
        if dspark_available:
            add_mlx_launcher(
                ModelSpec(
                    runtime="mlx",
                    launcher="mlx-dspark",
                    key=resolved_model_dir,
                    label=str(metadata.get("label") or model_dir.name),
                    family=str(metadata.get("family") or "Downloaded MLX"),
                    path=resolved_model_dir,
                    launch_ref=resolved_model_dir,
                    hf_url=str(metadata.get("hfUrl") or ""),
                    size_label=format_bytes(size_bytes),
                    size_bytes=size_bytes,
                    aliases=[str(item) for item in metadata.get("aliases") or [] if str(item).strip()],
                    discovery_source="disk",
                ),
                "mlx-dspark",
            )

    dflash_rows = read_command_json([str(DFLASH_LAUNCHER), "--list-json"]) if experimental_launchers_enabled() else []
    for row in dflash_rows:
        path = normalize_ref(str(row.get("path") or row.get("key") or ""))
        if not path:
            continue
        size_bytes = row.get("sizeBytes")
        if not isinstance(size_bytes, int):
            size_bytes = None
        add_model(
            ModelSpec(
                runtime="dflash",
                launcher="dflash",
                key=str(row.get("key") or path),
                label=str(row.get("label") or Path(path).name),
                family=str(row.get("family") or "DFlash"),
                path=path,
                launch_ref=str(row.get("key") or path),
                hf_url=str(row.get("hfUrl") or ""),
                size_label=str(row.get("sizeLabel") or format_bytes(size_bytes)),
                size_bytes=size_bytes,
                discovery_source="launcher",
            )
        )

    if experimental_launchers_enabled() and DFLASH_ROOT.is_dir():
        for manifest in sorted(DFLASH_ROOT.glob("*/manifest.json")):
            bundle_dir = manifest.parent
            metadata = load_json_file(manifest)
            target_dir = bundle_dir / str(metadata.get("targetDir") or "target")
            draft_dir = bundle_dir / str(metadata.get("draftDir") or "draft")
            if not target_dir.is_dir() or not draft_dir.is_dir():
                continue
            size_bytes = sum_directory_bytes(bundle_dir)
            add_model(
                ModelSpec(
                    runtime="dflash",
                    launcher="dflash",
                    key=str(metadata.get("key") or bundle_dir.name),
                    label=str(metadata.get("label") or bundle_dir.name),
                    family=str(metadata.get("family") or "DFlash"),
                    path=str(bundle_dir.resolve()),
                    launch_ref=str(metadata.get("key") or bundle_dir.name),
                    hf_url=f"https://huggingface.co/{metadata['targetRepo']}" if metadata.get("targetRepo") else "",
                    size_label=format_bytes(size_bytes),
                    size_bytes=size_bytes,
                    discovery_source="disk",
                )
            )

    for row in mtplx_rows:
        path = normalize_ref(str(row.get("path") or row.get("key") or ""))
        if not path:
            continue
        candidate = Path(path)
        size_bytes = sum_directory_bytes(candidate) if candidate.is_dir() else None
        base_model = ModelSpec(
            runtime="mlx",
            launcher="mtplx",
            key=str(row.get("key") or path),
            label=str(row.get("label") or candidate.name),
            family=str(row.get("family") or "MTPLX"),
            path=path,
            launch_ref=path,
            hf_url=str(row.get("hfUrl") or ""),
            size_label=str(row.get("sizeLabel") or format_bytes(size_bytes)),
            size_bytes=size_bytes,
            discovery_source="launcher",
        )
        add_mlx_launcher(base_model, "mlx")
        add_mlx_launcher(
            ModelSpec(
                runtime="mlx",
                launcher="mtplx",
                key=str(row.get("key") or path),
                label=str(row.get("label") or candidate.name),
                family=str(row.get("family") or "MTPLX"),
                path=path,
                launch_ref=path,
                hf_url=str(row.get("hfUrl") or ""),
                size_label=str(row.get("sizeLabel") or format_bytes(size_bytes)),
                size_bytes=size_bytes,
                discovery_source="launcher",
            ),
            "mtplx",
        )

    runtime_rank = {"gguf": 0, "mlx": 1, "mtplx": 2, "dflash": 3}
    models = sorted(
        discovered.values(),
        key=lambda model: (
            runtime_rank.get(model.runtime, 99),
            0 if model.discovery_source == "launcher" else 1,
            model.discovery_index,
            model.label.lower(),
            model.canonical_id(),
        ),
    )

    assigned_names: dict[str, int] = {}
    for model in models:
        variant_suffix = f"__{model.variant}" if model.variant else ""
        base_name = safe_name(f"{model.label}__{model.launcher}{variant_suffix}")
        assigned_names[base_name] = assigned_names.get(base_name, 0) + 1
    used_paths: set[str] = set()
    for model in models:
        variant_suffix = f"__{model.variant}" if model.variant else ""
        base_name = safe_name(f"{model.label}__{model.launcher}{variant_suffix}")
        result_name = base_name
        if assigned_names[base_name] > 1:
            suffix = hashlib.sha1(model.canonical_id().encode("utf-8")).hexdigest()[:8]
            result_name = f"{base_name}__{suffix}"
        while result_name in used_paths:
            suffix = hashlib.sha1(f"{model.canonical_id()}:{result_name}".encode("utf-8")).hexdigest()[:8]
            result_name = f"{base_name}__{suffix}"
        used_paths.add(result_name)
        model.result_dir_name = result_name

    return models


def model_inventory_json(models: list[ModelSpec]) -> list[dict[str, Any]]:
    return [
        {
            "runtime": model.runtime,
            "launcher": model.launcher,
            "key": model.key,
            "label": model.label,
            "family": model.family,
            "path": model.path,
            "launchRef": model.launch_ref,
            "hfUrl": model.hf_url,
            "sizeLabel": model.size_label,
            "sizeBytes": model.size_bytes,
            "aliases": model.aliases,
            "discoverySource": model.discovery_source,
            "resultDirName": model.result_dir_name,
        }
        for model in models
    ]


def resolve_models(models: list[ModelSpec], config: RunnerConfig) -> list[ModelSpec]:
    filtered = models
    if config.runtime_filter:
        filtered = [model for model in filtered if model.runtime in config.runtime_filter]
    if config.model_filters:
        needles = [value.lower() for value in config.model_filters]
        filtered = [
            model
            for model in filtered
            if any(
                needle in " ".join(
                    [
                        model.label.lower(),
                        model.key.lower(),
                        model.path.lower(),
                        model.launch_ref.lower(),
                        model.family.lower(),
                    ]
                )
                for needle in needles
            )
        ]
    # Applied after the include filters: excluding is the only practical way to
    # say "everything except these", e.g. skipping 77-96GB split sets that will
    # not fit alongside a 128k KV cache.
    if config.exclude_model_filters:
        haystacks = [value.lower() for value in config.exclude_model_filters]
        filtered = [
            model
            for model in filtered
            if not any(
                needle in " ".join(
                    [
                        model.label.lower(),
                        model.key.lower(),
                        model.path.lower(),
                        model.launch_ref.lower(),
                        model.family.lower(),
                    ]
                )
                for needle in haystacks
            )
        ]
    if not config.include_apple_tq3_cpu:
        filtered = [model for model in filtered if not is_apple_tq3_cpu_only(model)]
    if config.limit is not None:
        filtered = filtered[: config.limit]
    # A single-variant run still has to be labelled. Without this, "think only"
    # fell through to the legacy unlabelled path: variant "", a result directory
    # with no suffix, a "-" row in the dashboard, and nothing to join the think
    # bucket's scenes or translation against.
    if config.variant and not (config.thinking_variants or config.simple_thinking_variants):
        pinned: list[ModelSpec] = []
        for model in filtered:
            if config.variant not in model.thinking_variants(include_grammar=True):
                pinned.append(model)
                continue
            copy = dataclasses.replace(model, variant=config.variant)
            copy.result_dir_name = (
                safe_name(f"{model.label}__{model.launcher}__{config.variant}")
                if not model.result_dir_name
                else f"{model.result_dir_name}__{config.variant}"
            )
            pinned.append(copy)
        return pinned
    if config.thinking_variants or config.simple_thinking_variants:
        expanded: list[ModelSpec] = []
        for model in filtered:
            variants = model.thinking_variants(include_grammar=config.thinking_variants)
            if not variants:
                expanded.append(model)
                continue
            for variant in variants:
                copy = dataclasses.replace(model, variant=variant)
                copy.result_dir_name = (
                    safe_name(f"{model.label}__{model.launcher}__{variant}")
                    if not model.result_dir_name
                    else f"{model.result_dir_name}__{variant}"
                )
                expanded.append(copy)
        filtered = expanded
    return filtered


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark the models that actually exist on disk across GGUF, MLX, and DFlash runtimes.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--results-dir", type=Path, default=RESULTS_ROOT)
    parser.add_argument("--summary-path", type=Path, default=SUMMARY_PATH)
    parser.add_argument("--context-size", type=int, default=DEFAULT_CONTEXT_SIZE)
    parser.add_argument("--parallel", type=int, default=DEFAULT_PARALLEL)
    parser.add_argument("--load-timeout", type=int, default=DEFAULT_LOAD_TIMEOUT)
    parser.add_argument("--global-timeout", type=int, default=DEFAULT_GLOBAL_TIMEOUT)
    parser.add_argument("--throughput-window", type=int, default=DEFAULT_THROUGHPUT_WINDOW)
    parser.add_argument("--throughput-stall-timeout", type=int, default=DEFAULT_THROUGHPUT_STALL_TIMEOUT)
    parser.add_argument("--throughput-repeats", type=int, default=DEFAULT_THROUGHPUT_REPEATS, help="Throughput requests per row; the row reports the median.")
    parser.add_argument("--throughput-warmup", type=int, default=DEFAULT_THROUGHPUT_WARMUP, help="Discarded generations before the timed ones (0 disables).")
    parser.add_argument("--slot-count", type=int, default=DEFAULT_SLOT_COUNT)
    parser.add_argument("--slot", dest="selected_slot", help="Pin all benchmarks to a specific llm3 slot (for example: slot3).")
    parser.add_argument("--quality-limit", type=int, default=DEFAULT_QUALITY_LIMIT, help="Number of examples per quality benchmark task.")
    # Left unset these scale with --quality-limit: a fixed budget silently
    # truncated the sample the moment the question count went up.
    parser.add_argument(
        "--quality-metric",
        action="append",
        dest="quality_metrics",
        choices=list(QUALITY_METRIC_CHOICES),
        help=f"Quality metric to measure; repeat for more. Default: {', '.join(DEFAULT_QUALITY_METRICS)}.",
    )
    parser.add_argument("--deepeval-limit", type=int, default=None, help="IFEval problems for DeepEval. Defaults to --quality-limit; lower it when DeepEval dominates the run.")
    parser.add_argument("--quality-task-timeout", type=int, default=None, help="Budget for one whole quality task (all --quality-limit questions), not one request. Defaults to 30s per question.")
    parser.add_argument("--deepeval-timeout", type=int, default=None, help="Budget for the whole DeepEval IFEval run. Defaults to 30s per problem.")
    parser.add_argument("--runtime", action="append", choices=["gguf", "mlx", "mtplx", "dflash"])
    parser.add_argument("--model", action="append", dest="models", help="Substring filter; repeat to include multiple matches.")
    parser.add_argument("--exclude-model", action="append", dest="exclude_models", help="Substring filter applied after --model; repeat to skip multiple matches.")
    parser.add_argument("--force", action="store_true", help="Re-run models even if benchmark.json already exists.")
    parser.add_argument(
        "--variant",
        choices=("no-think", "think", "think-tiny", "think-gbnf"),
        help="Run exactly one labelled thinking variant instead of the legacy unlabelled single run.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Discover models and print planned execution without benchmarking.")
    parser.add_argument("--thinking", action="store_true", help="Enable thinking mode for compatible GGUF models.")
    parser.add_argument("--enable-tiny-grammar", action="store_true", help="Enable tiny grammar for Qwen GGUF models (grammar-constrained CoT).")
    parser.add_argument(
        "--simple-thinking-variants",
        action="store_true",
        help="Benchmark each compatible GGUF model 2 ways: no-think and think only.",
    )
    parser.add_argument(
        "--thinking-variants",
        action="store_true",
        help="Benchmark each compatible GGUF model 4 ways: no-think, think, think+tiny-grammar, think+structured-gbnf.",
    )
    parser.add_argument(
        "--include-apple-tq3-cpu",
        action="store_true",
        help="Include Apple Silicon TQ3 CPU fallback rows; excluded by default because the fork has no working Metal offload locally.",
    )
    parser.add_argument("--limit", type=int, help="Only benchmark the first N selected models.")
    parser.add_argument("--discover-json", action="store_true", help="Print discovered inventory as JSON and exit.")
    return parser.parse_args(argv)


def ensure_positive(name: str, value: int) -> None:
    if value <= 0:
        raise SystemExit(f"{name} must be positive")


def build_config(args: argparse.Namespace) -> RunnerConfig:
    ensure_positive("context-size", args.context_size)
    ensure_positive("parallel", args.parallel)
    ensure_positive("load-timeout", args.load_timeout)
    ensure_positive("global-timeout", args.global_timeout)
    ensure_positive("throughput-window", args.throughput_window)
    ensure_positive("throughput-stall-timeout", args.throughput_stall_timeout)
    ensure_positive("throughput-repeats", args.throughput_repeats)
    if args.throughput_warmup < 0:
        raise SystemExit("--throughput-warmup cannot be negative")
    ensure_positive("quality-limit", args.quality_limit)
    quality_metrics = tuple(dict.fromkeys(args.quality_metrics or DEFAULT_QUALITY_METRICS))
    deepeval_limit = args.deepeval_limit or args.quality_limit
    quality_task_timeout = args.quality_task_timeout or max(DEFAULT_QUALITY_TASK_TIMEOUT, 30 * args.quality_limit)
    deepeval_timeout = args.deepeval_timeout or max(DEFAULT_DEEPEVAL_TIMEOUT, 30 * deepeval_limit)
    ensure_positive("deepeval-limit", deepeval_limit)
    ensure_positive("quality-task-timeout", quality_task_timeout)
    ensure_positive("deepeval-timeout", deepeval_timeout)
    ensure_positive("slot-count", args.slot_count)
    return RunnerConfig(
        results_dir=args.results_dir.resolve(),
        summary_path=args.summary_path.resolve(),
        context_size=args.context_size,
        parallel=args.parallel,
        load_timeout=args.load_timeout,
        global_timeout=args.global_timeout,
        throughput_window=args.throughput_window,
        throughput_stall_timeout=args.throughput_stall_timeout,
        throughput_repeats=args.throughput_repeats,
        throughput_warmup=args.throughput_warmup,
        quality_limit=args.quality_limit,
        variant=(str(args.variant).strip() if args.variant else None),
        quality_metrics=quality_metrics,
        deepeval_limit=deepeval_limit,
        quality_task_timeout=quality_task_timeout,
        deepeval_timeout=deepeval_timeout,
        force=args.force,
        dry_run=args.dry_run,
        thinking=args.thinking,
        enable_tiny_grammar=args.enable_tiny_grammar,
        simple_thinking_variants=bool(getattr(args, "simple_thinking_variants", False)) and not bool(getattr(args, "thinking_variants", False)),
        thinking_variants=bool(getattr(args, "thinking_variants", False)),
        include_apple_tq3_cpu=args.include_apple_tq3_cpu
        or os.environ.get("LLM3_INCLUDE_APPLE_TQ3_CPU_BENCHMARK", "").strip().lower() in {"1", "true", "yes"},
        limit=args.limit,
        runtime_filter=set(args.runtime) if args.runtime else None,
        model_filters=args.models or [],
        exclude_model_filters=args.exclude_models or [],
        slot_count=args.slot_count,
        selected_slot=(str(args.selected_slot).strip() if args.selected_slot else None),
    )


def http_request_json(
    method: str,
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    timeout: float = 30,
    extra_headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    parsed = urlsplit(url)
    if parsed.scheme != "http":
        raise ValueError(f"Unsupported URL scheme in {url!r}")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 80
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    body: bytes | None = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(body))
    if extra_headers:
        headers.update(extra_headers)

    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        response_body = response.read()
        headers_map = {key.lower(): value for key, value in response.getheaders()}
        return response.status, headers_map, response_body
    finally:
        connection.close()


def runtime_request_headers(launcher: str) -> dict[str, str]:
    if launcher == "rapid-mlx":
        return {
            "Authorization": "Bearer api",
            "X-API-Key": "api",
        }
    if launcher == "mtplx":
        return {
            "Authorization": f"Bearer {LOCAL_API_KEY}",
            "X-API-Key": LOCAL_API_KEY,
        }
    return {}


def get_models_payload(public_port: int, timeout: float = 5.0, *, extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
    status, _, body = http_request_json(
        "GET",
        f"http://127.0.0.1:{public_port}/v1/models",
        timeout=timeout,
        extra_headers=extra_headers,
    )
    text = body.decode("utf-8", errors="replace")
    if status >= 400:
        raise ApiResponseError(status, f"Health check failed on port {public_port}", text)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise BenchmarkError("invalid-health-json", f"Invalid JSON from /v1/models: {exc}") from exc
    if not isinstance(payload, dict):
        raise BenchmarkError("invalid-health-json", "Unexpected /v1/models payload shape")
    return payload


def wait_for_health(public_port: int, deadline: float, *, extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
    while time.monotonic() < deadline:
        try:
            return get_models_payload(public_port, timeout=5.0, extra_headers=extra_headers)
        except Exception:
            time.sleep(1)
    raise StepTimeout("load-timeout", f"Timed out waiting for /v1/models on port {public_port}")


def choose_model_id(models_payload: dict[str, Any], fallback: str) -> str:
    entries = models_payload.get("data")
    if isinstance(entries, list):
        for item in entries:
            if isinstance(item, dict) and item.get("id"):
                return str(item["id"])
    return fallback


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
                if item.get("type") == "text":
                    parts.append(str(item.get("text") or ""))
                elif "text" in item:
                    parts.append(str(item.get("text") or ""))
                elif "content" in item:
                    parts.append(message_text(item.get("content")))
        return "".join(parts)
    if isinstance(value, dict):
        if "text" in value:
            return message_text(value.get("text"))
        if "content" in value:
            return message_text(value.get("content"))
    return str(value)


def extract_delta_text(event: dict[str, Any]) -> str:
    if not isinstance(event, dict):
        return ""
    choices = event.get("choices")
    if not isinstance(choices, list):
        return ""
    parts: list[str] = []
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        delta = choice.get("delta")
        if isinstance(delta, dict):
            if "content" in delta:
                parts.append(message_text(delta.get("content")))
            if "text" in delta:
                parts.append(message_text(delta.get("text")))
            if "reasoning_content" in delta:
                parts.append(message_text(delta.get("reasoning_content")))
        if "text" in choice:
            parts.append(message_text(choice.get("text")))
        message = choice.get("message")
        if isinstance(message, dict):
            parts.append(message_text(message.get("content")))
    return "".join(parts)


def extract_delta_segments(event: dict[str, Any]) -> tuple[str, str]:
    if not isinstance(event, dict):
        return "", ""
    choices = event.get("choices")
    if not isinstance(choices, list):
        return "", ""
    reasoning_parts: list[str] = []
    answer_parts: list[str] = []
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        delta = choice.get("delta")
        if isinstance(delta, dict):
            if "reasoning_content" in delta:
                reasoning_parts.append(message_text(delta.get("reasoning_content")))
            if "reasoning" in delta:
                reasoning_parts.append(message_text(delta.get("reasoning")))
            if "content" in delta:
                answer_parts.append(message_text(delta.get("content")))
            if "text" in delta:
                answer_parts.append(message_text(delta.get("text")))
        if "text" in choice:
            answer_parts.append(message_text(choice.get("text")))
        message = choice.get("message")
        if isinstance(message, dict):
            if "reasoning_content" in message:
                reasoning_parts.append(message_text(message.get("reasoning_content")))
            if "reasoning" in message:
                reasoning_parts.append(message_text(message.get("reasoning")))
            answer_parts.append(message_text(message.get("content")))
    return "".join(reasoning_parts), "".join(answer_parts)


def split_reasoning_output(reasoning_text: str, answer_text: str, combined_text: str) -> tuple[str, str]:
    think_pattern = re.compile(r"<think>\s*(.*?)\s*</think>\s*", flags=re.IGNORECASE | re.DOTALL)
    normalized_reasoning = reasoning_text or ""
    normalized_answer = answer_text or ""

    if normalized_answer:
        think_blocks = [match.strip() for match in think_pattern.findall(normalized_answer) if match.strip()]
        if think_blocks:
            normalized_reasoning = "\n\n".join(part for part in [normalized_reasoning.strip(), *think_blocks] if part)
            normalized_answer = think_pattern.sub("", normalized_answer).strip()

    if not normalized_reasoning and combined_text:
        think_blocks = [match.strip() for match in think_pattern.findall(combined_text) if match.strip()]
        if think_blocks:
            normalized_reasoning = "\n\n".join(think_blocks)
            normalized_answer = think_pattern.sub("", combined_text).strip()

    if not normalized_answer and combined_text and not normalized_reasoning:
        normalized_answer = combined_text.strip()

    return normalized_reasoning.strip(), normalized_answer.strip()


def split_completion_tokens(
    total_tokens: int | None,
    reasoning_text: str,
    answer_text: str,
    fallback_text: str,
) -> tuple[int, int, int, str]:
    reasoning_estimate = count_tokens_estimate(reasoning_text)
    answer_estimate = count_tokens_estimate(answer_text)
    estimated_total = reasoning_estimate + answer_estimate

    if total_tokens is not None:
        if estimated_total > 0:
            reasoning_tokens = int(round(total_tokens * (reasoning_estimate / estimated_total)))
            reasoning_tokens = max(0, min(total_tokens, reasoning_tokens))
            answer_tokens = max(0, total_tokens - reasoning_tokens)
        else:
            reasoning_tokens = 0
            answer_tokens = total_tokens
        return total_tokens, reasoning_tokens, answer_tokens, "usage"

    if estimated_total == 0:
        answer_estimate = count_tokens_estimate(fallback_text)
        estimated_total = answer_estimate
    return estimated_total, reasoning_estimate, answer_estimate, "estimate"


def read_tiny_grammar() -> str:
    return TINY_GRAMMAR_PATH.read_text(encoding="utf-8")


def read_structured_gbnf() -> str:
    return STRUCTURED_GBNF_PATH.read_text(encoding="utf-8")


def build_throughput_payload(model_id: str, *, visible_think: bool, grammar_text: str | None = None) -> dict[str, Any]:
    prompt = THROUGHPUT_PROMPT
    system_prompt = THROUGHPUT_SYSTEM_PROMPT
    if visible_think:
        system_prompt = THROUGHPUT_VISIBLE_THINK_SYSTEM_PROMPT
        prompt = (
            f"{THROUGHPUT_PROMPT}\n\n"
            "Your response must begin with a visible scratchpad in this exact wrapper format:\n"
            "<think>\n"
            "...your detailed step-by-step reasoning...\n"
            "</think>\n\n"
            "Then provide the final answer. Do not emit markdown headings like 'Scratchpad' before <think>, "
            "keep all scratchpad text inside the <think> block, and make the scratchpad detailed enough to explain "
            "the intermediate steps before you present the final solution. Outside the <think> block, return only "
            "Python 3 code and no prose."
        )
    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.0,
        # Large enough that fast models do not exhaust the cap long before the
        # throughput window closes (the window, not this cap, should end runs).
        "max_tokens": 6144,
        "seed": BENCHMARK_SEED,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if grammar_text:
        payload["grammar"] = grammar_text
    return payload


def extract_usage(event: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(event, dict):
        return None
    usage = event.get("usage")
    return usage if isinstance(usage, dict) else None


def open_stream_request(
    url: str,
    payload: dict[str, Any],
    *,
    timeout: float,
    extra_headers: dict[str, str] | None = None,
) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
    parsed = urlsplit(url)
    if parsed.scheme != "http":
        raise ValueError(f"Unsupported URL scheme in {url!r}")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 80
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Accept": "text/event-stream, application/json",
        "Content-Type": "application/json",
        "Content-Length": str(len(body)),
    }
    if extra_headers:
        headers.update(extra_headers)
    connection = http.client.HTTPConnection(host, port, timeout=max(1.0, timeout))
    connection.request("POST", path, body=body, headers=headers)
    response = connection.getresponse()
    return connection, response


def terminate_process(process: subprocess.Popen[Any], *, kill_after: float = 5.0) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    deadline = time.monotonic() + kill_after
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return
        time.sleep(0.1)
    if process.poll() is None:
        process.kill()
        process.wait(timeout=5)


def open_stream_request_with_curl(url: str, payload: dict[str, Any], *, header_timeout: float) -> CurlStreamResponse:
    body = json.dumps(payload).encode("utf-8")
    command = [
        "curl",
        "--silent",
        "--show-error",
        "--no-buffer",
        "--http1.1",
        "--dump-header",
        "-",
        "-H",
        "Accept: text/event-stream, application/json",
        "-H",
        "Content-Type: application/json",
        "-X",
        "POST",
        "--data-binary",
        "@-",
        url,
    ]
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None

    process.stdin.write(body)
    process.stdin.close()

    stdout_buffer = bytearray()
    stderr_buffer = bytearray()
    header_deadline = time.monotonic() + header_timeout
    separator_length = 4

    while time.monotonic() < header_deadline:
        if process.poll() is not None and not stdout_buffer and process.stderr:
            stderr_buffer.extend(process.stderr.read() or b"")
        wait_timeout = max(0.1, header_deadline - time.monotonic())
        readable, _, _ = select.select([process.stdout, process.stderr], [], [], wait_timeout)
        for stream in readable:
            chunk = os.read(stream.fileno(), 65536)
            if not chunk:
                continue
            if stream is process.stdout:
                stdout_buffer.extend(chunk)
            else:
                stderr_buffer.extend(chunk)

        header_end = stdout_buffer.find(b"\r\n\r\n")
        if header_end == -1:
            header_end = stdout_buffer.find(b"\n\n")
            separator_length = 2
        if header_end == -1:
            continue

        raw_header_bytes = bytes(stdout_buffer[:header_end])
        initial_body = bytes(stdout_buffer[header_end + separator_length :])
        header_text = raw_header_bytes.decode("iso-8859-1", errors="replace")
        header_sections = re.split(r"\r?\n\r?\n", header_text)
        header_block = next((section for section in reversed(header_sections) if section.strip()), "")
        header_lines = [line for line in header_block.splitlines() if line.strip()]
        if not header_lines:
            terminate_process(process)
            raise BenchmarkError("http-error", "No response headers received from streaming request")
        status_match = re.match(r"HTTP/\d+(?:\.\d+)?\s+(\d+)", header_lines[0].strip())
        if not status_match:
            terminate_process(process)
            raise BenchmarkError("http-error", f"Could not parse HTTP status line: {header_lines[0]!r}")
        status = int(status_match.group(1))
        headers: dict[str, str] = {}
        for line in header_lines[1:]:
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
        return CurlStreamResponse(
            process=process,
            status=status,
            headers=headers,
            initial_body=initial_body,
        )

    stderr_tail = stderr_buffer.decode("utf-8", errors="replace").strip()
    terminate_process(process)
    raise StepTimeout("timeout", f"Timed out waiting for streaming response headers{': ' + stderr_tail if stderr_tail else ''}")


def parse_text_tool_calls(text: str) -> list[dict[str, Any]]:
    matches = list(re.finditer(r"<tool_call>\s*(.*?)\s*</tool_call>", text, flags=re.IGNORECASE | re.DOTALL))
    tool_calls: list[dict[str, Any]] = []
    for index, match in enumerate(matches, start=1):
        block = match.group(1)
        function_match = re.search(r"<function=([A-Za-z0-9_:-]+)>", block, flags=re.IGNORECASE)
        if not function_match:
            continue
        name = function_match.group(1).strip()
        parameters = {
            param_match.group(1): param_match.group(2).strip()
            for param_match in re.finditer(
                r"<parameter=([A-Za-z0-9_:-]+)>\s*(.*?)\s*</parameter>",
                block,
                flags=re.IGNORECASE | re.DOTALL,
            )
        }
        if not parameters:
            continue
        tool_calls.append(
            {
                "id": f"text-tool-call-{index}",
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": json.dumps(parameters),
                },
            }
        )
    return tool_calls


def stream_chat_completion(
    url: str,
    payload: dict[str, Any],
    *,
    hard_timeout: float,
    first_token_timeout: float,
    stall_timeout: float | None = None,
    max_duration: float | None = None,
    log_path: Path | None = None,
    extra_headers: dict[str, str] | None = None,
) -> StreamResult:
    started_at = time.monotonic()
    hard_deadline = started_at + hard_timeout
    header_timeout = max(1.0, min(first_token_timeout, hard_timeout))
    try:
        connection, response = open_stream_request(url, payload, timeout=header_timeout, extra_headers=extra_headers)
    except socket.timeout as exc:
        raise StepTimeout("timeout", "Timed out waiting for streaming response headers") from exc
    except TimeoutError as exc:
        raise StepTimeout("timeout", "Timed out waiting for streaming response headers") from exc
    except OSError as exc:
        raise BenchmarkError("stream-open-error", str(exc)) from exc

    if response.status >= 400:
        body = response.read()
        connection.close()
        raise ApiResponseError(
            response.status,
            "Streaming request failed",
            body.decode("utf-8", errors="replace"),
            details={"headers": {key.lower(): value for key, value in response.getheaders()}},
        )

    event_lines: list[str] = []
    raw_events: list[dict[str, Any]] = []
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    answer_parts: list[str] = []
    usage: dict[str, Any] | None = None
    finish_reason: str | None = None
    ttft_seconds: float | None = None
    last_token_at: float | None = None
    first_answer_seconds: float | None = None
    seen_think_close = False
    stream_finished = False

    def snapshot_stream_result() -> dict[str, Any]:
        text = "".join(text_parts)
        reasoning_text, answer_text = split_reasoning_output("".join(reasoning_parts), "".join(answer_parts), text)
        usage_tokens = int(usage["completion_tokens"]) if usage and isinstance(usage.get("completion_tokens"), int) else None
        tokens_generated, reasoning_tokens_generated, answer_tokens_generated, method = split_completion_tokens(
            usage_tokens,
            reasoning_text,
            answer_text,
            text,
        )
        return {
            "text": text,
            "reasoningText": reasoning_text,
            "answerText": answer_text,
            "ttftSeconds": round(ttft_seconds, 3) if ttft_seconds is not None else None,
            "totalSeconds": round(time.monotonic() - started_at, 3),
            "tokensGenerated": tokens_generated,
            "reasoningTokensGenerated": reasoning_tokens_generated,
            "answerTokensGenerated": answer_tokens_generated,
            "tokenCountMethod": method,
            "finishReason": finish_reason,
            "usage": usage,
            "firstAnswerSeconds": round(first_answer_seconds, 3) if first_answer_seconds is not None else None,
        }

    def consume_event(payload_text: str) -> None:
        nonlocal usage, ttft_seconds, last_token_at, finish_reason, first_answer_seconds, seen_think_close
        payload_text = payload_text.strip()
        if not payload_text:
            return
        if payload_text == "[DONE]":
            raise StopIteration
        try:
            event = json.loads(payload_text)
        except json.JSONDecodeError:
            raw_events.append({"raw": payload_text[:JSON_CAPTURE_LIMIT]})
            return
        if not isinstance(event, dict):
            raw_events.append({"json": event})
            return
        raw_events.append(event)
        if usage is None:
            usage = extract_usage(event)
        delta_text = extract_delta_text(event)
        reasoning_delta, answer_delta = extract_delta_segments(event)
        if reasoning_delta:
            reasoning_parts.append(reasoning_delta)
        if answer_delta:
            answer_parts.append(answer_delta)
            # Answer-phase start: first content token after reasoning ends. For
            # visible-<think> runs the scratchpad arrives as content, so the
            # answer phase only starts once </think> has streamed past.
            accumulated = "".join(answer_parts)
            if not seen_think_close and "</think>" in accumulated:
                seen_think_close = True
                first_answer_seconds = time.monotonic() - started_at
            elif first_answer_seconds is None and "<think>" not in accumulated:
                first_answer_seconds = time.monotonic() - started_at
        if delta_text:
            text_parts.append(delta_text)
            if ttft_seconds is None:
                ttft_seconds = time.monotonic() - started_at
            last_token_at = time.monotonic()
        choices = event.get("choices")
        if isinstance(choices, list):
            for choice in choices:
                if isinstance(choice, dict) and choice.get("finish_reason"):
                    finish_reason = str(choice["finish_reason"])

    def feed_line(line: str) -> None:
        if log_path is not None:
            append_text(log_path, line)
        stripped = line.strip()
        if stripped and re.fullmatch(r"[0-9A-Fa-f]+", stripped):
            return
        if line in {"\n", "\r\n"}:
            if not event_lines:
                return
            payload_text = "\n".join(event_lines).strip()
            event_lines.clear()
            consume_event(payload_text)
            return
        if line.startswith(":"):
            return
        if line.startswith("data:"):
            event_lines.append(line[5:].lstrip().rstrip("\r\n"))
            return
        event_lines.append(line.strip())

    try:
        while not stream_finished:
            now = time.monotonic()
            if ttft_seconds is None and now >= started_at + first_token_timeout:
                raise StepTimeout("timeout", "No first token arrived before the deadline", details={"streamResult": snapshot_stream_result()})
            if max_duration is not None and now >= started_at + max_duration and last_token_at is not None:
                break
            if now >= hard_deadline:
                raise StepTimeout("timeout", "Streaming request exceeded the deadline", details={"streamResult": snapshot_stream_result()})
            if stall_timeout is not None and last_token_at is not None and now - last_token_at > stall_timeout:
                raise StreamStall("throughput-stall", "Stream stalled while waiting for additional tokens", details={"streamResult": snapshot_stream_result()})

            timeout_candidates = [hard_deadline - now, 2.0]
            if ttft_seconds is None:
                timeout_candidates.append((started_at + first_token_timeout) - now)
            elif stall_timeout is not None and last_token_at is not None:
                timeout_candidates.append((last_token_at + stall_timeout) - now)
            if max_duration is not None:
                timeout_candidates.append((started_at + max_duration) - now)
            read_timeout = max(0.1, min(candidate for candidate in timeout_candidates if candidate > 0))
            socket_obj = connection.sock
            if socket_obj is None:
                raw = getattr(getattr(response, "fp", None), "raw", None)
                socket_obj = getattr(raw, "_sock", None)
            if socket_obj is None:
                raise BenchmarkError(
                    "stream-read-error",
                    "Streaming response socket became unavailable before the body was consumed",
                    details={"streamResult": snapshot_stream_result()},
                )
            # Use socket timeout directly rather than select+blocking-read.
            # select.select checks the raw OS socket but http.client's
            # BufferedReader may have already consumed more than one line into
            # its Python-level buffer in a previous readline() call.  When
            # that happens the socket has no new bytes, select returns
            # not-readable, and we spin until hard_timeout fires even though
            # the next line (e.g. the blank-line SSE separator or [DONE]) is
            # already sitting in the buffer.  Setting a socket timeout lets
            # readline() drain buffered data immediately, and only blocks on
            # the OS socket when the buffer is empty.
            socket_obj.settimeout(read_timeout)
            try:
                raw_line = response.readline(65536)
            except (socket.timeout, TimeoutError):
                continue
            except OSError as exc:
                raise BenchmarkError("stream-read-error", str(exc), details={"streamResult": snapshot_stream_result()}) from exc
            if not raw_line:
                break
            try:
                feed_line(raw_line.decode("utf-8", errors="replace"))
            except StopIteration:
                stream_finished = True
                break
        if event_lines:
            try:
                consume_event("\n".join(event_lines))
            except StopIteration:
                pass
    finally:
        try:
            connection.close()
        except Exception:
            pass

    if ttft_seconds is None and not text_parts:
        raise BenchmarkError(
            "empty-stream",
            "Streaming response ended before any text tokens were received",
            details={"streamResult": snapshot_stream_result()},
        )

    snapshot = snapshot_stream_result()
    return StreamResult(
        text=str(snapshot["text"]),
        reasoning_text=str(snapshot["reasoningText"]),
        answer_text=str(snapshot["answerText"]),
        ttft_seconds=ttft_seconds,
        total_seconds=time.monotonic() - started_at,
        usage=usage,
        token_count_method=str(snapshot["tokenCountMethod"]),
        tokens_generated=int(snapshot["tokensGenerated"]),
        reasoning_tokens_generated=int(snapshot["reasoningTokensGenerated"]),
        answer_tokens_generated=int(snapshot["answerTokensGenerated"]),
        finish_reason=finish_reason,
        raw_events=raw_events,
        first_answer_seconds=first_answer_seconds,
    )


def chat_completion_json(
    url: str,
    payload: dict[str, Any],
    *,
    timeout: float,
    extra_headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    status, headers, body = http_request_json("POST", url, payload=payload, timeout=timeout, extra_headers=extra_headers)
    text = body.decode("utf-8", errors="replace")
    if status >= 400:
        raise ApiResponseError(status, "Chat completion failed", text, details={"headers": headers})
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise BenchmarkError("invalid-json", f"Invalid JSON from chat completion: {exc}") from exc
    if not isinstance(parsed, dict):
        raise BenchmarkError("invalid-json", "Unexpected JSON payload from chat completion")
    return parsed


def prime_factorize(n: int) -> list[int]:
    factors: list[int] = []
    candidate = 2
    remainder = n
    while candidate * candidate <= remainder:
        while remainder % candidate == 0:
            factors.append(candidate)
            remainder //= candidate
        candidate = 3 if candidate == 2 else candidate + 2
    if remainder > 1:
        factors.append(remainder)
    return factors


def execute_tool_call(tool_call: dict[str, Any]) -> dict[str, Any]:
    function = tool_call.get("function")
    if not isinstance(function, dict):
        raise BenchmarkError("tool-call-error", f"Malformed tool call: {tool_call!r}")
    name = str(function.get("name") or "")
    try:
        arguments = json.loads(str(function.get("arguments") or "{}"))
    except json.JSONDecodeError as exc:
        raise BenchmarkError("tool-call-error", f"Invalid tool arguments for {name}: {exc}") from exc
    if name == "multiply":
        a = int(arguments["a"])
        b = int(arguments["b"])
        return {"result": a * b}
    if name == "prime_factorize":
        n = int(arguments["n"])
        if n < 2:
            raise BenchmarkError("tool-call-error", "prime_factorize requires n >= 2")
        return {"result": prime_factorize(n)}
    raise BenchmarkError("tool-call-error", f"Unknown tool name {name!r}")


def looks_like_tool_unsupported(error_text: str) -> bool:
    lowered = error_text.lower()
    patterns = [
        "tool",
        "function",
        "unsupported",
        "unknown field",
        "unexpected field",
        "not allowed",
        "extra inputs are not permitted",
        "messages.0.tool_calls",
        "tools",
    ]
    return any(pattern in lowered for pattern in patterns) and (
        "unsupported" in lowered
        or "unknown" in lowered
        or "not supported" in lowered
        or "extra inputs" in lowered
        or "tool" in lowered
    )


def analyze_agentic_output(text: str) -> dict[str, Any]:
    normalized_text = re.sub(r"(?<=\d),(?=\d)", "", text)
    lowered = normalized_text.lower()
    math_correct = re.search(rf"\b{EXPECTED_PRODUCT}\b", normalized_text) is not None
    factors_present = all(re.search(rf"\b{factor}\b", normalized_text) for factor in EXPECTED_FACTORS)
    has_factor_language = "prime factor" in lowered or "factors" in lowered
    example_like = len(normalized_text.split()) >= 35 and (
        "example" in lowered or "real-world" in lowered or text.count(".") >= 2 or "\n" in text
    )
    complete = math_correct and factors_present and has_factor_language and example_like
    return {
        "mathCorrect": bool(math_correct and factors_present),
        "complete": complete,
        "textLength": len(text),
    }


def derive_overall_status(
    benchmarks: dict[str, Any],
    errors: list[dict[str, Any]] | None = None,
    timestamps: dict[str, Any] | None = None,
) -> str:
    required_stages = {"loadTime", "basicResponse", "agentic", "quality", "throughput"}
    stopped = bool((timestamps or {}).get("stopped"))
    statuses: list[str] = []
    for value in benchmarks.values():
        if isinstance(value, dict) and value.get("status"):
            statuses.append(str(value["status"]))
    if errors:
        error_stages = {str(error.get("stage") or "") for error in errors if isinstance(error, dict)}
        if error_stages:
            non_partial_stages = error_stages - {"throughput"}
            if non_partial_stages:
                return "fail"
            if statuses and all(status == "pass" for status in statuses):
                return "partial"
    if not statuses:
        return "pending"
    if any(status == "fail" for status in statuses):
        return "fail"
    if not required_stages.issubset(set(benchmarks.keys())):
        return "pending" if stopped else "running"
    if any(status in {"partial", "not-applicable"} for status in statuses):
        return "partial"
    if all(status == "pass" for status in statuses):
        return "pass"
    return "partial"


def median_index(values: list[float]) -> int:
    """Index of the median element (upper median for an even count)."""
    order = sorted(range(len(values)), key=lambda index: values[index])
    return order[len(order) // 2]


def aggregate_throughput_samples(
    samples: list["StreamResult"],
    *,
    status: str,
    elapsed_cap: float | None = None,
    error_code: str | None = None,
) -> dict[str, Any]:
    """Metrics of the median sample, plus every sample and the spread.

    `tokensPerSecond` stays the headline field the dashboard reads; it is now
    the median over the repeats instead of a single shot.
    """
    if not samples:
        raise ValueError("aggregate_throughput_samples needs at least one sample")
    per_sample = [
        stream_result_to_benchmark_metrics(sample, status=status, elapsed_cap=elapsed_cap, error_code=error_code)
        for sample in samples
    ]
    rates = [float(entry.get("tokensPerSecond") or 0.0) for entry in per_sample]
    chosen = median_index(rates)
    payload = dict(per_sample[chosen])
    payload["repeats"] = len(samples)
    payload["sampleIndex"] = chosen
    payload["samples"] = [
        {
            "tokensPerSecond": entry.get("tokensPerSecond"),
            "answerTokensPerSecond": entry.get("answerTokensPerSecond"),
            "totalTokensGenerated": entry.get("totalTokensGenerated"),
            "elapsedSeconds": entry.get("elapsedSeconds"),
            "completed": entry.get("completed"),
        }
        for entry in per_sample
    ]
    payload["tokensPerSecondMedian"] = rates[chosen]
    payload["tokensPerSecondMin"] = min(rates)
    payload["tokensPerSecondMax"] = max(rates)
    median = rates[chosen]
    payload["tokensPerSecondSpreadPct"] = round((max(rates) - min(rates)) / median * 100, 1) if median > 0 else None
    return payload


def stream_result_to_benchmark_metrics(
    result: StreamResult,
    *,
    status: str,
    elapsed_cap: float | None = None,
    error_code: str | None = None,
) -> dict[str, Any]:
    elapsed = result.total_seconds
    if elapsed_cap is not None:
        elapsed = min(elapsed_cap, elapsed)
    # Decode rate is measured over the generation window only (TTFT excluded);
    # the previous formula divided by total elapsed, which punished short runs
    # (grammar-constrained variants) for their fixed startup cost.
    decode_window = result.total_seconds
    if result.ttft_seconds is not None:
        decode_window = max(result.total_seconds - result.ttft_seconds, 0.0)
    answer_window = None
    if result.first_answer_seconds is not None:
        answer_window = max(result.total_seconds - result.first_answer_seconds, 0.0)
    payload: dict[str, Any] = {
        "totalTokensGenerated": result.tokens_generated,
        "reasoningTokensGenerated": result.reasoning_tokens_generated,
        "answerTokensGenerated": result.answer_tokens_generated,
        "elapsedSeconds": round(elapsed, 3),
        "tokensPerSecond": round(result.tokens_generated / decode_window, 3) if decode_window > 0 else 0.0,
        # Effective answer throughput: answer tokens over the whole run. This is
        # the "how long until I actually have an answer" metric — thinking time
        # counts against it by design.
        "answerTokensPerSecond": round(result.answer_tokens_generated / result.total_seconds, 3) if result.total_seconds > 0 else 0.0,
        # Pure answer-phase decode rate (thinking window excluded), when an
        # answer phase was observed.
        "answerPhaseTokensPerSecond": (
            round(result.answer_tokens_generated / answer_window, 3)
            if answer_window is not None and answer_window > 0 and result.answer_tokens_generated > 0
            else None
        ),
        "firstAnswerSeconds": round(result.first_answer_seconds, 3) if result.first_answer_seconds is not None else None,
        "completed": result.finish_reason == "stop",
        "totalResponseTimeSeconds": round(result.total_seconds, 3),
        "tokenCountMethod": result.token_count_method,
        "responseText": (result.answer_text or result.text)[:500],
        "status": status,
    }
    if result.reasoning_text:
        payload["reasoningPreview"] = result.reasoning_text[:500]
    if result.ttft_seconds is not None:
        payload["ttftSeconds"] = round(result.ttft_seconds, 3)
    if result.finish_reason:
        payload["finishReason"] = result.finish_reason
    if error_code:
        payload["errorCode"] = error_code
    return payload


def stream_result_from_details(details: Any) -> StreamResult | None:
    if not isinstance(details, dict):
        return None
    payload = details.get("streamResult")
    if not isinstance(payload, dict):
        return None
    text = payload.get("text")
    reasoning_text = payload.get("reasoningText")
    answer_text = payload.get("answerText")
    token_count_method = payload.get("tokenCountMethod")
    tokens_generated = payload.get("tokensGenerated")
    reasoning_tokens_generated = payload.get("reasoningTokensGenerated")
    answer_tokens_generated = payload.get("answerTokensGenerated")
    total_seconds = payload.get("totalSeconds")
    if not isinstance(text, str):
        return None
    if reasoning_text is not None and not isinstance(reasoning_text, str):
        return None
    if answer_text is not None and not isinstance(answer_text, str):
        return None
    if not isinstance(token_count_method, str):
        return None
    if not isinstance(tokens_generated, int):
        return None
    if reasoning_tokens_generated is not None and not isinstance(reasoning_tokens_generated, int):
        return None
    if answer_tokens_generated is not None and not isinstance(answer_tokens_generated, int):
        return None
    if not isinstance(total_seconds, (int, float)):
        return None
    ttft = payload.get("ttftSeconds")
    finish_reason = payload.get("finishReason")
    usage = payload.get("usage")
    first_answer = payload.get("firstAnswerSeconds")
    return StreamResult(
        text=text,
        reasoning_text=reasoning_text or "",
        answer_text=answer_text or text,
        ttft_seconds=float(ttft) if isinstance(ttft, (int, float)) else None,
        total_seconds=float(total_seconds),
        usage=usage if isinstance(usage, dict) else None,
        token_count_method=token_count_method,
        tokens_generated=tokens_generated,
        reasoning_tokens_generated=reasoning_tokens_generated or 0,
        answer_tokens_generated=answer_tokens_generated if isinstance(answer_tokens_generated, int) else tokens_generated,
        finish_reason=str(finish_reason) if isinstance(finish_reason, str) else None,
        raw_events=[],
        first_answer_seconds=float(first_answer) if isinstance(first_answer, (int, float)) else None,
    )


class BenchmarkRunner:
    def __init__(self, config: RunnerConfig, slots: list[Slot]) -> None:
        self.config = config
        self.slots = slots
        self.current_model: ModelSpec | None = None
        self.current_slot: Slot | None = None
        self.interrupted = False
        self._quality_cache: dict[tuple[str, str], dict[str, Any]] = {}
        # Keyed by (path, launcher, thinking bucket): the Hebrew translation is
        # the one quality task whose result depends on thinking, so it is
        # evaluated twice per model+launcher instead of once.
        self._translation_cache: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._install_signal_handlers()

    def _install_signal_handlers(self) -> None:
        def handler(signum: int, _frame: Any) -> None:
            self.interrupted = True
            signame = signal.Signals(signum).name
            print(f"\nReceived {signame}; stopping current benchmark cleanly...", file=sys.stderr)
            if self.current_slot is not None:
                try:
                    self.cleanup_slot(self.current_slot)
                except Exception:
                    traceback.print_exc()
            raise InterruptRequested(130)

        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, handler)

    def launcher_for_runtime(self, runtime: str) -> Path:
        if runtime == "gguf":
            return GGUF_LAUNCHER
        if runtime == "gguf-tq3":
            return GGUF_TQ3_LAUNCHER
        if runtime == "beellama":
            return BEELLAMA_LAUNCHER
        if runtime == "mlx":
            return MLX_LAUNCHER
        if runtime == "rapid-mlx":
            return RAPID_MLX_LAUNCHER
        if runtime == "mtplx":
            return MTPLX_LAUNCHER
        if runtime == "dflash":
            return DFLASH_LAUNCHER
        raise ValueError(f"Unknown runtime {runtime!r}")

    def stop_runtime(self, runtime: str, slot: Slot) -> subprocess.CompletedProcess[str] | None:
        launcher = self.launcher_for_runtime(runtime)
        if not launcher.exists():
            return None
        return run_subprocess([str(launcher), "--slot", slot.name, "--stop"], timeout=STOP_GRACE_SECONDS, check=False)

    def listener_pids(self, port: int) -> list[int]:
        """PIDs listening on a port, via netstat with lsof as the fallback.

        lsof walks every open descriptor on the box, so one stalled network
        mount makes it hang — llm3's own /api/status hit exactly this and moved
        to netstat. Here a hang means the 10s timeout elapses, no PID comes
        back, and the previous model's server keeps the port while the next
        model tries to bind it.
        """
        pids: list[int] = []
        try:
            result = run_subprocess(["netstat", "-anv", "-p", "tcp"], timeout=10, check=False)
            for line in (result.stdout or "").splitlines():
                # tcp4  0  0  *.8036  *.*  LISTEN  0  0  131072  131072  Python:55096  ...
                fields = line.split()
                if len(fields) < 11 or fields[5] != "LISTEN":
                    continue
                local_address = fields[3]
                owner = fields[10]
                try:
                    listen_port = int(local_address[local_address.rfind(".") + 1:])
                    owner_pid = int(owner[owner.rfind(":") + 1:])
                except ValueError:
                    continue
                if listen_port == port and owner_pid > 1:
                    pids.append(owner_pid)
        except Exception:
            pids = []

        if pids:
            return sorted(set(pids))

        try:
            result = run_subprocess(
                ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                timeout=10,
                check=False,
            )
        except Exception:
            return []
        for line in (result.stdout or "").splitlines():
            line = line.strip()
            if line.isdigit():
                pids.append(int(line))
        return sorted(set(pids))

    def terminate_pid(self, pid: int) -> None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + LISTENER_KILL_GRACE_SECONDS
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.5)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            return

    def cleanup_slot(self, slot: Slot, log_path: Path | None = None) -> None:
        for runtime in ("gguf", "gguf-tq3", "beellama", "mlx", "rapid-mlx", "mtplx", "dflash"):
            started_at = time.monotonic()
            try:
                result = self.stop_runtime(runtime, slot)
                if result is not None and log_path is not None:
                    append_text(log_path, subprocess_log_blob([str(self.launcher_for_runtime(runtime)), "--slot", slot.name, "--stop"], result, started_at))
            except subprocess.TimeoutExpired as exc:
                if log_path is not None:
                    append_text(log_path, subprocess_log_blob([str(self.launcher_for_runtime(runtime)), "--slot", slot.name, "--stop"], exc, started_at))

        deadline = time.monotonic() + LISTENER_KILL_GRACE_SECONDS
        while True:
            extra_pids: set[int] = set()
            for port in slot.all_ports():
                extra_pids.update(self.listener_pids(port))
            if not extra_pids:
                return
            for pid in sorted(extra_pids):
                self.terminate_pid(pid)
                if log_path is not None:
                    append_text(log_path, f"[{iso_now()}] force-stopped listener PID {pid}\n")
            if time.monotonic() >= deadline:
                return
            time.sleep(0.5)

    def launch_model_server(
        self,
        model: ModelSpec,
        slot: Slot,
        log_path: Path,
        *,
        thinking: bool,
        enable_tiny_grammar: bool,
        label: str,
    ) -> tuple[str, float]:
        launch_command = model.launch_command(
            slot,
            self.config.context_size,
            self.config.parallel,
            thinking,
            enable_tiny_grammar,
        )
        launch_started = time.monotonic()
        stale_pids: set[int] = set()
        for port in slot.all_ports():
            stale_pids.update(self.listener_pids(port))
        for pid in sorted(stale_pids):
            self.terminate_pid(pid)
            append_text(log_path, f"[{iso_now()}] force-stopped stale listener PID {pid} before launch\n")

        append_text(log_path, f"[{iso_now()}] launching {label}: {' '.join(shlex.quote(part) for part in launch_command)}\n")
        try:
            launch_result = run_subprocess(launch_command, timeout=self.config.load_timeout, check=False)
            append_text(log_path, subprocess_log_blob(launch_command, launch_result, launch_started))
        except subprocess.TimeoutExpired as exc:
            append_text(log_path, subprocess_log_blob(launch_command, exc, launch_started))
            raise StepTimeout("load-timeout", f"{label} launch exceeded the load timeout") from exc

        if launch_result.returncode != 0:
            body = (launch_result.stderr or launch_result.stdout or "").strip()
            error_code = "load-timeout" if "timed out waiting" in body.lower() else "launch-failed"
            raise BenchmarkError(error_code, body or f"{label} launch failed")

        health_payload = wait_for_health(
            slot.public_port,
            launch_started + self.config.load_timeout,
            extra_headers=runtime_request_headers(model.launcher),
        )
        load_elapsed = time.monotonic() - launch_started
        return choose_model_id(health_payload, model.key), load_elapsed

    def effective_thinking(self, model: ModelSpec) -> bool:
        if model.variant:
            return model.variant != "no-think"
        return bool(self.config.thinking and model.supports_thinking_toggle())

    def effective_grammar(self, model: ModelSpec) -> tuple[bool, bool]:
        """Return (tiny_grammar, structured_gbnf) for the throughput stage."""
        if model.variant:
            return model.variant == "think-tiny", model.variant == "think-gbnf"
        return bool(self.config.enable_tiny_grammar and model.supports_tiny_grammar()), False

    def initial_benchmark_payload(self, model: ModelSpec, slot: Slot, result_dir: Path) -> dict[str, Any]:
        effective_tiny_grammar, effective_structured_gbnf = self.effective_grammar(model)
        effective_thinking = self.effective_thinking(model)
        payload = model.metadata(slot)
        payload.update(
            {
                "variant": model.variant,
                "schemaVersion": SCHEMA_VERSION,
                "runner": dict(RUNNER_PROVENANCE),
                "host": dict(HOST_PROVENANCE),
                "environment": environment_snapshot(),
                "launchConfig": {
                    "contextSize": self.config.context_size,
                    "parallel": self.config.parallel,
                    "loadTimeout": self.config.load_timeout,
                    "globalTimeout": self.config.global_timeout,
                    "throughputWindow": self.config.throughput_window,
                    "throughputStallTimeout": self.config.throughput_stall_timeout,
                    "throughputRepeats": self.config.throughput_repeats,
                    "throughputWarmup": self.config.throughput_warmup,
                    "sampling": json.loads(json.dumps(SAMPLING_PROFILE)),
                    "selectedSlot": self.config.selected_slot,
                    "thinkingRequested": self.config.thinking,
                    "tinyGrammarRequested": self.config.enable_tiny_grammar,
                    "simpleThinkingVariantsRequested": self.config.simple_thinking_variants,
                    "thinkingVariantsRequested": self.config.thinking_variants,
                    "thinkingApplied": effective_thinking,
                    "tinyGrammarApplied": effective_tiny_grammar,
                    "structuredGbnfApplied": effective_structured_gbnf,
                    "variant": model.variant,
                    "tinyGrammarScope": "throughput",
                    "throughputVisibleThink": effective_tiny_grammar or effective_structured_gbnf,
                    "throughputScenario": THROUGHPUT_SCENARIO,
                    "throughputMetric": "tokensPerSecond",
                    "answerThroughputMetric": "answerTokensPerSecond",
                },
                "benchmarks": {},
                "errors": [],
                "timestamps": {"started": iso_now()},
                "overallStatus": "pending",
                "resultDir": str(result_dir),
            }
        )
        return payload

    def save_benchmark(self, path: Path, payload: dict[str, Any]) -> None:
        payload["overallStatus"] = derive_overall_status(
            payload.get("benchmarks", {}),
            payload.get("errors"),
            payload.get("timestamps"),
        )
        atomic_write_json(path, payload)

    def record_error(self, benchmark: dict[str, Any], stage: str, code: str, message: str, *, details: Any | None = None) -> None:
        benchmark.setdefault("errors", []).append(
            {
                "stage": stage,
                "code": code,
                "message": message,
                "details": details,
                "timestamp": iso_now(),
            }
        )

    def should_skip(self, benchmark_path: Path) -> bool:
        if self.config.force or not benchmark_path.is_file():
            return False
        payload = load_json_file(benchmark_path)
        overall = str(payload.get("overallStatus") or "")
        return overall in {"pass", "partial", "fail"}

    def run(self, models: list[ModelSpec], inventory_models: list[ModelSpec]) -> int:
        self.config.results_dir.mkdir(parents=True, exist_ok=True)
        completed_payloads: list[dict[str, Any]] = []
        exit_code = 0

        for index, model in enumerate(models):
            slot = self.slots[index % len(self.slots)]
            result_dir = self.config.results_dir / model.result_dir_name
            benchmark_path = result_dir / "benchmark.json"
            metadata_path = result_dir / "metadata.json"

            if self.should_skip(benchmark_path):
                payload = load_json_file(benchmark_path)
                if payload:
                    completed_payloads.append(payload)
                print(f"Skipping {model.label} ({model.runtime}); benchmark.json already exists.")
                continue

            print(f"[{index + 1}/{len(models)}] Benchmarking {model.label} [{model.runtime}] on {slot.name}")

            result_dir.mkdir(parents=True, exist_ok=True)
            atomic_write_json(metadata_path, model.metadata(slot))
            benchmark = self.initial_benchmark_payload(model, slot, result_dir)
            self.save_benchmark(benchmark_path, benchmark)

            if self.config.dry_run:
                continue

            self.current_model = model
            self.current_slot = slot
            try:
                self.run_one_model(model, slot, result_dir, benchmark, benchmark_path)
            except InterruptRequested as exc:
                benchmark["timestamps"]["stopped"] = iso_now()
                self.save_benchmark(benchmark_path, benchmark)
                # The tab reads SUMMARY.md, so without this a cancelled run
                # showed nothing for the models it had already finished.
                self.write_summary_safely(inventory_models)
                raise exc
            except Exception as exc:
                self.record_error(benchmark, "model", "generic-error", str(exc), details=traceback.format_exc(limit=10))
                benchmark["timestamps"]["stopped"] = iso_now()
                self.save_benchmark(benchmark_path, benchmark)
                exit_code = 1
            finally:
                self.current_model = None
                self.current_slot = None

            completed_payloads.append(load_json_file(benchmark_path))

            # Refresh after every model instead of only at the end: a run that
            # dies (or is cancelled) on model 12 of 17 used to leave the tab
            # showing nothing at all from the hours it had already spent.
            if not self.config.dry_run:
                self.write_summary_safely(inventory_models)

        if not self.config.dry_run:
            self.write_summary_safely(inventory_models)
        return exit_code

    def write_summary_safely(self, models: list[ModelSpec]) -> None:
        """Never let a summary-rendering failure destroy a finished run."""
        try:
            self.write_summary(models)
        except Exception:
            print("Failed to write SUMMARY.md:", file=sys.stderr)
            traceback.print_exc()

    def run_one_model(
        self,
        model: ModelSpec,
        slot: Slot,
        result_dir: Path,
        benchmark: dict[str, Any],
        benchmark_path: Path,
    ) -> None:
        load_log = result_dir / "load_time.log"
        basic_log = result_dir / "basic_response.log"
        throughput_log = result_dir / "throughput.log"
        agentic_log = result_dir / "agentic.log"
        stop_log = result_dir / "stop.log"
        quality_log = result_dir / "quality.log"

        for stage_log in (load_log, basic_log, throughput_log, agentic_log, quality_log, stop_log):
            try:
                stage_log.write_text("", encoding="utf-8")
            except OSError:
                pass

        self.cleanup_slot(slot, load_log)

        try:
            model_id, load_elapsed = self.launch_model_server(
                model,
                slot,
                load_log,
                thinking=self.effective_thinking(model),
                enable_tiny_grammar=False,
                label="initial",
            )
        except StepTimeout as exc:
            self.record_error(benchmark, "loadTime", "load-timeout", str(exc))
            benchmark["benchmarks"]["loadTime"] = {
                "seconds": round(self.config.load_timeout, 3),
                "status": "fail",
            }
            self.cleanup_slot(slot, stop_log)
            benchmark["timestamps"]["stopped"] = iso_now()
            self.save_benchmark(benchmark_path, benchmark)
            return
        except BenchmarkError as exc:
            error_code = "load-timeout" if exc.code == "load-timeout" else "generic-error"
            self.record_error(benchmark, "loadTime", error_code, str(exc))
            benchmark["benchmarks"]["loadTime"] = {
                "seconds": round(self.config.load_timeout, 3),
                "status": "fail",
            }
            self.cleanup_slot(slot, stop_log)
            benchmark["timestamps"]["stopped"] = iso_now()
            self.save_benchmark(benchmark_path, benchmark)
            return
        benchmark["benchmarks"]["loadTime"] = {
            "seconds": round(load_elapsed, 3),
            "status": "pass",
        }
        benchmark["engine"] = probe_engine(slot.public_port)
        benchmark["timestamps"]["loadComplete"] = iso_now()
        self.save_benchmark(benchmark_path, benchmark)

        basic_payload = {
            "model": model_id,
            "messages": [{"role": "user", "content": BASIC_PROMPT}],
            "temperature": 0.7,
            "max_tokens": 256,
            "seed": BENCHMARK_SEED,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        request_headers = runtime_request_headers(model.launcher)
        append_text(basic_log, json.dumps({"request": basic_payload}, indent=2) + "\n\n")
        try:
            basic_result = stream_chat_completion(
                f"http://127.0.0.1:{slot.public_port}/v1/chat/completions",
                basic_payload,
                hard_timeout=self.config.global_timeout,
                first_token_timeout=self.config.global_timeout,
                log_path=basic_log,
                extra_headers=request_headers,
            )
            benchmark["benchmarks"]["basicResponse"] = {
                "ttftSeconds": round(basic_result.ttft_seconds or 0.0, 3),
                "totalResponseSeconds": round(basic_result.total_seconds, 3),
                "tokensGenerated": basic_result.tokens_generated,
                "tokenCountMethod": basic_result.token_count_method,
                "responseText": basic_result.text[:500],
                "finishReason": basic_result.finish_reason,
                "status": "pass",
            }
            benchmark["timestamps"]["basicResponseComplete"] = iso_now()
        except BenchmarkError as exc:
            self.record_error(benchmark, "basicResponse", "basic-response-timeout" if isinstance(exc, StepTimeout) else exc.code, str(exc), details=exc.details)
            benchmark["benchmarks"]["basicResponse"] = {"status": "fail"}
            self.cleanup_slot(slot, stop_log)
            benchmark["timestamps"]["stopped"] = iso_now()
            self.save_benchmark(benchmark_path, benchmark)
            return
        self.save_benchmark(benchmark_path, benchmark)

        append_text(agentic_log, json.dumps({"requestPrompt": AGENTIC_PROMPT, "tools": TOOLS_PAYLOAD}, indent=2) + "\n\n")
        try:
            agentic_result = self.run_agentic_step(slot, model_id, agentic_log, request_headers=request_headers)
            benchmark["benchmarks"]["agentic"] = agentic_result
        except BenchmarkError as exc:
            self.record_error(benchmark, "agentic", "agentic-timeout" if isinstance(exc, StepTimeout) else exc.code, str(exc), details=exc.details)
            benchmark["benchmarks"]["agentic"] = {"status": "fail", "result": "fail"}
        benchmark["timestamps"]["agenticComplete"] = iso_now()
        self.save_benchmark(benchmark_path, benchmark)

        # Quality is cached per thinking bucket, not per model: the think and
        # no-think runs measure different behaviour, and sharing one across both
        # is what left the smartness column unable to show whether thinking
        # helps. Within a bucket the grammar variants (think-tiny, think-gbnf)
        # still reuse the plain think result — same reasoning path, different
        # output constraint.
        quality_bucket = translation_bucket_for_variant(getattr(model, "variant", ""))
        quality_cache_key = (model.path, model.launcher, quality_bucket)
        cached_quality = self._quality_cache.get(quality_cache_key)
        if cached_quality is not None:
            shared_quality = json.loads(json.dumps(cached_quality))
            shared_quality["sharedAcrossVariants"] = True
            benchmark["benchmarks"]["quality"] = shared_quality
            append_text(quality_log, f"[{iso_now()}] Reusing quality scores from an earlier {quality_bucket} variant of this model+launcher.\n")
        else:
            try:
                quality_result = self.run_quality_step(
                    slot,
                    model_id,
                    quality_log,
                    thinking=(quality_bucket == "think"),
                    request_headers=request_headers,
                )
                benchmark["benchmarks"]["quality"] = quality_result
                if quality_result.get("status") == "pass":
                    self._quality_cache[quality_cache_key] = quality_result
            except BenchmarkError as exc:
                self.record_error(benchmark, "quality", "quality-error" if isinstance(exc, StepTimeout) else exc.code, str(exc), details=exc.details)
                benchmark["benchmarks"]["quality"] = {"status": "fail"}

        # The Hebrew translation is thinking-dependent, so it is cached per
        # thinking bucket rather than shared across all variants. The grammar
        # variants map onto the "think" bucket and reuse its result: they force
        # ASCII-only output and cannot produce Hebrew at all.
        bucket = quality_bucket
        translation_cache_key = (model.path, model.launcher, bucket)
        translation_enabled = "translation" in tuple(
            getattr(self.config, "quality_metrics", DEFAULT_QUALITY_METRICS) or DEFAULT_QUALITY_METRICS
        )
        translation_artifact = self._translation_cache.get(translation_cache_key)
        if not translation_enabled:
            translation_artifact = None
        elif translation_artifact is None:
            translation_artifact = self.run_translation_step(
                slot,
                model_id,
                quality_log,
                thinking=(bucket == "think"),
                request_headers=request_headers,
            )
            if translation_artifact is not None:
                self._translation_cache[translation_cache_key] = translation_artifact
        else:
            append_text(quality_log, f"[{iso_now()}] Reusing the {bucket} Hebrew translation from an earlier variant of this model+launcher.\n")
        quality_payload = benchmark["benchmarks"].get("quality")
        if isinstance(quality_payload, dict) and translation_enabled:
            attach_translation_result(quality_payload, translation_artifact)
        benchmark["timestamps"]["qualityComplete"] = iso_now()
        self.save_benchmark(benchmark_path, benchmark)

        use_tiny_grammar, use_structured_gbnf = self.effective_grammar(model)
        throughput_visible_think = model.runtime == "gguf" and (use_tiny_grammar or use_structured_gbnf)
        throughput_grammar_text: str | None = None
        if use_tiny_grammar or use_structured_gbnf:
            try:
                throughput_grammar_text = read_structured_gbnf() if use_structured_gbnf else read_tiny_grammar()
            except OSError as exc:
                grammar_error_code = "structured-gbnf-read-failed" if use_structured_gbnf else "tiny-grammar-read-failed"
                self.record_error(benchmark, "throughput", grammar_error_code, str(exc))
                benchmark["benchmarks"]["throughput"] = {"status": "partial", "errorCode": grammar_error_code}
                benchmark["timestamps"]["throughputComplete"] = iso_now()
                self.cleanup_slot(slot, stop_log)
                benchmark["timestamps"]["stopped"] = iso_now()
                self.save_benchmark(benchmark_path, benchmark)
                return
        throughput_model_id = model_id
        if throughput_visible_think:
            self.cleanup_slot(slot, throughput_log)
            try:
                throughput_model_id, _ = self.launch_model_server(
                    model,
                    slot,
                    throughput_log,
                    thinking=False,
                    enable_tiny_grammar=False,
                    label="throughput",
                )
            except StepTimeout as exc:
                self.record_error(benchmark, "throughput", "throughput-launch-timeout", str(exc))
                benchmark["benchmarks"]["throughput"] = {"status": "partial", "errorCode": "throughput-launch-timeout"}
                benchmark["timestamps"]["throughputComplete"] = iso_now()
                self.cleanup_slot(slot, stop_log)
                benchmark["timestamps"]["stopped"] = iso_now()
                self.save_benchmark(benchmark_path, benchmark)
                return
            except BenchmarkError as exc:
                self.record_error(benchmark, "throughput", exc.code, str(exc))
                benchmark["benchmarks"]["throughput"] = {"status": "partial", "errorCode": exc.code}
                benchmark["timestamps"]["throughputComplete"] = iso_now()
                self.cleanup_slot(slot, stop_log)
                benchmark["timestamps"]["stopped"] = iso_now()
                self.save_benchmark(benchmark_path, benchmark)
                return

        throughput_payload = build_throughput_payload(
            throughput_model_id,
            visible_think=throughput_visible_think,
            grammar_text=throughput_grammar_text,
        )
        append_text(throughput_log, json.dumps({"request": throughput_payload}, indent=2) + "\n\n")
        throughput_url = f"http://127.0.0.1:{slot.public_port}/v1/chat/completions"
        samples: list[StreamResult] = []
        failure: tuple[str, BenchmarkError] | None = None
        warmups_done = 0
        for _ in range(max(0, self.config.throughput_warmup)):
            # Discarded: the first generation after a load pays for cold caches
            # and lazy allocation, which would otherwise land on sample one.
            append_text(throughput_log, "--- warm-up (discarded) ---\n")
            try:
                stream_chat_completion(
                    throughput_url,
                    {**throughput_payload, "max_tokens": 64, "cache_prompt": False},
                    hard_timeout=self.config.throughput_window,
                    first_token_timeout=self.config.throughput_window,
                    stall_timeout=self.config.throughput_stall_timeout,
                    max_duration=self.config.throughput_window,
                    log_path=throughput_log,
                    extra_headers=request_headers,
                )
                warmups_done += 1
            except BenchmarkError as exc:
                # A warm-up failure is not a row failure; the timed requests
                # below will record the real error if the model is broken.
                append_text(throughput_log, f"warm-up failed ({exc.code}); continuing\n")
                break
        for attempt in range(max(1, self.config.throughput_repeats)):
            attempt_payload = dict(throughput_payload)
            if attempt > 0:
                # The first request already primed the prompt cache; a repeat
                # must measure decode, not a cached prefix plus decode.
                attempt_payload["cache_prompt"] = False
                append_text(throughput_log, f"--- repeat {attempt + 1} ---\n")
            try:
                samples.append(stream_chat_completion(
                    throughput_url,
                    attempt_payload,
                    hard_timeout=self.config.throughput_window,
                    first_token_timeout=self.config.throughput_window,
                    stall_timeout=self.config.throughput_stall_timeout,
                    max_duration=self.config.throughput_window,
                    log_path=throughput_log,
                    extra_headers=request_headers,
                ))
            except StreamStall as exc:
                failure = ("throughput-stall", exc)
                break
            except StepTimeout as exc:
                failure = ("throughput-start-timeout", exc)
                break
            except BenchmarkError as exc:
                failure = (exc.code, exc)
                break
        if failure is None:
            benchmark["benchmarks"]["throughput"] = aggregate_throughput_samples(
                samples, status="pass", elapsed_cap=self.config.throughput_window,
            )
        else:
            code, exc = failure
            self.record_error(benchmark, "throughput", code, str(exc), details=exc.details)
            if samples:
                benchmark["benchmarks"]["throughput"] = aggregate_throughput_samples(
                    samples, status="partial", elapsed_cap=self.config.throughput_window, error_code=code,
                )
            else:
                partial_result = stream_result_from_details(exc.details)
                if partial_result is not None and partial_result.tokens_generated > 0:
                    benchmark["benchmarks"]["throughput"] = stream_result_to_benchmark_metrics(
                        partial_result,
                        status="partial",
                        elapsed_cap=self.config.throughput_window,
                        error_code=code,
                    )
                else:
                    benchmark["benchmarks"]["throughput"] = {"status": "partial", "errorCode": code}
        benchmark["benchmarks"]["throughput"]["warmupsCompleted"] = warmups_done
        benchmark["benchmarks"]["throughput"]["promptProcessing"] = self.measure_prompt_processing(
            throughput_url, throughput_model_id, request_headers, throughput_log,
        )
        benchmark["benchmarks"]["throughput"]["decodeProbe"] = self.measure_decode_probe(
            throughput_url, throughput_model_id, request_headers, throughput_log,
        )
        benchmark["timestamps"]["throughputComplete"] = iso_now()
        self.save_benchmark(benchmark_path, benchmark)

        self.cleanup_slot(slot, stop_log)
        benchmark["timestamps"]["stopped"] = iso_now()
        self.save_benchmark(benchmark_path, benchmark)

    def measure_decode_probe(
        self,
        url: str,
        model_id: str,
        request_headers: dict[str, str] | None,
        log_path: Path,
    ) -> dict[str, Any]:
        """Decode rate over a fixed token count.

        The scenario prompt measures "how fast did this model produce the
        answer it chose to give", which mixes decode speed with answer length:
        a no-think model finishes in ~90 tokens and a thinking model in
        thousands, so their tokens/s are not comparable. This asks every model
        for exactly DECODE_PROBE_TOKENS tokens with ignore_eos and times the
        generation window (TTFT excluded). Best effort: a failure is recorded
        on the field, never as a row error.
        """
        payload = {
            "model": model_id,
            "messages": [{"role": "user", "content": DECODE_PROBE_PROMPT}],
            "stream": True,
            "stream_options": {"include_usage": True},
            **SAMPLING_PROFILE["decodeProbe"],
        }
        append_text(log_path, "--- decode probe ---\n" + json.dumps({"request": payload}, indent=2) + "\n")
        try:
            result = stream_chat_completion(
                url,
                payload,
                hard_timeout=self.config.throughput_window,
                first_token_timeout=self.config.throughput_window,
                stall_timeout=self.config.throughput_stall_timeout,
                max_duration=self.config.throughput_window,
                log_path=log_path,
                extra_headers=request_headers,
            )
        except BenchmarkError as exc:
            return {"status": "failed", "errorCode": exc.code, "message": str(exc)}
        except Exception as exc:  # noqa: BLE001 - a probe must not take the row down
            return {"status": "failed", "errorCode": "decode-probe-error", "message": str(exc)}
        window = result.total_seconds
        if result.ttft_seconds is not None:
            window = max(result.total_seconds - result.ttft_seconds, 0.0)
        hit_cap = result.finish_reason == "length"
        return {
            # A model that stopped early despite ignore_eos measured a shorter
            # window than the others, so the comparison is weaker; say so
            # rather than hiding it behind a number.
            "status": "pass" if hit_cap else "partial",
            "requestedTokens": DECODE_PROBE_TOKENS,
            "tokensGenerated": result.tokens_generated,
            "hitCap": hit_cap,
            "finishReason": result.finish_reason,
            "ttftSeconds": round(result.ttft_seconds, 3) if result.ttft_seconds is not None else None,
            "windowSeconds": round(window, 3),
            "tokensPerSecond": round(result.tokens_generated / window, 3) if window > 0 else None,
            "tokenCountMethod": result.token_count_method,
        }

    def measure_prompt_processing(
        self,
        url: str,
        model_id: str,
        request_headers: dict[str, str] | None,
        log_path: Path,
    ) -> dict[str, Any]:
        """Prompt tokens per second on a cold cache: a long fixed prompt with a
        one-token answer, timed to the first token. Best effort; a failure is
        recorded on the field, never as a row error."""
        prompt = build_prompt_processing_prompt()
        payload = {
            "model": model_id,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            **SAMPLING_PROFILE["promptProcessing"],
        }
        append_text(log_path, "--- prompt processing probe ---\n" + json.dumps({"request": {**payload, "messages": "[fixed passage]"}}, indent=2) + "\n")
        # A one-token answer makes the whole round trip prompt processing plus
        # one decode step, so wall time to the (non-streamed) response is the
        # measurement. Streaming ends too abruptly here to time reliably.
        started = time.monotonic()
        try:
            response = chat_completion_json(url, payload, timeout=self.config.global_timeout, extra_headers=request_headers)
        except BenchmarkError as exc:
            return {"status": "failed", "errorCode": exc.code, "message": str(exc)}
        except Exception as exc:  # noqa: BLE001 - a probe must not take the row down
            return {"status": "failed", "errorCode": "prompt-processing-error", "message": str(exc)}
        seconds = time.monotonic() - started
        append_text(log_path, json.dumps({"response": response}, indent=2)[:4000] + "\n")
        usage = response.get("usage") if isinstance(response.get("usage"), dict) else {}
        prompt_tokens = usage.get("prompt_tokens")
        method = "usage"
        if not isinstance(prompt_tokens, int) or prompt_tokens <= 0:
            prompt_tokens = max(1, len(prompt) // 4)
            method = "estimate"
        return {
            "status": "pass",
            "promptTokens": prompt_tokens,
            "promptChars": len(prompt),
            "seconds": round(seconds, 3),
            "tokensPerSecond": round(prompt_tokens / seconds, 1) if seconds > 0 else None,
            "tokenCountMethod": method,
            "coldCache": True,
        }

    def run_agentic_step(
        self,
        slot: Slot,
        model_id: str,
        log_path: Path,
        *,
        request_headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + self.config.global_timeout
        url = f"http://127.0.0.1:{slot.public_port}/v1/chat/completions"
        messages: list[dict[str, Any]] = [{"role": "user", "content": AGENTIC_PROMPT}]
        tool_calls_made = 0
        tool_support = "unknown"
        final_text = ""
        notes: list[str] = []

        def remaining_timeout() -> float:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise StepTimeout("agentic-timeout", "Agentic request exceeded the timeout")
            return remaining

        def request_with_tools(include_tools: bool) -> dict[str, Any]:
            payload: dict[str, Any] = {
                "model": model_id,
                "messages": messages,
                # Deterministic: the tool-call result used to change from run
                # to run at temperature 0.3, so the same model could pass one
                # night and fail the next without anything changing.
                "temperature": 0.0,
                "max_tokens": 2048,
                "seed": BENCHMARK_SEED,
                "stream": False,
            }
            if include_tools:
                payload["tools"] = TOOLS_PAYLOAD
                payload["tool_choice"] = "auto"
            append_text(log_path, json.dumps({"payload": payload}, indent=2) + "\n")
            response = chat_completion_json(url, payload, timeout=remaining_timeout(), extra_headers=request_headers)
            append_text(log_path, json.dumps({"response": response}, indent=2) + "\n\n")
            return response

        try:
            for _round in range(MAX_AGENTIC_ROUNDS):
                response = request_with_tools(include_tools=True)
                choices = response.get("choices")
                if not isinstance(choices, list) or not choices:
                    raise BenchmarkError("agentic-error", "No choices returned from agentic request")
                message = choices[0].get("message")
                if not isinstance(message, dict):
                    raise BenchmarkError("agentic-error", "Missing assistant message in agentic response")
                tool_calls = message.get("tool_calls")
                if isinstance(tool_calls, list) and tool_calls:
                    tool_support = "supported"
                    tool_calls_made += len(tool_calls)
                    messages.append(
                        {
                            "role": "assistant",
                            "content": message.get("content") or "",
                            "tool_calls": tool_calls,
                        }
                    )
                    for tool_call in tool_calls:
                        result = execute_tool_call(tool_call)
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tool_call.get("id"),
                                "content": json.dumps(result),
                            }
                        )
                        append_text(log_path, json.dumps({"toolCall": tool_call, "toolResult": result}, indent=2) + "\n")
                    continue

                final_text = message_text(message.get("content"))
                reasoning_text = message_text(message.get("reasoning_content"))
                finish_reason = str(choices[0].get("finish_reason") or "")
                text_tool_calls = parse_text_tool_calls(final_text)
                if text_tool_calls:
                    tool_support = "supported"
                    tool_calls_made += len(text_tool_calls)
                    notes.append("Model emitted tool calls in text form; executed them locally and continued.")
                    messages.append({"role": "assistant", "content": final_text})
                    for tool_call in text_tool_calls:
                        result = execute_tool_call(tool_call)
                        append_text(log_path, json.dumps({"textToolCall": tool_call, "toolResult": result}, indent=2) + "\n")
                        messages.append(
                            {
                                "role": "user",
                                "content": (
                                    f"Tool `{tool_call['function']['name']}` returned "
                                    f"{json.dumps(result, ensure_ascii=False)}. Continue with the remaining task "
                                    "and provide the final answer for the user."
                                ),
                            }
                        )
                    final_text = ""
                    continue
                if finish_reason == "length":
                    if tool_calls_made == 0:
                        notes.append("Model spent its completion budget before issuing tool calls; retried with a terse tool-only follow-up.")
                        messages.append(
                            {
                                "role": "user",
                                "content": "Immediately call the required tool or tools. No explanation, no reasoning, no prose.",
                            }
                        )
                        continue
                    if not final_text and reasoning_text:
                        notes.append("Model completed the tool work but exhausted tokens in reasoning; requested a concise final answer without more tools.")
                        messages.append(
                            {
                                "role": "user",
                                "content": (
                                    "Stop reasoning. Do not call any more tools. In at most three short sentences, "
                                    "state the product, list the prime factors, and give one real-world example."
                                ),
                            }
                        )
                        continue
                break
            else:
                raise BenchmarkError("agentic-error", "Agentic conversation exhausted the round limit")
        except ApiResponseError as exc:
            if looks_like_tool_unsupported(exc.body):
                tool_support = "unsupported"
                notes.append("Tool payload was rejected by the runtime; retried without tools for text-only scoring.")
                append_text(log_path, json.dumps({"toolUnsupportedBody": exc.body[:JSON_CAPTURE_LIMIT]}, indent=2) + "\n")
                response = request_with_tools(include_tools=False)
                choices = response.get("choices")
                if not isinstance(choices, list) or not choices:
                    raise BenchmarkError("agentic-error", "No choices returned from fallback agentic request")
                message = choices[0].get("message")
                if not isinstance(message, dict):
                    raise BenchmarkError("agentic-error", "Missing assistant message in fallback agentic response")
                final_text = message_text(message.get("content"))
            else:
                raise

        analysis = analyze_agentic_output(final_text)
        math_correct = analysis["mathCorrect"]
        complete = analysis["complete"]
        agentic_error = None
        result = "fail"
        status = "fail"

        if tool_support == "unsupported":
            result = "not-applicable"
            status = "partial"
            agentic_error = "tool-not-supported"
        elif tool_calls_made == 0:
            if complete:
                result = "partial"
                status = "partial"
                agentic_error = "no-tool-calls"
            elif math_correct:
                result = "partial"
                status = "partial"
                agentic_error = "incomplete"
            else:
                result = "fail"
                status = "fail"
                agentic_error = "incorrect"
        else:
            if complete:
                result = "pass"
                status = "pass"
            elif math_correct:
                result = "partial"
                status = "partial"
                agentic_error = "incomplete"
            else:
                result = "fail"
                status = "fail"
                agentic_error = "incorrect"

        if final_text:
            notes.append(final_text[:500])

        payload = {
            "result": result,
            "toolCallsMade": tool_calls_made,
            "toolSupport": tool_support,
            "mathCorrect": math_correct,
            "expectedValue": EXPECTED_PRODUCT,
            "expectedPrimeFactors": EXPECTED_FACTORS,
            "notes": " ".join(note.strip() for note in notes if note.strip())[:1000],
            "finalText": final_text[:500],
            "status": status,
        }
        if agentic_error:
            payload["agenticError"] = agentic_error
        return payload

    def run_translation_step(
        self,
        slot: Slot,
        model_id: str,
        log_path: Path,
        *,
        thinking: bool,
        request_headers: dict[str, str] | None = None,
    ) -> dict[str, Any] | None:
        """Translate the fixed English passage and score it with chrF.

        Unlike the other quality tasks this follows the variant thinking mode,
        so it runs once with thinking on and once with it off.
        """
        url = f"http://127.0.0.1:{slot.public_port}/v1/chat/completions"
        eval_script = BENCHMARK_ROOT / "quality_eval.py"
        output_path = log_path.parent / f"quality_{TRANSLATION_TASK}_{'think' if thinking else 'no-think'}.json"
        try:
            output_path.unlink(missing_ok=True)
        except OSError:
            pass
        command = [
            "python3", "-u", str(eval_script),
            "--url", url,
            "--model", model_id,
            "--tasks", TRANSLATION_TASK,
            "--limit", "1",
            "--timeout", str(self.config.global_timeout),
            "--output", str(output_path),
        ]
        if not thinking:
            command.append("--disable-thinking")
        append_text(log_path, f"[{iso_now()}] Running {TRANSLATION_TASK} (thinking={'on' if thinking else 'off'})\n")
        env = {
            **os.environ,
            "BENCHMARK_API_KEY": str((request_headers or {}).get("X-API-Key") or ""),
        }
        try:
            with log_path.open("a", encoding="utf-8") as log_handle:
                process = subprocess.Popen(
                    command, stdout=subprocess.DEVNULL, stderr=log_handle, text=True, env=env,
                )
                try:
                    process.wait(timeout=self.config.global_timeout)
                except subprocess.TimeoutExpired:
                    terminate_process(process)
                    append_text(log_path, f"[{iso_now()}] {TRANSLATION_TASK}: timed out\n")
                    return None
            if not output_path.exists():
                return None
            data = json.loads(output_path.read_text(encoding="utf-8"))
            artifact = (data.get("artifacts") or {}).get(TRANSLATION_TASK)
            if isinstance(artifact, dict):
                artifact["thinking"] = bool(thinking)
            return artifact
        except Exception as exc:  # noqa: BLE001 - never sink a whole benchmark for this
            append_text(log_path, f"[{iso_now()}] {TRANSLATION_TASK}: error: {exc}\n")
            return None

    def run_quality_step(
        self,
        slot: Slot,
        model_id: str,
        log_path: Path,
        *,
        thinking: bool = False,
        request_headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        configured_limit = getattr(self.config, "quality_limit", DEFAULT_QUALITY_LIMIT)
        # Quality used to be measured once per model with thinking forced off and
        # the result copied onto the thinking row, which meant the smartness
        # column only ever described the no-think brain -- the one comparison
        # llm3's slot UI exists to make was the one the table could not answer.
        quality_limit = (
            max(MIN_THINKING_SAMPLE, configured_limit // THINKING_SAMPLE_DIVISOR)
            if thinking
            else configured_limit
        )
        url = f"http://127.0.0.1:{slot.public_port}/v1/chat/completions"

        enabled_metrics = tuple(getattr(self.config, "quality_metrics", DEFAULT_QUALITY_METRICS) or DEFAULT_QUALITY_METRICS)
        MMLU_TASKS = ["mmlu_stem", "mmlu_social_sciences", "mmlu_humanities"] if "mmlu" in enabled_metrics else []
        EXTRA_QUALITY_TASKS = [
            task for task in ("mmlu_pro", "math500", "gsm8k", "humaneval") if task in enabled_metrics
        ]
        QUALITY_TASKS = MMLU_TASKS + EXTRA_QUALITY_TASKS
        eval_script = BENCHMARK_ROOT / "quality_eval.py"
        deepeval_script = BENCHMARK_ROOT / "deepeval_smartness_eval.py"

        append_text(
            log_path,
            f"[{iso_now()}] Starting quality benchmark (limit={quality_limit}, thinking={'on' if thinking else 'off'})\n\n",
        )
        append_text(log_path, f"[{iso_now()}] Enabled metrics: {list(enabled_metrics)}\n\n")
        append_text(log_path, f"[{iso_now()}] MMLU tasks: {MMLU_TASKS}\n\n")
        append_text(log_path, f"[{iso_now()}] Extra quality tasks: {EXTRA_QUALITY_TASKS}\n\n")

        configured_task_timeout = getattr(self.config, "quality_task_timeout", DEFAULT_QUALITY_TASK_TIMEOUT)
        scores = {}
        # Why a score is missing matters as much as the score: a timeout is a
        # budget problem, a crash is a broken model, and the summary should not
        # render both as a bare "n/a".
        task_diagnostics: dict[str, Any] = {}
        for task_name in QUALITY_TASKS:
            # 30s a question is a non-thinking multiple-choice budget. A task
            # whose questions may each take minutes needs a deadline that says
            # so, or the score is computed over whatever fraction got answered
            # before the clock ran out.
            task_budget_tokens = (
                THINKING_MAX_TOKENS if thinking
                else MATH_MAX_TOKENS if task_name in NUMERIC_QUALITY_TASKS
                else CHOICE_MAX_TOKENS
            )
            task_timeout = max(
                configured_task_timeout,
                request_timeout_for(task_budget_tokens, thinking=thinking) * quality_limit,
            )
            append_text(log_path, f"[{iso_now()}] Running {task_name} (per-question ceiling {request_timeout_for(task_budget_tokens, thinking=thinking)}s)\n")
            output_path = log_path.parent / f"quality_{task_name}.json"
            live_path = log_path.parent / f"quality_{task_name}.live.jsonl"
            try:
                output_path.unlink(missing_ok=True)
                live_path.unlink(missing_ok=True)
            except OSError:
                pass
            try:
                command = [
                    "python3", "-u", str(eval_script),
                    "--url", url,
                    "--model", model_id,
                    "--tasks", task_name,
                    "--limit", str(quality_limit),
                    "--timeout", str(task_timeout),
                    "--output", str(output_path),
                    # Per-question results as they happen, so the dashboard can
                    # show what the model is getting wrong while it is still
                    # working rather than only in the post-mortem.
                    "--live-log", str(log_path.parent / f"quality_{task_name}.live.jsonl"),
                ]
                # Maths answers run long even without thinking; multiple choice
                # does not. Size the clock per task from the budget that task
                # will actually use.
                task_max_tokens = (
                    THINKING_MAX_TOKENS if thinking
                    else MATH_MAX_TOKENS if task_name in NUMERIC_QUALITY_TASKS
                    else CHOICE_MAX_TOKENS
                )
                per_request_timeout = request_timeout_for(task_max_tokens, thinking=thinking)
                command.extend(["--request-timeout", str(per_request_timeout)])
                if thinking:
                    # Three separate ceilings were all sized for non-thinking
                    # runs, and a reasoning model hits every one of them:
                    #
                    #   tokens   1024 for a multiple-choice answer. Measured: a
                    #            4B produced no answer text at all on 24 of 30
                    #            MMLU-Pro questions -- it spent the whole budget
                    #            reasoning -- and scored 0.20 against 0.43 for
                    #            its own no-think run.
                    #   request  60s, never passed, so it kept the default. At
                    #            the recorded decode rates that is ~1,200 tokens
                    #            on a dense 27B and ~5,600 on the 4B: a token
                    #            budget above that is unreachable, and the
                    #            request dies with nothing rather than
                    #            truncating.
                    #   task     30s per question, which a thinking question
                    #            blows through on its own.
                    #
                    # So the budget is set high enough not to bind and the
                    # timeout becomes the real backstop, which is the honest way
                    # round: a model that cannot answer inside five minutes has
                    # told you something about itself.
                    command.extend([
                        "--choice-max-tokens", str(THINKING_MAX_TOKENS),
                        "--math-max-tokens", str(THINKING_MAX_TOKENS),
                    ])
                else:
                    # Measured on the first per-variant run: a 4B truncated 8 of
                    # 60 MATH-500 answers at 2048 tokens with thinking off, and
                    # every one of them scored as wrong. Long derivations are the
                    # norm here, not the exception.
                    command.extend(["--math-max-tokens", str(MATH_MAX_TOKENS)])
                    command.append("--disable-thinking")
                env = {
                    **os.environ,
                    "BENCHMARK_API_KEY": str((request_headers or {}).get("X-API-Key") or ""),
                }
                with log_path.open("a", encoding="utf-8") as log_handle:
                    process = subprocess.Popen(
                        command,
                        stdout=subprocess.DEVNULL,
                        stderr=log_handle,
                        text=True,
                        env=env,
                    )
                    try:
                        # The eval stops itself a little before this, so a kill
                        # here means it hung rather than ran long.
                        returncode = process.wait(timeout=task_timeout + 60)
                    except subprocess.TimeoutExpired:
                        terminate_process(process)
                        append_text(log_path, f"[{iso_now()}] {task_name}: timed out after {task_timeout + 60}s\n")
                        scores[task_name] = None
                        task_diagnostics[task_name] = {"missingReason": "timeout", "budgetSeconds": task_timeout}
                        continue
                if returncode != 0:
                    append_text(log_path, f"[{iso_now()}] {task_name}: command failed (exit {returncode})\n")
                    scores[task_name] = None
                    task_diagnostics[task_name] = {"missingReason": f"exit-{returncode}"}
                    continue
                task_result = load_json_file(output_path)
                if task_result:
                    scores[task_name] = task_result.get("scores", {}).get(task_name)
                    diagnostic = (task_result.get("diagnostics") or {}).get(task_name)
                    if isinstance(diagnostic, dict):
                        task_diagnostics[task_name] = diagnostic
                        if not diagnostic.get("complete", True):
                            append_text(
                                log_path,
                                f"[{iso_now()}] {task_name}: PARTIAL SAMPLE — scored "
                                f"{diagnostic.get('scored')} of {diagnostic.get('requested')} questions\n",
                            )
                        if diagnostic.get("truncated"):
                            append_text(
                                log_path,
                                f"[{iso_now()}] {task_name}: {diagnostic['truncated']} reply(ies) hit the token cap\n",
                            )
                    append_text(log_path, f"[{iso_now()}] {task_name} = {scores[task_name]}\n")
                else:
                    append_text(log_path, f"[{iso_now()}] {task_name}: no JSON in output\n")
                    scores[task_name] = None
                    task_diagnostics[task_name] = {"missingReason": "no-output"}
            except Exception as e:
                append_text(log_path, f"[{iso_now()}] {task_name}: error: {e}\n")
                scores[task_name] = None
                task_diagnostics[task_name] = {"missingReason": f"error: {str(e)[:120]}"}

        deep_eval_score = None
        deep_eval_result: dict[str, Any] | None = None
        deep_eval_missing_reason = ""
        deep_eval_limit = getattr(self.config, "deepeval_limit", quality_limit) or quality_limit
        run_deepeval = "deepeval" in enabled_metrics
        deep_eval_timeout = getattr(self.config, "deepeval_timeout", DEFAULT_DEEPEVAL_TIMEOUT)
        if run_deepeval:
            append_text(
                log_path,
                f"[{iso_now()}] Running DeepEval smartness ({DEEPEVAL_SMARTNESS_BENCHMARK}, "
                f"limit={deep_eval_limit}, budget={deep_eval_timeout}s)\n",
            )
            deep_eval_output_path = log_path.parent / "quality_deepeval.json"
            try:
                deep_eval_output_path.unlink(missing_ok=True)
            except OSError:
                pass
            try:
                deep_eval_command = [
                    "python3", "-u", str(deepeval_script),
                    "--url", url,
                    "--model", model_id,
                    "--limit", str(deep_eval_limit),
                    "--request-timeout", str(max(60, min(deep_eval_timeout, 180))),
                    "--max-tokens", "512",
                    "--output", str(deep_eval_output_path),
                ]
                if not thinking:
                    deep_eval_command.append("--disable-thinking")
                env = {
                    **os.environ,
                    "BENCHMARK_API_KEY": str((request_headers or {}).get("X-API-Key") or ""),
                }
                with log_path.open("a", encoding="utf-8") as log_handle:
                    process = subprocess.Popen(
                        deep_eval_command,
                        stdout=subprocess.DEVNULL,
                        stderr=log_handle,
                        text=True,
                        env=env,
                    )
                    try:
                        returncode = process.wait(timeout=deep_eval_timeout)
                    except subprocess.TimeoutExpired:
                        terminate_process(process)
                        append_text(
                            log_path,
                            f"[{iso_now()}] DeepEval smartness: timed out after {deep_eval_timeout}s\n",
                        )
                        returncode = None
                        deep_eval_missing_reason = "timeout"
                if returncode == 0:
                    candidate = load_json_file(deep_eval_output_path)
                    if candidate:
                        deep_eval_result = candidate
                        deep_eval_score = candidate.get("score")
                        append_text(log_path, f"[{iso_now()}] DeepEval smartness = {deep_eval_score}\n")
                    else:
                        append_text(log_path, f"[{iso_now()}] DeepEval smartness: no JSON in output\n")
                        deep_eval_missing_reason = "no-output"
                elif returncode is not None:
                    append_text(log_path, f"[{iso_now()}] DeepEval smartness: command failed (exit {returncode})\n")
                    deep_eval_missing_reason = f"exit-{returncode}"
            except Exception as e:
                append_text(log_path, f"[{iso_now()}] DeepEval smartness: error: {e}\n")
                deep_eval_missing_reason = f"error: {str(e)[:120]}"

        mmlu_scores = [scores.get(task_name) for task_name in MMLU_TASKS if scores.get(task_name) is not None]
        avg_mmlu = round(sum(mmlu_scores) / len(mmlu_scores), 4) if mmlu_scores else None
        mmlu_pro_score = scores.get("mmlu_pro")
        math500_score = scores.get("math500")
        humaneval_score = scores.get("humaneval")
        gsm8k_score = scores.get("gsm8k")
        if isinstance(deep_eval_score, (int, float)):
            deep_eval_score = round(float(deep_eval_score), 4)
        else:
            deep_eval_score = None
        overall_components = {
            "avgMmlu": avg_mmlu,
            "mmluPro": mmlu_pro_score,
            "math500": math500_score,
            "humanEval": humaneval_score,
            "gsm8k": gsm8k_score,
            "deepEval": deep_eval_score,
        }
        def task_is_unreliable(diagnostic: dict[str, Any]) -> bool:
            scored = diagnostic.get("scored") or 0
            if not scored:
                return False
            lost = (diagnostic.get("truncated") or 0) + (diagnostic.get("noResponse") or 0) + (diagnostic.get("timeouts") or 0)
            requested = diagnostic.get("requested") or 0
            # Either most replies were unusable, or so few questions were scored
            # that the survivors are not a sample of anything. One recorded run
            # answered 1 of 30 maths questions, got it right, and reported 1.00.
            return lost / scored > 0.5 or (requested and scored / requested < 0.5)

        unreliable_tasks = sorted(
            task
            for task, diagnostic in task_diagnostics.items()
            if isinstance(diagnostic, dict) and task_is_unreliable(diagnostic)
        )

        excluded_keys = {
            QUALITY_METRIC_WEIGHT_KEYS[task]
            for task in unreliable_tasks
            if task in QUALITY_METRIC_WEIGHT_KEYS
        }
        weighted_total = 0.0
        total_weight = 0.0
        for key, weight in QUALITY_OVERALL_WEIGHTS.items():
            value = overall_components.get(key)
            if value is None or key in excluded_keys:
                continue
            weighted_total += float(value) * weight
            total_weight += weight
        overall = round(weighted_total / total_weight, 4) if total_weight > 0 else None

        # A task that truncated most of its replies did not measure the model,
        # it measured the token budget: the first per-variant run scored a 4B at
        # 0.20 on MMLU-Pro with 24 of 30 replies cut off before they named a
        # letter. Numbers like that must not be presented as a clean pass.
        payload = {
            "scores": scores,
            "avgMmlu": avg_mmlu,
            "mmluPro": mmlu_pro_score,
            "math500": math500_score,
            "humanEval": humaneval_score,
            "gsm8k": gsm8k_score,
            **(
                {
                    "deepEval": deep_eval_result or {"benchmark": DEEPEVAL_SMARTNESS_BENCHMARK, "score": deep_eval_score},
                    "deepEvalScore": deep_eval_score,
                }
                if run_deepeval
                else {}
            ),
            "overallComponents": overall_components,
            "overallWeights": dict(QUALITY_OVERALL_WEIGHTS),
            "overallAverage": overall,
            "mmluSubsets": MMLU_TASKS,
            "extraTasks": EXTRA_QUALITY_TASKS,
            "enabledMetrics": list(enabled_metrics),
            "limit": quality_limit,
            "configuredLimit": configured_limit,
            # Which thinking mode these numbers were actually measured in. The
            # dashboard compares it against the row's own variant and flags the
            # rows that are reading someone else's measurement.
            "qualityBucket": "think" if thinking else "no-think",
            "thinkingMeasured": bool(thinking),
            "taskDiagnostics": task_diagnostics,
            **({"deepEvalMissingReason": deep_eval_missing_reason} if deep_eval_missing_reason else {}),
            **({"unreliableTasks": unreliable_tasks} if unreliable_tasks else {}),
            "status": (
                "partial" if (overall is not None and unreliable_tasks)
                else "pass" if overall is not None
                else ("not-applicable" if not enabled_metrics else "fail")
            ),
        }

        append_text(
            log_path,
            f"\n[{iso_now()}] Summary: avg_mmlu={avg_mmlu}, mmlu_pro={mmlu_pro_score}, gsm8k={gsm8k_score}, deepeval={deep_eval_score}, overall={overall}\n",
        )
        return payload

    def write_summary(self, models: list[ModelSpec]) -> None:
        payloads: list[dict[str, Any]] = []
        for benchmark_path in sorted(self.config.results_dir.glob("*/benchmark.json")):
            if benchmark_path.is_file():
                payload = load_json_file(benchmark_path)
                if payload:
                    payloads.append(payload)

        if not payloads:
            return

        status_counts: dict[str, int] = {}
        for payload in payloads:
            status = str(payload.get("overallStatus") or "pending")
            status_counts[status] = status_counts.get(status, 0) + 1

        def metric(payload: dict[str, Any], *path: str) -> Any:
            value: Any = payload
            for key in path:
                if not isinstance(value, dict):
                    return None
                value = value.get(key)
            return value

        def as_float(value: Any) -> float | None:
            if isinstance(value, (int, float)):
                return float(value)
            return None

        def decode_throughput_metric_value(payload: dict[str, Any]) -> float | None:
            return as_float(metric(payload, "benchmarks", "throughput", "tokensPerSecond"))

        def answer_throughput_metric_value(payload: dict[str, Any]) -> float | None:
            return as_float(metric(payload, "benchmarks", "throughput", "answerTokensPerSecond"))

        def quality_metrics(payload: dict[str, Any]) -> dict[str, float | None]:
            quality = metric(payload, "benchmarks", "quality") or {}
            if not isinstance(quality, dict):
                quality = {}
            scores = quality.get("scores") if isinstance(quality.get("scores"), dict) else {}
            deep_eval = as_float(quality.get("deepEvalScore"))
            if deep_eval is None:
                deep_eval = as_float(metric(payload, "benchmarks", "quality", "deepEval", "score"))
            return {
                "avg_mmlu": as_float(quality.get("avgMmlu")),
                "mmlu_pro": as_float(scores.get("mmlu_pro")),
                "hebrew_translation": as_float(scores.get(TRANSLATION_TASK)),
                "gsm8k": as_float(scores.get("gsm8k")),
                "deep_eval": deep_eval,
                "overall": as_float(quality.get("overallAverage")),
            }

        lines: list[str] = [
            "# Benchmark Summary",
            "",
            "## Executive Summary",
            "",
            f"- Model+launcher combos discovered: **{len(models)}**",
            f"- Result rows (one per thinking variant): **{len(payloads)}**",
            f"- Pass: **{status_counts.get('pass', 0)}**",
            f"- Partial: **{status_counts.get('partial', 0)}**",
            f"- Fail: **{status_counts.get('fail', 0)}**",
            "",
            "## Performance Comparison",
            "",
            "*Decode tok/s = generation rate after the first token (TTFT excluded). "
            "Answer tok/s = answer tokens over the whole run — thinking time counts against it, "
            "so 0 means the model never finished thinking inside the window.*",
            "*DeepEval = DeepEval IFEval instruction-following score on a 0–1 scale.*",
            overall_legend(),
            "*HE chrF = character-F similarity of the model's Hebrew translation of a fixed English passage against a fixed reference translation. It is a sorting aid, not a correctness score — open the column's side-by-side view to judge the translation.*",
            "",
            "| Model | Runtime | Launcher | Variant | Load (s) | TTFT (s) | Decode tok/s | Answer tok/s | MMLU | MMLU-Pro | HE chrF | GSM8K | DeepEval | Overall | Status |",
            "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
        ]

        for payload in payloads:
            quality = quality_metrics(payload)
            lines.append(
                "| {label} | {runtime} | {launcher} | {variant} | {load} | {ttft} | {decode_tps} | {answer_tps} | {mmlu} | {hs} | {hebrew} | {gsm8k} | {deep_eval} | {overall} | {status} |".format(
                    label=str(payload.get("modelLabel") or payload.get("modelKey") or "unknown"),
                    runtime=str(payload.get("runtime") or "unknown"),
                    variant=str(payload.get("variant") or "-"),
                    launcher=str(payload.get("launcher") or payload.get("runtime") or "unknown"),
                    load=format_metric(as_float(metric(payload, "benchmarks", "loadTime", "seconds"))),
                    ttft=format_metric(as_float(metric(payload, "benchmarks", "basicResponse", "ttftSeconds"))),
                    decode_tps=format_metric(decode_throughput_metric_value(payload)),
                    answer_tps=format_metric(answer_throughput_metric_value(payload)),
                    mmlu=format_metric(quality["avg_mmlu"]),
                    hs=format_metric(quality["mmlu_pro"]),
                    hebrew=format_metric(quality["hebrew_translation"]),
                    gsm8k=format_metric(quality["gsm8k"]),
                    deep_eval=format_metric(quality["deep_eval"]),
                    overall=format_metric(quality["overall"]),
                    status=str(payload.get("overallStatus") or "pending"),
                )
            )

        lines.extend(["", "## By Runtime Family", "", "| Runtime | Models | Avg Load (s) | Avg TTFT (s) | Avg Decode tok/s | Avg Answer tok/s |", "| --- | ---: | ---: | ---: | ---: | ---: |"])
        for runtime in ("gguf", "mlx", "mtplx", "dflash"):
            subset = [payload for payload in payloads if payload.get("runtime") == runtime]
            if not subset:
                continue
            lines.append(
                "| {runtime} | {count} | {load} | {ttft} | {decode_tps} | {answer_tps} |".format(
                    runtime=runtime,
                    count=len(subset),
                    load=format_metric(avg(as_float(metric(item, "benchmarks", "loadTime", "seconds")) for item in subset)),
                    ttft=format_metric(avg(as_float(metric(item, "benchmarks", "basicResponse", "ttftSeconds")) for item in subset)),
                    decode_tps=format_metric(avg(decode_throughput_metric_value(item) for item in subset)),
                    answer_tps=format_metric(avg(answer_throughput_metric_value(item) for item in subset)),
                )
            )

        lines.extend(["", "## By Model Size", "", "| Model | Size | Load (s) | Decode tok/s | Answer tok/s |", "| --- | --- | ---: | ---: | ---: |"])
        for payload in sorted(payloads, key=lambda item: int(item.get("sizeBytes") or 0), reverse=True):
            lines.append(
                "| {label} | {size} | {load} | {decode_tps} | {answer_tps} |".format(
                    label=str(payload.get("modelLabel") or payload.get("modelKey") or "unknown"),
                    size=str(payload.get("sizeLabel") or "unknown"),
                    load=format_metric(as_float(metric(payload, "benchmarks", "loadTime", "seconds"))),
                    decode_tps=format_metric(decode_throughput_metric_value(payload)),
                    answer_tps=format_metric(answer_throughput_metric_value(payload)),
                )
            )

        error_rows = []
        for payload in payloads:
            for error in payload.get("errors") or []:
                if not isinstance(error, dict):
                    continue
                error_rows.append(
                    (
                        str(payload.get("modelLabel") or payload.get("modelKey") or "unknown"),
                        str(error.get("stage") or ""),
                        str(error.get("code") or ""),
                        truncate(str(error.get("message") or ""), 120),
                    )
                )
        lines.extend(["", "## Error Log", ""])
        if error_rows:
            lines.extend(["| Model | Stage | Code | Message |", "| --- | --- | --- | --- |"])
            for row in error_rows:
                lines.append(f"| {row[0]} | {row[1]} | {row[2]} | {row[3]} |")
        else:
            lines.append("No errors recorded.")

        lines.extend(["", "## Agentic Results", "", "| Model | Result | Tool Support | Tool Calls | Status |", "| --- | --- | --- | ---: | --- |"])
        for payload in payloads:
            agentic = metric(payload, "benchmarks", "agentic") or {}
            if not isinstance(agentic, dict):
                agentic = {}
            lines.append(
                "| {label} | {result} | {tool_support} | {tool_calls} | {status} |".format(
                    label=str(payload.get("modelLabel") or payload.get("modelKey") or "unknown"),
                    result=str(agentic.get("result") or "n/a"),
                    tool_support=str(agentic.get("toolSupport") or "unknown"),
                    tool_calls=str(agentic.get("toolCallsMade") or 0),
                    status=str(agentic.get("status") or "pending"),
                )
            )

        fastest_load = best_payload(payloads, lambda item: as_float(metric(item, "benchmarks", "loadTime", "seconds")), reverse=False)
        best_ttft = best_payload(payloads, lambda item: as_float(metric(item, "benchmarks", "basicResponse", "ttftSeconds")), reverse=False)
        best_decode_tps = best_payload(payloads, decode_throughput_metric_value, reverse=True)
        best_answer_tps = best_payload(payloads, answer_throughput_metric_value, reverse=True)
        agentic_pass = [payload for payload in payloads if metric(payload, "benchmarks", "agentic", "result") == "pass"]

        lines.extend(["", "## Quality Benchmarks", "", "| Model | MMLU (3-subset avg) | MMLU-Pro | HE chrF | GSM8K | DeepEval | Overall |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"])
        for payload in payloads:
            quality = quality_metrics(payload)
            lines.append(
                "| {label} | {mmlu} | {hs} | {hebrew} | {gsm8k} | {deep_eval} | {overall} |".format(
                    label=str(payload.get("modelLabel") or payload.get("modelKey") or "unknown"),
                    mmlu=format_metric(quality["avg_mmlu"]),
                    hs=format_metric(quality["mmlu_pro"]),
                    hebrew=format_metric(quality["hebrew_translation"]),
                    gsm8k=format_metric(quality["gsm8k"]),
                    deep_eval=format_metric(quality["deep_eval"]),
                    overall=format_metric(quality["overall"]),
                )
            )

        quality_scores = [as_float(metric(payload, "benchmarks", "quality", "avgMmlu")) for payload in payloads if as_float(metric(payload, "benchmarks", "quality", "avgMmlu")) is not None]
        best_quality = best_payload(payloads, lambda item: as_float(metric(item, "benchmarks", "quality", "avgMmlu")), reverse=True) if quality_scores else None
        best_mmlu_pro = best_payload(payloads, lambda item: as_float(metric(item, "benchmarks", "quality", "scores", "mmlu_pro")) if isinstance(metric(item, "benchmarks", "quality", "scores"), dict) else None, reverse=True)
        best_translation = best_payload(payloads, lambda item: as_float(metric(item, "benchmarks", "quality", "scores", TRANSLATION_TASK)) if isinstance(metric(item, "benchmarks", "quality", "scores"), dict) else None, reverse=True)
        best_overall = best_payload(payloads, lambda item: as_float(metric(item, "benchmarks", "quality", "overallAverage")), reverse=True)

        # Every quality number above is an accuracy with no denominator attached,
        # so a score over 11 of 30 questions and one over 30 of 30 look identical.
        # This section is where a run admits what it could not measure.
        known_labels = {str(model.label) for model in models}
        quality_notes: list[str] = []
        for payload in payloads:
            label = str(payload.get("modelLabel") or payload.get("modelKey") or "unknown")
            quality = metric(payload, "benchmarks", "quality") or {}
            if not isinstance(quality, dict):
                continue
            notes: list[str] = []
            diagnostics = quality.get("taskDiagnostics")
            if isinstance(diagnostics, dict):
                for task_name, diagnostic in sorted(diagnostics.items()):
                    if not isinstance(diagnostic, dict):
                        continue
                    reason = diagnostic.get("missingReason")
                    if reason:
                        notes.append(f"{task_name}: not measured ({reason})")
                        continue
                    scored = diagnostic.get("scored")
                    requested = diagnostic.get("requested")
                    if isinstance(scored, int) and isinstance(requested, int) and scored < requested:
                        notes.append(f"{task_name}: scored {scored} of {requested} questions")
                    truncated = diagnostic.get("truncated") or 0
                    if truncated:
                        notes.append(f"{task_name}: {truncated} reply(ies) hit the token cap")
                    unparsed = diagnostic.get("unparsed") or 0
                    if unparsed:
                        notes.append(f"{task_name}: {unparsed} reply(ies) had no readable answer")
            deep_eval_reason = quality.get("deepEvalMissingReason")
            if deep_eval_reason:
                notes.append(f"DeepEval: not measured ({deep_eval_reason})")
            if label not in known_labels:
                notes.append("result is stale — this model is no longer on disk")
            if notes:
                quality_notes.append(f"- **{label}** — " + "; ".join(notes))

        lines.extend(["", "## Data Quality", ""])
        if quality_notes:
            lines.append("*Rows below were scored on less than the full sample, or are missing a metric entirely. Their Overall re-normalizes across whatever was measured, so they are not directly comparable to complete rows.*")
            lines.append("")
            lines.extend(quality_notes)
        else:
            lines.append("Every recorded row measured the full sample on every metric.")

        lines.extend(["", "## Recommendations", ""])
        if fastest_load:
            lines.append(f"- Fastest load: **{fastest_load['modelLabel']}** ({format_metric(as_float(metric(fastest_load, 'benchmarks', 'loadTime', 'seconds')))} s)")
        if best_ttft:
            lines.append(f"- Best TTFT: **{best_ttft['modelLabel']}** ({format_metric(as_float(metric(best_ttft, 'benchmarks', 'basicResponse', 'ttftSeconds')))} s)")
        if best_decode_tps:
            lines.append(f"- Best decode throughput: **{best_decode_tps['modelLabel']}** ({format_metric(decode_throughput_metric_value(best_decode_tps))} tok/s)")
        if best_answer_tps:
            lines.append(f"- Best answer throughput: **{best_answer_tps['modelLabel']}** ({format_metric(answer_throughput_metric_value(best_answer_tps))} tok/s)")
        if best_quality:
            lines.append(f"- Best MMLU: **{best_quality['modelLabel']}** ({format_metric(as_float(metric(best_quality, 'benchmarks', 'quality', 'avgMmlu')))} avg)")
        if best_mmlu_pro and metric(best_mmlu_pro, "benchmarks", "quality", "scores", "mmlu_pro"):
            lines.append(f"- Best MMLU-Pro: **{best_mmlu_pro['modelLabel']}** ({format_metric(as_float(metric(best_mmlu_pro, 'benchmarks', 'quality', 'scores', 'mmlu_pro')))} acc)")
        if best_translation and metric(best_translation, "benchmarks", "quality", "scores", TRANSLATION_TASK):
            lines.append(f"- Best Hebrew translation (chrF vs reference): **{best_translation['modelLabel']}** ({format_metric(as_float(metric(best_translation, 'benchmarks', 'quality', 'scores', TRANSLATION_TASK)))})")
        best_gsm8k = best_payload(payloads, lambda item: as_float(metric(item, "benchmarks", "quality", "scores", "gsm8k")) if isinstance(metric(item, "benchmarks", "quality", "scores"), dict) else None, reverse=True)
        if best_gsm8k and metric(best_gsm8k, "benchmarks", "quality", "scores", "gsm8k"):
            lines.append(f"- Best GSM8K: **{best_gsm8k['modelLabel']}** ({format_metric(as_float(metric(best_gsm8k, 'benchmarks', 'quality', 'scores', 'gsm8k')))} acc)")
        if best_overall and metric(best_overall, "benchmarks", "quality", "overallAverage"):
            lines.append(f"- Best Overall: **{best_overall['modelLabel']}** ({format_metric(as_float(metric(best_overall, 'benchmarks', 'quality', 'overallAverage')))} weighted)")
        if agentic_pass:
            labels = ", ".join(str(payload.get("modelLabel") or payload.get("modelKey")) for payload in agentic_pass[:5])
            lines.append(f"- Agentic passes: **{labels}**")
        elif payloads:
            lines.append("- Agentic passes: none yet")

        atomic_write_text(self.config.summary_path, "\n".join(lines).rstrip() + "\n")


def truncate(value: str, length: int) -> str:
    if len(value) <= length:
        return value
    return value[: length - 1] + "…"


def avg(values: Iterable[float | None]) -> float | None:
    materialized = [value for value in values if value is not None]
    if not materialized:
        return None
    return sum(materialized) / len(materialized)


def best_payload(payloads: list[dict[str, Any]], key_fn: Any, *, reverse: bool) -> dict[str, Any] | None:
    ranked = [(payload, key_fn(payload)) for payload in payloads]
    ranked = [(payload, value) for payload, value in ranked if value is not None]
    if not ranked:
        return None
    ranked.sort(key=lambda item: item[1], reverse=reverse)
    return ranked[0][0]


def format_metric(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.3f}".rstrip("0").rstrip(".")


def print_plan(models: list[ModelSpec], slots: list[Slot], config: RunnerConfig) -> None:
    if not models:
        print("No models matched the current filters.")
        return
    print(f"Selected {len(models)} model(s):")
    if config.selected_slot:
        print(f"Pinned benchmark slot: {config.selected_slot}")
    for index, model in enumerate(models):
        slot = slots[index % len(slots)]
        print(
            f"- {model.label} [{model.runtime}/{model.launcher}] -> {slot.name} "
            f"(launch_ref={model.launch_ref}, result_dir={config.results_dir / model.result_dir_name})"
        )


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    config = build_config(args)
    slots = discover_slots(config.slot_count, config.selected_slot)
    models = discover_models()
    selected = resolve_models(models, config)

    if args.discover_json:
        print(json.dumps(model_inventory_json(selected), indent=2, ensure_ascii=False))
        return 0

    print(f"Discovered {len(models)} model(s); selected {len(selected)}.")
    if config.dry_run:
        print_plan(selected, slots, config)
        return 0
    if not selected:
        print("No models matched the current filters.", file=sys.stderr)
        return 1

    runner = BenchmarkRunner(config, slots)
    try:
        return runner.run(selected, models)
    except InterruptRequested as exc:
        return int(exc.code) if isinstance(exc.code, int) else 130


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
