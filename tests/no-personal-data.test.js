"use strict";
// Publication guard.
//
// llm3 is a public repository with no scrub step between the working tree and
// GitHub: what is committed is what ships. These tests are the thing that keeps
// that safe. They scan every tracked file for machine-specific values,
// credentials, and build artifacts, and fail the suite before a push can carry
// them out.
//
// If a test here fails, do not relax the pattern. Move the value into `.env`
// (git-ignored, loaded by src/local-env.js), give the code a neutral default,
// and document the key in `.env.example`.

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

// This file necessarily contains the patterns it searches for.
const SELF = "tests/no-personal-data.test.js";

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } catch {
    return []; // not a git checkout (e.g. a tarball) — nothing to guard
  }
}

function isProbablyText(buf) {
  return !buf.includes(0);
}

function scan(patterns, { skip = [] } = {}) {
  const hits = [];
  for (const rel of trackedFiles()) {
    if (rel === SELF || skip.includes(rel)) continue;
    const abs = path.join(REPO_ROOT, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (!isProbablyText(buf)) continue;
    const text = buf.toString("utf8");
    text.split("\n").forEach((line, i) => {
      for (const { name, re } of patterns) {
        if (re.test(line)) hits.push(`${rel}:${i + 1} [${name}] ${line.trim().slice(0, 120)}`);
      }
    });
  }
  return hits;
}

test("no personal identifiers in tracked files", () => {
  // LICENSE and README carry the author's public GitHub handle as the copyright
  // attribution. That is deliberate and public; every other file must not name
  // the author, their machines, or their network.
  const ATTRIBUTION = ["LICENSE", "README.md"];
  const hits = scan([
    { name: "unix account", re: /omeragmon/i },
    { name: "personal domain/handle", re: /omeriko/i },
    { name: "email address", re: /[\w.+-]+@(?!example\.)[\w-]+\.[a-z]{2,}/i },
    // The user's own RFC 1918 network. The generic "192.168." prefix logic that
    // detects a LAN at runtime is fine; a specific host address is not.
    { name: "private LAN host", re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
    // Also the JSON-escaped form, with a backslash before the colon.
    { name: "windows home", re: /C\\{0,2}:[\\/]{1,2}Users[\\/]{1,2}Omer\b/i },
    { name: "machine label", re: /\bM4 Studio\b|\bNUC\b/ },
  ], { skip: ATTRIBUTION });
  assert.deepEqual(hits, [], `personal data in tracked files:\n${hits.join("\n")}`);
});

test("no private terms from .env in tracked files", () => {
  // Names that must never ship but cannot be listed here without shipping them:
  // the owner's own sites, for example. They live in the git-ignored .env as
  // LLM3_PRIVATE_TERMS (comma-separated, case-insensitive). Without .env this
  // test has nothing to check. scripts/pre-push-guard.sh applies the same list
  // to every outgoing commit, messages included.
  require("../src/local-env").loadLocalEnv();
  const terms = String(process.env.LLM3_PRIVATE_TERMS || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hits = scan(terms.map((t, i) => ({ name: `private term #${i + 1}`, re: new RegExp(escape(t), "i") })));
  assert.deepEqual(hits, [], `private terms in tracked files:\n${hits.join("\n")}`);
});

test("no absolute home paths in tracked files", () => {
  const hits = scan([{ name: "absolute home path", re: /\/Users\/[a-z][a-z0-9_-]*\// }]);
  assert.deepEqual(hits, [], `absolute home paths (use $HOME or an env var):\n${hits.join("\n")}`);
});

test("no credentials in tracked files", () => {
  const hits = scan([
    { name: "firecrawl key", re: /\bfc-[a-f0-9]{20,}\b/ },
    { name: "openai-style key", re: /\bsk-[A-Za-z0-9]{24,}\b/ },
    { name: "github token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
    { name: "aws key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: "private key block", re: /BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY/ },
    // A secret assigned as a literal, as opposed to read from the environment
    // or a file. A value that is a shell/JS variable reference ($VAR, ${VAR},
    // process.env.X) carries no secret, so it is not a hit.
    {
      name: "inline secret",
      re: /(?:password|passwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*["'](?!\$|\{)[^"'$\s]{8,}["']/i,
    },
  ]);
  assert.deepEqual(hits, [], `credentials in tracked files:\n${hits.join("\n")}`);
});

test("no build artifacts or local state are tracked", () => {
  const offenders = trackedFiles().filter(
    (f) =>
      f.startsWith("node_modules/") ||
      f.startsWith("vendor/") ||
      /^benchmarks\/(results|saved-results|voxel-results|\.session|\.deepeval)\//.test(f) ||
      /^benchmarks\/[^/]+\.json$/.test(f) ||
      f === "benchmarks/SUMMARY.md" ||
      f.startsWith("public/vendor/") ||
      /\.(db|sqlite3?|log|pid|pem|key|p12|pfx)$/.test(f) ||
      /(^|\/)\.env$/.test(f) ||
      /\.bak(\.|$|[0-9])/.test(f),
  );
  assert.deepEqual(offenders, [], `artifacts should be ignored, not tracked:\n${offenders.join("\n")}`);
});

test(".env.example documents every key the code reads from .env", () => {
  const examplePath = path.join(REPO_ROOT, ".env.example");
  assert.ok(fs.existsSync(examplePath), ".env.example is missing");
  // A commented line (`# KEY=default`) documents the key without setting it.
  const documented = new Set(
    fs
      .readFileSync(examplePath, "utf8")
      .split("\n")
      .map((l) => /^#?\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => m[1]),
  );
  // Every setting the Node side reads under one of these prefixes must be
  // discoverable from the template. Launcher-internal keys (QWEN_LLAMA_*,
  // VOICE_TTS_* and friends) are set by the server for its child processes and
  // are documented in the launcher scripts instead.
  const PREFIXES =
    /process\.env\.((?:LLM3|HERMES|GAMING_PC|LIBRECHAT|REMOTE_JSON_APP|SQLITE_APP|PODG|CLAUDE|HF|MTPLX|MLX|CHATTERBOX)_[A-Z0-9_]*|QWEN_[A-Z0-9_]*|VOICE_[A-Z0-9_]*)/g;
  const sources = ["src/server.js", "src/hf-download-worker.js", "src/perf-dashboard-routes.js", "ecosystem.config.cjs"];
  const used = new Set();
  for (const rel of sources) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    for (const m of text.matchAll(PREFIXES)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !documented.has(k)).sort();
  assert.deepEqual(missing, [], `keys read by the server but absent from .env.example: ${missing.join(", ")}`);
});
