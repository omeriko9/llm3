"use strict";
// Dashboard access guard.
//
// The control API can start and stop models, delete weights, and restart pm2
// apps, and the server binds 0.0.0.0 by default. When LLM3_AUTH_TOKEN is set,
// every request from a non-loopback client must carry that token. Loopback
// clients always pass, so local scripts and the launchers keep working.
//
// A client can present the token four ways:
//   Authorization: Bearer <token>
//   X-LLM3-Token: <token>
//   Cookie: llm3_token=<token>         (set by the query form below)
//   ?token=<token>                     (a browser opens this once; the server
//                                       sets the cookie and redirects to the
//                                       same URL without the query parameter)
//
// Routes that carry their own access control (an explicit allowlist) can be
// listed in `exempt`.

const crypto = require("node:crypto");

const COOKIE_NAME = "llm3_token";
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function normalizeAddress(address = "") {
  return String(address || "").replace(/^::ffff:/, "");
}

function isLoopbackAddress(address = "") {
  return LOOPBACK.has(normalizeAddress(address));
}

function isLoopbackHost(host = "") {
  return isLoopbackAddress(host);
}

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[name] = part.slice(index + 1).trim();
    }
  }
  return out;
}

function safeEqual(a = "", b = "") {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function presentedTokens(req) {
  const tokens = [];
  const auth = String(req.headers.authorization || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (bearer) tokens.push(bearer[1].trim());
  const header = req.headers["x-llm3-token"];
  if (header) tokens.push(String(header).trim());
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME]) tokens.push(cookies[COOKIE_NAME]);
  return tokens;
}

function stripTokenParam(originalUrl = "/") {
  const url = new URL(originalUrl, "http://llm3.invalid");
  url.searchParams.delete("token");
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash || ""}`;
}

function wantsJson(req) {
  if (req.path.startsWith("/api/")) return true;
  const accept = String(req.headers.accept || "");
  return accept.includes("application/json") && !accept.includes("text/html");
}

function createDashboardAuth({ token = "", exempt = [] } = {}) {
  const secret = String(token || "").trim();
  const exemptPaths = new Set(exempt);

  function middleware(req, res, next) {
    if (!secret) return next();
    if (isLoopbackAddress(req.socket?.remoteAddress)) return next();
    if (exemptPaths.has(req.path)) return next();

    for (const candidate of presentedTokens(req)) {
      if (safeEqual(candidate, secret)) return next();
    }

    const queryToken = typeof req.query?.token === "string" ? req.query.token.trim() : "";
    if (queryToken && safeEqual(queryToken, secret)) {
      const cookie = `${COOKIE_NAME}=${encodeURIComponent(secret)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`;
      res.setHeader("Set-Cookie", cookie);
      if (req.method === "GET" || req.method === "HEAD") {
        res.redirect(302, stripTokenParam(req.originalUrl));
        return;
      }
      return next();
    }

    res.status(401);
    if (wantsJson(req)) {
      res.json({ error: "Unauthorized. Send the dashboard token as 'Authorization: Bearer <token>'." });
      return;
    }
    res.type("text/plain").send(
      "llm3: this dashboard requires a token.\n" +
        "Open http://<host>:<port>/?token=<LLM3_AUTH_TOKEN> once in this browser to sign in.\n",
    );
  }

  return middleware;
}

function describeAuthPosture({ token = "", host = "" } = {}) {
  const secret = String(token || "").trim();
  if (secret) return "dashboard auth: token required for non-loopback clients";
  if (isLoopbackHost(host)) return "dashboard auth: off (bound to loopback only)";
  return (
    `dashboard auth: OFF while bound to ${host || "all interfaces"}. ` +
    "Any client on the network can start, stop, and delete models. " +
    "Set LLM3_AUTH_TOKEN in .env, or set HOST=127.0.0.1."
  );
}

module.exports = {
  COOKIE_NAME,
  createDashboardAuth,
  describeAuthPosture,
  isLoopbackAddress,
  parseCookies,
  stripTokenParam,
};
