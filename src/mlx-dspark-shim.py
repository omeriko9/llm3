#!/usr/bin/env python3
"""llm3 start-up shim for mlx-dspark: first-token logprobs in the dflash mode.

READ docs/DECIDE_ENDPOINT.md BEFORE YOU CHANGE THIS FILE OR UPDATE mlx-dspark.

Why it exists
-------------
POST /v1/decide (src/slot_decide.py) needs the log-probabilities of the first
output token. mlx-dspark accepts `logprobs` / `top_logprobs`, but only
`greedy_generate` and `speculative_generate` use them. `dflash_generate` has no
`logprobs` parameter and the server does not pass one, so in the dflash mode the
response silently has no `logprobs` key. Verified on 0.15.1 (installed) and on
0.19.0 (upstream main, 2026-09-10). DFlash is the fast mode for Qwen3.8 on this
hardware, so a change of mode is not an acceptable answer.

What it does
------------
It edits NO file of the package. bin/run-mlx-dspark-api.sh runs this file in
place of the `mlx-dspark` console script. It replaces three names in memory and
then calls the usual `mlx_dspark.cli.main()`:

  1. `Engine._generate_impl_inner` records the `logprobs` value of the request.
  2. `generate._pick` selects the first token from the prefill logits in every
     generator. On its first call in a request that asked for logprobs, the
     shim sends the same logits row to the package's own `_logprobs_for_block`.
  3. `server.dflash_generate` puts that one entry into `GenResult.logprobs`.
     The server then writes the usual OpenAI `logprobs` block.

All generation runs on the one generation thread of the server, so no lock is
necessary. Limit: in the dflash mode only the FIRST token gets logprobs. That is
all that a decision call reads.

How it stays safe across package updates
----------------------------------------
`inspect_package()` does a check of every name and signature before it changes
anything, and the result is one of:

  active        the shim is installed
  native        `dflash_generate` has a `logprobs` parameter: upstream supports
                it now. The shim changes nothing. Delete the shim (see the doc).
  incompatible  a name or a signature moved. The shim changes nothing.
  disabled      LLM3_DSPARK_SHIM=0

In every case the server starts. When the shim is not active and upstream is
not native, /v1/decide falls back to the "greedy" method and
GET /llm3/capabilities reports it. The status goes to stderr (the slot log) as
one `[llm3-shim]` line and, when LLM3_DSPARK_SHIM_STATUS_FILE is set, to that
file as JSON.
"""

import inspect
import json
import os
import sys
import threading
import time

SHIM_VERSION = 1
_STATE = threading.local()


def shim_enabled() -> bool:
    return str(os.environ.get("LLM3_DSPARK_SHIM", "1")).strip().lower() not in {"0", "false", "no", "off"}


def inspect_package(generate, server) -> "tuple[str, str]":
    """Return (status, reason). Changes nothing."""
    for name in ("dflash_generate", "_pick", "_logprobs_for_block", "GenResult"):
        if not hasattr(generate, name):
            return "incompatible", f"mlx_dspark.generate.{name} is not there"
    try:
        parameters = inspect.signature(generate.dflash_generate).parameters
    except (TypeError, ValueError) as exc:
        return "incompatible", f"dflash_generate has no readable signature: {exc}"
    if "logprobs" in parameters:
        return "native", "dflash_generate accepts logprobs: upstream supports it, the shim is not necessary"
    if "logprobs" not in getattr(generate.GenResult, "__dataclass_fields__", {}):
        return "incompatible", "GenResult has no logprobs field"
    if getattr(server, "dflash_generate", None) is not generate.dflash_generate:
        return "incompatible", "mlx_dspark.server does not import dflash_generate by name"
    engine = getattr(server, "Engine", None)
    inner = getattr(engine, "_generate_impl_inner", None)
    if inner is None:
        return "incompatible", "Engine._generate_impl_inner is not there"
    if "logprobs" not in inspect.signature(inner).parameters:
        return "incompatible", "Engine._generate_impl_inner has no logprobs parameter"
    try:
        source = inspect.getsource(generate.dflash_generate)
    except (OSError, TypeError):
        source = ""
    if "_pick(" not in source:
        return "incompatible", "dflash_generate does not select its first token with _pick"
    return "active", "first-token logprobs for the dflash mode"


def install(generate, server) -> None:
    original_pick = generate._pick
    original_dflash = generate.dflash_generate
    original_inner = server.Engine._generate_impl_inner
    inner_signature = inspect.signature(original_inner)

    def pick(logits_row, *args, **kwargs):
        token = original_pick(logits_row, *args, **kwargs)
        wanted = getattr(_STATE, "wanted", None)
        if wanted is not None and getattr(_STATE, "first", None) is None and getattr(_STATE, "in_dflash", False):
            try:
                _STATE.first = generate._logprobs_for_block(logits_row[None, :], [token], wanted)
            except Exception as exc:  # never break generation for a logprob
                _STATE.first = []
                print(f"[llm3-shim] logprobs read failed: {exc!r}", file=sys.stderr, flush=True)
        return token

    def dflash_generate(*args, **kwargs):
        _STATE.in_dflash = True
        _STATE.first = None
        try:
            result = original_dflash(*args, **kwargs)
        finally:
            _STATE.in_dflash = False
        first = getattr(_STATE, "first", None)
        if first and getattr(result, "logprobs", None) is None:
            result.logprobs = first
        return result

    def generate_impl_inner(self, *args, **kwargs):
        try:
            bound = inner_signature.bind(self, *args, **kwargs)
            _STATE.wanted = bound.arguments.get("logprobs")
        except TypeError:
            _STATE.wanted = None
        try:
            return original_inner(self, *args, **kwargs)
        finally:
            _STATE.wanted = None

    generate._pick = pick
    server.dflash_generate = dflash_generate
    server.Engine._generate_impl_inner = generate_impl_inner


def report(status: str, reason: str, package_version: str) -> None:
    print(
        f"[llm3-shim] {status}: {reason} (mlx-dspark {package_version}, shim v{SHIM_VERSION})",
        file=sys.stderr,
        flush=True,
    )
    path = str(os.environ.get("LLM3_DSPARK_SHIM_STATUS_FILE") or "").strip()
    if not path:
        return
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "status": status,
                    "reason": reason,
                    "packageVersion": package_version,
                    "shimVersion": SHIM_VERSION,
                    "checkedAt": round(time.time() * 1000),
                },
                handle,
            )
    except OSError as exc:
        print(f"[llm3-shim] status file not written: {exc}", file=sys.stderr, flush=True)


def prepare() -> str:
    """Do the check and install the shim when it applies. Never raises."""
    package_version = "unknown"
    try:
        from importlib.metadata import version

        package_version = version("mlx-dspark")
    except Exception:
        pass
    if not shim_enabled():
        report("disabled", "LLM3_DSPARK_SHIM=0", package_version)
        return "disabled"
    try:
        import mlx_dspark.generate as generate
        import mlx_dspark.server as server

        status, reason = inspect_package(generate, server)
        if status == "active":
            install(generate, server)
    except Exception as exc:
        status, reason = "incompatible", f"the check failed: {exc!r}"
    report(status, reason, package_version)
    return status


if __name__ == "__main__":
    prepare()
    from mlx_dspark.cli import main

    sys.argv[0] = "mlx-dspark"
    sys.exit(main())
