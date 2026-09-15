"use strict";
// public/app.js is one classic script that touches the DOM at load, so it
// cannot be required. The escaping helpers are self-contained; lift their
// source out of the file and evaluate them in isolation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function lift(name) {
  const match = new RegExp(`^function ${name}\\(value\\) \\{[\\s\\S]*?^\\}`, "m").exec(source);
  assert.ok(match, `function ${name} not found in public/app.js`);
  return match[0];
}

const helpers = vm.runInNewContext(`${lift("esc")}\n${lift("safeHref")}\n({ esc, safeHref })`);

test("esc neutralizes markup and attribute quotes", () => {
  assert.equal(helpers.esc(`<img src=x onerror="alert(1)">`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(helpers.esc(null), "");
  assert.equal(helpers.esc(0), "0");
});

test("safeHref allows http(s), root-relative, and fragment links only", () => {
  assert.equal(helpers.safeHref("https://example.com/a?b=1&c=2"), "https://example.com/a?b=1&amp;c=2");
  assert.equal(helpers.safeHref("http://10.0.0.5:8080/"), "http://10.0.0.5:8080/");
  assert.equal(helpers.safeHref("/local/path"), "/local/path");
  assert.equal(helpers.safeHref("#top"), "#top");
  assert.equal(helpers.safeHref("javascript:alert(1)"), "#");
  assert.equal(helpers.safeHref("data:text/html,x"), "#");
  assert.equal(helpers.safeHref("//evil.example/x"), "#");
  assert.equal(helpers.safeHref(`" onmouseover="alert(1)`), "#");
  assert.equal(helpers.safeHref(""), "#");
  assert.equal(helpers.safeHref(undefined), "#");
});
