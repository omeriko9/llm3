"use strict";
// The Models-tab filter chips are derived from the models on disk. These are
// the two name parsers they rest on; public/app.js cannot be required, so the
// functions are lifted out of it (the same way frontend-helpers does).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function lift(pattern, name) {
  const match = pattern.exec(source);
  assert.ok(match, `${name} not found in public/app.js`);
  return match[0];
}

const helpers = vm.runInNewContext([
  lift(/^const MODEL_QUANT_PATTERN = .*$/m, "MODEL_QUANT_PATTERN"),
  lift(/^function modelQuantLabel\(model\) \{[\s\S]*?^\}/m, "modelQuantLabel"),
  lift(/^function deriveModelFamily\(model\) \{[\s\S]*?^\}/m, "deriveModelFamily"),
  "({ modelQuantLabel, deriveModelFamily })",
].join("\n"));

test("deriveModelFamily splits a version off the name but not a parameter count", () => {
  const cases = [
    [{ label: "Gemma4 26B A4B Uncensored Q8 K P" }, "Gemma 4"],
    [{ label: "DeepSeek V4 Flash Q2 0731" }, "DeepSeek V4"],
    [{ label: "Qwen3.8 27B UD Q8 K XL" }, "Qwen 3.8"],
    [{ label: "Qwen 3.6 MXFP4_MOE" }, "Qwen 3.6"],
    [{ label: "OrcaSAQ 2 27B Uncensored" }, "OrcaSAQ 2"],
    [{ label: "Qwen 27B Q4_K_M" }, "Qwen"],
    [{ label: "Mage VL" }, "Mage"],
    // The owner prefix of a folder-style alias is not the family.
    [{ label: "mlx community Qwen3.8 27B 8bit", aliases: ["mlx-community__Qwen3.8-27B-8bit"] }, "Qwen 3.8"],
    [{ label: "ailexleon Hemmingway 1 mlx 8Bit", aliases: ["ailexleon__Hemmingway-1-mlx-8Bit"] }, "Hemmingway 1"],
    [{ label: "", family: "Fallback" }, "Fallback"],
  ];
  for (const [model, expected] of cases) {
    assert.equal(helpers.deriveModelFamily(model), expected, model.label);
  }
});

test("modelQuantLabel prefers metadata, then reads the name", () => {
  assert.equal(helpers.modelQuantLabel({ quantization: "Q8_K_P", label: "x Q4 K M" }), "Q8_K_P");
  assert.equal(helpers.modelQuantLabel({ label: "orcarouter Qwen3.8 27B Uncensored MLX 6 bit" }), "6-bit");
  assert.equal(helpers.modelQuantLabel({ label: "Qwen3.8 Flash Next Uncensored IQ2 M 00001 of 00002" }), "IQ2_M");
  assert.equal(helpers.modelQuantLabel({ label: "beamster Qwen3.8 Flash Next Sushi 4bpw" }), "4bpw");
  assert.equal(helpers.modelQuantLabel({ label: "OrcaSAQ 2 27B Uncensored" }), "");
});
