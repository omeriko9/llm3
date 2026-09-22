"use strict";
/**
 * Read the true state of a service that sits behind a wake-on-demand proxy.
 *
 * A waker keeps a port answering while the heavy service behind it is stopped,
 * so llm3's usual health check -- a TCP connect -- always succeeds and always
 * reports "online". That is a lie the moment the service is asleep: ComfyUI can
 * be stopped, hold no memory, and still show a green dot.
 *
 * A waker answers GET /waker/status without starting anything, and says which
 * pm2 app it fronts. That answer is the truth, so llm3 asks for it.
 */

const http = require("node:http");

const WAKER_STATUS_PATH = "/waker/status";
const WAKER_PROBE_TIMEOUT_MS = 1500;
// A port that is not a waker stays not a waker. Re-probe it rarely, so an
// ordinary website costs one extra request every ten minutes, not one per poll.
const WAKER_NEGATIVE_TTL_MS = 10 * 60 * 1000;

/**
 * Normalize a /waker/status body. Returns null when the body is not a waker's.
 *
 * Tolerant on purpose: any HTTP server may answer /waker/status with something
 * else, and a 404 page must never be read as a sleeping service.
 */
function parseWakerStatus(body) {
  let payload = body;
  if (typeof body === "string") {
    try {
      payload = JSON.parse(body);
    } catch (_error) {
      return null;
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const waker = String(payload.waker || "").trim();
  if (!waker) {
    return null;
  }
  return {
    waker,
    app: String(payload.app || "").trim() || waker,
    pm2App: String(payload.pm2App || "").trim(),
    awake: payload.awake === true,
    waking: payload.waking === true,
    upstream: String(payload.upstream || payload.target || "").trim(),
  };
}

/** One GET /waker/status. Resolves to the normalized status, or null. */
function probeWaker(port, { host = "127.0.0.1", timeoutMs = WAKER_PROBE_TIMEOUT_MS, httpImpl = http } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let request;
    try {
      request = httpImpl.request(
        { host, port: Number(port), path: WAKER_STATUS_PATH, method: "GET", timeout: timeoutMs },
        (response) => {
          if (response.statusCode !== 200) {
            response.destroy();
            finish(null);
            return;
          }
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
            // A waker's answer is a few hundred bytes. Anything larger is some
            // other server's page, so stop reading it.
            if (body.length > 8192) {
              response.destroy();
              finish(null);
            }
          });
          response.on("end", () => finish(parseWakerStatus(body)));
          response.on("error", () => finish(null));
        },
      );
    } catch (_error) {
      finish(null);
      return;
    }
    request.on("error", () => finish(null));
    request.on("timeout", () => { request.destroy(); finish(null); });
    request.end();
  });
}

/**
 * probeWaker with a cache, so ordinary websites do not pay for this.
 *
 * A waker is re-read on every call: the answer changes whenever the service
 * sleeps or wakes, and reading it starts nothing. Everything else is remembered
 * as "not a waker" for the negative TTL.
 */
function createWakerProbe({ probe = probeWaker, negativeTtlMs = WAKER_NEGATIVE_TTL_MS, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async function wakerForPort(port, host = "127.0.0.1") {
    const key = `${host}:${port}`;
    const remembered = cache.get(key);
    if (remembered && remembered.notAWakerUntil > now()) {
      return null;
    }
    const status = await probe(port, { host });
    if (status) {
      cache.delete(key);
      return status;
    }
    cache.set(key, { notAWakerUntil: now() + negativeTtlMs });
    return null;
  };
}

module.exports = {
  WAKER_STATUS_PATH,
  WAKER_NEGATIVE_TTL_MS,
  parseWakerStatus,
  probeWaker,
  createWakerProbe,
};
