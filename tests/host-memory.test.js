"use strict";
// Host memory sampling for the benchmarks (src/host-memory.js): the vm_stat
// arithmetic must match getMemoryStats() in server.js, and the summary has to
// keep "baseline" (slot empty), "peak" and "average while working" apart.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseVmStat,
  hostUsedBytesFromVmStat,
  summarizeMemorySamples,
  createMemorySampler,
} = require("../src/host-memory");

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               100000.
Pages active:                             400000.
Pages inactive:                           300000.
Pages speculative:                         20000.
Pages throttled:                               0.
Pages wired down:                         500000.
Pages purgeable:                            1000.
"Translation faults":                  123456789.
Pages copy-on-write:                     1234567.
Pages zero filled:                     123456789.
Pages reactivated:                       1234567.
Pages purged:                             123456.
File-backed pages:                        600000.
Anonymous pages:                          120000.
Pages stored in compressor:                50000.
Pages occupied by compressor:              10000.
`;

test("vm_stat is read the way the Memory gauge reads it", () => {
  const pages = parseVmStat(VM_STAT);
  assert.equal(pages.pageSize, 16384);
  assert.equal(pages.wired, 500000);
  assert.equal(pages.anonymous, 120000);
  assert.equal(pages.fileBacked, 600000);
  assert.equal(pages.compressed, 10000);
  // wired + anonymous + compressed; the file-backed cache is not "used".
  assert.equal(hostUsedBytesFromVmStat(VM_STAT, 128 * 1024 ** 3), (500000 + 120000 + 10000) * 16384);
});

test("a vm_stat without the anonymous/file-backed split falls back to the queue arithmetic", () => {
  const legacy = VM_STAT.split("\n").filter((line) => !/^(File-backed|Anonymous)/.test(line)).join("\n");
  const total = 128 * 1024 ** 3;
  assert.equal(hostUsedBytesFromVmStat(legacy, total), total - (100000 + 300000 + 20000) * 16384);
  assert.equal(hostUsedBytesFromVmStat("", total), null);
});

test("the summary keeps baseline, peak and working average apart", () => {
  const GB = 1024 ** 3;
  const summary = summarizeMemorySamples({
    // The previous model unloads during the load window: its trough is the baseline.
    loadSamples: [50 * GB, 31 * GB, 30 * GB, 45 * GB, 60 * GB],
    workSamples: [52 * GB, 54 * GB, 56 * GB],
    otherSlots: ["slot1"],
  });
  assert.equal(summary.method, "host-used");
  assert.equal(summary.baselineBytes, 30 * GB);
  // The 50 GB and 60 GB load readings still hold the previous model's pages,
  // so the peak comes from the work phase only.
  assert.equal(summary.peakBytes, 56 * GB, "the peak ignores load-phase readings");
  assert.equal(summary.avgBytes, 54 * GB, "the average covers the working samples only");
  assert.equal(summary.footprintPeakBytes, 26 * GB);
  assert.equal(summary.footprintAvgBytes, 24 * GB);
  assert.equal(summary.samples, 8);
  assert.deepEqual(summary.otherSlots, ["slot1"]);
  assert.equal(summarizeMemorySamples({}), null);
});

test("the sampler reads while running and stops when told", async () => {
  const readings = [10, 5, 20, 30, 25, 25, 25, 25, 25, 25];
  let index = 0;
  const sampler = createMemorySampler({
    intervalMs: 20,
    slotId: "slot9",
    read: async () => readings[Math.min(index++, readings.length - 1)],
  });
  await sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await sampler.ready();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const summary = await sampler.stop();
  const frozen = index;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(index, frozen, "no reads after stop()");
  assert.equal(summary.baselineBytes, 5);
  assert.ok(summary.peakBytes >= 25);
  assert.ok(summary.workSamples >= 2);
  assert.ok(Array.isArray(summary.otherSlots));
});
