"use strict";
// Tests must not touch live state. Two of them did, silently, for months:
//
//  * remote-sync-markers called logFailedActionResponse, which appends to the
//    path src/server.js resolved from LLM3_STATE_DIR at import time. Unset,
//    that is the real ~/.local/state/llm3/server.log -- 28 of the 51 errors in
//    it were the suite's own "Unknown model: x" and "boom".
//  * perf-dashboard-session requires perf-dashboard-routes, which requires
//    src/voxel-test.js, which reads PORT at import and POSTs slot launches to
//    127.0.0.1:<PORT>/api/start. Unset, that is the LIVE dashboard on 7075.
//
// Both are import-time reads, so the env has to be set before the require. This
// guards the ordering, which a later edit could quietly undo.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(name) {
  return fs.readFileSync(path.join(__dirname, name), "utf8");
}

function indexOfLine(source, needle) {
  const at = source.indexOf(needle);
  assert.ok(at > -1, `expected to find ${needle}`);
  return at;
}

test("remote-sync-markers redirects the server log before importing the server", () => {
  const source = read("remote-sync-markers.test.js");
  const envAt = indexOfLine(source, "process.env.LLM3_STATE_DIR =");
  const requireAt = indexOfLine(source, 'require("../src/server.js")');
  assert.ok(envAt < requireAt, "LLM3_STATE_DIR must be set before src/server.js is imported");
  assert.match(source, /mkdtempSync/, "the log must go to a temp dir, not the real state dir");
});

test("perf-dashboard-session points the slot-launch port away from the live dashboard", () => {
  const source = read("perf-dashboard-session.test.js");
  const envAt = indexOfLine(source, "process.env.PORT =");
  const requireAt = indexOfLine(source, 'require.resolve("../src/perf-dashboard-routes.js")');
  assert.ok(envAt < requireAt, "PORT must be set before perf-dashboard-routes is imported");
  assert.ok(!/process\.env\.PORT\s*=\s*["']7075["']/.test(source), "7075 is the live dashboard");
});

test("src/voxel-test.js still reads PORT at import, which is why the guard exists", () => {
  // If this stops being true the guard above is pointless and should be revisited.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "voxel-test.js"), "utf8");
  assert.match(source, /const LOCAL_PORT = Number\(process\.env\.PORT \|\| 7075\)/);
  assert.match(source, /\/api\/start/);
});

test("src/server.js still resolves its log path from LLM3_STATE_DIR at import", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  assert.match(source, /const SLOT_STATE_DIR = process\.env\.LLM3_STATE_DIR \|\|/);
  assert.match(source, /const SERVER_LOG_PATH = path\.join\(SLOT_STATE_DIR, "server\.log"\)/);
});
