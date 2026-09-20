"use strict";
// src/mlx-dspark-shim.py against a false mlx_dspark package. The point of the
// shim is that an mlx-dspark update can never break a slot: it must install
// itself only when every name it touches is where it expects, stand down when
// upstream gains the function, and in every case let the server start.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const SHIM = path.join(__dirname, "..", "src", "mlx-dspark-shim.py");

const GENERATE = (dflashParams, firstToken) => `
from dataclasses import dataclass

@dataclass
class GenResult:
    text: str = ""
    logprobs: list = None

class Row:
    def __getitem__(self, _key):
        return self

def _pick(logits_row, temperature=0.0, top_p=1.0, top_k=0):
    return 7

def _logprobs_for_block(rows, token_ids, top_k):
    return [{"token_id": token_ids[0], "logprob": -0.1, "top": [(7, -0.1)][:top_k]}]

def dflash_generate(target, ${dflashParams}):
    ${firstToken}
    return GenResult(text="x")
`;

// The second _pick is a later token: it must not replace the first entry.
const FIRST_TOKEN = "token = _pick(Row())\n    _pick(Row())";

const SERVER = `
from .generate import dflash_generate

class Engine:
    def _generate_impl_inner(self, prompt_ids, max_tokens, logprobs=None):
        return dflash_generate("target")
`;

const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("shim", sys.argv[1])
shim = importlib.util.module_from_spec(spec); spec.loader.exec_module(shim)
status = shim.prepare()
import mlx_dspark.server as server
engine = server.Engine()
asked = engine._generate_impl_inner([1], 1, logprobs=5)
plain = engine._generate_impl_inner([1], 1)
print(json.dumps({"status": status, "asked": asked.logprobs, "plain": plain.logprobs}))
`;

async function run(t, { dflashParams = "max_new_tokens=1", firstToken = FIRST_TOKEN, env = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-shim-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, "mlx_dspark");
  await fs.mkdir(pkg);
  await fs.writeFile(path.join(pkg, "__init__.py"), "");
  await fs.writeFile(path.join(pkg, "generate.py"), GENERATE(dflashParams, firstToken));
  await fs.writeFile(path.join(pkg, "server.py"), SERVER);
  const statusFile = path.join(dir, "status.json");
  const { stdout, stderr } = await execFileAsync("python3", ["-c", DRIVER, SHIM], {
    env: { PATH: process.env.PATH, PYTHONPATH: dir, LLM3_DSPARK_SHIM_STATUS_FILE: statusFile, ...env },
  });
  const written = JSON.parse(await fs.readFile(statusFile, "utf8"));
  return { ...JSON.parse(stdout.trim().split("\n").pop()), stderr, written };
}

test("active: the first token gets logprobs, and only when the request asked for them", async (t) => {
  const out = await run(t);
  assert.equal(out.status, "active");
  assert.equal(out.asked.length, 1);
  assert.equal(out.asked[0].token_id, 7);
  assert.equal(out.plain, null);
  assert.match(out.stderr, /\[llm3-shim\] active/);
  assert.equal(out.written.status, "active");
  assert.equal(out.written.shimVersion, 1);
});

test("native: upstream dflash_generate accepts logprobs, so the shim changes nothing", async (t) => {
  const out = await run(t, { dflashParams: "max_new_tokens=1, logprobs=None" });
  assert.equal(out.status, "native");
  assert.equal(out.asked, null);
  assert.match(out.stderr, /upstream supports it/);
});

test("incompatible: a moved name leaves the package as it is and the server still starts", async (t) => {
  const out = await run(t, { firstToken: "token = 7" });
  assert.equal(out.status, "incompatible");
  assert.equal(out.asked, null);
  assert.match(out.written.reason, /_pick/);
});

test("disabled: LLM3_DSPARK_SHIM=0", async (t) => {
  const out = await run(t, { env: { LLM3_DSPARK_SHIM: "0" } });
  assert.equal(out.status, "disabled");
  assert.equal(out.asked, null);
});
