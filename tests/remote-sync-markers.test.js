// The `expect` password fallback runs ssh on a pty, and a pty echoes the whole
// spawned command line back into stdout. That command line *contains* the remote
// python script, which itself contains the sync marker as source:
//
//     print('__HERMES_SYNC__' + json.dumps({
//
// A `lastIndexOf(marker)` scan matched that source line and handed
// `'\''  + json.dumps({` to JSON.parse, so a dead remote host surfaced as
// `Unexpected token ''' ... is not valid JSON` -- and, because stopping a slot
// resets Hermes compaction routing, that 502 blocked every launch into the
// compaction slot.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  extractMarkerPayload,
  parseHermesSyncOutput,
  isLauncherSelectable,
  normalizeSlotName,
  normalizeSlotNames,
  resolveSlotName,
} = require("../src/server.js");

const ECHOED_SCRIPT = [
  `spawn sh -lc { ssh '-tt' 'user@host' bash -lc 'set -euo pipefail`,
  `print('\\''__HERMES_SYNC__'\\'' + json.dumps({`,
  `    '\\''ok'\\'': True,`,
  `}))`,
  `PY' ; } && printf '__LLM3_REMOTE_OK__\\n' || printf '__LLM3_REMOTE_FAIL__\\n'`,
  `ssh: connect to host remote.invalid port 22: Host is down`,
  `__LLM3_REMOTE_FAIL__`,
].join("\r\n");

test("a marker inside the echoed script is not mistaken for the result", () => {
  assert.equal(extractMarkerPayload(ECHOED_SCRIPT, "__HERMES_SYNC__"), "");
});

test("a real marker line is read even when the script was echoed first", () => {
  const transcript = `${ECHOED_SCRIPT}\r\n__HERMES_SYNC__{"ok": true, "changed": false}\r\n`;
  assert.deepEqual(extractMarkerPayload(transcript, "__HERMES_SYNC__"), '{"ok": true, "changed": false}');
});

test("a failed remote sync reports the transcript, never a raw SyntaxError", () => {
  const result = parseHermesSyncOutput(ECHOED_SCRIPT);
  assert.equal(result.ok, false);
  assert.match(result.error, /did not return a result/);
  assert.match(result.output, /Host is down/);
});

test("a marker line that is not JSON is a failed sync, not a thrown error", () => {
  const result = parseHermesSyncOutput("__HERMES_SYNC__ not json at all\n");
  assert.equal(result.ok, false);
  assert.match(result.error, /not JSON/);
});

test("the launcher catalog hides launchers no model can select", () => {
  // getLaunchersForModel gates these behind LLM3_ENABLE_EXPERIMENTAL_*, so with
  // the flags unset they can never be chosen and must not offer an Update button.
  for (const key of ["mlx", "rapid-mlx", "mtplx", "optiq", "beellama"]) {
    assert.equal(isLauncherSelectable(key), false, `${key} should be hidden`);
  }
  for (const key of ["gguf", "gguf-tq3", "mlx-dspark", "mlx-vlm", "ds4"]) {
    assert.equal(isLauncherSelectable(key), true, `${key} should be listed`);
  }
});

test("slot names are trimmed, collapsed, capped, and dropped when empty", () => {
  assert.equal(normalizeSlotName("  Coding   slot  "), "Coding slot");
  assert.equal(normalizeSlotName(""), "");
  assert.equal(normalizeSlotName("x".repeat(80)).length, 40);
  assert.deepEqual(normalizeSlotNames({ slot1: " Draft ", nope: "x", slot2: "  " }), { slot1: "Draft" });
});

test("the applied profile's slot name wins over the global one", () => {
  const slot = { id: "slot1", label: "1st LLM" };
  const profiles = [{ id: "p1", name: "MAIN", slots: { slot1: { name: "Coding" } } }];

  assert.equal(resolveSlotName(slot, { profiles, activeProfileId: "p1", slotNames: { slot1: "Global" } }), "Coding");
  assert.equal(resolveSlotName(slot, { profiles, activeProfileId: "", slotNames: { slot1: "Global" } }), "Global");
  assert.equal(resolveSlotName(slot, { profiles, activeProfileId: "", slotNames: {} }), "1st LLM");
});

// Slot names live inside the profile, but they are not part of the launch
// settings the profile editor round-trips. A save payload that says nothing
// about names must leave them alone -- saving a profile used to clear every
// name the user had given the slots.
test("saving a profile does not clear slot names it said nothing about", () => {
  const { carryForwardSlotNames } = require("../src/server.js");
  const existing = {
    id: "p1",
    name: "MAIN",
    slots: { slot1: { name: "Coding" }, slot2: { name: "" }, slot4: { name: "PodG-AU" } },
  };

  const merged = carryForwardSlotNames({ slot1: { modelKey: "m", enabled: true } }, existing);
  assert.equal(merged.slot1.name, "Coding");
  assert.equal(merged.slot1.modelKey, "m", "the rest of the slot config survives the merge");
  assert.equal(merged.slot4.name, "PodG-AU");
  assert.equal(merged.slot2, undefined, "an empty name adds no entry");
});

test("an explicit empty name still clears the slot name", () => {
  const { carryForwardSlotNames } = require("../src/server.js");
  const existing = { id: "p1", name: "MAIN", slots: { slot1: { name: "Coding" } } };
  const merged = carryForwardSlotNames({ slot1: { name: "" } }, existing);
  assert.equal(merged.slot1.name, "");
});

test("a brand new profile keeps the names the payload carries", () => {
  const { carryForwardSlotNames } = require("../src/server.js");
  const payload = { slot1: { name: "Fresh" } };
  assert.equal(carryForwardSlotNames(payload, null), payload);
});

// Compaction used to be a legacy special case: a top-bar button that launched
// one hardcoded model into slot 4, a default that pinned the role to slot 4, and
// a stop-time reset that threw a 502 and so made slot 4 unloadable whenever the
// remote machine was off. It is two ordinary roles now, one per machine.
test("compaction is two ordinary roles, one per machine", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  const block = serverSrc.slice(
    serverSrc.indexOf("const APPLICATION_DEFINITIONS"),
    serverSrc.indexOf("const APPLICATION_KEYS"),
  );

  const remote = /key:\s*"compaction",[\s\S]*?machine:\s*"([a-z0-9]+)"/.exec(block);
  const local = /key:\s*"compactionm4",[\s\S]*?machine:\s*"([a-z0-9]+)"/.exec(block);
  assert.equal(remote?.[1], "inuc", "compaction belongs to the remote machine");
  assert.equal(local?.[1], "m4", "compaction m4 belongs to the local machine");
  assert.ok(!block.includes("alsoOnMachines"), "neither role spans two machines any more");
});

test("no application default is pinned to a particular slot", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // Voice roles legitimately name their own voice slots; an llm role must not
  // name an llm slot.
  assert.ok(
    !/applicationKey === "compaction"[\s\S]{0,200}getSlotDefinition\("slot\d"\)/.test(serverSrc),
    "src/server.js still defaults an application to a fixed slot",
  );
  assert.ok(
    !/application\.key === "compaction"[\s\S]{0,120}getSlot\("slot\d"\)/.test(appSrc),
    "public/app.js still defaults an application to a fixed slot",
  );
});

test("the legacy compaction toggle is gone from the frontend", () => {
  const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  for (const marker of [
    "COMPACTION_SLOT_ID",
    "COMPACTION_MODEL_MATCH_TOKENS",
    "runCompactionToggle",
    "getCompactionSlot",
    "renderCompactionButton",
  ]) {
    assert.ok(!appSrc.includes(marker), `public/app.js still carries ${marker}`);
  }
  assert.ok(!htmlSrc.includes("compactionBtn"), "index.html still has the top-bar compaction button");
});

test("machine labels are served, not written twice", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  assert.ok(
    serverSrc.includes("applicationMachines: APPLICATION_MACHINES"),
    "the overview must carry the machine labels so LLM3_*_LABEL reaches the UI",
  );
  const appSrc = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(
    appSrc.includes("function getApplicationMachines()"),
    "public/app.js must prefer the served machine list over its literal fallback",
  );
});

// The Logs tab's llm3 view showed server.log alone, which only ever recorded
// what was *attempted*: a failed launch answered over HTTP and left no trace, so
// the log showed a start-model line followed by nothing. The view now merges
// llm3's own log with the process stdout/stderr, where stack traces land.
test("the llm3 log parses both timestamp formats and keeps stack traces attached", () => {
  const { parseLlm3LogLines } = require("../src/server.js");

  const own = parseLlm3LogLines("[2026-09-09T10:00:00.000Z] slot-action start-model slot=slot1\n", "llm3");
  assert.equal(own.length, 1);
  assert.equal(own[0].text, "slot-action start-model slot=slot1");
  assert.equal(own[0].time, Date.parse("2026-09-09T10:00:00.000Z"));

  // pm2 writes `ISO: line`, and a stack trace's continuation lines carry no
  // timestamp at all. They must inherit the one above or they sort to the top,
  // away from the error they belong to.
  const pm2 = parseLlm3LogLines(
    "2026-09-09T10:00:01: TypeError: boom\n    at foo (/x.js:1:1)\n    at bar (/x.js:2:2)\n",
    "stderr",
  );
  assert.equal(pm2.length, 3);
  assert.equal(pm2[0].text, "TypeError: boom");
  assert.equal(pm2[1].text, "    at foo (/x.js:1:1)");
  assert.equal(pm2[1].time, pm2[0].time, "a continuation line keeps its error's timestamp");
  assert.equal(pm2[2].time, pm2[0].time);
  assert.ok(pm2.every((entry) => entry.label === "stderr"));

  // The zones differ and that matters: server.log stamps UTC with a trailing Z,
  // while pm2 writes a bare local date-time. Date.parse reads a bare one as
  // local, which is what makes the two streams line up on the wall clock.
  const localNoon = parseLlm3LogLines("2026-09-09T12:00:00: local noon\n", "stdout")[0];
  assert.equal(localNoon.time, new Date(2026, 8, 9, 12, 0, 0).getTime());

  const early = parseLlm3LogLines("[2026-09-09T00:00:00.000Z] first\n", "llm3");
  const merged = [...early, ...pm2].sort((a, b) => (a.time - b.time) || (a.seq - b.seq));
  assert.deepEqual(merged.map((entry) => entry.label), ["llm3", "stderr", "stderr", "stderr"]);
});

test("every failed action is logged, and successes and polls are not", () => {
  const { logFailedActionResponse } = require("../src/server.js");
  const lines = [];
  const stub = (statusCode) => ({ statusCode });
  const capture = (req, res, body) => {
    const before = fs.readFileSync(SERVER_LOG, "utf8").length;
    logFailedActionResponse(req, res, body);
    const after = fs.readFileSync(SERVER_LOG, "utf8");
    lines.push(after.slice(before).trim());
  };
  const SERVER_LOG = path.join(
    process.env.LLM3_STATE_DIR || path.join(require("node:os").homedir(), ".local", "state", "llm3"),
    "server.log",
  );
  if (!fs.existsSync(SERVER_LOG)) {
    return; // no state dir on this machine; the parsing tests above still cover the format
  }

  capture({ method: "GET", originalUrl: "/api/overview" }, stub(404), { error: "nope" });
  assert.equal(lines.at(-1), "", "a polling GET must not spam the log");

  capture({ method: "POST", originalUrl: "/api/start" }, stub(200), { ok: true });
  assert.equal(lines.at(-1), "", "a success must not be logged as a failure");

  // The validation returns are the ones that never reach a catch block.
  capture({ method: "POST", originalUrl: "/api/start" }, stub(404), { error: "Unknown model: x" });
  assert.match(lines.at(-1), /ERROR POST \/api\/start -> 404: Unknown model: x/);

  capture({ method: "POST", originalUrl: "/api/start" }, stub(500), { error: "boom", stdout: "launcher said this" });
  assert.match(lines.at(-1), /stdout:\n?launcher said this/);
});
