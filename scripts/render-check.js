"use strict";
// Smoke-check the dashboard in a real browser.
//
// The frontend has no unit tests that execute it: public/app.js and
// public/benchmarks-tab.js touch the DOM at load, so they cannot be required.
// A render that throws halfway leaves a half-drawn page and nothing fails, so
// this loads the live dashboard in headless Chrome and asserts that the markers
// each section produces are present and that the page logged no error.
//
//   npm run render-check                  # against http://127.0.0.1:7075
//   npm run render-check -- http://host:port
//
// It needs a running dashboard and Google Chrome. When either is missing it
// says so and exits 0, so it never fails a machine that cannot run it.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

// Each marker is something a specific part of the render chain emits. Together
// they say the page got all the way through, not just far enough to paint.
const MARKERS = [
  ["page body", /<body/],
  ["slot cards", /id="slots"|data-slot-id=/],
  ["benchmarks section", /id="sec-benchmarks"/],
  ["benchmarks toolbar", /id="bmSearch"/],
  ["benchmarks filter chips", /data-bm-filter="status:all"/],
  ["benchmarks panel tabs", /data-bm-panel="results"/],
  ["benchmarks run strip", /id="bmRunStrip"/],
];

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

async function main() {
  const url = process.argv[2] || "http://127.0.0.1:7075/";
  const chrome = findChrome();
  if (!chrome) {
    console.log("render-check: skipped, no Chrome or Chromium found");
    return 0;
  }
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.log(`render-check: skipped, nothing answering at ${url}`);
    return 0;
  }

  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await execFileAsync(
      chrome,
      ["--headless", "--disable-gpu", "--dump-dom", "--virtual-time-budget=9000", "--enable-logging=stderr", "--v=0", url],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
    ));
  } catch (error) {
    stdout = error.stdout || "";
    stderr = error.stderr || "";
    if (!stdout) {
      console.error(`render-check: chrome failed: ${error.message}`);
      return 1;
    }
  }

  let failed = 0;
  for (const [label, pattern] of MARKERS) {
    const ok = pattern.test(stdout);
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  }

  // Chrome logs plenty of its own errors (keychain, display link) that say
  // nothing about the page; only script failures matter here.
  const pageErrors = String(stderr)
    .split("\n")
    .filter((line) => /Uncaught|TypeError|ReferenceError|SyntaxError/.test(line));
  if (pageErrors.length) {
    failed += 1;
    console.log(`FAIL  page script errors:\n      ${pageErrors.slice(0, 5).join("\n      ")}`);
  } else {
    console.log("ok    no page script errors");
  }

  console.log(failed ? `render-check: ${failed} problem(s)` : "render-check: ok");
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(`render-check: ${error.message}`);
  process.exit(1);
});
