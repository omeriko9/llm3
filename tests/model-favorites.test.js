"use strict";
// Favorite models live in dashboard-config.json (not localStorage), so they
// follow the user to every browser. This covers the endpoint's contract and
// that the entries survive a read-back through readDashboardConfig.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const SERVER_MODULE_PATH = require.resolve("../src/server.js");

test("POST /api/models/favorite adds, recolors and removes favorites in dashboard config", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-model-favorites-"));
  process.env.LLM3_STATE_DIR = tempDir;
  delete require.cache[SERVER_MODULE_PATH];
  const { app, readDashboardConfig } = require(SERVER_MODULE_PATH);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.close();
    delete process.env.LLM3_STATE_DIR;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => {
    const response = await fetch(`${base}/api/models/favorite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };

  const missing = await post({ favorite: true });
  assert.equal(missing.status, 400);

  // No color: the default. A bad color falls back to the default too.
  const added = await post({ modelKey: "model-a", favorite: true });
  assert.equal(added.status, 200);
  assert.deepEqual(added.payload.modelFavorites, { "model-a": { color: "#facc15" } });
  await post({ modelKey: "model-b", favorite: true, color: "not-a-color" });

  // A color alone recolors; favorite:true without a color keeps the old one.
  await post({ modelKey: "model-a", color: "#22C55E" });
  const kept = await post({ modelKey: "model-a", favorite: true });
  assert.equal(kept.payload.modelFavorites["model-a"].color, "#22c55e");

  const removed = await post({ modelKey: "model-b", favorite: false });
  assert.deepEqual(Object.keys(removed.payload.modelFavorites), ["model-a"]);

  const config = await readDashboardConfig();
  assert.deepEqual(config.modelFavorites, { "model-a": { color: "#22c55e" } });
  const onDisk = JSON.parse(await fs.readFile(path.join(tempDir, "dashboard-config.json"), "utf8"));
  assert.deepEqual(onDisk.modelFavorites, { "model-a": { color: "#22c55e" } });
});
