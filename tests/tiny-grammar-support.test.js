"use strict";
// llm3's server and bin/qwen_llama must agree about which models support Tiny
// Grammar. They did not: the server accepted EVERY gguf model, so the dashboard
// offered the toggle, the slot config saved it on, and the launcher then
// refused the launch outright —
//
//   Tiny Grammar is not supported for DeepSeek-V4-Flash-Q2-0731.
//   exit 1
//
// A non-Qwen GGUF could not be started at all. The launcher's rule
// (supports_tiny_grammar) is "the model identity says qwen"; the server and the
// browser now use the same rule, and the launch-path normalizer forces the flag
// off for anything else, so a stale saved config cannot resurrect it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  supportsTinyGrammar,
  supportsStructuredGbnf,
  normalizeGrammarSelectionForModel,
} = require("../src/server.js");

const DEEPSEEK = {
  key: "models/hf/huihui-ai__Huihui-DeepSeek-V4-Flash-0731-abliterated-GGUF/DeepSeek-V4-Flash-Q2-0731.gguf",
  label: "DeepSeek-V4-Flash-Q2-0731",
  family: "Downloaded GGUF",
  runtime: "gguf",
  aliases: ["DeepSeek-V4-Flash-Q2-0731"],
};
const QWEN = {
  key: "models/hf/unsloth__Qwen3.8-27B-GGUF/Qwen3.8-27B-Q8_0.gguf",
  label: "Qwen3.8 27B Q8 0",
  family: "Qwen",
  runtime: "gguf",
  aliases: ["Qwen3.8-27B-Q8_0"],
};

test("a non-Qwen GGUF does not support Tiny Grammar", () => {
  assert.equal(supportsTinyGrammar(DEEPSEEK), false);
});

test("a Qwen GGUF still does", () => {
  assert.equal(supportsTinyGrammar(QWEN), true);
});

test("a stale saved 'on' is forced off for a model the launcher would reject", () => {
  // This is what unblocks the launch: the user's slot config still says true.
  const selection = normalizeGrammarSelectionForModel(DEEPSEEK, { enableTinyGrammar: true });
  assert.equal(selection.enableTinyGrammar, false);
  assert.equal(selection.enableStructuredGbnf, false);
});

test("a Qwen model keeps the flag it was given", () => {
  assert.equal(normalizeGrammarSelectionForModel(QWEN, { enableTinyGrammar: true }).enableTinyGrammar, true);
  assert.equal(normalizeGrammarSelectionForModel(QWEN, { enableTinyGrammar: false }).enableTinyGrammar, false);
});

test("structured GBNF stays limited to Qwen 3.6 35B/A3B", () => {
  assert.equal(supportsStructuredGbnf(DEEPSEEK), false);
  assert.equal(supportsStructuredGbnf(QWEN), false);
  assert.equal(supportsStructuredGbnf({
    key: "Qwen3.6-35B-A3B-Q4_K_M.gguf", label: "Qwen3.6 35B A3B", family: "Qwen",
    runtime: "gguf", aliases: [],
  }), true);
});

test("the browser uses the same rule as the server", () => {
  // Three copies of this rule exist. Two are JS; the third is the shell
  // function below. They must not drift again.
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const fn = /function supportsTinyGrammar\(model\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(fn, "supportsTinyGrammar not found in public/app.js");
  assert.match(fn[0], /includes\("qwen"\)/, "the browser must require a Qwen identity too");
});

test("narrowing Tiny Grammar must not disable the plain llama.cpp controls", () => {
  // The thinking budget, DRY, micro-batch and MTP draft depth are llama.cpp
  // flags that work on ANY GGUF. The browser routed all four through
  // supportsTinyGrammar, so narrowing that to Qwen greyed them out for a
  // DeepSeek slot — including the thinking budget, which is exactly the control
  // needed to stop that model being cut off mid-thought.
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  const budget = /function supportsReasoningBudget\(model\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(budget, "supportsReasoningBudget not found");
  assert.match(budget[0], /supportsGgufExtras\(model\)/);
  assert.ok(!/supportsTinyGrammar/.test(budget[0]), "the budget must not depend on the grammar rule");

  const mtp = /function supportsMtpDraftTuning\(model\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(mtp, "supportsMtpDraftTuning not found");
  assert.ok(!/supportsTinyGrammar/.test(mtp[0]), "MTP depth must not depend on the grammar rule");

  const speed = /function readSpeedTricks[\s\S]*?\n\}/.exec(app) || [app];
  assert.ok(!/supportsTinyGrammar\(model\) \? Boolean\(source\.enableDry\)/.test(app),
    "DRY must not depend on the grammar rule");
  assert.ok(!/const ubatchSize = supportsTinyGrammar/.test(app),
    "micro-batch must not depend on the grammar rule");
});

test("the browser's GGUF-extras rule matches the server's", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const fn = /function supportsGgufExtras\(model\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(fn, "supportsGgufExtras not found in public/app.js");
  assert.match(fn[0], /ds4/, "ds4 is excluded on both sides");
  assert.match(fn[0], /gguf/);
  assert.ok(!/includes\("qwen"\)/.test(fn[0]), "GGUF extras are not Qwen-only");
});

test("the launcher's rule is still the one being mirrored", () => {
  // If bin/qwen_llama ever widens or narrows this, the two JS copies must follow.
  const launcher = fs.readFileSync(path.join(__dirname, "..", "bin", "qwen_llama"), "utf8");
  const fn = /supports_tiny_grammar\(\) \{[\s\S]*?\n\}/.exec(launcher);
  assert.ok(fn, "supports_tiny_grammar not found in bin/qwen_llama");
  assert.match(fn[0], /\*qwen\*/, "the launcher still matches on a qwen identity");
});
