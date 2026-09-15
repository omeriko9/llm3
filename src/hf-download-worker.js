#!/usr/bin/env node

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const HF_USER_AGENT = "llm3/1.0";
// Conversion targets. F16/BF16/Q8_0 come straight out of llama.cpp's
// convert_hf_to_gguf.py; K-quants need a bf16 intermediate plus llama-quantize.
// sizeFactor estimates final size relative to bf16 weights (for progress and
// the free-disk check only).
const CONVERSION_QUANT_PLANS = Object.freeze({
  Q3_K_M: { method: "quantize", sizeFactor: 0.25 },
  Q4_K_S: { method: "quantize", sizeFactor: 0.28 },
  Q4_K_M: { method: "quantize", sizeFactor: 0.3 },
  Q5_K_M: { method: "quantize", sizeFactor: 0.36 },
  Q6_K: { method: "quantize", sizeFactor: 0.41 },
  Q8_0: { method: "direct", outtype: "q8_0", sizeFactor: 0.53 },
  BF16: { method: "direct", outtype: "bf16", sizeFactor: 1 },
  F16: { method: "direct", outtype: "f16", sizeFactor: 1 },
});
const DEFAULT_CONVERSION_QUANTIZATION = "Q4_K_M";
const UNSUPPORTED_SOURCE_QUANT_METHODS = new Set([
  "auto-round",
  "autoround",
  "awq",
  "bitsandbytes",
  "bnb",
  "exl2",
  "gptq",
  "modelopt",
]);
const UNSUPPORTED_SOURCE_LIBRARY_MARKERS = [
  "model optimizer",
  "modelopt",
];
// Whole-repo snapshot runtimes: MLX and its MTPLX variant share the same
// on-disk layout (chat_template.jinja, directory-as-model label).
const SNAPSHOT_RUNTIMES = new Set(["mlx", "mtplx"]);

function isSnapshotRuntime(runtime) {
  return SNAPSHOT_RUNTIMES.has(String(runtime || "").trim().toLowerCase());
}

// Measured against huggingface.co on this machine: node's fetch sustains
// ~1.5 MB/s per stream, one curl ~15 MB/s, and 6-8 ranged curls ~40 MB/s. The
// old 512MB floor left sharded repos (76 × 384MB layers-*.safetensors) on the
// slow path — a 31GB source that should take ~13 minutes was pacing 5+ hours.
const PARALLEL_DOWNLOAD_MIN_BYTES = 64 * 1024 * 1024;
const PARALLEL_DOWNLOAD_PART_BYTES = 64 * 1024 * 1024;
const MAX_PARALLEL_DOWNLOADS = 8;
const MAX_CURL_DOWNLOAD_ATTEMPTS = 5;
const CURL_DOWNLOAD_RETRY_DELAY_MS = 1500;
// A transfer averaging under 100KB/s for a full minute is a dead connection,
// not a slow one — genuinely slow links stay well above this floor.
const CURL_STALL_BYTES_PER_SECOND = 100 * 1024;
const CURL_STALL_SECONDS = 60;
// Download phase of a convert job maps to 0–45% of the progress bar; the
// conversion phases fill in the rest.
const CONVERSION_DOWNLOAD_PROGRESS_SCALE = 0.45;
const DOWNLOAD_PROGRESS_POLL_MS = 250;
const LLAMA_CPP_PATCH_SENTINEL = "llm3 compatibility tokenizer patches";
const LLAMA_CPP_TOKENIZER_PRE_PATCHES = Object.freeze([
  {
    // Qwen 3.6 uses the same pre-tokenizer behavior as Qwen 3.5, but some
    // llama.cpp converters still need an explicit hash → tokenizer mapping.
    hash: "3cf6b29f6e0a8a1c7e8d3d9fef1d6f135c0f45f5b653a6b4b8e9d3a7b7c7d3e1",
    tokenizerPre: "qwen35",
    modelLabel: "Qwen3.6",
  },
]);

function inspectConversionSourceCompatibility(config, candidate = {}) {
  const quantizationConfig = config && typeof config === "object" ? config.quantization_config : null;
  const sourceRepoId = String(
    candidate?.sourceRepoId
    || candidate?.conversionRepoId
    || candidate?.repoId
    || ""
  ).trim();
  const requestedRepoId = String(candidate?.requestedRepoId || candidate?.repoId || "").trim();
  const quantizationMethod = String(
    quantizationConfig?.quant_method
    || ""
  ).trim().toLowerCase();
  const reroutedSource = Boolean(requestedRepoId && sourceRepoId && requestedRepoId !== sourceRepoId);
  const libraryName = String(
    config?.library_name
    || (reroutedSource ? "" : (candidate?.libraryName || candidate?.library_name || ""))
    || ""
  ).trim();
  const normalizedLibrary = libraryName.toLowerCase();
  const baseModelRepoId = String(
    candidate?.baseModelRepoId
    || ""
  ).trim();

  if (UNSUPPORTED_SOURCE_QUANT_METHODS.has(quantizationMethod)) {
    const reroute = baseModelRepoId && baseModelRepoId !== sourceRepoId
      ? ` Convert the advertised base model ${baseModelRepoId} instead.`
      : "";
    return `Conversion source ${sourceRepoId || "repo"} is already quantized with "${quantizationMethod}" and is not compatible with llama.cpp's HF converter.${reroute}`;
  }

  if (normalizedLibrary && UNSUPPORTED_SOURCE_LIBRARY_MARKERS.some((marker) => normalizedLibrary.includes(marker))) {
    const reroute = baseModelRepoId && baseModelRepoId !== sourceRepoId
      ? ` Convert the advertised base model ${baseModelRepoId} instead.`
      : "";
    return `Conversion source ${sourceRepoId || "repo"} uses unsupported library metadata "${libraryName}" and is not a raw transformers checkpoint.${reroute}`;
  }

  if (!quantizationMethod && !normalizedLibrary && reroutedSource) {
    return "";
  }

  return "";
}

async function prepareConversionSourceTree(job, targetDir) {
  if (String(job?.kind || "") !== "convert") {
    return;
  }
  const conversion = job?.conversion || {};
  const sourceDirRelative = sanitizeRelativePath(conversion.sourceDir || ".source");
  const sourceDir = path.join(targetDir, sourceDirRelative);
  const expectedEntries = new Set(
    (Array.isArray(job?.candidate?.downloadSpec?.files) ? job.candidate.downloadSpec.files : [])
      .map((file) => sanitizeRelativePath(file?.path || ""))
      .filter(Boolean)
      .map((relativePath) => relativePath.startsWith(`${sourceDirRelative}/`) ? relativePath.slice(sourceDirRelative.length + 1) : null)
      .filter(Boolean)
  );
  const markerPath = path.join(sourceDir, ".llm3-source.json");
  const expectedMarker = {
    repoId: String(conversion.sourceRepoId || job?.candidate?.downloadSpec?.repoId || job?.candidate?.repoId || "").trim(),
    revision: String(conversion.revision || job?.candidate?.downloadSpec?.revision || "main").trim() || "main",
  };

  let wipeSourceTree = false;
  try {
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    if (marker.repoId !== expectedMarker.repoId || marker.revision !== expectedMarker.revision) {
      wipeSourceTree = true;
    }
  } catch (_error) {
    try {
      const existingConfig = JSON.parse(await fs.readFile(path.join(sourceDir, "config.json"), "utf8"));
      const existingQuantMethod = String(existingConfig?.quantization_config?.quant_method || "").trim().toLowerCase();
      const existingBaseModel = String(existingConfig?.base_model || "").trim();
      if (
        existingQuantMethod === "modelopt"
        || (expectedMarker.repoId && existingBaseModel && existingBaseModel !== expectedMarker.repoId)
      ) {
        wipeSourceTree = true;
      }
    } catch (_innerError) {
      // No marker and no readable config means we will prune below.
    }
  }

  if (wipeSourceTree) {
    await fs.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
  }
  await fs.mkdir(sourceDir, { recursive: true });

  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".llm3-source.json") {
      continue;
    }
    if (!expectedEntries.has(entry.name)) {
      await fs.rm(path.join(sourceDir, entry.name), { recursive: true, force: true }).catch(() => {});
    }
  }

  const targetEntries = await fs.readdir(targetDir, { withFileTypes: true }).catch(() => []);
  for (const entry of targetEntries) {
    if (
      entry.isFile()
      && (
        entry.name.includes(".partial-")
        || /\.bf16-intermediate-\d+\.tmp$/i.test(entry.name)
      )
    ) {
      await fs.rm(path.join(targetDir, entry.name), { force: true }).catch(() => {});
    }
  }

  await fs.writeFile(markerPath, `${JSON.stringify(expectedMarker, null, 2)}\n`, "utf8");
}

// The text weights of a download: skips the vision projector (which carries no
// chat template) and, for a sharded GGUF, returns shard 00001 — the only shard
// that holds the metadata KV block.
async function findPrimaryGgufFile(targetDir) {
  // Keep in step with isVisionProjectorFile in src/server.js: projectors also
  // ship as "<model>-vision-f16.gguf", not just "mmproj-*".
  const isProjector = (name) => /mmproj/i.test(name)
    || /(^|[-_.])(vision|clip|projector)[-_.](f16|f32|bf16|fp16|fp32)\.gguf$/i.test(name);
  const usable = (name) => /\.gguf$/i.test(name) && !name.includes(".partial") && !isProjector(name);
  const entries = await fs.readdir(targetDir, { withFileTypes: true }).catch(() => []);
  const top = entries
    .filter((entry) => entry.isFile() && usable(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (top.length > 0) {
    return path.join(targetDir, top[0]);
  }
  // Repos that keep one folder per quant (unsloth's UD-IQ3_XXS/, UD-Q4_K_XL/,
  // ...) land the shards a level down, so a flat readdir saw only directories
  // and concluded the download had no GGUF at all.
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const dir of dirs) {
    const nested = await fs.readdir(path.join(targetDir, dir)).catch(() => []);
    const hit = nested.filter(usable).sort((left, right) => left.localeCompare(right));
    if (hit.length > 0) {
      return path.join(targetDir, dir, hit[0]);
    }
  }
  return "";
}

async function extractEmbeddedGgufChatTemplate(ggufPath) {
  const stats = await fs.stat(ggufPath);
  if (!stats.isFile() || stats.size < 1024) {
    return "";
  }
  const maxSearchSize = Math.min(stats.size, 64 * 1024 * 1024);
  const fd = await fs.open(ggufPath, "r");
  try {
    const searchBuffer = Buffer.alloc(maxSearchSize);
    const { bytesRead } = await fd.read(searchBuffer, 0, maxSearchSize, 0);
    const data = searchBuffer.subarray(0, bytesRead);
    const keyBytes = Buffer.from("tokenizer.chat_template");
    const keyPos = data.indexOf(keyBytes);
    if (keyPos < 0) {
      return "";
    }
    const valueTypePos = keyPos + keyBytes.length;
    const strLenPos = valueTypePos + 4;
    const strStart = strLenPos + 8;
    if (strStart > data.length || valueTypePos + 12 > data.length) {
      return "";
    }
    const valueType = data.readUInt32LE(valueTypePos);
    if (valueType !== 8) {
      return "";
    }
    const strLen = Number(data.readBigUInt64LE(strLenPos));
    if (!Number.isFinite(strLen) || strLen <= 0 || strLen > 1_000_000 || strStart + strLen > data.length) {
      return "";
    }
    // Some quantizers emit the template with a NUL prefix inside the string
    // payload. Strip it here rather than rewriting the GGUF: the length field
    // still covers those bytes, so editing them in place would shift every
    // later KV entry and the tensor-data offset and brick the file.
    const template = data
      .subarray(strStart, strStart + strLen)
      .toString("utf8")
      .replace(/^\0+/, "")
      .trim();
    // A template that survived neither check is garbage, not a template — say
    // so, so the caller can fall back to the repo's chat_template.jinja.
    return template.includes("{%") || template.includes("{{") ? template : "";
  } finally {
    await fd.close();
  }
}

// Upstream split convert_hf_to_gguf.py into a thin CLI plus a conversion/
// package, and get_vocab_base_pre() moved to conversion/base.py with it. Look
// for the fallback in both places so pulling a newer llama.cpp doesn't turn
// every conversion into "Unable to find get_vocab_base_pre() fallback".
function llamaCppPatchTargets(converterPath) {
  return [converterPath, path.join(path.dirname(converterPath), "conversion", "base.py")];
}

async function applyLlamaCppCompatPatches(converterPath) {
  const resolvedPath = path.resolve(String(converterPath || ""));
  const converterSource = await fs.readFile(resolvedPath, "utf8");
  if (!converterSource.trim()) {
    throw new Error(`Converter script is empty: ${resolvedPath}`);
  }

  const fallbackNeedle = "        if res is None:";
  const patchBlock = [
    `        # ${LLAMA_CPP_PATCH_SENTINEL}`,
    ...LLAMA_CPP_TOKENIZER_PRE_PATCHES.flatMap((patch) => [
      `        if chkhsh == "${patch.hash}":`,
      `            # ref: ${patch.modelLabel} tokenizer compatibility`,
      `            res = "${patch.tokenizerPre}"`,
      "",
    ]),
  ].join("\n");

  const targets = llamaCppPatchTargets(resolvedPath);
  for (const target of targets) {
    const original = target === resolvedPath
      ? converterSource
      : await fs.readFile(target, "utf8").catch(() => "");
    if (!original.trim()) {
      continue;
    }
    if (original.includes(LLAMA_CPP_PATCH_SENTINEL)) {
      return false;
    }
    const fallbackIndex = original.indexOf(fallbackNeedle);
    if (fallbackIndex === -1) {
      continue;
    }
    const patched = `${original.slice(0, fallbackIndex)}${patchBlock}\n${original.slice(fallbackIndex)}`;
    await fs.writeFile(target, patched, "utf8");
    return true;
  }

  throw new Error(`Unable to find get_vocab_base_pre() fallback in ${targets.join(" or ")}`);
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) {
    throw new Error("Usage: hf-download-worker.js <job-json-path>");
  }

  const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
  const headers = { "user-agent": HF_USER_AGENT };
  if (process.env.HF_TOKEN) {
    headers.authorization = `Bearer ${process.env.HF_TOKEN}`;
  }

  let bytesDownloaded = 0;
  const totalBytes = Number(job.totalBytes || 0);
  const isConvert = String(job.kind || "") === "convert";
  const downloadScale = isConvert ? CONVERSION_DOWNLOAD_PROGRESS_SCALE : 1;

  await updateJob(jobPath, {
    status: "running",
    message: isConvert ? "Downloading source weights" : "Downloading",
    progressPct: 0,
    bytesDownloaded: 0,
    totalBytes,
  });

  const targetDir = path.resolve(String(job.targetDir || ""));
  await fs.mkdir(targetDir, { recursive: true });
  await prepareConversionSourceTree(job, targetDir);

  for (const file of job.candidate.downloadSpec.files) {
    const relativePath = sanitizeRelativePath(file.path);
    const sourceRepoId = String(file.repoId || job.candidate.repoId || "").trim();
    const sourcePath = sanitizeRelativePath(file.sourcePath || file.path);
    const revision = String(file.revision || job.candidate.downloadSpec.revision || "main").trim() || "main";
    const destination = path.join(targetDir, relativePath);
    const expectedSize = Number(file.sizeBytes || 0);
    const existing = await fs.stat(destination).catch(() => null);

    // Unknown-size companions (cross-repo MTP drafts report sizeBytes 0) are
    // trusted when a non-empty copy already exists.
    if (existing?.isFile() && ((expectedSize > 0 && existing.size === expectedSize) || (expectedSize <= 0 && existing.size > 0))) {
      bytesDownloaded += expectedSize;
      await updateJob(jobPath, {
        status: "running",
        message: `Using existing ${relativePath}`,
        bytesDownloaded,
        progressPct: Math.round(calculateProgress(bytesDownloaded, totalBytes) * downloadScale),
      });
      continue;
    }

    const url = buildResolveUrl(sourceRepoId, revision, sourcePath);
    await downloadFile(
      url,
      destination,
      headers,
      expectedSize,
      async (chunkLength) => {
        bytesDownloaded += chunkLength;
        await throttledUpdate(jobPath, {
          status: "running",
          message: `Downloading ${relativePath}`,
          bytesDownloaded,
          progressPct: Math.round(calculateProgress(bytesDownloaded, totalBytes) * downloadScale),
        });
      },
      async (phase) => {
        await updateJob(jobPath, {
          status: "running",
          message: `${phase} ${relativePath}`,
          bytesDownloaded,
          progressPct: Math.round(calculateProgress(bytesDownloaded, totalBytes) * downloadScale),
        });
      },
    );
  }

  let conversionResult = null;
  if (isConvert) {
    conversionResult = await runConversionPipeline(job, jobPath, targetDir);
  }

  if (String(job.kind || "") === "companion") {
    // Companion jobs add a file to an existing model dir; merge the metadata
    // patch instead of overwriting the model's .llm3-hf.json.
    const resolvedTemplate = job.candidate?.template
      ? await materializeChatTemplate(targetDir, job.candidate, headers)
      : null;
    await mergeCompanionMetadata(targetDir, job.candidate, resolvedTemplate);
  } else {
    // The produced GGUF embeds a chat template, so a missing repo template
    // must not fail a conversion that already spent hours of compute.
    const resolvedTemplate = await materializeChatTemplate(targetDir, job.candidate, headers)
      .catch((error) => {
        if (!isConvert) {
          throw error;
        }
        return null;
      });
    const metadataCandidate = conversionResult
      ? {
          ...job.candidate,
          runtime: "gguf",
          name: conversionResult.fileName,
          fullName: `${job.candidate.repoId}/${conversionResult.fileName}`,
          quantization: conversionResult.quantization,
          vision: Boolean(conversionResult.mmprojFile),
        }
      : job.candidate;
    await writeMetadataFile(targetDir, metadataCandidate, resolvedTemplate);
  }
  await updateJob(jobPath, {
    status: "completed",
    message: conversionResult
      ? `Converted to ${conversionResult.quantization}${
        conversionResult.mmprojFile
          ? " (with vision projector)"
          : conversionResult.mmprojError
            ? " (vision projector export failed — text only)"
            : ""
      }`
      : "Download complete",
    bytesDownloaded: totalBytes || bytesDownloaded,
    progressPct: 100,
  });
}

async function mergeCompanionMetadata(targetDir, candidate, materializedTemplate = null) {
  const metadataPath = path.join(targetDir, ".llm3-hf.json");
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch (_error) {
    // Model dirs that predate llm3 metadata get a fresh minimal file.
  }
  const kind = String(candidate?.companion?.kind || "other");
  const file = Array.isArray(candidate?.downloadSpec?.files) ? candidate.downloadSpec.files[0] : null;
  const patch = { updatedAt: new Date().toISOString() };
  if (kind === "mtp" && file) {
    patch.mtpDraftFile = sanitizeRelativePath(file.path);
    patch.mtpDraftSourceRepoId = String(file.repoId || candidate.repoId || "").trim();
    patch.mtpDraftSourcePath = sanitizeRelativePath(file.sourcePath || file.path);
  }
  if (kind === "template" && materializedTemplate) {
    patch.chatTemplateFile = materializedTemplate.file;
    patch.chatTemplateSourceRepoId = materializedTemplate.sourceRepoId;
    patch.chatTemplateSourcePath = materializedTemplate.sourcePath;
  }
  if (kind === "mmproj") {
    patch.vision = true;
  }
  await fs.writeFile(metadataPath, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, "utf8");
}

let activeConversionChild = null;
const activeDownloadChildren = new Set();

function killActiveConversionChild() {
  if (activeConversionChild && activeConversionChild.exitCode === null) {
    try {
      // The converter/quantizer won't clean up either way; be decisive so a
      // cancelled job can't leave a torch process chewing CPU for an hour.
      activeConversionChild.kill("SIGKILL");
    } catch (_error) {
      // Already gone.
    }
  }
}

function trackChildProcess(child) {
  if (!child || typeof child.kill !== "function") {
    return child;
  }
  activeDownloadChildren.add(child);
  const cleanup = () => activeDownloadChildren.delete(child);
  child.once("error", cleanup);
  child.once("close", cleanup);
  return child;
}

function killActiveDownloadChildren() {
  for (const child of activeDownloadChildren) {
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch (_error) {
        // Already gone.
      }
    }
  }
  activeDownloadChildren.clear();
}

async function runConversionPipeline(job, jobPath, targetDir) {
  const conversion = job.conversion || {};
  const quantization = String(conversion.quantization || DEFAULT_CONVERSION_QUANTIZATION).trim().toUpperCase();
  const plan = CONVERSION_QUANT_PLANS[quantization];
  if (!plan) {
    throw new Error(`Unsupported quantization "${quantization}".`);
  }
  const llamaCppDir = await ensureLlamaCppCheckout(jobPath);
  const converterPath = path.join(llamaCppDir, "convert_hf_to_gguf.py");
  const toolsDir = path.resolve(String(process.env.HF_TOOLS_DIR || path.dirname(llamaCppDir)));
  const sourceDir = path.join(targetDir, sanitizeRelativePath(conversion.sourceDir || ".source"));
  if (!fsSync.existsSync(path.join(sourceDir, "config.json"))) {
    throw new Error("Conversion source is missing config.json — the source repo layout is not a convertible transformers checkpoint.");
  }
  const sourceConfig = JSON.parse(await fs.readFile(path.join(sourceDir, "config.json"), "utf8"));
  const compatibilityError = inspectConversionSourceCompatibility(sourceConfig, {
    ...job.candidate,
    sourceRepoId: String(conversion.sourceRepoId || "").trim(),
    requestedRepoId: String(job.candidate?.repoId || "").trim(),
  });
  if (compatibilityError) {
    throw new Error(compatibilityError);
  }

  const weightBytes = (job.candidate?.downloadSpec?.files || [])
    .filter((entry) => /\.(safetensors|bin)$/i.test(String(entry?.path || "")))
    .reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0);
  const intermediateBytes = plan.method === "quantize" ? weightBytes : 0;
  await assertFreeDiskSpace(targetDir, intermediateBytes + weightBytes * plan.sizeFactor + 1e9);

  await updateJob(jobPath, {
    message: "Preparing conversion toolchain (first run can take several minutes)",
    progressPct: 46,
  });
  const python = await ensureConverterPython(toolsDir, llamaCppDir, jobPath);
  await applyLlamaCppCompatPatches(converterPath);

  const baseName = deriveConversionBaseName(job.candidate);
  const finalName = `${baseName}-${quantization}.gguf`;
  const finalPath = path.join(targetDir, finalName);
  // Write through a partial name and rename on success so a crashed run can't
  // leave a half-written .gguf that looks like a finished conversion.
  const partialPath = `${finalPath}.partial-${process.pid}`;

  try {
    if (plan.method === "direct") {
      await runLoggedCommand(python, [converterPath, sourceDir, "--outfile", partialPath, "--outtype", plan.outtype], {
        jobPath,
        cwd: llamaCppDir,
        label: `Converting to ${quantization}`,
        progress: { path: partialPath, expectedBytes: weightBytes * plan.sizeFactor, fromPct: 48, toPct: 97 },
      });
    } else {
      const intermediatePath = path.join(targetDir, `${baseName}.bf16-intermediate-${process.pid}.tmp`);
      try {
        await runLoggedCommand(python, [converterPath, sourceDir, "--outfile", intermediatePath, "--outtype", "bf16"], {
          jobPath,
          cwd: llamaCppDir,
          label: "Converting to GGUF (bf16 intermediate)",
          progress: { path: intermediatePath, expectedBytes: weightBytes, fromPct: 48, toPct: 78 },
        });
        const quantizeBinary = await ensureQuantizeBinary(llamaCppDir, jobPath);
        await runLoggedCommand(quantizeBinary, [intermediatePath, partialPath, quantization], {
          jobPath,
          label: `Quantizing to ${quantization}`,
          progress: { path: partialPath, expectedBytes: weightBytes * plan.sizeFactor, fromPct: 82, toPct: 98 },
        });
      } finally {
        await fs.rm(intermediatePath, { force: true }).catch(() => {});
      }
    }
    await fs.rename(partialPath, finalPath);
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }

  const mmproj = await exportVisionProjector({
    sourceConfig,
    python,
    converterPath,
    llamaCppDir,
    sourceDir,
    targetDir,
    baseName,
    jobPath,
  });

  await updateJob(jobPath, { message: "Cleaning up source weights", progressPct: 99 });
  await fs.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
  return { fileName: finalName, quantization, mmprojFile: mmproj.file, mmprojError: mmproj.error };
}

// A multimodal checkpoint keeps its encoder config next to the text config;
// llama.cpp exports that half as a separate mmproj GGUF, which the launcher
// picks up automatically (find_mmproj in bin/qwen_llama).
function sourceHasMultimodalEncoder(config) {
  if (!config || typeof config !== "object") {
    return false;
  }
  return Boolean(
    config.vision_config
    || config.vision_encoder
    || config.audio_config
    || config.whisper_config
    || config.vision_tower_config
  );
}

// Best-effort by design: the text GGUF is already on disk by the time this
// runs, and an arch llama.cpp can't project must not throw hours of conversion
// away. A failure is reported in the job log and the model stays text-only.
async function exportVisionProjector({
  sourceConfig,
  python,
  converterPath,
  llamaCppDir,
  sourceDir,
  targetDir,
  baseName,
  jobPath,
}) {
  if (!sourceHasMultimodalEncoder(sourceConfig)) {
    return { file: "", error: "" };
  }
  const mmprojName = `mmproj-${baseName}-f16.gguf`;
  const mmprojPath = path.join(targetDir, mmprojName);
  if (fsSync.existsSync(mmprojPath)) {
    return { file: mmprojName, error: "" };
  }
  const partialPath = `${mmprojPath}.partial-${process.pid}`;
  await updateJob(jobPath, { message: "Exporting vision projector (mmproj)", progressPct: 98 });
  try {
    await runLoggedCommand(
      python,
      [converterPath, sourceDir, "--mmproj", "--outfile", partialPath, "--outtype", "f16"],
      { jobPath, cwd: llamaCppDir, label: "Exporting vision projector (mmproj)" },
    );
    await fs.rename(partialPath, mmprojPath);
    return { file: mmprojName, error: "" };
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => {});
    return { file: "", error: String(error?.message || error).slice(0, 300) };
  }
}

const LLAMA_CPP_REPO_URL = "https://github.com/ggml-org/llama.cpp";

async function ensureLlamaCppCheckout(jobPath) {
  if (!process.env.HF_LLAMA_CPP_DIR) {
    throw new Error("HF_LLAMA_CPP_DIR is not set.");
  }
  const llamaCppDir = path.resolve(process.env.HF_LLAMA_CPP_DIR);
  if (fsSync.existsSync(path.join(llamaCppDir, "convert_hf_to_gguf.py"))) {
    return llamaCppDir;
  }
  if (fsSync.existsSync(llamaCppDir)) {
    // Don't clone over (or delete) a directory we don't fully own — it may be
    // a user-managed checkout that just moved its converter script.
    throw new Error(`llama.cpp checkout at ${llamaCppDir} exists but is missing convert_hf_to_gguf.py.`);
  }
  await fs.mkdir(path.dirname(llamaCppDir), { recursive: true });
  await runLoggedCommand("git", ["clone", "--depth", "1", LLAMA_CPP_REPO_URL, llamaCppDir], {
    jobPath,
    label: "Fetching llama.cpp tools (first run only)",
  });
  if (!fsSync.existsSync(path.join(llamaCppDir, "convert_hf_to_gguf.py"))) {
    throw new Error(`Cloned llama.cpp at ${llamaCppDir} is missing convert_hf_to_gguf.py.`);
  }
  return llamaCppDir;
}

function deriveConversionBaseName(candidate) {
  const rawName = String(candidate?.name || candidate?.repoId || "model").split("/").at(-1) || "model";
  const trimmed = rawName.replace(/[-_.]gguf$/i, "").trim();
  return (trimmed || "model").replace(/[^\w.-]+/g, "-");
}

async function ensureConverterPython(toolsDir, llamaCppDir, jobPath) {
  const venvDir = path.join(toolsDir, "convert-venv");
  const python = path.join(venvDir, "bin", "python");
  const requirementsPath = path.join(llamaCppDir, "requirements", "requirements-convert_hf_to_gguf.txt");
  if (!fsSync.existsSync(requirementsPath)) {
    throw new Error(`Missing converter requirements file: ${requirementsPath}`);
  }
  const stampPath = path.join(venvDir, ".llm3-deps-ok");
  const requirementsHash = crypto.createHash("sha256").update(await fs.readFile(requirementsPath)).digest("hex");
  const stamped = await fs.readFile(stampPath, "utf8").catch(() => "");
  if (fsSync.existsSync(python) && stamped.trim() === requirementsHash) {
    return python;
  }

  const uvBinary = findUvBinary();
  if (uvBinary) {
    if (!fsSync.existsSync(python)) {
      await runLoggedCommand(uvBinary, ["venv", venvDir], { jobPath, label: "Creating converter venv" });
    }
    // llama.cpp's requirements pull torch from an --extra-index-url; uv's
    // default first-match strategy refuses mixed indexes, while pip (which
    // these files were written for) considers all indexes equally.
    await runLoggedCommand(uvBinary, ["pip", "install", "--python", python, "--index-strategy", "unsafe-best-match", "-r", requirementsPath], {
      jobPath,
      label: "Installing converter dependencies (first run only)",
    });
  } else {
    if (!fsSync.existsSync(python)) {
      await runLoggedCommand("python3", ["-m", "venv", venvDir], { jobPath, label: "Creating converter venv" });
    }
    await runLoggedCommand(python, ["-m", "pip", "install", "-r", requirementsPath], {
      jobPath,
      label: "Installing converter dependencies (first run only)",
    });
  }
  await fs.writeFile(stampPath, `${requirementsHash}\n`, "utf8");
  return python;
}

function findUvBinary() {
  const candidates = [
    ...String(process.env.PATH || "").split(":").filter(Boolean).map((dir) => path.join(dir, "uv")),
    path.join(process.env.HOME || "", ".local", "bin", "uv"),
  ];
  return candidates.find((candidate) => candidate && fsSync.existsSync(candidate)) || "";
}

// A binary can exist and still be unusable: a build made under a different
// state dir (an e2e run, a moved checkout) bakes an @rpath that no longer
// resolves, and the only symptom is a dyld abort in the middle of a
// multi-hour conversion. Probe it before trusting it.
async function quantizeBinaryRuns(binary) {
  return new Promise((resolve) => {
    const child = spawn(binary, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(!/Library not loaded|image not found|dyld\[/i.test(output)));
  });
}

async function ensureQuantizeBinary(llamaCppDir, jobPath) {
  const buildDir = path.join(llamaCppDir, "build-llm3-tools");
  const binary = path.join(buildDir, "bin", "llama-quantize");
  if (fsSync.existsSync(binary)) {
    if (await quantizeBinaryRuns(binary)) {
      return binary;
    }
    await updateJob(jobPath, { message: "Rebuilding llama-quantize (previous build is unusable)" });
    await fs.rm(buildDir, { recursive: true, force: true });
  }
  await runLoggedCommand("cmake", [
    "-S", llamaCppDir,
    "-B", buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DGGML_METAL=OFF",
    "-DLLAMA_CURL=OFF",
    "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_SERVER=OFF",
  ], { jobPath, label: "Configuring llama-quantize build (first run only)" });
  await runLoggedCommand("cmake", ["--build", buildDir, "--target", "llama-quantize", "-j"], {
    jobPath,
    label: "Building llama-quantize (first run only)",
  });
  if (!fsSync.existsSync(binary)) {
    throw new Error("llama-quantize binary was not produced by the build.");
  }
  return binary;
}

function runLoggedCommand(command, args, options = {}) {
  const { jobPath = "", cwd = undefined, progress = null } = options;
  const label = String(options.label || path.basename(String(command || "")));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    activeConversionChild = child;
    let tail = "";
    const appendTail = (chunk) => {
      tail = `${tail}${chunk}`.slice(-4000);
    };
    child.stdout.on("data", (chunk) => appendTail(String(chunk)));
    child.stderr.on("data", (chunk) => appendTail(String(chunk)));

    let timer = null;
    if (jobPath) {
      timer = setInterval(async () => {
        const lastLine = tail.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) || "";
        const patch = { message: lastLine ? `${label} — ${lastLine.slice(0, 160)}` : label };
        if (progress?.path && Number(progress.expectedBytes) > 0) {
          const stat = await fs.stat(progress.path).catch(() => null);
          if (stat?.isFile()) {
            const ratio = Math.min(stat.size / Number(progress.expectedBytes), 0.98);
            patch.progressPct = Math.round(progress.fromPct + (progress.toPct - progress.fromPct) * ratio);
          }
        }
        await updateJob(jobPath, patch).catch(() => {});
      }, 1500);
    }

    const finish = (callback) => {
      if (timer) {
        clearInterval(timer);
      }
      if (activeConversionChild === child) {
        activeConversionChild = null;
      }
      callback();
    };
    child.on("error", (error) => {
      finish(() => reject(new Error(`${label} failed to start: ${error.message}`)));
    });
    child.on("close", (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve(tail);
          return;
        }
        const detail = tail.split("\n").map((line) => line.trim()).filter(Boolean).slice(-4).join(" | ").slice(-600);
        reject(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit ${code}`})${detail ? `: ${detail}` : ""}`));
      });
    });
  });
}

async function assertFreeDiskSpace(targetDir, requiredBytes) {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0 || typeof fs.statfs !== "function") {
    return;
  }
  let stats = null;
  try {
    stats = await fs.statfs(targetDir);
  } catch (_error) {
    return;
  }
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  if (freeBytes < requiredBytes) {
    const toGb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
    throw new Error(`Not enough free disk space for conversion: need ~${toGb(requiredBytes)}, have ${toGb(freeBytes)}.`);
  }
}

function sanitizeRelativePath(value) {
  const normalized = String(value || "").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid download path: ${value}`);
  }
  return normalized;
}

function buildResolveUrl(repoId, revision, filePath) {
  const encodedRepo = String(repoId || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const encodedRevision = encodeURIComponent(String(revision || "main"));
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://huggingface.co/${encodedRepo}/resolve/${encodedRevision}/${encodedPath}?download=1`;
}

function buildDownloadParts(totalBytes, partBytes = PARALLEL_DOWNLOAD_PART_BYTES) {
  const normalizedTotal = Number(totalBytes || 0);
  const normalizedPartBytes = Math.max(1, Number(partBytes || PARALLEL_DOWNLOAD_PART_BYTES));
  if (!Number.isFinite(normalizedTotal) || normalizedTotal <= 0) {
    return [];
  }
  const parts = [];
  for (let start = 0, index = 0; start < normalizedTotal; start += normalizedPartBytes, index += 1) {
    const end = Math.min(start + normalizedPartBytes, normalizedTotal) - 1;
    parts.push({ index, start, end, size: end - start + 1 });
  }
  return parts;
}

async function supportsParallelDownload(url, headers, expectedSize) {
  if (!Number.isFinite(expectedSize) || expectedSize < PARALLEL_DOWNLOAD_MIN_BYTES) {
    return false;
  }
  const response = await fetch(url, {
    headers: {
      ...headers,
      range: "bytes=0-0",
    },
    redirect: "follow",
  });
  try {
    if (response.status !== 206) {
      return false;
    }
    const contentRange = String(response.headers.get("content-range") || "").trim();
    if (!/^bytes\s+0-0\/\d+$/i.test(contentRange)) {
      return false;
    }
    const total = Number(contentRange.split("/").at(-1) || 0);
    return total === expectedSize;
  } finally {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch (_error) {
        // Ignore probe cleanup failures.
      }
    }
  }
}

async function appendFileToWriter(sourcePath, writer) {
  const chunk = await fs.readFile(sourcePath);
  await writeChunk(writer, chunk);
}

function buildCurlHeaderArgs(headers) {
  return Object.entries(headers || {})
    .filter(([, value]) => value != null && String(value).trim())
    .flatMap(([name, value]) => ["-H", `${name}: ${String(value).trim()}`]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCurlCommand(args) {
  return new Promise((resolve, reject) => {
    const child = trackChildProcess(spawn("curl", args, { stdio: ["ignore", "ignore", "pipe"] }));
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    child.on("error", (error) => reject(new Error(`curl failed to start: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.split("\n").map((line) => line.trim()).filter(Boolean).slice(-4).join(" | ").slice(-600);
      reject(new Error(`curl download failed (${signal ? `signal ${signal}` : `exit ${code}`})${detail ? `: ${detail}` : ""}`));
    });
  });
}

async function watchFileProgress(filePaths, onChunk, work) {
  const knownSizes = new Map();
  for (const filePath of filePaths) {
    const stat = await fs.stat(filePath).catch(() => null);
    knownSizes.set(filePath, stat?.isFile() ? stat.size : 0);
  }
  let finished = false;
  let pollError = null;
  const poll = async () => {
    while (!finished) {
      for (const filePath of filePaths) {
        const stat = await fs.stat(filePath).catch(() => null);
        const nextSize = stat?.isFile() ? stat.size : 0;
        const prevSize = knownSizes.get(filePath) || 0;
        // Deltas are signed on purpose: a retried range restarts its part file
        // from zero, and reporting the drop keeps the job's byte counter honest
        // instead of counting the redone bytes twice.
        if (nextSize !== prevSize && typeof onChunk === "function") {
          await onChunk(nextSize - prevSize);
        }
        knownSizes.set(filePath, nextSize);
      }
      await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_PROGRESS_POLL_MS));
    }
  };
  const pollPromise = poll().catch((error) => {
    pollError = error;
  });
  try {
    await work();
  } finally {
    finished = true;
    await pollPromise;
  }
  if (pollError) {
    throw pollError;
  }
}

// Reports bytes while the range is in flight, not only when it lands: a 64MB
// part that reports on completion alone leaves the job's counter frozen for
// minutes at a time, which reads as a hung download.
async function downloadRangeToFile(url, partPath, headers, part, onChunk) {
  await fs.mkdir(path.dirname(partPath), { recursive: true });
  const existing = await fs.stat(partPath).catch(() => null);
  if (existing?.isFile() && existing.size > part.size) {
    await fs.rm(partPath, { force: true });
  }
  const present = await fs.stat(partPath).catch(() => null);
  const presentBytes = present?.isFile() ? present.size : 0;
  if (presentBytes >= part.size) {
    if (typeof onChunk === "function") {
      await onChunk(part.size);
    }
    return;
  }
  if (presentBytes > 0) {
    await fs.rm(partPath, { force: true });
  }
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_CURL_DOWNLOAD_ATTEMPTS; attempt += 1) {
    await fs.rm(partPath, { force: true }).catch(() => {});
    const curlArgs = [
      "--location",
      "--fail",
      "--silent",
      "--show-error",
      "--retry",
      "0",
      // Abandon a connection that has flatlined rather than letting one dead
      // socket hold the whole job open; the retry below picks the part back up.
      "--speed-limit",
      String(CURL_STALL_BYTES_PER_SECOND),
      "--speed-time",
      String(CURL_STALL_SECONDS),
      ...buildCurlHeaderArgs(headers),
      "--range",
      `${part.start}-${part.end}`,
      "--output",
      partPath,
      url,
    ];
    // Only this part's file is polled, so an in-flight range costs one stat per
    // tick no matter how many parts the file splits into.
    let reported = 0;
    const report = async (delta) => {
      reported += delta;
      if (typeof onChunk === "function") {
        await onChunk(delta);
      }
    };
    try {
      await watchFileProgress([partPath], report, () => runCurlCommand(curlArgs));
      // The poller stops the moment curl exits; settle up with the real size.
      const stat = await fs.stat(partPath).catch(() => null);
      const finalSize = stat?.isFile() ? stat.size : 0;
      if (finalSize !== reported) {
        await report(finalSize - reported);
      }
      return;
    } catch (error) {
      lastError = error;
      // The next attempt re-downloads this range from zero, so give back what
      // the failed attempt already counted instead of double counting it.
      if (reported !== 0) {
        await report(-reported);
      }
      if (attempt >= MAX_CURL_DOWNLOAD_ATTEMPTS) {
        break;
      }
      await sleep(CURL_DOWNLOAD_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError || new Error("curl download failed");
}

async function downloadFileInParallel(url, destination, headers, expectedSize, onChunk, onPhase) {
  const tempPath = `${destination}.partial-${process.pid}`;
  const partsDir = `${tempPath}.parts`;
  const parts = buildDownloadParts(expectedSize);
  const partPaths = parts.map((part) => path.join(partsDir, `${String(part.index).padStart(6, "0")}.part`));
  const concurrency = Math.max(1, Math.min(MAX_PARALLEL_DOWNLOADS, parts.length));
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < parts.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await downloadRangeToFile(url, partPaths[currentIndex], headers, parts[currentIndex], onChunk);
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    // Assembling a 31GB file out of its parts takes minutes and moves no
    // counters; say so rather than leaving the last message frozen.
    if (typeof onPhase === "function") {
      await onPhase("Assembling");
    }
    const writer = fsSync.createWriteStream(tempPath);
    try {
      for (const partPath of partPaths) {
        await appendFileToWriter(partPath, writer);
      }
      await closeWriter(writer);
    } catch (error) {
      writer.destroy();
      throw error;
    }
    await fs.rename(tempPath, destination);
  } finally {
    await fs.rm(partsDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

// Same client as the ranged path, for files that can't be split (unknown size,
// no range support) or that fall under the parallel floor. curl is ~10x faster
// than node's fetch against the HF CDN here, so fetch is only the last resort
// when curl is missing from the box.
async function downloadFileWithCurl(url, destination, headers, onChunk) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.partial-${process.pid}`;
  await fs.rm(tempPath, { force: true }).catch(() => {});
  let reported = 0;
  const report = async (delta) => {
    reported += delta;
    if (typeof onChunk === "function") {
      await onChunk(delta);
    }
  };

  try {
    await watchFileProgress([tempPath], report, () => runCurlCommand([
      "--location",
      "--fail",
      "--silent",
      "--show-error",
      "--retry",
      "0",
      ...buildCurlHeaderArgs(headers),
      "--output",
      tempPath,
      url,
    ]));
    // The poller stops the moment curl exits, so settle up with the real size
    // rather than leaving the job's byte counter short by the last poll gap.
    const stat = await fs.stat(tempPath);
    if (stat.size > reported) {
      await report(stat.size - reported);
    }
    await fs.rename(tempPath, destination);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function downloadFile(url, destination, headers, expectedSize, onChunk, onPhase) {
  if (await supportsParallelDownload(url, headers, expectedSize).catch(() => false)) {
    await downloadFileInParallel(url, destination, headers, expectedSize, onChunk, onPhase);
    return;
  }
  try {
    await downloadFileWithCurl(url, destination, headers, onChunk);
    return;
  } catch (error) {
    if (!/curl failed to start/i.test(String(error?.message || ""))) {
      throw error;
    }
  }
  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.partial-${process.pid}`;
  const writer = fsSync.createWriteStream(tempPath);
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      await writeChunk(writer, Buffer.from(value));
      if (typeof onChunk === "function") {
        await onChunk(value.length);
      }
    }
    await closeWriter(writer);
    await fs.rename(tempPath, destination);
  } catch (error) {
    writer.destroy();
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function writeChunk(writer, chunk) {
  return new Promise((resolve, reject) => {
    writer.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function closeWriter(writer) {
  return new Promise((resolve, reject) => {
    writer.end((error) => (error ? reject(error) : resolve()));
  });
}

async function writeMetadataFile(targetDir, candidate, materializedTemplate = null) {
  const metadataPath = path.join(targetDir, ".llm3-hf.json");
  const payload = {
    source: "huggingface",
    repoId: candidate.repoId,
    hfUrl: candidate.hfUrl,
    label: isSnapshotRuntime(candidate.runtime) ? candidate.name : "",
    family: candidate.family,
    quantization: candidate.quantization || "",
    runtime: candidate.runtime,
    aliases: buildAliases(candidate),
    updatedAt: new Date().toISOString(),
    ...(candidate.vision === true ? { vision: true } : {}),
  };
  const templateMetadata = await resolveTemplateMetadata(targetDir, candidate, materializedTemplate);
  if (templateMetadata) {
    payload.chatTemplateFile = templateMetadata.file;
    payload.chatTemplateSourceRepoId = templateMetadata.sourceRepoId;
    payload.chatTemplateSourcePath = templateMetadata.sourcePath;
  }
  const mtpDraftMetadata = resolveMtpDraftMetadata(candidate);
  if (mtpDraftMetadata) {
    payload.mtpDraftFile = mtpDraftMetadata.file;
    payload.mtpDraftSourceRepoId = mtpDraftMetadata.sourceRepoId;
    payload.mtpDraftSourcePath = mtpDraftMetadata.sourcePath;
  }
  await fs.writeFile(metadataPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function buildAliases(candidate) {
  const aliases = [
    candidate.repoId,
    candidate.name,
    candidate.fullName,
  ];
  if (candidate.runtime === "gguf") {
    aliases.push(path.basename(String(candidate.name || ""), ".gguf"));
  }
  return [...new Set(aliases.map((value) => String(value || "").trim()).filter(Boolean))];
}

function calculateProgress(bytesDownloaded, totalBytes) {
  if (!totalBytes || totalBytes <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100)));
}

async function materializeChatTemplate(targetDir, candidate, headers) {
  const outputPath = String(candidate?.template?.outputPath || "").trim();
  const sources = Array.isArray(candidate?.template?.sources) ? candidate.template.sources : [];
  if (!outputPath) {
    return null;
  }

  const relativeOutputPath = sanitizeRelativePath(outputPath);
  const destination = path.join(targetDir, relativeOutputPath);

  // A GGUF's own tokenizer.chat_template is authoritative: it is the template
  // the quantizer shipped and validated against THIS file's tokenizer. The repo
  // sources below fall back to the *base* transformers repo, which is a
  // different artifact — it can sit at a newer revision than the quant, and it
  // loses fixes the quantizer applied on top of it (unsloth and friends
  // routinely patch template bugs at quant time). Because llm3 launches
  // llama-server with --chat-template-file, whatever lands here OVERRIDES the
  // GGUF, so preferring the repo copy silently swapped in a template the
  // weights were never packaged with. Prefer embedded, fall back to the repo.
  if (String(candidate?.runtime || "") === "gguf") {
    const ggufPath = await findPrimaryGgufFile(targetDir);
    const embedded = ggufPath ? await extractEmbeddedGgufChatTemplate(ggufPath).catch(() => "") : "";
    if (embedded) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, `${embedded.trimEnd()}\n`, "utf8");
      return {
        file: relativeOutputPath,
        sourceRepoId: String(candidate?.repoId || "").trim(),
        sourcePath: "tokenizer.chat_template",
      };
    }
  }

  if (sources.length === 0) {
    return null;
  }

  for (const source of sources) {
    const sourceRepoId = String(source?.repoId || "").trim();
    const sourcePath = sanitizeRelativePath(source?.path || "");
    const revision = String(source?.revision || "main").trim() || "main";
    if (!sourceRepoId || !sourcePath) {
      continue;
    }
    const url = buildResolveUrl(sourceRepoId, revision, sourcePath);
    const payload = await downloadOptionalText(url, headers);
    if (payload == null) {
      continue;
    }
    const templateText = extractTemplateText(sourcePath, payload);
    if (!templateText) {
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, `${templateText.trimEnd()}\n`, "utf8");
    return {
      file: relativeOutputPath,
      sourceRepoId,
      sourcePath,
    };
  }
  // A GGUF carries its own tokenizer.chat_template, so llama.cpp can run it
  // without an external file. Failing a completed download over a missing
  // sidecar threw away a finished 103GB pull for a file that was never needed.
  if (String(candidate?.runtime || "") === "gguf") {
    return null;
  }
  throw new Error(`Unable to resolve chat template for ${candidate?.repoId || "download"}`);
}

async function downloadOptionalText(url, headers) {
  const response = await fetch(url, { headers, redirect: "follow" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

function extractTemplateText(sourcePath, payload) {
  if (typeof payload !== "string" || !payload.trim()) {
    return "";
  }
  if (/tokenizer_config\.json$/i.test(String(sourcePath || ""))) {
    try {
      const parsed = JSON.parse(payload);
      const template = parsed?.chat_template;
      return typeof template === "string" ? template.trim() : "";
    } catch (_error) {
      return "";
    }
  }
  if (/chat_template\.json$/i.test(String(sourcePath || ""))) {
    try {
      const parsed = JSON.parse(payload);
      const template = parsed?.chat_template ?? parsed?.template;
      return typeof template === "string" ? template.trim() : "";
    } catch (_error) {
      return "";
    }
  }
  return payload.trim();
}

async function resolveTemplateMetadata(targetDir, candidate, materializedTemplate) {
  if (materializedTemplate?.file) {
    return materializedTemplate;
  }

  const candidatePaths = [
    String(candidate?.template?.outputPath || "").trim(),
    isSnapshotRuntime(candidate?.runtime) ? "chat_template.jinja" : "",
  ].filter(Boolean);

  for (const relativePath of candidatePaths) {
    const normalizedPath = sanitizeRelativePath(relativePath);
    const existing = await fs.readFile(path.join(targetDir, normalizedPath), "utf8").catch(() => "");
    if (!existing.trim()) {
      continue;
    }
    return {
      file: normalizedPath,
      sourceRepoId: candidate.repoId,
      sourcePath: normalizedPath,
    };
  }
  if (candidate?.runtime === "gguf") {
    const ggufPath = await findPrimaryGgufFile(targetDir);
    if (ggufPath) {
      const template = await extractEmbeddedGgufChatTemplate(ggufPath).catch(() => "");
      if (template) {
        const outputPath = ".llm3-chat-template.jinja";
        await fs.writeFile(path.join(targetDir, outputPath), `${template.trimEnd()}\n`, "utf8");
        return {
          file: outputPath,
          sourceRepoId: candidate.repoId,
          sourcePath: "tokenizer.chat_template",
        };
      }
    }
  }
  return null;
}

function resolveMtpDraftMetadata(candidate) {
  const draft = candidate?.mtpDraft;
  if (!draft) {
    return null;
  }
  const file = sanitizeRelativePath(draft.outputPath || draft.sourcePath || "");
  if (!file) {
    return null;
  }
  return {
    file,
    sourceRepoId: String(draft.repoId || candidate.repoId || "").trim(),
    sourcePath: sanitizeRelativePath(draft.sourcePath || file),
  };
}

async function updateJob(jobPath, patch) {
  const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
  const next = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(jobPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

// Signal handlers cannot await. A promise-based write loses the race against
// process.exit, so the interrupt note is written with the synchronous API.
function updateJobSync(jobPath, patch) {
  try {
    const job = JSON.parse(fsSync.readFileSync(jobPath, "utf8"));
    const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
    fsSync.writeFileSync(jobPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (_error) {
    // The job file may already be gone (cleared while the worker ran).
  }
}

// A cancel is delivered as the same signal, but the server flags the job first
// and reports the outcome itself. Overwriting the message here would relabel a
// deliberate cancel as an interruption.
function isCancellationRequested(jobPath) {
  try {
    const job = JSON.parse(fsSync.readFileSync(jobPath, "utf8"));
    return Boolean(job?.cancelRequested) || String(job?.status || "").toLowerCase() === "cancelling";
  } catch (_error) {
    return false;
  }
}

let lastUpdateAt = 0;

async function throttledUpdate(jobPath, patch) {
  const now = Date.now();
  if (now - lastUpdateAt < 250) {
    return;
  }
  lastUpdateAt = now;
  await updateJob(jobPath, patch);
}

if (require.main === module) {
  // The server cancels jobs by signalling this worker; without a handler the
  // process would die leaving a spawned converter/quantizer running orphaned.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      killActiveConversionChild();
      killActiveDownloadChildren();
      // Record why the job stopped before exiting. Without this the server's
      // reconciler only sees a dead pid and marks the job "failed" carrying
      // whatever progress line was last written -- which reads as if the file
      // itself failed, when the real cause was this process being signalled.
      // Cancellation is left alone: the server reports that on its own.
      const jobPath = process.argv[2];
      if (jobPath && !isCancellationRequested(jobPath)) {
        updateJobSync(jobPath, {
          status: "failed",
          message: "Interrupted — llm3 stopped or restarted. Re-queue to resume; finished files are kept.",
        });
      }
      process.exit(signal === "SIGTERM" ? 143 : 130);
    });
  }
  main().catch(async (error) => {
    killActiveConversionChild();
    killActiveDownloadChildren();
    const jobPath = process.argv[2];
    if (jobPath) {
      try {
        await updateJob(jobPath, {
          status: "failed",
          message: error.message || String(error),
        });
      } catch (_innerError) {
        // Ignore secondary failure.
      }
    }
    process.exitCode = 1;
  });
}

module.exports = {
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
};
