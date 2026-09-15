"use strict";
// Loads machine-specific settings from a repo-local `.env` file.
//
// The repository ships neutral defaults only. Every value that is specific to
// one machine — LAN addresses, SSH identities, host labels, model directories —
// belongs in `.env`, which is git-ignored. Real environment variables always
// win, so pm2/launchd can still override anything here.
//
// Format: KEY=value, one per line. `#` starts a comment. Quotes are optional.
// A key with an empty value (`KEY=`) is skipped, so the template's blank
// placeholders never turn an "is this set?" flag on by accident.
const fs = require("fs");
const path = require("path");

function loadLocalEnv(envPath = path.join(__dirname, "..", ".env")) {
  const applied = [];
  let text;
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    return applied; // no .env — defaults apply
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (value === "") continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

module.exports = { loadLocalEnv };
