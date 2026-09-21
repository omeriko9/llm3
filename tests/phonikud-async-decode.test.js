"use strict";
// The Python checks of the async-decode changes need torch, chatterbox and the model on
// the device, so they run in the TTS venv (tests/python/test_phonikud_async_decode.py).
// Here: the venv is used when it exists, and the test is skipped when it does not, so
// `npm test` on a machine without the runtime still passes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const VENV_PYTHON = path.join(os.homedir(), "venvs", "phonikud-upstream-torch214", "bin", "python");
const CHECK = path.join(__dirname, "python", "test_phonikud_async_decode.py");

test("phonikud async decode: same tokens, same waveform, faster", { skip: !fs.existsSync(VENV_PYTHON) && "no TTS venv" }, async () => {
  const { stdout } = await execFileAsync(VENV_PYTHON, ["-m", "pytest", CHECK, "-q", "-p", "no:cacheprovider"], {
    timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONWARNINGS: "ignore" },
  });
  assert.match(stdout, /passed/);
  assert.doesNotMatch(stdout, /failed|error/i);
});
