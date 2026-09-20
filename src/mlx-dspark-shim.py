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
  2. `_pick` selects the first token from the prefill logits in every
     generator. On its first call in a request that asked for logprobs, the
     shim sends the same logits row to the package's own `_logprobs_for_block`.
     The hook goes into each module that holds the name (`generate`, `lookup`).
  3. `server.dflash_generate` and `server.lookup_generate` (SHIM_TARGETS) put
     that one entry into `GenResult.logprobs`. The server then writes the usual
     OpenAI `logprobs` block. v2 added the lookup mode, which `--mode auto`
     selects for a model with no drafter; v1 knew the dflash mode only.

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

SHIM_VERSION = 2
_STATE = threading.local()


def shim_enabled() -> bool:
    return str(os.environ.get("LLM3_DSPARK_SHIM", "1")).strip().lower() not in {"0", "false", "no", "off"}


# The generators that take no `logprobs` argument, as (module that defines it,
# function name). `generate.dflash_generate` is the dflash mode. `lookup.
# lookup_generate` is the lookup mode, which `--mode auto` resolves to for a
# model with no drafter. Each selects its first token with `_pick`, and each
# module holds its OWN `_pick` name (lookup.py imports it from generate), so the
# hook goes into the module where the generator looks the name up.
SHIM_TARGETS = (("generate", "dflash_generate"), ("lookup", "lookup_generate"))


def _target_status(module, name: str, server) -> "tuple[str, str]":
    function = getattr(module, name, None)
    if function is None:
        return "absent", f"{name} is not there"
    if not hasattr(module, "_pick"):
        return "incompatible", f"{module.__name__} has no _pick"
    try:
        parameters = inspect.signature(function).parameters
    except (TypeError, ValueError) as exc:
        return "incompatible", f"{name} has no readable signature: {exc}"
    if "logprobs" in parameters:
        return "native", f"{name} accepts logprobs"
    if getattr(server, name, None) is not function:
        return "incompatible", f"mlx_dspark.server does not import {name} by name"
    try:
        source = inspect.getsource(function)
    except (OSError, TypeError):
        source = ""
    if "_pick(" not in source:
        return "incompatible", f"{name} does not select its first token with _pick"
    return "active", name


def inspect_package(generate, server, lookup=None) -> "tuple[str, str, list]":
    """Return (status, reason, targets to install). Changes nothing."""
    for name in ("_pick", "_logprobs_for_block", "GenResult"):
        if not hasattr(generate, name):
            return "incompatible", f"mlx_dspark.generate.{name} is not there", []
    if "logprobs" not in getattr(generate.GenResult, "__dataclass_fields__", {}):
        return "incompatible", "GenResult has no logprobs field", []
    engine = getattr(server, "Engine", None)
    inner = getattr(engine, "_generate_impl_inner", None)
    if inner is None:
        return "incompatible", "Engine._generate_impl_inner is not there", []
    if "logprobs" not in inspect.signature(inner).parameters:
        return "incompatible", "Engine._generate_impl_inner has no logprobs parameter", []
    modules = {"generate": generate, "lookup": lookup}
    found = {}
    for module_name, name in SHIM_TARGETS:
        module = modules.get(module_name)
        if module is not None:
            found[name] = (module, *_target_status(module, name, server))
    active = [(module, name) for name, (module, status, _detail) in found.items() if status == "active"]
    detail = ", ".join(f"{name}: {status}" for name, (_module, status, _detail) in found.items())
    if active:
        return "active", f"first-token logprobs ({detail})", active
    if found and all(status in {"native", "absent"} for _m, status, _d in found.values()) and any(
        status == "native" for _m, status, _d in found.values()
    ):
        return "native", f"upstream supports it, the shim is not necessary ({detail})", []
    reasons = "; ".join(d for _m, status, d in found.values() if status == "incompatible") or "no generator to patch"
    return "incompatible", reasons, []


def install(generate, server, targets) -> None:
    original_inner = server.Engine._generate_impl_inner
    inner_signature = inspect.signature(original_inner)

    def make_pick(original_pick):
        def pick(logits_row, *args, **kwargs):
            token = original_pick(logits_row, *args, **kwargs)
            wanted = getattr(_STATE, "wanted", None)
            if wanted is not None and getattr(_STATE, "first", None) is None and getattr(_STATE, "in_target", False):
                try:
                    _STATE.first = generate._logprobs_for_block(logits_row[None, :], [token], wanted)
                except Exception as exc:  # never break generation for a logprob
                    _STATE.first = []
                    print(f"[llm3-shim] logprobs read failed: {exc!r}", file=sys.stderr, flush=True)
            return token

        return pick

    def make_generator(original):
        def generator(*args, **kwargs):
            _STATE.in_target = True
            _STATE.first = None
            try:
                result = original(*args, **kwargs)
            finally:
                _STATE.in_target = False
            first = getattr(_STATE, "first", None)
            if first and getattr(result, "logprobs", None) is None:
                result.logprobs = first
            return result

        generator.__name__ = getattr(original, "__name__", "generator")
        return generator

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

    hooked = set()
    for module, name in targets:
        if id(module) not in hooked:  # one hook for each module, whatever it shares with another
            module._pick = make_pick(module._pick)
            hooked.add(id(module))
        setattr(server, name, make_generator(getattr(module, name)))
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

        try:
            import mlx_dspark.lookup as lookup
        except Exception:
            lookup = None
        status, reason, targets = inspect_package(generate, server, lookup)
        if status == "active":
            install(generate, server, targets)
    except Exception as exc:
        status, reason = "incompatible", f"the check failed: {exc!r}"
    report(status, reason, package_version)
    return status


if __name__ == "__main__":
    prepare()
    from mlx_dspark.cli import main

    sys.argv[0] = "mlx-dspark"
    sys.exit(main())
