"use strict";
// llm3 called a website online whenever its port accepted a TCP connection.
// comfy-waker breaks that rule on purpose: it holds ComfyUI's port open while
// ComfyUI itself is stopped and holding no memory, so the card read "Online"
// for a service that was not running at all.
//
// The fix asks the waker. These tests pin the three things that must hold:
// a waker's answer is trusted, any other server's answer is not, and an
// ordinary website is not re-probed on every poll.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  parseWakerStatus,
  probeWaker,
  createWakerProbe,
} = require("../src/waker-status.js");

const AWAKE = JSON.stringify({
  waker: "comfy-waker", app: "ComfyUI", pm2App: "comfyui",
  awake: true, waking: false, upstream: "127.0.0.1:8189",
});
const ASLEEP = JSON.stringify({
  waker: "comfy-waker", app: "ComfyUI", pm2App: "comfyui",
  awake: false, waking: false, upstream: "127.0.0.1:8189",
});

test("an awake waker reports the service it fronts", () => {
  const status = parseWakerStatus(AWAKE);
  assert.equal(status.waker, "comfy-waker");
  assert.equal(status.pm2App, "comfyui");
  assert.equal(status.awake, true);
});

test("a sleeping service is not online", () => {
  assert.equal(parseWakerStatus(ASLEEP).awake, false);
});

test("only a waker's answer counts as a waker", () => {
  // Any server may answer /waker/status with something. A 404 page, an empty
  // body or another app's JSON must never be read as a sleeping service,
  // because that would take a healthy website offline in the UI.
  assert.equal(parseWakerStatus("<html>Not Found</html>"), null);
  assert.equal(parseWakerStatus(""), null);
  assert.equal(parseWakerStatus(JSON.stringify({ status: "ok" })), null);
  assert.equal(parseWakerStatus(JSON.stringify([1, 2])), null);
  assert.equal(parseWakerStatus(null), null);
});

test("a missing awake flag is read as asleep, never as awake", () => {
  const status = parseWakerStatus(JSON.stringify({ waker: "comfy-waker", awake: "yes" }));
  assert.equal(status.awake, false);
});

// --- probeWaker over a faked http module -------------------------------------

function fakeHttp({ statusCode = 200, body = AWAKE, fail = null, hang = false }) {
  return {
    request(_options, onResponse) {
      const request = new EventEmitter();
      request.end = () => {
        if (hang) {
          setImmediate(() => request.emit("timeout"));
          return;
        }
        if (fail) {
          setImmediate(() => request.emit("error", new Error(fail)));
          return;
        }
        const response = new EventEmitter();
        response.statusCode = statusCode;
        response.setEncoding = () => {};
        response.destroy = () => {};
        setImmediate(() => {
          onResponse(response);
          response.emit("data", body);
          response.emit("end");
        });
      };
      request.destroy = () => {};
      return request;
    },
  };
}

test("probeWaker reads a live waker", async () => {
  assert.equal((await probeWaker(8188, { httpImpl: fakeHttp({}) })).pm2App, "comfyui");
});

test("probeWaker returns null for a refused port, a timeout, or a non-200", async () => {
  assert.equal(await probeWaker(8188, { httpImpl: fakeHttp({ fail: "ECONNREFUSED" }) }), null);
  assert.equal(await probeWaker(8188, { httpImpl: fakeHttp({ hang: true }) }), null);
  assert.equal(await probeWaker(8188, { httpImpl: fakeHttp({ statusCode: 404, body: "nope" }) }), null);
});

// --- the cache ---------------------------------------------------------------

test("an ordinary website is probed once, not on every poll", async () => {
  let calls = 0;
  const wakerForPort = createWakerProbe({
    probe: async () => { calls += 1; return null; },
    negativeTtlMs: 600000,
    now: () => 1000,
  });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await wakerForPort(8183), null);
  }
  assert.equal(calls, 1, "a site that is not a waker must not be re-probed on every poll");
});

test("the negative answer expires", async () => {
  let calls = 0;
  let clock = 1000;
  const wakerForPort = createWakerProbe({
    probe: async () => { calls += 1; return null; },
    negativeTtlMs: 5000,
    now: () => clock,
  });
  await wakerForPort(8183);
  clock += 6000;
  await wakerForPort(8183);
  assert.equal(calls, 2);
});

test("a waker is re-read every time, because its answer changes", async () => {
  // This is the point of the whole module: sleep and wake must show up at once.
  let awake = true;
  let calls = 0;
  const wakerForPort = createWakerProbe({
    probe: async () => { calls += 1; return { waker: "comfy-waker", pm2App: "comfyui", awake }; },
  });
  assert.equal((await wakerForPort(8188)).awake, true);
  awake = false;
  assert.equal((await wakerForPort(8188)).awake, false);
  assert.equal(calls, 2);
});

test("ports are cached apart, so one site cannot answer for another", async () => {
  const seen = [];
  const wakerForPort = createWakerProbe({
    probe: async (port) => { seen.push(port); return null; },
  });
  await wakerForPort(8183);
  await wakerForPort(8188);
  assert.deepEqual(seen, [8183, 8188]);
});
