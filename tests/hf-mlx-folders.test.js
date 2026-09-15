// MLX repos routinely ship several complete models in sibling folders (4-bit/, 6-bit/,
// 8-bit/) plus an mtp/ draft head, sometimes with a model at the repo root too.
// buildHfCandidates used to hand back the whole repo as ONE candidate, so the HF tab
// showed a single row that would have pulled every quant into one directory --
// ~82 GiB for orcarouter/Qwen3.8-27B-MLX, and unloadable, since MLX wants exactly one
// config.json beside its weights.
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildHfCandidates, normalizeDownloadCandidate } = require("../src/server.js");

const GB = 1_000_000_000;
const file = (rfilename, gb = 0) => ({ rfilename, lfs: { size: Math.round(gb * GB) } });

// Mirrors orcarouter/Qwen3.8-27B-MLX.
function multiFolderRepo() {
  const variant = (dir, shards) => [
    file(`${dir}config.json`),
    file(`${dir}tokenizer.json`, 0.02),
    ...Array.from({ length: shards }, (_, i) => file(`${dir}model-0000${i + 1}-of-0000${shards}.safetensors`, 5)),
  ];
  return {
    id: "orcarouter/Qwen3.8-27B-MLX",
    sha: "abc123",
    tags: ["mlx"],
    siblings: [
      file(".gitattributes"),
      file("README.md"),
      ...variant("", 3),
      ...variant("4-bit/", 3),
      ...variant("6-bit/", 5),
      ...variant("8-bit/", 6),
      // A draft head: config.json + weights, but nobody chats with it.
      file("mtp/config.json"),
      file("mtp/model.safetensors", 0.8),
    ],
  };
}

test("each MLX model folder becomes its own candidate", () => {
  const candidates = buildHfCandidates(multiFolderRepo());
  assert.deepEqual(
    candidates.map((entry) => entry.directory || "(root)"),
    ["(root)", "4-bit", "6-bit", "8-bit"],
  );
  // mtp/ is a draft companion, never a selectable model.
  assert.ok(!candidates.some((entry) => String(entry.directory || "") === "mtp"));
  assert.deepEqual(candidates.map((entry) => entry.quantization), ["", "4BIT", "6BIT", "8BIT"]);
});

test("a variant downloads only its own folder, not the whole repo", () => {
  const candidates = buildHfCandidates(multiFolderRepo());
  const sixBit = candidates.find((entry) => entry.directory === "6-bit");

  const sources = sixBit.downloadSpec.files.map((entry) => entry.sourcePath || entry.path);
  assert.ok(sources.every((p) => p.startsWith("6-bit/") || p.startsWith("mtp/")), sources.join(", "));
  assert.ok(!sources.some((p) => p.startsWith("4-bit/") || p.startsWith("8-bit/")));

  // The whole repo is ~82 GB; one variant must be its own size plus the small draft.
  assert.ok(sixBit.sizeBytes < 30 * GB, `expected one variant, got ${sixBit.sizeLabel}`);

  // Flattened locally: MLX needs config.json beside the weights, not under 6-bit/.
  assert.ok(sixBit.downloadSpec.files.some((entry) => entry.path === "config.json"));
  assert.ok(!sixBit.downloadSpec.files.some((entry) => entry.path.startsWith("6-bit/")));
  // ...while the draft head keeps its folder so the runtime can still find it.
  assert.ok(sixBit.downloadSpec.files.some((entry) => entry.path === "mtp/model.safetensors"));
});

test("the folder survives normalization, so variants get separate target directories", () => {
  const candidates = buildHfCandidates(multiFolderRepo());
  const dirs = candidates.map((entry) => normalizeDownloadCandidate(entry)?.directory || "(root)");
  // Without this every quant in the repo downloads over the top of the previous one.
  assert.deepEqual(dirs, ["(root)", "4-bit", "6-bit", "8-bit"]);
});

test("a flat single-model MLX repo is unchanged", () => {
  const repo = {
    id: "mlx-community/Qwen3.8-27B-8bit",
    sha: "def456",
    tags: ["mlx"],
    siblings: [file("config.json"), file("tokenizer.json", 0.02), file("model.safetensors", 29)],
  };
  const candidates = buildHfCandidates(repo);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].directory, undefined);
  assert.equal(candidates[0].name, "Qwen3.8-27B-8bit");
  assert.ok(candidates[0].downloadSpec.files.every((entry) => !entry.path.includes("/")));
});
