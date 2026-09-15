"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const {
  COOKIE_NAME,
  createDashboardAuth,
  describeAuthPosture,
  isLoopbackAddress,
  parseCookies,
  stripTokenParam,
} = require("../src/dashboard-auth");

// The guard lets loopback through unconditionally, so to exercise the deny path
// the tests fake a remote client address on the socket.
function listen(t, { token, exempt, remoteAddress = "10.0.0.9" } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddress, configurable: true });
    next();
  });
  app.use(createDashboardAuth({ token, exempt }));
  app.get("/", (_req, res) => res.type("text/html").send("<h1>ok</h1>"));
  app.get("/api/overview", (_req, res) => res.json({ ok: true }));
  app.post("/api/pm2/control", (_req, res) => res.json({ pm2: true }));
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => server.close());
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

test("with no token configured every client passes", async (t) => {
  const base = await listen(t, { token: "" });
  const response = await fetch(`${base}/api/overview`);
  assert.equal(response.status, 200);
});

test("loopback clients pass without a token", async (t) => {
  const base = await listen(t, { token: "s3cret", remoteAddress: "::ffff:127.0.0.1" });
  const response = await fetch(`${base}/api/overview`);
  assert.equal(response.status, 200);
});

test("a remote client without the token gets 401", async (t) => {
  const base = await listen(t, { token: "s3cret" });
  const api = await fetch(`${base}/api/overview`);
  assert.equal(api.status, 401);
  const payload = await api.json();
  assert.match(payload.error, /Unauthorized/);

  const page = await fetch(`${base}/`, { headers: { accept: "text/html" } });
  assert.equal(page.status, 401);
  assert.match(await page.text(), /\?token=/);
});

test("bearer, header, and cookie forms all authenticate", async (t) => {
  const base = await listen(t, { token: "s3cret" });
  for (const headers of [
    { authorization: "Bearer s3cret" },
    { "x-llm3-token": "s3cret" },
    { cookie: `${COOKIE_NAME}=s3cret` },
  ]) {
    const response = await fetch(`${base}/api/overview`, { headers });
    assert.equal(response.status, 200, JSON.stringify(headers));
  }
  const wrong = await fetch(`${base}/api/overview`, { headers: { authorization: "Bearer nope" } });
  assert.equal(wrong.status, 401);
});

test("?token= sets the cookie and redirects to the clean URL", async (t) => {
  const base = await listen(t, { token: "s3cret" });
  const response = await fetch(`${base}/?tab=voice&token=s3cret`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/?tab=voice");
  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=s3cret;`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test("a wrong ?token= does not set a cookie", async (t) => {
  const base = await listen(t, { token: "s3cret" });
  const response = await fetch(`${base}/?token=nope`, { redirect: "manual" });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("exempt paths stay open", async (t) => {
  const base = await listen(t, { token: "s3cret", exempt: ["/api/pm2/control"] });
  const response = await fetch(`${base}/api/pm2/control`, { method: "POST" });
  assert.equal(response.status, 200);
});

test("helpers", () => {
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("10.0.0.1"), false);
  assert.deepEqual(parseCookies("a=1; llm3_token=x%20y; junk"), { a: "1", llm3_token: "x y" });
  assert.equal(stripTokenParam("/x?token=abc"), "/x");
  assert.equal(stripTokenParam("/x?a=1&token=abc&b=2"), "/x?a=1&b=2");
  assert.match(describeAuthPosture({ token: "", host: "0.0.0.0" }), /OFF/);
  assert.match(describeAuthPosture({ token: "", host: "127.0.0.1" }), /loopback only/);
  assert.match(describeAuthPosture({ token: "x", host: "0.0.0.0" }), /token required/);
});
