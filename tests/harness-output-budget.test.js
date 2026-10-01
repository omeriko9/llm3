const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const server = require("../src/server.js");
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures/gaming-pc", name), "utf8");
const target = {
  modelId: "thinking-model", runtimeBaseUrl: "http://127.0.0.1:8036",
  contextLength: 262144, thinking: true, reasoningBudget: 4096,
};

test("GGUF numeric budget reaches both OpenCode configs through the PC whitelist", () => {
  const spec = server.requireGamingPcTarget(target);
  const pc = JSON.parse(server.applyOpenCodePcConfig(fixture("opencode.jsonc"), spec));
  const local = server.applyOpenCodeM4Config({}, target);
  assert.equal(pc.provider["llama.cpp"].models[target.modelId].limit.output, 8096);
  assert.equal(local.provider.llm3.models[target.modelId].limit.output, 8096);
  assert.equal(server.applyOpenCodePcConfig(JSON.stringify(pc), spec),
    server.applyOpenCodePcConfig(server.applyOpenCodePcConfig(JSON.stringify(pc), spec), spec));
});

test("Pi, OMP and Hermes replace undersized caps and preserve unrelated settings", () => {
  const spec = server.requireGamingPcTarget(target);
  const piInput = JSON.parse(fixture("pi-models.json"));
  piInput.providers["local-server"].models[0].maxTokens = 4000;
  const pi = JSON.parse(server.applyPiPcConfig(JSON.stringify(piInput), spec));
  assert.equal(pi.providers["local-server"].models[0].maxTokens, 8096);
  const ompInput = yaml.load(fixture("omp-models.yaml"));
  ompInput.providers.myco.models[0].maxTokens = 4000;
  const omp = yaml.load(server.applyOmpPcConfig(yaml.dump(ompInput), spec));
  assert.equal(omp.providers.myco.models[0].maxTokens, 8096);
  const hermes = yaml.load(server.applyHermesPcConfig("model:\n  max_tokens: 4000\ncustom: keep\n", target));
  assert.equal(hermes.model.max_tokens, 8096);
  assert.equal(hermes.custom, "keep");
});

test("vision caps and context come from the vision slot", () => {
  const spec = server.requireGamingPcTarget({ ...target, hasVisionTarget: true,
    visionModelId: "vision-model", visionRuntimeBaseUrl: "http://127.0.0.1:8038",
    visionContextLength: 131072, visionThinking: true, visionReasoningBudget: 32768 });
  const pc = JSON.parse(server.applyOpenCodePcConfig(fixture("opencode.jsonc"), spec));
  const model = pc.provider["llama.cpp-vision"].models["vision-model"];
  assert.equal(model.limit.output, 36768);
  assert.equal(model.limit.context, 131072);
  const pi = JSON.parse(server.applyPiPcConfig(fixture("pi-models.json"), spec));
  assert.equal(pi.providers["local-vision-server"].models[0].maxTokens, 36768);
  assert.equal(pi.providers["local-vision-server"].models[0].contextWindow, 131072);
});

test("budget edge cases never silently allocate less than reasoning plus answer", () => {
  const resolve = server.resolveTargetOutputLimit;
  assert.equal(resolve({ ...target, thinking: false }), 4000);
  assert.equal(resolve({ ...target, reasoningBudget: 0 }), 4000);
  assert.equal(resolve({ ...target, reasoningBudget: -1 }), 32000);
  assert.equal(resolve({ ...target, reasoningBudget: 32768, contextLength: 65536 }), 36768);
  assert.equal(resolve(target, 20000), 20000);
  assert.equal(resolve({ contextLength: 262144 }), null);
  assert.throws(() => resolve({ ...target, contextLength: 8192 }), /insufficient context/);
});

test("Hermes notices a budget-only change and then converges", () => {
  const initial = server.applyLocalHermesModelTarget({}, { ...target, reasoningBudget: 0 }).config;
  const changed = server.applyLocalHermesModelTarget(initial, target);
  assert.equal(changed.configChanged, true);
  assert.equal(changed.config.model.max_tokens, 8096);
  assert.equal(server.applyLocalHermesModelTarget(changed.config, target).configChanged, false);
});
