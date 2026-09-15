const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  applyLlamaCppCompatPatches,
  buildDownloadParts,
  buildCurlHeaderArgs,
  extractEmbeddedGgufChatTemplate,
  findPrimaryGgufFile,
  materializeChatTemplate,
  inspectConversionSourceCompatibility,
  prepareConversionSourceTree,
  LLAMA_CPP_TOKENIZER_PRE_PATCHES,
  CONVERSION_QUANT_PLANS,
  DEFAULT_CONVERSION_QUANTIZATION,
  deriveConversionBaseName,
  supportsParallelDownload,
  watchFileProgress,
} = require("../src/hf-download-worker.js");

test("watchFileProgress reports growth live and backs out a restarted file", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-watch-progress-"));
  const filePath = path.join(tempDir, "download.part");
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const deltas = [];
  await watchFileProgress([filePath], async (delta) => { deltas.push(delta); }, async () => {
    await fs.writeFile(filePath, Buffer.alloc(1000));
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A failed range restarts its part from scratch.
    await fs.rm(filePath, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await fs.writeFile(filePath, Buffer.alloc(400));
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  assert.ok(deltas.includes(1000), `expected a +1000 delta, got ${JSON.stringify(deltas)}`);
  assert.ok(deltas.includes(-1000), `expected the restart to report -1000, got ${JSON.stringify(deltas)}`);
  // Net of every delta is what is actually on disk — no double counting.
  assert.equal(deltas.reduce((sum, value) => sum + value, 0), 400);
});

test("conversion quant plans cover the default and route direct vs quantize methods correctly", () => {
  assert.ok(CONVERSION_QUANT_PLANS[DEFAULT_CONVERSION_QUANTIZATION]);
  for (const [name, plan] of Object.entries(CONVERSION_QUANT_PLANS)) {
    assert.ok(["direct", "quantize"].includes(plan.method), `${name} has a valid method`);
    assert.ok(plan.sizeFactor > 0 && plan.sizeFactor <= 1, `${name} has a sane size factor`);
    if (plan.method === "direct") {
      assert.ok(["f16", "bf16", "q8_0"].includes(plan.outtype), `${name} maps to a converter outtype`);
    } else {
      assert.equal(plan.outtype, undefined);
    }
  }
});

test("deriveConversionBaseName strips GGUF suffixes and unsafe characters", () => {
  assert.equal(
    deriveConversionBaseName({ name: "Huihui-gemma-4-31B-abliterated" }),
    "Huihui-gemma-4-31B-abliterated",
  );
  assert.equal(deriveConversionBaseName({ name: "Qwopus3.6-27B-v2-MTP-GGUF" }), "Qwopus3.6-27B-v2-MTP");
  assert.equal(deriveConversionBaseName({ name: "weird name/with:stuff" }), "with-stuff");
  assert.equal(deriveConversionBaseName({}), "model");
});

test("buildDownloadParts splits large files into stable byte ranges", () => {
  assert.deepEqual(buildDownloadParts(0), []);
  assert.deepEqual(buildDownloadParts(10, 4), [
    { index: 0, start: 0, end: 3, size: 4 },
    { index: 1, start: 4, end: 7, size: 4 },
    { index: 2, start: 8, end: 9, size: 2 },
  ]);
});

test("buildCurlHeaderArgs preserves auth and user-agent headers for curl", () => {
  assert.deepEqual(buildCurlHeaderArgs({
    authorization: "Bearer test-token",
    "user-agent": "llm3/1.0",
    empty: "",
  }), [
    "-H", "authorization: Bearer test-token",
    "-H", "user-agent: llm3/1.0",
  ]);
});

test("extractEmbeddedGgufChatTemplate reads the embedded tokenizer.chat_template string", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-gguf-template-"));
  const ggufPath = path.join(tempDir, "embedded-template.gguf");
  const template = "{%- if add_generation_prompt %}<|im_start|>assistant\\n<think>\\n{%- endif %}";
  const header = Buffer.alloc(32);
  header.write("GGUF", 0, "utf8");
  header.writeBigUInt64LE(1n, 24);
  const key = Buffer.from("tokenizer.chat_template", "utf8");
  const valueType = Buffer.alloc(4);
  valueType.writeUInt32LE(8, 0);
  const strLen = Buffer.alloc(8);
  strLen.writeBigUInt64LE(BigInt(Buffer.byteLength(template, "utf8")), 0);
  const padding = Buffer.alloc(2048);
  const payload = Buffer.concat([header, padding, key, valueType, strLen, Buffer.from(template, "utf8")]);
  await fs.writeFile(ggufPath, payload);

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  assert.equal(await extractEmbeddedGgufChatTemplate(ggufPath), template);
});

// Builds a GGUF stub carrying exactly one metadata KV: tokenizer.chat_template.
function buildGgufWithEmbeddedTemplate(templateBytes) {
  const header = Buffer.alloc(32);
  header.write("GGUF", 0, "utf8");
  header.writeBigUInt64LE(1n, 24);
  const key = Buffer.from("tokenizer.chat_template", "utf8");
  const valueType = Buffer.alloc(4);
  valueType.writeUInt32LE(8, 0);
  const strLen = Buffer.alloc(8);
  strLen.writeBigUInt64LE(BigInt(templateBytes.length), 0);
  return Buffer.concat([header, Buffer.alloc(2048), key, valueType, strLen, templateBytes]);
}

test("extractEmbeddedGgufChatTemplate strips a NUL prefix and rejects non-template payloads", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-gguf-template-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const template = "{%- if add_generation_prompt %}<|im_start|>assistant{%- endif %}";
  const nulPrefixed = path.join(tempDir, "nul-prefixed.gguf");
  await fs.writeFile(
    nulPrefixed,
    buildGgufWithEmbeddedTemplate(Buffer.concat([Buffer.alloc(4), Buffer.from(template, "utf8")])),
  );
  assert.equal(await extractEmbeddedGgufChatTemplate(nulPrefixed), template);

  const garbage = path.join(tempDir, "garbage.gguf");
  await fs.writeFile(garbage, buildGgufWithEmbeddedTemplate(Buffer.from("not a template at all", "utf8")));
  assert.equal(await extractEmbeddedGgufChatTemplate(garbage), "");
});

test("findPrimaryGgufFile skips mmproj and partials and picks the first shard", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-gguf-primary-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  for (const name of [
    "mmproj-Model-F16.gguf",
    "Model-00002-of-00002.gguf",
    "Model-00001-of-00002.gguf",
    "Model.partial-3.gguf",
  ]) {
    await fs.writeFile(path.join(tempDir, name), "x");
  }
  assert.equal(await findPrimaryGgufFile(tempDir), path.join(tempDir, "Model-00001-of-00002.gguf"));
  assert.equal(await findPrimaryGgufFile(path.join(tempDir, "missing")), "");
});

test("findPrimaryGgufFile descends into per-quant subdirectories", async (t) => {
  // unsloth publishes one folder per quant, so a flat scan finds only dirs.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-gguf-nested-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const quantDir = path.join(tempDir, "UD-IQ3_XXS");
  await fs.mkdir(quantDir, { recursive: true });
  for (const name of [
    "Model-UD-IQ3_XXS-00002-of-00002.gguf",
    "Model-UD-IQ3_XXS-00001-of-00002.gguf",
    "mmproj.gguf",
  ]) {
    await fs.writeFile(path.join(quantDir, name), "x");
  }

  assert.equal(
    await findPrimaryGgufFile(tempDir),
    path.join(quantDir, "Model-UD-IQ3_XXS-00001-of-00002.gguf"),
  );
});

test("materializeChatTemplate does not fail a gguf download when no repo template exists", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-no-template-"));
  const originalFetch = global.fetch;
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    global.fetch = originalFetch;
  });

  // Repo has no chat_template.jinja / chat_template.json / tokenizer_config.
  global.fetch = async () => ({ ok: false, status: 404, async text() { return ""; } });
  await fs.writeFile(path.join(tempDir, "Model-Q3.gguf"), Buffer.alloc(4096));

  const resolved = await materializeChatTemplate(tempDir, {
    runtime: "gguf",
    repoId: "vendor/Model-GGUF",
    template: {
      outputPath: ".llm3-chat-template.jinja",
      sources: [{ repoId: "vendor/Model", revision: "main", path: "chat_template.jinja" }],
    },
  }, {});

  // Null, not a throw: the GGUF carries its own template.
  assert.equal(resolved, null);
});

test("materializeChatTemplate prefers the GGUF's embedded template over the repo copy", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-materialize-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    global.fetch = originalFetch;
  });

  const originalFetch = global.fetch;
  let fetched = 0;
  global.fetch = async () => {
    fetched += 1;
    return { ok: true, status: 200, async text() { return "{{ 'base repo template' }}"; } };
  };

  const embedded = "{%- if add_generation_prompt %}{{ 'quantizer template' }}{%- endif %}";
  await fs.writeFile(
    path.join(tempDir, "Model-Q8_0.gguf"),
    buildGgufWithEmbeddedTemplate(Buffer.from(embedded, "utf8")),
  );

  const candidate = {
    runtime: "gguf",
    repoId: "vendor/Model-GGUF",
    template: {
      outputPath: ".llm3-chat-template.jinja",
      sources: [{ repoId: "vendor/Model", revision: "main", path: "chat_template.jinja" }],
    },
  };

  const resolved = await materializeChatTemplate(tempDir, candidate, {});
  assert.equal(resolved.file, ".llm3-chat-template.jinja");
  assert.equal(resolved.sourceRepoId, "vendor/Model-GGUF");
  assert.equal(resolved.sourcePath, "tokenizer.chat_template");
  assert.equal(fetched, 0, "the base repo must not be consulted when the GGUF carries a template");
  assert.equal(
    await fs.readFile(path.join(tempDir, ".llm3-chat-template.jinja"), "utf8"),
    `${embedded}\n`,
  );
});

test("materializeChatTemplate falls back to the repo template when the GGUF has none", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-materialize-fallback-"));
  const originalFetch = global.fetch;
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    global.fetch = originalFetch;
  });

  global.fetch = async () => ({ ok: true, status: 200, async text() { return "{{ 'base repo template' }}"; } });
  await fs.writeFile(path.join(tempDir, "Model-Q8_0.gguf"), Buffer.alloc(4096));

  const resolved = await materializeChatTemplate(tempDir, {
    runtime: "gguf",
    repoId: "vendor/Model-GGUF",
    template: {
      outputPath: ".llm3-chat-template.jinja",
      sources: [{ repoId: "vendor/Model", revision: "main", path: "chat_template.jinja" }],
    },
  }, {});

  assert.equal(resolved.sourceRepoId, "vendor/Model");
  assert.equal(resolved.sourcePath, "chat_template.jinja");
  assert.equal(
    await fs.readFile(path.join(tempDir, ".llm3-chat-template.jinja"), "utf8"),
    "{{ 'base repo template' }}\n",
  );
});

test("supportsParallelDownload requires a valid 206 content-range probe", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, options = {}) => {
    calls.push(options);
    return {
      status: 206,
      headers: {
        get(name) {
          return String(name).toLowerCase() === "content-range" ? `bytes 0-0/${1024 * 1024 * 1024}` : null;
        },
      },
      body: {
        async cancel() {},
      },
    };
  };

  try {
    assert.equal(await supportsParallelDownload("https://example.test/model.gguf", { authorization: "Bearer test" }, 1024), false);
    assert.equal(await supportsParallelDownload("https://example.test/model.gguf", {}, 1024 * 1024 * 1024), true);
    assert.equal(calls.at(-1).headers.range, "bytes=0-0");
  } finally {
    global.fetch = originalFetch;
  }
});

test("applyLlamaCppCompatPatches injects the Qwen3.6 tokenizer compatibility mapping", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hf-worker-"));
  const converterPath = path.join(tempDir, "convert_hf_to_gguf.py");
  const sampleConverter = [
    "    def get_vocab_base_pre(self, tokenizer) -> str:",
    "        res = None",
    "        if chkhsh == \"d30d75d9059f1aa2c19359de71047b3ae408c70875e8a3ccf8c5fba56c9d8af4\":",
    "            # ref: https://huggingface.co/Qwen/Qwen3.5-9B-Instruct",
    "            res = \"qwen35\"",
    "",
    "        if res is None:",
    "            raise NotImplementedError(\"BPE pre-tokenizer was not recognized - update get_vocab_base_pre()\")",
    "",
  ].join("\n");
  await fs.writeFile(converterPath, sampleConverter, "utf8");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const firstPass = await applyLlamaCppCompatPatches(converterPath);
  const secondPass = await applyLlamaCppCompatPatches(converterPath);
  const patched = await fs.readFile(converterPath, "utf8");

  assert.equal(firstPass, true);
  assert.equal(secondPass, false);
  assert.match(patched, /llm3 compatibility tokenizer patches/);

  for (const patch of LLAMA_CPP_TOKENIZER_PRE_PATCHES) {
    assert.match(patched, new RegExp(`if chkhsh == "${patch.hash}"`));
    assert.match(patched, new RegExp(`res = "${patch.tokenizerPre}"`));
  }
});

test("applyLlamaCppCompatPatches follows get_vocab_base_pre() into conversion/base.py", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-hf-worker-split-"));
  const converterPath = path.join(tempDir, "convert_hf_to_gguf.py");
  const basePath = path.join(tempDir, "conversion", "base.py");
  // Upstream's split layout: the CLI keeps none of the vocab logic.
  await fs.writeFile(converterPath, "def main():\n    parse_args()\n", "utf8");
  await fs.mkdir(path.dirname(basePath), { recursive: true });
  await fs.writeFile(basePath, [
    "    def get_vocab_base_pre(self, tokenizer) -> str:",
    "        res = None",
    "",
    "        if res is None:",
    "            raise NotImplementedError(\"BPE pre-tokenizer was not recognized\")",
    "",
  ].join("\n"), "utf8");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const firstPass = await applyLlamaCppCompatPatches(converterPath);
  const secondPass = await applyLlamaCppCompatPatches(converterPath);
  const patchedBase = await fs.readFile(basePath, "utf8");
  const untouchedConverter = await fs.readFile(converterPath, "utf8");

  assert.equal(firstPass, true);
  assert.equal(secondPass, false);
  assert.match(patchedBase, /llm3 compatibility tokenizer patches/);
  assert.doesNotMatch(untouchedConverter, /llm3 compatibility tokenizer patches/);
  for (const patch of LLAMA_CPP_TOKENIZER_PRE_PATCHES) {
    assert.match(patchedBase, new RegExp(`res = "${patch.tokenizerPre}"`));
  }
});

test("inspectConversionSourceCompatibility rejects ModelOpt checkpoints with a base-model reroute hint", () => {
  const message = inspectConversionSourceCompatibility({
    quantization_config: {
      quant_method: "modelopt",
    },
  }, {
    repoId: "nvidia/Qwen3.6-27B-NVFP4",
    baseModelRepoId: "Qwen/Qwen3.6-27B",
    libraryName: "Model Optimizer",
  });

  assert.match(message, /already quantized with "modelopt"/);
  assert.match(message, /Convert the advertised base model Qwen\/Qwen3\.6-27B instead/);
});

test("inspectConversionSourceCompatibility accepts a rerouted raw base-model config", () => {
  const message = inspectConversionSourceCompatibility({
    architectures: ["Qwen3_5ForConditionalGeneration"],
  }, {
    repoId: "nvidia/Qwen3.6-27B-NVFP4",
    requestedRepoId: "nvidia/Qwen3.6-27B-NVFP4",
    sourceRepoId: "Qwen/Qwen3.6-27B",
    baseModelRepoId: "Qwen/Qwen3.6-27B",
    quantizationMethod: "modelopt",
    libraryName: "Model Optimizer",
  });

  assert.equal(message, "");
});

test("prepareConversionSourceTree wipes mismatched reroute leftovers and stale partial artifacts", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-convert-source-"));
  const sourceDir = path.join(tempDir, ".source");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "config.json"), JSON.stringify({
    quantization_config: { quant_method: "modelopt" },
    base_model: "Qwen/Qwen3.6-27B",
  }), "utf8");
  await fs.writeFile(path.join(sourceDir, "model-00001-of-00003.safetensors"), "stale", "utf8");
  await fs.writeFile(path.join(sourceDir, "model-00001-of-00015.safetensors"), "keep", "utf8");
  await fs.writeFile(path.join(tempDir, "Qwen3.6-27B-Q8_0.gguf.partial-1234"), "partial", "utf8");
  await fs.writeFile(path.join(tempDir, "Qwen3.6-27B.bf16-intermediate-1234.tmp"), "intermediate", "utf8");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await prepareConversionSourceTree({
    kind: "convert",
    targetDir: tempDir,
    candidate: {
      repoId: "nvidia/Qwen3.6-27B-NVFP4",
      downloadSpec: {
        repoId: "Qwen/Qwen3.6-27B",
        revision: "abc123",
        files: [
          { path: ".source/config.json" },
          { path: ".source/model-00001-of-00015.safetensors" },
          { path: ".source/model-00002-of-00015.safetensors" },
        ],
      },
    },
    conversion: {
      sourceDir: ".source",
      sourceRepoId: "Qwen/Qwen3.6-27B",
      revision: "abc123",
    },
  }, tempDir);

  await assert.rejects(fs.stat(path.join(sourceDir, "config.json")));
  await assert.rejects(fs.stat(path.join(sourceDir, "model-00001-of-00015.safetensors")));
  await assert.rejects(fs.stat(path.join(sourceDir, "model-00001-of-00003.safetensors")));
  await assert.rejects(fs.stat(path.join(tempDir, "Qwen3.6-27B-Q8_0.gguf.partial-1234")));
  await assert.rejects(fs.stat(path.join(tempDir, "Qwen3.6-27B.bf16-intermediate-1234.tmp")));

  const marker = JSON.parse(await fs.readFile(path.join(sourceDir, ".llm3-source.json"), "utf8"));
  assert.equal(marker.repoId, "Qwen/Qwen3.6-27B");
  assert.equal(marker.revision, "abc123");
});

test("prepareConversionSourceTree preserves matching files and prunes unexpected extras", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-convert-source-prune-"));
  const sourceDir = path.join(tempDir, ".source");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, ".llm3-source.json"), JSON.stringify({
    repoId: "Qwen/Qwen3.6-27B",
    revision: "abc123",
  }), "utf8");
  await fs.writeFile(path.join(sourceDir, "config.json"), "{}", "utf8");
  await fs.writeFile(path.join(sourceDir, "model-00001-of-00015.safetensors"), "keep", "utf8");
  await fs.writeFile(path.join(sourceDir, "model-00001-of-00003.safetensors"), "drop", "utf8");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await prepareConversionSourceTree({
    kind: "convert",
    candidate: {
      downloadSpec: {
        files: [
          { path: ".source/config.json" },
          { path: ".source/model-00001-of-00015.safetensors" },
          { path: ".source/model-00002-of-00015.safetensors" },
        ],
      },
    },
    conversion: {
      sourceDir: ".source",
      sourceRepoId: "Qwen/Qwen3.6-27B",
      revision: "abc123",
    },
  }, tempDir);

  await assert.doesNotReject(() => fs.stat(path.join(sourceDir, "config.json")));
  await assert.doesNotReject(() => fs.stat(path.join(sourceDir, "model-00001-of-00015.safetensors")));
  await assert.rejects(fs.stat(path.join(sourceDir, "model-00001-of-00003.safetensors")));
});
