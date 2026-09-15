const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const FIXTURES = path.join(__dirname, "fixtures", "gaming-pc");
const server = require("../src/server.js");
const {
  applyHermesPcConfig,
  applyOmpPcConfig,
  applyPiPcConfig,
  applyOpenCodePcConfig,
  requireGamingPcTarget,
} = server;

const TARGET = {
  modelId: "Qwen3.8-27B-UD-Q4_K_XL",
  runtimeBaseUrl: "http://192.0.2.10:8036/v1",
  contextLength: 400000,
  apiKey: "api-key",
  supportsVision: true,
  hasVisionTarget: true,
  visionModelId: "Qwen3.8-27B-UD-Q4_K_XL",
  visionRuntimeBaseUrl: "http://192.0.2.10:8036/v1",
};
const TEXT_ONLY_TARGET = { ...TARGET, supportsVision: false };
// A text-only model in the launched slot, while another slot serves vision.
const VISION_ELSEWHERE_TARGET = {
  ...TARGET,
  supportsVision: false,
  hasVisionTarget: true,
  visionModelId: "Mage-VL",
  visionRuntimeBaseUrl: "http://192.0.2.10:8038/v1",
};

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

test("requireGamingPcTarget derives both root and /v1 base URLs", () => {
  const spec = requireGamingPcTarget(TARGET);
  assert.equal(spec.rootBaseUrl, "http://192.0.2.10:8036");
  assert.equal(spec.v1BaseUrl, "http://192.0.2.10:8036/v1");
  assert.equal(spec.contextLength, 400000);

  // A target given without the /v1 suffix must still produce both forms.
  const bare = requireGamingPcTarget({ ...TARGET, runtimeBaseUrl: "http://192.0.2.10:8037" });
  assert.equal(bare.rootBaseUrl, "http://192.0.2.10:8037");
  assert.equal(bare.v1BaseUrl, "http://192.0.2.10:8037/v1");
});

test("requireGamingPcTarget rejects a target with no model or URL", () => {
  assert.throws(() => requireGamingPcTarget({ modelId: "", runtimeBaseUrl: "http://x/v1" }), /requires a model id/);
  assert.throws(() => requireGamingPcTarget({ modelId: "m", runtimeBaseUrl: "" }), /requires a model id/);
});

test("Hermes PC config gets the model, URL and context length", () => {
  const updated = applyHermesPcConfig(fixture("hermes-config.yaml"), TARGET);
  const config = yaml.load(updated);
  assert.equal(config.model.model, TARGET.modelId);
  assert.equal(config.model.default, TARGET.modelId);
  assert.equal(config.model.base_url, TARGET.runtimeBaseUrl);
  assert.equal(config.model.provider, "custom");
  assert.equal(config.model.context_length, 400000);
  // Unrelated sections must survive the round-trip untouched.
  assert.equal(config.agent.max_turns, 9960);
  assert.equal(config.max_live_sessions, 16);
});

test("Hermes PC sync refuses a context length below the Hermes minimum", () => {
  assert.throws(
    () => applyHermesPcConfig(fixture("hermes-config.yaml"), { ...TARGET, contextLength: 1024 }),
    /below the .* minimum/,
  );
});

test("OMP PC config points its provider at the launched slot", () => {
  const updated = applyOmpPcConfig(fixture("omp-models.yaml"), requireGamingPcTarget(TARGET));
  const config = yaml.load(updated);
  const provider = config.providers.myco;
  // OMP addresses the server root, not /v1.
  assert.equal(provider.baseUrl, "http://192.0.2.10:8036");
  assert.equal(provider.models[0].contextWindow, 400000);
  // The id tracks the launched model; config.yml's modelRoles are repointed to
  // match in the same sync (see applyOmpPcSettings), so nothing is orphaned.
  assert.equal(provider.models[0].id, "Qwen3.8-27B-UD-Q4_K_XL");
  assert.equal(provider.models[0].name, "Qwen3.8-27B-UD-Q4_K_XL");
  // Fields the dashboard does not own are preserved.
  assert.equal(provider.api, "openai-responses");
  assert.equal(provider.models[0].maxTokens, 50000);
  assert.deepEqual(provider.models[0].cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
});

test("PI PC config updates the main provider from the launched slot", () => {
  const updated = JSON.parse(applyPiPcConfig(fixture("pi-models.json"), requireGamingPcTarget(TARGET)));

  const original = JSON.parse(fixture("pi-models.json"));
  const main = updated.providers["local-server"];
  assert.equal(main.baseUrl, "http://192.0.2.10:8036/v1");
  assert.equal(main.models[0].contextWindow, 400000);
  // The id tracks the launched model; syncPiPcAfterLaunch repoints settings.json's
  // defaultModel from the alias it reads back, so the global default stays valid.
  assert.equal(main.models[0].id, "Qwen3.8-27B-UD-Q4_K_XL");
  assert.notEqual(main.models[0].id, original.providers["local-server"].models[0].id);
  // Fields the dashboard does not own are preserved.
  assert.equal(main.models[0].maxTokens, 20000);

  // This model is its own vision target, so the vision provider follows it.
  assert.equal(updated.providers["local-vision-server"].baseUrl, "http://192.0.2.10:8036/v1");
  assert.equal(updated.providers["local-vision-server"].models[0].id, "Qwen3.8-27B-UD-Q4_K_XL");
});

test("OpenCode PC config rewrites the llama.cpp provider and the active model", () => {
  const updated = applyOpenCodePcConfig(fixture("opencode.jsonc"), requireGamingPcTarget(TARGET));

  assert.match(updated, /"baseURL": "http:\/\/192\.0\.2\.10:8036\/v1"/);
  assert.match(updated, /"context": 400000/);

  // The provider now names the model it actually serves, and the stale
  // port-named entries from earlier launches are gone rather than piling up.
  assert.match(updated, /"Qwen3\.8-27B-UD-Q4_K_XL": \{/);
  assert.ok(!updated.includes("Qwen3.6-35B-8037"), "stale entry must not survive");
  assert.ok(!updated.includes("Qwen3.6-35B-8036"), "stale entry must not survive");
  // ...and the top-level selector follows it in the same write.
  assert.match(updated, /"model": "llama\.cpp\/Qwen3\.8-27B-UD-Q4_K_XL"/);

  // This model is itself the vision target, so llama.cpp-vision follows it too.
  assert.match(updated, /"llama\.cpp-vision"/);
  assert.ok(!updated.includes("8038"), "vision provider should follow the launched vision slot");

  // Everything outside the two provider blocks must survive verbatim.
  assert.match(updated, /"relab-web"/);
  assert.match(updated, /"pdf-reader"/);
  assert.match(updated, /"skills": \{/);
  assert.match(updated, /"\$schema": "https:\/\/opencode\.ai\/config\.json"/);
  assert.match(updated, /"permission": \{ "\*": "allow" \}/);
});

test("OpenCode PC transform is idempotent", () => {
  const spec = requireGamingPcTarget(TARGET);
  const once = applyOpenCodePcConfig(fixture("opencode.jsonc"), spec);
  const twice = applyOpenCodePcConfig(once, spec);
  assert.equal(twice, once);
});

test("OpenCode PC transform fails loudly on a config it does not recognise", () => {
  assert.throws(
    () => applyOpenCodePcConfig('{ "model": "x" }', requireGamingPcTarget(TARGET)),
    /no "llama\.cpp" provider block/,
  );
});

// ---- selectable chat templates -------------------------------------------

const {
  isQwen38TwentySevenBModel,
  getChatTemplateOptionsForModel,
  resolveChatTemplateKey,
  normalizeChatTemplateParam,
  buildChatTemplateOptionsPayload,
  buildGgufExtraArgs,
} = server;

const QWEN38_27B = { key: "/m/unsloth__Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_XL.gguf", label: "Qwen3.8 27B UD Q4 K XL", family: "Qwen", runtime: "gguf" };
const QWEN38_9B = { key: "/m/empero-ai__Qwen3.8-9B-GGUF/Qwen3.8-9B-Q8_0.gguf", label: "Qwen3.8 9B Q8 0", family: "Qwen", runtime: "gguf" };
const QWEN36_35B = { key: "/m/mudler__Qwen3.6-35B-A3B-APEX-GGUF/x.gguf", label: "Qwen3.6 35BA3B APEX", family: "Qwen 3.6", runtime: "gguf" };
const QWEN38_27B_MLX = { key: "/m/mlx-community__Qwen3.8-27B-8bit", label: "mlx community Qwen3.8 27B 8bit", family: "Qwen", runtime: "mlx" };

test("only the 27B Qwen3.8 variants are recognised", () => {
  assert.equal(isQwen38TwentySevenBModel(QWEN38_27B), true);
  assert.equal(isQwen38TwentySevenBModel({ label: "Huihui Qwen3.8 27B abliterated Q4 K", runtime: "gguf" }), true);
  assert.equal(isQwen38TwentySevenBModel(QWEN38_9B), false, "9B is not the 27B variant");
  assert.equal(isQwen38TwentySevenBModel(QWEN36_35B), false, "Qwen3.6 is a different generation");
});

test("the Qwen Sharp template is offered only where llama.cpp can load it", () => {
  assert.deepEqual(getChatTemplateOptionsForModel(QWEN38_27B).map((e) => e.key), ["qwen-sharp"]);
  assert.deepEqual(getChatTemplateOptionsForModel(QWEN38_9B), []);
  assert.deepEqual(getChatTemplateOptionsForModel(QWEN36_35B), []);
  // MLX is not launched through llama.cpp, so --chat-template-file does not apply.
  assert.deepEqual(getChatTemplateOptionsForModel(QWEN38_27B_MLX), []);
});

test("Qwen Sharp is the default until the model default is explicitly saved", () => {
  assert.equal(resolveChatTemplateKey(QWEN38_27B, ""), "qwen-sharp", "unsaved -> preferred template");
  assert.equal(resolveChatTemplateKey(QWEN38_27B, "qwen-sharp"), "qwen-sharp");
  assert.equal(resolveChatTemplateKey(QWEN38_27B, "model-default"), "model-default", "saving the original must stick");
  assert.equal(resolveChatTemplateKey(QWEN38_27B, "no-such-template"), "qwen-sharp", "stale key falls back");
  // Models with no alternatives always keep their own template.
  assert.equal(resolveChatTemplateKey(QWEN36_35B, "qwen-sharp"), "model-default");
});

test("a template request for an ineligible model is discarded", () => {
  assert.equal(normalizeChatTemplateParam(QWEN38_27B, { chatTemplate: "qwen-sharp" }), "qwen-sharp");
  assert.equal(normalizeChatTemplateParam(QWEN38_27B, { chatTemplate: "model-default" }), "model-default");
  assert.equal(normalizeChatTemplateParam(QWEN36_35B, { chatTemplate: "qwen-sharp" }), "model-default");
  assert.equal(normalizeChatTemplateParam(QWEN38_9B, { chatTemplate: "qwen-sharp" }), "model-default");
});

test("the options payload is only built for models with a choice", () => {
  const payload = buildChatTemplateOptionsPayload(QWEN38_27B, "");
  assert.equal(payload.selected, "qwen-sharp");
  assert.equal(payload.saved, null);
  assert.deepEqual(payload.options.map((o) => o.key), ["model-default", "qwen-sharp"]);

  const saved = buildChatTemplateOptionsPayload(QWEN38_27B, "model-default");
  assert.equal(saved.selected, "model-default");
  assert.equal(saved.saved, "model-default");

  assert.equal(buildChatTemplateOptionsPayload(QWEN36_35B, ""), null);
});

test("the launcher only receives --chat-template-file when a file was resolved", () => {
  assert.deepEqual(buildGgufExtraArgs({ enableDry: false }), ["--no-dry"]);
  assert.deepEqual(
    buildGgufExtraArgs({ enableDry: false, chatTemplateFile: "/tmp/qwen-sharp.jinja" }),
    ["--no-dry", "--chat-template-file", "/tmp/qwen-sharp.jinja"],
  );
});

// ---- vision capability ----------------------------------------------------
// Regression: the PC configs declare the model's input modalities themselves.
// Repointing a provider at a vision model while leaving input: ["text"] in place
// made the PI harness answer "Current model does not support images".

test("requireGamingPcTarget carries the model's own vision capability", () => {
  assert.equal(requireGamingPcTarget(TARGET).supportsVision, true);
  assert.equal(requireGamingPcTarget(TEXT_ONLY_TARGET).supportsVision, false);
  assert.equal(requireGamingPcTarget({ ...TARGET, supportsVision: undefined }).supportsVision, false);
});

test("PI PC declares image input for a vision model and drops it for a text model", () => {
  const vision = JSON.parse(applyPiPcConfig(fixture("pi-models.json"), requireGamingPcTarget(TARGET)));
  assert.deepEqual(vision.providers["local-server"].models[0].input, ["text", "image"]);

  const textOnly = JSON.parse(applyPiPcConfig(fixture("pi-models.json"), requireGamingPcTarget(TEXT_ONLY_TARGET)));
  assert.deepEqual(textOnly.providers["local-server"].models[0].input, ["text"]);
});

test("OMP PC declares image input from the model, not from whatever was there before", () => {
  // The fixture starts with input: [text, image]; a text-only model must clear it.
  const textOnly = yaml.load(applyOmpPcConfig(fixture("omp-models.yaml"), requireGamingPcTarget(TEXT_ONLY_TARGET)));
  assert.deepEqual(textOnly.providers.myco.models[0].input, ["text"]);

  const vision = yaml.load(applyOmpPcConfig(fixture("omp-models.yaml"), requireGamingPcTarget(TARGET)));
  assert.deepEqual(vision.providers.myco.models[0].input, ["text", "image"]);
});

test("OpenCode PC sets attachment + modalities from the model", () => {
  const vision = applyOpenCodePcConfig(fixture("opencode.jsonc"), requireGamingPcTarget(TARGET));
  assert.match(vision, /"Qwen3\.8-27B-UD-Q4_K_XL": \{[\s\S]*?"attachment": true/);
  assert.match(vision, /"Qwen3\.8-27B-UD-Q4_K_XL": \{[\s\S]*?"input": \["text", "image"\]/);

  const textOnly = applyOpenCodePcConfig(fixture("opencode.jsonc"), requireGamingPcTarget(TEXT_ONLY_TARGET));
  assert.match(textOnly, /"Qwen3\.8-27B-UD-Q4_K_XL": \{[\s\S]*?"attachment": false/);
  assert.match(textOnly, /"Qwen3\.8-27B-UD-Q4_K_XL": \{[\s\S]*?"input": \["text"\]/);
});

// ---- vision providers track whichever slot serves images -------------------

test("PI PC repoints its vision provider at the vision slot", () => {
  const updated = JSON.parse(applyPiPcConfig(fixture("pi-models.json"), requireGamingPcTarget(VISION_ELSEWHERE_TARGET)));

  // The launched (text-only) model goes to the main provider...
  assert.equal(updated.providers["local-server"].models[0].id, "Qwen3.8-27B-UD-Q4_K_XL");
  assert.deepEqual(updated.providers["local-server"].models[0].input, ["text"]);
  assert.equal(updated.providers["local-server"].baseUrl, "http://192.0.2.10:8036/v1");

  // ...while the vision provider follows the slot that can actually serve images,
  // naming that slot's model rather than the launched one.
  const vision = updated.providers["local-vision-server"];
  assert.equal(vision.baseUrl, "http://192.0.2.10:8038/v1");
  assert.equal(vision.models[0].id, "Mage-VL");
  assert.deepEqual(vision.models[0].input, ["text", "image"]);
});

test("PI PC leaves the vision provider alone when no slot serves vision", () => {
  const original = JSON.parse(fixture("pi-models.json"));
  const updated = JSON.parse(applyPiPcConfig(
    fixture("pi-models.json"),
    requireGamingPcTarget({ ...TEXT_ONLY_TARGET, hasVisionTarget: false }),
  ));
  assert.deepEqual(updated.providers["local-vision-server"], original.providers["local-vision-server"]);
});

test("OpenCode PC repoints llama.cpp-vision at the vision slot", () => {
  const updated = applyOpenCodePcConfig(fixture("opencode.jsonc"), requireGamingPcTarget(VISION_ELSEWHERE_TARGET));

  assert.match(updated, /"baseURL": "http:\/\/192\.0\.2\.10:8038\/v1"/);
  // The vision provider is repointed and named for the model that slot serves.
  assert.match(updated, /"Mage-VL": \{[\s\S]*?"attachment": true/);
  // compaction names the vision provider, so it follows that rename, while the
  // top-level selector follows the launched (text-only) model instead.
  assert.match(updated, /"model": "llama\.cpp-vision\/Mage-VL"/);
  assert.match(updated, /"model": "llama\.cpp\/Qwen3\.8-27B-UD-Q4_K_XL"/);
  // Untouched sections survive.
  assert.match(updated, /"relab-web"/);
  assert.match(updated, /"skills": \{/);
});

test("OpenCode PC leaves llama.cpp-vision alone when no slot serves vision", () => {
  const updated = applyOpenCodePcConfig(
    fixture("opencode.jsonc"),
    requireGamingPcTarget({ ...TEXT_ONLY_TARGET, hasVisionTarget: false }),
  );
  assert.match(updated, /"Qwen3\.6-35B-A3B-APEX-I-Balanced": \{[\s\S]*?"vision": true/);
  assert.match(updated, /"baseURL": "http:\/\/192\.0\.2\.10:8038\/v1"/);
});

// All three Gaming PC harnesses now name the model they actually serve. They used to
// keep "stable aliases" instead, which meant models.json / models.yaml / opencode.jsonc
// could sit on a model no slot had served for weeks -- the harness reported the wrong
// model with no way for the user to tell. Renaming is only safe because every
// reference to the id is repointed in the same sync: PI's settings.json defaultModel,
// OMP's config.yml modelRoles, and OpenCode's own top-level selector + compaction.model.
test("every Gaming PC harness names the model it is actually serving", () => {
  const spec = requireGamingPcTarget(TARGET);

  const pi = JSON.parse(applyPiPcConfig(fixture("pi-models.json"), spec));
  assert.equal(pi.providers["local-server"].models[0].id, TARGET.modelId);

  const omp = yaml.load(applyOmpPcConfig(fixture("omp-models.yaml"), spec));
  assert.equal(omp.providers.myco.models[0].id, TARGET.modelId);

  const opencode = applyOpenCodePcConfig(fixture("opencode.jsonc"), spec);
  assert.match(opencode, new RegExp(`"${TARGET.modelId.replace(/\./g, "\\.")}": \\{`));
  assert.match(opencode, new RegExp(`"model": "llama\\.cpp/${TARGET.modelId.replace(/\./g, "\\.")}"`));
});

test("both OpenCode providers stay valid across repeated syncs", () => {
  const spec = requireGamingPcTarget(VISION_ELSEWHERE_TARGET);
  const once = applyOpenCodePcConfig(fixture("opencode.jsonc"), spec);
  assert.equal(applyOpenCodePcConfig(once, spec), once);
});

// ---- vision projector naming ---------------------------------------------
// Regression: only "mmproj*" counted as a projector, so a repo that ships
// "<model>-vision-f16.gguf" (JonathanColetti/Qwen3.8-27B-Uncensored-GGUF) got
// no projector downloaded, reported no vision, and offered the projector itself
// in the model list.

const { isVisionProjectorFile } = server;

test("vision projectors are recognised under every shipped naming convention", () => {
  for (const name of [
    "mmproj-F16.gguf",
    "mmproj-BF16.gguf",
    "mmproj-Qwen3.8-27B-BF16.gguf",
    "Qwen3.8-27B-Uncensored-vision-f16.gguf",
    "some-model-vision-bf16.gguf",
    "model.clip.f16.gguf",
    "model-projector-f32.gguf",
  ]) {
    assert.equal(isVisionProjectorFile(name), true, `${name} should be a projector`);
  }
});

test("real model weights are never mistaken for a projector", () => {
  for (const name of [
    "Qwen3.8-27B-Uncensored-Q8_0.gguf",
    "Qwen3.8-27B-UD-Q4_K_XL.gguf",
    "Qwen3.8-27B-Uncensored-noMTP-Q8_0.gguf",
    "Qwen3.8-27B-Uncensored-draft-Q8_0.gguf",
    // A vision-LLM's own quantized weights: "vision" present, but no float type.
    "SomeModel-Vision-7B-Q4_K_M.gguf",
    "Qwen2-VL-7B-f16.gguf",
    "model-f16.gguf",
    "notes.txt",
  ]) {
    assert.equal(isVisionProjectorFile(name), false, `${name} should not be a projector`);
  }
});

test("projector detection works on full paths", () => {
  assert.equal(isVisionProjectorFile("/models/hf/repo/Qwen3.8-27B-Uncensored-vision-f16.gguf"), true);
  assert.equal(isVisionProjectorFile("/models/hf/repo/Qwen3.8-27B-Uncensored-Q8_0.gguf"), false);
});

// ---- selector files ------------------------------------------------------
// Regression: syncing the model LIST without the selector that points into it
// left PI's defaultModel and OMP's modelRoles naming a model that no longer
// existed. PI then fell back to its cloud provider and returned
// "OpenAI API error (401): Incorrect API key provided: dummy".

const { applyPiPcSettings, applyOmpPcSettings } = server;

test("PI settings follow the alias that was written into the model list", () => {
  const before = JSON.parse(fixture("pi-settings.json"));
  const updated = JSON.parse(applyPiPcSettings(fixture("pi-settings.json"), "some-alias", "local-server"));
  assert.equal(updated.defaultModel, "some-alias");
  assert.equal(updated.defaultProvider, "local-server");
  // Unrelated settings survive.
  assert.equal(updated.theme, before.theme);
  assert.deepEqual(updated.packages, before.packages);
  assert.equal(updated.lastChangelogVersion, before.lastChangelogVersion);
});

test("PI settings and model list agree after a sync", () => {
  const spec = requireGamingPcTarget(TARGET);
  const models = JSON.parse(applyPiPcConfig(fixture("pi-models.json"), spec));
  const alias = models.providers["local-server"].models[0].id;
  const settingsText = applyPiPcSettings(fixture("pi-settings.json"), alias, "local-server");
  const settings = settingsText === null ? JSON.parse(fixture("pi-settings.json")) : JSON.parse(settingsText);

  const ids = models.providers[settings.defaultProvider].models.map((m) => m.id);
  assert.ok(
    ids.includes(settings.defaultModel),
    `defaultModel ${settings.defaultModel} must exist in provider ${settings.defaultProvider} (${ids.join(", ")})`,
  );
});

test("OMP roles are repointed at the renamed model", () => {
  const updated = yaml.load(applyOmpPcSettings(fixture("omp-config.yml"), "new-alias", "myco", "myco-large"));
  assert.equal(updated.modelRoles.default, "myco/new-alias");
  // Unrelated settings survive.
  assert.equal(updated.symbolPreset, "unicode");
  assert.equal(updated.task.maxConcurrency, 2);
  assert.equal(updated.shellPath, "C:\\Program Files\\Git\\bin\\bash.exe");
});

test("OMP leaves roles pinned to another provider alone", () => {
  const original = yaml.dump({ modelRoles: { default: "myco/myco-large", cheap: "openai/gpt-5" } });
  const updated = yaml.load(applyOmpPcSettings(original, "new-alias", "myco", "myco-large"));
  assert.equal(updated.modelRoles.default, "myco/new-alias");
  assert.equal(updated.modelRoles.cheap, "openai/gpt-5", "another provider's role must not be touched");
});

test("OMP settings are left untouched when already correct", () => {
  const spec = requireGamingPcTarget(TARGET);
  // Already correct -> null means "nothing to change", skipping the remote write.
  assert.equal(applyOmpPcSettings(fixture("omp-config.yml"), "myco-large", "myco", "myco-large"), null);
});

// Regression: opencode.jsonc was assumed to "carry trailing commas" harmlessly, so the
// surgical edits preserved a stray comma after the last provider entry:
//     "llama.cpp-vision": { ... },
//   },
// OpenCode's parser rejects that and falls back to its own defaults, so a launch that
// reported success left the harness pointed at nothing.
test("OpenCode sync removes trailing commas that break the parser", () => {
  const { stripJsoncTrailingCommas } = require("../src/server.js");

  assert.equal(stripJsoncTrailingCommas('{"a": {"b": 1},\n}\n'), '{"a": {"b": 1}\n}\n');
  assert.equal(stripJsoncTrailingCommas('{"a": [1, 2,]}'), '{"a": [1, 2]}');
  // Legitimate separating commas must survive.
  assert.equal(stripJsoncTrailingCommas('{"a": 1, "b": 2}'), '{"a": 1, "b": 2}');
  // A comma inside a string is not a trailing comma. Windows paths matter here:
  // "cwd": "C:\\Users\\User\\..." appears throughout this file.
  assert.equal(stripJsoncTrailingCommas('{"cwd": "C:\\\\Users\\\\x,}"}'), '{"cwd": "C:\\\\Users\\\\x,}"}');
  // Nor is one inside a comment.
  assert.equal(stripJsoncTrailingCommas('{"a": 1 // trailing , }\n}'), '{"a": 1 // trailing , }\n}');
  assert.equal(stripJsoncTrailingCommas('{"a": 1 /* , */ }'), '{"a": 1 /* , */ }');
});

test("a synced opencode.jsonc parses as strict JSON", () => {
  const updated = applyOpenCodePcConfig(fixture("opencode.jsonc"), requireGamingPcTarget(TARGET));
  // The fixture ships the same stray commas the real file had; after a sync the result
  // must need no trailing-comma tolerance from whatever reads it.
  assert.doesNotThrow(() => JSON.parse(updated), "synced config should be strict JSON");
});

// --- llm3-owned OpenCode output cap, derived from reasoning effort -------------
// A thinking model bills reasoning as OUTPUT tokens, so a cap tuned for a
// non-thinking model truncates it mid-thought and OpenCode receives an empty
// message. See resolveHarnessOutputLimit in src/server.js.
const readOpenCodeOutput = (text, providerKey) => {
  const block = text.slice(text.indexOf(`"${providerKey}"`));
  const match = block.match(/"output"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : null;
};

test("opencode output cap scales with the launched reasoning effort", () => {
  const original = fs.readFileSync(path.join(FIXTURES, "opencode.jsonc"), "utf8");
  // "high" is intentionally not a supported level — Qwen3.8's template rejects it.
  // "medium" injects no restraint instruction at all, so it budgets near xhigh.
  const cases = [
    ["off", 4000],
    ["low", 8000],
    ["medium", 24000],
    ["xhigh", 32000],
    ["", 32000], // no explicit effort: the template defaults to xhigh
  ];
  for (const [effort, expected] of cases) {
    const updated = applyOpenCodePcConfig(original, {
      ...TARGET,
      reasoningEffort: effort,
    });
    assert.equal(
      readOpenCodeOutput(updated, "llama.cpp"),
      expected,
      `reasoningEffort=${JSON.stringify(effort)} should yield output ${expected}`
    );
  }
});

test("opencode output cap is preserved for launchers with no reasoning knob", () => {
  const original = fs.readFileSync(path.join(FIXTURES, "opencode.jsonc"), "utf8");
  // reasoningEffort absent entirely => llm3 does not own the field.
  const updated = applyOpenCodePcConfig(original, { ...TARGET });
  assert.equal(readOpenCodeOutput(updated, "llama.cpp"), 4000);
});

test("opencode output cap never crowds out the context window", () => {
  const original = fs.readFileSync(path.join(FIXTURES, "opencode.jsonc"), "utf8");
  // xhigh wants 32000, but a 40k context may only spend a quarter of itself replying.
  const updated = applyOpenCodePcConfig(original, {
    ...TARGET,
    contextLength: 40000,
    reasoningEffort: "xhigh",
  });
  assert.equal(readOpenCodeOutput(updated, "llama.cpp"), 10000);
});

test("an unsupported reasoning level never reaches a harness config", () => {
  // Qwen3.8's template raises on "high"; llm3 must not offer or propagate it.
  assert.ok(!server.DSPARK_REASONING_EFFORTS?.includes?.("high"),
    "high must not be an accepted reasoning effort");
});

test("opencode vision provider keeps its own hand-tuned output cap", () => {
  const original = fs.readFileSync(path.join(FIXTURES, "opencode.jsonc"), "utf8");
  const updated = applyOpenCodePcConfig(original, {
    ...TARGET,
    reasoningEffort: "medium",
  });
  assert.equal(readOpenCodeOutput(updated, "llama.cpp-vision"), 10000);
});

// The production path is applyOpenCodePcConfig(original, requireGamingPcTarget(t)),
// and requireGamingPcTarget is a whitelist — a field it does not copy is silently
// lost. Assert through the wrapper, not around it.
test("reasoning effort survives requireGamingPcTarget into the output cap", () => {
  const original = fs.readFileSync(path.join(FIXTURES, "opencode.jsonc"), "utf8");
  const withEffort = applyOpenCodePcConfig(
    original,
    requireGamingPcTarget({ ...TARGET, reasoningEffort: "medium" })
  );
  assert.equal(readOpenCodeOutput(withEffort, "llama.cpp"), 24000);

  const withoutEffort = applyOpenCodePcConfig(original, requireGamingPcTarget({ ...TARGET }));
  assert.equal(readOpenCodeOutput(withoutEffort, "llama.cpp"), 4000);
});
