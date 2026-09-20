"use strict";
// Contract tests for POST /v1/decide and GET /llm3/capabilities in
// src/slot-api-proxy.py (logic in src/slot_decide.py). A stub backend plays a
// chat-completions server whose first-token logprobs the test controls.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROXY = path.join(__dirname, "..", "src", "slot-api-proxy.py");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// `answer(prompt, body)` returns { content, top } where top is a list of
// [token, probability], or top === null for a backend without logprobs.
async function startBackend(t, answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push({ url: req.url, body });
      const { content, top } = answer(body.messages[0].content, body);
      const choice = { index: 0, message: { role: "assistant", content }, finish_reason: "length" };
      if (top) {
        choice.logprobs = {
          content: [{ token: content, top_logprobs: top.map(([token, p]) => ({ token, logprob: Math.log(p) })) }],
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [choice] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { port: server.address().port, seen };
}

async function startProxy(t, backendPort, extraArgs = []) {
  const port = await freePort();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-decide-test-"));
  const child = spawn("python3", ["-u", PROXY, "--no-sampling-defaults", ...extraArgs], {
    env: {
      PATH: process.env.PATH,
      QWEN_PROXY_HOST: "127.0.0.1",
      QWEN_PROXY_PORT: String(port),
      QWEN_PROXY_TARGET_HOST: "127.0.0.1",
      QWEN_PROXY_TARGET_PORT: String(backendPort),
      QWEN_PROXY_LOG: path.join(dir, "traffic.log"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  t.after(async () => {
    child.kill("SIGTERM");
    await fs.rm(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`proxy exited: ${stderr}`);
    const ok = await new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return `http://127.0.0.1:${port}`;
}

function decide(base, body) {
  return fetch(`${base}/v1/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Which label did the prompt give to this meaning?
function labelOf(prompt, meaning) {
  const match = prompt.match(new RegExp(`^([A-Z]) = ${meaning}$`, "m"));
  return match ? match[1] : null;
}

const TICKET = {
  context: "Ticket:\nI was charged twice.",
  question: "Which category matches the ticket?",
  choices: { billing: "billing and payments", technical: "technical support", account: "account access" },
};

test("decide returns one probability for each choice and sends a zero-text request", async (t) => {
  const backend = await startBackend(t, (prompt) => ({
    content: labelOf(prompt, "billing and payments"),
    top: [
      [labelOf(prompt, "billing and payments"), 0.8],
      [labelOf(prompt, "technical support"), 0.1],
      [labelOf(prompt, "account access"), 0.05],
      ["The", 0.05],
    ],
  }));
  const base = await startProxy(t, backend.port);
  const res = await decide(base, TICKET);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.method, "logprobs");
  assert.equal(out.choice, "billing");
  assert.ok(Math.abs(out.probabilities.billing - 0.8 / 0.95) < 1e-4);
  assert.ok(Math.abs(out.coverage - 0.95) < 1e-6);
  assert.ok(Math.abs(out.margin - (0.8 - 0.1) / 0.95) < 1e-4);
  assert.deepEqual(out.floored, []);

  const sent = backend.seen[0];
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.body.max_tokens, 1);
  assert.equal(sent.body.temperature, 0);
  assert.equal(sent.body.logprobs, true);
  assert.equal(sent.body.enable_thinking, false);
  assert.deepEqual(sent.body.chat_template_kwargs, { enable_thinking: false });
  assert.match(sent.body.messages[0].content, /Label:$/);
});

test("rotations change the label order and the result follows the meaning, not the position", async (t) => {
  const backend = await startBackend(t, (prompt) => ({
    content: labelOf(prompt, "technical support"),
    top: [[labelOf(prompt, "technical support"), 0.7], [labelOf(prompt, "billing and payments"), 0.2], [labelOf(prompt, "account access"), 0.1]],
  }));
  const base = await startProxy(t, backend.port);
  const out = await (await decide(base, { ...TICKET, rotations: 3 })).json();
  assert.equal(out.rotations, 3);
  assert.equal(backend.seen.length, 3);
  const firstLabels = backend.seen.map((s) => labelOf(s.body.messages[0].content, "technical support"));
  assert.equal(new Set(firstLabels).size, 3);
  assert.equal(out.choice, "technical");
  assert.ok(Math.abs(out.probabilities.technical - 0.7) < 1e-4);
});

test("a label token with a space before it counts for the same label", async (t) => {
  const backend = await startBackend(t, () => ({ content: "A", top: [["A", 0.5], [" A", 0.3], ["B", 0.2]] }));
  const base = await startProxy(t, backend.port);
  const out = await (await decide(base, { question: "q?", choices: ["yes", "no"] })).json();
  assert.ok(Math.abs(out.probabilities.yes - 0.8) < 1e-4);
});

test("a label outside the top list gets the lowest listed probability, not zero", async (t) => {
  const backend = await startBackend(t, () => ({ content: "A", top: [["A", 0.98], ["//", 0.01], ["x", 0.001]] }));
  const base = await startProxy(t, backend.port);
  const out = await (await decide(base, { question: "q?", choices: ["yes", "no"] })).json();
  assert.equal(out.choice, "yes");
  assert.deepEqual(out.floored, ["no"]);
  assert.ok(out.probabilities.no > 0);
  assert.ok(Number.isFinite(out.log_odds.yes) && Number.isFinite(out.log_odds.no));
});

test("a backend without logprobs gives the greedy method and the capability shows it", async (t) => {
  const backend = await startBackend(t, (prompt) => ({ content: labelOf(prompt, "no"), top: null }));
  const base = await startProxy(t, backend.port);

  const before = await (await fetch(`${base}/llm3/capabilities`)).json();
  assert.equal(before.decide, "unknown");
  assert.equal(backend.seen.length, 0);

  const out = await (await decide(base, { question: "q?", choices: ["yes", "no"], rotations: 2 })).json();
  assert.equal(out.method, "greedy");
  assert.equal(out.choice, "no");
  assert.equal(out.probabilities, null);
  assert.deepEqual(out.votes, { yes: 0, no: 2 });

  const after = await (await fetch(`${base}/llm3/capabilities`)).json();
  assert.equal(after.decide, "greedy");
});

test("capabilities?probe=1 sends one probe call and then uses the stored result", async (t) => {
  const backend = await startBackend(t, () => ({ content: "A", top: [["A", 0.9], ["B", 0.1]] }));
  const base = await startProxy(t, backend.port);
  const first = await (await fetch(`${base}/llm3/capabilities?probe=1`)).json();
  assert.equal(first.decide, "logprobs");
  assert.equal(backend.seen.length, 1);
  await fetch(`${base}/llm3/capabilities?probe=1`);
  assert.equal(backend.seen.length, 1);
});

test("--decide-slot pins decision calls to one llama-server slot, and the default does not", async (t) => {
  const backend = await startBackend(t, () => ({ content: "A", top: [["A", 0.9], ["B", 0.1]] }));
  const plain = await startProxy(t, backend.port);
  await decide(plain, { question: "q?", choices: ["yes", "no"] });
  assert.equal("id_slot" in backend.seen[0].body, false);

  const pinned = await startProxy(t, backend.port, ["--decide-slot", "1"]);
  await decide(pinned, { question: "q?", choices: ["yes", "no"], rotations: 2 });
  assert.deepEqual(backend.seen.slice(1).map((s) => s.body.id_slot), [1, 1]);
});

test("requests that the caller must correct give status 400", async (t) => {
  const backend = await startBackend(t, () => ({ content: "A", top: [["A", 1]] }));
  const base = await startProxy(t, backend.port);
  const many = Array.from({ length: 27 }, (_, i) => `choice${i}`);
  for (const body of [
    { choices: ["yes", "no"] },
    { question: "q?", choices: ["only"] },
    { question: "q?", choices: many },
  ]) {
    const res = await decide(base, body);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  }
  assert.equal(backend.seen.length, 0);
});
