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
// server.js loads .env, which may import the owner's LLM3_EMBED_SITES into
// the test database. An empty value (set before .env is read) keeps it out.
process.env.LLM3_EMBED_SITES = "";

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

  const favorites = async (query = "") => (await fetch(`${base}/api/websites/favorites${query}`)).json();
  assert.deepEqual(await favorites(), []);

  assert.equal((await post({ id: seeded.id, favorite: true })).status, 200);
  assert.equal((await list()).find((w) => w.id === seeded.id).favorite, true);

  // /fav lists only favorites, each with a tap address. Health only on request.
  const [fav] = await favorites();
  assert.equal(fav.id, seeded.id);
  assert.match(fav.url, /^http:\/\/[^/]+:\d+$/);
  assert.equal("online" in fav, false);
  assert.equal(typeof (await favorites("?status=1"))[0].online, "boolean");
  const page = await fetch(`${base}/fav`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /api\/websites\/favorites/);

  assert.equal((await post({ id: seeded.id, favorite: false })).status, 200);
  assert.equal((await list()).find((w) => w.id === seeded.id).favorite, false);
  assert.deepEqual(await favorites(), []);
});

test("POST /api/websites/expose serves a row at /embed/<slug>/ and hides it again", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-website-expose-"));
  process.env.LLM3_STATE_DIR = tempDir;
  delete require.cache[SERVER_MODULE_PATH];
  const { app } = require(SERVER_MODULE_PATH);
  const upstream = http.createServer((req, res) => res.end(`upstream ${req.url}`));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.close();
    upstream.close();
    delete process.env.LLM3_STATE_DIR;
    delete require.cache[SERVER_MODULE_PATH];
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const postJson = async (url, body) => {
    const response = await fetch(`${base}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };
  const list = async () => (await fetch(`${base}/api/websites`)).json();

  await postJson("/api/websites/add", {
    name: "Test Upstream Site",
    internal_url: `http://127.0.0.1:${upstream.address().port}`,
    category: "test",
  });
  const row = (await list()).find((w) => w.name === "Test Upstream Site");
  assert.equal(row.exposed, false);
  assert.equal(row.canExpose, true);
  assert.equal(row.embedPath, null);

  assert.equal((await postJson("/api/websites/expose", { id: row.id })).status, 400);
  assert.equal((await postJson("/api/websites/expose", { id: 999999, exposed: true })).status, 404);

  const on = await postJson("/api/websites/expose", { id: row.id, exposed: true });
  assert.equal(on.status, 200);
  assert.equal(on.payload.embedPath, "/embed/test-upstream-site/");
  assert.equal((await list()).find((w) => w.id === row.id).embedPath, "/embed/test-upstream-site/");
  assert.equal(await (await fetch(`${base}/embed/test-upstream-site/x?y=1`)).text(), "upstream /x?y=1");

  const off = await postJson("/api/websites/expose", { id: row.id, exposed: false });
  assert.equal(off.payload.embedPath, null);
  assert.equal((await fetch(`${base}/embed/test-upstream-site/`)).status, 404);

  // A rename does not move the address: the slug stays with the row.
  await postJson("/api/websites/update", { id: row.id, name: "Renamed", internal_url: row.internal_url, external_url: "", category: "test" });
  const again = await postJson("/api/websites/expose", { id: row.id, exposed: true });
  assert.equal(again.payload.embedPath, "/embed/test-upstream-site/");

  // The seeded row is llm3 itself: exposing it would loop.
  const self = (await list()).find((w) => w.id !== row.id && w.internal_url.endsWith(`:${process.env.PORT || 7075}`));
  if (self) {
    assert.equal(self.canExpose, false);
    assert.equal((await postJson("/api/websites/expose", { id: self.id, exposed: true })).status, 400);
  }
});
