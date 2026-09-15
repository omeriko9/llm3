const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
// NB: temp dirs must not contain "mtp" -- the launcher's name fallback searches
// the model's full path, so a "llm3-mtp-*" temp dir would look MTP-named.
const QWEN_LLAMA_PATH = path.join(__dirname, "..", "bin", "qwen_llama");

// A stand-in for llama.cpp's gguf-py. The real reader costs ~4.5s on a 16GB
// model; here the "GGUF" is a text file whose first line names its tensors, so
// the launcher's detection wiring can be tested without real weights.
async function createStubGgufPy(rootDir) {
  const sourceDir = path.join(rootDir, "fake-llama.cpp");
  const packageDir = path.join(sourceDir, "gguf-py", "gguf");
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "__init__.py"),
    `class _Tensor:
    def __init__(self, name):
        self.name = name


class GGUFReader:
    def __init__(self, path):
        with open(path, "r", encoding="utf-8") as handle:
            head = handle.readline().strip()
        if head == "UNREADABLE":
            raise ValueError("not a gguf")
        self.fields = []
        self.tensors = [_Tensor(name) for name in head.split(",") if name]
`,
    "utf8",
  );
  return sourceDir;
}

// Each model gets its own directory: find_mtp_draft() scans the model's folder
// for a separate drafter, so an unrelated *-MTP-*.gguf sibling would be adopted.
let modelSeq = 0;
async function createModel(rootDir, name, tensorLine) {
  modelSeq += 1;
  const modelDir = path.join(rootDir, `model-${modelSeq}`);
  await fs.mkdir(modelDir, { recursive: true });
  const modelPath = path.join(modelDir, name);
  await fs.writeFile(modelPath, `${tensorLine}\n`, "utf8");
  return modelPath;
}

async function createFakeLlamaServer(rootDir, { supportsMtp = true } = {}) {
  const serverPath = path.join(rootDir, "fake-llama-server.js");
  const help = supportsMtp
    ? "--spec-type [none|draft-simple|draft-mtp|draft-dflash]\\n--spec-draft-p-min\\n--reasoning\\n"
    : "--spec-draft-p-min\\n--reasoning\\n";
  await fs.writeFile(
    serverPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--help") {
  process.stdout.write("${help}");
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

async function runLauncher(tempDir, modelPath, { supportsMtp = true, stateRoot = "" } = {}) {
  const argsFile = path.join(tempDir, "backend-args.json");
  await fs.rm(argsFile, { force: true });
  const sourceDir = await createStubGgufPy(tempDir);
  const serverPath = await createFakeLlamaServer(tempDir, { supportsMtp });
  const root = stateRoot || path.join(tempDir, "state");

  const env = {
    ...process.env,
    QWEN_LLAMA_POLL_SECONDS: "0.05",
    QWEN_LLAMA_STATE_ROOT: root,
    QWEN_LLAMA_STATE_DIR: path.join(root, "slotX"),
    // kill_known_listener in stop_previous_server kills whatever LISTENS on these,
    // so they must never be allowed to default to a real slot's ports.
    QWEN_LLAMA_PORT: "9732",
    QWEN_LLAMA_BACKEND_PORT: "19732",
    QWEN_LLAMA_SOURCE_DIR: sourceDir,
    QWEN_LLAMA_SERVER: serverPath,
    QWEN_LLAMA_UPSTREAM_SERVER: serverPath,
    QWEN_LLAMA_MTP_SERVER: serverPath,
    QWEN_LLAMA_HOST: "127.0.0.1",
    QWEN_LLAMA_BACKEND_HOST: "127.0.0.1",
    FAKE_LLAMA_ARGS_FILE: argsFile,
  };

  let stderr = "";
  try {
    await execFileAsync(QWEN_LLAMA_PATH, [modelPath, "--ctx-size", "131072"], { env });
  } catch (error) {
    stderr = String(error?.stderr || "");
  }

  let backendArgs = null;
  try {
    backendArgs = JSON.parse(await fs.readFile(argsFile, "utf8"));
  } catch (_error) {
    backendArgs = null;
  }
  return { backendArgs, stderr, stateRoot: root };
}

function flagValue(args, flag) {
  const index = Array.isArray(args) ? args.indexOf(flag) : -1;
  return index === -1 ? null : args[index + 1];
}

test("a GGUF with an embedded MTP head gets --spec-type even with no \"MTP\" in its name", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-spec-embedded-"));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  // This is what Qwen3.8 looks like: nextn tensors, nothing in the file name.
  const modelPath = await createModel(tempDir, "Qwen3.8-27B-UD-Q4_K_XL.gguf", "blk.64.nextn.eh_proj.weight,blk.64.nextn.enorm.weight");
  const { backendArgs } = await runLauncher(tempDir, modelPath);

  assert.equal(flagValue(backendArgs, "--spec-type"), "draft-mtp");
  // Depth 1, not the global default of 2: on this dense hybrid-SSM arch each
  // extra draft step costs ~13 ms against a ~62 ms target pass, so deeper
  // drafting loses. Measured on M4 Max, Qwen3.8-27B-UD-Q8_K_L, no-think:
  // n-max 1 -> 23.5 tok/s, 2 -> 22.6, 3 -> 18.3, 4 -> 14.6.
  assert.equal(flagValue(backendArgs, "--spec-draft-n-max"), "1");
  // The head is inside the weights, so there is no separate drafter to pass.
  assert.equal(flagValue(backendArgs, "--model-draft"), null);
});

test("a GGUF with no MTP tensors gets no speculative flags", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-spec-none-"));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  const modelPath = await createModel(tempDir, "Qwen3.6-35B-A3B-APEX.gguf", "blk.0.attn_q.weight,blk.0.ffn_up.weight");
  const { backendArgs } = await runLauncher(tempDir, modelPath);

  assert.equal(flagValue(backendArgs, "--spec-type"), null);
  assert.equal(flagValue(backendArgs, "--spec-draft-n-max"), null);
});

test("the GGUF outranks the file name when the two disagree", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-spec-conflict-"));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  // Named MTP, but carries no nextn tensors -- the weights win.
  const modelPath = await createModel(tempDir, "Something-MTP-Q8_0.gguf", "blk.0.attn_q.weight");
  const { backendArgs } = await runLauncher(tempDir, modelPath);

  assert.equal(flagValue(backendArgs, "--spec-type"), null);
});

test("an unreadable GGUF falls back to the file name", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-spec-unreadable-"));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  const named = await createModel(tempDir, "Qwen3.6-35BA3B-MTP.gguf", "UNREADABLE");
  assert.equal(flagValue((await runLauncher(tempDir, named)).backendArgs, "--spec-type"), "draft-mtp");

  const plain = await createModel(tempDir, "Qwen3.6-35B-plain.gguf", "UNREADABLE");
  assert.equal(flagValue((await runLauncher(tempDir, plain)).backendArgs, "--spec-type"), null);
});

test("the detection verdict is cached so the GGUF is only read once", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-spec-cache-"));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  const modelPath = await createModel(tempDir, "Qwen3.8-27B.gguf", "blk.64.nextn.eh_proj.weight");
  const { stateRoot } = await runLauncher(tempDir, modelPath);

  const cached = await fs.readdir(path.join(stateRoot, "mtp-detect"));
  assert.equal(cached.length, 1, "one cache entry per model file");
  assert.equal(await fs.readFile(path.join(stateRoot, "mtp-detect", cached[0]), "utf8"), "yes");

  // Second launch reuses it and still passes the flags.
  const again = await runLauncher(tempDir, modelPath, { stateRoot });
  assert.equal(flagValue(again.backendArgs, "--spec-type"), "draft-mtp");
  assert.deepEqual(await fs.readdir(path.join(stateRoot, "mtp-detect")), cached);
});

test("an embedded head launches without MTP rather than failing on a server that lacks it", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-spec-degrade-"));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  const modelPath = await createModel(tempDir, "Qwen3.8-27B.gguf", "blk.64.nextn.eh_proj.weight");
  const { backendArgs, stderr } = await runLauncher(tempDir, modelPath, { supportsMtp: false });

  // Detecting a head must never turn a model that used to launch into one that cannot.
  assert.notEqual(backendArgs, null, "the launcher should still have started the backend");
  assert.equal(flagValue(backendArgs, "--spec-type"), null);
  assert.match(stderr, /embeds an MTP head but .* does not advertise MTP support/);
});

// ---- vision projector discovery -------------------------------------------

test("the launcher passes --mmproj for a projector named <model>-vision-f16.gguf", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-spec-vision-"));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  const modelPath = await createModel(tempDir, "Qwen3.8-27B-Uncensored-Q8_0.gguf", "blk.64.nextn.eh_proj.weight");
  const projectorPath = path.join(path.dirname(modelPath), "Qwen3.8-27B-Uncensored-vision-f16.gguf");
  await fs.writeFile(projectorPath, "projector\n", "utf8");

  const { backendArgs } = await runLauncher(tempDir, modelPath);
  // realpath: the launcher resolves paths, and macOS temp dirs live under /private.
  assert.equal(flagValue(backendArgs, "--mmproj"), await fs.realpath(projectorPath));
});

test("the launcher still prefers a classically named mmproj", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-spec-mmproj-"));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  const modelPath = await createModel(tempDir, "Qwen3.8-27B.gguf", "blk.64.nextn.eh_proj.weight");
  const projectorPath = path.join(path.dirname(modelPath), "mmproj-BF16.gguf");
  await fs.writeFile(projectorPath, "projector\n", "utf8");

  const { backendArgs } = await runLauncher(tempDir, modelPath);
  assert.equal(flagValue(backendArgs, "--mmproj"), await fs.realpath(projectorPath));
});

test("a model with no projector gets no --mmproj", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-spec-novision-"));
  t.after(async () => { await fs.rm(tempDir, { recursive: true, force: true }); });

  const modelPath = await createModel(tempDir, "Qwen3.8-27B.gguf", "blk.64.nextn.eh_proj.weight");
  const { backendArgs } = await runLauncher(tempDir, modelPath);
  assert.equal(flagValue(backendArgs, "--mmproj"), null);
});
