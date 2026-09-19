"use strict";
// Diagnostics -> Model chat: the thinking panel is its own scroll container, so
// it needs the tail-following rule the transcript already has. public/app.js is
// one classic script that touches the DOM at load, so lift the helpers out and
// run them against a small fake element, the way frontend-helpers.test.js does.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function liftFunction(name) {
  const match = new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, "m").exec(source);
  assert.ok(match, `function ${name} not found in public/app.js`);
  return match[0];
}

function liftLine(prefix) {
  const match = new RegExp(`^${prefix}.*$`, "m").exec(source);
  assert.ok(match, `${prefix} not found in public/app.js`);
  return match[0];
}

const prelude = `
  const chatState = { slotId: "slot1" };
  let pinnedTranscript = false;
  function chatScrollPinned() { return pinnedTranscript; }
  function chatMarkUnread() {}
  function renderMarkdown(text) { return text; }
`;

const api = vm.runInNewContext([
  prelude,
  liftLine("const CHAT_THINK_SLACK_PX"),
  liftLine("const chatThinkPin"),
  liftFunction("chatThinkFollows"),
  liftFunction("chatThinkPre"),
  liftFunction("chatThinkReadPin"),
  liftFunction("chatThinkFollowTail"),
  liftFunction("chatUpdateStreamInPlace"),
  "({ chatUpdateStreamInPlace, chatThinkPin })",
].join("\n"));

// --- the smallest DOM these helpers touch ---------------------------------
const LINE_PX = 2;          // pixels per character of reasoning
const PANEL_PX = 100;       // the 14rem cap on .chat-think pre

function makeLog() {
  const pre = {
    text: "",
    clientHeight: PANEL_PX,
    scrollTop: 0,
    get scrollHeight() { return Math.max(PANEL_PX, this.text.length * LINE_PX); },
    get textContent() { return this.text; },
    set textContent(value) { this.text = String(value); },
    append(value) { this.text += String(value); },
  };
  const summary = { textContent: "" };
  const body = { innerHTML: "" };
  const node = {
    querySelector(selector) {
      if (selector === "[data-think-body]") return pre;
      if (selector === "[data-think-summary]") return summary;
      if (selector === ".chat-bubble.chat-md") return body;
      return null;
    },
  };
  const log = {
    scrollTop: 0,
    clientHeight: 400,
    scrollHeight: 400,
    lastElementChild: node,
    querySelector(selector) {
      if (selector === '[data-chat-stream="1"]') return node;
      if (selector === '[data-chat-stream="1"] [data-think-body]') return pre;
      return null;
    },
  };
  return { log, pre, summary, body };
}

function conversation(reasoning, content = "") {
  return { messages: [{ role: "assistant", content, reasoning, streaming: true, error: "" }] };
}

test("the thinking panel follows the tail while the model thinks", () => {
  api.chatThinkPin.clear();
  const { log, pre, summary } = makeLog();
  const conv = conversation("");
  for (let step = 1; step <= 5; step += 1) {
    conv.messages[0].reasoning += "x".repeat(200);
    assert.equal(api.chatUpdateStreamInPlace(log, conv), true);
    assert.equal(pre.scrollTop, pre.scrollHeight, `panel left behind after chunk ${step}`);
  }
  assert.equal(pre.text, conv.messages[0].reasoning);
  assert.equal(summary.textContent, `thinking · ${conv.messages[0].reasoning.length} chars`);
});

test("a reader who scrolls up keeps the offset across chunks", () => {
  api.chatThinkPin.clear();
  const { log, pre } = makeLog();
  const conv = conversation("y".repeat(400));
  api.chatUpdateStreamInPlace(log, conv);

  pre.scrollTop = 120;                      // the reader scrolls back
  for (let step = 1; step <= 4; step += 1) {
    conv.messages[0].reasoning += "y".repeat(200);
    api.chatUpdateStreamInPlace(log, conv);
    assert.equal(pre.scrollTop, 120, `panel moved under the reader on chunk ${step}`);
  }

  pre.scrollTop = pre.scrollHeight - pre.clientHeight;   // back to the tail
  conv.messages[0].reasoning += "y".repeat(200);
  api.chatUpdateStreamInPlace(log, conv);
  assert.equal(pre.scrollTop, pre.scrollHeight, "following did not resume at the tail");
});

test("the text is appended, never rebuilt, while it only grows", () => {
  api.chatThinkPin.clear();
  const { log, pre } = makeLog();
  const conv = conversation("first ");
  api.chatUpdateStreamInPlace(log, conv);
  let rebuilt = 0;
  Object.defineProperty(pre, "textContent", {
    get() { return pre.text; },
    set(value) { rebuilt += 1; pre.text = String(value); },
  });
  conv.messages[0].reasoning += "second";
  api.chatUpdateStreamInPlace(log, conv);
  assert.equal(rebuilt, 0);
  assert.equal(pre.text, "first second");
});

test("a shape change hands the turn back to the full render", () => {
  api.chatThinkPin.clear();
  const { log } = makeLog();
  // The think block is on screen but the message carries no reasoning yet.
  assert.equal(api.chatUpdateStreamInPlace(log, conversation("")), false);
  // The stream ended.
  const finished = conversation("z".repeat(50));
  finished.messages[0].streaming = false;
  assert.equal(api.chatUpdateStreamInPlace(log, finished), false);
  // The turn failed.
  const failed = conversation("z".repeat(50));
  failed.messages[0].error = "stream failed";
  assert.equal(api.chatUpdateStreamInPlace(log, failed), false);
});
