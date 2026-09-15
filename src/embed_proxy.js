"use strict";
// Reverse-proxy a LAN-only pm2 site so it can be embedded inside llm3 as an
// iframe, on llm3's own origin.
//
// Why a server-side proxy and not an iframe pointed straight at the service:
// llm3 is reachable from the internet at its public domain, the embedded
// services are not, and an https page cannot frame an http://192.168.x.y URL
// (mixed content) even on the LAN. Proxying through llm3 puts the whole thing on
// one https origin -- so there are no cross-origin or mixed-content limits, the
// iframe gets the service in full, and the service needs no exposure of its own.
//
// Auth is deliberately NOT enforced here. The nginx layer in front of
// the public origin already gates every path with its login (auth_request), and on
// the LAN llm3 is unauthenticated by design -- the embedded service is already
// reachable on the LAN on its own port, so this adds no new local exposure.

const http = require("http");

// Pure, so it can be tested without a socket: turn an incoming URL into the
// path to request upstream, or a redirect. A bare mount with no trailing slash
// must redirect, or the browser resolves the page's relative assets (app.js,
// style.css) against the parent directory and every one of them 404s.
function resolveEmbedTarget(mountPath, originalUrl) {
  const url = String(originalUrl || "");
  if (url === mountPath) {
    return { redirect: mountPath + "/" };
  }
  const prefix = mountPath + "/";
  if (url === prefix) {
    return { upstreamPath: "/" };
  }
  if (url.startsWith(prefix)) {
    return { upstreamPath: url.slice(mountPath.length) };
  }
  return null; // not ours
}

// Headers that must not be copied verbatim to the client. Hop-by-hop headers
// per RFC 7230, plus anything that would stop the page from being framed on
// llm3's origin.
const STRIP_FROM_RESPONSE = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "x-frame-options", "content-security-policy",
]);

function createEmbedProxy({ mountPath, upstreamHost, upstreamPort }) {
  return function embedProxy(req, res, next) {
    const target = resolveEmbedTarget(mountPath, req.originalUrl);
    if (!target) return next();
    if (target.redirect) {
      res.redirect(308, target.redirect);
      return;
    }

    const headers = { ...req.headers };
    // The upstream is a plain stdlib HTTP server that keys nothing on Host, but
    // send it its own address rather than the public domain so any self-referential
    // Location it emits stays sane.
    headers.host = `${upstreamHost}:${upstreamPort}`;
    delete headers["accept-encoding"]; // no need to re-decode; keep it simple

    const upstream = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: target.upstreamPath,
        headers,
      },
      (upRes) => {
        const outHeaders = {};
        for (const [name, value] of Object.entries(upRes.headers)) {
          if (!STRIP_FROM_RESPONSE.has(name.toLowerCase())) {
            outHeaders[name] = value;
          }
        }
        // A redirect the upstream builds against its own root has to be rewritten
        // to sit under the mount, or it escapes the iframe to an llm3 route.
        const loc = upRes.headers.location;
        if (loc && loc.startsWith("/")) {
          outHeaders.location = mountPath + loc;
        }
        res.writeHead(upRes.statusCode || 502, outHeaders);
        upRes.pipe(res);
      }
    );

    upstream.on("error", (err) => {
      if (!res.headersSent) {
        res.status(502).type("text/plain").send(
          `Embedded service at ${upstreamHost}:${upstreamPort} is not answering: ${err.code || err.message}`
        );
      } else {
        res.destroy();
      }
    });

    // Stream the request body through (device /proxy POSTs, /api/stt POSTs).
    req.pipe(upstream);
  };
}

// Pure: parse LLM3_EMBED_SITES into proxy entries. The list names private sites,
// so it lives only in the git-ignored .env; the committed default is no sites.
// Format: comma-separated `name:port[:card title]`. `name` becomes the mount
// /embed/<name>. With a card title, the Websites tab also shows a pinned card
// that opens the site inside llm3. A malformed entry is skipped, not fatal.
function parseEmbedSites(raw) {
  const sites = [];
  const seen = new Set();
  for (const part of String(raw || "").split(",")) {
    const [name, portText, ...titleParts] = part.trim().split(":");
    const port = Number(portText);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name || "") || seen.has(name)) continue;
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    seen.add(name);
    sites.push({
      mountPath: `/embed/${name}`,
      upstreamHost: "127.0.0.1",
      upstreamPort: port,
      cardTitle: titleParts.join(":").trim() || null,
    });
  }
  return sites;
}

// Pure: the mount a Websites row can be opened through, or null. A row matches
// when its internal URL points at this machine on a proxied port, so the
// right-click "Open inside llm3" item follows the row whatever it is named.
function embedPathForWebsite(website, proxies, localHosts) {
  let url;
  try {
    url = new URL(String(website?.internal_url || ""));
  } catch (_e) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && !localHosts?.has(host)) {
    return null;
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const match = (proxies || []).find((p) => Number(p.upstreamPort) === port);
  return match ? match.mountPath + "/" : null;
}

module.exports = { createEmbedProxy, resolveEmbedTarget, parseEmbedSites, embedPathForWebsite, STRIP_FROM_RESPONSE };
