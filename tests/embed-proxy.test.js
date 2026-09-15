"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveEmbedTarget, parseEmbedSites, embedPathForWebsite, STRIP_FROM_RESPONSE } = require("../src/embed_proxy");

const MOUNT = "/embed/console";

test("a bare mount with no trailing slash redirects, so relative assets resolve", () => {
  // Without this, the browser resolves app.js/style.css against /embed/ and 404s.
  assert.deepEqual(resolveEmbedTarget(MOUNT, MOUNT), { redirect: MOUNT + "/" });
});

test("the mount root maps to the upstream root", () => {
  assert.deepEqual(resolveEmbedTarget(MOUNT, MOUNT + "/"), { upstreamPath: "/" });
});

test("the prefix is stripped, the rest forwarded with its query", () => {
  assert.deepEqual(resolveEmbedTarget(MOUNT, MOUNT + "/app.js"), { upstreamPath: "/app.js" });
  assert.deepEqual(
    resolveEmbedTarget(MOUNT, MOUNT + "/api/stt/transcript?session=3"),
    { upstreamPath: "/api/stt/transcript?session=3" }
  );
  assert.deepEqual(
    resolveEmbedTarget(MOUNT, MOUNT + "/proxy/api/tone"),
    { upstreamPath: "/proxy/api/tone" }
  );
});

test("paths outside the mount are not ours", () => {
  assert.equal(resolveEmbedTarget(MOUNT, "/api/system"), null);
  assert.equal(resolveEmbedTarget(MOUNT, "/"), null);
  // A prefix that only looks like the mount must not be captured.
  assert.equal(resolveEmbedTarget(MOUNT, "/embed/console-evil/x"), null);
});

test("LLM3_EMBED_SITES parses name:port[:card title], skipping bad entries", () => {
  assert.deepEqual(parseEmbedSites(""), []);
  assert.deepEqual(parseEmbedSites(undefined), []);
  assert.deepEqual(parseEmbedSites("console:5001:My Console: v2, docs:5002"), [
    { mountPath: "/embed/console", upstreamHost: "127.0.0.1", upstreamPort: 5001, cardTitle: "My Console: v2" },
    { mountPath: "/embed/docs", upstreamHost: "127.0.0.1", upstreamPort: 5002, cardTitle: null },
  ]);
  // A name that could escape the mount, a bad port, and a duplicate are dropped.
  assert.deepEqual(parseEmbedSites("../x:5001,Upper:5002,docs:0,docs:99999,a:5003,a:5004"), [
    { mountPath: "/embed/a", upstreamHost: "127.0.0.1", upstreamPort: 5003, cardTitle: null },
  ]);
});

test("a local row on a proxied port gets its embed path, anything else none", () => {
  const proxies = parseEmbedSites("console:5001,docs:5002");
  // Documentation addresses (RFC 5737), not a real network.
  const local = new Set(["192.0.2.10"]);
  const path = (internal_url) => embedPathForWebsite({ internal_url }, proxies, local);
  assert.equal(path("http://127.0.0.1:5001"), "/embed/console/");
  assert.equal(path("http://localhost:5002/"), "/embed/docs/");
  assert.equal(path("http://192.0.2.10:5002"), "/embed/docs/");
  // Same port on another machine is a different service.
  assert.equal(path("http://192.0.2.20:5002"), null);
  assert.equal(path("http://127.0.0.1:7075"), null);
  assert.equal(path(""), null);
});

test("framing and hop-by-hop headers are stripped so the iframe renders", () => {
  assert.ok(STRIP_FROM_RESPONSE.has("x-frame-options"));
  assert.ok(STRIP_FROM_RESPONSE.has("content-security-policy"));
  assert.ok(STRIP_FROM_RESPONSE.has("transfer-encoding"));
});
