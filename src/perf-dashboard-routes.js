const fs = require("fs/promises");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const voxel = require("./voxel-test");

const repoRoot = path.resolve(__dirname, "..");
const benchmarkRoot = process.env.LLM3_BENCHMARK_ROOT || path.join(repoRoot, "benchmarks");
const summaryPath = path.join(benchmarkRoot, "SUMMARY.md");
const resultsRoot = path.join(benchmarkRoot, "results");
const MAX_LOG_LINES = 160;
const INVENTORY_CACHE_TTL_MS = 10_000;
const START_STABILITY_WAIT_MS = 1500;

// How long after the last `ps` sighting an externally started runner still
// counts as alive for the "interrupted" row classification.
const EXTERNAL_RUNNER_GRACE_MS = 30_000;
// Questions per quality metric when a launch does not choose one. It must match
// DEFAULT_QUALITY_LIMIT in benchmarks/benchmark_runner.py, which explains why:
// at 60 the 95% interval is about +/-12 points, wider than much of the fleet's
// spread. buildRunnerArgs used to fall back to 60 while the runner, the run
// estimator, and the launcher UI all assumed 200, so a launch that did not name
// a limit ran a quarter of the questions the estimate was based on.
const DEFAULT_QUALITY_LIMIT = 200;
// The runner is started detached, with its output in this directory, and the
// session is written to session.json so a dashboard restart (pm2 restart llm3)
// neither kills the run nor forgets it: getBenchmarkStatus() re-adopts the
// session from the file when the in-memory one is gone.
const sessionDir = path.join(benchmarkRoot, ".session");
const sessionFilePath = path.join(sessionDir, "session.json");
const runnerLogPath = path.join(sessionDir, "runner.log");
let benchmarkSession = null;
let startInFlight = false;
let lastExternalRunnerSeenAt = 0;
const inventoryCache = new Map();
const benchmarkFileCache = new Map();

function sessionSnapshot(session) {
  if (!session) {
    return null;
  }
  return {
    pid: session.pid,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    exitCode: session.exitCode,
    args: session.args,
    command: session.command,
    selectedModels: session.selectedModels,
    sceneQueue: session.sceneQueue,
    // The scene being generated when the process went away. It is put back at
    // the front of the queue on adoption, so a restart mid-scene costs that
    // scene's progress and not the scene itself.
    scenePhase: session.scenePhase || null,
    sceneSlot: session.sceneSlot,
    sceneModelFilters: session.sceneModelFilters,
    sceneCancelled: Boolean(session.sceneCancelled),
    logPath: session.logPath,
  };
}

async function persistSession(session) {
  try {
    await fs.mkdir(sessionDir, { recursive: true });
    const tempPath = `${sessionFilePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(sessionSnapshot(session), null, 2), "utf8");
    await fs.rename(tempPath, sessionFilePath);
  } catch (error) {
    console.error(`[perf-dashboard] failed to persist session: ${error.message || error}`);
  }
}

async function readPersistedSession() {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionFilePath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.pid ? parsed : null;
  } catch (_error) {
    return null;
  }
}

// Called when there is no in-memory session: pick up a run that an earlier
// server process started. A live pid becomes the session again (scenes queued
// behind it included); a dead one is recorded as ended so the run strip can
// show the last run.
async function adoptPersistedSession() {
  if (benchmarkSession) {
    return benchmarkSession;
  }
  const saved = await readPersistedSession();
  if (!saved) {
    return null;
  }
  benchmarkSession = {
    child: null,
    pid: saved.pid,
    startedAt: saved.startedAt,
    endedAt: saved.endedAt || null,
    exitCode: saved.exitCode ?? null,
    args: Array.isArray(saved.args) ? saved.args : [],
    command: String(saved.command || ""),
    logLines: [],
    selectedModels: Array.isArray(saved.selectedModels) ? saved.selectedModels : [],
    sceneQueue: [
      ...(saved.scenePhase ? [saved.scenePhase] : []),
      ...(Array.isArray(saved.sceneQueue) ? saved.sceneQueue : []),
    ],
    scenePhase: null,
    sceneCancelled: Boolean(saved.sceneCancelled),
    sceneSlot: String(saved.sceneSlot || "slot3"),
    sceneModelFilters: Array.isArray(saved.sceneModelFilters) ? saved.sceneModelFilters : [],
    logPath: String(saved.logPath || runnerLogPath),
    adopted: true,
  };
  if (!benchmarkSession.endedAt && !isPidAlive(benchmarkSession.pid)) {
    // The runner finished (or died) while no dashboard was watching. Its exit
    // code is unknown; the rows on disk say what happened.
    await finishSession(benchmarkSession, null);
  } else if (benchmarkSession.endedAt && benchmarkSession.sceneQueue.length && !benchmarkSession.sceneCancelled) {
    // The runner had already finished and the scenes were being generated when
    // the process went away. finishSession would return early on an ended
    // session, so the queue is resumed here instead of being dropped.
    runSceneQueueForSession(benchmarkSession).catch((error) => {
      appendSessionLog("[scenes] ", Buffer.from(String(error.message || error)));
    });
  }
  return benchmarkSession;
}

async function finishSession(session, exitCode) {
  if (!session || session.endedAt) {
    return;
  }
  session.exitCode = exitCode;
  session.endedAt = new Date().toISOString();
  benchmarkFileCache.clear();
  await persistSession(session);
  runSceneQueueForSession(session).catch((error) => {
    appendSessionLog("[scenes] ", Buffer.from(String(error.message || error)));
  });
}

async function tailFile(filePath, maxLines) {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
      return lines.slice(-maxLines);
    } finally {
      await handle.close();
    }
  } catch (_error) {
    return [];
  }
}

// The runner's own output (from its log file) followed by what the server
// added itself (scene messages, spawn errors).
async function sessionRecentLog(session) {
  if (!session) {
    return "";
  }
  const fileLines = session.logPath ? await tailFile(session.logPath, MAX_LOG_LINES) : [];
  return [...fileLines, ...session.logLines].slice(-MAX_LOG_LINES).join("\n");
}

function runnerConsideredActive() {
  if (benchmarkSession && benchmarkSession.pid && isPidAlive(benchmarkSession.pid) && !benchmarkSession.endedAt) {
    return true;
  }
  return Date.now() - lastExternalRunnerSeenAt < EXTERNAL_RUNNER_GRACE_MS;
}

function safeInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeDiscoveredInventory(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.models)) {
      return payload.models;
    }
    if (Array.isArray(payload.items)) {
      return payload.items;
    }
    if (Array.isArray(payload.results)) {
      return payload.results;
    }
  }
  throw new Error("Invalid discovery payload shape.");
}

function buildRunnerArgs(config) {
  const args = ["benchmark_runner.py"];
  args.push("--context-size", String(safeInt(config.contextSize, 128000)));
  args.push("--parallel", String(safeInt(config.parallel, 1)));
  args.push("--load-timeout", String(safeInt(config.loadTimeout, 300)));
  args.push("--global-timeout", String(safeInt(config.globalTimeout, 300)));
  args.push("--throughput-window", String(safeInt(config.throughputWindow, 60)));
  args.push("--throughput-stall-timeout", String(safeInt(config.throughputStallTimeout, 10)));
  args.push("--throughput-repeats", String(safeInt(config.throughputRepeats, 3)));
  // safeInt only accepts positive numbers, so 0 (warm-up disabled) is passed
  // through explicitly rather than falling back to the default.
  args.push("--throughput-warmup", String(Number(config.throughputWarmup) === 0 ? 0 : safeInt(config.throughputWarmup, 1)));
  args.push("--slot-count", String(safeInt(config.slotCount, 3)));
  args.push("--quality-limit", String(safeInt(config.qualityLimit, DEFAULT_QUALITY_LIMIT)));

  // Only MMLU-Pro by default: it is the one metric with headroom on this
  // hardware's models, and the cheapest. Everything else is opt-in.
  const qualityMetrics = normalizeStringArray(config.qualityMetrics)
    .filter((item) => RUNNER_QUALITY_METRICS.includes(item));
  for (const metric of (qualityMetrics.length ? qualityMetrics : ["mmlu_pro"])) {
    args.push("--quality-metric", metric);
  }
  const selectedSlot = String(config.selectedSlot || "").trim();
  if (selectedSlot) {
    args.push("--slot", selectedSlot);
  }

  const runtimes = normalizeStringArray(config.runtimes).filter((item) => ["gguf", "mlx", "mtplx", "dflash"].includes(item));
  for (const runtime of runtimes) {
    args.push("--runtime", runtime);
  }

  const modelFilters = normalizeStringArray(config.modelFilters);
  for (const modelFilter of modelFilters) {
    args.push("--model", modelFilter);
  }

  const excludeModelFilters = normalizeStringArray(config.excludeModelFilters);
  for (const excludeFilter of excludeModelFilters) {
    args.push("--exclude-model", excludeFilter);
  }

  const limit = safeInt(config.limit, null);
  if (limit) {
    args.push("--limit", String(limit));
  }

  if (config.force) {
    args.push("--force");
  }

  // A single-variant run is pinned by name so its row is labelled and joins the
  // right thinking bucket; --thinking alone produces the legacy unlabelled run.
  if (config.variant && !config.simpleThinkingVariants && !config.thinkingVariants) {
    args.push("--variant", String(config.variant));
  } else if (config.thinking) {
    args.push("--thinking");
  }

  if (config.enableTinyGrammar) {
    args.push("--enable-tiny-grammar");
  }

  if (config.simpleThinkingVariants && !config.thinkingVariants) {
    args.push("--simple-thinking-variants");
  }

  if (config.thinkingVariants) {
    args.push("--thinking-variants");
  }

  if (config.includeAppleTq3Cpu) {
    args.push("--include-apple-tq3-cpu");
  }

  return args;
}

function tokenizeCommand(command) {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function parseRunnerArgs(args) {
  const config = {
    contextSize: 128000,
    parallel: 1,
    loadTimeout: 300,
    globalTimeout: 300,
    throughputWindow: 60,
    throughputStallTimeout: 10,
    throughputRepeats: 3,
    throughputWarmup: 1,
    slotCount: 3,
    qualityLimit: DEFAULT_QUALITY_LIMIT,
    qualityMetrics: [],
    selectedSlot: "",
    runtimes: [],
    modelFilters: [],
    excludeModelFilters: [],
    limit: null,
    force: false,
    thinking: false,
    enableTinyGrammar: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--context-size") config.contextSize = safeInt(next, config.contextSize);
    if (arg === "--parallel") config.parallel = safeInt(next, config.parallel);
    if (arg === "--load-timeout") config.loadTimeout = safeInt(next, config.loadTimeout);
    if (arg === "--global-timeout") config.globalTimeout = safeInt(next, config.globalTimeout);
    if (arg === "--throughput-window") config.throughputWindow = safeInt(next, config.throughputWindow);
    if (arg === "--throughput-stall-timeout") config.throughputStallTimeout = safeInt(next, config.throughputStallTimeout);
    if (arg === "--throughput-repeats") config.throughputRepeats = safeInt(next, config.throughputRepeats);
    if (arg === "--throughput-warmup") config.throughputWarmup = Number(next) === 0 ? 0 : safeInt(next, config.throughputWarmup);
    if (arg === "--slot-count") config.slotCount = safeInt(next, config.slotCount);
    if (arg === "--slot" && next) config.selectedSlot = next;
    if (arg === "--runtime" && next) config.runtimes.push(next);
    if (arg === "--model" && next) config.modelFilters.push(next);
    if (arg === "--exclude-model" && next) config.excludeModelFilters.push(next);
    if (arg === "--quality-limit") config.qualityLimit = safeInt(next, config.qualityLimit);
    if (arg === "--quality-metric" && next) config.qualityMetrics.push(next);
    if (arg === "--limit") config.limit = safeInt(next, null);
    if (arg === "--force") config.force = true;
    if (arg === "--thinking") config.thinking = true;
    if (arg === "--variant" && next) config.variant = next;
    if (arg === "--enable-tiny-grammar") config.enableTinyGrammar = true;
    if (arg === "--simple-thinking-variants") config.simpleThinkingVariants = true;
    if (arg === "--thinking-variants") config.thinkingVariants = true;
    if (arg === "--include-apple-tq3-cpu") config.includeAppleTq3Cpu = true;
  }

  return config;
}

function parseExternalProcessArgs(command) {
  const tokens = tokenizeCommand(command);
  const scriptIndex = tokens.findIndex((token) => token.endsWith("benchmark_runner.py") || token === "benchmark_runner.py");
  if (scriptIndex === -1) {
    return [];
  }
  return tokens.slice(scriptIndex + 1);
}

function appendSessionLog(prefix, chunk) {
  if (!benchmarkSession) {
    return;
  }
  const text = chunk.toString("utf8").trim();
  if (!text) {
    return;
  }
  const lines = text.split(/\r?\n/).filter(Boolean).map((line) => `${prefix}${line}`);
  benchmarkSession.logLines.push(...lines);
  if (benchmarkSession.logLines.length > MAX_LOG_LINES) {
    benchmarkSession.logLines = benchmarkSession.logLines.slice(-MAX_LOG_LINES);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearBenchmarkArtifacts() {
  const dirEntries = await fs.readdir(resultsRoot, { withFileTypes: true }).catch(() => []);
  let removedCount = 0;
  for (const entry of dirEntries) {
    const target = path.join(resultsRoot, entry.name);
    await fs.rm(target, { recursive: true, force: true });
    removedCount += 1;
  }
  await fs.rm(summaryPath, { force: true }).catch(() => {});
  await fs.rm(sessionFilePath, { force: true }).catch(() => {});
  inventoryCache.clear();
  benchmarkFileCache.clear();
  benchmarkSession = null;
  return { removedCount };
}

function inferActiveStage(payload) {
  const timestamps = (payload && payload.timestamps) || {};
  if (!timestamps.loadComplete) {
    return "load";
  }
  if (!timestamps.basicResponseComplete) {
    return "basicResponse";
  }
  if (!timestamps.agenticComplete) {
    return "agentic";
  }
  if (!timestamps.qualityComplete) {
    return "quality";
  }
  if (!timestamps.throughputComplete) {
    return "throughput";
  }
  return "finalizing";
}

function tailLines(text, limit) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).join("\n");
}

async function readCurrentModelLog(activePayload) {
  if (!activePayload || !activePayload.resultDir) {
    return { logName: null, logTail: "" };
  }
  const stage = inferActiveStage(activePayload);
  const candidates = {
    load: "load_time.log",
    basicResponse: "basic_response.log",
    throughput: "throughput.log",
    agentic: "agentic.log",
    quality: "quality.log",
    finalizing: "stop.log",
  };
  const logName = candidates[stage] || "load_time.log";
  const logPath = path.join(String(activePayload.resultDir), logName);
  try {
    const content = await fs.readFile(logPath, "utf8");
    return {
      logName,
      logTail: tailLines(content, MAX_LOG_LINES),
    };
  } catch (_error) {
    return { logName, logTail: "" };
  }
}

function isPidAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

async function discoverInventory(config) {
  const cacheKey = JSON.stringify(buildRunnerArgs(config));
  const cached = inventoryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < INVENTORY_CACHE_TTL_MS) {
    return cached.payload;
  }

  const args = buildRunnerArgs(config).concat("--discover-json");
  const { stdout } = await execFileAsync("python3", args, {
    cwd: benchmarkRoot,
    maxBuffer: 1024 * 1024 * 20,
  });
  const payload = normalizeDiscoveredInventory(JSON.parse(stdout));
  inventoryCache.set(cacheKey, { timestamp: Date.now(), payload });
  return payload;
}

// The working directory of a pid, used to tell a runner belonging to this llm3
// checkout from one belonging to another (or from a test's fake runner). Best
// effort: when it cannot be resolved the caller keeps the process rather than
// discarding a real run.
async function processWorkingDirectory(pid) {
  try {
    if (process.platform === "linux") {
      return await fs.readlink(`/proc/${pid}/cwd`);
    }
    const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { timeout: 5000 });
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch (_error) {
    return null;
  }
}

async function listBenchmarkProcesses() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,lstart=,command="], {
    maxBuffer: 1024 * 1024 * 8,
  });
  const processes = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes("benchmark_runner.py")) {
      continue;
    }
    const match = line.match(/^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    if (!Number.isFinite(pid) || pid === process.pid) {
      continue;
    }
    const args = parseExternalProcessArgs(match[3]);
    if (!Array.isArray(args) || args.length === 0 || args.includes("--discover-json")) {
      continue;
    }
    processes.push({
      pid,
      startedAt: new Date(match[2]).toISOString(),
      command: match[3],
      args,
    });
  }

  // `ps` sees every process on the machine, so a runner belonging to another
  // llm3 checkout (or to a test with its own benchmark root) would otherwise be
  // reported as this dashboard's run. The runner is spawned with the benchmark
  // root as its working directory, so that is what identifies it.
  const owned = [];
  for (const entry of processes) {
    const cwd = await processWorkingDirectory(entry.pid);
    if (cwd === null || path.resolve(cwd) === path.resolve(benchmarkRoot)) {
      owned.push(entry);
    }
  }
  processes.length = 0;
  processes.push(...owned);
  processes.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  if (processes.length) {
    lastExternalRunnerSeenAt = Date.now();
  }
  return processes;
}

function derivePayloadOverallStatus(payload) {
  const requiredStages = new Set(["loadTime", "basicResponse", "agentic", "quality", "throughput"]);
  const benchmarks = payload?.benchmarks && typeof payload.benchmarks === "object" ? payload.benchmarks : {};
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const timestamps = payload?.timestamps && typeof payload.timestamps === "object" ? payload.timestamps : {};
  const stopped = Boolean(timestamps.stopped);
  const statuses = Object.values(benchmarks)
    .map((value) => (value && typeof value === "object" && value.status ? String(value.status) : ""))
    .filter(Boolean);

  if (errors.length) {
    const errorStages = new Set(
      errors
        .filter((error) => error && typeof error === "object")
        .map((error) => String(error.stage || ""))
        .filter(Boolean),
    );
    if (errorStages.size) {
      const nonPartialStages = [...errorStages].filter((stage) => stage !== "throughput");
      if (nonPartialStages.length) {
        return "fail";
      }
      if (statuses.length && statuses.every((status) => status === "pass")) {
        return "partial";
      }
    }
  }

  if (!statuses.length) {
    return "pending";
  }
  if (statuses.some((status) => status === "fail")) {
    return "fail";
  }
  if (![...requiredStages].every((stage) => Object.prototype.hasOwnProperty.call(benchmarks, stage))) {
    return stopped ? "pending" : "running";
  }
  if (statuses.some((status) => status === "partial" || status === "not-applicable")) {
    return "partial";
  }
  if (statuses.every((status) => status === "pass")) {
    return "pass";
  }
  return "partial";
}

function normalizeBenchmarkPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return {
    ...payload,
    overallStatus: derivePayloadOverallStatus(payload),
  };
}

// Parsed benchmark.json files, cached by mtime: the status endpoint reads the
// whole results tree every poll, and parsing several megabytes of JSON per
// tick grows with every row while nothing in it has changed.
async function readBenchmarks() {
  const dirEntries = await fs.readdir(resultsRoot, { withFileTypes: true }).catch(() => []);
  const payloads = [];
  const seen = new Set();
  const runnerActive = runnerConsideredActive();
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const benchmarkPath = path.join(resultsRoot, entry.name, "benchmark.json");
    try {
      const stat = await fs.stat(benchmarkPath);
      seen.add(benchmarkPath);
      const cached = benchmarkFileCache.get(benchmarkPath);
      let parsed;
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        parsed = cached.parsed;
      } else {
        parsed = JSON.parse(await fs.readFile(benchmarkPath, "utf8"));
        benchmarkFileCache.set(benchmarkPath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
      }
      const payload = normalizeBenchmarkPayload(parsed);
      if (payload) {
        // Where this actually came from, not where the file claims it lives.
        // benchmark.json carries a resultDir written at run time, which is a
        // stale copy the moment a directory is renamed or copied -- trusting
        // it means a row can point at a different row's directory.
        payload.resultDirName = entry.name;
        // A row with stages missing and no "stopped" timestamp is mid-run only
        // while a runner exists. Without one (SIGKILL, power loss) it is a
        // half-written row, and the table should say so rather than "running".
        if (payload.overallStatus === "running" && !runnerActive) {
          payload.overallStatus = "interrupted";
        }
        payloads.push(payload);
      }
    } catch (_error) {
      // Ignore partial writes and missing files.
    }
  }
  for (const key of benchmarkFileCache.keys()) {
    if (!seen.has(key)) {
      benchmarkFileCache.delete(key);
    }
  }
  return payloads;
}

function metric(payload, ...pathParts) {
  let value = payload;
  for (const part of pathParts) {
    if (!value || typeof value !== "object") {
      return null;
    }
    value = value[part];
  }
  return value;
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function newestHost(payloads) {
  const withHost = payloads
    .filter((payload) => payload && payload.host && typeof payload.host === "object")
    .sort((left, right) => Date.parse(metric(right, "timestamps", "started") || 0) - Date.parse(metric(left, "timestamps", "started") || 0));
  if (!withHost.length) {
    return null;
  }
  const host = withHost[0].host;
  return {
    chip: String(host.chip || ""),
    memoryBytes: asNumber(host.memoryBytes),
    osVersion: String(host.osVersion || ""),
    cpuCount: asNumber(host.cpuCount),
  };
}

function decodeThroughputMetricValue(payload) {
  return asNumber(metric(payload, "benchmarks", "throughput", "tokensPerSecond"));
}

function answerThroughputMetricValue(payload) {
  return asNumber(metric(payload, "benchmarks", "throughput", "answerTokensPerSecond"));
}

function formatMetric(value) {
  if (value == null) {
    return "n/a";
  }
  return String(Number(value.toFixed(3))).replace(/\.0+$/, "");
}

function qualityMetricsFromPayload(payload) {
  const deepEvalValue = metric(payload, "benchmarks", "quality", "deepEvalScore");
  return {
    avgMmlu: asNumber(metric(payload, "benchmarks", "quality", "avgMmlu")),
    mmluPro: asNumber(metric(payload, "benchmarks", "quality", "scores", "mmlu_pro")),
    math500: asNumber(metric(payload, "benchmarks", "quality", "scores", "math500")),
    humanEval: asNumber(metric(payload, "benchmarks", "quality", "scores", "humaneval")),
    hebrewTranslation: asNumber(metric(payload, "benchmarks", "quality", "scores", "hebrew_translation")),
    gsm8k: asNumber(metric(payload, "benchmarks", "quality", "scores", "gsm8k")),
    deepEval: asNumber(deepEvalValue != null ? deepEvalValue : metric(payload, "benchmarks", "quality", "deepEval", "score")),
    overall: asNumber(metric(payload, "benchmarks", "quality", "overallAverage")),
  };
}

// ---- Smartness score -----------------------------------------------------
// One column, one weight table, one definition -- served to the UI so the
// breakdown tooltip can never drift from what the runner actually measured.
//
// Weights are relative and renormalized over whatever a row actually ran, so
// turning a metric off does not silently deflate the score; it redistributes.
// They add to 1.00, so a weight also reads as "share of the score when
// everything runs" -- the four supporting metrics sit at 0.025 apiece because
// each of them either saturates on this fleet or measures something adjacent to
// smartness rather than smartness itself.
// The `n` a metric was scored over travels with it, because an accuracy with no
// denominator is unreadable: 0.70 over 60 questions carries a +/-11.6 point
// interval, which is a third of this fleet's entire 0.43-0.73 spread. Ranking
// rows by a number that noisy is what made every model look equally clever.
const BENCHMARK_CATALOG = [
  {
    id: "mmlu_pro",
    label: "MMLU-Pro",
    weight: 0.30,
    kind: "accuracy",
    defaultOn: true,
    runner: "mmlu_pro",
    secondsPerQuestion: 1.2,
    blurb: "Ten-option reasoning questions sampled evenly across all 14 categories.",
  },
  {
    id: "math500",
    label: "MATH-500",
    weight: 0.25,
    kind: "accuracy",
    defaultOn: true,
    runner: "math500",
    // Measured at ~9s a question on a 9B with thinking off: it is the expensive
    // one, and the launcher says so before a run with it ticked.
    secondsPerQuestion: 9,
    blurb: "Competition maths, exact-match graded. The metric thinking actually moves.",
  },
  {
    id: "humaneval",
    label: "HumanEval",
    weight: 0.25,
    kind: "accuracy",
    defaultOn: false,
    runner: "humaneval",
    secondsPerQuestion: 3.5,
    blurb: "Python problems graded by running the model's code locally in a sandbox.",
    warning: "Executes model-written Python on this machine.",
  },
  {
    id: "deepeval",
    label: "IFEval",
    weight: 0.10,
    kind: "accuracy",
    defaultOn: false,
    runner: "deepeval",
    secondsPerQuestion: 10,
    blurb: "DeepEval instruction-following score. Near-saturated on this fleet.",
  },
  {
    id: "translation",
    label: "Hebrew chrF",
    weight: 0.025,
    kind: "similarity",
    defaultOn: false,
    runner: "translation",
    // One fixed passage, not a sample: cost does not scale with the limit.
    secondsPerQuestion: 0,
    fixedSeconds: 60,
    blurb: "Character-F similarity against a fixed reference translation. A sorting aid, not a correctness score.",
  },
  {
    id: "scenes",
    label: "Scenes",
    weight: 0.025,
    kind: "composite",
    defaultOn: true,
    runner: null,
    blurb: "Proxy score over the generated scenes: did it produce a page, does it parse, does it render, how much did it draw. Measures effort and correctness, not beauty.",
  },
  {
    id: "mmlu",
    label: "MMLU",
    weight: 0.025,
    kind: "accuracy",
    defaultOn: false,
    runner: "mmlu",
    secondsPerQuestion: 1.2,
    // Three subsets, each run at the full limit.
    taskCount: 3,
    blurb: "Three-subset MMLU average. Superseded by MMLU-Pro, which still has headroom here.",
  },
  {
    id: "gsm8k",
    label: "GSM8K",
    weight: 0.025,
    kind: "accuracy",
    defaultOn: false,
    runner: "gsm8k",
    secondsPerQuestion: 2.5,
    blurb: "Grade-school word problems. Superseded by MATH-500.",
  },
];

// What benchmark_runner.py accepts today. The catalogue above is the scoring
// model and can name a metric before the runner can run it; this list is what
// may actually be put on a command line, and it gates the launcher checkboxes.
const RUNNER_QUALITY_METRICS = ["mmlu_pro", "math500", "humaneval", "mmlu", "gsm8k", "deepeval", "translation"];

const SCENE_BENCHMARK_PREFIX = "scene:";
// Mirrors TRANSLATION_THINKING_VARIANTS in benchmark_runner.py: the grammar
// variants are thinking runs, so they read the thinking bucket's scenes.
const THINKING_VARIANTS = new Set(["think", "think-tiny", "think-gbnf"]);
const Z95 = 1.96;
// Below this a proportion carries no information worth ranking: at n=5 the 95%
// interval spans roughly half the scale.
const MIN_MEANINGFUL_SAMPLE = 10;

function thinkingBucketForVariant(variant) {
  return THINKING_VARIANTS.has(String(variant || "")) ? "think" : "no-think";
}

// Wilson half-width rather than the textbook normal one: at p = 0 or p = 1 the
// normal interval collapses to +/-0, which would claim a model that got every
// question right has no uncertainty at all.
function wilsonMargin(proportion, sampleSize) {
  if (typeof proportion !== "number" || typeof sampleSize !== "number") {
    return null;
  }
  const n = sampleSize;
  const p = proportion;
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(p)) {
    return null;
  }
  const denominator = 1 + (Z95 * Z95) / n;
  const spread = Math.sqrt((p * (1 - p)) / n + (Z95 * Z95) / (4 * n * n));
  return (Z95 / denominator) * spread;
}

function scoreComponentValue(payload, entry) {
  const quality = metric(payload, "benchmarks", "quality");
  if (!quality || typeof quality !== "object") {
    return null;
  }
  if (entry.id === "mmlu") {
    return asNumber(quality.avgMmlu);
  }
  if (entry.id === "deepeval") {
    const direct = asNumber(quality.deepEvalScore);
    return direct != null ? direct : asNumber(metric(quality, "deepEval", "score"));
  }
  if (entry.id === "translation") {
    return asNumber(metric(quality, "scores", "hebrew_translation"));
  }
  if (entry.id === "scenes") {
    return null; // filled in from the scene index by buildScore
  }
  return asNumber(metric(quality, "scores", entry.id));
}

function scoreComponentDiagnostics(payload, entry) {
  const diagnostics = metric(payload, "benchmarks", "quality", "taskDiagnostics");
  const key = entry.id === "mmlu" ? null : entry.id;
  const diagnostic = key && diagnostics && typeof diagnostics === "object" ? diagnostics[key] : null;
  if (!diagnostic || typeof diagnostic !== "object") {
    return { n: null, correct: null, notes: [] };
  }
  const notes = [];
  if (diagnostic.truncated) {
    notes.push(`${diagnostic.truncated} hit the token cap`);
  }
  if (diagnostic.timeouts) {
    notes.push(`${diagnostic.timeouts} timed out`);
  }
  if (diagnostic.abortedReason === "endpoint-unreachable") {
    notes.push("abandoned: the slot stopped answering mid-task");
  }
  // Past half the sample this is a measurement of the budget, not the model.
  // Truncations and timeouts are the same artefact wearing different clothes:
  // one hits the token cap, the other hits the clock, and both score a model
  // wrong for a limit somebody chose.
  const lost = (diagnostic.truncated || 0) + (diagnostic.timeouts || 0) + (diagnostic.noResponse || 0);
  // Two ways a task can lie. Most replies unusable is one. The other is a task
  // that scored almost nothing and reports the survivors' accuracy: 26 of 27
  // maths questions timed out on one recorded run, leaving "1 of 1 correct" --
  // a perfect 1.00 built from a single question that happened to squeak in.
  const scoredShare = diagnostic.requested ? diagnostic.scored / diagnostic.requested : 1;
  // A handful of questions cannot estimate anything. A one-question smoke run
  // scores either 0 or 100 and, left in, sorts itself straight to the top of the
  // leaderboard above models measured over hundreds.
  const tooFewToMean = diagnostic.scored < MIN_MEANINGFUL_SAMPLE;
  const unreliable = Boolean(diagnostic.scored)
    && (tooFewToMean
      || lost / diagnostic.scored > 0.5
      || scoredShare < 0.5
      || diagnostic.abortedReason === "endpoint-unreachable");
  if (tooFewToMean) {
    notes.push(`only ${diagnostic.scored} question${diagnostic.scored === 1 ? "" : "s"} — too few to estimate`);
  }
  if (diagnostic.unparsed) {
    notes.push(`${diagnostic.unparsed} unreadable`);
  }
  if (diagnostic.noResponse) {
    notes.push(`${diagnostic.noResponse} no response`);
  }
  return {
    n: Number.isInteger(diagnostic.scored) ? diagnostic.scored : null,
    correct: Number.isInteger(diagnostic.correct) ? diagnostic.correct : null,
    unreliable,
    notes,
  };
}

// The weighted composite, on a 0-100 scale, with the margin propagated from the
// per-metric sampling error: sqrt(sum((w*sigma)^2)) / sum(w).
function buildScore(payload, sceneScore) {
  const components = [];
  const notRun = [];
  let weighted = 0;
  let totalWeight = 0;
  let varianceNumerator = 0;

  for (const entry of BENCHMARK_CATALOG) {
    const raw = entry.id === "scenes"
      ? (sceneScore ? sceneScore.value : null)
      : scoreComponentValue(payload, entry);
    if (raw == null) {
      notRun.push({ id: entry.id, label: entry.label });
      continue;
    }
    const diagnostics = entry.id === "scenes"
      ? { n: sceneScore.n, correct: null, notes: sceneScore.notes || [] }
      : scoreComponentDiagnostics(payload, entry);
    // A metric that mostly failed to run is not a low score, it is an absent
    // one, and averaging it in makes the composite uninterpretable: one
    // recorded run answered a single maths question out of thirty, got it
    // right, and contributed a perfect 1.00 worth 25% of the weight.
    if (diagnostics.unreliable) {
      notRun.push({
        id: entry.id,
        label: entry.label,
        excluded: true,
        reason: diagnostics.notes.length
          ? `${diagnostics.notes.join(", ")} — excluded`
          : "too little of the sample was measured — excluded",
      });
      continue;
    }
    const margin = entry.kind === "accuracy" ? wilsonMargin(raw, diagnostics.n) : null;
    weighted += raw * entry.weight;
    totalWeight += entry.weight;
    if (margin != null) {
      varianceNumerator += (entry.weight * margin) ** 2;
    }
    components.push({
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      raw,
      weight: entry.weight,
      contribution: raw * entry.weight,
      n: diagnostics.n,
      correct: diagnostics.correct,
      margin,
      unreliable: Boolean(diagnostics.unreliable),
      notes: diagnostics.notes,
    });
  }

  // Scenes alone are not a smartness score: they carry 2.5% of the weight and
  // measure whether a page renders. A row mid-run has had its quality cleared
  // and would otherwise renormalize its scene score up to ~90 and sort itself
  // to the top of the table as the best model on the machine.
  const measuredQuality = components.some((component) => component.id !== "scenes");
  if (!totalWeight || !measuredQuality) {
    return null;
  }

  // Contributions are reported already renormalized, so they add up to the
  // score shown rather than to some smaller number nobody can reconcile.
  for (const component of components) {
    component.contribution = (component.contribution / totalWeight) * 100;
  }

  const quality = metric(payload, "benchmarks", "quality") || {};
  return {
    unreliable: notRun.some((entry) => entry.excluded),
    value: (weighted / totalWeight) * 100,
    margin: (Math.sqrt(varianceNumerator) / totalWeight) * 100,
    components,
    notRun,
    totalWeight,
    sampleLimit: Number.isInteger(quality.limit) ? quality.limit : null,
    // Quality measured with thinking forced off and copied onto the thinking
    // row is not a measurement of the thinking row. Say so rather than letting
    // the number imply otherwise.
    // Did this row's numbers come from a run in this row's own thinking mode?
    // Rows written before quality became per-variant carry no bucket: back then
    // every quality run was thinking-disabled, so only a no-think row was
    // measured as itself.
    measuredOwnVariant: typeof quality.qualityBucket === "string"
      ? quality.qualityBucket === thinkingBucketForVariant(payload.variant)
      : thinkingBucketForVariant(payload.variant) !== "think",
    measuredBucket: typeof quality.qualityBucket === "string" ? quality.qualityBucket : "no-think",
    sharedAcrossVariants: Boolean(quality.sharedAcrossVariants),
  };
}

// Tiers, not ranks: two rows whose intervals overlap are not distinguishable,
// and printing 73 above 72 pretends otherwise. A tier is every row that could
// still be the best of what is left -- its interval reaches the tier leader's --
// so tier A reads as "any of these might be the strongest model here".
function assignScoreTiers(rows) {
  const scored = rows
    .filter((row) => row.score && Number.isFinite(row.score.value))
    .sort((left, right) => right.score.value - left.score.value);
  let tierIndex = 0;
  let leaderLower = null;
  for (const row of scored) {
    const margin = Number.isFinite(row.score.margin) ? row.score.margin : 0;
    if (leaderLower == null) {
      leaderLower = row.score.value - margin;
    } else if (row.score.value + margin < leaderLower) {
      tierIndex += 1;
      leaderLower = row.score.value - margin;
    }
    row.score.tier = String.fromCharCode(65 + Math.min(tierIndex, 25));
  }
  return rows;
}

function hasQualityMetrics(payload) {
  return Object.values(qualityMetricsFromPayload(payload)).some((value) => value != null);
}

function compareBenchmarkPayloads(left, right) {
  const leftRuntime = String(left?.runtime || "").toLowerCase();
  const rightRuntime = String(right?.runtime || "").toLowerCase();
  if (leftRuntime !== rightRuntime) {
    return leftRuntime.localeCompare(rightRuntime);
  }

  const leftLabel = String(left?.modelLabel || left?.modelKey || "").toLowerCase();
  const rightLabel = String(right?.modelLabel || right?.modelKey || "").toLowerCase();
  if (leftLabel !== rightLabel) {
    return leftLabel.localeCompare(rightLabel);
  }

  const leftStarted = Date.parse(left?.timestamps?.started || "") || 0;
  const rightStarted = Date.parse(right?.timestamps?.started || "") || 0;
  return leftStarted - rightStarted;
}

function avg(values) {
  const filtered = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!filtered.length) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function bestPayload(payloads, getter, reverse) {
  const ranked = payloads
    .map((payload) => ({ payload, value: getter(payload) }))
    .filter((item) => item.value != null);
  if (!ranked.length) {
    return null;
  }
  ranked.sort((left, right) => (reverse ? right.value - left.value : left.value - right.value));
  return ranked[0].payload;
}

// Every quality number in the tables above is an accuracy with no denominator
// attached, so a score measured over 11 of 30 questions renders exactly like
// one measured over 30, and a metric that timed out renders as a bare "n/a".
// This section is where a run states what it could not measure.
function collectDataQualityNotes(payloads, knownLabels) {
  const entries = [];
  for (const payload of payloads) {
    const label = String(payload.modelLabel || payload.modelKey || "unknown");
    const quality = metric(payload, "benchmarks", "quality");
    const rowNotes = [];
    const diagnostics = quality && typeof quality === "object" ? quality.taskDiagnostics : null;
    if (diagnostics && typeof diagnostics === "object") {
      for (const taskName of Object.keys(diagnostics).sort()) {
        const diagnostic = diagnostics[taskName];
        if (!diagnostic || typeof diagnostic !== "object") {
          continue;
        }
        if (diagnostic.missingReason) {
          rowNotes.push(`${taskName}: not measured (${diagnostic.missingReason})`);
          continue;
        }
        const { scored, requested, truncated, unparsed } = diagnostic;
        if (Number.isInteger(scored) && Number.isInteger(requested) && scored < requested) {
          rowNotes.push(`${taskName}: scored ${scored} of ${requested} questions`);
        }
        if (truncated) {
          const share = scored ? ` of ${scored}` : "";
          rowNotes.push(
            Number.isInteger(scored) && truncated / scored > 0.5
              ? `${taskName}: ${truncated}${share} replies hit the token cap — this measured the budget, not the model`
              : `${taskName}: ${truncated} reply(ies) hit the token cap`,
          );
        }
        if (unparsed) {
          rowNotes.push(`${taskName}: ${unparsed} reply(ies) had no readable answer`);
        }
      }
    }
    const deepEvalReason = quality && typeof quality === "object" ? quality.deepEvalMissingReason : "";
    if (deepEvalReason) {
      rowNotes.push(`DeepEval: not measured (${deepEvalReason})`);
    }
    if (quality && typeof quality === "object" && thinkingBucketForVariant(payload.variant) === "think"
      && (typeof quality.qualityBucket === "string" ? quality.qualityBucket !== "think" : true)) {
      rowNotes.push("quality was measured with thinking off and copied onto this row");
    }
    if (knownLabels && !knownLabels.has(label)) {
      rowNotes.push("result is stale — this model is no longer on disk");
    }
    if (rowNotes.length) {
      entries.push({
        model: label,
        variant: String(payload.variant || ""),
        notes: rowNotes,
      });
    }
  }
  return entries;
}

function buildDataQualitySection(payloads, knownLabels) {
  const notes = collectDataQualityNotes(payloads, knownLabels)
    .map((entry) => `- **${entry.model}** — ${entry.notes.join("; ")}`);

  const section = ["", "## Data Quality", ""];
  if (!notes.length) {
    section.push("Every recorded row measured the full sample on every metric.");
    return section;
  }
  section.push(
    "*Rows below were scored on less than the full sample, or are missing a metric entirely. " +
      "Their Overall re-normalizes across whatever was measured, so they are not directly comparable to complete rows.*",
    "",
    ...notes,
  );
  return section;
}

// ---- Structured results --------------------------------------------------
// The UI used to read SUMMARY.md and parse the markdown tables back into
// objects, which meant every number arrived as a string and anything markdown
// cannot express -- per-task counts, weights, diagnostics -- was lost on the
// way out. This is the same data before it gets flattened.
function sceneEntryForRow(sceneIndex, testId, label, bucket) {
  const perTest = sceneIndex && sceneIndex[testId];
  const perModel = perTest && perTest[label];
  if (!perModel) {
    return null;
  }
  return perModel[bucket] || null;
}

function buildRowScenes(sceneIndex, sceneTests, label, bucket) {
  const scenes = {};
  for (const test of sceneTests) {
    const entry = sceneEntryForRow(sceneIndex, test.id, label, bucket);
    scenes[test.id] = entry
      ? {
          status: entry.status,
          elapsedMs: entry.elapsedMs || 0,
          file: entry.file || "",
          rawFile: entry.rawFile || "",
          bytes: entry.bytes || 0,
          error: entry.error || "",
          runtimeErrors: Array.isArray(entry.runtimeErrors) ? entry.runtimeErrors.length : 0,
          endedAt: entry.endedAt || null,
        }
      : null;
  }
  return scenes;
}

// ---- Scene score ----------------------------------------------------------
// Nothing here judges the art. It scores whether the model produced a working
// page at all, which is where the models here actually differ: a 4B emits a
// truncated fragment, a 27B emits a document that parses, renders and draws
// something substantial. Every term is listed in the tooltip so the number
// cannot be mistaken for taste.
const SCENE_SIGNAL_WEIGHTS = {
  produced: 0.30,   // finished and wrote a file at all
  parses: 0.20,     // complete html/head/body with a closing tag
  renders: 0.20,    // no runtime errors reported by a preview
  offline: 0.10,    // no external CDN it cannot load on this machine
  substance: 0.20,  // size, elements, colours -- each capped
};
const SCENE_SUBSTANCE_CAPS = { bytes: 24000, elements: 120, colours: 24 };

function analyseSceneHtml(html) {
  const text = String(html || "");
  const lower = text.toLowerCase();
  const parses = lower.includes("</html>") && (lower.includes("<body") || lower.includes("<canvas") || lower.includes("<svg"));
  const externalScript = /<script[^>]+src=["']https?:/i.test(text) || /<link[^>]+href=["']https?:/i.test(text);
  const elements = (text.match(/<[a-zA-Z][^>]*>/g) || []).length;
  const colours = new Set(
    (text.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) || []).map((value) => value.toLowerCase()),
  ).size;
  return { parses, externalScript, elements, colours, bytes: Buffer.byteLength(text, "utf8") };
}

function clampRatio(value, cap) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(1, value / cap);
}

async function scoreSceneEntry(entry) {
  if (!entry) {
    return null;
  }
  const signals = { produced: 0, parses: 0, renders: 0, offline: 0, substance: 0 };
  const notes = [];
  // A run someone cancelled, or one an llm3 restart interrupted, says nothing
  // about the model. Scoring it zero would punish the model for the operator.
  if (entry.status === "cancelled" || entry.status === "interrupted") {
    return null;
  }
  if (entry.status !== "done" || !entry.file) {
    notes.push(entry.error ? String(entry.error).slice(0, 80) : String(entry.status || "not run"));
    return { value: 0, signals, notes };
  }
  signals.produced = 1;

  let html = "";
  try {
    html = await fs.readFile(path.join(voxel.outputRoot, entry.file), "utf8");
  } catch (_error) {
    notes.push("file missing on disk");
    return { value: SCENE_SIGNAL_WEIGHTS.produced, signals, notes };
  }

  const analysis = analyseSceneHtml(html);
  signals.parses = analysis.parses ? 1 : 0;
  if (!analysis.parses) {
    notes.push("incomplete document");
  }
  // A page nobody has previewed has not been observed to fail, so it keeps the
  // benefit of the doubt; one that threw does not.
  signals.renders = Number(entry.runtimeErrors || 0) > 0 ? 0 : 1;
  if (!signals.renders) {
    notes.push(`${entry.runtimeErrors} runtime error(s)`);
  }
  signals.offline = analysis.externalScript ? 0 : 1;
  if (analysis.externalScript) {
    notes.push("needs an external CDN");
  }
  signals.substance = (
    clampRatio(analysis.bytes, SCENE_SUBSTANCE_CAPS.bytes)
    + clampRatio(analysis.elements, SCENE_SUBSTANCE_CAPS.elements)
    + clampRatio(analysis.colours, SCENE_SUBSTANCE_CAPS.colours)
  ) / 3;

  let value = 0;
  for (const [key, weight] of Object.entries(SCENE_SIGNAL_WEIGHTS)) {
    value += signals[key] * weight;
  }
  return { value, signals, notes, analysis };
}

// One number per row, averaged over the scenes that were actually run for it.
async function scoreScenesForRow(sceneIndex, sceneTests, label, bucket) {
  const scored = [];
  const notes = [];
  for (const test of sceneTests) {
    const entry = sceneEntryForRow(sceneIndex, test.id, label, bucket);
    if (!entry) {
      continue;
    }
    const result = await scoreSceneEntry(entry);
    if (!result) {
      continue;
    }
    scored.push(result.value);
    notes.push(`${test.id}: ${(result.value * 100).toFixed(0)}%${result.notes.length ? ` (${result.notes.join(", ")})` : ""}`);
  }
  if (!scored.length) {
    return null;
  }
  return {
    value: scored.reduce((total, item) => total + item, 0) / scored.length,
    n: scored.length,
    notes,
  };
}

async function buildResultsPayload(options = {}) {
  const payloads = (await readBenchmarks()).slice().sort(compareBenchmarkPayloads);

  let inventory = [];
  let knownLabels = null;
  try {
    inventory = await discoverInventory({ selectedSlot: String(options.selectedSlot || "") });
    knownLabels = new Set(
      inventory.map((item) => String(item.label || item.modelLabel || item.key || item.modelKey || "")),
    );
  } catch (_error) {
    // Discovery is best-effort: a transient failure must not blank the table or
    // mark every row stale.
    inventory = [];
  }

  const sceneIndex = await voxel.readSceneIndex().catch(() => ({}));
  const sceneTests = voxel.listTests();

  const rows = await Promise.all(payloads.map(async (payload) => {
    const label = String(payload.modelLabel || payload.modelKey || "unknown");
    const variant = String(payload.variant || "");
    const bucket = thinkingBucketForVariant(variant);
    const sceneScore = await scoreScenesForRow(sceneIndex, sceneTests, label, bucket);
    return {
      id: `${label}::${String(payload.launcher || payload.runtime || "")}::${variant || "-"}`,
      resultDir: String(payload.resultDirName || ""),
      model: label,
      runtime: String(payload.runtime || "unknown"),
      launcher: String(payload.launcher || payload.runtime || "unknown"),
      variant: variant || "-",
      thinkingBucket: bucket,
      sizeLabel: String(payload.sizeLabel || "unknown"),
      sizeBytes: Number(payload.sizeBytes || 0),
      status: String(payload.overallStatus || "pending"),
      stale: Boolean(knownLabels && !knownLabels.has(label)),
      perf: {
        loadS: asNumber(metric(payload, "benchmarks", "loadTime", "seconds")),
        ttftS: asNumber(metric(payload, "benchmarks", "basicResponse", "ttftSeconds")),
        decodeTps: decodeThroughputMetricValue(payload),
        answerTps: answerThroughputMetricValue(payload),
        // schemaVersion 2 rows: the decode rate is the median of `repeats`
        // samples, and a prompt-processing probe ran on a cold cache.
        decodeRepeats: asNumber(metric(payload, "benchmarks", "throughput", "repeats")),
        decodeSpreadPct: asNumber(metric(payload, "benchmarks", "throughput", "tokensPerSecondSpreadPct")),
        decodeMin: asNumber(metric(payload, "benchmarks", "throughput", "tokensPerSecondMin")),
        decodeMax: asNumber(metric(payload, "benchmarks", "throughput", "tokensPerSecondMax")),
        promptTps: asNumber(metric(payload, "benchmarks", "throughput", "promptProcessing", "tokensPerSecond")),
        promptTokens: asNumber(metric(payload, "benchmarks", "throughput", "promptProcessing", "promptTokens")),
        // Fixed-length decode: comparable across models because every one is
        // asked for the same token count, unlike the scenario decode rate.
        probeTps: asNumber(metric(payload, "benchmarks", "throughput", "decodeProbe", "tokensPerSecond")),
        probeTokens: asNumber(metric(payload, "benchmarks", "throughput", "decodeProbe", "tokensGenerated")),
        probeHitCap: metric(payload, "benchmarks", "throughput", "decodeProbe", "hitCap") === true,
        warmups: asNumber(metric(payload, "benchmarks", "throughput", "warmupsCompleted")),
        tokenCountMethod: String(metric(payload, "benchmarks", "throughput", "tokenCountMethod") || ""),
      },
      schemaVersion: asNumber(payload.schemaVersion) || 1,
      agentic: {
        result: String(metric(payload, "benchmarks", "agentic", "result") || ""),
        toolCalls: asNumber(metric(payload, "benchmarks", "agentic", "toolCallsMade")),
        toolSupport: String(metric(payload, "benchmarks", "agentic", "toolSupport") || ""),
      },
      score: buildScore(payload, sceneScore),
      scenes: buildRowScenes(sceneIndex, sceneTests, label, bucket),
      hasTranslation: Boolean(String(metric(payload, "benchmarks", "quality", "translationArtifact", "translation") || "").trim()),
      startedAt: metric(payload, "timestamps", "started") || null,
      errors: Array.isArray(payload.errors)
        ? payload.errors.filter(Boolean).map((error) => ({
            stage: String(error.stage || ""),
            code: String(error.code || ""),
            message: String(error.message || ""),
          }))
        : [],
    };
  }));

  // Models that exist on disk but were never benchmarked would otherwise be
  // invisible here, because the table is built from results. They come through
  // as pending rows so they can be seen, sorted and ticked for a run.
  const benchmarked = new Set(rows.map((row) => row.model));
  for (const item of inventory) {
    const label = String(item.label || item.modelLabel || item.key || item.modelKey || "").trim();
    if (!label || benchmarked.has(label)) {
      continue;
    }
    benchmarked.add(label);
    rows.push({
      id: `${label}::${String(item.runtime || "unknown")}::-`,
      model: label,
      runtime: String(item.runtime || "unknown"),
      launcher: String(item.runtime || "unknown"),
      variant: "-",
      thinkingBucket: "no-think",
      sizeLabel: String(item.sizeLabel || "unknown"),
      sizeBytes: Number(item.sizeBytes || 0),
      status: "not benchmarked",
      stale: false,
      pending: true,
      perf: { loadS: null, ttftS: null, decodeTps: null, answerTps: null },
      agentic: { result: "", toolCalls: null, toolSupport: "" },
      score: null,
      scenes: buildRowScenes(sceneIndex, sceneTests, label, "no-think"),
      hasTranslation: false,
      startedAt: null,
      errors: [],
    });
  }

  assignScoreTiers(rows);

  const runtimeAverages = [];
  for (const runtime of ["gguf", "mlx", "mtplx", "dflash"]) {
    const subset = payloads.filter((payload) => payload.runtime === runtime);
    if (!subset.length) {
      continue;
    }
    runtimeAverages.push({
      runtime,
      models: subset.length,
      loadS: avg(subset.map((item) => asNumber(metric(item, "benchmarks", "loadTime", "seconds")))),
      ttftS: avg(subset.map((item) => asNumber(metric(item, "benchmarks", "basicResponse", "ttftSeconds")))),
      decodeTps: avg(subset.map((item) => decodeThroughputMetricValue(item))),
      answerTps: avg(subset.map((item) => answerThroughputMetricValue(item))),
    });
  }

  const counts = { pass: 0, partial: 0, fail: 0, pending: 0 };
  for (const payload of payloads) {
    const status = String(payload.overallStatus || "pending");
    if (status in counts) {
      counts[status] += 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    benchmarks: BENCHMARK_CATALOG.map((entry) => ({
      id: entry.id,
      label: entry.label,
      weight: entry.weight,
      kind: entry.kind,
      defaultOn: entry.defaultOn,
      blurb: entry.blurb,
      warning: entry.warning || "",
      secondsPerQuestion: entry.secondsPerQuestion == null ? null : entry.secondsPerQuestion,
      fixedSeconds: entry.fixedSeconds || 0,
      taskCount: entry.taskCount || 1,
      // A metric can be part of the scoring model before the runner can measure
      // it; the launcher greys those out instead of offering a run that fails.
      available: entry.runner ? RUNNER_QUALITY_METRICS.includes(entry.runner) : true,
    })),
    sceneTests,
    sceneSignals: SCENE_SIGNAL_WEIGHTS,
    rows,
    runtimeAverages,
    // The machine the newest row was measured on (schemaVersion 2 rows record
    // it); older rows carry nothing, so this can be null.
    host: newestHost(payloads),
    dataQuality: collectDataQualityNotes(payloads, knownLabels),
    counts: {
      ...counts,
      rows: payloads.length,
      models: benchmarked.size,
      discovered: inventory.length,
    },
  };
}

async function buildSummaryMarkdown() {
  const payloads = (await readBenchmarks()).slice().sort(compareBenchmarkPayloads);
  if (!payloads.length) {
    return "# Benchmark Summary\n\nNo benchmark results are available yet.\n";
  }

  let discoveredModels = payloads.length;
  let knownLabels = null;
  try {
    const inventory = await discoverInventory({});
    discoveredModels = Array.isArray(inventory) ? inventory.length : discoveredModels;
    // Used to mark result rows whose model is gone from disk. Left null when
    // discovery fails so a transient error cannot label every row stale.
    knownLabels = Array.isArray(inventory)
      ? new Set(inventory.map((item) => String(item.label || item.modelLabel || item.key || item.modelKey || "")))
      : null;
  } catch (_error) {
    // Fall back to results count when inventory discovery is unavailable.
  }

  const statusCounts = { pass: 0, partial: 0, fail: 0 };
  for (const payload of payloads) {
    const status = String(payload.overallStatus || "pending");
    if (status in statusCounts) {
      statusCounts[status] += 1;
    }
  }

  const lines = [
    "# Benchmark Summary",
    "",
    "## Executive Summary",
    "",
    `- Model+launcher combos discovered: **${discoveredModels}**`,
    `- Result rows (one per thinking variant): **${payloads.length}**`,
    `- Pass: **${statusCounts.pass}**`,
    `- Partial: **${statusCounts.partial}**`,
    `- Fail: **${statusCounts.fail}**`,
    "",
    "## Performance Comparison",
    "",
    "*Decode tok/s = generation rate after the first token (TTFT excluded). " +
      "Answer tok/s = answer tokens over the whole run — thinking time counts against it, " +
      "so 0 means the model never finished thinking inside the window.*",
    "*DeepEval = DeepEval IFEval instruction-following score on a 0–1 scale.*",
    `*Overall = weighted smartness score: ${BENCHMARK_CATALOG.map((entry) => `${entry.label} ${Number((entry.weight * 100).toFixed(1))}%`).join(", ")}. Missing metrics are re-normalized across the available weights.*`,
    "*HE chrF = character-F similarity of the model's Hebrew translation of a fixed English passage against a fixed reference translation. It is a sorting aid, not a correctness score — open the column's side-by-side view to judge the translation.*",
    "",
    "| Model | Runtime | Launcher | Variant | Load (s) | TTFT (s) | Decode tok/s | Answer tok/s | MMLU | MMLU-Pro | MATH-500 | HumanEval | HE chrF | GSM8K | DeepEval | Overall | Status |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const payload of payloads) {
    const quality = qualityMetricsFromPayload(payload);
    lines.push(
      `| ${String(payload.modelLabel || payload.modelKey || "unknown")} | ${String(payload.runtime || "unknown")} | ${String(payload.launcher || payload.runtime || "unknown")} | ${String(payload.variant || "-")} | ${formatMetric(asNumber(metric(payload, "benchmarks", "loadTime", "seconds")))} | ${formatMetric(asNumber(metric(payload, "benchmarks", "basicResponse", "ttftSeconds")))} | ${formatMetric(decodeThroughputMetricValue(payload))} | ${formatMetric(answerThroughputMetricValue(payload))} | ${formatMetric(quality.avgMmlu)} | ${formatMetric(quality.mmluPro)} | ${formatMetric(quality.math500)} | ${formatMetric(quality.humanEval)} | ${formatMetric(quality.hebrewTranslation)} | ${formatMetric(quality.gsm8k)} | ${formatMetric(quality.deepEval)} | ${formatMetric(quality.overall)} | ${String(payload.overallStatus || "pending")} |`,
    );
  }

  lines.push("", "## By Runtime Family", "", "| Runtime | Models | Avg Load (s) | Avg TTFT (s) | Avg Decode tok/s | Avg Answer tok/s |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const runtime of ["gguf", "mlx", "mtplx", "dflash"]) {
    const subset = payloads.filter((payload) => payload.runtime === runtime);
    if (!subset.length) {
      continue;
    }
    lines.push(
      `| ${runtime} | ${subset.length} | ${formatMetric(avg(subset.map((item) => asNumber(metric(item, "benchmarks", "loadTime", "seconds")))))} | ${formatMetric(avg(subset.map((item) => asNumber(metric(item, "benchmarks", "basicResponse", "ttftSeconds")))))} | ${formatMetric(avg(subset.map((item) => decodeThroughputMetricValue(item))))} | ${formatMetric(avg(subset.map((item) => answerThroughputMetricValue(item))))} |`,
    );
  }

  lines.push("", "## By Model Size", "", "| Model | Size | Load (s) | Decode tok/s | Answer tok/s |", "| --- | --- | ---: | ---: | ---: |");
  const bySize = payloads.slice().sort((left, right) => Number(right.sizeBytes || 0) - Number(left.sizeBytes || 0));
  for (const payload of bySize) {
    lines.push(
      `| ${String(payload.modelLabel || payload.modelKey || "unknown")} | ${String(payload.sizeLabel || "unknown")} | ${formatMetric(asNumber(metric(payload, "benchmarks", "loadTime", "seconds")))} | ${formatMetric(decodeThroughputMetricValue(payload))} | ${formatMetric(answerThroughputMetricValue(payload))} |`,
    );
  }

  lines.push("", "## Error Log", "");
  const errorRows = [];
  for (const payload of payloads) {
    for (const error of payload.errors || []) {
      if (!error || typeof error !== "object") {
        continue;
      }
      errorRows.push([
        String(payload.modelLabel || payload.modelKey || "unknown"),
        String(error.stage || ""),
        String(error.code || ""),
        String(error.message || ""),
      ]);
    }
  }
  if (errorRows.length) {
    lines.push("| Model | Stage | Code | Message |", "| --- | --- | --- | --- |");
    for (const row of errorRows) {
      lines.push(`| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} |`);
    }
  } else {
    lines.push("No errors recorded.");
  }

  lines.push("", "## Agentic Results", "", "| Model | Result | Tool Support | Tool Calls | Status |", "| --- | --- | --- | ---: | --- |");
  for (const payload of payloads) {
    const agentic = metric(payload, "benchmarks", "agentic") || {};
    lines.push(
      `| ${String(payload.modelLabel || payload.modelKey || "unknown")} | ${String(agentic.result || "n/a")} | ${String(agentic.toolSupport || "unknown")} | ${String(agentic.toolCallsMade || 0)} | ${String(agentic.status || "pending")} |`,
    );
  }

  const fastestLoad = bestPayload(payloads, (item) => asNumber(metric(item, "benchmarks", "loadTime", "seconds")), false);
  const bestTtft = bestPayload(payloads, (item) => asNumber(metric(item, "benchmarks", "basicResponse", "ttftSeconds")), false);
  const bestDecodeTps = bestPayload(payloads, decodeThroughputMetricValue, true);
  const bestAnswerTps = bestPayload(payloads, answerThroughputMetricValue, true);
  const agenticPasses = payloads.filter((item) => metric(item, "benchmarks", "agentic", "result") === "pass");

  const qualityPayloads = payloads.filter((item) => hasQualityMetrics(item));
  const qualityTable = qualityPayloads.length ? ["", "## Quality Benchmarks", "", "| Model | MMLU (avg 3 subsets) | MMLU-Pro | HE chrF | GSM8K | DeepEval | Overall |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"] : [];
  for (const payload of qualityPayloads) {
    const quality = qualityMetricsFromPayload(payload);
    qualityTable.push(
      `| ${String(payload.modelLabel || payload.modelKey || "unknown")} | ${formatMetric(quality.avgMmlu)} | ${formatMetric(quality.mmluPro)} | ${formatMetric(quality.hebrewTranslation)} | ${formatMetric(quality.gsm8k)} | ${formatMetric(quality.deepEval)} | ${formatMetric(quality.overall)} |`,
    );
  }

  lines.push(...qualityTable);
  lines.push(...buildDataQualitySection(payloads, knownLabels));
  lines.push("", "## Recommendations", "");
  if (fastestLoad) {
    lines.push(`- Fastest load: **${fastestLoad.modelLabel}** (${formatMetric(asNumber(metric(fastestLoad, "benchmarks", "loadTime", "seconds")))} s)`);
  }
  if (bestTtft) {
    lines.push(`- Best TTFT: **${bestTtft.modelLabel}** (${formatMetric(asNumber(metric(bestTtft, "benchmarks", "basicResponse", "ttftSeconds")))} s)`);
  }
  if (bestDecodeTps) {
    lines.push(`- Best decode throughput: **${bestDecodeTps.modelLabel}** (${formatMetric(decodeThroughputMetricValue(bestDecodeTps))} tok/s)`);
  }
  if (bestAnswerTps) {
    lines.push(`- Best answer throughput: **${bestAnswerTps.modelLabel}** (${formatMetric(answerThroughputMetricValue(bestAnswerTps))} tok/s)`);
  }
  const bestQuality = bestPayload(payloads, (item) => asNumber(metric(item, "benchmarks", "quality", "avgMmlu")), true);
  if (bestQuality) {
    lines.push(`- Best MMLU: **${bestQuality.modelLabel}** (${formatMetric(asNumber(metric(bestQuality, "benchmarks", "quality", "avgMmlu")))} avg)`);
  }
  const bestMmluPro = bestPayload(payloads, (item) => asNumber(metric(item, "benchmarks", "quality", "scores", "mmlu_pro")), true);
  if (bestMmluPro) {
    lines.push(`- Best MMLU-Pro: **${bestMmluPro.modelLabel}** (${formatMetric(asNumber(metric(bestMmluPro, "benchmarks", "quality", "scores", "mmlu_pro")))} acc)`);
  }
  const bestHebrewTranslation = bestPayload(payloads, (item) => asNumber(metric(item, "benchmarks", "quality", "scores", "hebrew_translation")), true);
  if (bestHebrewTranslation) {
    lines.push(`- Best Hebrew translation: **${bestHebrewTranslation.modelLabel}** (${formatMetric(asNumber(metric(bestHebrewTranslation, "benchmarks", "quality", "scores", "hebrew_translation")))} chrF)`);
  }
  const bestGsm8k = bestPayload(payloads, (item) => asNumber(metric(item, "benchmarks", "quality", "scores", "gsm8k")), true);
  if (bestGsm8k) {
    lines.push(`- Best GSM8K: **${bestGsm8k.modelLabel}** (${formatMetric(asNumber(metric(bestGsm8k, "benchmarks", "quality", "scores", "gsm8k")))} acc)`);
  }
  const bestOverall = bestPayload(payloads, (item) => asNumber(metric(item, "benchmarks", "quality", "overallAverage")), true);
  if (bestOverall) {
    lines.push(`- Best Overall: **${bestOverall.modelLabel}** (${formatMetric(asNumber(metric(bestOverall, "benchmarks", "quality", "overallAverage")))} weighted)`);
  }
  if (agenticPasses.length) {
    lines.push(`- Agentic passes: **${agenticPasses.slice(0, 5).map((item) => String(item.modelLabel || item.modelKey || "unknown")).join(", ")}**`);
  } else {
    lines.push("- Agentic passes: none yet");
  }

  return `${lines.join("\n").trim()}\n`;
}

async function summarizeRunProgress(run) {
  const payloads = await readBenchmarks();
  const runStartedMs = Date.parse(run.startedAt);
  const relevant = payloads.filter((payload) => {
    const started = payload && payload.timestamps && payload.timestamps.started;
    if (!started) {
      return false;
    }
    return Date.parse(started) >= runStartedMs - 1000;
  });

  const completed = relevant.filter((payload) => payload.timestamps && payload.timestamps.stopped);
  const active = relevant
    .filter((payload) => !payload.timestamps || !payload.timestamps.stopped)
    .sort((left, right) => Date.parse((right.timestamps && right.timestamps.started) || 0) - Date.parse((left.timestamps && left.timestamps.started) || 0))[0] || null;

  const counts = { pass: 0, partial: 0, fail: 0 };
  for (const payload of completed) {
    const status = String(payload.overallStatus || "");
    if (status in counts) {
      counts[status] += 1;
    }
  }

  return {
    relevantCount: relevant.length,
    completedCount: completed.length,
    currentModel: active ? String(active.modelLabel || active.modelKey || "") : null,
    currentStage: active ? inferActiveStage(active) : null,
    activePayload: active,
    counts,
  };
}

async function getBenchmarkStatus() {
  await adoptPersistedSession();
  if (benchmarkSession && benchmarkSession.pid && !isPidAlive(benchmarkSession.pid) && !benchmarkSession.endedAt) {
    // A run we started (or adopted) ended without the exit event reaching us.
    await finishSession(benchmarkSession, benchmarkSession.child ? benchmarkSession.child.exitCode : null);
  }

  const sessionRunning = benchmarkSession && benchmarkSession.pid && isPidAlive(benchmarkSession.pid) && !benchmarkSession.endedAt;
  // `ps` over every process is the expensive part of a status poll; it is only
  // needed to notice a runner that something other than this dashboard started.
  const externalProcesses = sessionRunning ? [] : await listBenchmarkProcesses();
  const chosen = sessionRunning
    ? {
        pid: benchmarkSession.pid,
        startedAt: benchmarkSession.startedAt,
        args: benchmarkSession.args.slice(),
        command: benchmarkSession.command,
        source: "llm3",
      }
    : (externalProcesses[0] ? { ...externalProcesses[0], source: "external" } : null);

  const scenePhase = benchmarkSession && benchmarkSession.scenePhase ? benchmarkSession.scenePhase : null;
  // A scene can also be started on its own, from a row menu or an empty cell,
  // with no benchmark session behind it at all. That is still the slot being
  // busy and still a model doing work, and the table has to be able to say so.
  const looseSceneWork = !chosen && !scenePhase ? voxel.activeSceneWork() : [];
  if (looseSceneWork.length) {
    const first = looseSceneWork[0];
    return {
      running: true,
      phase: "scenes",
      source: "scene",
      standalone: true,
      sceneTest: first.test,
      sceneLabel: first.label,
      sceneThinking: first.thinking,
      currentModel: first.model,
      currentStage: `scene:${first.test}`,
      activeModels: [...new Set(looseSceneWork.map((item) => item.model))],
      startedAt: first.startedAt ? new Date(first.startedAt).toISOString() : null,
      totalModels: looseSceneWork.length,
      completedModels: 0,
      progressPercent: null,
    };
  }
  if (!chosen && scenePhase) {
    const sceneState = voxel.getVoxelState(scenePhase.test);
    const done = (sceneState.models || []).filter((item) => item.status !== "pending" && item.status !== "running").length;
    const total = (sceneState.models || []).length;
    return {
      running: true,
      phase: "scenes",
      source: "llm3",
      pid: null,
      startedAt: benchmarkSession.startedAt,
      sceneTest: scenePhase.test,
      sceneThinking: scenePhase.thinking,
      sceneLabel: sceneState.label || scenePhase.test,
      totalModels: total,
      completedModels: done,
      currentModel: (sceneState.models || []).filter((item) => item.status === "running").map((item) => item.model)[0] || "",
      activeModels: (sceneState.models || []).filter((item) => item.status === "running").map((item) => item.model),
      currentStage: `scene:${scenePhase.test}`,
      progressPercent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null,
      queuedScenes: (benchmarkSession.sceneQueue || []).map((job) => job.test),
      recentLog: await sessionRecentLog(benchmarkSession),
    };
  }

  if (!chosen) {
    return {
      running: false,
      phase: "idle",
      activeModels: [],
      lastRun: benchmarkSession
        ? {
            startedAt: benchmarkSession.startedAt,
            endedAt: benchmarkSession.endedAt,
            exitCode: benchmarkSession.exitCode,
            command: benchmarkSession.command,
            adopted: Boolean(benchmarkSession.adopted),
            recentLog: await sessionRecentLog(benchmarkSession),
          }
        : null,
    };
  }

  const config = parseRunnerArgs(chosen.args || []);
  let totalModels = null;
  let selectedModels = [];
  try {
    const inventory = await discoverInventory(config);
    selectedModels = inventory.map((item) => item.label || item.modelLabel || item.key || item.modelKey || "");
    totalModels = inventory.length;
  } catch (_error) {
    selectedModels = [];
    totalModels = null;
  }

  const progress = await summarizeRunProgress(chosen);
  const currentLog = await readCurrentModelLog(progress.activePayload);
  const completed = progress.completedCount;
  const inferredTotal = totalModels || Math.max(progress.relevantCount, completed);
  const percentage = inferredTotal > 0 ? Math.min(100, Math.round((completed / inferredTotal) * 100)) : null;

  return {
    running: true,
    phase: "benchmark",
    source: chosen.source,
    pid: chosen.pid,
    startedAt: chosen.startedAt,
    args: config,
    command: chosen.command,
    totalModels: inferredTotal,
    completedModels: completed,
    currentModel: progress.currentModel,
    // Everything the machine is working on right now, so a row can show it is
    // busy without the caller having to guess from a single "current" name.
    activeModels: [
      ...new Set([
        progress.currentModel,
        ...voxel.activeSceneWork().map((item) => item.model),
      ].filter(Boolean)),
    ],
    currentStage: progress.currentStage,
    progressPercent: percentage,
    counts: progress.counts,
    activeResultDir: progress.activePayload ? String(progress.activePayload.resultDir || "") : "",
    activeVariant: progress.activePayload ? String(progress.activePayload.variant || "") : "",
    selectedModels,
    adopted: Boolean(chosen.source === "llm3" && benchmarkSession && benchmarkSession.adopted),
    recentLog: chosen.source === "llm3" && benchmarkSession ? await sessionRecentLog(benchmarkSession) : "",
    currentLogName: currentLog.logName,
    currentLog: currentLog.logTail,
  };
}

// ---- Launch configuration ------------------------------------------------
// The launcher used to speak the runner's language: free-text model filters,
// four overlapping thinking checkboxes and a "force re-run" tickbox. What the
// UI sends now is what a person actually chooses -- which models, which
// benchmarks, and whether to compare thinking on and off -- and this turns that
// into runner config. Older field names still work so nothing breaks mid-deploy.
const LAUNCH_VARIANT_MODES = new Set(["no-think", "think", "both"]);

function normalizeLaunchConfig(body) {
  const raw = body && typeof body === "object" ? { ...body } : {};
  const config = { ...raw };

  const models = normalizeStringArray(raw.models);
  if (models.length) {
    config.modelFilters = models;
  }

  if (Array.isArray(raw.benchmarks)) {
    const benchmarks = normalizeStringArray(raw.benchmarks);
    const sceneIds = new Set(voxel.listTests().map((test) => String(test.id)));
    config.sceneTests = benchmarks
      .filter((id) => id.startsWith(SCENE_BENCHMARK_PREFIX))
      .map((id) => id.slice(SCENE_BENCHMARK_PREFIX.length))
      .filter((id) => sceneIds.has(id));
    config.qualityMetrics = benchmarks.filter((id) => RUNNER_QUALITY_METRICS.includes(id));
  } else {
    config.sceneTests = normalizeStringArray(raw.sceneTests);
  }

  if (raw.variants && LAUNCH_VARIANT_MODES.has(String(raw.variants))) {
    const mode = String(raw.variants);
    config.variants = mode;
    config.thinking = mode === "think";
    config.simpleThinkingVariants = mode === "both";
    config.variant = mode === "both" ? null : mode;
    // The 4-way grammar sweep stays an advanced opt-in and overrides the pair.
    config.thinkingVariants = Boolean(raw.thinkingVariants);
  }

  config.force = Boolean(raw.force);
  return config;
}

function variantBucketsForConfig(config) {
  if (config.thinkingVariants) {
    return ["no-think", "think", "think-tiny", "think-gbnf"];
  }
  if (config.simpleThinkingVariants) {
    return ["no-think", "think"];
  }
  return [config.thinking ? "think" : "no-think"];
}

// Rough, and labelled rough in the UI. Prior runs of the same row are the best
// estimator available, so they are used when present; everything else falls back
// to fleet medians measured from the recorded results.
const ESTIMATE_FALLBACK = {
  loadSeconds: 20,
  // Load, basic response, agentic and throughput, which do not scale with the
  // quality sample.
  fixedSeconds: 100,
  sceneSeconds: 150,
};
// A thinking question does not cost a multiple of a non-thinking one -- it
// costs however long the model spends generating, which is its own token budget
// divided by its own decode rate. A flat multiplier quoted 18s per question for
// a dense 27B that actually takes 140s, so a five-hour run was advertised as
// forty minutes.
//
// Measured: a 27B at 28.5 tok/s was still generating at 3,244 tokens on a single
// MMLU-Pro question; a 4B at 93 tok/s produced around 5,000. 4,000 is the
// working figure, clamped by the per-question ceiling the runner enforces.
const THINKING_TOKENS_TYPICAL = 4000;
const THINKING_QUESTION_CEILING_SECONDS = 300;
const FALLBACK_DECODE_TOKENS_PER_SECOND = 30;

function thinkingSecondsPerQuestion(decodeTokensPerSecond) {
  const rate = decodeTokensPerSecond && decodeTokensPerSecond > 0
    ? decodeTokensPerSecond
    : FALLBACK_DECODE_TOKENS_PER_SECOND;
  return Math.min(THINKING_QUESTION_CEILING_SECONDS, THINKING_TOKENS_TYPICAL / rate);
}

function estimateRowSeconds(item, config, priorByDir, decodeByModel) {
  const prior = priorByDir.get(String(item.resultDirName || "")) || null;
  const variant = String(item.variant || "")
    || (String(item.resultDirName || "").split("__")[2] || "");
  const bucket = thinkingBucketForVariant(variant);
  const priorLoad = asNumber(metric(prior, "benchmarks", "loadTime", "seconds"));
  const loadSeconds = priorLoad == null ? ESTIMATE_FALLBACK.loadSeconds : priorLoad;

  const configuredLimit = safeInt(config.qualityLimit, DEFAULT_QUALITY_LIMIT);
  const limit = bucket === "think" ? Math.max(20, Math.floor(configuredLimit / 2)) : configuredLimit;
  const label = String(item.label || item.modelLabel || "");
  const thinkingSeconds = thinkingSecondsPerQuestion(decodeByModel ? decodeByModel.get(label) : null);

  // Per-metric costs differ by an order of magnitude -- MMLU-Pro answers a
  // question in about a second, MATH-500 takes nine -- so one blended figure
  // would quietly mislead about exactly the runs worth thinking twice about.
  let qualitySeconds = 0;
  for (const id of config.qualityMetrics || []) {
    const entry = BENCHMARK_CATALOG.find((candidate) => candidate.runner === id);
    if (!entry) {
      continue;
    }
    // A thinking row's cost is set by how long the model generates, not by which
    // benchmark asked the question.
    const perQuestion = bucket === "think"
      ? thinkingSeconds
      : (entry.secondsPerQuestion == null ? 1.5 : entry.secondsPerQuestion);
    qualitySeconds += (entry.fixedSeconds || 0) + limit * perQuestion * (entry.taskCount || 1);
  }
  return loadSeconds + ESTIMATE_FALLBACK.fixedSeconds + qualitySeconds;
}

// What a launch would actually do, resolved through the same discovery the run
// uses -- so the row list, the "these already have results" warning and the time
// estimate all describe the run that is about to happen, not an approximation
// of it.
async function resolveLaunchPlan(config) {
  const inventory = await discoverInventory(config);
  const priorPayloads = await readBenchmarks();
  const priorByDir = new Map();
  for (const payload of priorPayloads) {
    const dir = path.basename(String(payload.resultDir || ""));
    if (dir) {
      priorByDir.set(dir, payload);
    }
  }

  // Each model's own decode rate, from whatever it last recorded.
  const decodeByModel = new Map();
  for (const payload of priorPayloads) {
    const label = String(payload.modelLabel || payload.modelKey || "");
    const rate = asNumber(metric(payload, "benchmarks", "throughput", "tokensPerSecond"));
    if (label && rate && !decodeByModel.has(label)) {
      decodeByModel.set(label, rate);
    }
  }

  const rows = [];
  let estimateSeconds = 0;
  for (const item of inventory) {
    const resultDirName = String(item.resultDirName || "");
    const variant = resultDirName.split("__")[2] || "";
    const existingPayload = priorByDir.get(resultDirName) || null;
    const seconds = estimateRowSeconds({ ...item, variant }, config, priorByDir, decodeByModel);
    estimateSeconds += seconds;
    rows.push({
      model: String(item.label || item.modelLabel || item.key || "unknown"),
      runtime: String(item.runtime || "unknown"),
      launcher: String(item.launcher || item.runtime || "unknown"),
      variant: variant || "-",
      sizeLabel: String(item.sizeLabel || "unknown"),
      resultDirName,
      hasResults: Boolean(existingPayload),
      estimateSeconds: Math.round(seconds),
    });
  }

  const sceneTests = normalizeStringArray(config.sceneTests);
  const sceneModels = new Set(rows.map((row) => row.model));
  estimateSeconds += sceneTests.length * sceneModels.size * ESTIMATE_FALLBACK.sceneSeconds;

  const existing = rows.filter((row) => row.hasResults);
  return {
    rows,
    existing: existing.map((row) => ({ model: row.model, variant: row.variant })),
    existingModels: [...new Set(existing.map((row) => row.model))],
    models: sceneModels.size,
    variants: variantBucketsForConfig(config),
    sceneTests,
    estimateSeconds: Math.round(estimateSeconds),
  };
}

// Scenes drive the same slot as the runner (voxel-test refuses to share one), so
// they cannot overlap the benchmark -- they run after it, inside the same
// session, and the status endpoint reports which phase is live.
async function runSceneQueueForSession(session) {
  if (!session || !Array.isArray(session.sceneQueue) || !session.sceneQueue.length) {
    return;
  }
  const slotId = String(session.sceneSlot || "slot3");
  const publicBase = `http://127.0.0.1:${8036 + (Number(slotId.replace(/\D/g, "")) || 1) - 1}`;
  // Shift rather than iterate a copy: the status endpoint reports what is left
  // in the queue, and a queue that never drains reports the same "1 queued"
  // from the first job to the last.
  while (session.sceneQueue.length) {
    if (session.sceneCancelled) {
      break;
    }
    const job = session.sceneQueue.shift();
    const testId = String(job.test || job);
    const thinking = typeof job.thinking === "boolean" ? job.thinking : Boolean(session.sceneThinking);
    session.scenePhase = { test: testId, thinking };
    // Written before the scene starts, so a process that dies during it knows
    // on restart which scene to pick up and what is still queued behind it.
    await persistSession(session);
    try {
      const inventory = await discoverInventory({
        selectedSlot: slotId,
        modelFilters: session.sceneModelFilters || [],
      });
      const wanted = [];
      const seen = new Set();
      for (const item of inventory) {
        const label = String(item.label || item.modelLabel || item.key || "").trim();
        const key = String(item.key || item.modelKey || "").trim();
        if (!label || !key || seen.has(label)) {
          continue;
        }
        seen.add(label);
        wanted.push({ label, modelKey: key });
      }
      if (!wanted.length) {
        continue;
      }
      await voxel.startVoxelTest({
        slotId,
        models: wanted,
        publicBase,
        test: testId,
        thinking,
      });
      // startVoxelTest returns as soon as the run is under way.
      while (voxel.getVoxelState(testId).running) {
        await sleep(2000);
      }
    } catch (error) {
      appendSessionLog("[scenes] ", Buffer.from(`${testId}: ${error.message || error}`));
    }
  }
  session.scenePhase = null;
  session.sceneQueue = [];
  await persistSession(session);
}

function startBenchmark(config) {
  // Synchronous guard: the checks below await `ps` and model discovery, and two
  // POSTs in that window used to both spawn a runner.
  if (startInFlight) {
    return Promise.reject(Object.assign(new Error("A benchmark start is already in progress."), { statusCode: 409 }));
  }
  startInFlight = true;
  return startBenchmarkLocked(config).finally(() => {
    startInFlight = false;
  });
}

function startBenchmarkLocked(config) {
  return new Promise(async (resolve, reject) => {
    try {
      const current = await getBenchmarkStatus();
      if (current.running) {
        reject(Object.assign(new Error("A benchmark is already running."), { statusCode: 409 }));
        return;
      }
    } catch (error) {
      reject(error);
      return;
    }

    let inventory;
    try {
      inventory = await discoverInventory(config);
    } catch (error) {
      reject(Object.assign(new Error(`Failed to resolve selected models: ${error.message || error}`), { statusCode: 400 }));
      return;
    }
    if (!Array.isArray(inventory) || inventory.length === 0) {
      reject(Object.assign(new Error("No models match the current benchmark filters."), { statusCode: 400 }));
      return;
    }

    const args = buildRunnerArgs(config);
    // Detached, in its own session, output to a file: a `pm2 restart llm3`
    // signals the server alone (see ecosystem.config.cjs) and the run carries
    // on; the next server process re-adopts it from session.json.
    let logHandle;
    try {
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.rm(runnerLogPath, { force: true });
      logHandle = await fs.open(runnerLogPath, "a");
    } catch (error) {
      reject(Object.assign(new Error(`Cannot open the runner log: ${error.message || error}`), { statusCode: 500 }));
      return;
    }
    const child = spawn("python3", ["-u", ...args], {
      cwd: benchmarkRoot,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      detached: true,
    });
    child.unref();
    child.once("spawn", () => logHandle.close().catch(() => {}));
    child.once("error", () => logHandle.close().catch(() => {}));

    // Scenes run after the runner exits, once per requested thinking bucket, so
    // a "both variants" launch fills in both the think and no-think scene cells.
    const sceneBuckets = [...new Set(variantBucketsForConfig(config).map(thinkingBucketForVariant))];
    const sceneQueue = [];
    for (const testId of normalizeStringArray(config.sceneTests)) {
      for (const bucket of sceneBuckets) {
        sceneQueue.push({ test: testId, thinking: bucket === "think" });
      }
    }

    benchmarkSession = {
      child,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      args: args.slice(1),
      command: `python3 -u ${args.join(" ")}`,
      logLines: [],
      selectedModels: inventory.map((item) => item.label || item.modelLabel || item.key || item.modelKey || "unknown"),
      sceneQueue,
      scenePhase: null,
      sceneCancelled: false,
      sceneSlot: String(config.selectedSlot || "slot3"),
      sceneModelFilters: normalizeStringArray(config.modelFilters),
      logPath: runnerLogPath,
      adopted: false,
    };
    benchmarkFileCache.clear();
    await persistSession(benchmarkSession);

    child.on("exit", (code) => {
      if (!benchmarkSession || benchmarkSession.pid !== child.pid) {
        return;
      }
      finishSession(benchmarkSession, code).catch(() => {});
    });
    child.on("error", (error) => {
      appendSessionLog("[spawn-error] ", Buffer.from(String(error.message || error)));
      if (benchmarkSession && benchmarkSession.pid === child.pid) {
        finishSession(benchmarkSession, 1).catch(() => {});
      }
    });

    await sleep(START_STABILITY_WAIT_MS);

    if (!benchmarkSession || benchmarkSession.pid !== child.pid) {
      reject(Object.assign(new Error("Benchmark session was replaced before startup completed."), { statusCode: 500 }));
      return;
    }
    if (!isPidAlive(child.pid) || benchmarkSession.endedAt) {
      const recentLog = await sessionRecentLog(benchmarkSession);
      const message = recentLog
        ? `Benchmark exited during startup.\n${recentLog}`
        : "Benchmark exited during startup without producing logs.";
      reject(Object.assign(new Error(message), { statusCode: 500 }));
      return;
    }

    resolve({
      pid: child.pid,
      startedAt: benchmarkSession.startedAt,
      command: benchmarkSession.command,
      selectedModels: benchmarkSession.selectedModels,
    });
  });
}

async function cancelBenchmark() {
  const status = await getBenchmarkStatus();
  // A run that has moved on to its scenes has no runner pid left to signal; the
  // cancel button still has to stop it.
  if (status.running && status.phase === "scenes" && benchmarkSession) {
    benchmarkSession.sceneCancelled = true;
    benchmarkSession.sceneQueue = [];
    const testId = benchmarkSession.scenePhase ? benchmarkSession.scenePhase.test : null;
    if (testId) {
      voxel.cancelVoxelTest(testId);
    }
    return { pid: null, phase: "scenes", sceneTest: testId };
  }
  if (!status.running || !status.pid) {
    throw Object.assign(new Error("No benchmark is currently running."), { statusCode: 409 });
  }
  if (benchmarkSession) {
    // Cancelling the runner cancels the scenes queued behind it too.
    benchmarkSession.sceneCancelled = true;
    benchmarkSession.sceneQueue = [];
  }
  try {
    process.kill(status.pid, "SIGTERM");
  } catch (error) {
    throw Object.assign(new Error(`Failed to signal benchmark process: ${error.message || error}`), { statusCode: 500 });
  }
  return { pid: status.pid };
}

function sendNoStore(res, payload, contentType = "application/json", statusCode = 200) {
  res.status(statusCode).set("Cache-Control", "no-store").type(contentType).send(payload);
}

// A run stores its own model list, so a model deleted from the Models tab would
// otherwise keep its tile forever, restart included. Reconcile against the live
// inventory on read rather than pruning the saved state: if the model is
// downloaded again its history comes back with it.
//
// Every voxel endpoint that returns state must go through this. It used to live
// inside the status handler alone, so start/rerun/cancel replied with the raw
// saved list and the grid painted deleted models for the second or two until
// the next status poll pruned them again.
// Scene pages are model-generated, so a fair number of them throw at runtime
// (undeclared variables, bad indexes). The frames are sandboxed without
// allow-same-origin, so the parent cannot reach in to check — instead this shim
// is injected at serve time (the stored artifact on disk is never modified) and
// reports failures out via postMessage, so the tile can say what went wrong
// rather than the scene silently rendering a blank box.
const VOXEL_ERROR_SHIM = `<script>
(function () {
  if (window.parent === window) { return; }   // opened in its own tab: nobody to tell
  var sent = 0, seen = {};
  function report(kind, message, detail) {
    var text = String(message || "").slice(0, 300);
    if (!text || seen[text] || sent >= 5) { return; }   // a rAF loop can throw every frame
    seen[text] = 1; sent += 1;
    try {
      window.parent.postMessage({ __voxelScene: true, kind: kind, message: text,
                                  detail: String(detail || "").slice(0, 200) }, "*");
    } catch (_e) { /* parent went away */ }
  }
  window.addEventListener("error", function (event) {
    if (event && event.target && event.target !== window && event.target.src) {
      report("resource", "failed to load " + event.target.src);
      return;
    }
    report("error", event && event.message, event && event.filename
      ? (event.filename.split("/").pop() + ":" + event.lineno) : "");
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    report("rejection", reason && (reason.message || reason), "");
  });

  // Post one still image of the finished scene. The grid shows it in tiles that
  // are not currently mounted, so a scrolled-away scene still looks like itself
  // without a live renderer burning cycles behind it.
  function poster() {
    try {
      var best = null;
      var canvases = document.getElementsByTagName("canvas");
      for (var i = 0; i < canvases.length; i += 1) {
        var c = canvases[i];
        if (!best || c.width * c.height > best.width * best.height) { best = c; }
      }
      if (!best || best.width < 8 || best.height < 8) { return; }
      var url = best.toDataURL("image/jpeg", 0.55);
      if (!url || url.length > 400000) { return; }   // keep the message small
      window.parent.postMessage({ __voxelScene: true, kind: "poster", poster: url }, "*");
    } catch (_e) { /* tainted canvas, WebGL without preserveDrawingBuffer, etc. */ }
  }
  // Late enough for a requestAnimationFrame scene to have drawn a frame or two.
  window.addEventListener("load", function () { setTimeout(poster, 1200); });
}());
<\/script>`;

function injectVoxelErrorShim(html) {
  const text = String(html);
  // Before the scene's own scripts, so a throw during parsing is caught too.
  const headMatch = text.match(/<head[^>]*>/i);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return text.slice(0, at) + VOXEL_ERROR_SHIM + text.slice(at);
  }
  const htmlMatch = text.match(/<html[^>]*>/i);
  if (htmlMatch) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return text.slice(0, at) + VOXEL_ERROR_SHIM + text.slice(at);
  }
  return VOXEL_ERROR_SHIM + text;
}

async function reconcileVoxelStateWithInventory(state, slot) {
  if (!state || !Array.isArray(state.models)) {
    return state;
  }
  try {
    const inventory = await discoverInventory({ selectedSlot: String(slot || "") });
    const known = new Set(
      inventory
        .map((item) => String(item.label || item.modelLabel || item.key || item.modelKey || "").trim())
        .filter(Boolean),
    );
    if (!known.size) {
      return state;
    }
    const kept = state.models.filter((m) => known.has(m.model));
    state.hiddenDeleted = state.models.length - kept.length;
    // Symmetric with hiding deleted models: a model downloaded after this run
    // was created should show up as a queued tile, so it can be generated on
    // its own with the re-run button instead of forcing a whole new sweep.
    const present = new Set(kept.map((m) => m.model));
    const added = [...known]
      .filter((label) => !present.has(label))
      .map((label) => ({
        model: label,
        modelKey: "",
        status: "pending",
        startedAt: null,
        endedAt: null,
        elapsedMs: 0,
        file: "",
        rawFile: "",
        bytes: 0,
        finishReason: "",
        completionTokens: 0,
        recovered: false,
        error: "",
        isNew: true,
      }));
    state.addedNew = added.length;
    // Order by the inventory, NOT by "was this in the saved run": the displayed
    // set is exactly the inventory (kept is a subset of it, added is the rest),
    // so inventory order covers every tile and never depends on run state.
    // Ordering as kept-then-added made a tile physically jump the moment it was
    // re-run — re-running moves a model out of the "added" block and onto the
    // end of "kept", so its tile leapt up the grid mid-click.
    const inventoryOrder = new Map([...known].map((label, index) => [label, index]));
    state.models = kept
      .concat(added)
      .sort((left, right) => (inventoryOrder.get(left.model) ?? Number.MAX_SAFE_INTEGER)
        - (inventoryOrder.get(right.model) ?? Number.MAX_SAFE_INTEGER));
  } catch (_error) {
    // Discovery failed - show everything rather than blanking the grid.
  }
  return state;
}

function attachPerfDashboardRoutes(app) {
  app.get("/api/perf-dashboard/summary", async (_req, res) => {
    try {
      const generated = await buildSummaryMarkdown();
      await fs.writeFile(summaryPath, generated, "utf8").catch(() => {});
      sendNoStore(res, generated, "text/markdown");
    } catch (error) {
      try {
        const generated = await buildSummaryMarkdown();
        await fs.writeFile(summaryPath, generated, "utf8").catch(() => {});
        sendNoStore(res, generated, "text/markdown");
      } catch (fallbackError) {
        console.error(`[perf-dashboard summary] primary read failed: ${error.message}`);
        console.error(`[perf-dashboard summary] fallback generation failed: ${fallbackError.message || fallbackError}`);
        res.status(500).json({ error: fallbackError.message || "Failed to build summary." });
      }
    }
  });

  // The Hebrew translation column stores two long texts per model+variant, so
  // they are served here rather than squeezed into the summary markdown table.
  app.get("/api/perf-dashboard/translations", async (_req, res) => {
    try {
      const payloads = await readBenchmarks();
      const entries = [];
      for (const payload of payloads) {
        const artifact = metric(payload, "benchmarks", "quality", "translationArtifact");
        if (!artifact || typeof artifact !== "object" || !String(artifact.translation || "").trim()) {
          continue;
        }
        entries.push({
          model: String(payload.modelLabel || payload.modelKey || "unknown"),
          runtime: String(payload.runtime || "unknown"),
          launcher: String(payload.launcher || payload.runtime || "unknown"),
          variant: String(payload.variant || ""),
          thinking: Boolean(artifact.thinking),
          chrF: asNumber(artifact.score),
          hebrewRatio: asNumber(artifact.hebrewRatio),
          translation: String(artifact.translation || ""),
        });
      }
      const referenceDir = path.join(benchmarkRoot, "translation");
      const [sourceText, referenceText] = await Promise.all([
        fs.readFile(path.join(referenceDir, "source_en.txt"), "utf8").catch(() => ""),
        fs.readFile(path.join(referenceDir, "reference_he.txt"), "utf8").catch(() => ""),
      ]);
      res.json({ source: sourceText.trim(), reference: referenceText.trim(), entries });
    } catch (error) {
      res.status(500).json({ error: error.message || "Failed to read translations." });
    }
  });

  // ---- Voxel Test -------------------------------------------------------
  // Generated pages are served statically so the grid can preview them in an
  // iframe and open them in a new tab.
  app.get("/api/perf-dashboard/voxel/tests", (_req, res) => {
    sendNoStore(res, JSON.stringify({ tests: voxel.listTests(), running: voxel.anyTestRunning() }));
  });

  app.get("/api/perf-dashboard/voxel/status", async (req, res) => {
    const state = await reconcileVoxelStateWithInventory(voxel.getVoxelState(req.query.test), req.query.slot);
    sendNoStore(res, JSON.stringify(state));
  });

  app.post("/api/perf-dashboard/voxel/start", async (req, res) => {
    try {
      const slotId = String(req.body?.slotId || "").trim();
      if (!slotId) {
        res.status(400).json({ error: "slotId is required." });
        return;
      }
      const requested = Array.isArray(req.body?.models) ? req.body.models : [];
      const inventory = await discoverInventory({ selectedSlot: slotId });
      const byLabel = new Map();
      for (const item of inventory) {
        const label = String(item.label || item.modelLabel || item.key || item.modelKey || "").trim();
        const key = String(item.key || item.modelKey || "").trim();
        if (label && key && !byLabel.has(label)) {
          byLabel.set(label, { label, modelKey: key });
        }
      }
      // Ticked models scope the run; with none ticked it runs every model in
      // the inventory. A results row can outlive the weights on disk (the
      // benchmark table is history, the inventory is what is loadable now), so
      // ticks that no longer resolve are reported rather than silently dropped.
      const trimmed = requested.map((label) => String(label || "").trim()).filter(Boolean);
      const wanted = trimmed.length
        ? trimmed.map((label) => byLabel.get(label)).filter(Boolean)
        : [...byLabel.values()];
      const skipped = trimmed.filter((label) => !byLabel.has(label));
      const publicBase = String(req.body?.publicBase || "").trim()
        || `http://127.0.0.1:${8036 + (Number(String(slotId).replace(/\D/g, "")) || 1) - 1}`;
      const thinking = typeof req.body?.thinking === "boolean" ? req.body.thinking : undefined;
      const state = await voxel.startVoxelTest({ slotId, models: wanted, publicBase, skipped, test: req.body?.test, thinking });
      res.json({ ok: true, voxel: await reconcileVoxelStateWithInventory(state, slotId) });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "Failed to start voxel test." });
    }
  });

  app.post("/api/perf-dashboard/voxel/rerun", async (req, res) => {
    try {
      const slotId = String(req.body?.slotId || "").trim();
      const label = String(req.body?.model || "").trim();
      if (!slotId || !label) {
        res.status(400).json({ error: "slotId and model are required." });
        return;
      }
      const inventory = await discoverInventory({ selectedSlot: slotId });
      const hit = inventory.find((item) => {
        const name = String(item.label || item.modelLabel || item.key || item.modelKey || "").trim();
        return name === label;
      });
      if (!hit) {
        res.status(400).json({ error: `${label} is not in the inventory any more (weights missing?).` });
        return;
      }
      const publicBase = String(req.body?.publicBase || "").trim()
        || `http://127.0.0.1:${8036 + (Number(String(slotId).replace(/\D/g, "")) || 1) - 1}`;
      const state = await voxel.rerunModel({
        slotId,
        model: label,
        modelKey: String(hit.key || hit.modelKey || ""),
        publicBase,
        test: req.body?.test,
        thinking: typeof req.body?.thinking === "boolean" ? req.body.thinking : undefined,
      });
      res.json({ ok: true, voxel: await reconcileVoxelStateWithInventory(state, slotId) });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "Failed to re-run model." });
    }
  });

  app.post("/api/perf-dashboard/voxel/cancel-model", async (req, res) => {
    try {
      const state = await voxel.cancelOneModel(req.body?.test, req.body?.model);
      res.json({ ok: true, voxel: await reconcileVoxelStateWithInventory(state, req.body?.slotId) });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "Failed to cancel model." });
    }
  });

  app.post("/api/perf-dashboard/voxel/cancel", async (req, res) => {
    const state = voxel.cancelVoxelTest(req.body?.test);
    res.json({ ok: true, voxel: await reconcileVoxelStateWithInventory(state, req.body?.slotId) });
  });

  app.get("/api/perf-dashboard/voxel/file/:name", async (req, res) => {
    const name = path.basename(String(req.params.name || ""));
    if (!name || name.startsWith(".")) {
      res.status(400).send("bad name");
      return;
    }
    const full = path.join(voxel.outputRoot, name);
    try {
      const body = await fs.readFile(full);
      res.setHeader("Content-Type", name.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(name.endsWith(".html") ? injectVoxelErrorShim(body.toString("utf8")) : body);
    } catch (_error) {
      res.status(404).send("not found");
    }
  });

  // The structured feed the results table is built from. /summary stays for the
  // SUMMARY.md artifact; nothing in the UI parses markdown any more.
  app.get("/api/perf-dashboard/results", async (req, res) => {
    try {
      const payload = await buildResultsPayload({ selectedSlot: req.query.slot || "" });
      sendNoStore(res, JSON.stringify(payload));
    } catch (error) {
      res.status(500).json({ error: error.message || "Failed to build results." });
    }
  });

  // Dry run for the launcher: the rows a launch would produce, which of them
  // already have results, and roughly how long it would take.
  app.post("/api/perf-dashboard/plan", async (req, res) => {
    try {
      const plan = await resolveLaunchPlan(normalizeLaunchConfig(req.body || {}));
      sendNoStore(res, JSON.stringify(plan));
    } catch (error) {
      res.status(400).json({ error: error.message || "Failed to resolve the launch plan." });
    }
  });

  // The preview iframes report scene runtime failures through the injected error
  // shim; this is where those reports are kept.
  app.post("/api/perf-dashboard/scene-error", async (req, res) => {
    try {
      const recorded = await voxel.noteSceneRuntimeError({
        file: req.body?.file,
        kind: req.body?.kind,
        message: req.body?.message,
        detail: req.body?.detail,
      });
      res.json({ ok: true, recorded });
    } catch (error) {
      res.status(500).json({ error: error.message || "Failed to record the scene error." });
    }
  });

  // What the model is getting wrong, while it is still working. quality_eval.py
  // appends one JSON line per scored question; this tails the active row's feed
  // so the Running tab can show the struggles live instead of only in the
  // post-mortem.
  app.get("/api/perf-dashboard/live-questions", async (req, res) => {
    try {
      const status = await getBenchmarkStatus();
      const resultDir = String(status.activeResultDir || "");
      if (!resultDir) {
        sendNoStore(res, JSON.stringify({ running: Boolean(status.running), entries: [], model: "", variant: "" }));
        return;
      }
      const limit = Math.min(400, Math.max(1, Number(req.query.limit) || 120));
      const files = (await fs.readdir(resultDir).catch(() => []))
        .filter((name) => name.endsWith(".live.jsonl"));
      const entries = [];
      for (const name of files) {
        const text = await fs.readFile(path.join(resultDir, name), "utf8").catch(() => "");
        for (const line of text.split("\n")) {
          if (!line.trim()) {
            continue;
          }
          try {
            entries.push(JSON.parse(line));
          } catch (_error) {
            // A half-written final line is normal while the file is being
            // appended to; the next poll picks it up complete.
          }
        }
      }
      entries.sort((left, right) => (right.ts || 0) - (left.ts || 0));
      sendNoStore(res, JSON.stringify({
        running: Boolean(status.running),
        model: String(status.currentModel || ""),
        stage: String(status.currentStage || ""),
        counts: {
          scored: entries.length,
          wrong: entries.filter((entry) => !entry.correct).length,
        },
        entries: entries.slice(0, limit),
      }));
    } catch (error) {
      res.status(500).json({ error: error.message || "Failed to read the live feed." });
    }
  });

  // Which model is actually serving on a slot right now. /api/overview carries
  // this too, but it is 89KB of everything else and this is polled every few
  // seconds. Asking the slot's own port is both cheaper and more truthful: it
  // reports what answers requests, not what llm3 believes it launched.
  app.get("/api/perf-dashboard/slot-model", async (req, res) => {
    const slotNumber = Number(String(req.query.slot || "").replace(/\D/g, "")) || 1;
    const port = 8036 + slotNumber - 1;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) {
        sendNoStore(res, JSON.stringify({ loaded: false, port }));
        return;
      }
      const payload = await response.json();
      const id = String(payload?.data?.[0]?.id || "").trim();
      sendNoStore(res, JSON.stringify({ loaded: Boolean(id), id, port }));
    } catch (_error) {
      sendNoStore(res, JSON.stringify({ loaded: false, port }));
    }
  });

  app.get("/api/perf-dashboard/status", async (_req, res) => {
    try {
      const status = await getBenchmarkStatus();
      sendNoStore(res, JSON.stringify(status));
    } catch (error) {
      res.status(500).json({ error: error.message || "Failed to read benchmark status." });
    }
  });

  app.get("/api/perf-dashboard/inventory", async (req, res) => {
    const config = {
      limit: req.query.limit,
      selectedSlot: req.query.slot || "",
      runtimes: Array.isArray(req.query.runtime) ? req.query.runtime : (req.query.runtime ? [req.query.runtime] : []),
      modelFilters: Array.isArray(req.query.model) ? req.query.model : (req.query.model ? [req.query.model] : []),
      excludeModelFilters: Array.isArray(req.query.exclude) ? req.query.exclude : (req.query.exclude ? [req.query.exclude] : []),
    };
    try {
      const inventory = await discoverInventory(config);
      res.json({
        count: inventory.length,
        models: inventory.map((item) => ({
          label: item.label || item.modelLabel || item.key || item.modelKey || "unknown",
          runtime: item.runtime || "unknown",
          sizeLabel: item.sizeLabel || "unknown",
        })),
      });
    } catch (error) {
      res.status(500).json({ error: error.message || "Failed to discover models." });
    }
  });

  app.post("/api/perf-dashboard/start", async (req, res) => {
    try {
      const launched = await startBenchmark(normalizeLaunchConfig(req.body || {}));
      res.json({ ok: true, benchmark: launched });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      console.error(`[perf-dashboard start] ${statusCode}: ${error.message || "Failed to start benchmark."}`);
      const recentLog = await sessionRecentLog(benchmarkSession);
      if (recentLog) {
        console.error(recentLog.split("\n").slice(-20).join("\n"));
      }
      res.status(statusCode).json({
        error: error.message || "Failed to start benchmark.",
        recentLog,
      });
    }
  });

  app.post("/api/perf-dashboard/results/clear", async (_req, res) => {
    try {
      const status = await getBenchmarkStatus();
      if (status.running) {
        res.status(409).json({ error: "Cannot clear results while a benchmark is running." });
        return;
      }
      const cleared = await clearBenchmarkArtifacts();
      res.json({ ok: true, cleared });
    } catch (error) {
      res.status(500).json({ error: error.message || "Failed to clear benchmark results." });
    }
  });

  // Clearing everything was the only way to get rid of a row -- a smoke run, a
  // model you deleted, a result you know is garbage. This removes just the
  // directories asked for. Names are taken from the rows' own resultDir, and
  // each is reduced to a basename and re-checked to be a direct child of
  // resultsRoot before anything is removed.
  app.post("/api/perf-dashboard/results/delete", async (req, res) => {
    try {
      const status = await getBenchmarkStatus();
      if (status.running) {
        res.status(409).json({ error: "Cannot delete results while a benchmark is running." });
        return;
      }
      const requested = Array.isArray(req.body && req.body.dirs) ? req.body.dirs : [];
      const names = [...new Set(requested.map((entry) => path.basename(String(entry || "").trim())))]
        .filter((name) => name && name !== "." && name !== "..");
      if (!names.length) {
        res.status(400).json({ error: "No result directories given." });
        return;
      }
      const removed = [];
      const missing = [];
      const root = path.resolve(resultsRoot);
      for (const name of names) {
        const target = path.resolve(root, name);
        if (path.dirname(target) !== root) {
          continue;
        }
        const stat = await fs.stat(target).catch(() => null);
        if (!stat || !stat.isDirectory()) {
          missing.push(name);
          continue;
        }
        await fs.rm(target, { recursive: true, force: true });
        removed.push(name);
      }
      inventoryCache.clear();
      // SUMMARY.md is generated from what is left, so regenerate it rather
      // than leaving it describing rows that no longer exist.
      const generated = await buildSummaryMarkdown();
      await fs.writeFile(summaryPath, generated, "utf8").catch(() => {});
      res.json({ ok: true, removed, missing });
    } catch (error) {
      res.status(500).json({ error: error.message || "Failed to delete benchmark results." });
    }
  });

  app.post("/api/perf-dashboard/cancel", async (_req, res) => {
    try {
      const cancelled = await cancelBenchmark();
      res.json({ ok: true, cancelled });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "Failed to cancel benchmark." });
    }
  });
}

module.exports = {
  attachPerfDashboardRoutes,
  startBenchmark,
  getBenchmarkStatus,
  cancelBenchmark,
  _test: {
    readBenchmarks,
    adoptPersistedSession,
    sessionFilePath,
    runnerLogPath,
    buildRunnerArgs,
    parseRunnerArgs,
    normalizeDiscoveredInventory,
    compareBenchmarkPayloads,
    buildSummaryMarkdown,
    qualityMetricsFromPayload,
    normalizeLaunchConfig,
    thinkingSecondsPerQuestion,
    estimateRowSeconds,
    buildResultsPayload,
    resolveLaunchPlan,
    variantBucketsForConfig,
    thinkingBucketForVariant,
    wilsonMargin,
    buildScore,
    assignScoreTiers,
    collectDataQualityNotes,
    BENCHMARK_CATALOG,
    RUNNER_QUALITY_METRICS,
    DEFAULT_QUALITY_LIMIT,
    SCENE_SIGNAL_WEIGHTS,
    analyseSceneHtml,
    scoreSceneEntry,
  },
};
