"""Host memory sampling while a model is benchmarked.

The Python twin of src/host-memory.js; both write the same `memory` shape.

A model's own memory cannot be read off its process on this machine: llama.cpp
and MLX put weights and KV cache in Metal buffers, which are WIRED pages that
macOS attributes to no process, so `ps` RSS and `footprint` miss almost all of
it. What is measured is the whole host, with the formula getMemoryStats() in
src/server.js uses (Activity Monitor's "Memory Used"): wired + anonymous +
compressed pages from vm_stat. The page cache holding mmapped weight files is
left out, because the kernel hands it back the moment anything asks for it.

The runner loads one model at a time, so host used while the model works minus
host used with its slot empty is that model's footprint. Both sides are
recorded, with the other slots that were serving at the time, because a model
in another slot growing its KV cache lands in the same number.
"""
from __future__ import annotations

import os
import re
import socket
import subprocess
import threading
import time
from typing import Any, Callable

SAMPLE_INTERVAL_SECONDS = 1.0
# Public slot ports: slotN answers on 8036 + (N - 1).
SLOT_PORT_BASE = 8036
SLOT_COUNT = 4


def parse_vm_stat(text: str) -> dict[str, int]:
    size_match = re.search(r"page size of (\d+) bytes", text or "")
    pages = {
        "pageSize": int(size_match.group(1)) if size_match else 4096,
        "free": 0,
        "inactive": 0,
        "speculative": 0,
        "wired": 0,
        "compressed": 0,
        "fileBacked": 0,
        "anonymous": 0,
    }
    labels = {
        "free": "free",
        "inactive": "inactive",
        "speculative": "speculative",
        "wired down": "wired",
        "occupied by compressor": "compressed",
    }
    for line in (text or "").splitlines():
        match = re.match(r"^Pages (.+?):\s+([0-9.]+)", line)
        if match:
            key = labels.get(match.group(1).strip().lower())
            if key:
                pages[key] = int(float(match.group(2).rstrip(".")))
            continue
        split = re.match(r"^(File-backed|Anonymous) pages:\s+([0-9.]+)", line)
        if split:
            key = "fileBacked" if split.group(1) == "File-backed" else "anonymous"
            pages[key] = int(float(split.group(2).rstrip(".")))
    return pages


def total_memory_bytes() -> int | None:
    try:
        return int(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"))
    except (ValueError, OSError, AttributeError):
        return None


def host_used_bytes_from_vm_stat(text: str, total_bytes: int | None = None) -> int | None:
    pages = parse_vm_stat(text)
    size = pages["pageSize"]
    if pages["fileBacked"] > 0 or pages["anonymous"] > 0:
        return (pages["wired"] + pages["anonymous"] + pages["compressed"]) * size
    # The same fallback as getMemoryStats() for a vm_stat without the split.
    total = total_bytes if total_bytes is not None else total_memory_bytes()
    if not total or (not pages["wired"] and not pages["free"]):
        return None
    return max(0, total - (pages["free"] + pages["inactive"] + pages["speculative"]) * size)


def read_host_used_bytes() -> int | None:
    try:
        result = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return host_used_bytes_from_vm_stat(result.stdout)


def port_answers(port: int, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def other_slots_listening(slot_name: str) -> list[str]:
    digits = re.sub(r"\D", "", slot_name or "")
    own = int(digits) if digits else 0
    return [
        f"slot{index}"
        for index in range(1, SLOT_COUNT + 1)
        if index != own and port_answers(SLOT_PORT_BASE + index - 1)
    ]


def summarize_samples(
    load_samples: list[int],
    work_samples: list[int],
    *,
    interval_seconds: float = SAMPLE_INTERVAL_SECONDS,
    other_slots: list[str] | None = None,
    started_at: str | None = None,
    total_bytes: int | None = None,
) -> dict[str, Any] | None:
    samples = list(load_samples) + list(work_samples)
    if not samples:
        return None
    baseline = min(load_samples) if load_samples else None
    peak = max(samples)
    avg = round(sum(work_samples) / len(work_samples)) if work_samples else None

    def delta(value: int | None) -> int | None:
        return None if value is None or baseline is None else max(0, value - baseline)

    return {
        "method": "host-used",
        "intervalMs": int(interval_seconds * 1000),
        "samples": len(samples),
        "workSamples": len(work_samples),
        "totalBytes": total_bytes if total_bytes is not None else total_memory_bytes(),
        "baselineBytes": baseline,
        "peakBytes": peak,
        "avgBytes": avg,
        "footprintPeakBytes": delta(peak),
        "footprintAvgBytes": delta(avg),
        "otherSlots": list(other_slots or []),
        "startedAt": started_at,
    }


class HostMemorySampler:
    """Samples host used memory once a second from start() to stop().

    Two phases, because a load is not work. The baseline is the lowest reading
    before ready() -- the first one is taken with the slot empty -- the average
    covers only the readings after ready(), and the peak covers both, since a
    load can itself be the high point. pause()/resume() leave out the moments a
    slot is stopped and relaunched in the middle of a row.
    """

    def __init__(
        self,
        slot_name: str = "",
        *,
        interval_seconds: float = SAMPLE_INTERVAL_SECONDS,
        read: Callable[[], int | None] = read_host_used_bytes,
    ) -> None:
        self.slot_name = slot_name
        self.interval_seconds = interval_seconds
        self.read = read
        self.load_samples: list[int] = []
        self.work_samples: list[int] = []
        self.other_slots: list[str] = []
        self.phase = "idle"
        self.paused = False
        self.started_at: str | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def _sample(self) -> None:
        if self.paused or self.phase == "idle":
            return
        value = self.read()
        if not value or value <= 0:
            return
        with self._lock:
            (self.work_samples if self.phase == "work" else self.load_samples).append(int(value))

    def _loop(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            try:
                self._sample()
            except Exception:  # noqa: BLE001 - a sampling hiccup must never fail a row
                pass

    def start(self) -> None:
        self.phase = "load"
        self.started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._sample()
        self._thread = threading.Thread(target=self._loop, name="host-memory", daemon=True)
        self._thread.start()

    def ready(self) -> None:
        if self.phase == "work":
            return
        self.phase = "work"
        try:
            self.other_slots = other_slots_listening(self.slot_name)
        except Exception:  # noqa: BLE001
            self.other_slots = []
        self._sample()

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def stop(self) -> dict[str, Any] | None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self.interval_seconds * 3)
            self._thread = None
        self.phase = "idle"
        with self._lock:
            return summarize_samples(
                self.load_samples,
                self.work_samples,
                interval_seconds=self.interval_seconds,
                other_slots=self.other_slots,
                started_at=self.started_at,
            )
