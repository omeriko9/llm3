const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const yaml = require("js-yaml");

const SERVER_MODULE_PATH = require.resolve("../src/server.js");
const execFileAsync = promisify(execFile);

async function loadServerWithConfig(configPath) {
  process.env.HERMES_M4_CONFIG_PATH = configPath;
  delete require.cache[SERVER_MODULE_PATH];
  return require(SERVER_MODULE_PATH);
}

async function loadServerWithEnv(env = {}) {
  // The launcher lists these tests assert include mlx-dspark, which the server
  // only offers when its venv is installed. Pin it so the answer is the same
  // on every machine, CI included.
  Object.assign(process.env, { LLM3_MTPLX_INSPECT: "false", LLM3_MLX_DSPARK_INSTALLED: "1" }, env);
  delete require.cache[SERVER_MODULE_PATH];
  return require(SERVER_MODULE_PATH);
}

async function createFakeMlxModelDir(rootDir, name, options = {}) {
  const modelDir = path.join(rootDir, name);
  await fs.mkdir(modelDir, { recursive: true });
  await fs.writeFile(path.join(modelDir, "model-00001-of-00001.safetensors"), "stub", "utf8");
  await fs.writeFile(
    path.join(modelDir, "config.json"),
    JSON.stringify({
      architectures: ["Qwen3_5ForConditionalGeneration"],
      text_config: {
        mtp_num_hidden_layers: options.mtpLayers ?? 1,
        max_position_embeddings: options.maxPositionEmbeddings ?? 262144,
      },
      ...(options.extraConfig || {}),
    }, null, 2),
    "utf8",
  );
  if (options.embeddedWeights) {
    await fs.writeFile(
      path.join(modelDir, "model.safetensors.index.json"),
      JSON.stringify({
        weight_map: {
          "language_model.mtp.fc.weight": "model-00001-of-00001.safetensors",
        },
      }, null, 2),
      "utf8",
    );
  }
  if (options.runtimeContract) {
    await fs.writeFile(path.join(modelDir, "mtplx_runtime.json"), JSON.stringify({ arch_id: "qwen3-next-mtp" }, null, 2), "utf8");
  }
  if (options.sidecarWeights) {
    await fs.writeFile(path.join(modelDir, "mtp.safetensors"), "stub", "utf8");
  }
  return modelDir;
}

test("syncHermesM4AfterLaunch updates model, default, vision, compression, and cache context_length", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hermesm4-"));
  const configPath = path.join(tempDir, "config.yaml");
  const cachePath = path.join(tempDir, "context_length_cache.yaml");
  const initialConfig = {
    model: {
      provider: "custom",
      base_url: "http://old-host:8036/v1",
      model: "old-model",
      context_length: 524288,
    },
  };

  await fs.writeFile(configPath, yaml.dump(initialConfig, { noRefs: true, indent: 2 }), "utf8");

  t.after(async () => {
    delete process.env.HERMES_M4_CONFIG_PATH;
    delete process.env.HERMES_M4_CACHE_PATH;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  process.env.HERMES_M4_CACHE_PATH = cachePath;
  const { syncHermesM4AfterLaunch } = await loadServerWithConfig(configPath);
  const result = await syncHermesM4AfterLaunch({
    modelId: "Qwen3.6-35B-A3B-MXFP4_MOE",
    runtimeBaseUrl: "http://127.0.0.1:8036/v1",
    visionModelId: "Qwen3.6-Vision",
    visionRuntimeBaseUrl: "http://127.0.0.1:8037/v1",
    contextLength: 1048576,
  });

  assert.equal(result.ok, true);
  assert.equal(result.config_changed, true);
  assert.equal(result.context_length, 1048576);

  const updatedConfig = yaml.load(await fs.readFile(configPath, "utf8"));
  assert.equal(updatedConfig.model.base_url, "http://127.0.0.1:8036/v1");
  assert.equal(updatedConfig.model.model, "Qwen3.6-35B-A3B-MXFP4_MOE");
   assert.equal(updatedConfig.model.default, "Qwen3.6-35B-A3B-MXFP4_MOE");
  assert.equal(updatedConfig.model.context_length, 1048576);
   assert.equal(updatedConfig.auxiliary.vision.provider, "custom");
   assert.equal(updatedConfig.auxiliary.vision.api_key, "api");
   assert.equal(updatedConfig.auxiliary.vision.model, "Qwen3.6-Vision");
   assert.equal(updatedConfig.auxiliary.vision.base_url, "http://127.0.0.1:8037/v1");
  assert.equal(updatedConfig.auxiliary.compression.context_length, 1048576);

  const updatedCache = yaml.load(await fs.readFile(cachePath, "utf8"));
  assert.equal(
    updatedCache.context_lengths["Qwen3.6-35B-A3B-MXFP4_MOE@http://127.0.0.1:8036/v1"],
    1048576,
  );
});

test("syncHermesM4AfterLaunch skips restart when config and cache are unchanged", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hermesm4-noop-"));
  const configPath = path.join(tempDir, "config.yaml");
  const cachePath = path.join(tempDir, "context_length_cache.yaml");
  const initialConfig = {
    model: {
      provider: "custom",
      api_key: "api",
      base_url: "http://127.0.0.1:8036/v1",
      model: "Qwen3.6-35B-A3B-MXFP4_MOE",
      default: "Qwen3.6-35B-A3B-MXFP4_MOE",
      context_length: 524288,
    },
    auxiliary: {
      vision: {
        provider: "custom",
        api_key: "api",
        model: "Qwen3.6-Vision",
        base_url: "http://127.0.0.1:8037/v1",
      },
      compression: {
        provider: "custom",
        api_key: "api",
        model: "Qwen3.6-35B-A3B-MXFP4_MOE",
        base_url: "http://127.0.0.1:8036/v1",
        context_length: 524288,
      },
      session_search: {
        provider: "custom",
        api_key: "api",
        model: "Qwen3.6-35B-A3B-MXFP4_MOE",
        base_url: "http://127.0.0.1:8036/v1",
        context_length: 524288,
      },
    },
  };
  const initialCache = {
    context_lengths: {
      "Qwen3.6-35B-A3B-MXFP4_MOE@http://127.0.0.1:8036/v1": 524288,
    },
  };

  await fs.writeFile(configPath, yaml.dump(initialConfig, { noRefs: true, indent: 2 }), "utf8");
  await fs.writeFile(cachePath, yaml.dump(initialCache, { noRefs: true, indent: 2 }), "utf8");

  t.after(async () => {
    delete process.env.HERMES_M4_CONFIG_PATH;
    delete process.env.HERMES_M4_CACHE_PATH;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  process.env.HERMES_M4_CONFIG_PATH = configPath;
  process.env.HERMES_M4_CACHE_PATH = cachePath;
  const { syncHermesM4AfterLaunch } = await loadServerWithConfig(configPath);
  const result = await syncHermesM4AfterLaunch({
    modelId: "Qwen3.6-35B-A3B-MXFP4_MOE",
    runtimeBaseUrl: "http://127.0.0.1:8036/v1",
    visionModelId: "Qwen3.6-Vision",
    visionRuntimeBaseUrl: "http://127.0.0.1:8037/v1",
    contextLength: 524288,
  });

  assert.equal(result.ok, true);
  assert.equal(result.config_changed, false);
  assert.equal(result.cache_updated, false);
  assert.equal(result.restart?.skipped, true);
  assert.equal(result.restart?.reason, "unchanged");
});

test("preferred runtime model id prefers explicit ids and derives runtime ids from model paths", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { getPreferredRuntimeModelId } = await loadServerWithEnv();

  assert.equal(
    getPreferredRuntimeModelId({
      runtime: "mlx",
      path: "/home/user/models/hf/mlx-community__Qwen3.6-35B-A3B-bf16",
      key: "/home/user/models/hf/mlx-community__Qwen3.6-35B-A3B-bf16",
    }),
    "mlx-community__Qwen3.6-35B-A3B-bf16",
  );
  assert.equal(
    getPreferredRuntimeModelId({
      runtime: "dflash",
      modelId: "Qwen3.6-27B-MXFP4-DFlash",
      key: "dflash-bundle",
    }),
    "Qwen3.6-27B-MXFP4-DFlash",
  );
  assert.equal(
    getPreferredRuntimeModelId({
      runtime: "gguf",
      path: "/home/user/models/qwen36-mxfp4/Qwen3.6-35B-A3B-MXFP4_MOE.gguf",
      key: "qwen-mxfp4",
      aliases: ["qwen36-mxfp4", "Qwen3.6-35B-A3B-MXFP4_MOE"],
    }),
    "Qwen3.6-35B-A3B-MXFP4_MOE",
  );
  assert.equal(
    getPreferredRuntimeModelId({
      runtime: "mtplx",
      path: "/home/user/models/hf/Youssofal__Qwen3.6-27B-MTPLX-Optimized-Speed",
      key: "/home/user/models/hf/Youssofal__Qwen3.6-27B-MTPLX-Optimized-Speed",
    }),
    "Youssofal__Qwen3.6-27B-MTPLX-Optimized-Speed",
  );
  assert.equal(
    getPreferredRuntimeModelId({
      runtime: "gguf",
      aliases: ["Qwen3.6-35B-A3B-BF16", "qwen36-bf16"],
      key: "qwen-bf16",
    }),
    "Qwen3.6-35B-A3B-BF16",
  );
});

test("launch sync prefers the selected runtime id when the live endpoint advertises unrelated model ids", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { chooseLaunchSyncModelId } = await loadServerWithEnv();
  const selectedModel = {
    runtime: "mlx",
    launcher: "optiq",
    path: "/home/user/models/hf/Youssofal__Gemma4-MTPLX-Optimized-Quality",
    key: "/home/user/models/hf/Youssofal__Gemma4-MTPLX-Optimized-Quality",
    aliases: ["Youssofal__Gemma4-MTPLX-Optimized-Quality", "Gemma4-MTPLX-Optimized-Quality"],
  };

  assert.equal(
    chooseLaunchSyncModelId("TeichAI/Qwen3.6-27B-Claude-Opus-Reasoning-Distill-v2", selectedModel, null),
    "Youssofal__Gemma4-MTPLX-Optimized-Quality",
  );
  assert.equal(
    chooseLaunchSyncModelId("Youssofal__Gemma4-MTPLX-Optimized-Quality", selectedModel, null),
    "Youssofal__Gemma4-MTPLX-Optimized-Quality",
  );
});

test("launcher metadata exposes grouped launchers and exact command templates", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { buildLauncherCommandTemplate, getLauncherDefinitions } = await loadServerWithEnv();
  const definitions = getLauncherDefinitions();

  assert.deepEqual(
    definitions.map((entry) => entry.key),
    ["gguf", "gguf-tq3", "beellama", "mlx", "rapid-mlx", "mtplx", "mlx-dspark", "mlx-vlm", "ds4", "optiq"],
  );
  assert.equal(definitions.find((entry) => entry.key === "gguf")?.family, "gguf");
  assert.equal(definitions.find((entry) => entry.key === "mtplx")?.accent, "mtplx");
  assert.equal(definitions.find((entry) => entry.key === "optiq")?.accent, "mlx");
  // mlx-vlm hosts the architectures mlx-lm has no module for and mlx-dspark
  // cannot generate with (qwen4_exp, mage_vl). It is an MLX-family launcher, so
  // the slot card, API-key choice and launcher matrix treat it like the rest.
  assert.equal(definitions.find((entry) => entry.key === "mlx-vlm")?.family, "mlx");
  assert.match(buildLauncherCommandTemplate("mlx-vlm"), /run-mlx-vlm-api\.sh --slot <slot-id> --model <model-path>/);
  assert.match(buildLauncherCommandTemplate("gguf"), /qwen_llama .*<model-path> --ctx-size <ctx-size>/);
  assert.match(buildLauncherCommandTemplate("rapid-mlx"), /run-qwen36-rapid-mlx-api\.sh --slot <slot-id> --model <model-path>/);
  assert.match(buildLauncherCommandTemplate("mtplx"), /--port <public-port>/);
  assert.match(buildLauncherCommandTemplate("optiq"), /run-optiq-api\.sh --slot <slot-id> --model <model-path>/);
  // ds4 is a GGUF-family launcher (it loads a pack GGUF), but it is NOT
  // llama.cpp: its template must never show --ctx-size, a bare model path or
  // --thinking, and it must show the MTP controls it really takes.
  assert.equal(definitions.find((entry) => entry.key === "ds4")?.family, "gguf");
  assert.match(buildLauncherCommandTemplate("ds4"), /run-ds4-api\.sh --slot <slot-id> --model <model-path>/);
  assert.match(buildLauncherCommandTemplate("ds4"), /--mtp on\|off --mtp-draft <n>/);
});

// ubatch is user-settable because a large micro-batch is a long non-preemptible Metal
// command buffer: while one slot runs a prompt eval at ubatch 512, another model on the
// same GPU stalls (measured 10.5 -> 3.7 tok/s). Blank must stay blank so the launcher
// keeps its own 512 default and nobody's existing setup changes.
test("parseLauncherRequestBody carries ubatchSize and leaves it null when unset", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });
  const { parseLauncherRequestBody } = await loadServerWithEnv();
  assert.equal(parseLauncherRequestBody({ ubatchSize: 128 }).ubatchSize, 128);
  assert.equal(parseLauncherRequestBody({ ubatchSize: "256" }).ubatchSize, 256);
  assert.equal(parseLauncherRequestBody({}).ubatchSize, null);
  assert.equal(parseLauncherRequestBody({ ubatchSize: "" }).ubatchSize, null);
  assert.equal(parseLauncherRequestBody({ ubatchSize: "abc" }).ubatchSize, null);
});

const GEMMA4_LAUNCH_MODEL = {
  key: "/tmp/gemma-4-31B-it-UD-Q6_K_XL.gguf",
  label: "Gemma 4 31B it UD Q6 K XL",
  family: "Gemma 4",
  runtime: "gguf",
  launcher: "gguf",
  supportsThinking: true,
};

test("normalizeLaunchParamsForModel caps Gemma 4 context per request, not divided by parallel", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
    delete process.env.QWEN_LLAMA_GEMMA4_MAX_CONTEXT;
  });

  // Pinned: the machine's .env may raise the cap, and this test is about the default.
  process.env.QWEN_LLAMA_GEMMA4_MAX_CONTEXT = "262144";
  // ctxSize is per parallel slot everywhere in llm3. The Gemma cap used to be
  // divided by the parallel count, so 512K at parallel 2 became 131K while the
  // same request on a Qwen slot kept its 512K.
  const { normalizeLaunchParamsForModel } = await loadServerWithEnv();
  const params = normalizeLaunchParamsForModel(GEMMA4_LAUNCH_MODEL, {
    ctxSize: 524288,
    parallel: 2,
    thinking: true,
  });

  assert.equal(params.ctxSize, 262144);
  assert.equal(params.parallel, 2);
  assert.equal(params.thinking, true);
});

test("QWEN_LLAMA_GEMMA4_MAX_CONTEXT raises the Gemma 4 cap", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
    delete process.env.QWEN_LLAMA_GEMMA4_MAX_CONTEXT;
  });

  process.env.QWEN_LLAMA_GEMMA4_MAX_CONTEXT = "1048576";
  const { normalizeLaunchParamsForModel } = await loadServerWithEnv();
  const params = normalizeLaunchParamsForModel(GEMMA4_LAUNCH_MODEL, { ctxSize: 524288, parallel: 2 });
  assert.equal(params.ctxSize, 524288);
});

test("voice benchmark helpers reject unsupported Hebrew Kokoro runs and pick matching voices", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const {
    detectVoiceBenchmarkTextLanguage,
    getVoiceBenchmarkDefaultVoiceName,
    getVoiceBenchmarkModelTuning,
    getVoiceBenchmarkVoiceName,
    voiceBenchmarkRuntimeMatchesTarget,
    voiceModelSupportsTextLanguage,
  } = await loadServerWithEnv();

  assert.equal(detectVoiceBenchmarkTextLanguage("שלום עולם"), "he");
  assert.equal(detectVoiceBenchmarkTextLanguage("こんにちは"), "ja");
  assert.equal(detectVoiceBenchmarkTextLanguage("plain latin text"), "");

  const kokoroModel = {
    runtime: "kokoro",
    languages: ["en-us", "en-gb", "es", "fr-fr", "hi", "it", "pt-br", "ja", "zh"],
    voices: ["af_alloy", "bf_emma", "jf_alpha", "zf_xiaobei"],
  };

  assert.equal(voiceModelSupportsTextLanguage(kokoroModel, "he"), false);
  assert.equal(voiceModelSupportsTextLanguage(kokoroModel, "ja"), true);
  assert.equal(getVoiceBenchmarkDefaultVoiceName(kokoroModel, "", "ja"), "jf_alpha");
  assert.equal(getVoiceBenchmarkDefaultVoiceName(kokoroModel, "af_alloy", "ja"), "jf_alpha");
  assert.equal(getVoiceBenchmarkDefaultVoiceName(kokoroModel, "jf_alpha", "ja"), "jf_alpha");
  assert.equal(getVoiceBenchmarkVoiceName({ ...kokoroModel, key: "voice-tts/kokoro" }, { "voice-tts/kokoro": "zf_xiaobei" }, "", "ja"), "jf_alpha");

  const omnivoiceModel = {
    key: "voice-tts/omnivoice",
    runtime: "omnivoice",
    voices: ["hebrew_carmit_clone", "female_warm", "male_calm"],
  };
  assert.equal(
    getVoiceBenchmarkVoiceName(omnivoiceModel, { "voice-tts/omnivoice": "female_warm" }, "hebrew_carmit_clone", "he"),
    "female_warm",
  );

  const phonikudModel = {
    key: "voice-tts/phonikud-chatterbox",
    runtime: "phonikud-chatterbox",
    voices: ["female1", "london"],
  };
  const phonikudTuning = getVoiceBenchmarkModelTuning(phonikudModel, {
    "voice-tts/phonikud-chatterbox": {
      exaggeration: 1.5,
      cfgWeight: 1,
      temperature: 2,
      repetitionPenalty: 2,
      minP: 0.5,
      topP: 0.7,
      ttsChunkSize: 500,
    },
  });
  assert.equal(
    voiceBenchmarkRuntimeMatchesTarget({
      wasRunning: true,
      modelKey: "phonikud-chatterbox",
      voiceName: "london",
      tuning: phonikudTuning,
    }, phonikudModel, "london", phonikudTuning),
    true,
  );
  // The voice rides on every /tts request, so a running server of the same
  // model with the same tuning is reused for a different voice: no relaunch,
  // no second model load between two voices of one model.
  assert.equal(
    voiceBenchmarkRuntimeMatchesTarget({
      wasRunning: true,
      modelKey: "phonikud-chatterbox",
      voiceName: "female1",
      tuning: phonikudTuning,
    }, phonikudModel, "london", phonikudTuning),
    true,
  );
  // Tuning is a launch parameter, so a tuning change still relaunches.
  const otherTuning = getVoiceBenchmarkModelTuning(phonikudModel, {
    "voice-tts/phonikud-chatterbox": { ...phonikudTuning, exaggeration: 0.5 },
  });
  assert.equal(
    voiceBenchmarkRuntimeMatchesTarget({
      wasRunning: true,
      modelKey: "phonikud-chatterbox",
      voiceName: "london",
      tuning: phonikudTuning,
    }, phonikudModel, "london", otherTuning),
    false,
  );
  assert.equal(
    voiceBenchmarkRuntimeMatchesTarget({ wasRunning: false, modelKey: "phonikud-chatterbox" }, phonikudModel, "london", phonikudTuning),
    false,
  );
});

test("voice benchmark tuning normalization keeps Chatterbox params and drops unsupported models", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { normalizeVoiceBenchmarkSelectedTunings } = await loadServerWithEnv();
  const result = normalizeVoiceBenchmarkSelectedTunings({
    "voice-tts/phonikud-chatterbox": {
      exaggeration: 5,
      cfgWeight: -1,
      temperature: 0.05,
      repetitionPenalty: 10,
      minP: -1,
      topP: 2,
      ttsChunkSize: 50,
    },
    "voice-tts/chatterbox-multilingual": {
      exaggeration: 1.25,
      ttsChunkSize: 640,
    },
    "voice-tts/phonikud-upstream": {
      exaggeration: 5,
      cfgWeight: -1,
      temperature: 0.05,
      repetitionPenalty: 10,
      minP: -1,
      topP: 2,
      ttsChunkSize: 50,
    },
    "voice-tts/kokoro": {
      exaggeration: 1.1,
    },
  });

  assert.deepEqual(result, {
    "voice-tts/phonikud-chatterbox": {
      exaggeration: 2,
      cfgWeight: 0,
      temperature: 0.1,
      repetitionPenalty: 5,
      minP: 0,
      topP: 1,
      seed: 1234,
      ttsChunkSize: 50,
    },
    "voice-tts/chatterbox-multilingual": {
      exaggeration: 1.25,
      cfgWeight: 0.5,
      temperature: 0.8,
      repetitionPenalty: 2,
      minP: 0.05,
      topP: 1,
      seed: 1234,
      ttsChunkSize: 640,
    },
    "voice-tts/phonikud-upstream": {
      exaggeration: 2,
      cfgWeight: 0,
      temperature: 0.1,
      repetitionPenalty: 5,
      minP: 0,
      topP: 1,
      seed: 1234,
      ttsChunkSize: 50,
    },
  });
});

test("detectMtplxModelSupport exposes runnable and marker-only MLX models correctly", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-mtplx-support-"));

  t.after(async () => {
    delete process.env.LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const runnableDir = await createFakeMlxModelDir(tempDir, "verified-mtplx", {
    runtimeContract: true,
    sidecarWeights: true,
  });
  const markerOnlyDir = await createFakeMlxModelDir(tempDir, "missing-mtp-weights");

  const { detectMtplxModelSupport, applyLauncherMetadata } = await loadServerWithEnv({
    LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS: "1",
  });

  const runnableSupport = await detectMtplxModelSupport(runnableDir);
  const markerOnlySupport = await detectMtplxModelSupport(markerOnlyDir);

  assert.equal(runnableSupport.recognized, true);
  assert.equal(runnableSupport.canRun, true);
  assert.equal(runnableSupport.runtimeCompatibility, "native");
  assert.equal(runnableSupport.supportLevel, "verified-native");

  assert.equal(markerOnlySupport.recognized, true);
  assert.equal(markerOnlySupport.canRun, false);
  assert.equal(markerOnlySupport.runtimeCompatibility, "missing-mtp-weights");
  assert.equal(markerOnlySupport.supportLevel, "native-backend-missing-mtp-weights");

  const runnableModel = applyLauncherMetadata({
    runtime: runnableSupport.canRun ? "mtplx" : "mlx",
    mtplxSupport: runnableSupport,
  });
  const markerOnlyModel = applyLauncherMetadata({
    runtime: markerOnlySupport.canRun ? "mtplx" : "mlx",
    mtplxSupport: markerOnlySupport,
  });

  assert.deepEqual(runnableModel.launchers, ["mlx-dspark", "mlx", "rapid-mlx", "mtplx"]);
  assert.deepEqual(markerOnlyModel.launchers, ["mlx-dspark", "mlx", "rapid-mlx"]);
});

test("detectMtplxModelSupport treats embedded MTP weights as runnable", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-mtplx-embedded-"));

  t.after(async () => {
    delete process.env.LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const embeddedDir = await createFakeMlxModelDir(tempDir, "embedded-mtp", {
    embeddedWeights: true,
  });

  const { detectMtplxModelSupport, applyLauncherMetadata } = await loadServerWithEnv({
    LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS: "1",
  });
  const support = await detectMtplxModelSupport(embeddedDir);

  assert.equal(support.recognized, true);
  assert.equal(support.canRun, true);
  assert.equal(support.runtimeCompatibility, "embedded-mtp-weights");
  assert.equal(support.supportLevel, "native-backend-embedded-mtp-weights");

  const model = applyLauncherMetadata({
    runtime: support.canRun ? "mtplx" : "mlx",
    mtplxSupport: support,
  });
  assert.deepEqual(model.launchers, ["mlx-dspark", "mlx", "rapid-mlx", "mtplx"]);
});

test("detectMtplxModelSupport prefers MTPLX inspect compatibility when available", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-mtplx-inspect-"));
  const inspectScriptPath = path.join(tempDir, "fake-mtplx");
  const embeddedDir = await createFakeMlxModelDir(tempDir, "deepseek-v4-pending", {
    embeddedWeights: true,
    extraConfig: {
      architectures: ["DeepseekV4ForCausalLM"],
      model_type: "deepseek_v4",
    },
  });

  await fs.writeFile(inspectScriptPath, `#!/bin/sh
cat <<'EOF'
{
  "architecture_recognized": true,
  "compatibility": {
    "can_run": false,
    "recognized": true,
    "runtime_compatibility": "recognized-backend-pending",
    "support_level": "recognized-backend-pending",
    "message": "DeepSeek V4 MTP markers are recognized, but the native backend is still pending."
  }
}
EOF
`, "utf8");
  await fs.chmod(inspectScriptPath, 0o755);

  t.after(async () => {
    delete process.env.MTPLX_BINARY;
    delete process.env.LLM3_MTPLX_INSPECT;
    delete process.env.LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { detectMtplxModelSupport, applyLauncherMetadata } = await loadServerWithEnv({
    LLM3_MTPLX_INSPECT: "true",
    LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS: "1",
    MTPLX_BINARY: inspectScriptPath,
  });
  const support = await detectMtplxModelSupport(embeddedDir);

  assert.equal(support.recognized, true);
  assert.equal(support.canRun, false);
  assert.equal(support.runtimeCompatibility, "recognized-backend-pending");
  assert.equal(support.supportLevel, "recognized-backend-pending");
  assert.match(support.message, /native backend is still pending/i);

  const model = applyLauncherMetadata({
    runtime: support.canRun ? "mtplx" : "mlx",
    mtplxSupport: support,
  });
  assert.deepEqual(model.launchers, ["mlx-dspark", "mlx", "rapid-mlx"]);
});

test("detectMtplxModelSupport accepts complete contracted sidecars despite repair-gate inspect result", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-mtplx-contract-"));
  const inspectScriptPath = path.join(tempDir, "fake-mtplx");
  const contractedDir = await createFakeMlxModelDir(tempDir, "contracted-extra-mtp", {
    runtimeContract: true,
    sidecarWeights: true,
  });

  await fs.writeFile(inspectScriptPath, `#!/bin/sh
cat <<'EOF'
{
  "architecture_recognized": true,
  "compatibility": {
    "can_run": false,
    "recognized": true,
    "runtime_compatibility": "needs-grafting",
    "support_level": "native-backend-needs-contract-repair",
    "message": "Runtime contract exists but local MTP artifact inspection did not pass; refusing to run without repair."
  },
  "mtp": {
    "exists": true,
    "missing_expected_keys": [],
    "passes_tensor_gate": false,
    "tensor_count": 20
  }
}
EOF
`, "utf8");
  await fs.chmod(inspectScriptPath, 0o755);

  t.after(async () => {
    delete process.env.MTPLX_BINARY;
    delete process.env.LLM3_MTPLX_INSPECT;
    delete process.env.LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { detectMtplxModelSupport, applyLauncherMetadata } = await loadServerWithEnv({
    LLM3_MTPLX_INSPECT: "true",
    LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS: "1",
    MTPLX_BINARY: inspectScriptPath,
  });
  const support = await detectMtplxModelSupport(contractedDir);

  assert.equal(support.recognized, true);
  assert.equal(support.canRun, true);
  assert.equal(support.runtimeCompatibility, "native-contracted-sidecar");
  assert.equal(support.supportLevel, "verified-native-contracted-sidecar");
  assert.deepEqual(support.mtpMissingExpectedKeys, []);

  const model = applyLauncherMetadata({
    runtime: support.canRun ? "mtplx" : "mlx",
    mtplxSupport: support,
  });
  assert.deepEqual(model.launchers, ["mlx-dspark", "mlx", "rapid-mlx", "mtplx"]);
});

test("chooseLaunchSyncModelId prefers the selected model when the live runtime id points somewhere else", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { chooseLaunchSyncModelId } = await loadServerWithEnv();

  assert.equal(
    chooseLaunchSyncModelId(
      "mlx-community__Qwen3.6-27B-4bit",
      {
        runtime: "gguf",
        path: "/home/user/models/qwen36-mxfp4/Qwen3.6-35B-A3B-MXFP4_MOE.gguf",
        key: "qwen-mxfp4",
      },
      {
        runtime: "mlx",
        path: "/home/user/models/hf/unsloth__Qwen3.6-35B-A3B-UD-MLX-4bit",
        key: "/home/user/models/hf/unsloth__Qwen3.6-35B-A3B-UD-MLX-4bit",
      },
    ),
    "Qwen3.6-35B-A3B-MXFP4_MOE",
  );
  assert.equal(
    chooseLaunchSyncModelId(
      "",
      {
        runtime: "gguf",
        path: "/home/user/models/qwen36-mxfp4/Qwen3.6-35B-A3B-MXFP4_MOE.gguf",
        key: "qwen-mxfp4",
      },
      {
        runtime: "mlx",
        path: "/home/user/models/hf/mlx-community__Qwen3.6-27B-4bit",
        key: "/home/user/models/hf/mlx-community__Qwen3.6-27B-4bit",
      },
    ),
    "Qwen3.6-35B-A3B-MXFP4_MOE",
  );
  assert.equal(
    chooseLaunchSyncModelId(
      "",
      null,
      {
        runtime: "mlx",
        path: "/home/user/models/hf/mlx-community__Qwen3.6-27B-4bit",
        key: "/home/user/models/hf/mlx-community__Qwen3.6-27B-4bit",
      },
    ),
    "mlx-community__Qwen3.6-27B-4bit",
  );
});

test("normalizeOptionalHttpUrl drops invalid env overrides", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { normalizeOptionalHttpUrl } = await loadServerWithEnv();

  assert.equal(normalizeOptionalHttpUrl("http://127.0.0.1:8037/v1", "HERMES_SYNC_BASE_URL"), "http://127.0.0.1:8037/v1");
  assert.equal(
    normalizeOptionalHttpUrl(
      "File Doesn't Exist, Will Create: /Library/LaunchDaemons/com.llm3.server.plist",
      "HERMES_SYNC_BASE_URL",
    ),
    "",
  );
});

test("buildLauncherExecEnv strips daemon-only service vars", async (t) => {
  const originalHost = process.env.HOST;
  const originalPort = process.env.PORT;
  const originalServiceMode = process.env.LLM3_SERVICE_MODE;
  const originalHermesHost = process.env.HERMES_SYNC_HOST;
  const originalXpc = process.env.XPC_SERVICE_NAME;
  const originalTerm = process.env.TERM;

  t.after(() => {
    process.env.HOST = originalHost;
    process.env.PORT = originalPort;
    process.env.LLM3_SERVICE_MODE = originalServiceMode;
    process.env.HERMES_SYNC_HOST = originalHermesHost;
    process.env.XPC_SERVICE_NAME = originalXpc;
    process.env.TERM = originalTerm;
    delete require.cache[SERVER_MODULE_PATH];
  });

  Object.assign(process.env, {
    HOST: "0.0.0.0",
    PORT: "7075",
    LLM3_SERVICE_MODE: "launchd",
    HERMES_SYNC_HOST: "192.0.2.20",
    XPC_SERVICE_NAME: "0",
    TERM: "",
  });

  const { buildLauncherExecEnv } = await loadServerWithEnv();
  const env = buildLauncherExecEnv();

  assert.equal(env.HOST, undefined);
  assert.equal(env.PORT, undefined);
  assert.equal(env.LLM3_SERVICE_MODE, undefined);
  assert.equal(env.HERMES_SYNC_HOST, undefined);
  assert.equal(env.XPC_SERVICE_NAME, undefined);
  assert.equal(env.TERM, "xterm-color");
  assert.equal(env.XDG_DATA_HOME, path.join(os.homedir(), ".local", "share"));
});

test("getFailedIntegrationSyncMessages reports only failed application syncs", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { getFailedIntegrationSyncMessages } = await loadServerWithEnv();
  const messages = getFailedIntegrationSyncMessages({
    hermes: { ok: true },
    claudecode: { ok: false, error: "launchctl service missing" },
    podcastg: { ok: true, skipped: true, reason: "podcastg target is slot2" },
    librechat: { ok: false, error: "container restart failed" },
  });

  assert.deepEqual(messages, [
    "claudecode sync failed: launchctl service missing",
    "librechat sync failed: container restart failed",
  ]);
});

test("readThinkingClearOffset drops stale marker offsets after log truncation", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-thinking-clear-"));

  t.after(async () => {
    delete process.env.LLM3_STATE_DIR;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { readThinkingClearOffset, writeThinkingClearOffset } = await loadServerWithEnv({
    LLM3_STATE_DIR: tempDir,
  });
  const logPath = path.join(tempDir, "proxy.log");
  await fs.writeFile(logPath, "1234567890abcdefghij", "utf8");

  const slot = { id: "slot1" };
  await writeThinkingClearOffset(slot, logPath, 18);
  await fs.writeFile(logPath, "tiny", "utf8");

  const clearOffset = await readThinkingClearOffset(slot, logPath);
  assert.equal(clearOffset, 0);

  const markerFiles = await fs.readdir(path.join(tempDir, "log-clears"));
  assert.deepEqual(markerFiles, []);
});

test("syncHermesAfterLaunch uses SSH key auth when available", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hermes-sync-key-"));
  const sshPath = path.join(tempDir, "ssh");
  const sshLogPath = path.join(tempDir, "ssh.log");
  const keyPath = path.join(tempDir, "nginx_server_key.pem");
  const originalPath = process.env.PATH || "";

  await fs.writeFile(keyPath, "dummy-key", "utf8");
  await fs.writeFile(
    sshPath,
    [
      "#!/bin/sh",
      "printf '__SSH_CALL__\\n' >> \"$SSH_LOG_PATH\"",
      "printf '%s\\n' \"$@\" >> \"$SSH_LOG_PATH\"",
      "printf '__HERMES_SYNC__{\"ok\":true,\"model\":\"Qwen-Test\",\"context_length\":65536,\"base_url\":\"http://192.0.2.10:8037/v1\",\"vision_model\":\"Qwen-Test\",\"vision_base_url\":\"http://192.0.2.10:8037/v1\",\"cache_updated\":true}\\n'",
      "printf '__HERMES_SERVICE__active__END__\\n'",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  t.after(async () => {
    delete process.env.HERMES_SYNC_ENABLED;
    delete process.env.HERMES_SYNC_HOST;
    delete process.env.HERMES_SYNC_USER;
    delete process.env.HERMES_SYNC_PASSWORD;
    delete process.env.HERMES_SYNC_SSH_KEY;
    delete process.env.SSH_LOG_PATH;
    process.env.PATH = originalPath;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { syncHermesAfterLaunch } = await loadServerWithEnv({
    HERMES_SYNC_ENABLED: "true",
    HERMES_SYNC_HOST: "192.0.2.20",
    HERMES_SYNC_USER: "user",
    HERMES_SYNC_PASSWORD: "",
    HERMES_SYNC_SSH_KEY: keyPath,
    SSH_LOG_PATH: sshLogPath,
    PATH: `${tempDir}:${originalPath}`,
  });

  const result = await syncHermesAfterLaunch({
    modelId: "Qwen-Test",
    visionModelId: "Qwen-Test",
    contextLength: 65536,
    runtimeBaseUrl: "http://192.0.2.10:8037/v1",
    visionRuntimeBaseUrl: "http://192.0.2.10:8037/v1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.context_length, 65536);
  assert.equal(result.base_url, "http://192.0.2.10:8037/v1");
  assert.equal(result.service_state, "active");

  const sshArgs = await fs.readFile(sshLogPath, "utf8");
  const sshCalls = sshArgs
    .split("__SSH_CALL__\n")
    .map((call) => call.trim())
    .filter(Boolean);
  const syncCall = sshCalls.find((call) => call.includes("bash -lc"));
  assert.ok(syncCall, `expected a remote sync SSH invocation in:\n${sshArgs}`);
  assert.match(syncCall, /^-tt$/m);
  assert.match(syncCall, /^-i$/m);
  assert.match(syncCall, new RegExp(`^${keyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(syncCall, /^user@192\.0\.2\.20$/m);
});

test("syncHermesM4CompactionAfterLaunch enables Hermes compaction with the selected model", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hermesm4-compaction-"));
  const configPath = path.join(tempDir, "config.yaml");
  const cachePath = path.join(tempDir, "context_length_cache.yaml");
  const initialConfig = {
    compression: {
      enabled: false,
      threshold: 0.65,
      protect_last_n: 12,
    },
    auxiliary: {
      compression: {
        provider: "main",
        model: "old-summary-model",
        context_length: 12345,
      },
    },
    context: {
      engine: "lcm",
    },
  };

  await fs.writeFile(configPath, yaml.dump(initialConfig, { noRefs: true, indent: 2 }), "utf8");

  t.after(async () => {
    delete process.env.HERMES_M4_CONFIG_PATH;
    delete process.env.HERMES_M4_CACHE_PATH;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  process.env.HERMES_M4_CONFIG_PATH = configPath;
  process.env.HERMES_M4_CACHE_PATH = cachePath;
  const { syncHermesM4CompactionAfterLaunch } = await loadServerWithConfig(configPath);
  const result = await syncHermesM4CompactionAfterLaunch({
    modelId: "Qwen3.6-Compaction",
    runtimeBaseUrl: "http://127.0.0.1:8039/v1",
    contextLength: 262144,
  });

  assert.equal(result.ok, true);
  assert.equal(result.context_length, 262144);

  const updatedConfig = yaml.load(await fs.readFile(configPath, "utf8"));
  assert.equal(updatedConfig.context.engine, "lcm");
  assert.equal(updatedConfig.compression.enabled, true);
  assert.equal(updatedConfig.compression.threshold, 0.65);
  assert.equal(updatedConfig.compression.target_ratio, 0.75);
  assert.equal(updatedConfig.compression.protect_last_n, 12);
  assert.equal(updatedConfig.auxiliary.compression.provider, "auto");
  assert.equal(updatedConfig.auxiliary.compression.api_key, "api");
  assert.equal(updatedConfig.auxiliary.compression.model, "Qwen3.6-Compaction");
  assert.equal(updatedConfig.auxiliary.compression.base_url, "http://127.0.0.1:8039/v1");
  assert.equal("context_length" in updatedConfig.auxiliary.compression, false);

  const updatedCache = yaml.load(await fs.readFile(cachePath, "utf8"));
  assert.equal(
    updatedCache.context_lengths["Qwen3.6-Compaction@http://127.0.0.1:8039/v1"],
    262144,
  );
});

test("syncHermesM4CompactionAfterStop resets Hermes compaction routing and removes cache entry", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hermesm4-compaction-stop-"));
  const configPath = path.join(tempDir, "config.yaml");
  const cachePath = path.join(tempDir, "context_length_cache.yaml");
  const initialConfig = {
    compression: {
      enabled: true,
      threshold: 0.65,
      target_ratio: 0.75,
      protect_last_n: 12,
    },
    auxiliary: {
      compression: {
        provider: "auto",
        api_key: "api",
        model: "Qwen3.6-Compaction",
        base_url: "http://127.0.0.1:8039/v1",
        timeout: 120,
      },
    },
  };
  const initialCache = {
    context_lengths: {
      "Qwen3.6-Compaction@http://127.0.0.1:8039/v1": 262144,
      "another-model@http://127.0.0.1:8040/v1": 131072,
    },
  };

  await fs.writeFile(configPath, yaml.dump(initialConfig, { noRefs: true, indent: 2 }), "utf8");
  await fs.writeFile(cachePath, yaml.dump(initialCache, { noRefs: true, indent: 2 }), "utf8");

  t.after(async () => {
    delete process.env.HERMES_M4_CONFIG_PATH;
    delete process.env.HERMES_M4_CACHE_PATH;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  process.env.HERMES_M4_CONFIG_PATH = configPath;
  process.env.HERMES_M4_CACHE_PATH = cachePath;
  const { syncHermesM4CompactionAfterStop } = await loadServerWithConfig(configPath);
  const result = await syncHermesM4CompactionAfterStop({
    runtimeBaseUrl: "http://127.0.0.1:8039/v1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.cache_updated, true);

  const updatedConfig = yaml.load(await fs.readFile(configPath, "utf8"));
  assert.equal(updatedConfig.compression.enabled, true);
  assert.equal(updatedConfig.compression.threshold, 0.65);
  assert.equal(updatedConfig.auxiliary.compression.provider, "auto");
  assert.equal(updatedConfig.auxiliary.compression.api_key, "");
  assert.equal(updatedConfig.auxiliary.compression.model, "");
  assert.equal(updatedConfig.auxiliary.compression.base_url, "");
  assert.equal(updatedConfig.auxiliary.compression.timeout, 120);

  const updatedCache = yaml.load(await fs.readFile(cachePath, "utf8"));
  assert.equal(updatedCache.context_lengths["Qwen3.6-Compaction@http://127.0.0.1:8039/v1"], undefined);
  assert.equal(updatedCache.context_lengths["another-model@http://127.0.0.1:8040/v1"], 131072);
});

test("syncHermesM4CompactionAfterStop leaves unrelated compaction routing untouched", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hermesm4-compaction-stop-noop-"));
  const configPath = path.join(tempDir, "config.yaml");
  const cachePath = path.join(tempDir, "context_length_cache.yaml");
  const initialConfig = {
    auxiliary: {
      compression: {
        provider: "auto",
        api_key: "api",
        model: "other-model",
        base_url: "http://127.0.0.1:8040/v1",
      },
    },
  };
  const initialCache = {
    context_lengths: {
      "other-model@http://127.0.0.1:8040/v1": 131072,
    },
  };

  await fs.writeFile(configPath, yaml.dump(initialConfig, { noRefs: true, indent: 2 }), "utf8");
  await fs.writeFile(cachePath, yaml.dump(initialCache, { noRefs: true, indent: 2 }), "utf8");

  t.after(async () => {
    delete process.env.HERMES_M4_CONFIG_PATH;
    delete process.env.HERMES_M4_CACHE_PATH;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  process.env.HERMES_M4_CONFIG_PATH = configPath;
  process.env.HERMES_M4_CACHE_PATH = cachePath;
  const { syncHermesM4CompactionAfterStop } = await loadServerWithConfig(configPath);
  const result = await syncHermesM4CompactionAfterStop({
    runtimeBaseUrl: "http://127.0.0.1:8039/v1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.cache_updated, false);

  const updatedConfig = yaml.load(await fs.readFile(configPath, "utf8"));
  assert.equal(updatedConfig.auxiliary.compression.model, "other-model");
  assert.equal(updatedConfig.auxiliary.compression.base_url, "http://127.0.0.1:8040/v1");

  const updatedCache = yaml.load(await fs.readFile(cachePath, "utf8"));
  assert.equal(updatedCache.context_lengths["other-model@http://127.0.0.1:8040/v1"], 131072);
});

test("syncHermesM4VoiceAfterLaunch writes TTS settings into local Hermes config", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hermesm4-voice-tts-"));
  const configPath = path.join(tempDir, "config.yaml");
  await fs.writeFile(configPath, yaml.dump({ model: { provider: "custom" } }, { noRefs: true, indent: 2 }), "utf8");

  t.after(async () => {
    delete process.env.HERMES_M4_CONFIG_PATH;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { syncHermesM4VoiceAfterLaunch } = await loadServerWithConfig(configPath);
  const result = await syncHermesM4VoiceAfterLaunch({
    type: "tts",
    modelId: "voice-tts/xtts-v2",
    voiceName: "alloy",
    runtimeBaseUrl: "http://127.0.0.1:8040",
  });

  assert.equal(result.ok, true);

  const updatedConfig = yaml.load(await fs.readFile(configPath, "utf8"));
  assert.equal(updatedConfig.tts.model, "voice-tts/xtts-v2");
  assert.equal(updatedConfig.tts.voice, "alloy");
  assert.equal(updatedConfig.tts.base_url, "http://127.0.0.1:8040");
});

test("syncHermesM4VoiceAfterLaunch writes STT settings into local Hermes config", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hermesm4-voice-stt-"));
  const configPath = path.join(tempDir, "config.yaml");
  await fs.writeFile(configPath, yaml.dump({ model: { provider: "custom" } }, { noRefs: true, indent: 2 }), "utf8");

  t.after(async () => {
    delete process.env.HERMES_M4_CONFIG_PATH;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { syncHermesM4VoiceAfterLaunch } = await loadServerWithConfig(configPath);
  const result = await syncHermesM4VoiceAfterLaunch({
    type: "stt",
    modelId: "voice-stt/faster-whisper",
    runtimeBaseUrl: "http://127.0.0.1:8042",
  });

  assert.equal(result.ok, true);

  const updatedConfig = yaml.load(await fs.readFile(configPath, "utf8"));
  assert.equal(updatedConfig.stt.model, "voice-stt/faster-whisper");
  assert.equal(updatedConfig.stt.base_url, "http://127.0.0.1:8042");
});

test("sortHfCandidates prioritizes exact provider and quantization matches", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { parseHfSearchQuery, filterHfCandidates, sortHfCandidates } = await loadServerWithEnv();
  const search = parseHfSearchQuery("unsloth/Qwen3.6-27-BF16");
  const filtered = filterHfCandidates([
    {
      id: "exact",
      provider: "unsloth",
      repoId: "unsloth/Qwen3.6-27",
      fullName: "unsloth/Qwen3.6-27/Qwen3.6-27-BF16.gguf",
      family: "Qwen 3.6",
      quantization: "BF16",
      runtime: "gguf",
      downloads: 10,
      likes: 1,
      sizeBytes: 1,
      tags: [],
    },
    {
      id: "wrong-provider",
      provider: "bartowski",
      repoId: "bartowski/Qwen3.6-27",
      fullName: "bartowski/Qwen3.6-27/Qwen3.6-27-BF16.gguf",
      family: "Qwen 3.6",
      quantization: "BF16",
      runtime: "gguf",
      downloads: 1000,
      likes: 50,
      sizeBytes: 1,
      tags: [],
    },
    {
      id: "wrong-quant",
      provider: "unsloth",
      repoId: "unsloth/Qwen3.6-27",
      fullName: "unsloth/Qwen3.6-27/Qwen3.6-27-Q4_K_M.gguf",
      family: "Qwen 3.6",
      quantization: "Q4_K_M",
      runtime: "gguf",
      downloads: 900,
      likes: 40,
      sizeBytes: 1,
      tags: [],
    },
  ], search);
  const ranked = sortHfCandidates(filtered, "downloads", "desc", search);

  assert.equal(ranked[0].id, "exact");
  assert.deepEqual(ranked.map((entry) => entry.id), ["exact"]);
});

test("buildHfCandidates includes sibling mmproj files in GGUF downloads", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { buildHfCandidates } = await loadServerWithEnv();
  const candidates = buildHfCandidates({
    id: "unsloth/gemma-4-31B-it-GGUF",
    sha: "abc123",
    tags: ["gguf"],
    siblings: [
      { rfilename: "gemma-4-31B-it-Q8_0.gguf", size: 1000 },
      { rfilename: "mmproj-F16.gguf", size: 200 },
      { rfilename: "nested/mmproj-BF16.gguf", size: 300 },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].family, "Gemma 4");
  assert.deepEqual(
    candidates[0].downloadSpec.files,
    [
      { path: "gemma-4-31B-it-Q8_0.gguf", sizeBytes: 1000 },
      { path: "mmproj-F16.gguf", sizeBytes: 200 },
      { path: "nested/mmproj-BF16.gguf", sizeBytes: 300 },
    ],
  );
});

test("buildHfCandidates attaches same-repo Gemma MTP drafters as sidecar downloads", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { buildHfCandidates } = await loadServerWithEnv();
  const candidates = buildHfCandidates({
    id: "unsloth/gemma-4-31B-it-GGUF",
    sha: "abc123",
    tags: ["gguf"],
    siblings: [
      { rfilename: "gemma-4-31B-it-UD-Q4_K_XL.gguf", size: 1000 },
      { rfilename: "mtp-gemma-4-31B-it.gguf", size: 200 },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].downloadSpec.files, [
    { path: "gemma-4-31B-it-UD-Q4_K_XL.gguf", sizeBytes: 1000 },
    {
      path: "mtp-gemma-4-31B-it.gguf",
      sourcePath: "mtp-gemma-4-31B-it.gguf",
      repoId: "unsloth/gemma-4-31B-it-GGUF",
      revision: "abc123",
      sizeBytes: 200,
    },
  ]);
  assert.deepEqual(candidates[0].mtpDraft, {
    repoId: "unsloth/gemma-4-31B-it-GGUF",
    revision: "abc123",
    sourcePath: "mtp-gemma-4-31B-it.gguf",
    outputPath: "mtp-gemma-4-31B-it.gguf",
    sizeBytes: 200,
  });
});

test("buildHfCandidates attaches same-repo Gemma QAT MTP drafters from the root mtp file", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { buildHfCandidates } = await loadServerWithEnv();
  const candidates = buildHfCandidates({
    id: "unsloth/gemma-4-31B-it-qat-GGUF",
    sha: "deadbeef",
    tags: ["gguf"],
    siblings: [
      { rfilename: "gemma-4-31B-it-qat-UD-Q4_K_XL.gguf", size: 1000 },
      { rfilename: "mtp-gemma-4-31B-it.gguf", size: 200 },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].downloadSpec.files, [
    { path: "gemma-4-31B-it-qat-UD-Q4_K_XL.gguf", sizeBytes: 1000 },
    {
      path: "mtp-gemma-4-31B-it.gguf",
      sourcePath: "mtp-gemma-4-31B-it.gguf",
      repoId: "unsloth/gemma-4-31B-it-qat-GGUF",
      revision: "deadbeef",
      sizeBytes: 200,
    },
  ]);
});

test("buildHfCandidates promotes MTP-named quants to main downloads when a repo has no other GGUFs", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { buildHfCandidates } = await loadServerWithEnv();
  const candidates = buildHfCandidates({
    id: "Jackrong/Qwopus3.6-27B-v2-MTP-GGUF",
    sha: "abc123",
    tags: ["gguf", "mtp"],
    siblings: [
      { rfilename: "Qwopus3.6-27B-v2-MTP-Q4_K_M.gguf", size: 1000 },
      { rfilename: "Qwopus3.6-27B-v2-MTP-Q8_0.gguf", size: 1800 },
      { rfilename: "mmproj-F32.gguf", size: 200 },
    ],
  });

  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    assert.equal(candidate.runtime, "gguf");
    assert.equal(candidate.vision, true);
    assert.equal(
      candidate.downloadSpec.files.filter((file) => file.path.startsWith("mmproj")).length,
      1,
    );
  }
  assert.deepEqual(
    candidates.map((candidate) => candidate.name).sort(),
    ["Qwopus3.6-27B-v2-MTP-Q4_K_M.gguf", "Qwopus3.6-27B-v2-MTP-Q8_0.gguf"],
  );
});

test("buildHfCandidates keeps mtp-/MTP-dir drafts as companions when promoting MTP-named quants", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { buildHfCandidates } = await loadServerWithEnv();
  const candidates = buildHfCandidates({
    id: "unsloth/Qwen3.6-35BA3B-MTP-GGUF",
    sha: "abc123",
    tags: ["gguf", "mtp"],
    siblings: [
      { rfilename: "Qwen3.6-35BA3B-MTP-Q4_K_M.gguf", size: 1000 },
      { rfilename: "MTP/Qwen3.6-35BA3B-MTP-Q8_0.gguf", size: 120 },
    ],
  });

  // The top-level "-MTP-Q4_K_M.gguf" is a full quant (its own row); the MTP/ dir
  // draft head is bundled with it as a speculative-decoding companion.
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, "Qwen3.6-35BA3B-MTP-Q4_K_M.gguf");
  assert.deepEqual(
    candidates[0].downloadSpec.files.map((file) => file.path),
    ["Qwen3.6-35BA3B-MTP-Q4_K_M.gguf", "MTP/Qwen3.6-35BA3B-MTP-Q8_0.gguf"],
  );
});

test("partitionMtpGgufPaths keeps draft-only repos unpromoted", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { partitionMtpGgufPaths } = await loadServerWithEnv();
  // A repo that is nothing but draft sidecars (MTP/ dir + mtp- prefix) has no
  // base model, so surface them all as main rather than hiding the repo.
  const draftsOnly = partitionMtpGgufPaths(["MTP/gemma-4-31B-it-MTP-Q8_0.gguf", "mtp-gemma-4-31B-it.gguf"]);
  assert.deepEqual(draftsOnly.main, ["MTP/gemma-4-31B-it-MTP-Q8_0.gguf", "mtp-gemma-4-31B-it.gguf"]);
  assert.deepEqual(draftsOnly.drafts, []);

  const mixed = partitionMtpGgufPaths(["model-Q4_K_M.gguf", "model-mtp-draft.gguf"]);
  assert.deepEqual(mixed.main, ["model-Q4_K_M.gguf"]);
  assert.deepEqual(mixed.drafts, ["model-mtp-draft.gguf"]);
});

test("normalizeConversionQuantization defaults and validates against the supported plans", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { normalizeConversionQuantization } = await loadServerWithEnv();
  assert.equal(normalizeConversionQuantization(""), "Q4_K_M");
  assert.equal(normalizeConversionQuantization("q5_k_m"), "Q5_K_M");
  assert.throws(() => normalizeConversionQuantization("Q2_K"), /Unsupported quantization/);
});

test("normalizeConversionCandidate reroutes ModelOpt repos to their advertised base model", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { normalizeConversionCandidate } = await loadServerWithEnv();
  const candidate = normalizeConversionCandidate({
    repoId: "nvidia/Qwen3.6-27B-NVFP4",
    runtime: "other",
    name: "Qwen3.6-27B-NVFP4",
    tags: [
      "quantized",
      "modelopt",
      "base_model:Qwen/Qwen3.6-27B",
      "base_model:quantized:Qwen/Qwen3.6-27B",
    ],
    quantizationMethod: "modelopt",
    libraryName: "Model Optimizer",
  });

  assert.equal(candidate.repoId, "nvidia/Qwen3.6-27B-NVFP4");
  assert.equal(candidate.baseModelRepoId, "Qwen/Qwen3.6-27B");
  assert.equal(candidate.conversionRepoId, "Qwen/Qwen3.6-27B");
  assert.equal(candidate.conversionBlockedReason, undefined);
});

test("normalizeConversionCandidate blocks unsupported quantized repos that do not advertise a base model", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { normalizeConversionCandidate } = await loadServerWithEnv();
  const candidate = normalizeConversionCandidate({
    repoId: "example/opaque-modelopt",
    runtime: "other",
    tags: ["modelopt", "quantized"],
    libraryName: "Model Optimizer",
  });

  assert.equal(candidate.conversionRepoId, "example/opaque-modelopt");
  assert.match(candidate.conversionBlockedReason, /unsupported library "Model Optimizer"|unsupported ModelOpt quantization|unsupported quantization method "modelopt"/);
});

test("selectConversionSourceFiles picks safetensors weights plus converter support files", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { selectConversionSourceFiles } = await loadServerWithEnv();
  const { weights, support } = selectConversionSourceFiles({
    siblings: [
      { rfilename: "config.json", size: 10 },
      { rfilename: "tokenizer.json", size: 20 },
      { rfilename: "model-00001-of-00002.safetensors", lfs: { size: 500 } },
      { rfilename: "model-00002-of-00002.safetensors", lfs: { size: 500 } },
      { rfilename: "model.safetensors.index.json", size: 5 },
      { rfilename: "consolidated.safetensors", lfs: { size: 1000 } },
      { rfilename: "README.md", size: 1 },
      { rfilename: "nested/extra.safetensors", lfs: { size: 999 } },
    ],
  });

  assert.deepEqual(
    weights.map((entry) => entry.path).sort(),
    ["model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors"],
  );
  assert.deepEqual(
    support.map((entry) => entry.path).sort(),
    ["config.json", "model.safetensors.index.json", "tokenizer.json"],
  );
});

test("readDownloadedMetadata normalizes older Gemma metadata to Gemma 4", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-downloaded-metadata-gemma4-"));
  const repoDir = path.join(tempDir, "ironbcc__gemma-4-26B-A4B-it-MTP-GGUF");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(
    path.join(repoDir, ".llm3-hf.json"),
    `${JSON.stringify({
      source: "huggingface",
      repoId: "ironbcc/gemma-4-26B-A4B-it-MTP-GGUF",
      family: "Gemma",
      aliases: ["gemma-4-26B-A4B-it-Q8_0.gguf"],
    }, null, 2)}\n`,
    "utf8",
  );

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { readDownloadedMetadata } = await loadServerWithEnv();
  const metadata = await readDownloadedMetadata(repoDir);

  assert.equal(metadata.family, "Gemma 4");
});

test("scanDownloadedModels hides MTP draft GGUF sidecars from the model list", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-downloaded-models-hide-mtp-"));
  const hfRoot = path.join(tempDir, "models", "hf");
  const repoDir = path.join(hfRoot, "unsloth__gemma-4-31B-it-qat-GGUF");
  const fakeLauncher = path.join(tempDir, "fake-list-json-launcher.sh");
  await fs.mkdir(path.join(repoDir, "MTP"), { recursive: true });
  await fs.writeFile(path.join(repoDir, "gemma-4-31B-it-qat-UD-Q4_K_XL.gguf"), "target", "utf8");
  await fs.writeFile(path.join(repoDir, "MTP", "gemma-4-31B-it-MTP-Q8_0.gguf"), "draft", "utf8");
  await fs.writeFile(
    fakeLauncher,
    "#!/bin/sh\nif [ \"$1\" = \"--list-json\" ]; then\n  printf '[]\\n'\n  exit 0\nfi\nexit 0\n",
    "utf8",
  );
  await fs.chmod(fakeLauncher, 0o755);
  await fs.writeFile(
    path.join(repoDir, ".llm3-hf.json"),
    `${JSON.stringify({
      source: "huggingface",
      repoId: "unsloth/gemma-4-31B-it-qat-GGUF",
      family: "Gemma 4",
      aliases: ["gemma-4-31B-it-qat-UD-Q4_K_XL.gguf"],
    }, null, 2)}\n`,
    "utf8",
  );

  t.after(async () => {
    delete process.env.HOME;
    delete process.env.QWEN_LLAMA;
    delete process.env.QWEN_MLX;
    delete process.env.QWEN_OPTIQ;
    delete process.env.QWEN_DFLASH;
    delete process.env.QWEN_TURBO_QUANT;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { app } = await loadServerWithEnv({
    HOME: tempDir,
    QWEN_LLAMA: fakeLauncher,
    QWEN_MLX: fakeLauncher,
    QWEN_OPTIQ: fakeLauncher,
    QWEN_DFLASH: fakeLauncher,
    QWEN_TURBO_QUANT: fakeLauncher,
  });
  const http = require("node:http");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/models`);
  const payload = await response.json();
  const models = Array.isArray(payload) ? payload : [];

  assert.equal(models.length, 1);
  assert.match(models[0].path, /gemma-4-31B-it-qat-UD-Q4_K_XL\.gguf$/);
});

test("scanDownloadedModels hides Gemma MTP sidecars with the Q8_0-MTP suffix from the model list", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-downloaded-models-hide-gemma-q8-mtp-"));
  const hfRoot = path.join(tempDir, "models", "hf");
  const repoDir = path.join(hfRoot, "unsloth__gemma-4-31B-it-qat-GGUF");
  const fakeLauncher = path.join(tempDir, "fake-list-json-launcher.sh");
  await fs.mkdir(path.join(repoDir, "MTP"), { recursive: true });
  await fs.writeFile(path.join(repoDir, "gemma-4-31B-it-qat-UD-Q4_K_XL.gguf"), "target", "utf8");
  await fs.writeFile(path.join(repoDir, "MTP", "gemma-4-31B-it-Q8_0-MTP.gguf"), "draft", "utf8");
  await fs.writeFile(
    fakeLauncher,
    "#!/bin/sh\nif [ \"$1\" = \"--list-json\" ]; then\n  printf '[]\\n'\n  exit 0\nfi\nexit 0\n",
    "utf8",
  );
  await fs.chmod(fakeLauncher, 0o755);

  t.after(async () => {
    delete process.env.HOME;
    delete process.env.QWEN_LLAMA;
    delete process.env.QWEN_MLX;
    delete process.env.QWEN_OPTIQ;
    delete process.env.QWEN_DFLASH;
    delete process.env.QWEN_TURBO_QUANT;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { app } = await loadServerWithEnv({
    HOME: tempDir,
    QWEN_LLAMA: fakeLauncher,
    QWEN_MLX: fakeLauncher,
    QWEN_OPTIQ: fakeLauncher,
    QWEN_DFLASH: fakeLauncher,
    QWEN_TURBO_QUANT: fakeLauncher,
  });
  const http = require("node:http");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/models`);
  const payload = await response.json();
  const models = Array.isArray(payload) ? payload : [];

  assert.equal(models.length, 1);
  assert.match(models[0].path, /gemma-4-31B-it-qat-UD-Q4_K_XL\.gguf$/);
});

test("buildHfCandidates pins GGUF templates from the base model when the quantized repo omits them", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { buildHfCandidates } = await loadServerWithEnv();
  const candidates = buildHfCandidates({
    id: "unsloth/Qwen3.6-27B-GGUF",
    sha: "deadbeef",
    tags: [
      "gguf",
      "base_model:Qwen/Qwen3.6-27B",
      "base_model:quantized:Qwen/Qwen3.6-27B",
    ],
    siblings: [
      { rfilename: "Qwen3.6-27B-UD-Q8_K_XL.gguf", size: 1234 },
      { rfilename: "mmproj-F16.gguf", size: 200 },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].template, {
    outputPath: ".llm3-chat-template.jinja",
    sources: [
      { repoId: "Qwen/Qwen3.6-27B", revision: "main", path: "chat_template.jinja" },
      { repoId: "Qwen/Qwen3.6-27B", revision: "main", path: "chat_template.json" },
      { repoId: "Qwen/Qwen3.6-27B", revision: "main", path: "tokenizer_config.json" },
    ],
  });
});

test("buildHfCandidates pins Qwopus GGUF templates from the advertised base model when the repo ships only weights", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { buildHfCandidates } = await loadServerWithEnv();
  const candidates = buildHfCandidates({
    id: "mudler/Qwopus3.6-35B-A3B-v1-APEX-GGUF",
    sha: "feedcafe",
    tags: [
      "gguf",
      "apex",
      "base_model:Jackrong/Qwopus3.6-35B-A3B-v1",
      "base_model:quantized:Jackrong/Qwopus3.6-35B-A3B-v1",
    ],
    siblings: [
      { rfilename: "Qwopus3.6-35B-A3B-v1-APEX-Quality.gguf", size: 22819402080 },
      { rfilename: "README.md", size: 4096 },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].template, {
    outputPath: ".llm3-chat-template.jinja",
    sources: [
      { repoId: "Jackrong/Qwopus3.6-35B-A3B-v1", revision: "main", path: "chat_template.jinja" },
      { repoId: "Jackrong/Qwopus3.6-35B-A3B-v1", revision: "main", path: "chat_template.json" },
      { repoId: "Jackrong/Qwopus3.6-35B-A3B-v1", revision: "main", path: "tokenizer_config.json" },
    ],
  });
});

test("buildHfCandidates downloads complete MTPLX snapshots from MTPLX-only repos", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { buildHfCandidates, parseHfSearchQuery } = await loadServerWithEnv();
  const search = parseHfSearchQuery("samuelfaj/Qwen3.6-35B-A3B-4bit-MTPLX-Optimized-Speed");
  const candidates = buildHfCandidates({
    id: "samuelfaj/Qwen3.6-35B-A3B-4bit-MTPLX-Optimized-Speed",
    sha: "cafebabe",
    library_name: "mtplx",
    tags: ["mtplx", "4bit"],
    siblings: [
      { rfilename: "config.json", size: 100 },
      { rfilename: "model-00001-of-00004.safetensors", lfs: { size: 1000 } },
      { rfilename: "model.safetensors.index.json", size: 200 },
      { rfilename: "mtp.safetensors", lfs: { size: 300 } },
      { rfilename: "mtplx_runtime.json", size: 400 },
      { rfilename: "tokenizer.json", size: 500 },
      { rfilename: "tokenizer_config.json", size: 600 },
      { rfilename: "README.md", size: 700 },
    ],
  });

  assert.equal(search.runtime, "mtplx");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].runtime, "mtplx");
  assert.equal(candidates[0].downloadSpec.runtime, "mtplx");
  assert.deepEqual(
    candidates[0].downloadSpec.files.map((file) => file.path),
    [
      "config.json",
      "model-00001-of-00004.safetensors",
      "model.safetensors.index.json",
      "mtp.safetensors",
      "mtplx_runtime.json",
      "tokenizer.json",
      "tokenizer_config.json",
    ],
  );
});

test("dashboard config persists profile defaults and drops invalid active profile ids", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-profiles-"));

  t.after(async () => {
    delete process.env.LLM3_STATE_DIR;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { writeDashboardConfig, readDashboardConfig } = await loadServerWithEnv({
    LLM3_STATE_DIR: tempDir,
  });

  await writeDashboardConfig({
    applicationTargets: { hermes: "slot1", hermesm4: "slot1", compaction: "slot4", remotejsonapp: "slot1", sqliteapp: "slot1", librechat: "slot1", claudecode: "slot1" },
    slotRuntimeBaseUrls: { slot1: "http://127.0.0.1:8036/v1" },
    profiles: [
      {
        id: "alpha",
        name: "Alpha",
        color: "#fef08a",
        slots: {
          slot1: {
            enabled: true,
            modelKey: "model-a",
            ctxSize: 131072,
            parallel: 2,
            thinking: true,
          },
        },
        voiceSlots: {
          "voice-tts-1": {
            enabled: true,
            modelKey: "voice-tts/xtts-v2",
            voiceName: "alloy",
            sampleRate: 24000,
          },
        },
      },
    ],
    defaultProfileId: "alpha",
    activeProfileId: "missing-profile",
  });

  const config = await readDashboardConfig();
  assert.equal(config.defaultProfileId, "alpha");
  assert.equal(config.activeProfileId, "");
  assert.equal(config.profiles.length, 1);
  assert.equal(config.profiles[0].color, "#fef08a");
  assert.equal(config.profiles[0].slots.slot1.enabled, true);
  assert.equal(config.profiles[0].slots.slot1.ctxSize, 131072);
  assert.equal(config.profiles[0].slots.slot2.enabled, false);
  assert.equal(config.profiles[0].voiceSlots["voice-tts-1"].enabled, true);
  assert.equal(config.profiles[0].voiceSlots["voice-tts-1"].voiceName, "alloy");
  assert.equal(config.profiles[0].voiceSlots["voice-stt-1"].enabled, false);
});

test("normalizeProfileSlotConfig preserves PodG AutoGen application flag", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { normalizeProfileSlotConfig } = await loadServerWithEnv();
  const config = normalizeProfileSlotConfig("slot1", {
    enabled: true,
    modelKey: "model-a",
    setPodGAutoGen: true,
  });

  assert.equal(config.setPodGAutoGen, true);
  assert.equal(config.setPodcastG, false);
});

test("dashboard config preserves PodG AutoGen application target", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-podgag-target-"));

  t.after(async () => {
    delete process.env.LLM3_STATE_DIR;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { writeDashboardConfig, readDashboardConfig } = await loadServerWithEnv({
    LLM3_STATE_DIR: tempDir,
  });

  await writeDashboardConfig({
    applicationTargets: {
      hermes: "slot1",
      hermesm4: "slot1",
      compaction: "slot4",
      remotejsonapp: "slot1",
      sqliteapp: "slot1",
      librechat: "slot1",
      claudecode: "slot1",
      voiceapp: "slot1",
      podcastg: "slot1",
      podgag: "slot2",
    },
  });

  const config = await readDashboardConfig();
  assert.equal(config.applicationTargets.podgag, "slot2");
  assert.equal(config.applicationTargets.podcastg, "slot1");
});

test("deleteDashboardProfile removes saved profiles and clears matching ids", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-profile-delete-"));

  t.after(async () => {
    delete process.env.LLM3_STATE_DIR;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { writeDashboardConfig, readDashboardConfig, deleteDashboardProfile } = await loadServerWithEnv({
    LLM3_STATE_DIR: tempDir,
  });

  await writeDashboardConfig({
    applicationTargets: { hermes: "slot1", hermesm4: "slot1", compaction: "slot4", remotejsonapp: "slot1", sqliteapp: "slot1", librechat: "slot1", claudecode: "slot1" },
    slotRuntimeBaseUrls: { slot1: "http://127.0.0.1:8036/v1" },
    profiles: [
      {
        id: "alpha",
        name: "Alpha",
        slots: {
          slot1: { enabled: true, modelKey: "model-a", ctxSize: 131072, parallel: 2 },
        },
      },
      {
        id: "beta",
        name: "Beta",
        slots: {
          slot2: { enabled: true, modelKey: "model-b", ctxSize: 65536, parallel: 1 },
        },
      },
    ],
    defaultProfileId: "alpha",
    activeProfileId: "alpha",
  });

  const deletedProfile = await deleteDashboardProfile("alpha");
  assert.equal(deletedProfile.name, "Alpha");

  const config = await readDashboardConfig();
  assert.equal(config.defaultProfileId, "");
  assert.equal(config.activeProfileId, "");
  assert.deepEqual(config.profiles.map((profile) => profile.id), ["beta"]);
});

test("syncSqliteAppAfterLaunch updates the SQLite app settings and restarts PM2 when present", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-sqlite-app-"));
  const dbPath = path.join(tempDir, "notes.db");
  const pm2BinPath = path.join(tempDir, "pm2");
  const pm2LogPath = path.join(tempDir, "pm2.log");

  await fs.writeFile(
    pm2BinPath,
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$PM2_LOG_PATH\"",
      "if [ \"$1\" = \"describe\" ]; then",
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  await fs.writeFile(
    dbPath,
    "",
    "utf8",
  );

  t.after(async () => {
    delete process.env.SQLITE_APP_SYNC_ROOT;
    delete process.env.SQLITE_APP_SYNC_DB_PATH;
    delete process.env.SQLITE_APP_SYNC_PM2_APP;
    delete process.env.SQLITE_APP_SYNC_API_KEY;
    process.env.PATH = originalPath;
    delete process.env.PM2_LOG_PATH;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const originalPath = process.env.PATH || "";
  const { syncSqliteAppAfterLaunch } = await loadServerWithEnv({
    SQLITE_APP_SYNC_ROOT: tempDir,
    SQLITE_APP_SYNC_DB_PATH: dbPath,
    SQLITE_APP_SYNC_PM2_APP: "sqlite-app",
    SQLITE_APP_SYNC_API_KEY: "api",
    PATH: `${tempDir}:${originalPath}`,
    PM2_LOG_PATH: pm2LogPath,
  });

  const result = await syncSqliteAppAfterLaunch({
    modelId: "Qwen3.6-35B-A3B-MXFP4_MOE",
    runtimeBaseUrl: "http://127.0.0.1:8038/v1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.base_url, "http://127.0.0.1:8038/v1");
  assert.equal(result.model, "Qwen3.6-35B-A3B-MXFP4_MOE");
  assert.deepEqual(result.restarted_apps, ["sqlite-app"]);

  const settingsRows = JSON.parse(
    (await execFileAsync("sqlite3", [dbPath, "-json", "SELECT key, value FROM settings ORDER BY key ASC"], {
      maxBuffer: 64 * 1024,
    })).stdout || "[]",
  );
  assert.deepEqual(settingsRows, [
    { key: "hermes_api_key", value: "api" },
    { key: "hermes_base_url", value: "http://127.0.0.1:8038/v1" },
    { key: "llm_model", value: "Qwen3.6-35B-A3B-MXFP4_MOE" },
  ]);

  const pm2Log = await fs.readFile(pm2LogPath, "utf8");
  assert.match(pm2Log, /describe sqlite-app/);
  assert.match(pm2Log, /restart sqlite-app/);
});

test("syncClaudeCodeAfterLaunch skips GUI restart cleanly under system launchd", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-claude-launchd-"));
  const binDir = path.join(tempDir, "bin");
  const proxyEnvPath = path.join(tempDir, "claude-proxy.env");
  const settingsPath = path.join(tempDir, "settings.json");
  const launchctlPath = path.join(binDir, "launchctl");
  const originalPath = process.env.PATH || "";

  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    launchctlPath,
    [
      "#!/bin/sh",
      "echo 'Could not find domain for gui session' >&2",
      "exit 113",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  t.after(async () => {
    delete process.env.CLAUDE_SYNC_ENABLED;
    delete process.env.CLAUDE_PROXY_ENV_PATH;
    delete process.env.CLAUDE_SETTINGS_PATH;
    delete process.env.CLAUDE_PROXY_LAUNCH_LABEL;
    delete process.env.CLAUDE_PROXY_ROOT_URL;
    delete process.env.LLM3_SERVICE_MODE;
    delete process.env.LLM3_LAUNCHD_DOMAIN;
    delete process.env.LLM3_GUI_UID;
    process.env.PATH = originalPath;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { syncClaudeCodeAfterLaunch } = await loadServerWithEnv({
    CLAUDE_SYNC_ENABLED: "true",
    CLAUDE_PROXY_ENV_PATH: proxyEnvPath,
    CLAUDE_SETTINGS_PATH: settingsPath,
    CLAUDE_PROXY_LAUNCH_LABEL: "com.example.claude-proxy",
    CLAUDE_PROXY_ROOT_URL: "http://127.0.0.1:4999/",
    LLM3_SERVICE_MODE: "launchd",
    LLM3_LAUNCHD_DOMAIN: "system",
    LLM3_GUI_UID: "501",
    PATH: `${binDir}:${originalPath}`,
  });

  const result = await syncClaudeCodeAfterLaunch({
    modelId: "Qwen3.6-Test",
    contextLength: 65536,
    runtimeBaseUrl: "http://127.0.0.1:8036/v1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.proxy.skipped, true);
  assert.equal(result.proxy.requires_gui_session, true);
  assert.match(result.proxy.reason, /GUI/i);

  const envContents = await fs.readFile(proxyEnvPath, "utf8");
  assert.match(envContents, /OPENAI_BASE_URL="?http:\/\/127\.0\.0\.1:8036\/v1"?/);
  assert.match(envContents, /BIG_MODEL="?Qwen3\.6-Test"?/);

  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, "Qwen3.6-Test");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "Qwen3.6-Test");
});

test("clearHfDownloadJobs removes finished jobs and keeps active ones", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hf-jobs-"));
  const jobsDir = path.join(tempDir, "hf", "jobs");
  await fs.mkdir(jobsDir, { recursive: true });

  await fs.writeFile(path.join(jobsDir, "completed.json"), JSON.stringify({
    id: "completed",
    status: "completed",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }), "utf8");
  await fs.writeFile(path.join(jobsDir, "failed.json"), JSON.stringify({
    id: "failed",
    status: "failed",
    updatedAt: "2026-01-02T00:00:00.000Z",
  }), "utf8");
  // A genuinely running job is one with a live worker behind it; this test
  // process stands in for that worker.
  await fs.writeFile(path.join(jobsDir, "running.json"), JSON.stringify({
    id: "running",
    status: "running",
    pid: process.pid,
    updatedAt: "2026-01-03T00:00:00.000Z",
  }), "utf8");

  t.after(async () => {
    delete process.env.LLM3_STATE_DIR;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { clearHfDownloadJobs, readHfDownloadJobs } = await loadServerWithEnv({
    LLM3_STATE_DIR: tempDir,
  });

  const remaining = await clearHfDownloadJobs();
  assert.deepEqual(remaining.map((job) => job.id), ["running"]);

  const fromDisk = await readHfDownloadJobs();
  assert.deepEqual(fromDisk.map((job) => job.id), ["running"]);
  assert.equal(fromDisk[0].canClear, false);
});

test("readHfDownloadJobs releases a job wedged in cancelling with no worker pid", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hf-stuck-"));
  const jobsDir = path.join(tempDir, "hf", "jobs");
  await fs.mkdir(jobsDir, { recursive: true });

  // Shape of the real job that sat "cancelling" for a month: a force-cancel
  // dropped the pid, so the old reconciler returned early and it stayed active
  // forever — unclearable, and blocking any re-queue for the same target dir.
  await fs.writeFile(path.join(jobsDir, "stuck.json"), JSON.stringify({
    id: "stuck",
    kind: "convert",
    status: "cancelling",
    cancelRequested: true,
    message: "Force cancelling",
    targetDir: path.join(tempDir, "models", "nvidia__Example__gguf"),
    createdAt: "2026-06-24T14:35:30.762Z",
    updatedAt: "2026-06-24T14:45:36.708Z",
  }), "utf8");

  // A job written milliseconds ago has no pid yet because enqueueHfJob records
  // it right after spawning — that one must be left alone.
  await fs.writeFile(path.join(jobsDir, "starting.json"), JSON.stringify({
    id: "starting",
    kind: "download",
    status: "queued",
    updatedAt: new Date().toISOString(),
  }), "utf8");

  t.after(async () => {
    delete process.env.LLM3_STATE_DIR;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { readHfDownloadJobs } = await loadServerWithEnv({ LLM3_STATE_DIR: tempDir });
  const jobs = await readHfDownloadJobs();

  const stuck = jobs.find((job) => job.id === "stuck");
  assert.equal(stuck.status, "cancelled", "a pidless cancelling job is finally settled");
  assert.equal(stuck.canClear, true, "and can now be cleared from the UI");

  const starting = jobs.find((job) => job.id === "starting");
  assert.equal(starting.status, "queued", "a job still inside the spawn window is untouched");
  assert.equal(starting.canClear, false);
});

test("cancelling a parallel download removes its .parts chunk directory", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hf-parts-"));
  const targetDir = path.join(tempDir, "acme__Repo-GGUF");
  await fs.mkdir(targetDir, { recursive: true });

  // The 8 range workers each leave a chunk behind; the old cleanup keyed off the
  // job pid, so a force-cancelled job (pid 0) stranded all of them on disk.
  const partsDir = path.join(targetDir, "Model-Q6_K.gguf.partial-49757.parts");
  await fs.mkdir(partsDir, { recursive: true });
  await fs.writeFile(path.join(partsDir, "000000.part"), "chunk", "utf8");
  await fs.writeFile(path.join(targetDir, "Model-Q6_K.gguf.partial-49757"), "partial", "utf8");
  await fs.writeFile(path.join(targetDir, "keep-me.gguf"), "real", "utf8");

  t.after(async () => {
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { removePartialArtifacts } = await loadServerWithEnv();
  await removePartialArtifacts(path.join(targetDir, "Model-Q6_K.gguf"));

  const remaining = await fs.readdir(targetDir);
  assert.ok(!remaining.includes("Model-Q6_K.gguf.partial-49757.parts"), "the chunk directory is removed");
  assert.ok(!remaining.includes("Model-Q6_K.gguf.partial-49757"), "the partial file is removed");
  assert.ok(remaining.includes("keep-me.gguf"), "unrelated files are left alone");
});

test("computeSlotBenchmarkMetrics prefers usage tokens and falls back to text estimate", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { computeSlotBenchmarkMetrics } = await loadServerWithEnv();
  const exact = computeSlotBenchmarkMetrics({
    elapsedMs: 2000,
    firstTokenMs: 350,
    outputText: "12345",
    usage: {
      prompt_tokens: 48,
      completion_tokens: 120,
      total_tokens: 168,
    },
  });
  assert.equal(exact.promptTokens, 48);
  assert.equal(exact.completionTokens, 120);
  assert.equal(exact.totalTokens, 168);
  assert.equal(exact.completionTokensEstimated, false);
  assert.equal(exact.completionTokensPerSecond, 60);

  const estimated = computeSlotBenchmarkMetrics({
    elapsedMs: 1000,
    firstTokenMs: null,
    outputText: "x".repeat(80),
    usage: null,
  });
  assert.equal(estimated.promptTokens, null);
  assert.equal(estimated.completionTokens, 20);
  assert.equal(estimated.totalTokens, 20);
  assert.equal(estimated.completionTokensEstimated, true);
  assert.equal(estimated.completionTokensPerSecond, 20);
});

test("diagnostics parsers keep relevant Hermes and MLX errors with timestamps", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { parseHermesDiagnosticsEntries, parseMlxDiagnosticsEntries } = await loadServerWithEnv();
  const fallbackTimestamp = {
    iso: "2026-04-28T20:13:32.000Z",
    label: "2026-04-28 20:13:32",
  };

  const hermesEntries = parseHermesDiagnosticsEntries([
    "2026-04-28 19:34:21,043 WARNING root: Session search LLM returned empty content (attempt 3/3)",
    "2026-04-28 19:34:35,502 INFO agent.auxiliary_client: Auxiliary auto-detect succeeded",
    "2026-04-28 19:36:06,738 WARNING root: Failed to generate context summary: Connection error.",
  ].join("\n"), { key: "hermes-agent", label: "Hermes agent" }, fallbackTimestamp);
  assert.deepEqual(
    hermesEntries.map((entry) => ({ timestamp: entry.timestamp, summary: entry.summary })),
    [
      {
        timestamp: "2026-04-28 19:34:21,043",
        summary: "root: Session search LLM returned empty content (attempt 3/3)",
      },
      {
        timestamp: "2026-04-28 19:36:06,738",
        summary: "root: Failed to generate context summary: Connection error.",
      },
    ],
  );

  const mlxEntries = parseMlxDiagnosticsEntries([
    "ERROR:vllm_mlx.scheduler:Error in batch generation step: [concatenate] mismatch",
    "Traceback (most recent call last):",
    "ValueError: [concatenate] All the input array dimensions must match exactly",
    "WARNING:vllm_mlx.scheduler:[generation_error_recovery] aborted 2 running requests, batch generator closed, Metal cache cleared",
    "INFO:vllm_mlx.routes.chat:Chat completion: 0 tokens in 8.11s (0.0 tok/s)",
    "INFO:vllm_mlx.routes.chat:Chat completion: 102 tokens in 89.67s (1.1 tok/s)",
  ].join("\n"), { key: "rapid-mlx", label: "rapid-mlx" }, fallbackTimestamp);
  assert.deepEqual(
    mlxEntries.map((entry) => ({ severity: entry.severity, timestamp: entry.timestamp, summary: entry.summary })),
    [
      {
        severity: "error",
        timestamp: "2026-04-28 20:13:32",
        summary: "vllm_mlx.scheduler: Error in batch generation step: [concatenate] mismatch",
      },
      {
        severity: "warning",
        timestamp: "2026-04-28 20:13:32",
        summary: "vllm_mlx.scheduler: [generation_error_recovery] aborted 2 running requests, batch generator closed, Metal cache cleared",
      },
      {
        severity: "info",
        timestamp: "2026-04-28 20:13:32",
        summary: "vllm_mlx.routes.chat: Chat completion: 0 tokens in 8.11s (0.0 tok/s)",
      },
    ],
  );
});

test("Hermes session diagnostics surface missing tools and tool-as-text anomalies", async (t) => {
  t.after(() => {
    delete require.cache[SERVER_MODULE_PATH];
  });

  const { parseHermesSessionDiagnosticsEntries, compactDiagnosticsEntries } = await loadServerWithEnv();
  const fallbackTimestamp = {
    iso: "2026-04-28T22:08:42.000Z",
    label: "2026-04-28 22:08:42",
  };

  const sessionEntries = parseHermesSessionDiagnosticsEntries({
    messages: [
      {
        role: "assistant",
        content: "Cloudflare is blocking. Let me try something else.",
        finish_reason: "stop",
        tool_calls: [
          {
            id: "call_recovered_6c5069c9",
            function: {
              name: "browser_navigate",
              arguments: "{\"url\":\"https://alphasignal.ai/\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        content: "Tool 'web_search' does not exist. Available tools: browser_navigate, execute_code, read_file",
      },
      {
        role: "tool",
        content: "Tool 'web_search' does not exist. Available tools: browser_navigate, execute_code, read_file",
      },
      {
        role: "assistant",
        content: "[Calling tool: execute_code({\"code\":\"print(1)\"})]",
        finish_reason: "stop",
      },
    ],
  }, { key: "hermes-session-demo", label: "Hermes session" }, fallbackTimestamp, {
    sessionName: "session_20260428_220842_65fe16.json",
  });

  assert.deepEqual(
    sessionEntries.map((entry) => ({ severity: entry.severity, summary: entry.summary })),
    [
      {
        severity: "warning",
        summary: "Hermes recovered tool call from assistant text: browser_navigate",
      },
      {
        severity: "error",
        summary: "Model requested unavailable tool: web_search",
      },
      {
        severity: "error",
        summary: "Model requested unavailable tool: web_search",
      },
      {
        severity: "error",
        summary: "Assistant emitted tool call as plain text: execute_code",
      },
    ],
  );

  const compacted = compactDiagnosticsEntries(sessionEntries);
  const missingTool = compacted.find((entry) => entry.summary === "Model requested unavailable tool: web_search");
  assert.ok(missingTool);
  assert.equal(missingTool.occurrences, 2);

  const plainText = compacted.find((entry) => entry.summary === "Assistant emitted tool call as plain text: execute_code");
  assert.ok(plainText?.details.includes("[Calling tool: execute_code"));
});

test("voice benchmark audio route does not serve files outside the runs directory", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-voice-audio-traversal-"));
  const stateDir = path.join(tempDir, "state");
  const runsDir = path.join(stateDir, "voice", "benchmark", "runs");
  const leakDir = path.join(stateDir, "voice", "benchmark", "leak");
  await fs.mkdir(path.join(runsDir, "run1"), { recursive: true });
  await fs.mkdir(leakDir, { recursive: true });
  await fs.writeFile(path.join(runsDir, "run1", "clip.wav"), "RIFFclip", "utf8");
  await fs.writeFile(path.join(leakDir, "secret.txt"), "top-secret", "utf8");

  t.after(async () => {
    delete process.env.HOME;
    delete process.env.LLM3_STATE_DIR;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { app } = await loadServerWithEnv({ HOME: tempDir, LLM3_STATE_DIR: stateDir });
  const http = require("node:http");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const ok = await fetch(`${base}/api/voice/benchmark/audio/run1/clip.wav`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "RIFFclip");

  for (const runId of ["..%2Fleak", "..%252Fleak", "run1%2F..%2F..%2Fleak"]) {
    const response = await fetch(`${base}/api/voice/benchmark/audio/${runId}/secret.txt`);
    assert.notEqual(response.status, 200, runId);
    assert.doesNotMatch(await response.text(), /top-secret/, runId);
  }
});

test("updateDashboardConfig serializes concurrent read-modify-write updates", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-config-lock-"));
  const stateDir = path.join(tempDir, "state");
  t.after(async () => {
    delete process.env.HOME;
    delete process.env.LLM3_STATE_DIR;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const { updateDashboardConfig, readDashboardConfig } = await loadServerWithEnv({ HOME: tempDir, LLM3_STATE_DIR: stateDir });

  const keys = Array.from({ length: 25 }, (_, i) => `/models/model-${i}.gguf`);
  await Promise.all(keys.map((key) => updateDashboardConfig((config) => ({
    ...config,
    usedModelKeys: [...config.usedModelKeys, key],
  }))));

  const config = await readDashboardConfig();
  assert.deepEqual([...config.usedModelKeys].sort(), [...keys].sort(), "every concurrent update survived");
  const onDisk = JSON.parse(await fs.readFile(path.join(stateDir, "dashboard-config.json"), "utf8"));
  assert.equal(onDisk.usedModelKeys.length, 25);
  const leftovers = (await fs.readdir(stateDir)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "atomic writes leave no temp files");

  const unchanged = await updateDashboardConfig(() => null);
  assert.equal(unchanged.usedModelKeys.length, 25, "a null result leaves the config as is");
});

test("a rejected async route handler answers with JSON, not an HTML stack trace", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-error-handler-"));
  t.after(async () => {
    delete process.env.HOME;
    delete process.env.LLM3_STATE_DIR;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const { app } = await loadServerWithEnv({ HOME: tempDir, LLM3_STATE_DIR: path.join(tempDir, "state") });
  const http = require("node:http");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  // express.json() rejects a malformed body with a 400 error object, which
  // travels the same error path as a thrown handler.
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sync-target`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.match((await response.json()).error, /JSON|token|Unexpected/i);
});
