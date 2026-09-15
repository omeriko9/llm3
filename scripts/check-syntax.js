"use strict";
// `node --check` over every JavaScript file the project ships. The previous
// check listed four files by hand and missed src/local-env.js,
// src/hf-download-worker.js, src/voxel-*.js, and scripts/.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DIRS = ["src", "public", "scripts", "tests"];
const files = ["ecosystem.config.cjs"];
for (const dir of DIRS) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    if (/\.(c?js)$/.test(name)) files.push(path.join(dir, name));
  }
}
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    failed += 1;
    process.stderr.write(String(error.stderr || error.message));
  }
}
console.log(`check-syntax: ${files.length - failed}/${files.length} files ok`);
process.exit(failed ? 1 : 0);
