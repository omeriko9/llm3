"use strict";
// A launch with several thinking modes runs as stages: every model without
// thinking, then every model with it. This drives two real (fake) runner
// processes through the dashboard's session machinery, and checks that "clear
// before run" deletes exactly the rows the launch is about to replace.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// voxel-test posts slot launches to 127.0.0.1:<PORT>; keep that off the live
// dashboard (see perf-dashboard-session.test.js).
process.env.PORT = process.env.LLM3_TEST_PORT || "9738";

const MODULE_PATH = require.resolve("../src/perf-dashboard-routes.js");

// Exits on its own after ~4s -- past the start-up stability wait -- so the
// next stage has to be spawned by the exit handler.
const QUICK_RUNNER = `#!/usr/bin/env python3
import json, sys, time
args = sys.argv[1:]
if "--discover-json" in args:
    print(json.dumps([{"label": "Fake Model", "key": "fake-model", "runtime": "gguf"}]))
    sys.exit(0)
print("quick runner args: " + " ".join(args), flush=True)
time.sleep(4)
print("quick runner: done", flush=True)
`;

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-bench-stages-"));
  await fs.mkdir(path.join(root, "voxel-results"), { recursive: true });
  await fs.mkdir(path.join(root, "results"), { recursive: true });
  await fs.writeFile(path.join(root, "benchmark_runner.py"), QUICK_RUNNER, "utf8");
  return root;
}

function loadRoutes(root) {
  process.env.LLM3_BENCHMARK_ROOT = root;
  process.env.LLM3_VOXEL_ROOT = path.join(root, "voxel-results");
  delete require.cache[MODULE_PATH];
  delete require.cache[require.resolve("../src/voxel-test.js")];
  return require(MODULE_PATH);
}

async function writeRow(root, dir, payload) {
  await fs.mkdir(path.join(root, "results", dir), { recursive: true });
  await fs.writeFile(path.join(root, "results", dir, "benchmark.json"), JSON.stringify({
    benchmarks: {},
    errors: [],
    timestamps: { started: "2026-09-01T00:00:00Z", stopped: "2026-09-01T01:00:00Z" },
    ...payload,
  }), "utf8");
}

async function exists(target) {
  return fs.stat(target).then(() => true, () => false);
}

async function waitFor(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("two thinking modes run as two runner passes, the second with effort and without switchless models", async (t) => {
  const root = await makeRoot();
  const routes = loadRoutes(root);
  t.after(async () => {
    await waitFor(async () => !(await routes.getBenchmarkStatus()).running, 15000);
    delete require.cache[MODULE_PATH];
    delete process.env.LLM3_BENCHMARK_ROOT;
    delete process.env.LLM3_VOXEL_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });

  // Rows the launch will replace (Fake Model, both buckets) and rows it must
  // leave alone (another model).
  await writeRow(root, "Fake Model__gguf__no-think", { modelLabel: "Fake Model", variant: "no-think" });
  await writeRow(root, "Fake Model__gguf__think", { modelLabel: "Fake Model", variant: "think" });
  await writeRow(root, "Other Model__gguf__no-think", { modelLabel: "Other Model", variant: "no-think" });

  const config = routes._test.normalizeLaunchConfig({
    models: ["Fake Model"],
    benchmarks: ["mmlu_pro"],
    modes: ["think", "no-think"],
    effort: "high",
    selectedSlot: "slot3",
  });
  const launched = await routes.startBenchmark(config);
  assert.deepEqual(launched.stages.map((stage) => `${stage.kind}:${stage.mode}:${stage.effort || "-"}`),
    ["runner:no-think:-", "runner:think:high"], "modes run in a fixed order, off first");
  assert.deepEqual(launched.cleared, { models: 1, resultDirs: 2, scenes: 0 });
  assert.equal(await exists(path.join(root, "results", "Fake Model__gguf__no-think")), false);
  assert.equal(await exists(path.join(root, "results", "Fake Model__gguf__think")), false);
  assert.equal(await exists(path.join(root, "results", "Other Model__gguf__no-think")), true, "other models keep their rows");

  const first = await routes.getBenchmarkStatus();
  assert.equal(first.running, true);
  assert.equal(first.stageIndex, 1);
  assert.equal(first.stageTotal, 2);
  assert.equal(first.stage.mode, "no-think");
  assert.equal(first.queuedStages.length, 1);

  assert.ok(await waitFor(async () => (await routes.getBenchmarkStatus()).stageIndex === 2), "the second pass starts when the first exits");
  assert.ok(await waitFor(async () => !(await routes.getBenchmarkStatus()).running), "the run ends after the last pass");

  const log = await fs.readFile(routes._test.runnerLogPath, "utf8");
  const passes = log.split("\n").filter((line) => line.startsWith("quick runner args:"));
  assert.equal(passes.length, 2);
  assert.match(passes[0], /--variant no-think/);
  assert.doesNotMatch(passes[0], /--reasoning-effort|--toggleable-only/);
  assert.match(passes[1], /--variant think/);
  assert.match(passes[1], /--reasoning-effort high/);
  assert.match(passes[1], /--toggleable-only/);
  assert.match(log, /=== stage 2\/2: benchmark, think \(high\) ===/);

  const after = await routes.getBenchmarkStatus();
  assert.equal(after.lastRun.stageTotal, 2);
  assert.deepEqual(after.lastRun.cleared, { models: 1, resultDirs: 2, scenes: 0 });
});

test("clearFirst false leaves the previous rows in place", async (t) => {
  const root = await makeRoot();
  const routes = loadRoutes(root);
  t.after(async () => {
    await waitFor(async () => !(await routes.getBenchmarkStatus()).running, 15000);
    delete require.cache[MODULE_PATH];
    delete process.env.LLM3_BENCHMARK_ROOT;
    delete process.env.LLM3_VOXEL_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeRow(root, "Fake Model__gguf__no-think", { modelLabel: "Fake Model", variant: "no-think" });
  const launched = await routes.startBenchmark(routes._test.normalizeLaunchConfig({
    models: ["Fake Model"],
    benchmarks: ["mmlu_pro"],
    modes: ["no-think"],
    clearFirst: false,
  }));
  assert.equal(launched.cleared, null);
  assert.equal(await exists(path.join(root, "results", "Fake Model__gguf__no-think")), true);
});
