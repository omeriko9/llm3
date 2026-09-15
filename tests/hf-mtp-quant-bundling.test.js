const test = require("node:test");
const assert = require("node:assert/strict");

const {
  partitionMtpGgufPaths,
  buildHfCandidates,
  pruneForeignQuantFiles,
  normalizeDownloadCandidate,
  resolveHfDownloadCandidate,
} = require("../src/server.js");

function stubHfFetch(t, repo) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => repo });
  t.after(() => {
    globalThis.fetch = original;
  });
}

const GB = 1_000_000_000;

test("partitionMtpGgufPaths: -MTP-<quant> infix files are main quants, not draft heads", () => {
  // DavidAU-style repo: one plain quant + many "…-MTP-<quant>.gguf" full quants.
  const paths = [
    "Model-NEO-Q8_0.gguf",
    "Model-NEO-MTP-Q6_K.gguf",
    "Model-NEO-MTP-IQ4_XS.gguf",
    "Model-NEO-AMD-MTP-Q6_K.gguf",
  ];
  const { main, drafts } = partitionMtpGgufPaths(paths);
  assert.deepEqual(main.sort(), paths.slice().sort(), "every quant is a selectable main model");
  assert.deepEqual(drafts, [], "no infix quant is treated as a draft companion");
});

test("partitionMtpGgufPaths: genuine draft heads (mtp-*, MTP/) stay drafts", () => {
  const gemma = partitionMtpGgufPaths(["gemma-4-31B-Q8_0.gguf", "mtp-gemma-4-31B-it.gguf"]);
  assert.deepEqual(gemma.main, ["gemma-4-31B-Q8_0.gguf"]);
  assert.deepEqual(gemma.drafts, ["mtp-gemma-4-31B-it.gguf"]);

  const subdir = partitionMtpGgufPaths(["model-Q8_0.gguf", "MTP/model-MTP-Q8_0.gguf"]);
  assert.deepEqual(subdir.main, ["model-Q8_0.gguf"]);
  assert.deepEqual(subdir.drafts, ["MTP/model-MTP-Q8_0.gguf"]);
});

test("partitionMtpGgufPaths: a combined …-MTP.gguf model is main, and all-draft repos fall back to main", () => {
  assert.deepEqual(partitionMtpGgufPaths(["Qwen3.6-35BA3B-MTP.gguf"]).main, ["Qwen3.6-35BA3B-MTP.gguf"]);
  // Pathological: nothing but draft heads — surface them rather than hiding the repo.
  const allDrafts = partitionMtpGgufPaths(["mtp-a.gguf", "mtp-b.gguf"]);
  assert.deepEqual(allDrafts.main.sort(), ["mtp-a.gguf", "mtp-b.gguf"]);
  assert.deepEqual(allDrafts.drafts, []);
});

test("buildHfCandidates: selecting one quant does not drag in every other quant (285GB bug)", () => {
  const sibling = (rfilename, gb) => ({ rfilename, lfs: { size: Math.round(gb * GB) } });
  const repo = {
    id: "DavidAU/Qwen3.6-27B-Fable-MTP-GGUF",
    sha: "abc123",
    siblings: [
      sibling("Model-NEO-Q8_0.gguf", 29.79),
      sibling("Model-NEO-MTP-Q6_K.gguf", 24.03),
      sibling("Model-NEO-MTP-IQ4_XS.gguf", 17.03),
      sibling("Model-NEO-MTP-IQ2_M.gguf", 12.12),
      sibling("Model-NEO-AMD-MTP-Q6_K.gguf", 24.03),
      sibling("mmproj-F16.gguf", 0.93),
      sibling("mmproj-BF16.gguf", 0.93),
    ],
  };

  const candidates = buildHfCandidates(repo);
  const quantRows = candidates.filter((c) => c.runtime === "gguf");

  // Every full quant is offered as its own selectable row (5 model quants).
  assert.equal(quantRows.length, 5, "all quants appear as rows, none hidden as a companion");

  const q8 = quantRows.find((c) => c.name === "Model-NEO-Q8_0.gguf");
  assert.ok(q8, "the Q8_0 quant is a selectable candidate");

  const specPaths = q8.downloadSpec.files.map((f) => f.path).sort();
  // Only the selected quant + the mmproj vision projectors — NOT the other quants.
  assert.deepEqual(
    specPaths,
    ["Model-NEO-Q8_0.gguf", "mmproj-BF16.gguf", "mmproj-F16.gguf"].sort(),
    "download spec contains only the chosen quant + mmproj companions",
  );

  const specGB = q8.downloadSpec.files.reduce((s, f) => s + f.sizeBytes, 0) / GB;
  assert.ok(specGB < 35, `spec total ${specGB.toFixed(1)}GB should be ~31GB, not ~285GB`);
  // Guard against the exact regression: the other quants must be absent.
  for (const other of ["Model-NEO-MTP-Q6_K.gguf", "Model-NEO-MTP-IQ4_XS.gguf", "Model-NEO-AMD-MTP-Q6_K.gguf"]) {
    assert.ok(!specPaths.includes(other), `${other} must not be bundled into the Q8_0 download`);
  }
});

test("pruneForeignQuantFiles: keeps shards, mmproj and real drafts, drops other quants", () => {
  const file = (path) => ({ path, sizeBytes: 1 });
  const kept = pruneForeignQuantFiles([
    file("Model-NEO-Q6_K-00001-of-00003.gguf"),
    file("Model-NEO-Q6_K-00002-of-00003.gguf"),
    file("Model-NEO-Q6_K-00003-of-00003.gguf"),
    file("mmproj-F16.gguf"),
    file("mtp-model-neo.gguf"),
    file(".llm3-chat-template.jinja"),
    file("Model-NEO-Q8_0.gguf"),
    file("Model-NEO-MTP-IQ4_XS.gguf"),
  ]).map((entry) => entry.path);

  assert.ok(kept.includes("Model-NEO-Q6_K-00002-of-00003.gguf"), "sibling shards of the chosen quant stay");
  assert.ok(kept.includes("mmproj-F16.gguf"), "vision projectors stay");
  assert.ok(kept.includes("mtp-model-neo.gguf"), "genuine draft heads stay");
  assert.ok(kept.includes(".llm3-chat-template.jinja"), "non-GGUF sidecars stay");
  assert.ok(!kept.includes("Model-NEO-Q8_0.gguf"), "a different full quant is dropped");
  assert.ok(!kept.includes("Model-NEO-MTP-IQ4_XS.gguf"), "an MTP-infix full quant is dropped");
});

test("pruneForeignQuantFiles: leaves MLX repo snapshots untouched", () => {
  const files = [
    { path: "model-00001-of-00002.safetensors", sizeBytes: 1 },
    { path: "model-00002-of-00002.safetensors", sizeBytes: 1 },
    { path: "config.json", sizeBytes: 1 },
  ];
  assert.deepEqual(pruneForeignQuantFiles(files).map((entry) => entry.path), files.map((entry) => entry.path));
});

test("normalizeDownloadCandidate: a stale client payload cannot replay the 279GB whole-repo spec", () => {
  // Shape taken from the real cancelled job: Q6_K was chosen, but the cached
  // candidate carried every other quant in the repo as an "MTP companion".
  const GB2 = (gb) => Math.round(gb * GB);
  const staleCandidate = {
    id: "gguf:DavidAU/Repo-MTP-GGUF:Model-NEO-Q6_K.gguf",
    name: "Model-NEO-Q6_K.gguf",
    fullName: "DavidAU/Repo-MTP-GGUF/Model-NEO-Q6_K.gguf",
    repoId: "DavidAU/Repo-MTP-GGUF",
    runtime: "gguf",
    quantization: "Q6_K",
    sizeBytes: GB2(23.58),
    mtpDraft: {
      outputPath: "Model-NEO-AMD-MTP-IQ4_XS.gguf",
      sourcePath: "Model-NEO-AMD-MTP-IQ4_XS.gguf",
      repoId: "DavidAU/Repo-MTP-GGUF",
      revision: "ee5b744",
    },
    downloadSpec: {
      type: "single-file",
      runtime: "gguf",
      repoId: "DavidAU/Repo-MTP-GGUF",
      revision: "ee5b744",
      files: [
        { path: "Model-NEO-Q6_K.gguf", sizeBytes: GB2(23.58) },
        { path: "mmproj-BF16.gguf", sizeBytes: GB2(0.93) },
        { path: "mmproj-F16.gguf", sizeBytes: GB2(0.93) },
        { path: "mmproj-F32.gguf", sizeBytes: GB2(1.84) },
        { path: "Model-NEO-AMD-MTP-IQ4_XS.gguf", sizeBytes: GB2(16.81) },
        { path: "Model-NEO-AMD-MTP-Q6_K.gguf", sizeBytes: GB2(24.03) },
        { path: "Model-NEO-MTP-Q8_0.gguf", sizeBytes: GB2(30.24) },
        { path: "Model-NEO-MTP-Q5_K_M.gguf", sizeBytes: GB2(21.18) },
      ],
    },
  };

  const normalized = normalizeDownloadCandidate(staleCandidate);
  const paths = normalized.downloadSpec.files.map((entry) => entry.path).sort();
  assert.deepEqual(
    paths,
    ["Model-NEO-Q6_K.gguf", "mmproj-BF16.gguf", "mmproj-F16.gguf", "mmproj-F32.gguf"].sort(),
    "only the chosen quant and its vision projectors survive",
  );
  const totalGB = normalized.downloadSpec.files.reduce((sum, entry) => sum + entry.sizeBytes, 0) / GB;
  assert.ok(totalGB < 30, `queued total ${totalGB.toFixed(1)}GB should be ~27GB, not ~279GB`);
  assert.equal(normalized.mtpDraft, undefined, "a draft pointing at a pruned quant is dropped from metadata");
});

test("resolveHfDownloadCandidate: rebuilds the spec from the live repo, ignoring a stale client list", async (t) => {
  const sibling = (rfilename, gb) => ({ rfilename, lfs: { size: Math.round(gb * GB) } });
  const repo = {
    id: "DavidAU/Repo-MTP-GGUF",
    sha: "livesha",
    siblings: [
      sibling("Model-NEO-Q6_K.gguf", 23.58),
      sibling("Model-NEO-MTP-Q8_0.gguf", 30.24),
      sibling("Model-NEO-AMD-MTP-Q6_K.gguf", 24.03),
      sibling("mmproj-F16.gguf", 0.93),
    ],
  };
  stubHfFetch(t, repo);

  const resolved = await resolveHfDownloadCandidate({
    id: "gguf:DavidAU/Repo-MTP-GGUF:Model-NEO-Q6_K.gguf",
    name: "Model-NEO-Q6_K.gguf",
    repoId: "DavidAU/Repo-MTP-GGUF",
    runtime: "gguf",
    // A spec the client cached back when every quant was bundled as a companion.
    downloadSpec: {
      type: "single-file",
      runtime: "gguf",
      repoId: "DavidAU/Repo-MTP-GGUF",
      revision: "stalesha",
      files: [
        { path: "Model-NEO-Q6_K.gguf", sizeBytes: 1 },
        { path: "Model-NEO-MTP-Q8_0.gguf", sizeBytes: 1 },
        { path: "Model-NEO-AMD-MTP-Q6_K.gguf", sizeBytes: 1 },
      ],
    },
  });

  assert.deepEqual(
    resolved.downloadSpec.files.map((entry) => entry.path).sort(),
    ["Model-NEO-Q6_K.gguf", "mmproj-F16.gguf"],
    "the file list comes from the live repo, not the client",
  );
  assert.equal(resolved.downloadSpec.revision, "livesha", "the revision is refreshed too");
  assert.equal(resolved.downloadSpec.files[0].sizeBytes, Math.round(23.58 * GB), "sizes come from the live listing");
});

test("resolveHfDownloadCandidate: rejects a file the repo no longer has", async (t) => {
  stubHfFetch(t, { id: "acme/Repo-GGUF", sha: "livesha", siblings: [{ rfilename: "Model-Q4_K_M.gguf", lfs: { size: GB } }] });

  await assert.rejects(
    () => resolveHfDownloadCandidate({
      id: "gguf:acme/Repo-GGUF:Model-Q6_K.gguf",
      name: "Model-Q6_K.gguf",
      repoId: "acme/Repo-GGUF",
      runtime: "gguf",
      downloadSpec: { type: "single-file", runtime: "gguf", repoId: "acme/Repo-GGUF", revision: "old", files: [{ path: "Model-Q6_K.gguf", sizeBytes: GB }] },
    }),
    /no longer in acme\/Repo-GGUF/,
  );
});

test("resolveHfDownloadCandidate: falls back to the client spec when Hugging Face is unreachable", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const candidate = {
    id: "gguf:acme/Repo-GGUF:Model-Q6_K.gguf",
    name: "Model-Q6_K.gguf",
    repoId: "acme/Repo-GGUF",
    runtime: "gguf",
    downloadSpec: { type: "single-file", runtime: "gguf", repoId: "acme/Repo-GGUF", revision: "old", files: [{ path: "Model-Q6_K.gguf", sizeBytes: GB }] },
  };
  const resolved = await resolveHfDownloadCandidate(candidate);
  assert.deepEqual(resolved.downloadSpec.files.map((entry) => entry.path), ["Model-Q6_K.gguf"]);
});
