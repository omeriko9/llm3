"use strict";
// Lifecycle of a benchmark run as the dashboard sees it: the runner is a
// detached process with its session persisted to benchmarks/.session, so a
// restarted server re-adopts it instead of killing or forgetting it. A fake
// benchmark_runner.py stands in for the real one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const MODULE_PATH = require.resolve("../src/perf-dashboard-routes.js");

const FAKE_RUNNER = `#!/usr/bin/env python3
import json, os, signal, sys, time
args = sys.argv[1:]
if "--discover-json" in args:
    print(json.dumps([{"label": "Fake Model", "key": "fake-model", "runtime": "gguf"}]))
    sys.exit(0)
root = os.path.join(os.getcwd(), "results", "fake-model__gguf")
os.makedirs(root, exist_ok=True)
state = {"modelLabel": "Fake Model", "modelKey": "fake-model", "benchmarks": {}, "errors": [],
         "timestamps": {"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, "resultDir": root}
def save():
    with open(os.path.join(root, "benchmark.json"), "w") as f:
        json.dump(state, f)
def stop(signum, frame):
    state["timestamps"]["stopped"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save()
    print("fake runner: stopped by signal", flush=True)
    sys.exit(130)
signal.signal(signal.SIGTERM, stop)
save()
print("fake runner: started", flush=True)
for i in range(600):
    print(f"fake runner: tick {i}", flush=True)
    time.sleep(0.1)
`;

async function makeBenchmarkRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-bench-session-"));
  await fs.mkdir(path.join(root, "voxel-results"), { recursive: true });
  await fs.writeFile(path.join(root, "benchmark_runner.py"), FAKE_RUNNER, "utf8");
  await fs.mkdir(path.join(root, "results"), { recursive: true });
  return root;
}

function loadRoutes(root) {
  process.env.LLM3_BENCHMARK_ROOT = root;
  // src/voxel-test.js keeps scene state under LLM3_VOXEL_ROOT, which is a
  // separate variable from the benchmark root. Without this a test that
  // resumes a scene queue writes into the real benchmarks/voxel-results and
  // starts a real scene run on a real slot.
  process.env.LLM3_VOXEL_ROOT = path.join(root, "voxel-results");
  delete require.cache[MODULE_PATH];
  delete require.cache[require.resolve("../src/voxel-test.js")];
  return require(MODULE_PATH);
}

function killQuietly(pid) {
  try { process.kill(pid, "SIGKILL"); } catch {}
}

// Kill and wait for the process to actually go: a fake runner writes into its
// results directory in a loop, so removing that directory while it still lives
// fails with ENOTEMPTY.
async function killAndWait(pid) {
  if (!pid) return;
  killQuietly(pid);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

// These tests spawn real processes, so every wait is wall-clock. The margins
// are generous on purpose: a loaded or slower machine (CI) must not fail a test
// that is only waiting for a fork to be scheduled.
// Adoption can restart a scene queue that keeps writing session.json in the
// background. Stop it and let the in-flight step settle before the directory
// goes away, or the removal races the writer.
async function quiesceSession(session) {
  if (!session) return;
  session.sceneCancelled = true;
  session.sceneQueue.length = 0;
  const deadline = Date.now() + 15000;
  while (session.scenePhase && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // One more tick so a persistSession already in flight can finish its rename.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function waitFor(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("a run starts detached, persists its session, refuses a second start, and cancels", async (t) => {
  const root = await makeBenchmarkRoot();
  const routes = loadRoutes(root);
  let pid = null;
  t.after(async () => {
    await killAndWait(pid);
    delete require.cache[MODULE_PATH];
    delete process.env.LLM3_BENCHMARK_ROOT;
    delete process.env.LLM3_VOXEL_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });

  const launched = await routes.startBenchmark({ models: ["Fake"] });
  pid = launched.pid;
  assert.ok(pid > 0);

  const status = await routes.getBenchmarkStatus();
  assert.equal(status.running, true);
  assert.equal(status.pid, pid);
  assert.equal(status.source, "llm3");
  assert.equal(status.adopted, false);
  assert.match(status.recentLog, /fake runner: started/, "runner output is read back from the log file");

  const session = JSON.parse(await fs.readFile(routes._test.sessionFilePath, "utf8"));
  assert.equal(session.pid, pid);
  assert.ok(Array.isArray(session.args));

  await assert.rejects(routes.startBenchmark({ models: ["Fake"] }), /already running/);

  const cancelled = await routes.cancelBenchmark();
  assert.equal(cancelled.pid, pid);
  assert.ok(await waitFor(async () => !(await routes.getBenchmarkStatus()).running), "runner exits after SIGTERM");
  const after = await routes.getBenchmarkStatus();
  assert.equal(after.phase, "idle");
  assert.ok(after.lastRun);
  assert.ok(after.lastRun.endedAt);
  assert.match(after.lastRun.recentLog, /stopped by signal/);
  const persisted = JSON.parse(await fs.readFile(routes._test.sessionFilePath, "utf8"));
  assert.ok(persisted.endedAt, "the ended session is persisted too");
});

test("a fresh server process re-adopts a live run from session.json", async (t) => {
  const root = await makeBenchmarkRoot();
  let routes = loadRoutes(root);
  let pid = null;
  t.after(async () => {
    await killAndWait(pid);
    delete require.cache[MODULE_PATH];
    delete process.env.LLM3_BENCHMARK_ROOT;
    delete process.env.LLM3_VOXEL_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });

  pid = (await routes.startBenchmark({ models: ["Fake"] })).pid;

  // Simulate `pm2 restart llm3`: a new module instance with no in-memory session.
  routes = loadRoutes(root);
  const status = await routes.getBenchmarkStatus();
  assert.equal(status.running, true, "the detached runner survived the reload");
  assert.equal(status.pid, pid);
  assert.equal(status.adopted, true);
  assert.match(status.recentLog, /fake runner: tick/);

  await assert.rejects(routes.startBenchmark({ models: ["Fake"] }), /already running/);
  await routes.cancelBenchmark();
  assert.ok(await waitFor(async () => !(await routes.getBenchmarkStatus()).running));
});

test("concurrent start requests spawn one runner", async (t) => {
  const root = await makeBenchmarkRoot();
  const routes = loadRoutes(root);
  const pids = [];
  t.after(async () => {
    for (const pid of pids) await killAndWait(pid);
    delete require.cache[MODULE_PATH];
    delete process.env.LLM3_BENCHMARK_ROOT;
    delete process.env.LLM3_VOXEL_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });

  const outcomes = await Promise.allSettled([
    routes.startBenchmark({ models: ["Fake"] }),
    routes.startBenchmark({ models: ["Fake"] }),
    routes.startBenchmark({ models: ["Fake"] }),
  ]);
  const ok = outcomes.filter((o) => o.status === "fulfilled");
  const failed = outcomes.filter((o) => o.status === "rejected");
  for (const o of ok) pids.push(o.value.pid);
  assert.equal(ok.length, 1, JSON.stringify(outcomes.map((o) => o.status)));
  assert.equal(failed.length, 2);
  for (const o of failed) assert.match(o.reason.message, /already/);
  await routes.cancelBenchmark();
  assert.ok(await waitFor(async () => !(await routes.getBenchmarkStatus()).running));
});

test("a half-written row with no live runner reads as interrupted, not running", async (t) => {
  const root = await makeBenchmarkRoot();
  const routes = loadRoutes(root);
  t.after(async () => {
    delete require.cache[MODULE_PATH];
    delete process.env.LLM3_BENCHMARK_ROOT;
    delete process.env.LLM3_VOXEL_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });
  const dir = path.join(root, "results", "dead__gguf");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "benchmark.json"), JSON.stringify({
    modelLabel: "Dead",
    benchmarks: { loadTime: { status: "pass" } },
    errors: [],
    timestamps: { started: "2026-09-01T10:00:00Z" },
  }));
  const rows = await routes._test.readBenchmarks();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].overallStatus, "interrupted");

  // The cache returns the same parse while the file is unchanged, and a
  // rewrite is picked up.
  await fs.writeFile(path.join(dir, "benchmark.json"), JSON.stringify({
    modelLabel: "Dead",
    benchmarks: { loadTime: { status: "pass" } },
    errors: [],
    timestamps: { started: "2026-09-01T10:00:00Z", stopped: "2026-09-01T10:05:00Z" },
  }));
  const again = await routes._test.readBenchmarks();
  assert.equal(again[0].overallStatus, "pending");
});

test("a runner belonging to another checkout is not reported as this dashboard's run", async (t) => {
  // `ps` sees every process on the machine. Without scoping, any
  // benchmark_runner.py anywhere (another llm3 checkout, another test) made
  // this instance report a run it does not own and refuse to start one.
  const mine = await makeBenchmarkRoot();
  const theirs = await makeBenchmarkRoot();
  const routes = loadRoutes(mine);
  let strayPid = null;
  let minePid = null;
  t.after(async () => {
    await killAndWait(strayPid);
    await killAndWait(minePid);
    delete require.cache[MODULE_PATH];
    delete process.env.LLM3_BENCHMARK_ROOT;
    delete process.env.LLM3_VOXEL_ROOT;
    await fs.rm(mine, { recursive: true, force: true });
    await fs.rm(theirs, { recursive: true, force: true });
  });

  const { spawn } = require("node:child_process");
  const stray = spawn("python3", ["-u", "benchmark_runner.py", "--slot", "slot1"], {
    cwd: theirs,
    stdio: "ignore",
    detached: true,
  });
  stray.unref();
  strayPid = stray.pid;
  assert.ok(await waitFor(async () => {
    try { process.kill(strayPid, 0); return true; } catch { return false; }
  }), "the stray runner is alive");

  const status = await routes.getBenchmarkStatus();
  assert.equal(status.running, false, "a runner in another benchmark root is not ours");

  // And a run of our own is still found.
  minePid = (await routes.startBenchmark({ models: ["Fake"] })).pid;
  const ours = await routes.getBenchmarkStatus();
  assert.equal(ours.running, true);
  assert.equal(ours.pid, minePid);
  await routes.cancelBenchmark();
});

test("a scene interrupted by a restart is picked up again, not dropped", async (t) => {
  const root = await makeBenchmarkRoot();
  let adoptedSession = null;
  t.after(async () => {
    await quiesceSession(adoptedSession);
    delete require.cache[MODULE_PATH];
    delete process.env.LLM3_BENCHMARK_ROOT;
    delete process.env.LLM3_VOXEL_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });

  // A session whose runner already finished, with one scene in flight and one
  // still queued -- the shape left behind when the dashboard restarts during
  // the scene phase. The in-flight scene is only in scenePhase: the queue no
  // longer holds it, because runSceneQueueForSession shifts before running.
  const routes = loadRoutes(root);
  const sessionDir = path.dirname(routes._test.sessionFilePath);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(routes._test.sessionFilePath, JSON.stringify({
    pid: 999999,
    startedAt: "2026-09-04T10:00:00.000Z",
    endedAt: "2026-09-04T10:30:00.000Z",
    exitCode: 0,
    args: [],
    command: "python3 -u benchmark_runner.py",
    selectedModels: ["Fake Model"],
    scenePhase: { test: "pixel", thinking: false },
    sceneQueue: [{ test: "voxel", thinking: false }],
    sceneSlot: "slot3",
    sceneModelFilters: [],
    sceneCancelled: false,
  }), "utf8");

  const adopted = await routes._test.adoptPersistedSession();
  adoptedSession = adopted;
  assert.ok(adopted, "the session was adopted");
  // Adoption also restarts the queue, which shifts the head into scenePhase
  // straight away, so the interrupted scene is either running again or still
  // waiting at the front. Both mean it was not dropped.
  const pending = [
    ...(adopted.scenePhase ? [adopted.scenePhase.test] : []),
    ...adopted.sceneQueue.map((job) => job.test),
  ];
  assert.deepEqual(pending, ["pixel", "voxel"], "the interrupted scene is retried before the queued one");
});

test("a cancelled scene queue is not resumed on adoption", async (t) => {
  const root = await makeBenchmarkRoot();
  t.after(async () => {
    delete require.cache[MODULE_PATH];
    delete process.env.LLM3_BENCHMARK_ROOT;
    delete process.env.LLM3_VOXEL_ROOT;
    await fs.rm(root, { recursive: true, force: true });
  });
  const routes = loadRoutes(root);
  await fs.mkdir(path.dirname(routes._test.sessionFilePath), { recursive: true });
  await fs.writeFile(routes._test.sessionFilePath, JSON.stringify({
    pid: 999999,
    startedAt: "2026-09-04T10:00:00.000Z",
    endedAt: "2026-09-04T10:30:00.000Z",
    exitCode: 130,
    args: [],
    command: "python3 -u benchmark_runner.py",
    selectedModels: [],
    scenePhase: null,
    sceneQueue: [{ test: "voxel", thinking: false }],
    sceneSlot: "slot3",
    sceneModelFilters: [],
    sceneCancelled: true,
  }), "utf8");

  const adopted = await routes._test.adoptPersistedSession();
  assert.equal(adopted.sceneCancelled, true);
  const status = await routes.getBenchmarkStatus();
  assert.equal(status.running, false, "a cancelled queue does not restart itself");
});
