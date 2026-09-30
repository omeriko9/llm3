// The local OpenCode role owns one provider ("llm3") in opencode.json and points
// the default model at it. Everything else in the file belongs to the user.
const test = require("node:test");
const assert = require("node:assert/strict");

const { applyOpenCodeM4Config, parseJsoncObject } = require("../src/server.js");

const TARGET = {
  modelId: "Qwen3.8-27B-Q8_0",
  runtimeBaseUrl: "http://127.0.0.1:8036",
  contextLength: 131072,
  supportsVision: true,
};

test("parses the hand-written file shape: comments and trailing commas", () => {
  const parsed = parseJsoncObject(`{
    // a comment
    "provider": { "llamacpp": { "options": { "baseURL": "http://x/v1" } }, },
    /* block */ "permission": "allow",
  }`);
  assert.equal(parsed.permission, "allow");
  assert.equal(parsed.provider.llamacpp.options.baseURL, "http://x/v1");
  assert.deepEqual(parseJsoncObject(""), {});
});

test("adds the llm3 provider, selects it, and keeps the user's other keys", () => {
  const config = applyOpenCodeM4Config({
    permission: "allow",
    provider: { llamacpp: { options: { baseURL: "http://old/v1" }, models: { Old: {} } } },
    compaction: { auto: true },
  }, TARGET);

  const provider = config.provider.llm3;
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.equal(provider.options.baseURL, "http://127.0.0.1:8036/v1");
  assert.deepEqual(Object.keys(provider.models), ["Qwen3.8-27B-Q8_0"]);
  assert.equal(provider.models["Qwen3.8-27B-Q8_0"].limit.context, 131072);
  assert.equal(provider.models["Qwen3.8-27B-Q8_0"].attachment, true);
  assert.deepEqual(provider.models["Qwen3.8-27B-Q8_0"].modalities.input, ["text", "image"]);
  assert.equal(config.model, "llm3/Qwen3.8-27B-Q8_0");
  assert.equal(config.small_model, "llm3/Qwen3.8-27B-Q8_0");
  assert.equal(config.permission, "allow");
  assert.deepEqual(config.compaction, { auto: true });
  assert.equal(config.provider.llamacpp.options.baseURL, "http://old/v1");
});

test("a relaunch replaces the model and repoints only selectors llm3 owns", () => {
  const first = applyOpenCodeM4Config({
    small_model: "anthropic/claude-haiku",
    agent: { build: { model: "llm3/Old" }, plan: { model: "other/Pinned" } },
  }, TARGET);
  const second = applyOpenCodeM4Config(first, { ...TARGET, modelId: "Next", supportsVision: false });

  assert.deepEqual(Object.keys(second.provider.llm3.models), ["Next"]);
  assert.equal(second.provider.llm3.models.Next.attachment, false);
  assert.equal(second.model, "llm3/Next");
  assert.equal(second.small_model, "anthropic/claude-haiku");
  assert.equal(second.agent.build.model, "llm3/Next");
  assert.equal(second.agent.plan.model, "other/Pinned");
});

test("keeps a hand-tuned output cap unless the slot has a reasoning effort", () => {
  const tuned = applyOpenCodeM4Config({}, TARGET);
  tuned.provider.llm3.models[TARGET.modelId].limit.output = 12345;
  const kept = applyOpenCodeM4Config(tuned, TARGET);
  assert.equal(kept.provider.llm3.models[TARGET.modelId].limit.output, 12345);

  const owned = applyOpenCodeM4Config(kept, { ...TARGET, reasoningEffort: "high" });
  assert.notEqual(owned.provider.llm3.models[TARGET.modelId].limit.output, 12345);
});

test("refuses a target without a model or a base URL", () => {
  assert.throws(() => applyOpenCodeM4Config({}, { modelId: "x" }), /runtime base URL/);
});
