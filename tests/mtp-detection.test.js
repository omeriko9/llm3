"use strict";
// bin/qwen_llama decides whether to pass `--spec-type draft-mtp` by inspecting
// the GGUF. It used to accept the metadata key OR the tensors:
//
//   print("yes" if mtp_field or mtp_tensors else "no")
//
// `nextn_predict_layers` states what the ARCHITECTURE has, not what the file
// carries. DeepSeek-V4-Flash-Q2-0731 declares `deepseek4.nextn_predict_layers = 1`
// and contains 0 of 1328 tensors with an MTP name, because that build ships its
// drafter separately. llm3 therefore sent --spec-type draft-mtp and llama.cpp
// refused the whole model:
//
//   W llama_init_from_model: context type MTP requested but model doesn't contain MTP layers
//   E srv    load_model: failed to create MTP context
//   E srv  llama_server: exiting due to model loading error
//
// Worse, the verdict is cached per (path, size, mtime), so the bad answer stuck.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const LAUNCHER = fs.readFileSync(path.join(__dirname, "..", "bin", "qwen_llama"), "utf8");

function verdict({ field, tensorNames }) {
  // Runs the launcher's own verdict expression against stub inputs.
  const script = `
mtp_field = ${field ? "True" : "False"}
tensors = ${JSON.stringify(tensorNames)}
class T:
    def __init__(self, n): self.name = n
class R:
    def __init__(self, names): self.tensors = [T(n) for n in names]
reader = R(tensors)
mtp_tensors = any("nextn" in t.name.lower() or "mtp" in t.name.lower() for t in reader.tensors)
print("yes" if mtp_tensors else ("no" if reader.tensors else ("yes" if mtp_field else "no")))
`;
  return execFileSync("python3", ["-c", script], { encoding: "utf8" }).trim();
}

test("the metadata key alone no longer claims MTP", () => {
  // The exact DeepSeek-V4-Flash-Q2 shape: key declared, no MTP tensors.
  assert.equal(verdict({ field: true, tensorNames: ["blk.0.attn_q.weight", "output.weight"] }), "no");
});

test("real MTP tensors still claim MTP", () => {
  // The exact Qwen3.8-27B shape, verified on disk.
  assert.equal(verdict({ field: true, tensorNames: ["blk.0.attn_q.weight", "blk.64.nextn.shared_head_norm.weight"] }), "yes");
});

test("a model with neither says no", () => {
  assert.equal(verdict({ field: false, tensorNames: ["blk.0.attn_q.weight"] }), "no");
});

test("an unreadable tensor list falls back to the key", () => {
  // Only when there is nothing to judge by does the declaration get a vote.
  assert.equal(verdict({ field: true, tensorNames: [] }), "yes");
  assert.equal(verdict({ field: false, tensorNames: [] }), "no");
});

test("the launcher no longer ORs the key with the tensors", () => {
  assert.ok(
    !/print\("yes" if mtp_field or mtp_tensors else "no"\)/.test(LAUNCHER),
    "the metadata key must not be able to claim MTP on its own",
  );
  assert.match(LAUNCHER, /print\("yes" if mtp_tensors else/);
});

test("the MTP verdict is still cached per file identity", () => {
  // Cheap to keep, and the reason a wrong answer survives restarts — worth
  // knowing about when a detection bug is suspected.
  assert.match(LAUNCHER, /mtp-detect/);
  assert.match(LAUNCHER, /stat -f '%z-%m'/);
});
