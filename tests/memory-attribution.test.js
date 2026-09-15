"use strict";
// The RAM badge and the Models-tab slot cards used to describe different things
// while looking like they described the same thing.
//
// A slot card shows its backend's RSS. llama.cpp hands the GPU buffers created
// over its own memory with StorageModeShared, and the kernel wires those pages;
// wired memory is attributed to no process, so ps, footprint and vmmap all miss
// it. Measured 2026-09-10 with one inference request on a loaded slot: wired
// moved 31.3 -> 33.9 -> 32.5 GB while the slot's RSS stayed at 26.5 GB. Two
// models reading 3.9 GB and 32.7 GB next to a 97 percent badge looked like tens
// of gigabytes had gone missing.
//
// So the badge now names the block, and modelRssBytes counts every backend
// rather than whichever one Object.values happened to yield first.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");

function liftTitleBuilder() {
  const start = appSource.indexOf("function buildRamAttributionTitle");
  assert.ok(start >= 0, "buildRamAttributionTitle not found in public/app.js");
  const end = appSource.indexOf("\nfunction renderSystem()", start);
  assert.ok(end > start, "could not bound buildRamAttributionTitle");
  const fmtBytes = `function fmtBytes(b){const n=Number(b||0);if(!n)return "0 B";
    const u=["B","KB","MB","GB","TB"];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++;}
    return v.toFixed(1)+" "+u[i];}`;
  return vm.runInNewContext(`${fmtBytes}\n${appSource.slice(start, end)}\nbuildRamAttributionTitle`);
}

const GB = 1024 ** 3;
const buildTitle = liftTitleBuilder();

// The machine exactly as it stood when the mismatch was reported.
const REPORTED = {
  usedBytes: 102.3 * GB,
  totalBytes: 128 * GB,
  pressureLabel: "normal",
  attribution: {
    modelResidentBytes: 36.6 * GB,
    wiredBytes: 62.0 * GB,
    appMemoryBytes: 34.6 * GB,
    compressedBytes: 5.7 * GB,
    slots: [{ slotId: "slot2" }, { slotId: "slot3" }],
    note: "Wired holds the GPU's Metal working set and the kernel's own pages. macOS "
      + "reports it per machine, never per process, so a slot card cannot include its share.",
  },
};

test("the badge tooltip accounts for every part of the used figure", () => {
  const title = buildTitle(REPORTED, 19.5 * GB);
  for (const part of ["wired (GPU / kernel)", "app memory", "compressed", "= used"]) {
    assert.ok(title.includes(part), `tooltip is missing the "${part}" line`);
  }
  assert.ok(title.includes("62.0 GB"), "the wired block must be shown, it is the whole point");
  assert.ok(title.includes("102.3 GB"), "the total must be shown so the parts can be checked against it");
});

test("the tooltip says what the slots hold and why it is less", () => {
  const title = buildTitle(REPORTED, 0);
  assert.ok(title.includes("36.6 GB resident"), "the slot total must appear");
  assert.ok(title.includes("2 running backends"), "how many backends that total covers");
  assert.ok(title.includes("never per process"), "the reason a slot card cannot include its GPU share");
  // And the note must actually come from the server, not only from this fixture.
  assert.ok(
    /never per process/.test(serverSource),
    "src/server.js must supply the note explaining why a slot cannot show its GPU share"
  );
});

test("an older server with no attribution still produces a usable tooltip", () => {
  const title = buildTitle({ usedBytes: GB, totalBytes: 2 * GB, pressureLabel: "normal" }, 0);
  assert.ok(title.includes("Used = wired + app memory + compressed."));
  assert.ok(title.includes("Kernel memory pressure: normal."));
  assert.ok(!title.includes("undefined"), "a missing attribution must not leak undefined into the UI");
});

test("cached files stay outside the used figure and are still explained", () => {
  const withCache = buildTitle(REPORTED, 19.5 * GB);
  assert.ok(withCache.includes("19.5 GB of cached file pages"));
  assert.ok(withCache.includes("is not counted"));
  assert.ok(!buildTitle(REPORTED, 0).includes("cached file pages"));
});

test("modelRssBytes sums every running backend, not just the first", () => {
  // The old code was `Object.values(processes).map(e => e.backend).find(Boolean)`,
  // which reported one slot and ignored the rest.
  assert.ok(
    /const modelResidentBytes = modelBackends\.reduce\(/.test(serverSource),
    "src/server.js must sum all backends into modelResidentBytes"
  );
  assert.ok(
    /modelRssBytes: modelResidentBytes/.test(serverSource),
    "modelRssBytes must be the summed figure"
  );
  assert.ok(
    !/modelRssBytes: modelProcess \? modelProcess\.rssBytes : 0/.test(serverSource),
    "the single-backend version must be gone"
  );
});

test("the system payload carries the attribution the badge needs", () => {
  for (const field of ["modelResidentBytes", "wiredBytes", "compressedBytes", "appMemoryBytes"]) {
    assert.ok(
      new RegExp(`${field}[,:]`).test(serverSource),
      `src/server.js must expose ${field} in the memory attribution`
    );
  }
  assert.ok(/attribution,/.test(serverSource), "attribution must be attached to the memory payload");
});

test("a slot card names its figure as resident rather than implying a total", () => {
  assert.ok(
    /text: `\$\{fmtBytes\(rssBytes\)\} resident`/.test(appSource),
    "the slot pill must say resident"
  );
  assert.ok(
    /Model on disk: \$\{fmtBytes\(onDiskBytes\)\}/.test(appSource),
    "the slot tooltip must carry the model's own size, so 3.9 GB for a 25 GB model reads correctly"
  );
});
