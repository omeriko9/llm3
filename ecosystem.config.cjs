const path = require("path");
const REPO_ROOT = __dirname;

// Machine-specific settings come from a git-ignored `.env` at the repo root.
// src/server.js loads the same file and applies every default itself, so only
// the values pm2 needs to know about are set here.
require("./src/local-env").loadLocalEnv(path.join(REPO_ROOT, ".env"));

module.exports = {
  apps: [
    {
      name: "llm3",
      cwd: REPO_ROOT,
      script: "src/server.js",
      env: {
        PORT: process.env.PORT || "7075",
        HOST: process.env.HOST || "0.0.0.0",
        LLM3_SLOT_COUNT: process.env.LLM3_SLOT_COUNT || "4",
      },
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 2000,
      time: true,
      // pm2 defaults to treekill, which signals every descendant of the app.
      // Hugging Face downloads run in a detached, unref'd worker precisely so
      // they outlive a restart -- but the worker is still a direct child at
      // kill time, so treekill reached it and a routine `pm2 restart llm3`
      // aborted a download mid-file. Slots survive today only because their
      // launcher script daemonizes and is reparented before the walk sees it.
      // Signal the server alone and let it decide what to take down with it.
      treekill: false,
    },
  ],
};
