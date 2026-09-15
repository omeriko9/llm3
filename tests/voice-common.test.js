"use strict";
// src/llm3_voice_common.py carries the load-once / inference-lock / size-cap
// guards shared by the voice servers. It depends on the standard library only,
// so its self-test runs on the system python3 without any voice venv.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const MODULE = path.join(__dirname, "..", "src", "llm3_voice_common.py");

test("llm3_voice_common self-test passes", async () => {
  const { stdout } = await execFileAsync("python3", [MODULE, "--selftest"], { timeout: 30000 });
  assert.match(stdout, /selftest: ok/);
});

test("every voice server imports the shared guards", async () => {
  const fs = require("node:fs/promises");
  for (const name of ["kokoro_api_server.py", "omnivoice_api_server.py", "vibevoice_api_server.py", "voice-stt-server.py"]) {
    const source = await fs.readFile(path.join(__dirname, "..", "src", name), "utf8");
    assert.match(source, /from llm3_voice_common import/, name);
    assert.match(source, /INFERENCE_LOCK/, name);
    assert.match(source, /limit_request_size\(/, name);
  }
});
