"use strict";
// Top bar: the ComfyUI indicator, the memory "who holds it" tooltip and the GPU
// utilisation sampler. app.js touches the DOM at load, so its pure helpers are
// lifted and run in a vm; the server parsers are exported from src/server.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const server = require("../src/server");
const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function liftFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "m").exec(source);
  assert.ok(match, `function ${name} not found in public/app.js`);
  return match[0];
}

function runInApp(names, expression, extra = {}) {
  const context = { result: null, ...extra };
  vm.createContext(context);
  vm.runInContext(`${names.map(liftFunction).join("\n")}\nresult = ${expression};`, context);
  return context.result;
}

const IOREG = `+-o AGXAcceleratorG16X  <class AGXAcceleratorG16X>
    "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=58093305856,"Tiler Utilization %"=0,"Renderer Utilization %"=1,"Device Utilization %"=98,"In use system memory"=513966080}`;

test("GPU utilisation and Metal allocations are read from IOAccelerator", () => {
  assert.deepEqual(server.parseIoAcceleratorStats(IOREG), { utilization: 98, allocBytes: 58093305856 });
  assert.deepEqual(server.parseIoAcceleratorStats("nothing here"), { utilization: null, allocBytes: null });
});

const TOP = `Processes: 612 total
PID    MEM   CMPRS COMMAND
37993  53G   20G   llama-server
56480  25G   14G   python3.11
75368  4506M 4122M java
97821  550M+ 6272K mediaanalysisd
`;

test("top's footprint table is parsed with its units, the header skipped", () => {
  const rows = server.parseTopMemoryConsumers(TOP);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { pid: 37993, bytes: 53 * 1024 ** 3, compressedBytes: 20 * 1024 ** 3, command: "llama-server" });
  assert.equal(rows[2].bytes, 4506 * 1024 ** 2);
  assert.equal(rows[3].bytes, 550 * 1024 ** 2, "a trailing + (still growing) is tolerated");
  assert.equal(server.parseTopSize("12B"), 12);
  assert.equal(server.parseTopSize("n/a"), null);
});

test("the ComfyUI indicator says what a click will do", () => {
  const view = (status, busy = "") => runInApp(["comfyIndicatorView"], `comfyIndicatorView(${JSON.stringify(status)}, ${JSON.stringify(busy)})`);
  const on = view({ available: true, awake: true, waking: false, pm2App: "comfyui" });
  assert.equal(on.state, "online");
  assert.match(on.title, /Click to stop/);
  const off = view({ available: true, awake: false, waking: false, pm2App: "comfyui" });
  assert.equal(off.state, "offline");
  assert.match(off.title, /Click to start/);
  assert.equal(view({ available: true, awake: false, waking: true }).state, "waking");
  assert.equal(view({ available: false, error: "ECONNREFUSED" }).state, "unknown");
  assert.equal(view({ available: true, awake: true }, "stop").state, "waking", "a click in flight shows progress");
});

test("the memory tooltip names the biggest consumers and the unattributed wired block", () => {
  const memory = {
    usedPercent: 93, totalBytes: 128 * 1024 ** 3,
    breakdown: { wiredBytes: 51 * 1024 ** 3, appMemoryBytes: 30 * 1024 ** 3, compressedBytes: 37 * 1024 ** 3 },
    swap: { usedBytes: 4.8 * 1024 ** 3, totalBytes: 6 * 1024 ** 3 },
    topConsumers: [
      { name: "Main LLM (model)", bytes: 53 * 1024 ** 3, compressedBytes: 20 * 1024 ** 3 },
      { name: "comfyui", bytes: 25 * 1024 ** 3, compressedBytes: 0 },
    ],
  };
  const fmtBytes = (bytes) => `${Math.round(bytes / 1024 ** 3)} GB`;
  const text = runInApp(["memoryTooltip"], `memoryTooltip(${JSON.stringify(memory)})`, { fmtBytes });
  assert.match(text, /Memory 93% used/);
  assert.match(text, /Swap 5 GB of 6 GB/);
  assert.match(text, /53 GB {2}Main LLM \(model\) \(20 GB compressed\)/);
  assert.match(text, /25 GB {2}comfyui$/m);
  assert.match(text, /not counted per process/);
});

test("the busy indicator has a calm idle state instead of a frozen spinner", () => {
  const renderer = liftFunction("renderTopbarBusyIndicators");
  assert.match(renderer, /element\.hidden = false/);
  assert.match(renderer, /classList\.toggle\("idle", !visible\)/);
  assert.match(renderer, /classList\.toggle\("spinning", visible\)/);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.match(css, /\.topbar-busy-indicator\.idle \.topbar-busy-spinner \{[^}]*animation: none/);
});

test("the home service's answer is read as JSON or as a bare word", () => {
  assert.equal(server.parseHomeStatus({ isHome: true }), true);
  assert.equal(server.parseHomeStatus({ isHome: false }), false);
  assert.equal(server.parseHomeStatus({ isHome: "true" }), true);
  assert.equal(server.parseHomeStatus("true"), true);
  assert.equal(server.parseHomeStatus("nope"), false);
});

test("the house is yellow at home, grey away, dim when the service is down", () => {
  const view = (status) => runInApp(["homeIndicatorView"], `homeIndicatorView(${JSON.stringify(status)})`);
  assert.equal(view({ available: true, isHome: true }).state, "home");
  assert.equal(view({ available: true, isHome: false }).state, "away");
  assert.equal(view({ available: false, error: "timeout" }).state, "unknown");
  assert.match(view({ available: false, error: "timeout" }).title, /unavailable \(timeout\)/);
});

test("the house tells the user a click opens its link, only when one is set", () => {
  const view = (status) => runInApp(["homeIndicatorView"], `homeIndicatorView(${JSON.stringify(status)})`);
  assert.match(view({ available: true, isHome: true, link: "http://example.test" }).title, /Click to open it in a new tab/);
  assert.doesNotMatch(view({ available: true, isHome: true, link: null }).title, /Click/);
});
