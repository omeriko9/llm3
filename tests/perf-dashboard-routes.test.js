const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../src/perf-dashboard-routes.js");

test("normalizeDiscoveredInventory accepts legacy and wrapped discovery payloads", () => {
  const arrayPayload = [{ label: "Model A" }];
  const wrappedPayload = { models: [{ label: "Model B" }] };
  const resultPayload = { results: [{ label: "Model C" }] };

  assert.deepEqual(_test.normalizeDiscoveredInventory(arrayPayload), arrayPayload);
  assert.deepEqual(_test.normalizeDiscoveredInventory(wrappedPayload), wrappedPayload.models);
  assert.deepEqual(_test.normalizeDiscoveredInventory(resultPayload), resultPayload.results);
  assert.throws(() => _test.normalizeDiscoveredInventory({}), /Invalid discovery payload shape/);
});

test("buildRunnerArgs and parseRunnerArgs preserve selected slot and benchmark flags", () => {
  const args = _test.buildRunnerArgs({
    contextSize: 16384,
    parallel: 2,
    loadTimeout: 400,
    globalTimeout: 500,
    throughputWindow: 45,
    throughputStallTimeout: 12,
    slotCount: 4,
    selectedSlot: "slot3",
    runtimes: ["gguf", "mlx"],
    modelFilters: ["Qwen3.6", "Gemma4"],
    excludeModelFilters: ["DeepSeek-V4-Flash"],
    qualityLimit: 60,
    qualityMetrics: ["mmlu_pro", "gsm8k"],
    limit: 7,
    force: true,
    thinking: true,
    enableTinyGrammar: true,
  });

  assert.deepEqual(args, [
    "benchmark_runner.py",
    "--context-size", "16384",
    "--parallel", "2",
    "--load-timeout", "400",
    "--global-timeout", "500",
    "--throughput-window", "45",
    "--throughput-stall-timeout", "12",
    "--throughput-repeats", "3",
    "--throughput-warmup", "1",
    "--slot-count", "4",
    "--quality-limit", "60",
    "--quality-metric", "mmlu_pro",
    "--quality-metric", "gsm8k",
    "--slot", "slot3",
    "--runtime", "gguf",
    "--runtime", "mlx",
    "--model", "Qwen3.6",
    "--model", "Gemma4",
    "--exclude-model", "DeepSeek-V4-Flash",
    "--limit", "7",
    "--force",
    "--thinking",
    "--enable-tiny-grammar",
  ]);

  assert.deepEqual(_test.parseRunnerArgs(args.slice(1)), {
    contextSize: 16384,
    parallel: 2,
    loadTimeout: 400,
    globalTimeout: 500,
    throughputWindow: 45,
    throughputStallTimeout: 12,
    throughputRepeats: 3,
    throughputWarmup: 1,
    slotCount: 4,
    qualityLimit: 60,
    qualityMetrics: ["mmlu_pro", "gsm8k"],
    selectedSlot: "slot3",
    runtimes: ["gguf", "mlx"],
    modelFilters: ["Qwen3.6", "Gemma4"],
    excludeModelFilters: ["DeepSeek-V4-Flash"],
    limit: 7,
    force: true,
    thinking: true,
    enableTinyGrammar: true,
  });
});

test("buildRunnerArgs defaults to 128000 context and supports 2-way thinking variants", () => {
  const args = _test.buildRunnerArgs({
    simpleThinkingVariants: true,
  });

  assert.deepEqual(args, [
    "benchmark_runner.py",
    "--context-size", "128000",
    "--parallel", "1",
    "--load-timeout", "300",
    "--global-timeout", "300",
    "--throughput-window", "60",
    "--throughput-stall-timeout", "10",
    "--throughput-repeats", "3",
    "--throughput-warmup", "1",
    "--slot-count", "3",
    "--quality-limit", "200",
    "--quality-metric", "mmlu_pro",
    "--simple-thinking-variants",
  ]);

  assert.deepEqual(_test.parseRunnerArgs(args.slice(1)), {
    contextSize: 128000,
    parallel: 1,
    loadTimeout: 300,
    globalTimeout: 300,
    throughputWindow: 60,
    throughputStallTimeout: 10,
    throughputRepeats: 3,
    throughputWarmup: 1,
    slotCount: 3,
    qualityLimit: 200,
    qualityMetrics: ["mmlu_pro"],
    selectedSlot: "",
    runtimes: [],
    modelFilters: [],
    excludeModelFilters: [],
    limit: null,
    force: false,
    thinking: false,
    enableTinyGrammar: false,
    simpleThinkingVariants: true,
  });
});

test("compareBenchmarkPayloads sorts by runtime, model label, then start time", () => {
  const payloads = [
    { runtime: "mlx", modelLabel: "beta", timestamps: { started: "2026-04-30T10:00:02Z" } },
    { runtime: "gguf", modelLabel: "zeta", timestamps: { started: "2026-04-30T10:00:03Z" } },
    { runtime: "gguf", modelLabel: "alpha", timestamps: { started: "2026-04-30T10:00:04Z" } },
    { runtime: "gguf", modelLabel: "alpha", timestamps: { started: "2026-04-30T10:00:01Z" } },
  ];

  payloads.sort(_test.compareBenchmarkPayloads);

  assert.deepEqual(
    payloads.map((item) => `${item.runtime}:${item.modelLabel}:${item.timestamps.started}`),
    [
      "gguf:alpha:2026-04-30T10:00:01Z",
      "gguf:alpha:2026-04-30T10:00:04Z",
      "gguf:zeta:2026-04-30T10:00:03Z",
      "mlx:beta:2026-04-30T10:00:02Z",
    ],
  );
});

test("qualityMetricsFromPayload extracts deepeval and aggregate quality scores", () => {
  const payload = {
    benchmarks: {
      quality: {
        avgMmlu: 0.81,
        scores: {
          mmlu_pro: 0.62,
          hebrew_translation: 0.73,
          gsm8k: 0.44,
        },
        deepEval: {
          benchmark: "IFEval",
          score: 0.91,
        },
        overallAverage: 0.7025,
      },
    },
  };

  assert.deepEqual(_test.qualityMetricsFromPayload(payload), {
    avgMmlu: 0.81,
    mmluPro: 0.62,
    math500: null,
    humanEval: null,
    hebrewTranslation: 0.73,
    gsm8k: 0.44,
    deepEval: 0.91,
    overall: 0.7025,
  });
});

// ---- Launcher configuration ------------------------------------------------

test("normalizeLaunchConfig turns launcher choices into runner config", () => {
  const config = _test.normalizeLaunchConfig({
    models: ["Qwen3.8-27B-UD-Q4_K_XL", "  ", "Qwen3.8-9B-Q8_0"],
    benchmarks: ["mmlu_pro", "gsm8k", "math500", "scene:voxel", "scene:nope"],
    variants: "both",
    qualityLimit: 200,
  });

  assert.deepEqual(config.modelFilters, ["Qwen3.8-27B-UD-Q4_K_XL", "Qwen3.8-9B-Q8_0"]);
  // An unknown scene id must not reach the scene queue, and only metrics the
  // runner actually accepts may reach its command line.
  assert.deepEqual(config.qualityMetrics, ["mmlu_pro", "gsm8k", "math500"]);
  assert.deepEqual(config.sceneTests, ["voxel"]);
  assert.equal(config.simpleThinkingVariants, true);
  assert.equal(config.thinking, false);
  assert.equal(config.force, false);
});

test("normalizeLaunchConfig leaves legacy filter payloads alone", () => {
  const config = _test.normalizeLaunchConfig({
    modelFilters: ["Qwen3.6"],
    qualityMetrics: ["mmlu_pro"],
    thinking: true,
    force: true,
  });

  assert.deepEqual(config.modelFilters, ["Qwen3.6"]);
  assert.deepEqual(config.qualityMetrics, ["mmlu_pro"]);
  assert.equal(config.thinking, true);
  assert.equal(config.force, true);
});

test("variantBucketsForConfig expands the three launcher modes", () => {
  assert.deepEqual(_test.variantBucketsForConfig({ simpleThinkingVariants: true }), ["no-think", "think"]);
  assert.deepEqual(_test.variantBucketsForConfig({ thinking: true }), ["think"]);
  assert.deepEqual(_test.variantBucketsForConfig({}), ["no-think"]);
  assert.deepEqual(
    _test.variantBucketsForConfig({ thinkingVariants: true }),
    ["no-think", "think", "think-tiny", "think-gbnf"],
  );
});

test("thinkingBucketForVariant folds the grammar variants into the thinking bucket", () => {
  assert.equal(_test.thinkingBucketForVariant("no-think"), "no-think");
  assert.equal(_test.thinkingBucketForVariant(""), "no-think");
  assert.equal(_test.thinkingBucketForVariant("think"), "think");
  assert.equal(_test.thinkingBucketForVariant("think-tiny"), "think");
  assert.equal(_test.thinkingBucketForVariant("think-gbnf"), "think");
});

// ---- Smartness score -------------------------------------------------------

test("wilsonMargin reports the sampling error a bare accuracy hides", () => {
  // The numbers that motivated the redesign: 60 questions cannot separate this
  // fleet, 200 can start to.
  assert.equal(Math.round(_test.wilsonMargin(0.7, 60) * 1000) / 10, 11.3);
  assert.equal(Math.round(_test.wilsonMargin(0.7, 200) * 1000) / 10, 6.3);
  assert.equal(Math.round(_test.wilsonMargin(0.7, 500) * 1000) / 10, 4);
  // A perfect score is not a certain one.
  assert.ok(_test.wilsonMargin(1, 60) > 0.02);
  assert.equal(_test.wilsonMargin(0.7, 0), null);
  assert.equal(_test.wilsonMargin(null, 60), null);
});

test("buildScore renormalizes over the metrics that ran", () => {
  const payload = {
    variant: "no-think",
    benchmarks: {
      quality: {
        limit: 200,
        scores: { mmlu_pro: 0.8, gsm8k: 0.6 },
        taskDiagnostics: {
          mmlu_pro: { scored: 200, correct: 160, truncated: 2 },
          gsm8k: { scored: 100, correct: 60 },
        },
      },
    },
  };

  const score = _test.buildScore(payload, null);
  const ran = score.components.map((component) => component.id);
  assert.deepEqual(ran, ["mmlu_pro", "gsm8k"]);
  // (0.8 * 0.30 + 0.6 * 0.025) / 0.325, as a percentage.
  assert.equal(Math.round(score.value * 10) / 10, 78.5);
  // Contributions are reported already renormalized, so they add to the score.
  const summed = score.components.reduce((total, component) => total + component.contribution, 0);
  assert.ok(Math.abs(summed - score.value) < 1e-9);
  assert.deepEqual(score.notRun.map((entry) => entry.id), ["math500", "humaneval", "deepeval", "translation", "scenes", "mmlu"]);
  assert.equal(score.totalWeight, 0.325, "0.30 for MMLU-Pro plus 0.025 for GSM8K");
  assert.deepEqual(score.components[0].notes, ["2 hit the token cap"]);
  assert.equal(score.sampleLimit, 200);
});

test("buildScore marks the rows that are reading another variant's measurement", () => {
  const score = (variant, quality) => _test.buildScore({ variant, benchmarks: { quality } }, null);

  // Measured in its own mode: no caveat, either way round.
  assert.equal(score("think", { scores: { mmlu_pro: 0.7 }, qualityBucket: "think" }).measuredOwnVariant, true);
  assert.equal(score("no-think", { scores: { mmlu_pro: 0.7 }, qualityBucket: "no-think" }).measuredOwnVariant, true);
  // A thinking row showing a no-think measurement is the case the * flags.
  const copied = score("think", { scores: { mmlu_pro: 0.7 }, qualityBucket: "no-think" });
  assert.equal(copied.measuredOwnVariant, false);
  assert.equal(copied.measuredBucket, "no-think");
  // The grammar variants belong to the thinking bucket.
  assert.equal(score("think-tiny", { scores: { mmlu_pro: 0.7 }, qualityBucket: "think" }).measuredOwnVariant, true);
  // Rows written before quality was per-variant carry no bucket at all.
  assert.equal(score("think", { scores: { mmlu_pro: 0.7 } }).measuredOwnVariant, false);
  assert.equal(score("no-think", { scores: { mmlu_pro: 0.7 } }).measuredOwnVariant, true);
});

test("buildScore returns null when nothing was measured", () => {
  assert.equal(_test.buildScore({ benchmarks: { quality: { scores: {} } } }, null), null);
  assert.equal(_test.buildScore({}, null), null);
});

test("assignScoreTiers groups rows whose intervals still reach the tier leader", () => {
  const rows = [
    { score: { value: 80, margin: 5 } },
    { score: { value: 77, margin: 5 } },
    { score: { value: 60, margin: 4 } },
    { score: { value: 30, margin: 2 } },
    { score: null },
  ];

  _test.assignScoreTiers(rows);
  assert.equal(rows[0].score.tier, "A");
  assert.equal(rows[1].score.tier, "A", "77+5 still reaches 80-5, so it could be the best");
  assert.equal(rows[2].score.tier, "B");
  assert.equal(rows[3].score.tier, "C");
  assert.equal(rows[4].score, null);
});

test("collectDataQualityNotes says when a thinking row was never measured thinking", () => {
  const notes = _test.collectDataQualityNotes(
    [
      {
        modelLabel: "alpha",
        variant: "think",
        benchmarks: { quality: { sharedAcrossVariants: true, taskDiagnostics: {} } },
      },
      {
        modelLabel: "beta",
        variant: "no-think",
        benchmarks: { quality: { taskDiagnostics: { mmlu_pro: { scored: 40, requested: 200 } } } },
      },
    ],
    null,
  );

  assert.deepEqual(notes[0], {
    model: "alpha",
    variant: "think",
    notes: ["quality was measured with thinking off and copied onto this row"],
  });
  assert.deepEqual(notes[1].notes, ["mmlu_pro: scored 40 of 200 questions"]);
});

// ---- Run cost estimate -----------------------------------------------------

test("the run estimate uses each metric's own cost, not one blended figure", () => {
  const catalog = new Map(_test.BENCHMARK_CATALOG.map((entry) => [entry.runner, entry]));
  // MATH-500 was measured at ~9s a question against ~1.2s for MMLU-Pro; an
  // estimate that averages them is wrong by an order of magnitude on the runs
  // that matter.
  assert.ok(catalog.get("math500").secondsPerQuestion > catalog.get("mmlu_pro").secondsPerQuestion * 4);
  assert.equal(catalog.get("mmlu").taskCount, 3, "MMLU runs three subsets at the full limit");
  assert.equal(catalog.get("translation").secondsPerQuestion, 0, "one fixed passage, not a sample");
});

test("the catalogue and the runner agree on which metrics can actually run", () => {
  for (const entry of _test.BENCHMARK_CATALOG) {
    if (!entry.runner) {
      continue;
    }
    assert.ok(
      _test.RUNNER_QUALITY_METRICS.includes(entry.runner),
      `${entry.id} is scored but the runner cannot measure it`,
    );
  }
  // Scenes are scored by the dashboard, never by benchmark_runner.py.
  const scenes = _test.BENCHMARK_CATALOG.find((entry) => entry.id === "scenes");
  assert.equal(scenes.runner, null);
});

test("the weight table sums to 1 so renormalization has a meaningful denominator", () => {
  const total = _test.BENCHMARK_CATALOG.reduce((sum, entry) => sum + entry.weight, 0);
  assert.equal(Math.round(total * 100) / 100, 1);
});

// ---- Scene score -----------------------------------------------------------

test("scene signal weights sum to 1 and name what they measure", () => {
  const total = Object.values(_test.SCENE_SIGNAL_WEIGHTS).reduce((sum, value) => sum + value, 0);
  assert.equal(Math.round(total * 100) / 100, 1);
  assert.deepEqual(
    Object.keys(_test.SCENE_SIGNAL_WEIGHTS),
    ["produced", "parses", "renders", "offline", "substance"],
  );
});

test("analyseSceneHtml separates a finished page from a fragment", () => {
  const complete = _test.analyseSceneHtml(
    "<html><head><style>a{color:#ff0000}</style></head><body><canvas></canvas><div>x</div></body></html>",
  );
  assert.equal(complete.parses, true);
  assert.equal(complete.externalScript, false);
  assert.ok(complete.colours >= 1);

  const fragment = _test.analyseSceneHtml("<div>half a scene");
  assert.equal(fragment.parses, false);

  const cdn = _test.analyseSceneHtml('<html><body><script src="https://cdn.example/three.js"></script></body></html>');
  assert.equal(cdn.externalScript, true, "a scene that needs the network cannot render offline here");
});

test("a scenes-only row has no smartness score to show", () => {
  // A row being re-benchmarked has its quality cleared while the run is in
  // flight. Renormalizing the surviving scene score over its own 0.025 put a
  // half-finished row at the top of the table as "90".
  const sceneOnly = _test.buildScore(
    { variant: "no-think", benchmarks: { quality: {} } },
    { value: 0.9, n: 1, notes: [] },
  );
  assert.equal(sceneOnly, null);

  const withQuality = _test.buildScore(
    { variant: "no-think", benchmarks: { quality: { scores: { mmlu_pro: 0.5 } } } },
    { value: 0.9, n: 1, notes: [] },
  );
  assert.ok(withQuality.value > 0);
  assert.deepEqual(withQuality.components.map((component) => component.id), ["mmlu_pro", "scenes"]);
});

test("a single-variant launch is pinned by name, not left unlabelled", () => {
  // "--thinking" alone runs the runner's legacy unlabelled path: variant "", a
  // result directory with no suffix, and a "-" row that joins no thinking
  // bucket. Naming the variant keeps single-mode runs addressable.
  const think = _test.buildRunnerArgs(_test.normalizeLaunchConfig({ models: ["m"], variants: "think" }));
  assert.ok(think.includes("--variant") && think[think.indexOf("--variant") + 1] === "think");
  assert.ok(!think.includes("--thinking"));

  const noThink = _test.buildRunnerArgs(_test.normalizeLaunchConfig({ models: ["m"], variants: "no-think" }));
  assert.ok(noThink.includes("--variant") && noThink[noThink.indexOf("--variant") + 1] === "no-think");

  // Comparing both still uses the pair expansion.
  const both = _test.buildRunnerArgs(_test.normalizeLaunchConfig({ models: ["m"], variants: "both" }));
  assert.ok(both.includes("--simple-thinking-variants"));
  assert.ok(!both.includes("--variant"));

  // Round-trips, so a running process's args still describe the run.
  assert.equal(_test.parseRunnerArgs(think).variant, "think");
});

test("a metric that mostly failed to run is excluded from the score, not averaged in", () => {
  const build = (diagnostic) => _test.buildScore(
    {
      variant: "think",
      benchmarks: {
        quality: {
          scores: { mmlu_pro: 0.4, math500: 1 },
          taskDiagnostics: { mmlu_pro: { requested: 30, scored: 30, correct: 12 }, math500: diagnostic },
        },
      },
    },
    null,
  );

  // 29 of 30 maths questions timed out and the survivor was right: a perfect
  // 1.00 that would otherwise carry a quarter of the weight.
  const collapsed = build({ requested: 30, scored: 1, correct: 1, noResponse: 29 });
  assert.deepEqual(collapsed.components.map((component) => component.id), ["mmlu_pro"]);
  assert.equal(collapsed.unreliable, true);
  assert.equal(collapsed.notRun.find((entry) => entry.id === "math500").excluded, true);
  assert.equal(Math.round(collapsed.value), 40, "the score is what MMLU-Pro alone measured");

  // Most replies cut off at the token cap is the same problem, differently shaped.
  assert.equal(build({ requested: 30, scored: 30, correct: 12, truncated: 20 }).unreliable, true);

  // A full, healthy sample counts normally.
  const healthy = build({ requested: 30, scored: 30, correct: 30 });
  assert.deepEqual(healthy.components.map((component) => component.id), ["mmlu_pro", "math500"]);
  assert.equal(healthy.unreliable, false);

  // Losing a few is not losing the measurement.
  assert.equal(build({ requested: 30, scored: 27, correct: 20, truncated: 3 }).unreliable, false);
});

test("a thinking question is costed from the model's decode rate, not a multiplier", () => {
  // A flat multiplier quoted ~18s for a dense 27B that measurably takes ~140s,
  // advertising a five-hour run as forty minutes.
  const dense = _test.thinkingSecondsPerQuestion(28.5);
  const fast = _test.thinkingSecondsPerQuestion(93.4);
  assert.ok(dense > 100 && dense < 200, `dense 27B should be minutes per question, got ${dense}`);
  assert.ok(fast < dense / 2, "a model that decodes three times faster costs proportionally less");
  // Never quote more than the ceiling the runner actually enforces.
  assert.equal(_test.thinkingSecondsPerQuestion(1), 300);
  // No recorded rate still yields something sane rather than NaN.
  assert.ok(_test.thinkingSecondsPerQuestion(null) > 0);
});

test("a smoke-test sample is not allowed to top the leaderboard", () => {
  const score = (scored, correct) => _test.buildScore(
    {
      variant: "no-think",
      benchmarks: {
        quality: {
          scores: { mmlu_pro: correct / scored },
          taskDiagnostics: { mmlu_pro: { requested: scored, scored, correct } },
        },
      },
    },
    null,
  );

  // One question answered correctly is 100%, and it used to sort above models
  // measured over hundreds.
  assert.equal(score(1, 1), null, "a single question yields no score at all");
  assert.equal(score(9, 9), null, "nine is still too few");
  const real = score(60, 44);
  assert.ok(real && Math.round(real.value) === 73, "a real sample still scores");
  assert.equal(real.unreliable, false);
});

test("readBenchmarks stamps each payload with the directory it was actually read from", async () => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const nodePath = require("node:path");

  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "llm3-bench-"));
  const resultsDir = nodePath.join(root, "results");
  const write = async (dirName, payload) => {
    await fs.mkdir(nodePath.join(resultsDir, dirName), { recursive: true });
    await fs.writeFile(nodePath.join(resultsDir, dirName, "benchmark.json"), JSON.stringify(payload), "utf8");
  };

  // The second directory is a copy of the first: its benchmark.json still
  // claims to live at the original path. Trusting that self-reported field is
  // what let a delete aimed at one row remove a different row's results.
  await write("Model-A__gguf__no-think", {
    modelLabel: "Model-A",
    variant: "no-think",
    resultDir: "/somewhere/else/Model-A__gguf__no-think",
  });
  await write("Model-B__gguf__think", {
    modelLabel: "Model-B",
    variant: "think",
    resultDir: "/somewhere/else/Model-A__gguf__no-think",
  });

  const previousRoot = process.env.LLM3_BENCHMARK_ROOT;
  process.env.LLM3_BENCHMARK_ROOT = root;
  const modulePath = require.resolve("../src/perf-dashboard-routes.js");
  const cached = require.cache[modulePath];
  delete require.cache[modulePath];
  try {
    const fresh = require("../src/perf-dashboard-routes.js");
    const payloads = await fresh._test.readBenchmarks();
    const byLabel = new Map(payloads.map((entry) => [entry.modelLabel, entry.resultDirName]));
    assert.equal(byLabel.get("Model-A"), "Model-A__gguf__no-think");
    assert.equal(byLabel.get("Model-B"), "Model-B__gguf__think");
  } finally {
    delete require.cache[modulePath];
    if (cached) {
      require.cache[modulePath] = cached;
    }
    if (previousRoot === undefined) {
      delete process.env.LLM3_BENCHMARK_ROOT;
    } else {
      process.env.LLM3_BENCHMARK_ROOT = previousRoot;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the dashboard and the runner agree on the default quality sample size", () => {
  // buildRunnerArgs used to fall back to 60 while benchmark_runner.py, the run
  // estimator, and the launcher UI all assumed 200, so a launch that did not
  // name a limit quietly ran a quarter of the questions the estimate covered.
  const fs = require("node:fs");
  const path = require("node:path");
  const runner = fs.readFileSync(path.join(__dirname, "..", "benchmarks", "benchmark_runner.py"), "utf8");
  const match = /^DEFAULT_QUALITY_LIMIT = (\d+)$/m.exec(runner);
  assert.ok(match, "benchmark_runner.py no longer defines DEFAULT_QUALITY_LIMIT");
  assert.equal(_test.DEFAULT_QUALITY_LIMIT, Number(match[1]));

  const args = _test.buildRunnerArgs({});
  const index = args.indexOf("--quality-limit");
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], String(_test.DEFAULT_QUALITY_LIMIT));
});

test("throughput warm-up count survives the args round trip, including zero", () => {
  const withWarmup = _test.buildRunnerArgs({ throughputWarmup: 2 });
  assert.equal(withWarmup[withWarmup.indexOf("--throughput-warmup") + 1], "2");
  assert.equal(_test.parseRunnerArgs(withWarmup.slice(1)).throughputWarmup, 2);

  // 0 means "no warm-up" and must not fall back to the default.
  const none = _test.buildRunnerArgs({ throughputWarmup: 0 });
  assert.equal(none[none.indexOf("--throughput-warmup") + 1], "0");
  assert.equal(_test.parseRunnerArgs(none.slice(1)).throughputWarmup, 0);

  const fallback = _test.buildRunnerArgs({});
  assert.equal(fallback[fallback.indexOf("--throughput-warmup") + 1], "1");
});
