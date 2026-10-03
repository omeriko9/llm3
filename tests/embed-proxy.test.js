"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const {
  resolveEmbedTarget,
  parseEmbedSites,
  embedPathForWebsite,
  embedSlugFromUrl,
  slugForWebsiteName,
  upstreamForWebsite,
  rewriteLocation,
  createEmbedRouter,
  STRIP_FROM_RESPONSE,
} = require("../src/embed_proxy");

const MOUNT = "/embed/console";

test("a bare mount with no trailing slash redirects, so relative assets resolve", () => {
  // Without this, the browser resolves app.js/style.css against /embed/ and 404s.
  assert.deepEqual(resolveEmbedTarget(MOUNT, MOUNT), { redirect: MOUNT + "/" });
});

test("a bare mount with a query keeps the query on the redirect", () => {
  assert.deepEqual(resolveEmbedTarget(MOUNT, MOUNT + "?a=1"), { redirect: MOUNT + "/?a=1" });
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

test("a slug comes from the name, stays in the mount alphabet, and never collides", () => {
  assert.equal(slugForWebsiteName("My Console"), "my-console");
  assert.equal(slugForWebsiteName("Café  Ünïcode!"), "cafe-unicode");
  assert.equal(slugForWebsiteName("!!!"), "site");
  assert.equal(slugForWebsiteName("../../etc"), "etc");
  assert.equal(slugForWebsiteName("My Console", new Set(["my-console", "my-console-2"])), "my-console-3");
});

test("the slug is read from /embed/<slug> addresses only", () => {
  assert.equal(embedSlugFromUrl("/embed/docs/"), "docs");
  assert.equal(embedSlugFromUrl("/embed/docs"), "docs");
  assert.equal(embedSlugFromUrl("/embed/docs?x=1"), "docs");
  assert.equal(embedSlugFromUrl("/embed/docs/a/b.js"), "docs");
  assert.equal(embedSlugFromUrl("/embed/Docs/"), null);
  assert.equal(embedSlugFromUrl("/embed/%2e%2e/"), null);
  assert.equal(embedSlugFromUrl("/api/x"), null);
});

test("an exposed row's upstream comes from its internal URL", () => {
  // Documentation addresses (RFC 5737), not a real network.
  assert.deepEqual(upstreamForWebsite({ internal_url: "http://localhost:5001" }),
    { protocol: "http:", upstreamHost: "127.0.0.1", upstreamPort: 5001, basePath: "" });
  assert.deepEqual(upstreamForWebsite({ internal_url: "http://192.0.2.20:8080/app/" }),
    { protocol: "http:", upstreamHost: "192.0.2.20", upstreamPort: 8080, basePath: "/app" });
  assert.deepEqual(upstreamForWebsite({ internal_url: "https://192.0.2.20" }),
    { protocol: "https:", upstreamHost: "192.0.2.20", upstreamPort: 443, basePath: "" });
  assert.equal(upstreamForWebsite({ internal_url: "ftp://192.0.2.20" }), null);
  assert.equal(upstreamForWebsite({ internal_url: "" }), null);
});

test("redirects from upstream stay under the mount", () => {
  const target = { mountPath: "/embed/docs", upstreamHost: "192.0.2.20", upstreamPort: 8080, basePath: "/app" };
  assert.equal(rewriteLocation("/login", target), "/embed/docs/login");
  assert.equal(rewriteLocation("/app/login?x=1", target), "/embed/docs/login?x=1");
  assert.equal(rewriteLocation("/app", target), "/embed/docs/");
  assert.equal(rewriteLocation("http://192.0.2.20:8080/app/home", target), "/embed/docs/home");
  // Another host, and a relative path, are left alone.
  assert.equal(rewriteLocation("https://example.com/x", target), "https://example.com/x");
  assert.equal(rewriteLocation("next", target), "next");
});

test("the router serves exposed slugs per request and 404s the rest", async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/app/go") {
      res.writeHead(302, { location: "/app/there" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/plain", "x-frame-options": "DENY" });
    res.end(`upstream saw ${req.method} ${req.url}`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const exposed = new Map([["docs", { protocol: "http:", upstreamHost: "127.0.0.1", upstreamPort: upstream.address().port, basePath: "/app" }]]);
  const app = express();
  app.use(createEmbedRouter((slug) => exposed.get(slug) || null));
  app.use((_req, res) => res.status(418).end("llm3 route"));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    upstream.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(`${base}/embed/docs/a.js?v=2`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "upstream saw GET /app/a.js?v=2");
  assert.equal(page.headers.get("x-frame-options"), null);

  const bare = await fetch(`${base}/embed/docs`, { redirect: "manual" });
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get("location"), "/embed/docs/");

  const moved = await fetch(`${base}/embed/docs/go`, { redirect: "manual" });
  assert.equal(moved.headers.get("location"), "/embed/docs/there");

  assert.equal((await fetch(`${base}/embed/other/`)).status, 404);
  assert.equal((await fetch(`${base}/api/x`)).status, 418);

  // Hidden: the same address stops answering at once.
  exposed.delete("docs");
  assert.equal((await fetch(`${base}/embed/docs/a.js`)).status, 404);
});
