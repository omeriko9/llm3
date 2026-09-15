"use strict";
// The control contract every launcher in bin/ must honour, because
// src/server.js calls each one the same way:
//   <launcher> --slot slotN --status-json    -> JSON with a boolean "running"
//   <launcher> --slot slotN --defaults-json  -> JSON object
//   <launcher> --list-json                   -> JSON array   (model launchers)
// All of these must work on a machine that has no model weights and no Python
// venv, because the dashboard polls status and defaults before anything is
// installed. Each launcher runs under a temporary HOME so nothing it writes
// lands in the real state directory.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const BIN = path.join(__dirname, "..", "bin");

const MODEL_LAUNCHERS = [
  "qwen_llama",
  "qwen_llama_beellama",
  "qwen_llama_tq3",
  "run-gpt-oss-turboquant-api.sh",
  "run-mlx-dspark-api.sh",
  "run-mlx-vlm-api.sh",
  "run-ds4-api.sh",
  "run-optiq-api.sh",
  "run-qwen36-dflash-api.sh",
  "run-qwen36-mlx-api.sh",
  "run-qwen36-mtplx-api.sh",
  "run-qwen36-rapid-mlx-api.sh",
];
const VOICE_LAUNCHERS = ["voice-tts.sh", "voice-stt.sh"];
// --list-json is a model-launcher mode; these launchers list through the
// server's own model scan instead (ds4 among them: its pack is discovered as a
// GGUF repo directory like any other).
const NO_LIST_JSON = new Set(["run-mlx-dspark-api.sh", "run-mlx-vlm-api.sh", "run-ds4-api.sh"]);

let tempHome;
test.before(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-launcher-contract-"));
  await fs.mkdir(path.join(tempHome, "state"), { recursive: true });
});
test.after(async () => {
  await fs.rm(tempHome, { recursive: true, force: true });
});

function run(launcher, args) {
  return execFileAsync(path.join(BIN, launcher), args, {
    env: {
      PATH: process.env.PATH,
      HOME: tempHome,
      XDG_STATE_HOME: path.join(tempHome, "state"),
      LLM3_MODELS_DIR: path.join(tempHome, "models"),
      LLM3_VENV_ROOT: path.join(tempHome, "venvs"),
    },
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

for (const launcher of [...MODEL_LAUNCHERS, ...VOICE_LAUNCHERS]) {
  test(`${launcher}: --status-json reports not running under a fresh home`, async () => {
    const { stdout } = await run(launcher, ["--slot", "slot2", "--status-json"]);
    const payload = JSON.parse(stdout);
    assert.equal(payload.running, false, stdout);
  });

  test(`${launcher}: --defaults-json returns a JSON object`, async () => {
    const { stdout } = await run(launcher, ["--slot", "slot2", "--defaults-json"]);
    const payload = JSON.parse(stdout);
    assert.equal(typeof payload, "object");
    assert.ok(payload && !Array.isArray(payload), stdout);
  });
}

for (const launcher of MODEL_LAUNCHERS.filter((name) => !NO_LIST_JSON.has(name))) {
  test(`${launcher}: --list-json returns a JSON array`, async () => {
    const { stdout } = await run(launcher, ["--list-json"]);
    assert.ok(Array.isArray(JSON.parse(stdout)), stdout);
  });
}
