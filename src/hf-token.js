"use strict";

// Resolve the Hugging Face token the way huggingface_hub does: HF_TOKEN, then
// the file at HF_TOKEN_PATH, then $HF_HOME/token, then ~/.cache/huggingface/token.
// Reading only HF_TOKEN made every gated repo fail with a bare 401, because
// `hf auth login` writes the file and pm2 never exports the variable.
const fs = require("fs");
const os = require("os");
const path = require("path");

function resolveHfToken(env = process.env) {
  const fromEnv = String(env.HF_TOKEN || "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  const hfHome = String(env.HF_HOME || "").trim() || path.join(os.homedir(), ".cache", "huggingface");
  const tokenPath = String(env.HF_TOKEN_PATH || "").trim() || path.join(hfHome, "token");
  try {
    return fs.readFileSync(tokenPath, "utf8").trim();
  } catch (_error) {
    return "";
  }
}

function hfAuthHeaders(env = process.env) {
  const token = resolveHfToken(env);
  return token ? { authorization: `Bearer ${token}` } : {};
}

module.exports = { resolveHfToken, hfAuthHeaders };
