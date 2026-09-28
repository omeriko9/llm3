// Host memory sampling for the benchmarks.
//
// A model's own memory cannot be read off its process on this machine:
// llama.cpp and MLX put their weights and KV cache in Metal buffers, which are
// WIRED pages that macOS attributes to no process, so `ps` RSS and `footprint`
// both miss almost all of it. What can be measured is the whole host. "Used"
// here is the same figure getMemoryStats() in server.js reports and Activity
// Monitor calls Memory Used -- wired + anonymous + compressed, from vm_stat --
// and the page cache holding mmapped weight files is left out, because the
// kernel hands those pages back the moment anything asks for them.
//
// A benchmark loads one model at a time, so "host used while the model works"
// minus "host used just before it loaded" is that model's footprint. The
// sampler records both sides and leaves the subtraction to whoever displays it,
// together with which other slots were serving at the time, because a second
// model growing its KV cache during the run lands in the same number.
const { execFile } = require("child_process");
const net = require("net");
const os = require("os");

const SAMPLE_INTERVAL_MS = 1000;
// Public slot ports: slotN answers on 8036 + (N - 1).
const SLOT_PORT_BASE = 8036;
const SLOT_COUNT = 4;

// vm_stat prints "Pages wired down:  123." plus two lines ("File-backed
// pages:", "Anonymous pages:") that do not start with "Pages".
function parseVmStat(stdout) {
  const text = String(stdout || "");
  const sizeMatch = text.match(/page size of (\d+) bytes/);
  const pages = {
    pageSize: sizeMatch ? Number(sizeMatch[1]) : 4096,
    free: 0,
    inactive: 0,
    speculative: 0,
    wired: 0,
    compressed: 0,
    fileBacked: 0,
    anonymous: 0,
  };
  for (const line of text.split("\n")) {
    const match = line.match(/^Pages (.+?):\s+([0-9.]+)/);
    if (match) {
      const label = match[1].trim().toLowerCase();
      const value = Number(match[2].replace(/\.$/, ""));
      if (label === "free") pages.free = value;
      if (label === "inactive") pages.inactive = value;
      if (label === "speculative") pages.speculative = value;
      if (label === "wired down") pages.wired = value;
      if (label === "occupied by compressor") pages.compressed = value;
      continue;
    }
    const split = line.match(/^(File-backed|Anonymous) pages:\s+([0-9.]+)/);
    if (split) {
      const value = Number(split[2].replace(/\.$/, ""));
      if (split[1] === "File-backed") pages.fileBacked = value;
      if (split[1] === "Anonymous") pages.anonymous = value;
    }
  }
  return pages;
}

// Same formula as getMemoryStats(), including its fallback for a vm_stat that
// stops printing the anonymous/file-backed split.
function hostUsedBytesFromVmStat(stdout, totalBytes = os.totalmem()) {
  const pages = parseVmStat(stdout);
  if (pages.fileBacked > 0 || pages.anonymous > 0) {
    return (pages.wired + pages.anonymous + pages.compressed) * pages.pageSize;
  }
  if (!pages.wired && !pages.free) {
    return null;
  }
  return Math.max(0, totalBytes - (pages.free + pages.inactive + pages.speculative) * pages.pageSize);
}

function readHostUsedBytes() {
  return new Promise((resolve) => {
    execFile("vm_stat", [], { maxBuffer: 256 * 1024, timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : hostUsedBytesFromVmStat(stdout));
    });
  });
}

function portAnswers(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// Which other LLM slots have something listening. A listener is not proof of
// a loaded model, but an empty port is proof of none, which is what the note
// in the tooltip needs.
async function otherSlotsListening(slotId) {
  const own = Number(String(slotId || "").replace(/\D/g, "")) || 0;
  const checks = [];
  for (let index = 1; index <= SLOT_COUNT; index += 1) {
    if (index !== own) {
      checks.push(portAnswers(SLOT_PORT_BASE + index - 1).then((open) => (open ? `slot${index}` : null)));
    }
  }
  return (await Promise.all(checks)).filter(Boolean);
}

// Samples every intervalMs from start() to stop(). Two phases, because a load
// is not work: the baseline is the LOWEST reading before the model was ready
// (the slot's previous model is unloaded inside that window, so its trough is
// the empty-slot level), the average covers only the readings after ready(),
// and the peak covers both, since a load can itself be the high point.
function createMemorySampler({ intervalMs = SAMPLE_INTERVAL_MS, read = readHostUsedBytes, slotId = "" } = {}) {
  const loadSamples = [];
  const workSamples = [];
  let timer = null;
  let phase = "idle";
  let otherSlots = [];
  let startedAt = null;
  let inFlight = false;

  async function tick() {
    if (inFlight || phase === "idle") {
      return;
    }
    inFlight = true;
    try {
      const value = await read();
      if (Number.isFinite(value) && value > 0) {
        (phase === "work" ? workSamples : loadSamples).push(value);
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    async start() {
      phase = "load";
      startedAt = Date.now();
      await tick();
      timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    },
    async ready() {
      phase = "work";
      otherSlots = await otherSlotsListening(slotId).catch(() => []);
      await tick();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (phase === "work") {
        await tick();
      }
      phase = "idle";
      return summarizeMemorySamples({ loadSamples, workSamples, intervalMs, otherSlots, startedAt });
    },
  };
}

function summarizeMemorySamples({ loadSamples = [], workSamples = [], intervalMs = SAMPLE_INTERVAL_MS, otherSlots = [], startedAt = null } = {}) {
  const all = [...loadSamples, ...workSamples];
  if (!all.length) {
    return null;
  }
  const baselineBytes = loadSamples.length ? Math.min(...loadSamples) : null;
  const peakBytes = Math.max(...all);
  const avgBytes = workSamples.length
    ? Math.round(workSamples.reduce((total, value) => total + value, 0) / workSamples.length)
    : null;
  const delta = (value) => (value == null || baselineBytes == null ? null : Math.max(0, value - baselineBytes));
  return {
    method: "host-used",
    intervalMs,
    samples: all.length,
    workSamples: workSamples.length,
    totalBytes: os.totalmem(),
    baselineBytes,
    peakBytes,
    avgBytes,
    footprintPeakBytes: delta(peakBytes),
    footprintAvgBytes: delta(avgBytes),
    otherSlots,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
  };
}

module.exports = {
  SAMPLE_INTERVAL_MS,
  parseVmStat,
  hostUsedBytesFromVmStat,
  readHostUsedBytes,
  otherSlotsListening,
  createMemorySampler,
  summarizeMemorySamples,
};
