"use strict";
// Website favorites are a column in websites.db, so they follow the row to
// every browser. This covers the endpoint's contract and the read-back
// through GET /api/websites.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const SERVER_MODULE_PATH = require.resolve("../src/server.js");

test("POST /api/websites/favorite sets and clears the favorite flag", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-website-favorites-"));
  process.env.LLM3_STATE_DIR = tempDir;
  delete require.cache[SERVER_MODULE_PATH];
  const { app } = require(SERVER_MODULE_PATH);
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
    const response = await fetch(`${base}/api/websites/favorite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };
  const list = async () => (await fetch(`${base}/api/websites`)).json();

  // The first run seeds one row; it starts as no favorite.
  const [seeded] = await list();
  assert.equal(seeded.favorite, false);

  assert.equal((await post({ favorite: true })).status, 400);
  assert.equal((await post({ id: seeded.id, favorite: "yes" })).status, 400);
  assert.equal((await post({ id: 999999, favorite: true })).status, 404);

  assert.equal((await post({ id: seeded.id, favorite: true })).status, 200);
  assert.equal((await list()).find((w) => w.id === seeded.id).favorite, true);

  assert.equal((await post({ id: seeded.id, favorite: false })).status, 200);
  assert.equal((await list()).find((w) => w.id === seeded.id).favorite, false);
});
