"use strict";
// Contract tests for src/slot-api-proxy.py, the one proxy that fronts every
// slot's public port. Each test starts a stub backend (Node http), then the
// proxy as a child process, and speaks to the proxy with fetch (undici), which
// is the strict client the proxy has to satisfy.
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

async function startBackend(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: raw };
      seen.push(record);
      const route = req.url.split("?")[0];
      if (route === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json", server: "stub", date: "x" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "backend-model" }] }));
        return;
      }
      if (route === "/props") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ from: "backend", default_generation_settings: { n_ctx: 4096 } }));
        return;
      }
      if (route === "/v1/chat/completions") {
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch {}
        if (parsed.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "x-empty": "" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          model: parsed.model,
          choices: [{ message: { role: "assistant", content: "hello", reasoning_content: "hmm" } }],
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "nope" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { port: server.address().port, seen };
}

async function startProxy(t, { backendPort, args = [], env = {} }) {
  const port = await freePort();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-proxy-test-"));
  const trafficLog = path.join(dir, "nested", "traffic.log");
  const child = spawn("python3", ["-u", PROXY, ...args], {
    env: {
      PATH: process.env.PATH,
      QWEN_PROXY_HOST: "127.0.0.1",
      QWEN_PROXY_PORT: String(port),
      QWEN_PROXY_TARGET_HOST: "127.0.0.1",
      QWEN_PROXY_TARGET_PORT: String(backendPort),
      QWEN_PROXY_LOG: trafficLog,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  t.after(async () => {
    child.kill("SIGTERM");
    await fs.rm(dir, { recursive: true, force: true });
  });
  // Generous on purpose: this waits for a Python interpreter to start and bind.
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
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    trafficLog,
    output: () => stdout,
    errors: () => stderr,
  };
}

// The proxy appends to the traffic log in a `finally`, after the response has
// gone back to the client, so a read immediately after `fetch` resolves can see
// fewer lines than requests made. Wait for the line count instead of racing it.
async function readTrafficLog(logPath, expectedLines) {
  const deadline = Date.now() + 15000;
  let lines = [];
  while (Date.now() < deadline) {
    try {
      lines = (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
    } catch {
      lines = [];
    }
    if (lines.length >= expectedLines) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return lines.map((line) => JSON.parse(line));
}

async function chat(base, body) {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response;
}

test("env-configured (qwen_llama) mode injects sampling defaults and passes /v1/models and /props through", async (t) => {
  const backend = await startBackend(t);
  const proxy = await startProxy(t, {
    backendPort: backend.port,
    env: { QWEN_PROXY_DEFAULT_TEMPERATURE: "0.3", QWEN_PROXY_DEFAULT_TOP_K: "7" },
  });

  const response = await chat(proxy.base, { model: "m", messages: [], top_p: 0.5 });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.choices[0].message.content, "hello");
  assert.equal(payload.choices[0].message.reasoning_content, "hmm", "reasoning kept by default");

  const forwarded = JSON.parse(backend.seen.at(-1).body);
  assert.equal(forwarded.temperature, 0.3);
  assert.equal(forwarded.top_k, 7);
  assert.equal(forwarded.top_p, 0.5, "explicit client value wins");
  assert.equal(forwarded.min_p, 0);
  assert.equal(backend.seen.at(-1).headers["content-length"], String(backend.seen.at(-1).body.length));

  const models = await (await fetch(`${proxy.base}/v1/models`)).json();
  assert.equal(models.data[0].id, "backend-model", "no advertised id: pass-through");
  const props = await (await fetch(`${proxy.base}/props`)).json();
  assert.equal(props.from, "backend", "no context size: pass-through");

  const log = await readTrafficLog(proxy.trafficLog, 3);
  assert.equal(log.length, 3);
  assert.equal(log[0].path, "/v1/chat/completions");
  assert.equal(log[0].status, 200);
  assert.equal(log[0].model, "m");
});

test("--hide-reasoning strips reasoning from JSON and SSE responses but keeps it in the logs", async (t) => {
  const backend = await startBackend(t);
  const proxy = await startProxy(t, { backendPort: backend.port, env: { QWEN_PROXY_HIDE_REASONING: "true" } });

  const plain = await (await chat(proxy.base, { model: "m", messages: [] })).json();
  assert.equal(plain.choices[0].message.content, "hello");
  assert.equal("reasoning_content" in plain.choices[0].message, false);

  const streamed = await chat(proxy.base, { model: "m", messages: [], stream: true });
  assert.equal(streamed.headers.get("transfer-encoding"), "chunked");
  assert.equal(streamed.headers.get("x-empty"), null, "empty upstream header is not forwarded");
  const text = await streamed.text();
  assert.doesNotMatch(text, /reasoning_content/);
  assert.match(text, /"content":\s?"hello"/);
  assert.match(text, /data: \[DONE\]/);

  const log = (await readTrafficLog(proxy.trafficLog, 2)).map((entry) => JSON.stringify(entry)).join("\n");
  assert.match(log, /hmm/, "traffic log keeps the original reasoning");
  assert.match(proxy.output(), /\[thinking\] hmm/);
});

test("flag-configured (optiq) mode remaps model ids, answers /v1/models and /props locally, and adds the backend key", async (t) => {
  const backend = await startBackend(t);
  const proxy = await startProxy(t, {
    backendPort: backend.port,
    args: [
      "--advertised-model-id", "public-name",
      "--advertised-model-label", "Public",
      "--backend-model-id", "/models/real",
      "--context-size", "8192",
      "--backend-api-key", "k3y",
      "--default-temperature", "0.1",
    ],
  });

  const models = await (await fetch(`${proxy.base}/v1/models`)).json();
  assert.deepEqual(models.data, [{ id: "public-name", object: "model", owned_by: "Public" }]);
  const props = await (await fetch(`${proxy.base}/props`)).json();
  assert.equal(props.default_generation_settings.n_ctx, 8192);
  assert.equal(backend.seen.length, 0, "both answered without the backend");

  const response = await chat(proxy.base, { model: "public-name", messages: [] });
  assert.equal(response.status, 200);
  const forwarded = backend.seen.at(-1);
  assert.equal(JSON.parse(forwarded.body).model, "/models/real");
  assert.equal(JSON.parse(forwarded.body).temperature, 0.1);
  assert.equal(forwarded.headers.authorization, "Bearer k3y");
  assert.equal(forwarded.headers["x-api-key"], "k3y");

  const other = await chat(proxy.base, { model: "something-else", messages: [] });
  assert.equal(other.status, 200);
  assert.equal(JSON.parse(backend.seen.at(-1).body).model, "something-else", "unknown ids are left alone");
});

test("backend errors and a dead backend surface as JSON, and the traffic log directory is created", async (t) => {
  const backend = await startBackend(t);
  const proxy = await startProxy(t, { backendPort: backend.port });
  const missing = await fetch(`${proxy.base}/v1/nothing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "nope" });

  const dead = await startProxy(t, { backendPort: await freePort() });
  const response = await chat(dead.base, { model: "m", messages: [] });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /refused|Connection/i);
});

test("missing configuration is rejected with a usage error", async (t) => {
  const child = spawn("python3", [PROXY], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 2);
  assert.match(stderr, /--port, --backend-port and --traffic-log are required/);
});
