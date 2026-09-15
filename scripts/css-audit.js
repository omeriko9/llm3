"use strict";
// Report CSS class selectors that nothing in the page sources mentions.
//
//   npm run css-audit                       # every stylesheet in public/
//   node scripts/css-audit.js public/x.css  # one file
//
// Deliberately conservative, because deleting a rule that is still used is
// worse than keeping a dead one. A class counts as used when:
//   * its literal name appears in any JS or HTML source, or
//   * a template literal could compose it (`bm-tier-${x}` keeps every
//     `bm-tier-*`), or
//   * it is on the list of names applied by a vendored library at runtime
//     (KaTeX and markdown-it write their own markup, so the repository never
//     mentions those class names).
//
// It also strips comments and string/URL literals from the CSS before looking
// for selectors: `url("http://www.w3.org/...")` otherwise reads as the classes
// `.w3` and `.org`.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_FILES = [
  "public/app.js",
  "public/benchmarks-tab.js",
  "public/index.html",
  "public/neon-arena.html",
];

// Applied by vendored libraries at run time, so no source mentions them.
const VENDOR_CLASSES = [
  /^katex/,
  /^eqno$/,
  /^eqn$/,
  /^mord$/,
  /^tml-/,
  /^hljs/,
  /^markdown-it/,
  /^texmath/,
];

function stripCssNoise(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

function collectSources() {
  return SOURCE_FILES.map((rel) => path.join(ROOT, rel))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

function dynamicPrefixes(sources) {
  // `class="bm-tier-${x}"` means any bm-tier-* may be produced at run time.
  const prefixes = new Set();
  for (const match of sources.matchAll(/([a-zA-Z][\w-]*-)\$\{/g)) {
    prefixes.add(match[1]);
  }
  return prefixes;
}

function auditFile(rel, sources, prefixes) {
  const css = stripCssNoise(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  const classes = new Set();
  for (const match of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    classes.add(match[1]);
  }
  const unused = [...classes].filter((name) => {
    if (sources.includes(name)) return false;
    if (VENDOR_CLASSES.some((pattern) => pattern.test(name))) return false;
    for (const prefix of prefixes) {
      if (name.startsWith(prefix)) return false;
    }
    return true;
  });
  return { total: classes.size, unused: unused.sort() };
}

function main() {
  const targets = process.argv.slice(2);
  const files = targets.length
    ? targets
    : fs.readdirSync(path.join(ROOT, "public"))
        .filter((name) => name.endsWith(".css"))
        .map((name) => path.join("public", name));

  const sources = collectSources();
  const prefixes = dynamicPrefixes(sources);
  let totalUnused = 0;
  for (const rel of files) {
    const { total, unused } = auditFile(rel, sources, prefixes);
    totalUnused += unused.length;
    console.log(`${rel}: ${total} classes, ${unused.length} unreferenced`);
    if (unused.length) {
      console.log(`  ${unused.join(" ")}`);
    }
  }
  console.log(`\ndynamic prefixes honoured: ${[...prefixes].sort().join(" ") || "(none)"}`);
  console.log(`total unreferenced: ${totalUnused}`);
  // Reporting only: a name may still be produced somewhere this cannot see, so
  // this never fails a build.
  return 0;
}

process.exit(main());
