"use strict";
// Reverse-proxy a LAN-only site so llm3 can serve it at /embed/<slug>/, on
// llm3's own origin. The Websites tab's "Expose from llm3" toggle decides
// which rows are served; the page opens in its own tab at that address, never
// inside the llm3 page.
//
// Why a server-side proxy: llm3 is reachable from the internet at its public
// domain, the services are not, and an https page cannot even link usefully to
// an http://<LAN address> from outside. Proxying through llm3 puts the service
// on one https origin, and the service needs no exposure of its own.
//
// Auth is not enforced here: the dashboard guard (LLM3_AUTH_TOKEN) runs before
// this router, and the nginx layer in front of the public origin gates every
// path with its login (auth_request). On the LAN the service is already
// reachable on its own port, so this adds no new local exposure.

const http = require("http");
const https = require("https");

// Pure, so it can be tested without a socket: turn an incoming URL into the
// path to request upstream, or a redirect. A bare mount with no trailing slash
// must redirect, or the browser resolves the page's relative assets (app.js,
// style.css) against the parent directory and every one of them 404s.
function resolveEmbedTarget(mountPath, originalUrl) {
  const url = String(originalUrl || "");
  if (url === mountPath || url.startsWith(mountPath + "?")) {
    return { redirect: mountPath + "/" + url.slice(mountPath.length) };
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

// The mount a slug is served under. Slugs are lowercase words joined by
// hyphens, so a slug can never climb out of /embed/.
const EMBED_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
function embedMountPath(slug) {
  return `/embed/${slug}`;
}

// Pure: the slug in /embed/<slug>[/...][?...], or null.
function embedSlugFromUrl(originalUrl) {
  const match = /^\/embed\/([^/?#]+)(?:[/?]|$)/.exec(String(originalUrl || ""));
  return match && EMBED_SLUG_RE.test(match[1]) ? match[1] : null;
}

// Pure: a free slug for a website name. The name is the owner's, so the slug
// lives only in the websites database, never in code.
function slugForWebsiteName(name, taken = new Set()) {
  const base = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "site";
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

// Pure: where an exposed row's requests go, from its internal URL. A path in
// the URL becomes a prefix on every upstream request. Loopback names mean this
// machine. Null for anything that is not a plain http(s) address.
function upstreamForWebsite(website) {
  let url;
  try {
    url = new URL(String(website?.internal_url || ""));
  } catch (_e) {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return null;
  return {
    protocol: url.protocol,
    upstreamHost: host,
    upstreamPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    basePath: url.pathname.replace(/\/+$/, ""),
  };
}

// Pure: a Location header from upstream, rewritten to stay under the mount.
// Root-relative and absolute-to-upstream redirects would otherwise escape to an
// llm3 route or to an address the browser cannot reach.
function rewriteLocation(location, { mountPath, upstreamHost, upstreamPort, basePath = "" }) {
  let loc = String(location || "");
  if (!loc) return loc;
  if (/^https?:\/\//i.test(loc)) {
    let url;
    try {
      url = new URL(loc);
    } catch (_e) {
      return loc;
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const sameHost = url.hostname === upstreamHost || (upstreamHost === "127.0.0.1" && url.hostname === "localhost");
    if (!sameHost || port !== Number(upstreamPort)) return loc;
    loc = url.pathname + url.search + url.hash;
  }
  if (!loc.startsWith("/")) return loc;
  if (basePath && (loc === basePath || loc.startsWith(basePath + "/") || loc.startsWith(basePath + "?"))) {
    loc = loc.slice(basePath.length) || "/";
  }
  return mountPath + loc;
}

// Forward one request to an upstream and stream the answer back.
function proxyRequest(req, res, { mountPath, protocol = "http:", upstreamHost, upstreamPort, basePath = "" }) {
  const target = resolveEmbedTarget(mountPath, req.originalUrl);
  if (!target) return false;
  if (target.redirect) {
    res.redirect(308, target.redirect);
    return true;
  }

  const headers = { ...req.headers };
  // Send the upstream its own address rather than the public domain so any
  // self-referential Location it emits stays sane.
  headers.host = `${upstreamHost}:${upstreamPort}`;
  delete headers["accept-encoding"]; // no need to re-decode; keep it simple

  const client = protocol === "https:" ? https : http;
  const upstream = client.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: basePath + target.upstreamPath,
      headers,
      // LAN services with https almost always carry a self-signed certificate.
      ...(protocol === "https:" ? { rejectUnauthorized: false } : {}),
    },
    (upRes) => {
      const outHeaders = {};
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (!STRIP_FROM_RESPONSE.has(name.toLowerCase())) {
          outHeaders[name] = value;
        }
      }
      if (upRes.headers.location) {
        outHeaders.location = rewriteLocation(upRes.headers.location, { mountPath, upstreamHost, upstreamPort, basePath });
      }
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res);
    }
  );

  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.status(502).type("text/plain").send(
        `Exposed service at ${upstreamHost}:${upstreamPort} is not answering: ${err.code || err.message}`
      );
    } else {
      res.destroy();
    }
  });

  // Stream the request body through (device /proxy POSTs, /api/stt POSTs).
  req.pipe(upstream);
  return true;
}

// A fixed mount, for one known upstream.
function createEmbedProxy({ mountPath, upstreamHost, upstreamPort, protocol, basePath }) {
  return function embedProxy(req, res, next) {
    if (!proxyRequest(req, res, { mountPath, upstreamHost, upstreamPort, protocol, basePath })) next();
  };
}

// Every /embed/<slug> request, resolved per request through lookup(slug),
// which returns an upstream (see upstreamForWebsite) or null. Asking on each
// request means a toggle on the Websites tab takes effect at once.
function createEmbedRouter(lookup) {
  return function embedRouter(req, res, next) {
    if (!String(req.originalUrl || "").startsWith("/embed/")) return next();
    const slug = embedSlugFromUrl(req.originalUrl);
    const upstream = slug ? lookup(slug) : null;
    if (!upstream) {
      res.status(404).type("text/plain").send("No website is exposed from llm3 at this address.");
      return;
    }
    proxyRequest(req, res, { ...upstream, mountPath: embedMountPath(slug) });
  };
}

// Pure: parse LLM3_EMBED_SITES into proxy entries. The list names private sites,
// so it lives only in the git-ignored .env; the committed default is no sites.
// Format: comma-separated `name:port[:card title]`. Since the Websites tab got
// its "Expose from llm3" toggle, the list is only imported once into the
// websites database (each entry's row is exposed under /embed/<name>); a card
// title still adds a pinned card while that slug is exposed. A malformed entry
// is skipped, not fatal.
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

// Pure: the mount a Websites row matches in an LLM3_EMBED_SITES list, or null.
// A row matches when its internal URL points at this machine on a listed port.
// Used for the one-time import of that list.
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

module.exports = {
  createEmbedProxy,
  createEmbedRouter,
  resolveEmbedTarget,
  parseEmbedSites,
  embedPathForWebsite,
  embedSlugFromUrl,
  embedMountPath,
  slugForWebsiteName,
  upstreamForWebsite,
  rewriteLocation,
  EMBED_SLUG_RE,
  STRIP_FROM_RESPONSE,
};
