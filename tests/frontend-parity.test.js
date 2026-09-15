// The dashboard duplicates a few server-side tables in public/app.js because the
// frontend is plain JS with no build step and cannot require() from src/. That
// duplication silently drifted: the four Gaming PC applications were added to
// src/server.js and to LLM_APPLICATION_FLAGS (the launch checkboxes, keyed by
// `appKey`) but never to ALL_APPLICATION_DEFINITIONS (keyed by `key`), which is
// what renderApplicationBadges iterates. The launch synced correctly while the
// slot tooltip insisted "No applications are currently routed here".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

function keysBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  assert.ok(start !== -1, `missing ${startMarker}`);
  assert.ok(end > start, `missing ${endMarker}`);
  return [...source.slice(start, end).matchAll(/key:\s*"([^"]+)"/g)].map((m) => m[1]);
}

test("every server application is declared in the frontend badge table", () => {
  const server = keysBetween(serverSrc, "const APPLICATION_DEFINITIONS", "const APPLICATION_KEYS");
  const client = keysBetween(appSrc, "const ALL_APPLICATION_DEFINITIONS", "const APPLICATION_DEFINITIONS");

  assert.ok(server.length > 0, "server application list should not be empty");
  const missing = server.filter((key) => !client.includes(key));
  const extra = client.filter((key) => !server.includes(key));

  // A key missing here does not break the sync -- it makes the slot tooltip and
  // the routing badges silently omit the application, which reads as "not set".
  assert.deepEqual(missing, [], `public/app.js ALL_APPLICATION_DEFINITIONS is missing: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `public/app.js declares applications the server does not: ${extra.join(", ")}`);
});

test("the launch checkbox table covers every launchable llm application", () => {
  // LLM_APPLICATION_FLAGS keys the checkboxes by `appKey`; a gap here means the
  // application can never be routed from the launch modal at all.
  const flagKeys = [...appSrc.slice(
    appSrc.indexOf("const LLM_APPLICATION_FLAGS"),
    appSrc.indexOf("const LLM_APPLICATION_MACHINES"),
  ).matchAll(/appKey:\s*"([^"]+)"/g)].map((m) => m[1]);

  const serverBlock = serverSrc.slice(
    serverSrc.indexOf("const APPLICATION_DEFINITIONS"),
    serverSrc.indexOf("const APPLICATION_KEYS"),
  );
  const launchable = [...serverBlock.matchAll(/\{[^}]*?key:\s*"([^"]+)"[^}]*?slotKind:\s*"llm"[^}]*?\}/gs)]
    .map((m) => m[1]);

  const missing = launchable.filter((key) => !flagKeys.includes(key));
  assert.deepEqual(missing, [], `LLM_APPLICATION_FLAGS is missing: ${missing.join(", ")}`);
});
