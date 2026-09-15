#!/usr/bin/env python3
"""Size llama.cpp's prompt cache from what the machine can actually spare.

`--cache-ram` defaults to 8192 MiB **per server**. Nothing scales that by how
many servers are running, so two loaded slots quietly commit 16 GiB of prompt
cache on top of weights, KV and compute buffers. On 2026-09-10 that was part of
a machine sitting at 97 percent with both models loaded.

The obvious fix -- predict each model's footprint and subtract -- runs straight
into the reason this was hard to diagnose in the first place. KV size is not
derivable from GGUF metadata in any general way: Gemma4 stores
`attention.head_count_kv` as a per-layer array and uses sliding-window attention
with its own key/value lengths, so `ctx x layers x heads x (k+v)` is badly wrong,
and reproducing llama.cpp's allocator here would rot on the next architecture.

So this does not predict. It measures:

* Before launch the caller records a memory baseline.
* The moment the backend answers, the caller records the delta. That delta is
  weights + KV + compute buffers, with the prompt cache still empty -- exactly
  the number we want and the one nobody can compute.
* The value is kept per (model, context, cache types) and used to size the next
  launch of that same configuration.

The first launch of an unseen model has no measurement, so it assumes the
footprint is twice the weights. That is deliberately pessimistic: a wrong guess
then costs a smaller prompt cache, never an out-of-memory.

**The cache is never sized above llama.cpp's own 8192 MiB default.** This can
only lower memory pressure relative to today, never raise it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

MIB = 1024 * 1024
GIB = 1024 * MIB

# llama.cpp's own default. Never exceed it: this must not be able to make the
# machine tighter than it already is.
CACHE_RAM_CEILING_MIB = 8192
# Below this the cache cannot hold even one agent prompt -- slot 2's evictions
# on 2026-09-10 ran 1.6-4.8 GiB per entry -- so it would cost memory and return
# nothing. Under the floor the cache is disabled outright (llama.cpp reads 0 as
# "off"), which is the right answer on a machine with no room: it costs
# recompute, where over-committing costs the whole slot to an out-of-memory.
CACHE_RAM_FLOOR_MIB = 1024
# Share of what is genuinely spare that the prompt cache may take. The rest is
# left for the other slot to grow into and for whatever else the user runs.
SPARE_SHARE = 0.5
# Never plan the machine down to nothing, whatever the arithmetic says.
MIN_HEADROOM_BYTES = 8 * GIB
HEADROOM_FRACTION = 0.06
# Used only until a real measurement exists for a configuration.
UNMEASURED_FOOTPRINT_MULTIPLIER = 2.0
# A measured delta outside this band around the weights is not this model
# loading -- it is other activity on the machine -- so it is not recorded.
PLAUSIBLE_FOOTPRINT_RANGE = (0.5, 4.0)


# ── Reading the machine ────────────────────────────────────────────────

def total_memory_bytes() -> int:
    out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


def _vm_stat_pages() -> tuple[dict[str, int], int]:
    out = subprocess.run(["vm_stat"], capture_output=True, text=True, check=True).stdout
    page_size = 4096
    header = re.search(r"page size of (\d+) bytes", out)
    if header:
        page_size = int(header.group(1))
    pages: dict[str, int] = {}
    for line in out.splitlines():
        if ":" not in line:
            continue
        name, _, value = line.partition(":")
        digits = value.strip().rstrip(".")
        if digits.isdigit():
            pages[name.strip().lower()] = int(digits)
    return pages, page_size


def memory_snapshot() -> dict[str, int]:
    """Committed memory, and what could still be handed out.

    "Committed" is wired + anonymous: the pages that cannot simply be dropped.
    A model's Metal buffers are wired, and wired memory belongs to no process,
    which is why this is read per machine and never per pid.
    """
    pages, page_size = _vm_stat_pages()
    get = lambda key: pages.get(key, 0) * page_size
    wired = get("pages wired down")
    anonymous = get("anonymous pages")
    compressed = get("pages occupied by compressor")
    committed = wired + anonymous + compressed
    # Deliberately the same definition the RAM badge uses in src/server.js
    # (getMemoryStats): available = total - (wired + app memory + compressed).
    # Clean file-backed pages are reclaimable and so are genuinely available
    # too, but counting them would make the planner reason in different units
    # from the number the user is looking at, and it errs generous -- a planner
    # that overestimates room is the failure that costs a slot.
    total = total_memory_bytes()
    return {
        "committed_bytes": committed,
        "available_bytes": max(0, total - committed),
        "wired_bytes": wired,
        "anonymous_bytes": anonymous,
        "compressed_bytes": compressed,
        "cached_files_bytes": get("file-backed pages"),
    }


# ── The store of measured footprints ───────────────────────────────────

def footprint_key(model_file: str, ctx: int, cache_type_k: str, cache_type_v: str) -> str:
    return "|".join([
        os.path.realpath(os.path.expanduser(model_file)),
        str(int(ctx)),
        str(cache_type_k or ""),
        str(cache_type_v or ""),
    ])


def store_path(state_root: str) -> Path:
    return Path(os.path.expanduser(state_root)) / "model-footprints.json"


def read_store(state_root: str) -> dict:
    try:
        payload = json.loads(store_path(state_root).read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def write_store(state_root: str, payload: dict) -> None:
    path = store_path(state_root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".json.tmp")
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2, sort_keys=True)
        os.replace(temp_name, path)
    except Exception as exc:  # noqa: BLE001 - a launch must never fail over bookkeeping
        print(f"llm3_cache_budget: could not write the footprint store: {exc}", file=sys.stderr)


# ── The decision ───────────────────────────────────────────────────────

def plan_cache_ram_mib(
    *,
    total_bytes: int,
    available_bytes: int,
    weights_bytes: int,
    measured_footprint_bytes: int | None = None,
) -> tuple[int, dict]:
    """Return (MiB for --cache-ram, the reasoning behind it).

    Everything is derived from memory that is free *now*, so a slot starting
    second automatically sees what the first one already took. No slot needs to
    know about any other slot.
    """
    predicted = (
        int(measured_footprint_bytes)
        if measured_footprint_bytes and measured_footprint_bytes > 0
        else int(weights_bytes * UNMEASURED_FOOTPRINT_MULTIPLIER)
    )
    headroom = max(MIN_HEADROOM_BYTES, int(total_bytes * HEADROOM_FRACTION))
    spare = available_bytes - predicted - headroom
    raw_mib = int(max(0, spare) * SPARE_SHARE) // MIB
    capped_mib = min(CACHE_RAM_CEILING_MIB, raw_mib)
    cache_mib = capped_mib if capped_mib >= CACHE_RAM_FLOOR_MIB else 0
    return cache_mib, {
        "predicted_footprint_bytes": predicted,
        "predicted_from": "measurement" if measured_footprint_bytes else "weights x 2 (never measured)",
        "weights_bytes": int(weights_bytes),
        "available_bytes": int(available_bytes),
        "headroom_bytes": headroom,
        "spare_bytes": int(spare),
        "cache_ram_mib": cache_mib,
        "ceiling_mib": CACHE_RAM_CEILING_MIB,
    }


def plausible_footprint(delta_bytes: int, weights_bytes: int) -> bool:
    if delta_bytes <= 0 or weights_bytes <= 0:
        return False
    low, high = PLAUSIBLE_FOOTPRINT_RANGE
    return weights_bytes * low <= delta_bytes <= weights_bytes * high


def weights_bytes_for(model_file: str, mmproj_file: str = "") -> int:
    total = 0
    for path in (model_file, mmproj_file):
        if not path:
            continue
        try:
            total += os.path.getsize(os.path.expanduser(path))
        except OSError:
            pass
    return total


# ── CLI, for the launcher ──────────────────────────────────────────────

def _cmd_plan(args) -> int:
    weights = weights_bytes_for(args.model_file, args.mmproj_file)
    store = read_store(args.state_root)
    key = footprint_key(args.model_file, args.ctx, args.cache_type_k, args.cache_type_v)
    entry = store.get(key) or {}
    measured = int(entry.get("footprint_bytes") or 0) or None
    snapshot = memory_snapshot()
    cache_mib, why = plan_cache_ram_mib(
        total_bytes=total_memory_bytes(),
        available_bytes=snapshot["available_bytes"],
        weights_bytes=weights,
        measured_footprint_bytes=measured,
    )
    if args.explain:
        json.dump(why, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(cache_mib)
    return 0


def _cmd_baseline(args) -> int:
    json.dump(memory_snapshot(), sys.stdout)
    sys.stdout.write("\n")
    return 0


def _cmd_record(args) -> int:
    try:
        baseline = json.loads(Path(args.baseline_file).read_text(encoding="utf-8"))
    except Exception:
        return 0
    delta = memory_snapshot()["committed_bytes"] - int(baseline.get("committed_bytes") or 0)
    weights = weights_bytes_for(args.model_file, args.mmproj_file)
    if not plausible_footprint(delta, weights):
        # Other activity moved the number more than this model did. Keeping a
        # bad measurement would be worse than keeping none.
        return 0
    store = read_store(args.state_root)
    store[footprint_key(args.model_file, args.ctx, args.cache_type_k, args.cache_type_v)] = {
        "footprint_bytes": int(delta),
        "weights_bytes": int(weights),
        "ctx": int(args.ctx),
        "measured_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
    }
    write_store(args.state_root, store)
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("--model-file", required=True)
        p.add_argument("--mmproj-file", default="")
        p.add_argument("--ctx", type=int, required=True)
        p.add_argument("--cache-type-k", default="")
        p.add_argument("--cache-type-v", default="")
        p.add_argument("--state-root", default="~/.local/state/qwen_llama")

    p_plan = sub.add_parser("plan", help="print the MiB to pass to --cache-ram")
    common(p_plan)
    p_plan.add_argument("--explain", action="store_true")
    p_plan.set_defaults(func=_cmd_plan)

    p_base = sub.add_parser("baseline", help="print a memory snapshot to compare against later")
    p_base.set_defaults(func=_cmd_baseline)

    p_rec = sub.add_parser("record", help="measure this model's footprint against a baseline")
    common(p_rec)
    p_rec.add_argument("--baseline-file", required=True)
    p_rec.set_defaults(func=_cmd_record)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
