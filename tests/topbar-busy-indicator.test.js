"use strict";
// The topbar spinner used to report POLLING rather than work: every fetch's
// `loading` flag fed it, and refreshVoiceBenchmarkState runs on a 1s timer, so
// the tooltip sat on "preparing voice benchmark" while nothing was preparing.
// Separately, the spin class was toggled from state.actionInFlight alone, so
// the indicator could be visible and frozen at the same time.
//
// public/app.js is one classic script that touches the DOM at load, so it
// cannot be required; lift the pure collectors and evaluate them in isolation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function liftFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "m").exec(source);
  assert.ok(match, `function ${name} not found in public/app.js`);
  return match[0];
}

function liftConst(name) {
  const match = new RegExp(`^const ${name} = \\{[\\s\\S]*?^\\};`, "m").exec(source);
  assert.ok(match, `const ${name} not found in public/app.js`);
  return match[0];
}

const PRELUDE = [
  liftConst("SLOT_PHASE_TEXT"),
  liftFunction("slotName"),
  liftFunction("collectTopbarActivities"),
  liftFunction("topbarBusyTitle"),
].join("\n");

function evaluate(state) {
  const context = { state };
  vm.createContext(context);
  vm.runInContext(`${PRELUDE}\nthis.lines = collectTopbarActivities();\nthis.title = topbarBusyTitle(this.lines);`, context);
  // Cross-realm arrays are not reference-equal to this realm's Array, which
  // deepEqual checks; copy them back before asserting.
  return { lines: Array.from(context.lines), title: String(context.title) };
}

function baseState(overrides = {}) {
  return {
    actionInFlight: false,
    busyAction: null,
    slots: [],
    slotActivity: {},
    benchmarkStartInFlight: {},
    voiceBenchmark: { serverState: {} },
    hf: { downloads: [], loading: false },
    voiceTuningModal: { voiceLibrary: {} },
    launchersModal: { loading: false },
    ...overrides,
  };
}

test("an idle dashboard reports nothing", () => {
  const { lines, title } = evaluate(baseState());
  assert.deepEqual(lines, []);
  assert.equal(title, "No background activity");
});

test("routine pollers never light the indicator", () => {
  // These are the flags that made it lie. diagnostics, Hermes status, the
  // Hermes feed and the voice-benchmark STATE poll are housekeeping; the voice
  // poll alone runs every second.
  const state = baseState({
    diagnostics: { loading: true },
    hermesStatus: { loading: true },
    hermesFeedModal: { loading: true },
    voiceBenchmark: { loading: true, serverState: { status: "idle" } },
  });
  const { lines, title } = evaluate(state);
  assert.deepEqual(lines, [], "a poll in flight is not background activity");
  assert.equal(title, "No background activity");
  assert.ok(!title.includes("voice benchmark"), "the stuck 'preparing voice benchmark' tooltip is gone");
});

test("a generating slot is reported, with its phase and rate", () => {
  const state = baseState({
    slots: [{ id: "slot1", name: "General", label: "1st LLM" }],
    slotActivity: { slot1: { busy: true, phase: "decode", tokensPerSecond: 34.52 } },
  });
  const { lines, title } = evaluate(state);
  assert.deepEqual(lines, ["General: generating at 34.5 tok/s"]);
  assert.equal(title, "General: generating at 34.5 tok/s");
});

test("prefill reads as reading the prompt, and a missing rate is omitted", () => {
  const state = baseState({
    slots: [{ id: "slot2", name: "", label: "2nd LLM" }],
    slotActivity: { slot2: { busy: true, phase: "prefill" } },
  });
  assert.deepEqual(evaluate(state).lines, ["2nd LLM: reading the prompt"]);
});

test("a slot with a request open but no tokens yet says so", () => {
  // Prefill, a queued request or a stall: the proxy holds it, the runtime has
  // committed nothing. This whole window used to read as idle.
  const state = baseState({
    slots: [{ id: "slot1", name: "General" }],
    slotActivity: { slot1: { busy: true, source: "inflight", phase: null, tokensPerSecond: null } },
  });
  assert.deepEqual(evaluate(state).lines, ["General: handling a request"]);
});

test("an idle slot is not reported", () => {
  const state = baseState({
    slots: [{ id: "slot1", label: "1st LLM" }],
    slotActivity: { slot1: { busy: false, phase: "decode" } },
  });
  assert.deepEqual(evaluate(state).lines, []);
});

test("the startup Hugging Face prefetch is not reported as user activity", () => {
  // refreshHfSearch runs once on page load so the HF tab is populated when it
  // is opened. Reporting it made the spinner claim "Searching Hugging Face" on
  // every single page load, for a search nobody asked for.
  const background = baseState({ hf: { downloads: [], loading: true, loadingIsBackground: true } });
  assert.deepEqual(evaluate(background).lines, []);

  const userSearch = baseState({ hf: { downloads: [], loading: true, loadingIsBackground: false } });
  assert.deepEqual(evaluate(userSearch).lines, ["Searching Hugging Face"]);
});

test("only the startup call is marked background", () => {
  // Opening the tab and changing the sort are both `silent` and both
  // user-initiated, so `silent` is the wrong signal to hide on.
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const marked = source.match(/refreshHfSearch\(\{[^}]*background: true[^}]*\}\)/g) || [];
  assert.equal(marked.length, 1, "exactly one background prefetch");
  assert.match(liftFunction("refreshHfSearch"), /state\.hf\.loadingIsBackground = Boolean\(options\.background\)/);
});

test("the model action names itself", () => {
  const state = baseState({ actionInFlight: true, busyAction: { label: "Starting a model" } });
  assert.equal(evaluate(state).title, "Starting a model");
});

test("an action with no label still says something useful", () => {
  const state = baseState({ actionInFlight: true });
  assert.equal(evaluate(state).title, "Applying a model action");
});

test("downloads name the model and their progress", () => {
  const state = baseState({
    hf: {
      loading: false,
      downloads: [
        { id: "j1", status: "downloading", progressPct: 41.6, candidate: { fullName: "unsloth/Qwen3.8-27B-GGUF" } },
        { id: "j2", status: "completed", candidate: { fullName: "done/model" } },
      ],
    },
  });
  assert.deepEqual(evaluate(state).lines, ["Downloading unsloth/Qwen3.8-27B-GGUF (42%)"]);
});

test("a conversion says convert, not download", () => {
  const state = baseState({
    hf: { loading: false, downloads: [{ id: "j1", status: "running", kind: "convert", candidate: { name: "m" } }] },
  });
  assert.deepEqual(evaluate(state).lines, ["Converting m"]);
});

test("a running benchmark is reported; a finished one is not", () => {
  const state = baseState({
    slots: [
      { id: "slot1", label: "1st LLM", benchmark: { status: "running" } },
      { id: "slot2", label: "2nd LLM", benchmark: { status: "completed" } },
    ],
  });
  assert.deepEqual(evaluate(state).lines, ["1st LLM: benchmark running"]);
});

test("a running voice benchmark carries its stage detail", () => {
  const state = baseState({
    voiceBenchmark: { serverState: { status: "running", currentStageDetail: "synthesising take 3/8" } },
  });
  assert.deepEqual(evaluate(state).lines, ["Voice benchmark: synthesising take 3/8"]);
});

test("everything running shows up, not just the first match", () => {
  const state = baseState({
    actionInFlight: true,
    busyAction: { label: "Starting a model" },
    slots: [{ id: "slot1", label: "1st LLM" }],
    slotActivity: { slot1: { busy: true, phase: "decode", tokensPerSecond: 20 } },
    hf: { loading: false, downloads: [{ id: "j1", status: "downloading", candidate: { name: "m" } }] },
  });
  const { lines, title } = evaluate(state);
  assert.equal(lines.length, 3, "a priority list would have shown only one");
  assert.match(title, /^3 things running:/);
  for (const line of lines) {
    assert.ok(title.includes(line), `tooltip must list: ${line}`);
  }
});

test("the spin and the visibility come from one collector", () => {
  // They used to be two functions on two call paths, so the indicator could be
  // shown and frozen at once. renderTopbarBusyIndicators now sets both, and
  // updateTopbarSpinner only delegates to it.
  const renderer = liftFunction("renderTopbarBusyIndicators");
  assert.match(renderer, /collectTopbarActivities\(\)/);
  assert.match(renderer, /classList\.toggle\("spinning", visible\)/);
  const legacy = liftFunction("updateTopbarSpinner");
  assert.match(legacy, /renderTopbarBusyIndicators\(\)/);
  assert.ok(!/state\.actionInFlight/.test(legacy), "the spin must not read actionInFlight alone");
});

// --- tooltips must not blink on every poll -----------------------------------
//
// Writing `title` dismisses the native tooltip the browser is showing, even
// when the value is identical. The dashboard rewrote titles from its pollers,
// so a tooltip you were reading blinked out every 2 seconds.

function titleHarness() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${liftFunction("isPointerOver")}\n${liftFunction("setLiveTitle")}
    this.setLiveTitle = setLiveTitle;`, context);
  return context.setLiveTitle;
}

function fakeElement({ title = "", hover = false } = {}) {
  const attributes = { title };
  return {
    hovered: hover,
    writes: 0,
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    setAttribute(name, value) {
      attributes[name] = value;
      this.writes += 1;
    },
    matches(selector) {
      return selector === ":hover" ? this.hovered : false;
    },
  };
}

test("an unchanged title is never rewritten", () => {
  const setLiveTitle = titleHarness();
  const element = fakeElement({ title: "General: generating at 30.0 tok/s" });
  setLiveTitle(element, "General: generating at 30.0 tok/s");
  assert.equal(element.writes, 0, "rewriting the same text still dismisses the tooltip");
});

test("a changed title is written when the pointer is elsewhere", () => {
  const setLiveTitle = titleHarness();
  const element = fakeElement({ title: "old" });
  setLiveTitle(element, "new");
  assert.equal(element.writes, 1);
  assert.equal(element.getAttribute("title"), "new");
});

test("the title is not yanked out from under the pointer", () => {
  // A native tooltip cannot be updated in place: while it is being read the
  // choice is a stale tooltip or no tooltip, and stale wins.
  const setLiveTitle = titleHarness();
  const element = fakeElement({ title: "General: generating at 30.0 tok/s", hover: true });
  setLiveTitle(element, "General: generating at 31.4 tok/s");
  assert.equal(element.writes, 0, "the tooltip being read must survive the poll");
  assert.equal(element.getAttribute("title"), "General: generating at 30.0 tok/s");
});

test("the pending title lands once the pointer moves away", () => {
  const setLiveTitle = titleHarness();
  const element = fakeElement({ title: "old", hover: true });
  setLiveTitle(element, "new");
  assert.equal(element.getAttribute("title"), "old");
  element.hovered = false;
  setLiveTitle(element, "new");
  assert.equal(element.getAttribute("title"), "new", "the next poll catches it up");
});

test("a missing element is tolerated", () => {
  const setLiveTitle = titleHarness();
  assert.doesNotThrow(() => setLiveTitle(null, "x"));
  assert.doesNotThrow(() => setLiveTitle(undefined, "x"));
});

test("the busy indicator writes its title through the guard", () => {
  const renderer = liftFunction("renderTopbarBusyIndicators");
  assert.match(renderer, /setLiveTitle\(element, title\)/);
  assert.ok(!/setAttribute\("title"/.test(renderer), "a raw title write blinks the tooltip");
});

test("the slot readouts write their titles through the guard", () => {
  const readout = liftFunction("updateSlotThroughputReadout");
  assert.match(readout, /setLiveTitle\(pill,/);
  assert.match(readout, /setLiveTitle\(line,/);
  assert.ok(!/\b(pill|line)\.title = /.test(readout), "these run on the 2s activity poll");
});

test("the slot strip is not rebuilt under the pointer", () => {
  // innerHTML destroys the element being hovered, so a CSS hover tooltip or a
  // native title on a slot card vanished on every poll.
  const strip = liftFunction("renderModelsSlotStrip");
  assert.match(strip, /isPointerOver\(els\.modelsSlotStrip\)/);
  const guardIndex = strip.indexOf("isPointerOver(els.modelsSlotStrip)");
  // The word "innerHTML" also appears in the comment above the guard; match the
  // assignment itself.
  const writeIndex = strip.indexOf("els.modelsSlotStrip.innerHTML =");
  assert.ok(guardIndex > -1 && writeIndex > -1 && guardIndex < writeIndex, "the guard must come before the rebuild");
});

test("the slot strip repaints under the pointer when an action ends", () => {
  // A stop ran with the pointer on the strip. The repaint during the action
  // built every select as disabled, and the hover guard then kept that markup
  // after the action ended: no model could be started until the user switched
  // tabs and back.
  const strip = { dataset: {}, innerHTML: "", matches: () => true };
  const context = { state: { actionInFlight: true }, els: { modelsSlotStrip: strip } };
  vm.createContext(context);
  vm.runInContext(`${liftFunction("renderModelsSlotStrip")}
    function isSlotRenameInputFocused() { return false; }
    function isPointerOver(el) { return el.matches(":hover"); }
    function buildModelsSlotStripItems() { return [{}]; }
    function renderModelsSlotStripCard() { return state.actionInFlight ? "<select disabled>" : "<select>"; }
    renderModelsSlotStrip({ force: true });
    this.during = els.modelsSlotStrip.innerHTML;
    state.actionInFlight = false;
    renderModelsSlotStrip();
    this.after = els.modelsSlotStrip.innerHTML;
    els.modelsSlotStrip.innerHTML = "untouched";
    renderModelsSlotStrip();
    this.idlePoll = els.modelsSlotStrip.innerHTML;`, context);
  assert.match(context.during, /disabled/);
  assert.doesNotMatch(context.after, /disabled/);
  // With nothing changed, the hover guard still holds.
  assert.equal(context.idlePoll, "untouched");
});

// --- the lock the indicator must never touch ---------------------------------
//
// Inference is not a slot action. A model generating must never disable Launch,
// Stop, Save or anything else: the whole point of four slots is that you can
// load one while another is answering.

test("beginBusyAction and endBusyAction actually flip the flag, and endBusyAction does not recurse", () => {
  // A blanket rename of `state.actionInFlight = false;` rewrote the body of
  // endBusyAction into a call to itself. Every action's `finally` then threw
  // RangeError, so actionInFlight was never cleared and the global buttons
  // stayed disabled until the next overview poll -- Launch looked frozen for
  // a minute or two.
  const context = { state: { actionInFlight: false, busyAction: null } };
  vm.createContext(context);
  vm.runInContext(`${liftFunction("beginBusyAction")}\n${liftFunction("endBusyAction")}
    begin: { beginBusyAction("Starting a model"); }
    this.afterBegin = { flag: state.actionInFlight, label: state.busyAction && state.busyAction.label };
    endBusyAction();
    this.afterEnd = { flag: state.actionInFlight, action: state.busyAction };`, context);
  assert.deepEqual({ ...context.afterBegin }, { flag: true, label: "Starting a model" });
  assert.deepEqual({ ...context.afterEnd }, { flag: false, action: null });
});

test("endBusyAction clears the flag it is named for", () => {
  // Guards the specific shape of the bug: the body must assign the flag, not
  // call itself.
  const lifted = liftFunction("endBusyAction");
  assert.match(lifted, /state\.actionInFlight = false;/);
  // Drop the declaration line; it necessarily contains the name.
  const body = lifted.split("\n").slice(1).join("\n");
  assert.ok(!/\bendBusyAction\(/.test(body), "endBusyAction must not call itself");
});

test("a generating slot never disables the global action buttons", () => {
  // The buttons are gated on state.actionInFlight alone. Inference sets
  // slotActivity, never that flag, so loading another slot stays available.
  const gate = liftFunction("renderGlobalActionButtons");
  assert.match(gate, /setGlobalActionButtonsDisabled\(Boolean\(state\.actionInFlight\)\)/);

  const state = baseState({
    slots: [{ id: "slot1", name: "General" }],
    slotActivity: { slot1: { busy: true, phase: "decode", tokensPerSecond: 30 } },
  });
  assert.equal(state.actionInFlight, false, "inference must not raise the action lock");
  const { lines } = evaluate(state);
  assert.equal(lines.length, 1, "it is reported in the tooltip...");
  assert.ok(!state.actionInFlight, "...and nowhere near the lock");
});

test("the indicator renderer never touches the button gate", () => {
  // Reporting activity and blocking the UI are different jobs; the spinner
  // must not acquire the right to disable anything.
  const renderer = liftFunction("renderTopbarBusyIndicators");
  assert.ok(!/setGlobalActionButtonsDisabled/.test(renderer));
  assert.ok(!/actionInFlight\s*=/.test(renderer), "the renderer must not write the lock");
  const collector = liftFunction("collectTopbarActivities");
  assert.ok(!/actionInFlight\s*=/.test(collector), "the collector only reads the lock");
});

test("the slot-activity poll refreshes the indicator", () => {
  // Otherwise a generation would only reach the topbar on the 5s overview.
  const refresh = liftFunction("refreshSlotActivity");
  assert.match(refresh, /renderTopbarBusyIndicators\(\)/);
});
