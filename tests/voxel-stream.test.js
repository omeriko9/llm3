const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const {
  postSseLong,
  detectDegenerate,
  tailRepeats,
  lineDiversity,
  REASONING_RUNAWAY_TOKENS,
} = require("../src/voxel-stream");

function denseHtml(lines = 400) {
  let out = "";
  for (let i = 0; i < lines; i += 1) {
    out += `  ctx.fillRect(${i}, ${(i * 7) % 13}, 8, 8); // block ${i}\n`;
  }
  return out;
}

test("dense procedurally-varied markup is not flagged", () => {
  const html = denseHtml();
  assert.equal(tailRepeats(html), null);
  assert.equal(lineDiversity(html).ratio, 1);
  assert.equal(detectDegenerate({ answerTokens: 9000, reasoningTokens: 0, answer: [html] }), "");
});

test("a repeated block is flagged", () => {
  const loop = '<div class="px"></div>\n'.repeat(500);
  const hit = tailRepeats(loop);
  assert.ok(hit && hit.copies >= 4);
  assert.match(
    detectDegenerate({ answerTokens: 9000, reasoningTokens: 0, answer: [loop] }),
    /repeated a \d+-character block/,
  );
});

test("padding with occasional unique lines is still flagged", () => {
  let text = "";
  for (let i = 0; i < 400; i += 1) {
    text += i % 37 === 0 ? `  // note ${i}\n` : "  drawPixel(x, y, c);\n";
  }
  assert.notEqual(detectDegenerate({ answerTokens: 9000, reasoningTokens: 0, answer: [text] }), "");
});

test("the diversity check catches padding the cycle detector misses", () => {
  // Duplicate-heavy but never four identical blocks in a row at the tail, so
  // tailRepeats cannot fire and lineDiversity is the only thing left.
  // Nine identical lines per unique one (ratio ~0.1), and the text ends on a
  // unique line so the tail is not a clean cycle.
  let text = "";
  for (let group = 0; group < 30; group += 1) {
    text += "  drawPixel(x, y, c);\n".repeat(9);
    text += `  // group ${group}\n`;
  }
  assert.equal(tailRepeats(text), null, "no clean 4x tail cycle here");
  assert.match(
    detectDegenerate({ answerTokens: 9000, reasoningTokens: 0, answer: [text] }),
    /distinct lines/,
  );
});

test("short output is never flagged", () => {
  const loop = '<div class="px"></div>\n'.repeat(500);
  assert.equal(detectDegenerate({ answerTokens: 100, reasoningTokens: 0, answer: [loop] }), "");
});

test("runaway reasoning is flagged regardless of answer length", () => {
  assert.match(
    detectDegenerate({ answerTokens: 0, reasoningTokens: REASONING_RUNAWAY_TOKENS, answer: [""] }),
    /reasoning ran to/,
  );
});

// One SSE server shared by the transport tests below.
function sseServer(chunks) {
  return http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("reasoning and answer deltas are accumulated separately", async () => {
  const server = sseServer([
    { choices: [{ delta: { reasoning_content: "thinking " } }] },
    { choices: [{ delta: { reasoning_content: "harder " } }] },
    { choices: [{ delta: { content: "<html>" } }] },
    { choices: [{ delta: { content: "</html>" }, finish_reason: "stop" }] },
    { choices: [], usage: { completion_tokens: 4 } },
  ]);
  const port = await listen(server);
  try {
    const res = await postSseLong(`http://127.0.0.1:${port}/v1/chat/completions`, {}, 10_000);
    assert.equal(res.ok, true);
    assert.equal(res.body.choices[0].message.content, "<html></html>");
    assert.equal(res.stream.reasoning, "thinking harder ");
    assert.equal(res.stream.reasoningTokens, 2);
    assert.equal(res.stream.answerTokens, 2);
    assert.equal(res.stream.finishReason, "stop");
    assert.equal(res.stream.abortReason, "");
  } finally {
    server.close();
  }
});

test("a non-streaming backend still returns a usable body", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "<html></html>" }, finish_reason: "stop" }] }));
  });
  const port = await listen(server);
  try {
    const res = await postSseLong(`http://127.0.0.1:${port}/v1/chat/completions`, {}, 10_000);
    assert.equal(res.ok, true);
    assert.equal(res.stream.unsupported, true);
    assert.equal(res.body.choices[0].message.content, "<html></html>");
  } finally {
    server.close();
  }
});

test("a degenerate stream is cut short and reports why", async () => {
  // Enough repeated deltas to pass LOOP_MIN_TOKENS and trip the tail detector.
  const chunks = [];
  for (let i = 0; i < 9000; i += 1) {
    chunks.push({ choices: [{ delta: { content: '<div class="px"></div>\n' } }] });
  }
  const server = sseServer(chunks);
  const port = await listen(server);
  try {
    const res = await postSseLong(`http://127.0.0.1:${port}/v1/chat/completions`, {}, 30_000);
    assert.match(res.stream.abortReason, /repeated a \d+-character block/);
    assert.ok(res.stream.answerTokens < 9000, "should stop before consuming every delta");
  } finally {
    server.close();
  }
});

test("scene runs pin their sampling so models are compared on equal terms", () => {
  // A scene run used to inherit whatever the active profile held for the slot,
  // so a model measured under one profile was scored against a model measured
  // under another, and a re-run could differ from itself.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "voxel-test.js"), "utf8");

  assert.match(source, /const SCENE_SAMPLING = Object\.freeze\(\{/);
  // The slot's values are spread first and the fixed ones last, so the pinned
  // sampling wins rather than being overwritten by the profile.
  assert.match(source, /return \{ \.\.\.next, \.\.\.SCENE_SAMPLING \};/);
  // Every sampling field the scene request sends must be pinned, or the ones
  // left out keep leaking in from the profile.
  for (const field of ["temperature", "topP", "topK", "minP", "presencePenalty", "repetitionPenalty"]) {
    const block = /const SCENE_SAMPLING = Object\.freeze\(\{[\s\S]*?\}\);/.exec(source)[0];
    assert.ok(block.includes(`${field}:`), `${field} is not pinned for scene runs`);
  }
  // And the result has to say what it was generated with.
  assert.match(source, /entry\.sampling = \{/);
  assert.match(source, /sampling: entry\.sampling \|\| null,/);
});
