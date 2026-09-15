// llm3 resolves one "vision target" per launch (enrichSyncTargetWithVision) and hands
// every app the same three fields. The contract is stated on that function:
//
//   visionModelId falls back to the launched model when NO slot serves vision, and
//   "consumers must not treat that as vision".
//
// Three consumers ignored it: Hermes rewrote auxiliary.vision unconditionally,
// LibreChat hardcoded `vision: True`, and the remote JSON app never received the vision
// fields at all so it always repointed its vision entry at the launched model.
// The effect was a harness told a text-only model could read images -- requests then
// succeed and return nonsense instead of failing honestly.
const test = require("node:test");
const assert = require("node:assert/strict");
const yaml = require("js-yaml");
const {
  applyHermesPcConfig,
  buildLibreChatSyncRemoteScript,
  buildRemoteJsonAppSyncScript,
} = require("../src/server.js");

const BASE = {
  modelId: "TextOnly-27B",
  runtimeBaseUrl: "http://192.0.2.10:8037/v1",
  contextLength: 262144,
  apiKey: "api",
};
// The launched model carries its own projector.
const SELF_VISION = { ...BASE, hasVisionTarget: true, supportsVision: true, visionModelId: "Qwen-VL", visionRuntimeBaseUrl: "http://192.0.2.10:8037/v1" };
// Launched model is text-only; a different slot serves images.
const VISION_ELSEWHERE = { ...BASE, hasVisionTarget: true, supportsVision: false, visionModelId: "Mage-VL", visionRuntimeBaseUrl: "http://192.0.2.10:8038/v1" };
// Nothing anywhere can serve images; the vision* fields fall back to the main model.
const NO_VISION = { ...BASE, hasVisionTarget: false, supportsVision: false, visionModelId: "TextOnly-27B", visionRuntimeBaseUrl: "http://192.0.2.10:8037/v1" };

const HERMES_YAML = yaml.dump({
  model: { model: "OLD", base_url: "http://old", context_length: 262144 },
  auxiliary: { vision: { provider: "custom", model: "PREEXISTING-VL", base_url: "http://old-vision", api_key: "api" } },
});

test("Hermes points auxiliary.vision at whichever slot serves images", () => {
  const own = yaml.load(applyHermesPcConfig(HERMES_YAML, SELF_VISION));
  assert.equal(own.auxiliary.vision.model, "Qwen-VL");
  assert.equal(own.auxiliary.vision.base_url, "http://192.0.2.10:8037/v1");

  const elsewhere = yaml.load(applyHermesPcConfig(HERMES_YAML, VISION_ELSEWHERE));
  assert.equal(elsewhere.auxiliary.vision.model, "Mage-VL");
  assert.equal(elsewhere.auxiliary.vision.base_url, "http://192.0.2.10:8038/v1");
});

test("Hermes never relabels a text-only model as the vision model", () => {
  const updated = yaml.load(applyHermesPcConfig(HERMES_YAML, NO_VISION));
  // Left as it was, rather than overwritten with TextOnly-27B: a stale pointer is
  // recoverable, silently mislabelling the text model is not.
  assert.equal(updated.auxiliary.vision.model, "PREEXISTING-VL");
  assert.notEqual(updated.auxiliary.vision.model, NO_VISION.modelId);
  // The main model is still updated normally.
  assert.equal(updated.model.model, "TextOnly-27B");
});

// The builder returns an outer bash wrapper that carries the real script as
// SCRIPT_BASE64, so the Python has to be decoded before it can be asserted on.
function libreChatInnerScript(target) {
  const outer = buildLibreChatSyncRemoteScript(target);
  return Buffer.from(outer.match(/SCRIPT_BASE64='([^']+)'/)[1], "base64").toString("utf8");
}

test("Hermes still honours a hand-built target that omits hasVisionTarget", () => {
  // Production targets always come from enrichSyncTargetWithVision, which sets the
  // flag. A caller that supplies a *distinct* vision model without it still clearly
  // means vision, and the no-vision case cannot reach here because enrich makes
  // visionModelId equal to modelId then.
  const noFlag = { ...BASE, visionModelId: "Mage-VL", visionRuntimeBaseUrl: "http://192.0.2.10:8038/v1" };
  const updated = yaml.load(applyHermesPcConfig(HERMES_YAML, noFlag));
  assert.equal(updated.auxiliary.vision.model, "Mage-VL");

  // ...but the same shape with vision == main model is the no-vision fallback and
  // must still be refused.
  const sameModel = { ...BASE, visionModelId: BASE.modelId, visionRuntimeBaseUrl: BASE.runtimeBaseUrl };
  assert.equal(yaml.load(applyHermesPcConfig(HERMES_YAML, sameModel)).auxiliary.vision.model, "PREEXISTING-VL");
});

test("LibreChat advertises vision from the target, not unconditionally", () => {
  for (const target of [SELF_VISION, VISION_ELSEWHERE, NO_VISION]) {
    const inner = libreChatInnerScript(target);
    assert.ok(!inner.includes("entry['vision'] = True"), "vision must not be hardcoded True");
    assert.match(inner, /entry\['vision'\] = bool\(payload\.get\('hasVisionTarget'\)\)/);

    const outer = buildLibreChatSyncRemoteScript(target);
    const payload = JSON.parse(Buffer.from(outer.match(/PAYLOAD_BASE64='([^']+)'/)[1], "base64").toString("utf8"));
    assert.equal(payload.hasVisionTarget, target.hasVisionTarget);
    assert.equal(payload.visionModelId, target.visionModelId);
  }
});

test("the remote JSON app sends the vision fields it needs to route the vision entry", () => {
  const script = buildRemoteJsonAppSyncScript(VISION_ELSEWHERE);
  const payload = JSON.parse(Buffer.from(script.match(/PAYLOAD_BASE64='([^']+)'/)[1], "base64").toString("utf8"));
  // Regression: the payload used to carry only modelId/baseUrl, so the vision entry
  // was structurally guaranteed to be rewritten to the launched (text-only) model.
  assert.equal(payload.hasVisionTarget, true);
  assert.equal(payload.visionModelId, "Mage-VL");
  assert.match(payload.visionBaseUrl, /8038/);
  assert.notEqual(payload.visionModelId, payload.modelId);

  const none = JSON.parse(Buffer.from(
    buildRemoteJsonAppSyncScript(NO_VISION).match(/PAYLOAD_BASE64='([^']+)'/)[1], "base64").toString("utf8"));
  assert.equal(none.hasVisionTarget, false);
});
