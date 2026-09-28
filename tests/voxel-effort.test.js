"use strict";
// Scene runs: how a thinking level reaches the slot launch, and how clearing
// scene results removes exactly the cells asked for.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Isolated before voxel-test is required: it reads its state and the active
// profile at import time, and posts launches to 127.0.0.1:<PORT>.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm3-voxel-effort-"));
process.env.LLM3_VOXEL_ROOT = path.join(root, "voxel");
process.env.LLM3_STATE_DIR = path.join(root, "state");
process.env.PORT = process.env.LLM3_TEST_PORT || "9738";
process.env.XDG_STATE_HOME = path.join(root, "xdg");
const voxel = require("../src/voxel-test.js");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("a thinking level becomes a GGUF budget and an MLX effort; off is sent as off", async () => {
  const { resolveSlotParams } = voxel._test;
  const high = await resolveSlotParams("slot3", true, "high");
  assert.equal(high.thinking, true);
  assert.equal(high.reasoningBudget, voxel.EFFORT_REASONING_BUDGET.high);
  assert.equal(high.reasoningEffort, "xhigh", "Qwen3.8's template has no \"high\"");
  assert.equal(high.thinkingEffort, "high");

  const unspecified = await resolveSlotParams("slot3", true);
  assert.equal(unspecified.thinkingEffort, "medium", "thinking on with no level means the default level");
  assert.equal(unspecified.reasoningBudget, 8192);

  const off = await resolveSlotParams("slot3", false, "high");
  assert.equal(off.thinking, false);
  assert.equal(off.reasoningEffort, "off", "an MLX slot must not keep a saved effort on a no-think run");
  assert.equal(off.thinkingEffort, null);

  const inherit = await resolveSlotParams("slot3", undefined);
  assert.equal(inherit.reasoningEffort, undefined, "no override leaves the slot's own setting alone");
});

test("clearSceneResults removes only the matching test, model and bucket", async () => {
  const indexPath = path.join(process.env.LLM3_VOXEL_ROOT, "results-index.json");
  fs.mkdirSync(process.env.LLM3_VOXEL_ROOT, { recursive: true });
  const cell = (status) => ({ status, file: "x.html", runtimeErrors: [] });
  fs.writeFileSync(indexPath, JSON.stringify({
    voxel: {
      A: { "no-think": cell("done"), think: cell("done") },
      B: { "no-think": cell("done") },
    },
    pixel: { A: { "no-think": cell("failed") } },
  }));
  assert.equal(await voxel.countSceneResults({ tests: ["voxel"], models: ["A"], buckets: ["think"] }), 1);
  const removed = await voxel.clearSceneResults({ tests: ["voxel"], models: ["A"], buckets: ["think"] });
  assert.equal(removed, 1);
  const index = await voxel.readSceneIndex();
  assert.deepEqual(Object.keys(index.voxel.A), ["no-think"]);
  assert.ok(index.voxel.B["no-think"]);
  assert.ok(index.pixel.A["no-think"]);

  assert.equal(await voxel.clearSceneResults({}), 3, "an empty filter clears everything");
  assert.equal(await voxel.countSceneResults({}), 0);
});

test("ds4 and sushi slots get thinking per request; other launchers do not", () => {
  const { perRequestThinkingFields } = voxel;
  assert.deepEqual(perRequestThinkingFields("slot3", { thinking: false }), {}, "no ds4/sushi state: request unchanged");

  const stateFile = path.join(root, "xdg", "ds4", "slot3", "current.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{}");
  assert.deepEqual(perRequestThinkingFields("slot3", { thinking: false }), {
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: "none",
  });
  assert.deepEqual(perRequestThinkingFields("slot3", { thinking: true, thinkingEffort: "low" }), {
    chat_template_kwargs: { enable_thinking: true },
    reasoning_effort: "low",
  });
  fs.rmSync(stateFile);
});

test("the scene sends the loaded model's id, not the first one listed", () => {
  const { pickLoadedModelId } = voxel;
  const listed = [{ id: "k2-fsa/OmniVoice" }, { id: "/m/Mage-VL" }, { id: "other" }];
  assert.equal(pickLoadedModelId(listed, "/m/Mage-VL"), "/m/Mage-VL");
  assert.equal(pickLoadedModelId([{ id: "x/omni" }, { id: "mage-vl" }], "/m/Mage-VL/"), "mage-vl");
  assert.equal(pickLoadedModelId([{ id: "qwen3.8-flash-next" }], "/m/pack.gguf"), "qwen3.8-flash-next", "one listed id: use it");
});
