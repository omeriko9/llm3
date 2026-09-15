const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const QWEN_LLAMA_PATH = path.join(__dirname, "..", "bin", "qwen_llama");
const SLOT_API_PROXY_PATH = path.join(__dirname, "..", "src", "slot-api-proxy.py");

test("qwen_llama runs the shared slot proxy file instead of an embedded copy", async () => {
  const [launcherSource, proxySource] = await Promise.all([
    fs.readFile(QWEN_LLAMA_PATH, "utf8"),
    fs.readFile(SLOT_API_PROXY_PATH, "utf8"),
  ]);

  assert.match(launcherSource, /python3 -u "\$proxy_script"/);
  assert.match(launcherSource, /proxy_script="\$LLM3_DIR\/src\/slot-api-proxy\.py"/);
  assert.doesNotMatch(launcherSource, /class ProxyHandler/, "the proxy must not be embedded again");
  // Long generations must not be cut off by the proxy's backend timeout.
  assert.match(proxySource, /HTTPConnection\(ARGS\.backend_host, ARGS\.backend_port, timeout=3600\)/);
});

async function createFakeGguf(rootDir, name) {
  const modelPath = path.join(rootDir, name);
  await fs.writeFile(modelPath, "stub", "utf8");
  return modelPath;
}

async function createFakeGgufRepo(rootDir, repoName, modelName, metadata = {}) {
  const repoDir = path.join(rootDir, repoName);
  await fs.mkdir(repoDir, { recursive: true });
  const modelPath = await createFakeGguf(repoDir, modelName);
  const payload = {
    source: "huggingface",
    repoId: metadata.repoId || `test/${repoName}`,
    hfUrl: metadata.hfUrl || `https://huggingface.co/test/${repoName}`,
    label: metadata.label || "",
    family: metadata.family || "",
    quantization: metadata.quantization || "Q8_0",
    runtime: "gguf",
    aliases: metadata.aliases || [modelName, path.basename(modelName, ".gguf")],
    updatedAt: "2026-05-25T00:00:00.000Z",
    ...(metadata.chatTemplateFile ? { chatTemplateFile: metadata.chatTemplateFile } : {}),
    ...(metadata.mtpDraftFile ? { mtpDraftFile: metadata.mtpDraftFile } : {}),
  };
  await fs.writeFile(path.join(repoDir, ".llm3-hf.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (metadata.chatTemplateFile) {
    await fs.writeFile(path.join(repoDir, metadata.chatTemplateFile), metadata.chatTemplateContent || "{{ bos_token }}", "utf8");
  }
  if (metadata.mtpDraftFile) {
    const draftPath = path.join(repoDir, metadata.mtpDraftFile);
    await fs.mkdir(path.dirname(draftPath), { recursive: true });
    await fs.writeFile(draftPath, metadata.mtpDraftContent || "draft", "utf8");
  }
  return { repoDir, modelPath };
}

async function createFakeLlamaSource(rootDir) {
  const sourceDir = path.join(rootDir, "fake-llama.cpp");
  const templatePath = path.join(sourceDir, "models", "templates", "google-gemma-4-31B-it-interleaved.jinja");
  await fs.mkdir(path.dirname(templatePath), { recursive: true });
  await fs.writeFile(templatePath, "{# gemma4 interleaved #}\n{{ bos_token }}", "utf8");
  return { sourceDir, templatePath };
}

async function createFakeLlamaServer(rootDir) {
  const serverPath = path.join(rootDir, "fake-llama-server.js");
  await fs.writeFile(
    serverPath,
    `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
if (args[0] === "--help") {
  process.stdout.write("--spec-type [none|draft-mtp|draft]\\n--spec-draft-p-min\\n--reasoning\\n");
  process.exit(0);
}

const argsFile = process.env.FAKE_LLAMA_ARGS_FILE;
if (argsFile) {
  fs.writeFileSync(argsFile, JSON.stringify(args));
}
process.exit(0);
`,
    "utf8",
  );
  await fs.chmod(serverPath, 0o755);
  return serverPath;
}

async function runLauncher(tempDir, modelPath, extraArgs = [], extraEnv = {}) {
  const argsFile = path.join(tempDir, "backend-args.json");
  const fakeServerPath = await createFakeLlamaServer(tempDir);
  const env = {
    ...process.env,
    // stop_previous_server() ends with kill_known_listener on PORT and BACKEND_PORT,
    // which kills whatever is LISTENING there regardless of the pid files. Isolating
    // QWEN_LLAMA_STATE_DIR is therefore not enough: without these two the launcher
    // falls back to slot1's real ports and every test run kills a live slot1.
    QWEN_LLAMA_PORT: "9731",
    QWEN_LLAMA_BACKEND_PORT: "19731",
    QWEN_LLAMA_STATE_DIR: path.join(tempDir, "state"),
    QWEN_LLAMA_POLL_SECONDS: "0.05",
    QWEN_LLAMA_SERVER: fakeServerPath,
    QWEN_LLAMA_UPSTREAM_SERVER: fakeServerPath,
    QWEN_LLAMA_MTP_SERVER: fakeServerPath,
    QWEN_LLAMA_HOST: "127.0.0.1",
    QWEN_LLAMA_BACKEND_HOST: "127.0.0.1",
    FAKE_LLAMA_ARGS_FILE: argsFile,
    ...extraEnv,
  };

  try {
    await execFileAsync(QWEN_LLAMA_PATH, [modelPath, ...extraArgs], { env });
    assert.fail("Expected qwen_llama to fail after the fake backend exits immediately");
  } catch (error) {
    return { env, argsFile, error };
  }
}

test("qwen_llama preserves requested per-parallel context while expanding backend context", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-pass-"));
  const modelPath = await createFakeGguf(tempDir, "Qwen3.6-test.gguf");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { argsFile, error } = await runLauncher(tempDir, modelPath, ["--ctx-size", "524288", "--parallel", "2"]);
  const backendArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));

  assert.deepEqual(
    backendArgs.slice(backendArgs.indexOf("--ctx-size"), backendArgs.indexOf("--parallel") + 2),
    ["--ctx-size", "1048576", "--parallel", "2"],
  );
  assert.match(error.stderr, /llama-server exited during startup/);
  assert.doesNotMatch(error.stderr, /Requested context size/);
});

test("qwen_llama keeps thinking disabled unless it is explicitly requested", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-thinking-"));
  const modelPath = await createFakeGguf(tempDir, "Qwen3.6-thinking.gguf");
  const grammarPath = path.join(tempDir, "tiny-grammar.gbnf");
  await fs.writeFile(grammarPath, "root ::= \"ok\"\n", "utf8");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { argsFile } = await runLauncher(
    tempDir,
    modelPath,
    ["--enable-tiny-grammar"],
    { QWEN_LLAMA_TINY_GRAMMAR_FILE: grammarPath },
  );
  const backendArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));
  const chatTemplateKwargsIndex = backendArgs.indexOf("--chat-template-kwargs");

  assert.equal(backendArgs[chatTemplateKwargsIndex + 1], "{\"enable_thinking\":false}");
});

test("qwen_llama applies the structured GBNF grammar file for Qwen 3.6 35B models", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-structured-"));
  const modelPath = await createFakeGguf(tempDir, "Qwen3.6-35B-A3B-structured.gguf");
  const grammarPath = path.join(tempDir, "structured-cot.gbnf");
  await fs.writeFile(grammarPath, "root ::= \"ok\"\n", "utf8");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { argsFile } = await runLauncher(
    tempDir,
    modelPath,
    ["--enable-structured-gbnf"],
    { QWEN_LLAMA_STRUCTURED_GBNF_FILE: grammarPath },
  );
  const backendArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));
  const grammarFileIndex = backendArgs.indexOf("--grammar-file");

  assert.notEqual(grammarFileIndex, -1);
  assert.equal(backendArgs[grammarFileIndex + 1], grammarPath);
});

test("qwen_llama defaults ubatch to 512 and honours an explicit --ubatch-size", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-ubatch-"));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });
  const modelPath = await createFakeGguf(tempDir, "Qwen3.6-test.gguf");

  // Unset: unchanged from the behaviour before ubatch became configurable.
  const base = await runLauncher(tempDir, modelPath, ["--ctx-size", "4096", "--parallel", "1"]);
  const baseArgs = JSON.parse(await fs.readFile(base.argsFile, "utf8"));
  assert.equal(baseArgs[baseArgs.indexOf("--ubatch-size") + 1], "512");

  // A large ubatch is a long non-preemptible Metal command buffer, so a second model
  // sharing the GPU stalls while it runs; the user needs to be able to lower it.
  const tuned = await runLauncher(tempDir, modelPath, ["--ctx-size", "4096", "--parallel", "1", "--ubatch-size", "128"]);
  const tunedArgs = JSON.parse(await fs.readFile(tuned.argsFile, "utf8"));
  assert.equal(tunedArgs[tunedArgs.indexOf("--ubatch-size") + 1], "128");
});

test("qwen_llama rejects a nonsense ubatch size instead of passing it through", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-ubatch-bad-"));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });
  const modelPath = await createFakeGguf(tempDir, "Qwen3.6-test.gguf");
  const { error } = await runLauncher(tempDir, modelPath, ["--ctx-size", "4096", "--ubatch-size", "0"]);
  assert.match(String(error.stderr || ""), /Invalid ubatch size/);
});

test("qwen_llama keeps requested MTP parallel values instead of forcing parallel=1", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-mtp-"));
  const modelPath = await createFakeGguf(tempDir, "Qwen3.6-mtp-test.gguf");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { argsFile, error } = await runLauncher(tempDir, modelPath, ["--parallel", "2"]);
  const backendArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));

  assert.equal(backendArgs[backendArgs.indexOf("--parallel") + 1], "2");
  assert.ok(backendArgs.includes("--spec-type"));
  assert.match(error.stderr, /llama-server exited during startup/);
  assert.doesNotMatch(error.stderr, /Requested parallel value/);
});

test("qwen_llama treats Gemma 4 target plus drafter metadata as MTP and applies safe draft length", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-gemma4-mtp-"));
  const { modelPath } = await createFakeGgufRepo(
    tempDir,
    "unsloth__gemma-4-31B-it-qat-GGUF",
    "gemma-4-31B-it-qat-UD-Q4_K_XL.gguf",
    {
      family: "Gemma 4",
      mtpDraftFile: "mtp-gemma-4-31B-it.gguf",
    },
  );

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { argsFile } = await runLauncher(tempDir, modelPath, []);
  const backendArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));

  assert.equal(backendArgs[backendArgs.indexOf("--spec-type") + 1], "draft-mtp");
  assert.equal(
    await fs.realpath(backendArgs[backendArgs.indexOf("--model-draft") + 1]),
    await fs.realpath(path.join(tempDir, "unsloth__gemma-4-31B-it-qat-GGUF", "mtp-gemma-4-31B-it.gguf")),
  );
  assert.equal(backendArgs[backendArgs.indexOf("--spec-draft-n-max") + 1], "2");
  assert.equal(backendArgs.includes("--spec-draft-p-min"), false);
});

test("qwen_llama fails unsupported tiny grammar requests instead of silently disabling them", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-grammar-"));
  const modelPath = await createFakeGguf(tempDir, "gemma4-test.gguf");
  const fakeServerPath = await createFakeLlamaServer(tempDir);

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await assert.rejects(
    execFileAsync(QWEN_LLAMA_PATH, [modelPath, "--enable-tiny-grammar"], {
      env: {
        ...process.env,
        // The launcher requires llama-server before it validates the grammar
        // flags, and the CI runner has none. The fake server exits at once.
        QWEN_LLAMA_SERVER: fakeServerPath,
        QWEN_LLAMA_UPSTREAM_SERVER: fakeServerPath,
        QWEN_LLAMA_MTP_SERVER: fakeServerPath,
        QWEN_LLAMA_POLL_SECONDS: "0.05",
        QWEN_LLAMA_STATE_DIR: path.join(tempDir, "state"),
        // See runLauncher: without these the launcher targets slot1's real ports.
        QWEN_LLAMA_PORT: "9731",
        QWEN_LLAMA_BACKEND_PORT: "19731",
      },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Tiny Grammar is not supported for gemma4-test/);
      return true;
    },
  );
});

test("qwen_llama fails unsupported structured GBNF requests instead of silently disabling them", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-structured-unsupported-"));
  const modelPath = await createFakeGguf(tempDir, "gemma4-test.gguf");
  const fakeServerPath = await createFakeLlamaServer(tempDir);

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await assert.rejects(
    execFileAsync(QWEN_LLAMA_PATH, [modelPath, "--enable-structured-gbnf"], {
      env: {
        ...process.env,
        // The launcher requires llama-server before it validates the grammar
        // flags, and the CI runner has none. The fake server exits at once.
        QWEN_LLAMA_SERVER: fakeServerPath,
        QWEN_LLAMA_UPSTREAM_SERVER: fakeServerPath,
        QWEN_LLAMA_MTP_SERVER: fakeServerPath,
        QWEN_LLAMA_POLL_SECONDS: "0.05",
        QWEN_LLAMA_STATE_DIR: path.join(tempDir, "state"),
        // See runLauncher: without these the launcher targets slot1's real ports.
        QWEN_LLAMA_PORT: "9731",
        QWEN_LLAMA_BACKEND_PORT: "19731",
      },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Structured GBNF is only supported/);
      return true;
    },
  );
});

test("qwen_llama prefers the llama.cpp Gemma 4 interleaved template and skips Qwen kwargs for Gemma 4 metadata", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-gemma4-template-"));
  const { modelPath } = await createFakeGgufRepo(
    tempDir,
    "ironbcc__gemma-4-26B-A4B-it-MTP-GGUF",
    "gemma-4-26B-A4B-it-Q8_0.gguf",
    {
      family: "Gemma",
      chatTemplateFile: ".llm3-chat-template.jinja",
      chatTemplateContent: "{# downloaded template #}\n{{ bos_token }}",
    },
  );
  const { sourceDir, templatePath } = await createFakeLlamaSource(tempDir);

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { argsFile } = await runLauncher(tempDir, modelPath, [], {
    QWEN_LLAMA_SOURCE_DIR: sourceDir,
  });
  const backendArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));
  const chatTemplateFileIndex = backendArgs.indexOf("--chat-template-file");

  assert.notEqual(chatTemplateFileIndex, -1);
  assert.equal(backendArgs[chatTemplateFileIndex + 1], templatePath);
  assert.equal(backendArgs.includes("--chat-template-kwargs"), false);
});

test("qwen_llama caps Gemma 4 context per request and defaults Gemma KV cache to q8_0", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-gemma4-memory-"));
  const { modelPath } = await createFakeGgufRepo(
    tempDir,
    "unsloth__gemma-4-31B-it-GGUF",
    "gemma-4-31B-it-UD-Q6_K_XL.gguf",
    {
      family: "Gemma",
    },
  );

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { argsFile, error } = await runLauncher(tempDir, modelPath, ["--ctx-size", "524288", "--parallel", "2"]);
  const backendArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));

  // The cap is per parallel slot, like --ctx-size itself: 262144 per request,
  // so the backend gets 262144 x 2. It used to be divided by the parallel
  // count, which turned this same request into 131072 per slot.
  assert.deepEqual(
    backendArgs.slice(backendArgs.indexOf("--ctx-size"), backendArgs.indexOf("--parallel") + 2),
    ["--ctx-size", "524288", "--parallel", "2"],
  );
  assert.equal(backendArgs[backendArgs.indexOf("--cache-type-k") + 1], "q8_0");
  assert.equal(backendArgs[backendArgs.indexOf("--cache-type-v") + 1], "q8_0");
  assert.match(error.stderr, /Requested context size 524288 exceeds the Gemma 4 per-request cap 262144/);
});

test("qwen_llama --chat-template-file overrides the template declared in .llm3-hf.json", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-template-"));
  const { modelPath } = await createFakeGgufRepo(tempDir, "Qwen3.8-27B-GGUF", "Qwen3.8-27B-UD-Q4_K_XL.gguf", {
    chatTemplateFile: ".llm3-chat-template.jinja",
    chatTemplateContent: "{# repo template #}",
  });
  const overridePath = path.join(tempDir, "qwen-sharp.jinja");
  await fs.writeFile(overridePath, "{# sharp template #}", "utf8");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { argsFile } = await runLauncher(tempDir, modelPath, ["--chat-template-file", overridePath]);
  const backendArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));
  const index = backendArgs.indexOf("--chat-template-file");

  assert.notEqual(index, -1);
  assert.equal(backendArgs[index + 1], overridePath);
  // The override must win: the metadata template is loaded after argument parsing.
  assert.equal(backendArgs.filter((value) => value === "--chat-template-file").length, 1);
});

test("qwen_llama still uses the model's own template when no override is passed", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-template-default-"));
  const { repoDir, modelPath } = await createFakeGgufRepo(tempDir, "Qwen3.8-27B-GGUF", "Qwen3.8-27B-UD-Q4_K_XL.gguf", {
    chatTemplateFile: ".llm3-chat-template.jinja",
    chatTemplateContent: "{# repo template #}",
  });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { argsFile } = await runLauncher(tempDir, modelPath, []);
  const backendArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));
  const index = backendArgs.indexOf("--chat-template-file");

  assert.notEqual(index, -1);
  // realpath: the launcher resolves the path, and macOS temp dirs live under /private.
  assert.equal(backendArgs[index + 1], await fs.realpath(path.join(repoDir, ".llm3-chat-template.jinja")));
});

test("qwen_llama ignores a --chat-template-file that does not exist", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-qwen-llama-template-missing-"));
  const { repoDir, modelPath } = await createFakeGgufRepo(tempDir, "Qwen3.8-27B-GGUF", "Qwen3.8-27B-UD-Q4_K_XL.gguf", {
    chatTemplateFile: ".llm3-chat-template.jinja",
    chatTemplateContent: "{# repo template #}",
  });

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { argsFile } = await runLauncher(
    tempDir,
    modelPath,
    ["--chat-template-file", path.join(tempDir, "nope.jinja")],
  );
  const backendArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));
  const index = backendArgs.indexOf("--chat-template-file");

  // Falls back to the model's own template rather than pointing llama.cpp at nothing.
  assert.equal(backendArgs[index + 1], await fs.realpath(path.join(repoDir, ".llm3-chat-template.jinja")));
});
