"use strict";
// Copies the browser bundles that public/index.html loads from /vendor/* out of
// node_modules. public/vendor/ is git-ignored; `npm install` runs this through
// the postinstall hook, so a fresh clone has the files without a manual step.
//
// Only the woff2 fonts are copied: KaTeX's @font-face lists woff2 first, so a
// modern browser never requests the woff/ttf fallbacks.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MODULES = path.join(ROOT, "node_modules");
const TARGET = path.join(ROOT, "public", "vendor");

const FILES = [
  ["katex/dist/katex.min.js", "katex/katex.min.js"],
  ["katex/dist/katex.min.css", "katex/katex.min.css"],
  ["katex/LICENSE", "katex/LICENSE"],
  ["markdown-it/dist/browser/markdown-it.umd.min.js", "markdown-it/markdown-it.umd.min.js"],
  ["markdown-it/LICENSE", "markdown-it/LICENSE"],
  ["markdown-it-texmath/texmath.js", "markdown-it-texmath/texmath.js"],
  ["markdown-it-texmath/css/texmath.css", "markdown-it-texmath/texmath.css"],
  ["markdown-it-texmath/license.txt", "markdown-it-texmath/license.txt"],
];

function copy(fromRel, toRel) {
  const from = path.join(MODULES, fromRel);
  const to = path.join(TARGET, toRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function main() {
  if (!fs.existsSync(MODULES)) {
    console.error("sync-vendor: node_modules is missing; run npm install first");
    process.exit(1);
  }
  for (const [from, to] of FILES) copy(from, to);

  const fontDir = path.join(MODULES, "katex", "dist", "fonts");
  const fonts = fs.readdirSync(fontDir).filter((name) => name.endsWith(".woff2"));
  for (const name of fonts) copy(path.join("katex", "dist", "fonts", name), path.join("katex", "fonts", name));

  console.log(`sync-vendor: copied ${FILES.length} files and ${fonts.length} fonts to public/vendor`);
}

main();
