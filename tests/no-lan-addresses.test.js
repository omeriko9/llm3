"use strict";
// No tracked file may contain the private /16 LAN prefix -- not an address, not
// a comment, not a regex. This repository is public; a home-network address in a
// tracked file (or a commit message) is published with the history.
//
// Runs in `npm test` and in the pre-commit hook (scripts/pre-commit-guard.sh),
// which checks the STAGED content: that is exactly what the commit will record.
// Real addresses belong in the git-ignored .env; code that has to recognise the
// range compares octets instead of writing the prefix (see isPrivateLan16Host).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
// Built from parts so this file does not match itself.
const NEEDLE = ["192", "168"].join(".");

function gitGrep(extraArgs) {
  try {
    const out = execFileSync("git", ["grep", "-n", "-I", "-F", ...extraArgs, NEEDLE], {
      cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").filter(Boolean);
  } catch (error) {
    if (error.status === 1) {
      return []; // git grep exits 1 when nothing matches
    }
    throw error;
  }
}

test("no staged file contains the private LAN prefix", () => {
  const hits = gitGrep(["--cached"]);
  assert.deepEqual(hits, [], `the private LAN prefix is in files about to be committed:\n${hits.join("\n")}`);
});

test("no tracked file in the working tree contains the private LAN prefix", () => {
  const hits = gitGrep([]);
  assert.deepEqual(hits, [], `the private LAN prefix is in tracked files:\n${hits.join("\n")}`);
});

test("the LAN check still recognises the range without writing it", () => {
  const { isPrivateLan16Host } = require("../src/server");
  const [a, b] = NEEDLE.split(".");
  assert.equal(isPrivateLan16Host(`${a}.${b}.1.7`), true);
  assert.equal(isPrivateLan16Host("10.0.0.1"), false);
  assert.equal(isPrivateLan16Host(`${a}.${b}.1`), false, "not a full IPv4 address");
  assert.equal(isPrivateLan16Host("localhost"), false);
});
