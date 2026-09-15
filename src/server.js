const express = require("express");
const fsSync = require("fs");
const fs = require("fs/promises");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { randomUUID, createHash } = require("crypto");
const { execFile, spawn, execFileSync } = require("child_process");
const { promisify } = require("util");
const yaml = require("js-yaml");
const Database = require("better-sqlite3");
const { attachPerfDashboardRoutes } = require("./perf-dashboard-routes");
const { createDashboardAuth, describeAuthPosture } = require("./dashboard-auth");
const { CONVERSION_QUANT_PLANS, DEFAULT_CONVERSION_QUANTIZATION } = require("./hf-download-worker");
const { loadLocalEnv } = require("./local-env");

// Machine-specific settings live in a git-ignored `.env`; the repo ships
// neutral defaults. Must run before any process.env read below.
loadLocalEnv();

const execFileAsync = promisify(execFile);

const app = express();
const HOME = os.homedir();
const REPO_ROOT = path.resolve(__dirname, "..");
const BIN_DIR = path.join(REPO_ROOT, "bin");
const PORT = Number(process.env.PORT || 7075);
const HOST = process.env.HOST || "0.0.0.0";
const DEFAULT_EXEC_PATH = process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_TMPDIR = process.env.TMPDIR || "/tmp";
const DEFAULT_XDG_STATE_HOME = process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state");
const DEFAULT_XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || path.join(HOME, ".local", "cache");
const DEFAULT_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
const DEFAULT_XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share");
const SERVICE_MODE = String(process.env.LLM3_SERVICE_MODE || "").trim() || "interactive";
const LAUNCHD_DOMAIN = String(process.env.LLM3_LAUNCHD_DOMAIN || "").trim();
const LAUNCHD_GUI_UID = Number.parseInt(process.env.LLM3_GUI_UID || `${typeof process.getuid === "function" ? process.getuid() : ""}`, 10);
const RUNTIME_USER = process.env.USER || process.env.LOGNAME || safeOsUserName();
const NORMALIZED_EXEC_ENV = Object.freeze({
  ...process.env,
  PATH: DEFAULT_EXEC_PATH,
  HOME,
  USER: RUNTIME_USER,
  LOGNAME: process.env.LOGNAME || RUNTIME_USER,
  TMPDIR: DEFAULT_TMPDIR,
  XDG_STATE_HOME: DEFAULT_XDG_STATE_HOME,
  XDG_CACHE_HOME: DEFAULT_XDG_CACHE_HOME,
  XDG_CONFIG_HOME: DEFAULT_XDG_CONFIG_HOME,
  XDG_DATA_HOME: DEFAULT_XDG_DATA_HOME,
  LANG: process.env.LANG || "en_US.UTF-8",
  LC_ALL: process.env.LC_ALL || process.env.LANG || "en_US.UTF-8",
});
const LAUNCHER_ENV_EXCLUDED_KEYS = new Set(["HOST", "PORT", "OSLogRateLimit", "XPC_FLAGS", "XPC_SERVICE_NAME"]);
const LAUNCHER_ENV_EXCLUDED_PREFIXES = ["CLAUDE_", "HERMES_", "LIBRECHAT_", "LLM3_", "SQLITE_APP_", "REMOTE_JSON_APP_"];
const NORMALIZED_LAUNCHER_ENV = Object.freeze(buildLauncherExecEnv());
const DEFAULT_REMOTE_SSH_KEY_PATH = path.join(HOME, "keys", "nginx_server_key.pem");
const DEFAULT_HERMES_SYNC_PASSWORD_FILE = path.join(HOME, "pass.txt");
const HERMES_SYNC_HOST = process.env.HERMES_SYNC_HOST || "127.0.0.1";
const HERMES_SYNC_USER = process.env.HERMES_SYNC_USER || "user";
const HERMES_SYNC_PASSWORD_FILE = process.env.HERMES_SYNC_PASSWORD_FILE || DEFAULT_HERMES_SYNC_PASSWORD_FILE;
const HERMES_SYNC_PASSWORD = readOptionalSecret(process.env.HERMES_SYNC_PASSWORD, HERMES_SYNC_PASSWORD_FILE);
const HERMES_SYNC_SSH_KEY = process.env.HERMES_SYNC_SSH_KEY || DEFAULT_REMOTE_SSH_KEY_PATH;
// The secondary Linux machine whose pm2 processes this dashboard also lists.
const REMOTE_HOST = process.env.LLM3_REMOTE_HOST || HERMES_SYNC_HOST;
const REMOTE_SSH_USER = process.env.LLM3_REMOTE_SSH_USER || HERMES_SYNC_USER;
const REMOTE_SSH_KEY = process.env.LLM3_REMOTE_SSH_KEY || HERMES_SYNC_SSH_KEY;
const REMOTE_SSH_TARGET = `${REMOTE_SSH_USER}@${REMOTE_HOST}`;
// Labels shown in the dashboard for "this machine" and the remote one.
const LOCAL_MACHINE_LABEL = process.env.LLM3_LOCAL_LABEL || "Local";
const REMOTE_MACHINE_LABEL = process.env.LLM3_REMOTE_LABEL || "Remote";
// Host that terminates TLS for the published subdomains, if any.
const NGINX_HOST_IP = process.env.LLM3_NGINX_HOST || "127.0.0.1";
const HERMES_SYNC_HOME = process.env.HERMES_SYNC_HOME || "/home/user/.hermes";
const HERMES_SYNC_PYTHON =
  process.env.HERMES_SYNC_PYTHON || path.posix.join(HERMES_SYNC_HOME, "hermes-agent", "venv", "bin", "python");
const HERMES_SYNC_CONFIG_PATH =
  process.env.HERMES_SYNC_CONFIG_PATH || path.posix.join(HERMES_SYNC_HOME, "config.yaml");
const HERMES_SYNC_CACHE_PATH =
  process.env.HERMES_SYNC_CACHE_PATH || path.posix.join(HERMES_SYNC_HOME, "context_length_cache.yaml");
const HERMES_SYNC_SERVICE = process.env.HERMES_SYNC_SERVICE || "hermes-gateway.service";
const HERMES_SYNC_BASE_URL = normalizeOptionalHttpUrl(process.env.HERMES_SYNC_BASE_URL, "HERMES_SYNC_BASE_URL");
const HERMES_SYNC_ENABLED =
  process.env.HERMES_SYNC_ENABLED != null
    ? process.env.HERMES_SYNC_ENABLED !== "false"
    : hasRemoteShellAuth(HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY);
const HERMES_M4_HOME = process.env.HERMES_M4_HOME || path.join(HOME, ".hermes");
const HERMES_M4_CONFIG_PATH = process.env.HERMES_M4_CONFIG_PATH || path.join(HERMES_M4_HOME, "config.yaml");
const HERMES_M4_CACHE_PATH =
  process.env.HERMES_M4_CACHE_PATH || path.join(HERMES_M4_HOME, "context_length_cache.yaml");
const DEFAULT_HERMES_M4_CONFIG_PATH = path.join(HERMES_M4_HOME, "config.yaml");
const PODG_HERMES_HOME = process.env.PODG_HERMES_HOME || path.join(HOME, ".hermes-podg");
const PODG_HERMES_CONFIG_PATH = process.env.PODG_HERMES_CONFIG_PATH || path.join(PODG_HERMES_HOME, "config.yaml");
const PODG_HERMES_CACHE_PATH =
  process.env.PODG_HERMES_CACHE_PATH || path.join(PODG_HERMES_HOME, "context_length_cache.yaml");
const PODG_HERMES_ENV_PATH = process.env.PODG_HERMES_ENV_PATH || path.join(PODG_HERMES_HOME, ".env");
const PODG_HERMES_ENABLED =
  process.env.PODG_HERMES_ENABLED != null
    ? process.env.PODG_HERMES_ENABLED !== "false"
    : true;
const PODG_AUTO_RANDOM_HERMES_HOME = process.env.PODG_AUTO_RANDOM_HERMES_HOME || path.join(HOME, ".hermes-podg-ag");
const PODG_AUTO_RANDOM_HERMES_CONFIG_PATH =
  process.env.PODG_AUTO_RANDOM_HERMES_CONFIG_PATH || path.join(PODG_AUTO_RANDOM_HERMES_HOME, "config.yaml");
const PODG_AUTO_RANDOM_HERMES_CACHE_PATH =
  process.env.PODG_AUTO_RANDOM_HERMES_CACHE_PATH || path.join(PODG_AUTO_RANDOM_HERMES_HOME, "context_length_cache.yaml");
const PODG_AUTO_RANDOM_HERMES_ENV_PATH =
  process.env.PODG_AUTO_RANDOM_HERMES_ENV_PATH || path.join(PODG_AUTO_RANDOM_HERMES_HOME, ".env");
const PODG_AUTO_RANDOM_HERMES_ENABLED =
  process.env.PODG_AUTO_RANDOM_HERMES_ENABLED != null
    ? process.env.PODG_AUTO_RANDOM_HERMES_ENABLED !== "false"
    : true;
const HERMES_M4_ENABLED =
  process.env.HERMES_M4_ENABLED != null
    ? process.env.HERMES_M4_ENABLED !== "false"
    : true;
const HERMES_HOME = path.join(HOME, ".hermes");
const HERMES_LOG_DIR = path.join(HERMES_HOME, "logs");
const HERMES_AGENT_LOG_PATH = path.join(HERMES_LOG_DIR, "agent.log");
const HERMES_ERRORS_LOG_PATH = path.join(HERMES_LOG_DIR, "errors.log");
const HERMES_GATEWAY_ERROR_LOG_PATH = path.join(HERMES_LOG_DIR, "gateway.error.log");
const HERMES_SESSIONS_DIR = path.join(HERMES_HOME, "sessions");
const API_PUBLIC_HOST = "127.0.0.1";
const LOCAL_IPV4_ADDRESSES = new Set(
  Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4")
    .map((entry) => entry.address)
    .filter(Boolean)
);
const LOCAL_LLM_API_KEY = String(process.env.LLM3_LOCAL_API_KEY || "llm3-local-api-key").trim() || "llm3-local-api-key";
const DASHBOARD_AUTH_TOKEN = String(process.env.LLM3_AUTH_TOKEN || "").trim();
const HF_FETCH_TIMEOUT_MS = 60 * 1000;
const VOICE_RUNTIME_PROBE_TIMEOUT_MS = 10 * 1000;
const VOICE_RUNTIME_SYNTH_TIMEOUT_MS = 10 * 60 * 1000;
// Host-key policy for every ssh/scp the dashboard runs. "accept-new" records a
// host on first contact and refuses a changed key afterwards; "yes" requires
// the key to be in known_hosts already; "no" trusts anything (the old default).
const SSH_HOST_KEY_POLICY = (() => {
  const value = String(process.env.LLM3_SSH_HOST_KEY_POLICY || "accept-new").trim().toLowerCase();
  return ["yes", "no", "accept-new"].includes(value) ? value : "accept-new";
})();

// Seconds ssh waits for a TCP connection before giving up. Short on purpose: a
// slot action blocks the dashboard until its application syncs finish.
const SSH_CONNECT_TIMEOUT_SECONDS = Math.max(1, Number(process.env.LLM3_SSH_CONNECT_TIMEOUT || 5));
// Ceiling on one whole remote shell, connect plus the script it runs.
const REMOTE_SHELL_TIMEOUT_MS = Math.max(5000, Number(process.env.LLM3_REMOTE_SHELL_TIMEOUT_MS || 45_000));

function sshHostKeyArgs() {
  return ["-o", `StrictHostKeyChecking=${SSH_HOST_KEY_POLICY}`];
}
const SLOT_COUNT = Math.max(1, Number(process.env.LLM3_SLOT_COUNT || 4));
const SLOT_STATE_DIR = process.env.LLM3_STATE_DIR || path.join(DEFAULT_XDG_STATE_HOME, "llm3");
const SERVER_LOG_PATH = path.join(SLOT_STATE_DIR, "server.log");
const DASHBOARD_CONFIG_PATH = path.join(SLOT_STATE_DIR, "dashboard-config.json");
const LOG_CLEAR_STATE_DIR = path.join(SLOT_STATE_DIR, "log-clears");
const LEGACY_SYNC_TARGET_PATH = path.join(SLOT_STATE_DIR, "sync-target.json");
const CLAUDE_SETTINGS_PATH = process.env.CLAUDE_SETTINGS_PATH || path.join(HOME, ".claude", "settings.json");
const CLAUDE_PROXY_DIR = process.env.CLAUDE_PROXY_DIR || path.join(HOME, ".local", "share", "claude-code-proxy");
const CLAUDE_PROXY_ENV_PATH = process.env.CLAUDE_PROXY_ENV_PATH || path.join(CLAUDE_PROXY_DIR, ".env");
const CLAUDE_PROXY_LAUNCH_LABEL = process.env.CLAUDE_PROXY_LAUNCH_LABEL || "com.llm3.claude-qwen-proxy";
const CLAUDE_PROXY_ROOT_URL = process.env.CLAUDE_PROXY_ROOT_URL || "http://127.0.0.1:4000/";
const CLAUDE_SYNC_ENABLED =
  process.env.CLAUDE_SYNC_ENABLED != null
    ? process.env.CLAUDE_SYNC_ENABLED !== "false"
    : false;
const LIBRECHAT_SYNC_HOST = process.env.LIBRECHAT_SYNC_HOST || HERMES_SYNC_HOST;
const LIBRECHAT_SYNC_USER = process.env.LIBRECHAT_SYNC_USER || HERMES_SYNC_USER;
const LIBRECHAT_SYNC_PASSWORD = process.env.LIBRECHAT_SYNC_PASSWORD || HERMES_SYNC_PASSWORD;
const LIBRECHAT_SYNC_SSH_KEY = process.env.LIBRECHAT_SYNC_SSH_KEY || HERMES_SYNC_SSH_KEY;
const LIBRECHAT_SYNC_HOME = process.env.LIBRECHAT_SYNC_HOME || "/home/user";
const LIBRECHAT_SYNC_CONFIG_PATH =
  process.env.LIBRECHAT_SYNC_CONFIG_PATH || path.posix.join(LIBRECHAT_SYNC_HOME, "LibreChat", "librechat.yaml");
const LIBRECHAT_SYNC_SCRIPT_PATH =
  process.env.LIBRECHAT_SYNC_SCRIPT_PATH || path.posix.join(HERMES_SYNC_HOME, "scripts", "set-librechat-llm.sh");
const LIBRECHAT_SYNC_CONTAINER = process.env.LIBRECHAT_SYNC_CONTAINER || "LibreChat";
const LIBRECHAT_SYNC_ENDPOINT_NAME = process.env.LIBRECHAT_SYNC_ENDPOINT_NAME || "Qwen3.6";
const LIBRECHAT_SYNC_ENABLED =
  process.env.LIBRECHAT_SYNC_ENABLED != null
    ? process.env.LIBRECHAT_SYNC_ENABLED !== "false"
    : hasRemoteShellAuth(LIBRECHAT_SYNC_PASSWORD, LIBRECHAT_SYNC_SSH_KEY);
// Three generic app integrations follow the loaded model: a remote app with an
// llm_config.json (edited over SSH), a local app that keeps its settings in
// SQLite, and a local voice app restarted with LLM_URL/LLM_MODEL. The code names
// no real app: set the display names, paths and pm2 apps in .env.
const REMOTE_JSON_APP_LABEL = process.env.REMOTE_JSON_APP_LABEL || "Remote JSON app";
const SQLITE_APP_LABEL = process.env.SQLITE_APP_LABEL || "SQLite app";
const VOICE_APP_LABEL = process.env.VOICE_APP_LABEL || "Voice app";
// Extra env variable names that hold a pm2 app's port, besides PORT (comma list).
const PM2_EXTRA_PORT_ENV_KEYS = String(process.env.LLM3_PM2_PORT_ENV_KEYS || "")
  .split(",").map((key) => key.trim()).filter(Boolean);
const REMOTE_JSON_APP_SYNC_HOST = process.env.REMOTE_JSON_APP_SYNC_HOST || HERMES_SYNC_HOST;
const REMOTE_JSON_APP_SYNC_USER = process.env.REMOTE_JSON_APP_SYNC_USER || HERMES_SYNC_USER;
const REMOTE_JSON_APP_SYNC_PASSWORD = process.env.REMOTE_JSON_APP_SYNC_PASSWORD || HERMES_SYNC_PASSWORD;
const REMOTE_JSON_APP_SYNC_SSH_KEY = process.env.REMOTE_JSON_APP_SYNC_SSH_KEY || HERMES_SYNC_SSH_KEY;
const REMOTE_JSON_APP_SYNC_HOME = process.env.REMOTE_JSON_APP_SYNC_HOME || "/home/user";
const REMOTE_JSON_APP_SYNC_CONFIG_PATH =
  process.env.REMOTE_JSON_APP_SYNC_CONFIG_PATH || "";
const REMOTE_JSON_APP_SYNC_PM2_APP = process.env.REMOTE_JSON_APP_SYNC_PM2_APP || "";
const REMOTE_JSON_APP_SYNC_EXTRA_PM2_APP = process.env.REMOTE_JSON_APP_SYNC_EXTRA_PM2_APP || "";
const REMOTE_JSON_APP_SYNC_ENABLED =
  process.env.REMOTE_JSON_APP_SYNC_ENABLED != null
    ? process.env.REMOTE_JSON_APP_SYNC_ENABLED !== "false"
    : hasRemoteShellAuth(REMOTE_JSON_APP_SYNC_PASSWORD, REMOTE_JSON_APP_SYNC_SSH_KEY);
const SQLITE_APP_SYNC_ROOT = process.env.SQLITE_APP_SYNC_ROOT || "";
const SQLITE_APP_SYNC_DB_PATH = process.env.SQLITE_APP_SYNC_DB_PATH || "";
const SQLITE_APP_SYNC_PM2_APP = process.env.SQLITE_APP_SYNC_PM2_APP || "";
const SQLITE_APP_SYNC_API_KEY = process.env.SQLITE_APP_SYNC_API_KEY || "api";
const SQLITE_APP_SYNC_ENABLED =
  process.env.SQLITE_APP_SYNC_ENABLED != null
    ? process.env.SQLITE_APP_SYNC_ENABLED !== "false"
    : true;
const VOICE_APP_PM2_APP = process.env.VOICE_APP_PM2_APP || "";
const VOICE_APP_ROOT = process.env.VOICE_APP_ROOT || "";
// ---- Gaming PC (Windows, optional second machine) ------------------------
const GAMING_PC_SYNC_HOST = process.env.GAMING_PC_SYNC_HOST || "127.0.0.1";
const GAMING_PC_SYNC_USER = process.env.GAMING_PC_SYNC_USER || "user";
const GAMING_PC_SYNC_SSH_KEY = process.env.GAMING_PC_SYNC_SSH_KEY || path.join(HOME, ".ssh", "id_ed25519_gaming");
const GAMING_PC_SYNC_TIMEOUT_SECONDS = Number(process.env.GAMING_PC_SYNC_TIMEOUT_SECONDS || 15);
const GAMING_PC_SYNC_ENABLED =
  process.env.GAMING_PC_SYNC_ENABLED != null
    ? process.env.GAMING_PC_SYNC_ENABLED !== "false"
    : true;
// The Windows user profile the synced agent configs live under. Set
// GAMING_PC_HOME (or any individual path below) in .env for your own machine.
const GAMING_PC_HOME = process.env.GAMING_PC_HOME || "C:\\Users\\User";
const GAMING_PC_CONFIG_PATHS = Object.freeze({
  hermes: process.env.GAMING_PC_HERMES_CONFIG_PATH || `${GAMING_PC_HOME}\\AppData\\Local\\hermes\\config.yaml`,
  omp: process.env.GAMING_PC_OMP_CONFIG_PATH || `${GAMING_PC_HOME}\\.omp\\agent\\models.yaml`,
  opencode: process.env.GAMING_PC_OPENCODE_CONFIG_PATH || `${GAMING_PC_HOME}\\.config\\opencode\\opencode.jsonc`,
  pi: process.env.GAMING_PC_PI_CONFIG_PATH || `${GAMING_PC_HOME}\\.pi\\agent\\models.json`,
  // Selector files: these name the active model, so they go stale the moment the
  // model list beside them is rewritten.
  piSettings: process.env.GAMING_PC_PI_SETTINGS_PATH || `${GAMING_PC_HOME}\\.pi\\agent\\settings.json`,
  ompSettings: process.env.GAMING_PC_OMP_SETTINGS_PATH || `${GAMING_PC_HOME}\\.omp\\agent\\config.yml`,
});
const VOICE_APP_SYNC_ENABLED =
  process.env.VOICE_APP_SYNC_ENABLED != null
    ? process.env.VOICE_APP_SYNC_ENABLED !== "false"
    : true;
const GGUF_LAUNCHER = process.env.QWEN_LLAMA || path.join(BIN_DIR, "qwen_llama");
const GGUF_TQ3_LAUNCHER = process.env.QWEN_LLAMA_TQ3 || path.join(BIN_DIR, "qwen_llama_tq3");
const BEELLAMA_LAUNCHER = process.env.QWEN_BEELLAMA || path.join(BIN_DIR, "qwen_llama_beellama");
const BEELLAMA_METAL_SERVER = path.join(REPO_ROOT, "vendor", "beellama.cpp", "build-metal", "bin", "llama-server");
const MLX_LAUNCHER = process.env.QWEN_MLX || path.join(BIN_DIR, "run-qwen36-mlx-api.sh");
const RAPID_MLX_LAUNCHER = process.env.QWEN_RAPID_MLX || path.join(BIN_DIR, "run-qwen36-rapid-mlx-api.sh");
const MTPLX_LAUNCHER = process.env.QWEN_MTPLX || path.join(BIN_DIR, "run-qwen36-mtplx-api.sh");
// mlx-dspark speculation mode. "auto" lets its registry pick the measured-best head
// for the target (DFlash 2 on Qwen3.8-27B-8bit: 37 tok/s vs DSpark's 24, measured
// 2026-08-22); the explicit values exist so a slot can be pinned for A/B work.
const DSPARK_MODES = ["auto", "dflash", "dspark", "lookup", "baseline"];
function normalizeDsparkMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return DSPARK_MODES.includes(raw) ? raw : null;
}

// "" / null = leave the model's chat template alone (Qwen3.8's own template asks for
// xhigh). "off" becomes --no-thinking; the levels become --reasoning-effort.
// NB "high" is deliberately absent. mlx-dspark's CLI accepts it, but Qwen3.8's chat
// template hard-fails on it — `TemplateError: Unexpected reasoning effort high.
// Supported types are xhigh (default), medium, and low.` — so offering it would break
// every request on this model. Verified against the shipped template 2026-08-22.
const DSPARK_REASONING_EFFORTS = ["off", "low", "medium", "xhigh"];
function normalizeDsparkReasoningEffort(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return DSPARK_REASONING_EFFORTS.includes(raw) ? raw : null;
}

const MLX_DSPARK_LAUNCHER = process.env.MLX_DSPARK_LAUNCHER || path.join(BIN_DIR, "run-mlx-dspark-api.sh");
const MLX_DSPARK_PYTHON = path.join(HOME, ".venvs", "mlx-dspark", "bin", "python");
// mlx-vlm's own OpenAI server. Shares the mlx-dspark venv, where mlx-vlm is
// already installed as mlx-dspark's dependency. Point MLX_VLM_VENV elsewhere to
// split them.
const MLX_VLM_LAUNCHER = process.env.MLX_VLM_LAUNCHER || path.join(BIN_DIR, "run-mlx-vlm-api.sh");
// ds4 (DwarfStar) is a native Metal engine, not a GGUF runner: it loads one pack
// GGUF written by its own converter plus a mandatory external PLE sidecar. It is
// the fastest host on this box for Qwen3.8-Flash-Next (42 tok/s plain, 52-57
// with MTP, against 24-28 on mlx-vlm). See bin/run-ds4-api.sh.
const DS4_HOME = process.env.DS4_HOME || path.join(HOME, "ds4-metal");
const DS4_LAUNCHER = process.env.DS4_LAUNCHER || path.join(BIN_DIR, "run-ds4-api.sh");
const MLX_VLM_PYTHON = process.env.MLX_VLM_PYTHON || MLX_DSPARK_PYTHON;
const OPTIQ_LAUNCHER = process.env.QWEN_OPTIQ || path.join(BIN_DIR, "run-optiq-api.sh");
const MTPLX_BINARY = process.env.MTPLX_BINARY || path.join(HOME, ".venvs", "rapid-mlx", "bin", "mtplx");
const RAPID_MLX_VENV = path.join(HOME, ".venvs", "rapid-mlx");
const RAPID_MLX_PYTHON = path.join(RAPID_MLX_VENV, "bin", "python");
const OPTIQ_VENV = path.join(HOME, ".venvs", "mlx-optiq");
const OPTIQ_PYTHON = path.join(OPTIQ_VENV, "bin", "python");
const DFLASH_LAUNCHER = process.env.QWEN_DFLASH || path.join(BIN_DIR, "run-qwen36-dflash-api.sh");
const TURBO_QUANT_LAUNCHER = process.env.QWEN_TURBO_QUANT || path.join(BIN_DIR, "run-gpt-oss-turboquant-api.sh");
const Voice_TTS_LAUNCHER = process.env.VOICE_TTS_LAUNCHER || path.join(BIN_DIR, "voice-tts.sh");
const Voice_STT_LAUNCHER = process.env.VOICE_STT_LAUNCHER || path.join(BIN_DIR, "voice-stt.sh");
const MODELS_ROOT = path.join(HOME, "models");
const HF_MODELS_ROOT = path.join(MODELS_ROOT, "hf");
const GGUF_STATE_DIR = path.join(DEFAULT_XDG_STATE_HOME, "qwen_llama");
const GGUF_TQ3_STATE_DIR = path.join(DEFAULT_XDG_STATE_HOME, "qwen_llama_tq3");
const BEELLAMA_STATE_DIR = path.join(DEFAULT_XDG_STATE_HOME, "qwen_llama_beellama");
const MLX_STATE_DIR = path.join(DEFAULT_XDG_STATE_HOME, "qwen36_mlx");
const RAPID_MLX_STATE_DIR = path.join(DEFAULT_XDG_STATE_HOME, "qwen36_rapid_mlx");
const MTPLX_STATE_DIR = path.join(DEFAULT_XDG_STATE_HOME, "qwen36_mtplx");
const OPTIQ_STATE_DIR = path.join(DEFAULT_XDG_STATE_HOME, "optiq_api");
const DFLASH_STATE_DIR = path.join(DEFAULT_XDG_STATE_HOME, "qwen36_dflash");
const TURBO_QUANT_STATE_DIR = path.join(DEFAULT_XDG_STATE_HOME, "qwen36_turboquant");
const HF_STATE_DIR = path.join(SLOT_STATE_DIR, "hf");
const HF_JOBS_DIR = path.join(HF_STATE_DIR, "jobs");
const HF_JOB_LOGS_DIR = path.join(HF_STATE_DIR, "job-logs");
const HF_DOWNLOAD_WORKER = path.join(__dirname, "hf-download-worker.js");
const HF_TOOLS_DIR = path.join(HF_STATE_DIR, "tools");
const HF_LLAMA_CPP_DIR = path.join(HF_TOOLS_DIR, "llama.cpp");
const HF_USER_AGENT = "llm3/1.0";
const OVERVIEW_CACHE_TTL_MS = 1000;
const STATUS_SCRIPT_TIMEOUT_MS = 2500;
const DEFAULTS_SCRIPT_TIMEOUT_MS = 2500;
const PORT_PROBE_TIMEOUT_MS = 2500;
const LISTENING_PORT_CACHE_TTL_MS = 1000;
const MTPLX_INSPECT_TIMEOUT_MS = 15000;
const SLOT_ICON_NAMES = ["diamond", "orbit", "triangle", "hexagon", "square"];
const GGUF_BACKEND_PORT_BASE = 18036;
const GGUF_TQ3_BACKEND_PORT_BASE = 18636;
const BEELLAMA_BACKEND_PORT_BASE = 18736;
const MLX_BACKEND_PORT_BASE = 18136;
const RAPID_MLX_BACKEND_PORT_BASE = 18336;
const MTPLX_BACKEND_PORT_BASE = 18536;
const DFLASH_BACKEND_PORT_BASE = 18236;
const TURBO_QUANT_BACKEND_PORT_BASE = 18436;
const PUBLIC_API_PORT_BASE = 8036;
const INTEGRATION_KEYS = ["hermes", "openclaude", "chat"];
const VOICE_TTS_PUBLIC_PORT_BASE = 8040;
const VOICE_TTS_BACKEND_PORT_BASE = 18040;
const VOICE_STT_PUBLIC_PORT_BASE = 8042;
const VOICE_STT_BACKEND_PORT_BASE = 18042;
const VOICE_SLOT_COUNT = 2; // tts, stt
const VOICE_SLOT_TYPES = ["tts", "stt"];
const VOICE_SLOT_LABELS = ["Voice TTS", "Voice STT"];
const VOICE_TTS_TUNING_FIELDS = Object.freeze([
  { field: "exaggeration", cliFlag: "--exaggeration", defaultValue: 0.5, min: 0.0, max: 2.0 },
  { field: "cfgWeight", cliFlag: "--cfg-weight", defaultValue: 0.5, min: 0.0, max: 1.0 },
  { field: "temperature", cliFlag: "--temperature", defaultValue: 0.8, min: 0.1, max: 2.0 },
  { field: "repetitionPenalty", cliFlag: "--repetition-penalty", defaultValue: 2.0, min: 1.0, max: 5.0 },
  { field: "minP", cliFlag: "--min-p", defaultValue: 0.05, min: 0.0, max: 1.0 },
  { field: "topP", cliFlag: "--top-p", defaultValue: 1.0, min: 0.0, max: 1.0 },
  // seed also rides the runtime payload (buildVoiceTtsRuntimePayload); the cliFlag lets the
  // Voice tab persist it as the slot's default seed via the launcher (--seed → DEFAULT_SEED env).
  { field: "seed", cliFlag: "--seed", defaultValue: 1234, min: -1, max: 2147483647 },
  { field: "ttsChunkSize", cliFlag: "--tts-chunk-size", defaultValue: 400, min: 10, max: 1000 },
]);
const VOICE_TTS_TUNING_MODEL_KEYS = new Set([
  "chatterbox",
  "chatterbox-resemble",
  "chatterbox-multilingual",
  "phonikud-chatterbox",
  "phonikud-upstream",
]);
const VOICE_STATE_DIR = path.join(SLOT_STATE_DIR, "voice");
const VOICE_MODELS_ROOT = path.join(MODELS_ROOT, "voice");
const VOICE_BENCHMARK_DIR = path.join(VOICE_STATE_DIR, "benchmark");
const VOICE_BENCHMARK_RUNS_DIR = path.join(VOICE_BENCHMARK_DIR, "runs");
const VOICE_BENCHMARK_STATE_PATH = path.join(VOICE_BENCHMARK_DIR, "state.json");
const LLAMA_CPP_UPSTREAM_DIR = process.env.LLM3_LLAMA_CPP_DIR || path.join(HOME, "llama.cpp-upstream");
const LAUNCHER_BUILD_JOBS = String(Math.max(4, Math.min(12, os.cpus().length || 4)));
const LAUNCHER_DEFINITIONS = Object.freeze([
  {
    key: "gguf",
    name: "llama.cpp",
    family: "gguf",
    accent: "gguf",
    path: GGUF_LAUNCHER,
    versionKind: "git",
    versionPath: LLAMA_CPP_UPSTREAM_DIR,
    updateKind: "git",
    updatePath: LLAMA_CPP_UPSTREAM_DIR,
    buildDirs: ["build"],
  },
  {
    key: "gguf-tq3",
    name: "llama.cpp TQ3",
    family: "gguf",
    accent: "gguf",
    path: GGUF_TQ3_LAUNCHER,
    versionKind: "git",
    versionPath: path.join(REPO_ROOT, "vendor", "llama.cpp-tq3"),
    updateKind: "git",
    updatePath: path.join(REPO_ROOT, "vendor", "llama.cpp-tq3"),
    buildDirs: ["build"],
  },
  {
    key: "beellama",
    name: "beellama",
    family: "gguf",
    accent: "gguf",
    path: BEELLAMA_LAUNCHER,
    versionKind: "git",
    versionPath: path.join(REPO_ROOT, "vendor", "beellama.cpp"),
    updateKind: "git",
    updatePath: path.join(REPO_ROOT, "vendor", "beellama.cpp"),
    buildDirs: ["build", "build-metal"],
  },
  {
    key: "mlx",
    name: "MLX API proxy",
    family: "mlx",
    accent: "mlx",
    path: MLX_LAUNCHER,
    versionKind: "python-packages",
    pythonPath: RAPID_MLX_PYTHON,
    packages: ["mlx", "mlx-lm"],
    updateKind: "pip",
    updatePackages: ["mlx", "mlx-lm"],
  },
  {
    key: "rapid-mlx",
    name: "rapid-mlx",
    family: "mlx",
    accent: "mlx",
    path: RAPID_MLX_LAUNCHER,
    versionKind: "python-packages",
    pythonPath: RAPID_MLX_PYTHON,
    packages: ["rapid-mlx"],
    updateKind: "pip",
    updatePackages: ["rapid-mlx"],
  },
  {
    key: "mtplx",
    name: "MTPLX",
    family: "mlx",
    accent: "mtplx",
    path: MTPLX_LAUNCHER,
    versionKind: "python-packages",
    pythonPath: RAPID_MLX_PYTHON,
    packages: ["mtplx"],
    updateKind: "pip",
    updatePackages: ["mtplx"],
  },
  {
    key: "mlx-dspark",
    name: "MLX DSpark",
    family: "mlx",
    accent: "mtplx",
    path: MLX_DSPARK_LAUNCHER,
    versionKind: "python-packages",
    pythonPath: MLX_DSPARK_PYTHON,
    packages: ["mlx-dspark"],
    updateKind: "pip",
    updatePackages: ["mlx-dspark"],
  },
  {
    // The host for architectures mlx-lm has no implementation for and
    // mlx-dspark cannot wrap -- qwen4_exp (Qwen3.8-Flash-Next) is the first.
    // See bin/run-mlx-vlm-api.sh for why mlx-dspark cannot serve those.
    key: "mlx-vlm",
    name: "MLX VLM",
    family: "mlx",
    accent: "mlx",
    path: MLX_VLM_LAUNCHER,
    versionKind: "python-packages",
    pythonPath: MLX_VLM_PYTHON,
    packages: ["mlx-vlm"],
    updateKind: "pip",
    updatePackages: ["mlx-vlm"],
  },
  {
    // The ds4 build tree is a git checkout of ivanfioravanti/ds4-metal on the
    // qwen3.8-flash-next branch, so Update rebuilds it the way the llama.cpp
    // launchers are updated. It has no Python side.
    key: "ds4",
    name: "DwarfStar ds4",
    family: "gguf",
    accent: "gguf",
    path: DS4_LAUNCHER,
    versionKind: "git",
    versionPath: DS4_HOME,
    updateKind: "git",
    updatePath: DS4_HOME,
    buildDirs: [],
  },
  {
    key: "optiq",
    name: "OptIQ",
    family: "mlx",
    accent: "mlx",
    path: OPTIQ_LAUNCHER,
    versionKind: "python-packages",
    pythonPath: OPTIQ_PYTHON,
    packages: ["mlx-optiq"],
    updateKind: "pip",
    updatePackages: ["mlx-optiq"],
  },
]);

function safeOsUserName() {
  try {
    return os.userInfo().username || "";
  } catch (_error) {
    return "";
  }
}

function normalizeOptionalHttpUrl(value, envName = "URL") {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch (_error) {
    // Ignore invalid URL env overrides and fall back to per-target runtime URLs.
  }
  console.warn(`Ignoring invalid ${envName}: ${trimmed}`);
  return "";
}

function getExecOptions(options = {}) {
  return {
    ...options,
    env: {
      ...NORMALIZED_EXEC_ENV,
      ...(options.env || {}),
    },
  };
}

function buildLauncherExecEnv() {
  const env = {
    ...NORMALIZED_EXEC_ENV,
    TERM: process.env.TERM || "xterm-color",
  };
  for (const key of Object.keys(env)) {
    if (
      LAUNCHER_ENV_EXCLUDED_KEYS.has(key)
      || LAUNCHER_ENV_EXCLUDED_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete env[key];
    }
  }
  return env;
}

function getLauncherExecOptions(options = {}) {
  return {
    ...options,
    env: {
      ...NORMALIZED_LAUNCHER_ENV,
      ...(options.env || {}),
    },
  };
}

function getLauncherDefinition(launcherKey) {
  const key = String(launcherKey || "").trim();
  return LAUNCHER_DEFINITIONS.find((launcher) => launcher.key === key) || null;
}

function getLauncherDefinitions() {
  return LAUNCHER_DEFINITIONS.map((launcher) => ({
    key: launcher.key,
    name: launcher.name,
    family: launcher.family,
    accent: launcher.accent,
    path: launcher.path,
  }));
}

function buildLauncherCommandTemplate(launcherKey) {
  const definition = getLauncherDefinition(launcherKey);
  const launcherPath = definition?.path || "<launcher-path>";
  const slot = "<slot-id>";
  const modelPath = "<model-path>";
  const contextSize = "<ctx-size>";
  const parallel = "<parallel>";
  const temperature = "<temperature>";
  const topP = "<top-p>";
  const topK = "<top-k>";
  const minP = "<min-p>";
  const presencePenalty = "<presence-penalty>";
  const repetitionPenalty = "<repetition-penalty>";

  switch (String(launcherKey || "").trim()) {
    case "mlx":
    case "rapid-mlx":
      return `${launcherPath} --slot ${slot} --model ${modelPath} --context-size ${contextSize} --parallel ${parallel} --temperature ${temperature} --top-p ${topP} --top-k ${topK} --min-p ${minP} --presence-penalty ${presencePenalty} --repetition-penalty ${repetitionPenalty}`;
    case "mtplx":
      return `${launcherPath} --slot ${slot} --model ${modelPath} --context-size ${contextSize} --parallel ${parallel} --port <public-port> --temperature ${temperature} --top-p ${topP} --top-k ${topK} --min-p ${minP} --presence-penalty ${presencePenalty} --repetition-penalty ${repetitionPenalty}`;
    case "optiq":
      return `${launcherPath} --slot ${slot} --model ${modelPath} --context-size ${contextSize} --parallel ${parallel} --port <public-port> --temperature ${temperature} --top-p ${topP}`;
    // Both of these previously fell through to the llama.cpp default below,
    // which showed a command neither launcher accepts (--ctx-size, a bare model
    // path, --thinking) in the Launchers panel.
    case "mlx-dspark":
      return `${launcherPath} --slot ${slot} --model ${modelPath} --mode <mode> --reasoning-effort <reasoning-effort> --context-size ${contextSize} --parallel ${parallel} --port <public-port> --temperature ${temperature} --top-p ${topP} --top-k ${topK} --min-p ${minP} --presence-penalty ${presencePenalty} --repetition-penalty ${repetitionPenalty} --start`;
    case "mlx-vlm":
      return `${launcherPath} --slot ${slot} --model ${modelPath} --reasoning-effort <reasoning-effort> --context-size ${contextSize} --parallel ${parallel} --port <public-port> --temperature ${temperature} --top-p ${topP} --top-k ${topK} --min-p ${minP} --presence-penalty ${presencePenalty} --repetition-penalty ${repetitionPenalty} --start`;
    case "ds4":
      return `${launcherPath} --slot ${slot} --model ${modelPath} --context-size ${contextSize} --parallel ${parallel} --port <public-port> --mtp on|off --mtp-draft <n> --temperature ${temperature} --top-p ${topP} --top-k ${topK} --min-p ${minP} --presence-penalty ${presencePenalty} --repetition-penalty ${repetitionPenalty} --start`;
    case "gguf-tq3":
    case "beellama":
    case "gguf":
    default:
      return `${launcherPath} --slot ${slot} ${modelPath} --ctx-size ${contextSize} --parallel ${parallel} --temperature ${temperature} --top-p ${topP} --top-k ${topK} --min-p ${minP} --presence-penalty ${presencePenalty} --repetition-penalty ${repetitionPenalty} --thinking|--no-thinking [--enable-tiny-grammar]`;
  }
}

function formatExecResult(result) {
  return [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim();
}

async function readGitBranchStatus(repoPath) {
  const branch = await execFileAsync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], getExecOptions({
    maxBuffer: 256 * 1024,
    timeout: 5000,
  }))
    .then((result) => String(result.stdout || "").trim())
    .catch(() => "");
  const upstream = await execFileAsync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], getExecOptions({
    maxBuffer: 256 * 1024,
    timeout: 5000,
  }))
    .then((result) => String(result.stdout || "").trim())
    .catch(() => "");
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await execFileAsync("git", ["-C", repoPath, "rev-list", "--left-right", "--count", `HEAD...${upstream}`], getExecOptions({
      maxBuffer: 256 * 1024,
      timeout: 5000,
    }))
      .then((result) => String(result.stdout || "").trim())
      .catch(() => "");
    const [aheadText, behindText] = counts.split(/\s+/);
    ahead = Number.parseInt(aheadText || "0", 10) || 0;
    behind = Number.parseInt(behindText || "0", 10) || 0;
  }
  const dirty = await execFileAsync("git", ["-C", repoPath, "status", "--short"], getExecOptions({
    maxBuffer: 512 * 1024,
    timeout: 5000,
  }))
    .then((result) => String(result.stdout || "").trim().length > 0)
    .catch(() => false);
  return { branch, upstream, ahead, behind, dirty };
}

async function readGitVersion(repoPath) {
  const resolved = String(repoPath || "").trim();
  if (!resolved || !fsSync.existsSync(resolved)) {
    return "missing";
  }
  const describe = await execFileAsync("git", ["-C", resolved, "describe", "--always", "--dirty", "--tags"], getExecOptions({
    maxBuffer: 512 * 1024,
    timeout: 5000,
  }))
    .then((result) => String(result.stdout || "").trim())
    .catch(() => "");
  if (describe) {
    return describe;
  }
  const head = await execFileAsync("git", ["-C", resolved, "rev-parse", "--short", "HEAD"], getExecOptions({
    maxBuffer: 512 * 1024,
    timeout: 5000,
  }))
    .then((result) => String(result.stdout || "").trim())
    .catch(() => "");
  return head || "unknown";
}

async function readPythonPackageVersions(pythonPath, packages = []) {
  const resolvedPython = String(pythonPath || "").trim();
  const packageList = Array.isArray(packages) ? packages.map((value) => String(value || "").trim()).filter(Boolean) : [];
  if (!resolvedPython || !packageList.length || !fsSync.existsSync(resolvedPython)) {
    return "missing";
  }
  const script = [
    "from importlib import metadata",
    "import sys",
    "for name in sys.argv[1:]:",
    "    try:",
    "        print(f\"{name}\\t{metadata.version(name)}\")",
    "    except metadata.PackageNotFoundError:",
    "        print(f\"{name}\\tmissing\")",
  ].join("\n");
  const result = await execFileAsync(resolvedPython, ["-c", script, ...packageList], getExecOptions({
    maxBuffer: 512 * 1024,
    timeout: 10000,
  }));
  const versions = new Map();
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const [name, version] = line.split("\t");
    if (name && version) {
      versions.set(name, version);
    }
  }
  return packageList
    .map((name) => `${name} ${versions.get(name) || "missing"}`)
    .join(" · ");
}

async function readLauncherVersion(definition) {
  if (!definition) {
    return "unknown";
  }
  if (definition.versionKind === "git") {
    return readGitVersion(definition.versionPath);
  }
  if (definition.versionKind === "python-packages") {
    return readPythonPackageVersions(definition.pythonPath, definition.packages);
  }
  return "unknown";
}

// A launcher no model can be started with is dead weight in the Launchers modal:
// its Update button rebuilds a tree nothing loads. The MLX family (mlx,
// rapid-mlx, mtplx, optiq) and beellama lost the launcher matrix to the 2026-06
// benchmarks and now only come back behind LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS /
// LLM3_ENABLE_EXPERIMENTAL_BEELLAMA -- see getLaunchersForModel.
const EXPERIMENTAL_MLX_LAUNCHER_KEYS = new Set(["mlx", "rapid-mlx", "mtplx", "optiq", "dflash", "turboquant"]);

function isLauncherSelectable(launcherKey) {
  if (launcherKey === "beellama") {
    return experimentalBeellamaEnabled();
  }
  if (EXPERIMENTAL_MLX_LAUNCHER_KEYS.has(launcherKey)) {
    return experimentalMlxLaunchersEnabled();
  }
  return true;
}

async function listLaunchers() {
  const selectable = LAUNCHER_DEFINITIONS.filter((launcher) => isLauncherSelectable(launcher.key));
  return Promise.all(selectable.map(async (launcher) => ({
    key: launcher.key,
    name: launcher.name,
    family: launcher.family,
    accent: launcher.accent,
    path: launcher.path,
    version: await readLauncherVersion(launcher),
    commandTemplate: buildLauncherCommandTemplate(launcher.key),
  })));
}

async function runGitLauncherUpdate(definition) {
  const repoPath = String(definition?.updatePath || "").trim();
  if (!repoPath || !fsSync.existsSync(repoPath)) {
    throw new Error(`Missing launcher source tree: ${repoPath || definition?.updatePath || "unknown"}`);
  }

  const output = [];
  output.push(`$ git -C ${repoPath} fetch --prune origin`);
  const fetchResult = await execFileAsync("git", ["-C", repoPath, "fetch", "--prune", "origin"], getExecOptions({
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  }));
  const fetchText = formatExecResult(fetchResult);
  if (fetchText) {
    output.push(fetchText);
  }

  const branchStatus = await readGitBranchStatus(repoPath);
  if (!branchStatus.upstream) {
    const details = [
      `Launcher source tree is on branch '${branchStatus.branch || "unknown"}' with no configured upstream tracking branch.`,
      "The Update button only fast-forwards branches that already track an upstream branch.",
      "This usually means the checkout is a local custom branch rather than the upstream launcher branch.",
    ];
    if (branchStatus.dirty) {
      details.push("The working tree also has local modifications.");
    }
    details.push(`Repo: ${repoPath}`);
    throw new Error([...details, ...output].join("\n\n"));
  }

  if (branchStatus.ahead > 0 && branchStatus.behind > 0) {
    const details = [
      `Branch '${branchStatus.branch || "unknown"}' has diverged from '${branchStatus.upstream}'.`,
      `Ahead by ${branchStatus.ahead} commit(s), behind by ${branchStatus.behind} commit(s).`,
      "The Update button intentionally refuses to auto-merge or auto-rebase diverged launcher branches.",
    ];
    if (branchStatus.dirty) {
      details.push("The working tree also has local modifications.");
    }
    details.push(`Repo: ${repoPath}`);
    throw new Error([...details, ...output].join("\n\n"));
  }

  output.push(`$ git -C ${repoPath} pull --ff-only`);
  const pullResult = await execFileAsync("git", ["-C", repoPath, "pull", "--ff-only"], getExecOptions({
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  }));
  const pullText = formatExecResult(pullResult);
  if (pullText) {
    output.push(pullText);
  }

  for (const buildDirName of definition.buildDirs || []) {
    const buildDir = path.join(repoPath, buildDirName);
    if (!fsSync.existsSync(path.join(buildDir, "CMakeCache.txt"))) {
      continue;
    }
    output.push(`$ cmake --build ${buildDir} --target llama-server -j ${LAUNCHER_BUILD_JOBS}`);
    const buildResult = await execFileAsync("cmake", ["--build", buildDir, "--target", "llama-server", "-j", LAUNCHER_BUILD_JOBS], getExecOptions({
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    }));
    const buildText = formatExecResult(buildResult);
    if (buildText) {
      output.push(buildText);
    }
  }

  return output.filter(Boolean).join("\n\n").trim();
}

async function runPipLauncherUpdate(definition) {
  const pythonPath = String(definition?.pythonPath || "").trim();
  const packages = Array.isArray(definition?.updatePackages)
    ? definition.updatePackages.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (!pythonPath || !fsSync.existsSync(pythonPath)) {
    throw new Error(`Missing launcher Python runtime: ${pythonPath || definition?.pythonPath || "unknown"}`);
  }
  if (!packages.length) {
    throw new Error("No packages configured for this launcher update.");
  }
  const args = ["-m", "pip", "install", "--upgrade", ...packages];
  const result = await execFileAsync(pythonPath, args, getExecOptions({
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  }));
  return [`$ ${pythonPath} ${args.join(" ")}`, formatExecResult(result)].filter(Boolean).join("\n\n").trim();
}

async function updateLauncher(launcherKey) {
  const definition = getLauncherDefinition(launcherKey);
  if (!definition) {
    throw new Error("Unknown launcher.");
  }
  const stdout = definition.updateKind === "git"
    ? await runGitLauncherUpdate(definition)
    : await runPipLauncherUpdate(definition);
  return {
    ok: true,
    launcherKey: definition.key,
    version: await readLauncherVersion(definition),
    stdout: stdout || `Updated ${definition.name}.`,
  };
}

function ensureRuntimeDirs(dirPaths) {
  for (const dirPath of dirPaths) {
    const resolved = String(dirPath || "").trim();
    if (!resolved) {
      continue;
    }
    try {
      fsSync.mkdirSync(resolved, { recursive: true });
    } catch (_error) {
      // Leave failures to the specific feature that needs the directory.
    }
  }
}

function getClaudeProxyLaunchDomain() {
  if (LAUNCHD_DOMAIN === "gui" && Number.isInteger(LAUNCHD_GUI_UID) && LAUNCHD_GUI_UID > 0) {
    return `gui/${LAUNCHD_GUI_UID}`;
  }
  if (Number.isInteger(LAUNCHD_GUI_UID) && LAUNCHD_GUI_UID > 0) {
    return `gui/${LAUNCHD_GUI_UID}`;
  }
  return "";
}

function buildClaudeGuiSkipResult(reason) {
  return {
    ok: true,
    skipped: true,
    requires_gui_session: true,
    reason,
    launchd_domain: getClaudeProxyLaunchDomain() || null,
    service_mode: SERVICE_MODE,
  };
}

function isGuiLaunchDomainError(error) {
  const message = formatExecError(error).toLowerCase();
  return [
    "gui/",
    "could not find service",
    "could not find domain",
    "domain does not support specified action",
    "no such process",
    "not privileged",
    "service not found",
  ].some((pattern) => message.includes(pattern));
}

async function canAccessClaudeProxyLaunchDomain() {
  const domain = getClaudeProxyLaunchDomain();
  if (!domain) {
    return false;
  }
  if (!claudeGuiDomainAvailabilityPromise) {
    claudeGuiDomainAvailabilityPromise = execFileAsync("launchctl", ["print", domain], getExecOptions({
      maxBuffer: 128 * 1024,
      timeout: 5000,
    }))
      .then(() => true)
      .catch(() => false);
  }
  return claudeGuiDomainAvailabilityPromise;
}
const APPLICATION_DEFINITIONS = [
  {
    key: "hermes",
    label: "Hermes Agent",
    badgeLabel: "Hermes",
    description: "Updates the Hermes Agent on the remote machine.",
    legacyKey: "hermes",
    slotKind: "llm",
    machine: "inuc",
  },
  { key: "hermesm4", label: "Hermes M4", badgeLabel: "Hermes M4", description: "Updates local ~/.hermes/config.yaml.", slotKind: "llm", machine: "m4" },
  {
    key: "compaction",
    label: "Compaction",
    badgeLabel: "Compaction",
    description: "Points the remote Hermes compaction model at the selected slot.",
    slotKind: "llm",
    machine: "inuc",
  },
  {
    key: "compactionm4",
    label: "Compaction M4",
    badgeLabel: "Compaction M4",
    description: "Points the local Hermes compaction model at the selected slot.",
    slotKind: "llm",
    machine: "m4",
  },
  {
    key: "remotejsonapp",
    label: REMOTE_JSON_APP_LABEL,
    badgeLabel: REMOTE_JSON_APP_LABEL,
    description: "Rewrites the app's llm_config.json over SSH and restarts its PM2 apps.",
    slotKind: "llm",
    machine: "inuc",
  },
  {
    key: "sqliteapp",
    label: SQLITE_APP_LABEL,
    badgeLabel: SQLITE_APP_LABEL,
    description: "Writes the LLM endpoint into the app's SQLite settings and restarts its PM2 app.",
    slotKind: "llm",
    machine: "m4",
  },
  { key: "librechat", label: "LibreChat", badgeLabel: "LibreChat", legacyKey: "chat", slotKind: "llm", machine: "inuc" },
  { key: "claudecode", label: "Claude Code", badgeLabel: "Claude Code", legacyKey: "openclaude", slotKind: "llm", machine: "m4" },
  {
    key: "voiceapp",
    label: VOICE_APP_LABEL,
    badgeLabel: VOICE_APP_LABEL,
    description: "Restarts the app's PM2 process with the selected LLM endpoint.",
    slotKind: "llm",
    machine: "m4",
  },
  {
    key: "podcastg",
    label: "PodG",
    badgeLabel: "PodG",
    description: "Updates the dedicated local podG Hermes profile with the selected LLM endpoint.",
    slotKind: "llm",
    machine: "m4",
  },
  {
    key: "podgag",
    label: "PodG-AG",
    badgeLabel: "PodG-AG",
    description: "Updates the dedicated local podG AutoGen Hermes profile used for subject selection and accept/reject decisions.",
    slotKind: "llm",
    machine: "m4",
  },
  {
    key: "hermespc",
    label: "Hermes PC",
    badgeLabel: "Hermes PC",
    description: "Updates Hermes on the Gaming PC (AppData\\Local\\hermes\\config.yaml).",
    slotKind: "llm",
    machine: "gaming",
  },
  {
    key: "opencodepc",
    label: "OpenCode PC",
    badgeLabel: "OpenCode PC",
    description: "Updates OpenCode on the Gaming PC (.config\\opencode\\opencode.jsonc).",
    slotKind: "llm",
    machine: "gaming",
  },
  {
    key: "omppc",
    label: "OMP PC",
    badgeLabel: "OMP PC",
    description: "Updates OMP on the Gaming PC (.omp\\agent\\models.yaml).",
    slotKind: "llm",
    machine: "gaming",
  },
  {
    key: "pipc",
    label: "PI PC",
    badgeLabel: "PI PC",
    description: "Updates PI on the Gaming PC (.pi\\agent\\models.json).",
    slotKind: "llm",
    machine: "gaming",
  },
  {
    key: "voicetts",
    label: "Voice TTS",
    badgeLabel: "Voice TTS",
    description: "Updates Hermes config with TTS endpoint.",
    slotKind: "voice",
    visibleInApplications: false,
  },
  {
    key: "voicestt",
    label: "Voice STT",
    badgeLabel: "Voice STT",
    description: "Updates Hermes config with STT endpoint.",
    slotKind: "voice",
    visibleInApplications: false,
  },
];
const APPLICATION_KEYS = APPLICATION_DEFINITIONS.map((entry) => entry.key);
// Machines an application's config actually lives on. The dashboard groups the
// launch modal's routing toggles by these so it is obvious what a launch touches.
const APPLICATION_MACHINES = [
  { key: "inuc", label: REMOTE_MACHINE_LABEL, host: REMOTE_HOST },
  { key: "m4", label: LOCAL_MACHINE_LABEL, host: "local" },
  { key: "gaming", label: "Gaming PC", host: GAMING_PC_SYNC_HOST },
];
const LOG_CHUNK_LIMIT = 64 * 1024;
const DIAGNOSTIC_LOG_TAIL_LIMIT = 128 * 1024;
const THINKING_LOG_READ_LIMIT = 1024 * 1024;
const THINKING_LOG_LOOKBEHIND = 16 * 1024;
const DIAGNOSTIC_SESSION_FILE_LIMIT = 16;
const DIAGNOSTIC_ENTRY_LIMIT = 60;
const HERMES_STATUS_LOG_TAIL_LIMIT = 256 * 1024;
const HERMES_STATUS_CACHE_TTL_MS = 4000;
const HERMES_STATUS_ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const HERMES_STATUS_DETAIL_LIMIT = 220;
const HERMES_FEED_LOG_LIMIT = 48;
const HERMES_FEED_ENTRY_LIMIT = 240;
const HERMES_M4_LAUNCH_LABEL = process.env.HERMES_M4_LAUNCH_LABEL || "ai.hermes.gateway";
const HERMES_M4_RESTART_ON_VOICE_SYNC =
  process.env.HERMES_M4_RESTART_ON_VOICE_SYNC != null
    ? process.env.HERMES_M4_RESTART_ON_VOICE_SYNC !== "false"
    : path.resolve(HERMES_M4_CONFIG_PATH) === path.resolve(DEFAULT_HERMES_M4_CONFIG_PATH);
const ACTION_BUFFER = 8 * 1024 * 1024;
const SLOT_BENCHMARKS = new Map();
const LAUNCH_SAMPLING_DEFAULTS = Object.freeze({
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  minP: 0.0,
  presencePenalty: 0.0,
  repetitionPenalty: 1.0,
});
const SLOT_BENCHMARK_STANDARD = Object.freeze({
  id: "llm3-standard-v1",
  label: "Count 1 to 200",
  promptSummary: "Output the integers 1 through 200, one per line.",
  timeoutMs: 90_000,
  request: Object.freeze({
    messages: Object.freeze([
      {
        role: "system",
        content: "You are running a deterministic throughput benchmark. Follow the user's format exactly and do not add commentary.",
      },
      {
        role: "user",
        content: "Output the integers 1 through 200, one per line, and nothing else.",
      },
    ]),
    max_tokens: 400,
    temperature: 0,
    stream: true,
    stream_options: Object.freeze({ include_usage: true }),
  }),
});

let actionInFlight = false;
let actionAbortRequested = false;

// Route guard for the launch/stop/profile actions that must not overlap.
function requireIdle(_req, res, next) {
  if (actionInFlight) {
    res.status(409).json({ error: "Another action is already running." });
    return;
  }
  next();
}

function beginExclusiveAction() {
  actionAbortRequested = false;
  actionInFlight = true;
}

function finishExclusiveAction() {
  actionInFlight = false;
  actionAbortRequested = false;
}

function requestActionAbort() {
  actionAbortRequested = true;
}

function assertActionNotAborted(message = "Action was cancelled by Stop All.") {
  if (actionAbortRequested) {
    const error = new Error(message);
    error.statusCode = 499;
    throw error;
  }
}
let cpuSnapshot = readCpuSnapshot();
let cpuPercent = 0;
let overviewCache = { expiresAt: 0, value: null, promise: null };
let hermesStatusCache = { expiresAt: 0, value: null, promise: null };
let claudeGuiDomainAvailabilityPromise = null;

ensureRuntimeDirs([
  DEFAULT_XDG_STATE_HOME,
  DEFAULT_XDG_CACHE_HOME,
  DEFAULT_XDG_CONFIG_HOME,
  SLOT_STATE_DIR,
  GGUF_STATE_DIR,
  MLX_STATE_DIR,
  RAPID_MLX_STATE_DIR,
  MTPLX_STATE_DIR,
  DFLASH_STATE_DIR,
  TURBO_QUANT_STATE_DIR,
  HF_STATE_DIR,
  HF_JOBS_DIR,
  VOICE_STATE_DIR,
  VOICE_BENCHMARK_DIR,
  VOICE_BENCHMARK_RUNS_DIR,
]);

// --- Websites database (SQLite) ---
const WEBSITES_DB_PATH = path.join(SLOT_STATE_DIR, "websites.db");
const websitesDb = new Database(WEBSITES_DB_PATH);
websitesDb.pragma("journal_mode = WAL");
websitesDb.exec(`
  CREATE TABLE IF NOT EXISTS websites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    internal_url TEXT   NOT NULL,
    external_url TEXT   DEFAULT '',
    category    TEXT    NOT NULL DEFAULT 'general',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);
// Seed if empty (first run)
try {
  const count = websitesDb.prepare("SELECT COUNT(*) as cnt FROM websites").get();
  if (count.cnt === 0) {
    const seedStmt = websitesDb.prepare(
      "INSERT INTO websites (name, internal_url, external_url, category) VALUES (?, ?, ?, ?)"
    );
      // First-run examples only. Everything here is editable from the
      // Websites tab; nothing in this list is required.
      const seeds = [
        ["llm3 (Models)", `http://127.0.0.1:${PORT}`, "", LOCAL_MACHINE_LABEL],
      ];
    for (const [name, intUrl, extUrl, cat] of seeds) {
      seedStmt.run(name, intUrl, extUrl, cat);
    }
    console.log(`Websites DB seeded with ${seeds.length} entries.`);
  }
} catch (e) {
  console.warn("Websites seed failed (probably already seeded):", e.message);
}


const websitesInsert = websitesDb.prepare(
  "INSERT INTO websites (name, internal_url, external_url, category) VALUES (?, ?, ?, ?)"
);
const websitesUpdate = websitesDb.prepare(
  "UPDATE websites SET name = ?, internal_url = ?, external_url = ?, category = ?, updated_at = datetime('now') WHERE id = ?"
);
const websitesDelete = websitesDb.prepare(
  "DELETE FROM websites WHERE id = ?"
);
const websitesList = websitesDb.prepare(
  "SELECT * FROM websites ORDER BY category, name"
);
const websitesGetOne = websitesDb.prepare(
 "SELECT * FROM websites WHERE id = ?"
);
const websitesGetByName = websitesDb.prepare(
  "SELECT * FROM websites WHERE name = ?"
);


  // --- Websites migration: rewrite external URLs in place ---
  // Add { name, oldExt, newExt } entries to move a service to a new
  // address on startup. Empty by default.
try {
    const migrationMap = [];
  let migrated = 0;
  for (const m of migrationMap) {
    const row = websitesGetByName.get(m.name);
    if (row && row.external_url === m.oldExt) {
      websitesUpdate.run(m.name, row.internal_url, m.newExt, row.category, row.id);
      console.log(`Websites migrated: ${m.name} -> ${m.newExt || "(empty)"}`);
      migrated++;
    }
  }
  if (migrated > 0) {
    console.log(`Websites migration complete: ${migrated} entries upgraded.`);
  }
} catch (e) {
  console.warn("Websites migration failed:", e.message);
}


const SLOT_DEFINITIONS = Array.from({ length: SLOT_COUNT }, (_, index) => buildSlotDefinition(index + 1));
const VOICE_SLOT_DEFINITIONS = Array.from({ length: VOICE_SLOT_COUNT }, (_, index) => buildVoiceSlotDefinition(index));

function buildVoiceSlotDefinition(index) {
  const type = VOICE_SLOT_TYPES[index];
  const typeIndex = VOICE_SLOT_TYPES.slice(0, index + 1).filter((value) => value === type).length;
  const publicPortBase = type === "tts" ? VOICE_TTS_PUBLIC_PORT_BASE : VOICE_STT_PUBLIC_PORT_BASE;
  const backendPortBase = type === "tts" ? VOICE_TTS_BACKEND_PORT_BASE : VOICE_STT_BACKEND_PORT_BASE;
  const id = `voice-${type}-${typeIndex}`;
  return {
    id,
    index: typeIndex,
    label: VOICE_SLOT_LABELS[index],
    type,
    publicPort: publicPortBase + typeIndex - 1,
    backendPort: backendPortBase + typeIndex - 1,
    stateDir: path.join(VOICE_STATE_DIR, id),
  };
}

// Access guard first: nothing below runs for a non-loopback client that has no
// token when LLM3_AUTH_TOKEN is set. /api/pm2/control keeps its own allowlist
// and is called cross-origin by the Immich UI, so it stays open.
app.use(createDashboardAuth({ token: DASHBOARD_AUTH_TOKEN, exempt: ["/api/pm2/control"] }));

// Embedded LAN sites, reverse-proxied so the Websites tab can frame them on
// llm3's own origin. Mounted BEFORE express.json so the request body streams
// through untouched (uploads, POSTs the site forwards). See embed_proxy.js
// for why this is a server-side proxy and not a direct iframe, and why it is
// intentionally unguarded here (nginx gates the public origin). The sites come
// from LLM3_EMBED_SITES in .env only; the public code names none. A site works
// under its mount only if its pages use relative URLs.
const { createEmbedProxy, parseEmbedSites, embedPathForWebsite } = require("./embed_proxy");
const EMBED_PROXIES = parseEmbedSites(process.env.LLM3_EMBED_SITES);
for (const proxy of EMBED_PROXIES) {
  app.use(createEmbedProxy(proxy));
}

app.use(express.json({ limit: "25mb" }));

// Wrap res.json once so every failed action is recorded, wherever it answered
// from. See logFailedActionResponse.
app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    try {
      logFailedActionResponse(req, res, body);
    } catch (_error) {
      // Logging must never break a response.
    }
    return sendJson(body);
  };
  next();
});
attachPerfDashboardRoutes(app);

// --- Websites API ---
app.post("/api/websites/add", (req, res) => {
  const { name, internal_url, external_url, category } = req.body || {};
  if (!name || !internal_url) {
    return res.status(400).json({ error: "name and internal_url are required" });
  }
  try {
    websitesInsert.run(name, internal_url, external_url || "", category || "general");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/websites/update", (req, res) => {
  const { id, name, internal_url, external_url, category } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: "id is required" });
  }
  try {
    websitesUpdate.run(name, internal_url, external_url, category, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/websites/delete", (req, res) => {
  const { id } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: "id is required" });
  }
  try {
    websitesDelete.run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Websites online status & control ---

// Build a map: port -> pm2AppName from `pm2 list` JSON output
// Also store all-apps data for collision resolution
let pm2PortMap = {};
let pm2AppNameSet = new Set();
let pm2PortToNameMap = {}; // port -> [{name, env}] for resolving collisions
let remotePm2PortMap = {};
let remotePm2AppNameSet = new Set();
let pm2AppToPort = {};
let localPm2AppsByName = {};
let remotePm2AppsByName = {};

function formatHomeRelativePath(filePath) {
  const normalized = String(filePath || "").trim();
  if (!normalized) {
    return "";
  }
  const resolved = path.resolve(normalized);
  if (resolved === HOME) {
    return "~";
  }
  if (resolved.startsWith(`${HOME}${path.sep}`)) {
    return `~/${path.relative(HOME, resolved)}`;
  }
  return resolved;
}

function formatPm2MemoryLimit(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  const units = [
    { suffix: "T", size: 1024 ** 4 },
    { suffix: "G", size: 1024 ** 3 },
    { suffix: "M", size: 1024 ** 2 },
    { suffix: "K", size: 1024 },
  ];
  for (const unit of units) {
    if (bytes >= unit.size) {
      const amount = bytes / unit.size;
      const rounded = amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10;
      return `${rounded}${unit.suffix}`;
    }
  }
  return `${Math.round(bytes)}B`;
}

function summarizePm2App(app, { remote = false } = {}) {
  const pm2Env = app?.pm2_env || {};
  const monit = app?.monit || {};
  const execPath = String(pm2Env.pm_exec_path || app?.pm_exec_path || "").trim();
  const cwd = String(pm2Env.pm_cwd || pm2Env.cwd || "").trim();
  const maxMemoryRestart = Number(pm2Env.max_memory_restart || 0);
  return {
    name: String(app?.name || "").trim(),
    remote,
    status: String(pm2Env.status || "").trim().toLowerCase(),
    pid: Number(app?.pid || 0) || null,
    port: resolvePm2DeclaredPort(app),
    maxMemoryRestart: Number.isFinite(maxMemoryRestart) && maxMemoryRestart > 0 ? maxMemoryRestart : null,
    maxMemoryRestartLabel: formatPm2MemoryLimit(maxMemoryRestart),
    execPath,
    execPathDisplay: formatHomeRelativePath(execPath),
    cwd,
    cwdDisplay: formatHomeRelativePath(cwd),
    memoryBytes: Number(monit.memory || 0) || 0,
    cpuPercent: Number(monit.cpu || 0) || 0,
  };
}

function resolvePm2DeclaredPort(app) {
  const env = app?.pm2_env?.env || {};
  const candidates = [
    env.PODCAST_PORT,
    ...PM2_EXTRA_PORT_ENV_KEYS.map((key) => env[key]),
    env.VOICE_PORT,
    env.PORT,
    app?.pm2_env?.port,
    app?.port,
  ];
  for (const value of candidates) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

async function refreshPm2PortMap() {
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], { timeout: 5000 });
    const raw = JSON.parse(stdout);
    const apps = Array.isArray(raw) ? raw : (raw.processes || []);
    pm2PortMap = {};
    pm2AppNameSet = new Set();
    pm2PortToNameMap = {};
    localPm2AppsByName = {};
    for (const app of apps) {
      if (app?.name) {
        localPm2AppsByName[app.name] = summarizePm2App(app);
      }
      const port = resolvePm2DeclaredPort(app);
      if (port && app.name) {
        pm2AppNameSet.add(app.name);
        // Track all apps per port for collision resolution
        if (!pm2PortToNameMap[port]) pm2PortToNameMap[port] = [];
        pm2PortToNameMap[port].push({ name: app.name, pm2Env: app.pm2_env });
      }
    }
    // Reverse map: app name -> port
    pm2AppToPort = {};
    for (const app of apps) {
      if (app.name) {
        const port = resolvePm2DeclaredPort(app);
        if (port) pm2AppToPort[app.name] = port;
      }
    }
    // Also build the remote machine's port map
    try {
      const { stdout: remStdout } = await execFileAsync("ssh", [
        ...sshHostKeyArgs(),
        "-o", "ConnectTimeout=3",
        "-i", REMOTE_SSH_KEY,
        REMOTE_SSH_TARGET, "pm2 jlist"
      ], { timeout: 8000 });
      const remRaw = JSON.parse(remStdout);
      const remApps = Array.isArray(remRaw) ? remRaw : (remRaw.processes || []);
      remotePm2PortMap = {};
      remotePm2AppNameSet = new Set();
      remotePm2AppsByName = {};
      const pidToApp = {}; // pid -> pm2 app name
      for (const app of remApps) {
        if (app?.name) {
          remotePm2AppsByName[app.name] = summarizePm2App(app, { remote: true });
        }
        // Check multiple possible env var names for PORT
        const env = app.pm2_env?.env || {};
        const port = String(
          env.PORT ||
          PM2_EXTRA_PORT_ENV_KEYS.map((key) => env[key]).find(Boolean) ||
          app.pm2_env?.port ||
          app.port ||
          ""
        ).trim();
        if (port && app.name) {
          remotePm2PortMap[port] = app.name;
          remotePm2AppNameSet.add(app.name);
        }
        if (app.pid) {
          pidToApp[app.pid] = app.name;
        }
      }
      // Cross-reference with ss -tlnp to find PM2 apps by listening port.
      // This serves two purposes:
      // 1. For apps WITHOUT a PORT env var, discover the actual listening port.
      // 2. For apps WITH a PORT env var, validate/correct it against the actual
      //    listening port (PM2 PORT env vars can be wrong).
      try {
        const { stdout: ssOutput } = await execFileAsync("ssh", [
          ...sshHostKeyArgs(),
          "-o", "ConnectTimeout=3",
          "-i", REMOTE_SSH_KEY,
          REMOTE_SSH_TARGET,
          "ss -tlnp 2>/dev/null | grep -E '(LISTEN|users:)' | grep -oP 'pid=\\K[0-9]+'"
        ], { timeout: 8000 });
        const pids = ssOutput.trim().split('\n').map(p => p.trim()).filter(Boolean);
        for (const pidStr of pids) {
          const pid = parseInt(pidStr);
          if (!isNaN(pid) && pidToApp[pid]) {
            // Get the port this PID actually listens on
            const { stdout: portOutput } = await execFileAsync("ssh", [
              ...sshHostKeyArgs(),
              "-o", "ConnectTimeout=3",
              "-i", REMOTE_SSH_KEY,
              REMOTE_SSH_TARGET,
              `ss -tlnp 2>/dev/null | grep "pid=${pid}" | grep -oP ':[0-9]+' | tail -1 | tr -d ':'`
            ], { timeout: 8000 });
            const listeningPort = portOutput.trim();
            if (listeningPort) {
              const appName = pidToApp[pid];
              const currentPort = remotePm2PortMap[listeningPort];
              // If this port is not mapped yet, or mapped to a different app,
              // use the ss-based port to correct the mapping.
              if (!currentPort || currentPort !== appName) {
                remotePm2PortMap[listeningPort] = appName;
                remotePm2AppNameSet.add(appName);
              }
            }
          }
        }
      } catch (_e) {
        // ss cross-reference failed silently
      }
    } catch (_e) {
      // Remote machine not reachable — remotePm2PortMap stays empty
      remotePm2AppsByName = {};
    }
  } catch (_e) {
    // pm2 not available
    localPm2AppsByName = {};
  }
}


// --- Auto-register pm2-managed sites -------------------------------------------
// The Websites tab is backed by the websites table, so anything not seeded there was
// invisible even though pm2 was managing it. Register every pm2 app that declares a
// port and isn't already listed, so new services (added tomorrow, by anyone) show up
// on their own with working start/stop instead of needing a manual DB entry.
function autoRegisterPm2Websites() {
  try {
    const existing = websitesList.all();
    const knownNames = new Set(existing.map((w) => String(w.name || "").toLowerCase()));
    const knownPorts = new Set();
    for (const w of existing) {
      try {
        knownPorts.add(String(new URL(w.internal_url).port));
      } catch (_e) { /* row without a parseable url */ }
    }

    for (const [appName, port] of Object.entries(pm2AppToPort)) {
      if (!appName || !port) continue;
      if (knownNames.has(appName.toLowerCase())) continue;
      if (knownPorts.has(String(port))) continue;   // already listed under another name
      websitesInsert.run(appName, `http://127.0.0.1:${port}`, "", LOCAL_MACHINE_LABEL);
      knownNames.add(appName.toLowerCase());
      knownPorts.add(String(port));
      console.log(`Websites: auto-registered pm2 app "${appName}" on port ${port}`);
    }
  } catch (e) {
    console.warn("Websites auto-register failed:", e.message);
  }
}

function startPm2Discovery() {
  refreshPm2PortMap();
  setInterval(async () => {
    try {
      await refreshPm2PortMap();
      autoRegisterPm2Websites();
    } catch (error) {
      console.error("[llm3] pm2 discovery failed:", error?.message || error);
    }
  }, 30000).unref();
  setTimeout(autoRegisterPm2Websites, 2000).unref();
}

// Get PM2 app name for a given port, optionally filtered by hostname
// Returns {name, remote} or null
function getPm2AppForPort(port, host) {
  port = String(port);
  const normalizedHost = String(host || "").trim().toLowerCase();
  const isLocalHost =
    normalizedHost === "127.0.0.1"
    || normalizedHost === "localhost"
    || LOCAL_IPV4_ADDRESSES.has(normalizedHost);
  // If host is remote (192.168.1.x), use remote map
  if (normalizedHost && normalizedHost.startsWith("192.168.") && !isLocalHost) {
    if (remotePm2PortMap[port]) {
      return { name: remotePm2PortMap[port], remote: true };
    }
  }
  // Check local map first
  if (pm2PortToNameMap[port]) {
    const candidates = pm2PortToNameMap[port];
    if (candidates.length === 1) {
      return { name: candidates[0].name, remote: false };
    }
    // Collision: prefer the one that's NOT llm3 (the server itself) or the voice app
    for (const c of candidates) {
      if (c.name !== "llm3" && c.name !== VOICE_APP_PM2_APP) {
        return { name: c.name, remote: false };
      }
    }
    // Fall back to first non-llm3
    for (const c of candidates) {
      if (c.name !== "llm3") {
        return { name: c.name, remote: false };
      }
    }
    // Last resort: first candidate
    return { name: candidates[0].name, remote: false };
  }
  // Fall back to old pm2PortMap (single entry)
  if (pm2PortMap[port]) {
    return { name: pm2PortMap[port], remote: false };
  }
  return null;
}

function getPm2MetadataForWebsite(website) {
  try {
    const url = new URL(String(website?.internal_url || ""));
    const port = String(url.port || "").trim();
    const host = String(url.hostname || "").trim();
    if (!port) {
      return null;
    }
    const pm2Result = getPm2AppForPort(port, host);
    if (!pm2Result) {
      return null;
    }
    const snapshot = pm2Result.remote
      ? remotePm2AppsByName[pm2Result.name]
      : localPm2AppsByName[pm2Result.name];
    return {
      managed: true,
      name: pm2Result.name,
      remote: Boolean(pm2Result.remote),
      status: String(snapshot?.status || "").trim().toLowerCase() || "unknown",
      pid: snapshot?.pid || null,
      port: snapshot?.port || port,
      maxMemoryRestart: snapshot?.maxMemoryRestart || null,
      maxMemoryRestartLabel: snapshot?.maxMemoryRestartLabel || "",
      execPath: snapshot?.execPath || "",
      execPathDisplay: snapshot?.execPathDisplay || "",
      cwd: snapshot?.cwd || "",
      cwdDisplay: snapshot?.cwdDisplay || "",
      memoryBytes: snapshot?.memoryBytes || 0,
      cpuPercent: snapshot?.cpuPercent || 0,
    };
  } catch (_error) {
    return null;
  }
}

// This machine's LAN address. The Websites tab rewrites every loopback URL to
// it, because 127.0.0.1 is only meaningful on the host itself and the dashboard
// is normally opened from a phone or another machine on the LAN.
//
// Interfaces are ranked rather than filtered: en0 is the built-in port on this
// Mac, so it wins over a VPN or a Docker bridge that also reports a private
// IPv4. Cached because the answer only changes when the network does, and the
// overview payload that carries it is polled every few seconds.
let lanIpCache = "";

function detectLanIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }
      // en0/en1 first, then anything else that is not a bridge or a tunnel.
      let rank = 3;
      if (/^en\d+$/.test(name)) rank = 0;
      else if (/^(bridge|utun|awdl|llw|vmnet|docker)/.test(name)) rank = 9;
      else rank = 5;
      candidates.push({ rank, name, address: address.address });
    }
  }
  candidates.sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name));
  return candidates[0]?.address || "";
}

function getLanIp() {
  if (!lanIpCache) {
    lanIpCache = detectLanIp();
  }
  return lanIpCache;
}

// Check if a TCP port is open (local only)
function checkPortLocal(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.connect(Number(port), "127.0.0.1");
  });
}

// Check if a TCP port is open (remote host)
function checkPortRemote(port, host) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.connect(Number(port), host);
  });
}

// Check online status via nginx server for nginx sites
async function checkWebsiteViaNginx(website) {
  const https = require("https");
  const machineIp = website.machine_ip || NGINX_HOST_IP;
  const url = new URL(website.internal_url);
  const hostname = url.hostname;
  
  return new Promise((resolve) => {
    const options = {
      hostname: machineIp,
      port: 443,
      path: "/",
      method: "HEAD",
      headers: {
        Host: hostname,
        "User-Agent": "llm3-website-checker"
      },
      rejectUnauthorized: false, // Allow self-signed certs
      timeout: 3000
    };
    
    const req = https.request(options, (res) => {
      res.destroy();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Check online status for a single website
async function checkWebsiteStatus(website) {
  try {
    // Nginx sites: check via nginx server
    if (website.category === "Nginx" && website.machine_ip) {
      return await checkWebsiteViaNginx(website);
    }
    
    const url = new URL(website.internal_url);
    const host = url.hostname;
    const port = Number(url.port);
    if (host === "127.0.0.1" || host === "localhost") {
      return await checkPortLocal(port);
    }
    return await checkPortRemote(port, host);
  } catch (_e) {
    return false;
  }
}

// Enrich websites list with online status
// Card icons: { "<website name>": "<svg path data>" } in a git-ignored local file,
// since the keys are the owner's site names. Missing or broken file: no icons.
const WEBSITE_ICONS_PATH = process.env.LLM3_WEBSITE_ICONS_PATH || path.join(SLOT_STATE_DIR, "website-icons.json");
function loadWebsiteIcons() {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(WEBSITE_ICONS_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Website icons unreadable (${WEBSITE_ICONS_PATH}): ${error.message}`);
    return {};
  }
}

app.get("/api/websites", async (_req, res) => {
  try {
    const rows = websitesList.all();
    const websiteIcons = loadWebsiteIcons();
    const enriched = await Promise.all(
      rows.map(async (w) => {
        const online = await checkWebsiteStatus(w);
        const pm2 = getPm2MetadataForWebsite(w);
        const embedPath = embedPathForWebsite(w, EMBED_PROXIES, LOCAL_IPV4_ADDRESSES);
        const iconPath = typeof websiteIcons[w.name] === "string" ? websiteIcons[w.name] : null;
        return { ...w, online, pm2, pm2App: pm2?.name || null, embedPath, iconPath };
      })
    );
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pinned Websites-tab cards for embed sites that carry a card title in .env.
// Negative ids keep them apart from database rows.
app.get("/api/embed-sites", (_req, res) => {
  res.json(
    EMBED_PROXIES.filter((site) => site.cardTitle).map((site, index) => ({
      id: -1001 - index,
      name: site.cardTitle,
      embed: site.mountPath + "/",
      category: "Embedded",
      online: true,
    }))
  );
});

// Control endpoint: start/stop/restart a PM2-managed website
app.post("/api/websites/control", async (req, res) => {
  const { id, action } = req.body || {};
  if (!id || !action) {
    return res.status(400).json({ error: "id and action are required" });
  }
  if (!["start", "stop", "restart"].includes(action)) {
    return res.status(400).json({ error: "action must be start, stop, or restart" });
  }
  try {
    const w = websitesGetOne.get(id);
    if (!w) {
      return res.status(404).json({ error: "website not found" });
    }
    // Parse host and port from internal_url
    const url = new URL(w.internal_url);
    const port = String(url.port);
    const host = url.hostname || "127.0.0.1";

    // Look up PM2 app using the new collision-aware resolver
    const pm2Result = getPm2AppForPort(port, host);
    if (!pm2Result) {
      const hostLabel = host !== "127.0.0.1" && host !== "localhost"
        ? `${host}:`
        : "";
      return res.status(400).json({
        error: `No PM2 app mapped to ${hostLabel}${port}. Cannot start/stop.`,
      });
    }

    const { name: pm2App, remote: isRemote } = pm2Result;

    let result;
    if (isRemote) {
      // Execute on the remote machine via SSH
      result = await execFileAsync("ssh", [
        ...sshHostKeyArgs(),
        "-o", "ConnectTimeout=5",
        "-i", REMOTE_SSH_KEY,
        REMOTE_SSH_TARGET, `pm2 ${shellQuote(action)} ${shellQuote(pm2App)}`
      ], { timeout: 15000 });
    } else {
      // Execute locally
      result = await execFileAsync("pm2", [action, pm2App], { timeout: 15000 });
    }

    // Refresh the port map after pm2 change
    await refreshPm2PortMap();

    const online = await checkWebsiteStatus(w);
    res.json({ ok: true, pm2App, online, stdout: result.stdout?.trim() || "", stderr: result.stderr?.trim() || "", remote: isRemote });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Control a pm2 app by name, for UIs that live outside llm3.
//
// /api/websites/control already does this, but it is keyed on a website row id,
// which an external caller has no way to know. This one takes the pm2 app name
// directly.
//
// Deliberately an allowlist rather than a general "pm2 <action> <anything>"
// primitive: llm3's control surface is unauthenticated (it binds 0.0.0.0:7075 on
// a home LAN), so the blast radius of this route is capped at the apps below.
const PM2_CONTROL_ALLOWLIST = new Set(["immich"]);

// Only the Immich UI needs to reach this cross-origin. It is served on :4991 by
// the same machine, so reflect that origin rather than opening this to `*`.
const allowImmichOrigin = (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/[^/]+:4991$/.test(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
  }
  next();
};

app.options("/api/pm2/control", allowImmichOrigin, (_req, res) => res.sendStatus(204));

app.post("/api/pm2/control", allowImmichOrigin, async (req, res) => {
  const app_ = String(req.body?.app || "").trim();
  const action = String(req.body?.action || "").trim();

  if (!PM2_CONTROL_ALLOWLIST.has(app_)) {
    return res.status(403).json({ error: `pm2 app "${app_}" is not controllable via this endpoint.` });
  }
  if (!["start", "stop", "restart"].includes(action)) {
    return res.status(400).json({ error: "action must be start, stop, or restart" });
  }

  try {
    // Generous timeout: immich-pm2.sh has kill_timeout 60s so the whole docker
    // stack (and Mage-VL) can shut down cleanly before pm2 gives up on it.
    const result = await execFileAsync("pm2", [action, app_], { timeout: 90_000 });
    await refreshPm2PortMap();
    res.json({ ok: true, app: app_, action, stdout: result.stdout?.trim() || "" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/websites/pm2-memory", async (req, res) => {
  const { id, value } = req.body || {};
  const normalizedValue = String(value || "").trim().toUpperCase();
  if (!id || !normalizedValue) {
    return res.status(400).json({ error: "id and value are required" });
  }
  if (!/^\d+(?:\.\d+)?[KMGTP]?$/i.test(normalizedValue)) {
    return res.status(400).json({ error: "Use a PM2 memory value like 500M, 1G, or 15G." });
  }
  try {
    const website = websitesGetOne.get(id);
    if (!website) {
      return res.status(404).json({ error: "website not found" });
    }
    const url = new URL(website.internal_url);
    const pm2Result = getPm2AppForPort(String(url.port || ""), url.hostname || "127.0.0.1");
    if (!pm2Result) {
      return res.status(400).json({ error: "No PM2 app mapped to this website." });
    }
    if (pm2Result.remote) {
      return res.status(400).json({ error: "Remote PM2 memory cap editing is not supported from llm3 yet." });
    }
    const result = await execFileAsync(
      "pm2",
      ["restart", pm2Result.name, "--max-memory-restart", normalizedValue, "--update-env"],
      { timeout: 30000, maxBuffer: 512 * 1024 }
    );
    await execFileAsync("pm2", ["save"], { timeout: 15000, maxBuffer: 512 * 1024 });
    await refreshPm2PortMap();
    const refreshedWebsite = websitesGetOne.get(id);
    const online = await checkWebsiteStatus(refreshedWebsite);
    const pm2 = getPm2MetadataForWebsite(refreshedWebsite);
    res.json({
      ok: true,
      stdout: result.stdout?.trim() || "",
      stderr: result.stderr?.trim() || "",
      website: {
        ...refreshedWebsite,
        online,
        pm2,
        pm2App: pm2?.name || null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update port endpoint
app.post("/api/websites/update-port", async (req, res) => {
  const { id, newPort } = req.body || {};
  if (!id || !newPort) {
    return res.status(400).json({ error: "id and newPort are required" });
  }
  try {
    const w = websitesGetOne.get(id);
    if (!w) {
      return res.status(404).json({ error: "website not found" });
    }
    const url = new URL(w.internal_url);
    url.port = String(newPort);
    const newInternalUrl = url.toString();
    websitesUpdate.run(w.name, newInternalUrl, w.external_url, w.category, id);
    // Check if new port maps to a PM2 app
    const pm2Result = getPm2AppForPort(newPort, "127.0.0.1");
    const pm2App = pm2Result?.name || null;
    const online = pm2App ? await checkPortLocal(Number(newPort)) : false;
    res.json({ ok: true, newInternalUrl, pm2App, online });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

setInterval(() => {
  const next = readCpuSnapshot();
  const totalDiff = next.total - cpuSnapshot.total;
  const idleDiff = next.idle - cpuSnapshot.idle;
  if (totalDiff > 0) {
    cpuPercent = round1((1 - idleDiff / totalDiff) * 100);
  }
  cpuSnapshot = next;
}, 1000).unref();

function formatOrdinal(value) {
  const number = Number(value);
  const mod100 = number % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${number}th`;
  }
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[number % 10] || "th";
  return `${number}${suffix}`;
}

function buildSlotDefinition(index) {
  const id = `slot${index}`;
  const label = index === 4 ? "Compcation LLM" : `${formatOrdinal(index)} LLM`;
  const ggufStateDir = index === 1 ? GGUF_STATE_DIR : path.join(GGUF_STATE_DIR, id);
  const ggufTq3StateDir = index === 1 ? GGUF_TQ3_STATE_DIR : path.join(GGUF_TQ3_STATE_DIR, id);
  const beellamaStateDir = index === 1 ? BEELLAMA_STATE_DIR : path.join(BEELLAMA_STATE_DIR, id);
  const mlxStateDir = index === 1 ? MLX_STATE_DIR : path.join(MLX_STATE_DIR, id);
  const rapidMlxStateDir = index === 1 ? RAPID_MLX_STATE_DIR : path.join(RAPID_MLX_STATE_DIR, id);
  const mtplxStateDir = index === 1 ? MTPLX_STATE_DIR : path.join(MTPLX_STATE_DIR, id);
  const optiqStateDir = index === 1 ? OPTIQ_STATE_DIR : path.join(OPTIQ_STATE_DIR, id);
  const dflashStateDir = index === 1 ? DFLASH_STATE_DIR : path.join(DFLASH_STATE_DIR, id);
  const turboquantStateDir = index === 1 ? TURBO_QUANT_STATE_DIR : path.join(TURBO_QUANT_STATE_DIR, id);
  return {
    id,
    index,
    label,
    shortLabel: formatOrdinal(index),
    iconName: SLOT_ICON_NAMES[index - 1] || "circle",
    publicPort: PUBLIC_API_PORT_BASE + index - 1,
    localRuntimeBaseUrl: `http://${API_PUBLIC_HOST}:${PUBLIC_API_PORT_BASE + index - 1}/v1`,
    ggufBackendPort: GGUF_BACKEND_PORT_BASE + index - 1,
    ggufTq3BackendPort: GGUF_TQ3_BACKEND_PORT_BASE + index - 1,
    beellamaBackendPort: BEELLAMA_BACKEND_PORT_BASE + index - 1,
    mlxBackendPort: MLX_BACKEND_PORT_BASE + index - 1,
    dflashBackendPort: DFLASH_BACKEND_PORT_BASE + index - 1,
    turboquantBackendPort: TURBO_QUANT_BACKEND_PORT_BASE + index - 1,
    ggufStateDir,
    mlxStateDir,
    rapidMlxStateDir,
    dflashStateDir,
    mtplxBackendPort: MTPLX_BACKEND_PORT_BASE + index - 1,
    mtplxStateDir,
    optiqStateDir,
    ggufTq3StateDir,
    beellamaStateDir,
    turboquantStateDir,
  };
}

function getSlotDefinition(slotId) {
  return SLOT_DEFINITIONS.find((slot) => slot.id === slotId) || null;
}

function getVoiceSlotDefinition(slotId) {
  return VOICE_SLOT_DEFINITIONS.find((slot) => slot.id === slotId) || null;
}

function buildDefaultIntegrationTargets(defaultSlotId = "slot1") {
  return applicationTargetsToIntegrationTargets(buildDefaultApplicationTargets(defaultSlotId));
}

function getLaunchableApplicationKeys() {
  return APPLICATION_DEFINITIONS
    .filter((entry) => entry.slotKind === "llm" && entry.visibleInApplications !== false)
    .map((entry) => entry.key);
}

function requestedApplicationTargetsFromPayload(payload) {
  const requested = Object.fromEntries(getLaunchableApplicationKeys().map((key) => [key, false]));
  const explicitTargets = (payload?.applicationTargets && typeof payload.applicationTargets === "object")
    ? payload.applicationTargets
    : {};

  for (const key of Object.keys(requested)) {
    if (Object.prototype.hasOwnProperty.call(explicitTargets, key)) {
      requested[key] = Boolean(explicitTargets[key]);
    }
  }

  // Backward compatibility with older frontend payloads.
  requested.hermes = requested.hermes || Boolean(payload?.setHermes);
  requested.hermesm4 = requested.hermesm4 || Boolean(payload?.setHermesM4);
  requested.compaction = requested.compaction || Boolean(payload?.setCompaction);
  requested.compactionm4 = requested.compactionm4 || Boolean(payload?.setCompactionM4);
  requested.claudecode = requested.claudecode || Boolean(payload?.setOpenClaude);
  requested.librechat = requested.librechat || Boolean(payload?.setChat);
  requested.remotejsonapp = requested.remotejsonapp || Boolean(payload?.setRemoteJsonApp);
  requested.sqliteapp = requested.sqliteapp || Boolean(payload?.setSqliteApp);
  requested.voiceapp = requested.voiceapp || Boolean(payload?.setVoiceApp);
  requested.podcastg = requested.podcastg || Boolean(payload?.setPodcastG);
  requested.podgag = requested.podgag || Boolean(payload?.setPodGAutoGen);
  requested.hermespc = requested.hermespc || Boolean(payload?.setHermesPc);
  requested.opencodepc = requested.opencodepc || Boolean(payload?.setOpenCodePc);
  requested.omppc = requested.omppc || Boolean(payload?.setOmpPc);
  requested.pipc = requested.pipc || Boolean(payload?.setPiPc);

  return requested;
}

function parseLauncherRequestBody(body = {}) {
  const parseNumber = (value, fallback) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  };
  const parseIntNumber = (value, fallback) => {
    const numeric = Number.parseInt(String(value ?? ""), 10);
    return Number.isInteger(numeric) ? numeric : fallback;
  };
  return {
    ctxSize: Number(body.ctxSize || 0),
    parallel: Number(body.parallel || 0),
    thinking: Boolean(body.thinking),
    reasoningBudget: parseIntNumber(body.reasoningBudget, null),
    enableDry: Boolean(body.enableDry),
    mtpDraftMax: parseIntNumber(body.mtpDraftMax, null),
    ubatchSize: parseIntNumber(body.ubatchSize, null),
    dsparkMode: normalizeDsparkMode(body.dsparkMode),
    reasoningEffort: normalizeDsparkReasoningEffort(body.reasoningEffort),
    enableTinyGrammar: Boolean(body.enableTinyGrammar),
    enableStructuredGbnf: Boolean(body.enableStructuredGbnf),
    chatTemplate: String(body.chatTemplate || "").trim(),
    launcher: String(body.launcher || "").trim(),
    temperature: parseNumber(body.temperature, LAUNCH_SAMPLING_DEFAULTS.temperature),
    topP: parseNumber(body.topP, LAUNCH_SAMPLING_DEFAULTS.topP),
    topK: parseIntNumber(body.topK, LAUNCH_SAMPLING_DEFAULTS.topK),
    minP: parseNumber(body.minP, LAUNCH_SAMPLING_DEFAULTS.minP),
    presencePenalty: parseNumber(body.presencePenalty, LAUNCH_SAMPLING_DEFAULTS.presencePenalty),
    repetitionPenalty: parseNumber(body.repetitionPenalty, LAUNCH_SAMPLING_DEFAULTS.repetitionPenalty),
  };
}

function buildDefaultApplicationTargets(defaultSlotId = "slot1") {
  const fallbackSlotId = getSlotDefinition(defaultSlotId) ? defaultSlotId : SLOT_DEFINITIONS[0]?.id || "slot1";
  return Object.fromEntries(APPLICATION_KEYS.map((key) => [key, getDefaultApplicationTargetSlotId(key, fallbackSlotId)]));
}

function normalizeIntegrationTargets(targets) {
  const normalized = buildDefaultIntegrationTargets();
  for (const key of INTEGRATION_KEYS) {
    const slotId = String(targets?.[key] || "").trim();
    if (getSlotDefinition(slotId)) {
      normalized[key] = slotId;
    }
  }
  return normalized;
}

function normalizeApplicationTargets(targets) {
  const normalized = buildDefaultApplicationTargets();
  for (const key of APPLICATION_KEYS) {
    const slotId = String(targets?.[key] || "").trim();
    if (getApplicationSlot(key, slotId)) {
      normalized[key] = slotId;
    }
  }
  return normalized;
}

function applicationTargetsToIntegrationTargets(applicationTargets) {
  const normalized = normalizeApplicationTargets(applicationTargets);
  return {
    hermes: normalized.hermes,
    openclaude: normalized.claudecode,
    chat: normalized.librechat,
  };
}

function integrationTargetsToApplicationTargets(targets) {
  const normalized = normalizeIntegrationTargets(targets);
  const fallbackSlotId = normalized.hermes || normalized.openclaude || normalized.chat || SLOT_DEFINITIONS[0]?.id || "slot1";
  return {
    ...buildDefaultApplicationTargets(fallbackSlotId),
    hermes: normalized.hermes,
    remotejsonapp: normalized.hermes,
    librechat: normalized.chat,
    claudecode: normalized.openclaude,
  };
}

function buildSlotIntegrationFlags(slot, integrationTargets) {
  return Object.fromEntries(
    INTEGRATION_KEYS.map((key) => [key, integrationTargets[key] === slot.id])
  );
}

function buildSlotApplicationFlags(slot, applicationTargets) {
  return Object.fromEntries(
    APPLICATION_KEYS.map((key) => [key, applicationTargets[key] === slot.id])
  );
}

function getApplicationDefinition(key) {
  return APPLICATION_DEFINITIONS.find((entry) => entry.key === key) || null;
}

function getDefaultApplicationTargetSlotId(applicationKey, fallbackSlotId = "slot1") {
  const definition = getApplicationDefinition(applicationKey);
  if (definition?.slotKind === "voice") {
    if (applicationKey === "voicetts") {
      return VOICE_SLOT_DEFINITIONS.find((slot) => slot.type === "tts")?.id || "voice-tts-1";
    }
    if (applicationKey === "voicestt") {
      return VOICE_SLOT_DEFINITIONS.find((slot) => slot.type === "stt")?.id || "voice-stt-1";
    }
  }
  return getSlotDefinition(fallbackSlotId) ? fallbackSlotId : SLOT_DEFINITIONS[0]?.id || "slot1";
}

function getApplicationSlot(applicationKey, slotId) {
  const definition = getApplicationDefinition(applicationKey);
  if (!definition) {
    return null;
  }
  return definition.slotKind === "voice" ? getVoiceSlotDefinition(slotId) : getSlotDefinition(slotId);
}

function buildApplicationRows(applicationTargets) {
  const normalized = normalizeApplicationTargets(applicationTargets);
  return APPLICATION_DEFINITIONS.filter((entry) => entry.visibleInApplications !== false).map((entry) => {
    const slotId = normalized[entry.key];
    const slot = getApplicationSlot(entry.key, slotId);
    return {
      key: entry.key,
      label: entry.label,
      badgeLabel: entry.badgeLabel,
      slotId,
      slotLabel: slot?.label || slotId,
    };
  });
}

function getDefaultLogs(slot, runtime) {
  if (runtime === "beellama") {
    return {
      server: path.join(slot.beellamaStateDir, "llama-server.log"),
      traffic: path.join(slot.beellamaStateDir, "traffic.log"),
      proxy: path.join(slot.beellamaStateDir, "proxy.log"),
    };
  }

  if (runtime === "gguf-tq3") {
    return {
      server: path.join(slot.ggufTq3StateDir, "llama-server.log"),
      traffic: path.join(slot.ggufTq3StateDir, "traffic.log"),
      proxy: path.join(slot.ggufTq3StateDir, "proxy.log"),
    };
  }

  if (runtime === "mlx-dspark") {
    const stateDir = path.join(DEFAULT_XDG_STATE_HOME, "mlx_dspark", slot.id);
    return {
      server: path.join(stateDir, "mlx-dspark-api.log"),
      traffic: "",
      proxy: path.join(stateDir, "mlx-dspark-api.log"),
    };
  }

  if (runtime === "mlx-vlm") {
    const stateDir = path.join(DEFAULT_XDG_STATE_HOME, "mlx_vlm", slot.id);
    return {
      server: path.join(stateDir, "mlx-vlm-api.log"),
      traffic: "",
      proxy: path.join(stateDir, "mlx-vlm-api.log"),
    };
  }

  if (runtime === "ds4") {
    const stateDir = path.join(DEFAULT_XDG_STATE_HOME, "ds4", slot.id);
    return {
      server: path.join(stateDir, "ds4-api.log"),
      traffic: "",
      proxy: path.join(stateDir, "ds4-api.log"),
    };
  }

  if (runtime === "rapid-mlx") {
    return {
      server: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "qwen36-rapid-mlx-api.log")
        : path.join(slot.rapidMlxStateDir, "qwen36-rapid-mlx-api.log"),
      traffic: "",
      proxy: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "qwen36-rapid-mlx-api.log")
        : path.join(slot.rapidMlxStateDir, "qwen36-rapid-mlx-api.log"),
    };
  }

  if (runtime === "mtplx") {
    return {
      server: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "qwen36-mtplx-api.log")
        : path.join(slot.mtplxStateDir, "qwen36-mtplx-api.log"),
      traffic: "",
      proxy: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "qwen36-mtplx-api.log")
        : path.join(slot.mtplxStateDir, "qwen36-mtplx-api.log"),
    };
  }

  if (runtime === "optiq") {
    return {
      server: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "optiq-api.log")
        : path.join(slot.optiqStateDir, "optiq-api.log"),
      traffic: "",
      proxy: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "optiq-api.log")
        : path.join(slot.optiqStateDir, "optiq-api.log"),
    };
  }

  if (runtime === "mlx") {
    return {
      server: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "qwen36-mlx-api.log")
        : path.join(slot.mlxStateDir, "qwen36-mlx-api.log"),
      traffic: "",
      proxy: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "qwen36-mlx-api.log")
        : path.join(slot.mlxStateDir, "qwen36-mlx-api.log"),
    };
  }

  if (runtime === "dflash") {
    return {
      server: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "qwen36-dflash-api.log")
        : path.join(slot.dflashStateDir, "qwen36-dflash-api.log"),
      traffic: "",
      proxy: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "qwen36-dflash-api.log")
        : path.join(slot.dflashStateDir, "qwen36-dflash-api.log"),
    };
  }

  if (runtime === "turboquant") {
    return {
      server: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "qwen36-turboquant-api.log")
        : path.join(slot.turboquantStateDir, "qwen36-turboquant-api.log"),
      traffic: "",
      proxy: indexOr(slot.index, 1) === 1
        ? path.join(HOME, "qwen36-turboquant-api.log")
        : path.join(slot.turboquantStateDir, "qwen36-turboquant-api.log"),
    };
  }

  return {
    server: path.join(slot.ggufStateDir, "llama-server.log"),
    traffic: path.join(slot.ggufStateDir, "traffic.log"),
    proxy: path.join(slot.ggufStateDir, "proxy.log"),
  };
}

function extractThinkingLogContent(buffer, baseOffset, minOffset) {
  const output = [];
  const logLinePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \[([^\]]+)\]/;
  let inThinkingBlock = false;
  let lineStart = 0;

  const pushLine = (rawLine, absoluteEndOffset) => {
    if (absoluteEndOffset <= minOffset) {
      return;
    }
    output.push(rawLine.replace(/\r$/, ""));
  };

  const processLine = (lineEnd, hasNewline) => {
    const lineBuffer = buffer.subarray(lineStart, lineEnd);
    const line = lineBuffer.toString("utf8");
    const absoluteEndOffset = baseOffset + lineEnd + (hasNewline ? 1 : 0);
    const logLineMatch = line.match(logLinePattern);
    if (logLineMatch) {
      inThinkingBlock = String(logLineMatch[1] || "").trim().toLowerCase() === "thinking";
      if (inThinkingBlock) {
        pushLine(line, absoluteEndOffset);
      }
      return;
    }
    if (inThinkingBlock) {
      pushLine(line, absoluteEndOffset);
    }
  };

  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) {
      continue;
    }
    processLine(index, true);
    lineStart = index + 1;
  }

  if (lineStart < buffer.length) {
    processLine(buffer.length, false);
  }

  return output.join("\n").trimEnd();
}

async function readThinkingLogChunk(filePath, requestedOffset = 0, minOffset = 0) {
  if (!filePath) {
    return {
      content: "",
      nextOffset: 0,
      reset: requestedOffset > 0,
    };
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    return {
      content: "",
      nextOffset: 0,
      reset: requestedOffset > 0,
    };
  }

  const floorOffset = Number.isFinite(minOffset) ? Math.max(0, minOffset) : 0;
  let clearOffset = Math.max(
    floorOffset,
    Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0
  );
  let reset = false;
  if (clearOffset > stat.size) {
    if (floorOffset > 0) {
      return {
        content: "",
        nextOffset: stat.size,
        reset: true,
      };
    }
    clearOffset = 0;
    reset = true;
  }

  let contentStart = clearOffset;
  if (stat.size - contentStart > THINKING_LOG_READ_LIMIT) {
    contentStart = Math.max(clearOffset, stat.size - THINKING_LOG_READ_LIMIT);
    reset = true;
  }

  const readStart = Math.max(0, contentStart - THINKING_LOG_LOOKBEHIND);
  const length = Math.max(0, stat.size - readStart);
  if (length === 0) {
    return {
      content: "",
      nextOffset: stat.size,
      reset,
    };
  }

  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, readStart);
    return {
      content: extractThinkingLogContent(buffer, readStart, contentStart),
      nextOffset: stat.size,
      reset,
    };
  } finally {
    await handle.close();
  }
}

async function readThinkingLogContent(filePath, minOffset = 0) {
  if (!filePath) {
    return "";
  }
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size <= 0) {
    return "";
  }
  const clearOffset = Math.min(
    stat.size,
    Number.isFinite(minOffset) ? Math.max(0, minOffset) : 0
  );
  const readStart = Math.max(0, clearOffset - THINKING_LOG_LOOKBEHIND);
  const length = Math.max(0, stat.size - readStart);
  if (length === 0) {
    return "";
  }
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, readStart);
    return extractThinkingLogContent(buffer, readStart, clearOffset);
  } finally {
    await handle.close();
  }
}

async function getLogClearPoint(filePath) {
  if (!filePath) {
    return 0;
  }
  const stat = await fs.stat(filePath).catch(() => null);
  return stat ? stat.size : 0;
}

function getThinkingClearMarkerPath(slot, filePath) {
  const digest = createHash("sha256").update(String(filePath || "")).digest("hex").slice(0, 20);
  return path.join(LOG_CLEAR_STATE_DIR, `${slot.id}-thinking-${digest}.json`);
}

async function readThinkingClearOffset(slot, filePath) {
  if (!slot || !filePath) {
    return 0;
  }
  const markerPath = getThinkingClearMarkerPath(slot, filePath);
  const payload = await fs.readFile(markerPath, "utf8").then(JSON.parse).catch(() => null);
  if (!payload || payload.filePath !== filePath) {
    return 0;
  }
  const offset = Number(payload.clearOffset || 0);
  if (!Number.isFinite(offset) || offset <= 0) {
    return 0;
  }
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size <= 0) {
    return 0;
  }
  if (offset > stat.size) {
    await fs.rm(markerPath, { force: true }).catch(() => {});
    return 0;
  }
  return offset;
}

async function writeThinkingClearOffset(slot, filePath, clearOffset) {
  if (!slot || !filePath) {
    return 0;
  }
  await fs.mkdir(LOG_CLEAR_STATE_DIR, { recursive: true });
  const offset = Math.max(0, Number(clearOffset || 0));
  const markerPath = getThinkingClearMarkerPath(slot, filePath);
  const payload = {
    slotId: slot.id,
    kind: "thinking",
    filePath,
    clearOffset: offset,
    clearedAt: new Date().toISOString(),
  };
  await fs.writeFile(markerPath, JSON.stringify(payload, null, 2), "utf8");
  return offset;
}

function createIdleStatus(slot) {
  return {
    slotId: slot.id,
    slotLabel: slot.label,
    slotIndex: slot.index,
    running: false,
    lastCrash: null,
    logs: {
      gguf: getDefaultLogs(slot, "gguf"),
      "gguf-tq3": getDefaultLogs(slot, "gguf-tq3"),
      beellama: getDefaultLogs(slot, "beellama"),
      mlx: getDefaultLogs(slot, "mlx"),
      "rapid-mlx": getDefaultLogs(slot, "rapid-mlx"),
      mtplx: getDefaultLogs(slot, "mtplx"),
      optiq: getDefaultLogs(slot, "optiq"),
      dflash: getDefaultLogs(slot, "dflash"),
      turboquant: getDefaultLogs(slot, "turboquant"),
      active: getDefaultLogs(slot, "gguf"),
    },
  };
}

function normalizeModelRuntime(value) {
  const runtime = String(value || "").trim().toLowerCase();
  if (runtime === "gguf-tq3" || runtime === "llama.cpp-tq3") {
    return "gguf";
  }
  if (runtime === "beellama") {
    return "gguf";
  }
  if (runtime === "mtplx") {
    return "mtplx";
  }
  if (runtime === "dflash") {
    return "dflash";
  }
  if (runtime === "turboquant") {
    return "turboquant";
  }
  if (runtime === "mlx") {
    return "mlx";
  }
  // mlx-dspark serves an MLX model dir, so everything downstream (API key,
  // context resolution, launcher matrix) should treat it as MLX; without this
  // the status card reported a running MLX model as "gguf".
  if (runtime === "mlx-dspark") {
    return "mlx";
  }
  // Same reasoning for mlx-vlm: it serves an MLX model directory, so the status
  // card, API-key choice and launcher matrix must all treat it as MLX.
  if (runtime === "mlx-vlm") {
    return "mlx";
  }
  return "gguf";
}

function getRuntimeApiKey(value) {
  return normalizeModelRuntime(value) === "mtplx" ? LOCAL_LLM_API_KEY : "api";
}

function buildRuntimeAuthHeaders(apiKey) {
  const value = String(apiKey || "").trim();
  if (!value) {
    return {};
  }
  return {
    authorization: `Bearer ${value}`,
    "x-api-key": value,
  };
}

function getLaunchersForRuntime(runtime) {
  const normalizedRuntime = normalizeModelRuntime(runtime);
  if (normalizedRuntime === "mtplx") {
    return experimentalMlxLaunchersEnabled() ? ["mlx", "mtplx"] : [];
  }
  if (normalizedRuntime === "turboquant") {
    return experimentalMlxLaunchersEnabled() ? ["turboquant"] : [];
  }
  if (normalizedRuntime === "mlx") {
    return experimentalMlxLaunchersEnabled() ? ["mlx"] : [];
  }
  if (normalizedRuntime === "dflash") {
    return experimentalMlxLaunchersEnabled() ? ["dflash"] : [];
  }
  return ["gguf"];
}

function modelTraitText(model) {
  return [
    model?.key,
    model?.label,
    model?.family,
    model?.path,
    model?.repoId,
    model?.downloadId,
    model?.hfUrl,
    model?.quantization,
    ...(Array.isArray(model?.aliases) ? model.aliases : []),
  ].map((value) => String(value || "").trim()).filter(Boolean).join(" ").toLowerCase();
}

function isTq3Model(model) {
  const text = modelTraitText(model);
  return text.includes("tq3") || text.includes("turboquant");
}

// A ds4 (DwarfStar) pack is one base GGUF plus a mandatory *-PLE-*.gguf n-gram
// table. Two things must not happen when such a repo is scanned: the 29.8 GiB
// PLE file must never be listed as a model of its own, and the base GGUF --
// whose name ends in "-MTP" because the MTP head lives INSIDE the pack, not
// beside it -- must not be mistaken for a speculative draft head and hidden.
function isDs4PleSidecarFile(filePath) {
  return /-ple-[^/]*\.gguf$/i.test(String(filePath || "").replace(/\\/g, "/"));
}

// Set at scan time from the PLE sidecar's presence; the trait fallback covers a
// pack registered by hand or renamed.
function isDs4PackModel(model) {
  if (model?.ds4Pack === true) {
    return true;
  }
  const text = modelTraitText(model);
  return text.includes("ds4-iq2") || text.includes("ds4-q4") || text.includes("dwarfstar");
}

function isMtpGgufModel(model) {
  const text = modelTraitText(model);
  return text.includes("mtp") || text.includes("speculative");
}

function isOptiqPairBundleModel(model) {
  const text = modelTraitText(model);
  return text.includes("mtplx_pair.json")
    || text.includes("gemma4-mtplx-optimized-quality")
    || text.includes("gemma4-mtplx-optimized-speed")
    || String(model?.launcher || "").trim() === "optiq";
}

function modelCanRunMtplx(model) {
  return model?.mtplxSupport?.canRun === true || normalizeModelRuntime(model?.runtime || model?.launcher) === "mtplx";
}

function modelCanRunRapidMlx(model) {
  const runtime = normalizeModelRuntime(model?.runtime || model?.launcher);
  return model?.rapidMlxSupport?.canRun === true
    || model?.mtplxSupport?.recognized === true
    || runtime === "mtplx"
    || String(model?.launcher || "").trim() === "rapid-mlx";
}

function experimentalBeellamaEnabled() {
  // Benchmarks (2026-06): beellama decodes 15-30% slower than upstream
  // llama.cpp on every model it can load and crashes Gemma 4 fatally, so the
  // mere presence of the metal build no longer auto-enables it.
  return ["1", "true", "yes"].includes(String(process.env.LLM3_ENABLE_EXPERIMENTAL_BEELLAMA || "").trim().toLowerCase());
}

let mlxDsparkInstalledCache = null;
function mlxDsparkInstalled() {
  if (mlxDsparkInstalledCache === null) {
    // LLM3_MLX_DSPARK_INSTALLED=1|0 overrides the probe. The tests set it, so
    // the launcher list they assert does not depend on which machine has the
    // venv: the CI runner has none, and four tests failed there for that alone.
    const override = String(process.env.LLM3_MLX_DSPARK_INSTALLED || "").trim().toLowerCase();
    if (["1", "true", "yes"].includes(override)) {
      mlxDsparkInstalledCache = true;
    } else if (["0", "false", "no"].includes(override)) {
      mlxDsparkInstalledCache = false;
    } else {
      mlxDsparkInstalledCache = fsSync.existsSync(path.join(HOME, ".venvs", "mlx-dspark", "bin", "mlx-dspark"))
        && fsSync.existsSync(MLX_DSPARK_LAUNCHER);
    }
  }
  return mlxDsparkInstalledCache;
}

// --- which MLX runtime can actually load a given architecture -----------------
//
// mlx-dspark loads a target through mlx-lm when mlx-lm implements its
// model_type, and falls back to mlx-vlm otherwise. That fallback calls
// `lm.logits_from_hidden(...)` (mlx_dspark/target.py), a hook only a couple of
// mlx-vlm families define -- so for every other mlx-vlm-only architecture
// mlx-dspark loads the weights, binds the port, and then fails the first
// generation with:
//   AttributeError: 'LanguageModel' object has no attribute 'logits_from_hidden'
// Qwen3.8-Flash-Next (qwen4_exp) is the first such model here. Offering
// mlx-dspark for those is a trap: the slot looks healthy until you send a
// prompt. So decide from what is installed rather than guessing.
//
// Everything below is filesystem inspection of the venv, cached for the process
// lifetime; it re-derives itself after a package upgrade + llm3 restart.
const mlxSupportCache = { lm: null, vlm: null, dsparkVlm: null, modelTypes: new Map() };

function mlxVenvSitePackages() {
  const base = path.join(HOME, ".venvs", "mlx-dspark", "lib");
  const entries = fsSync.existsSync(base) ? fsSync.readdirSync(base) : [];
  const py = entries.find((entry) => entry.startsWith("python"));
  return py ? path.join(base, py, "site-packages") : "";
}

// model_types mlx-lm implements, i.e. the ones mlx-dspark drives natively.
function mlxLmModelTypes() {
  if (mlxSupportCache.lm === null) {
    const dir = path.join(mlxVenvSitePackages(), "mlx_lm", "models");
    const entries = fsSync.existsSync(dir) ? fsSync.readdirSync(dir) : [];
    mlxSupportCache.lm = new Set(
      entries.filter((entry) => entry.endsWith(".py")).map((entry) => entry.slice(0, -3)),
    );
  }
  return mlxSupportCache.lm;
}

// model_types mlx-vlm implements (one package directory each).
function mlxVlmModelTypes() {
  if (mlxSupportCache.vlm === null) {
    const dir = path.join(mlxVenvSitePackages(), "mlx_vlm", "models");
    const entries = fsSync.existsSync(dir)
      ? fsSync.readdirSync(dir, { withFileTypes: true })
      : [];
    mlxSupportCache.vlm = new Set(
      entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("_")).map((entry) => entry.name),
    );
  }
  return mlxSupportCache.vlm;
}

// Can mlx-dspark actually generate with this mlx-vlm family, or only load it?
//
// Asked of the real class rather than by grepping sources, because the answer
// is often inherited: qwen4_exp gets its methods from Qwen3_5LanguageModel, so
// a grep of its own directory says nothing. mlx_dspark/target.py needs both
// `logits_from_hidden` (the vocab projection) and `make_cache`; a family
// missing either loads fine, binds the port, and then throws AttributeError on
// the first token. Measured on this box: gemma4 and minimax_m3_vl have both,
// mage_vl has neither, qwen4_exp has only make_cache.
//
// Returns null when the probe cannot run at all, which callers treat as "do not
// change anything" rather than as "unsupported".
const MLX_DSPARK_VLM_PROBE = [
  "import importlib, json, sys",
  "t = sys.argv[1]",
  "lm = None",
  "for name in (f'mlx_vlm.models.{t}.language', f'mlx_vlm.models.{t}.{t}'):",
  "    try:",
  "        lm = getattr(importlib.import_module(name), 'LanguageModel', None)",
  "    except Exception:",
  "        continue",
  "    if lm is not None:",
  "        break",
  "print(json.dumps(None if lm is None else bool(",
  "    hasattr(lm, 'logits_from_hidden') and hasattr(lm, 'make_cache'))))",
].join("\n");

function mlxDsparkCanServeVlmType(type) {
  if (mlxSupportCache.dsparkVlm === null) {
    mlxSupportCache.dsparkVlm = new Map();
  }
  if (mlxSupportCache.dsparkVlm.has(type)) {
    return mlxSupportCache.dsparkVlm.get(type);
  }
  let answer = null;
  try {
    const out = execFileSync(MLX_VLM_PYTHON, ["-c", MLX_DSPARK_VLM_PROBE, type], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(String(out).trim());
    answer = typeof parsed === "boolean" ? parsed : null;
  } catch (_error) {
    answer = null;
  }
  mlxSupportCache.dsparkVlm.set(type, answer);
  return answer;
}

// A local MLX model directory declares its architecture in config.json. Nested
// under text_config for multimodal repos, so check both.
function readMlxModelType(model) {
  const dir = String(model?.path || model?.key || "").trim();
  if (!dir) {
    return "";
  }
  if (mlxSupportCache.modelTypes.has(dir)) {
    return mlxSupportCache.modelTypes.get(dir);
  }
  let type = "";
  try {
    const config = JSON.parse(fsSync.readFileSync(path.join(dir, "config.json"), "utf8"));
    type = String(config?.model_type || config?.text_config?.model_type || "").trim();
  } catch (_error) {
    type = "";
  }
  mlxSupportCache.modelTypes.set(dir, type);
  return type;
}

// null = "cannot tell" (no config.json, nothing installed to compare against);
// callers keep the old behaviour rather than hiding a launcher on a guess.
function mlxRuntimeSupport(model) {
  const type = readMlxModelType(model);
  if (!type) {
    return null;
  }
  const lmTypes = mlxLmModelTypes();
  const vlmTypes = mlxVlmModelTypes();
  if (!lmTypes.size && !vlmTypes.size) {
    return null;
  }
  return {
    modelType: type,
    mlxLm: lmTypes.has(type),
    mlxVlm: vlmTypes.has(type),
    // mlx-lm support means mlx-dspark never takes its mlx-vlm path at all.
    // Otherwise ask the class. A null probe result keeps mlx-dspark on offer
    // rather than hiding it on a failed measurement.
    dsparkCapable: lmTypes.has(type) || (mlxDsparkCanServeVlmType(type) !== false),
  };
}

let mlxVlmLauncherInstalledCache = null;
function mlxVlmLauncherInstalled() {
  if (mlxVlmLauncherInstalledCache === null) {
    mlxVlmLauncherInstalledCache = fsSync.existsSync(MLX_VLM_LAUNCHER)
      && fsSync.existsSync(path.join(mlxVenvSitePackages(), "mlx_vlm"));
  }
  return mlxVlmLauncherInstalledCache;
}

function experimentalMlxLaunchersEnabled() {
  // Benchmarks (2026-06): MTPLX 30-58 tok/s vs GGUF MTP 62-71 tok/s on the
  // same prompts, plain MLX/rapid-mlx never beat llama.cpp/Metal here, and
  // OptIQ was the slowest Gemma path measured (8.8 tok/s). Keep the whole MLX
  // launcher family (mlx, rapid-mlx, mtplx, optiq, dflash, turboquant) out of
  // the matrix unless explicitly re-enabled for experiments.
  return ["1", "true", "yes"].includes(String(process.env.LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS || "").trim().toLowerCase());
}

function getLaunchersForModel(model) {
  const runtime = normalizeModelRuntime(model?.runtime || model?.launcher);
  if (runtime === "gguf") {
    // First, and unconditionally: llama.cpp rejects a ds4 pack outright (the
    // pack manifest and the qwen4exp architecture are DS4-specific), so ds4 is
    // not one option among several here -- it is the only one.
    if (isDs4PackModel(model)) {
      return ["ds4"];
    }
    if (isTq3Model(model)) {
      return ["gguf-tq3"];
    }
    if (isMtpGgufModel(model)) {
      return ["gguf"];
    }
    const launchers = ["gguf"];
    // Gemma 4 crashes beellama fatally during warmup (ggml_compute_forward_scale
    // abort; see benchmarks/SUMMARY.md gemma-4 beellama rows), so keep that
    // combination out of the matrix until the fork is fixed.
    if (experimentalBeellamaEnabled() && !isGemma4Model(model)) {
      launchers.push("beellama");
    }
    return launchers;
  }
  if (runtime === "mlx" && isOptiqPairBundleModel(model)) {
    return experimentalMlxLaunchersEnabled() ? ["optiq"] : [];
  }
  const launchers = getLaunchersForRuntime(runtime);
  if (experimentalMlxLaunchersEnabled() && (runtime === "mlx" || runtime === "mtplx") && modelCanRunRapidMlx(model) && !launchers.includes("rapid-mlx")) {
    launchers.push("rapid-mlx");
  }
  if (experimentalMlxLaunchersEnabled() && (runtime === "mlx" || runtime === "mtplx") && modelCanRunMtplx(model) && !launchers.includes("mtplx")) {
    launchers.push("mtplx");
  }
  if ((runtime === "mlx" || runtime === "mtplx") && mlxDsparkInstalled() && !launchers.includes("mlx-dspark")) {
    launchers.push("mlx-dspark");
  }
  if (runtime === "mlx" || runtime === "mtplx") {
    const support = mlxRuntimeSupport(model);
    // An architecture only mlx-vlm implements: mlx-dspark can load it but not
    // generate with it, and mlx/rapid-mlx/mtplx go through mlx-lm, which has no
    // implementation at all. mlx-vlm's own server is the only one that runs it.
    if (support && !support.dsparkCapable) {
      const usable = mlxVlmLauncherInstalled() && support.mlxVlm ? ["mlx-vlm"] : [];
      return usable;
    }
    // mlx-dspark first: it is the only MLX path here that beats GGUF/Metal.
    const preferredOrder = ["mlx-dspark", "mlx", "rapid-mlx", "mtplx"];
    return [
      ...preferredOrder.filter((candidate) => launchers.includes(candidate)),
      ...launchers.filter((candidate) => !preferredOrder.includes(candidate)),
    ];
  }
  return launchers;
}

function getLauncherWarningsForModel(model) {
  const runtime = normalizeModelRuntime(model?.runtime || model?.launcher);
  if (runtime === "mlx" || runtime === "mtplx") {
    const support = mlxRuntimeSupport(model);
    if (support && !support.dsparkCapable) {
      if (support.mlxVlm && mlxVlmLauncherInstalled()) {
        return [{
          launcher: "mlx-vlm",
          severity: "info",
          code: "mlx-vlm-only-architecture",
          benchmarkExcluded: true,
          message: `${support.modelType} is implemented by mlx-vlm only. mlx-dspark loads it but cannot generate (it needs a logits_from_hidden hook this family does not define), so this model runs on the mlx-vlm launcher.`,
        }];
      }
      return [{
        launcher: "mlx-vlm",
        severity: "warning",
        code: "mlx-architecture-unsupported",
        benchmarkExcluded: true,
        message: `No installed MLX runtime implements ${support.modelType}. mlx-lm has no module for it and mlx-vlm ${support.mlxVlm ? "is not reachable from the configured venv" : "does not implement it either"}. Upgrading mlx-vlm may add it.`,
      }];
    }
  }
  if (isTq3Model(model) && process.platform === "darwin") {
    return [{
      launcher: "gguf-tq3",
      severity: "warning",
      code: "apple-tq3-cpu-only",
      benchmarkExcluded: true,
      message: "gguf-tq3 TQ3_4S runs CPU-only on this Mac because the local TQ3 fork does not provide working Metal offload for this quantization.",
    }];
  }
  return [];
}

function applyLauncherMetadata(model) {
  const runtime = normalizeModelRuntime(model?.runtime || model?.launcher);
  const provisionalModel = {
    ...model,
    launcher: model?.launcher && model.launcher !== model.runtime ? String(model.launcher) : runtime,
    runtime,
  };
  const launchers = getLaunchersForModel(provisionalModel);
  const launcher = launchers.includes(provisionalModel.launcher) ? provisionalModel.launcher : (launchers[0] || runtime);
  const normalizedModel = {
    ...provisionalModel,
    launcher,
  };
  const launcherWarnings = getLauncherWarningsForModel(normalizedModel);
  const benchmarkLaunchers = launchers.filter(
    (candidate) => !launcherWarnings.some((warning) => warning.launcher === candidate && warning.benchmarkExcluded)
  );
  const unsupported = launchers.length === 0;
  return {
    ...normalizedModel,
    accent: runtime === "dflash" ? "dflash" : runtime === "turboquant" ? "turboquant" : runtime === "mtplx" ? "mtplx" : runtime === "mlx" ? "mlx" : "default",
    // ds4 takes thinking as a per-request field only (think:false /
    // reasoning_effort on the call); it has no launch-time flag, so do not offer
    // a launch control that would do nothing.
    supportsThinking: (runtime === "gguf" && !isTq3Model(normalizedModel) && launcher !== "ds4") || launcher === "optiq",
    launchers,
    benchmarkLaunchers,
    benchmarkExcluded: unsupported || (launchers.length > 0 && benchmarkLaunchers.length === 0),
    unsupported,
    launcherWarnings,
    performanceWarning: unsupported
      ? "No active launcher: the MLX/MTPLX launcher family is disabled because GGUF beat it on this hardware (set LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS=1 to re-enable)."
      : (launcherWarnings[0]?.message || ""),
  };
}

function supportsTinyGrammar(model) {
  return supportsGgufExtras(model);
}

function supportsStructuredGbnf(model) {
  if (!supportsTinyGrammar(model)) {
    return false;
  }
  const aliases = Array.isArray(model?.aliases) ? model.aliases.join(" ") : "";
  const haystack = `${model?.key || ""} ${model?.label || ""} ${model?.family || ""} ${model?.path || ""} ${aliases}`.toLowerCase();
  return haystack.includes("qwen") && haystack.includes("3.6") && (haystack.includes("35b") || haystack.includes("a3b"));
}

function normalizeGrammarSelectionForModel(model, params = {}) {
  const enableStructuredGbnf = supportsStructuredGbnf(model) ? Boolean(params.enableStructuredGbnf) : false;
  const enableTinyGrammar = supportsTinyGrammar(model) ? Boolean(params.enableTinyGrammar) && !enableStructuredGbnf : false;
  return { enableTinyGrammar, enableStructuredGbnf };
}

function buildQwenGrammarArgs(params = {}) {
  return [
    params.enableTinyGrammar ? "--enable-tiny-grammar" : "--no-tiny-grammar",
    params.enableStructuredGbnf ? "--enable-structured-gbnf" : "--no-structured-gbnf",
  ];
}

function resolveCompatibleLauncher(model, launcher = "") {
  const launchers = getLaunchersForModel(model);
  const requestedLauncher = String(launcher || model?.preferredLauncher || model?.launcher || "").trim();
  return launchers.includes(requestedLauncher) ? requestedLauncher : (launchers[0] || normalizeModelRuntime(model?.runtime || model?.launcher));
}

// Per-request context cap for Gemma 4 launches, in tokens. Like every other
// ctxSize in llm3 it is PER PARALLEL SLOT; the backend allocates ctxSize x
// parallel. It used to be treated as a combined budget and divided by the
// parallel count, so a 512K request at parallel 2 silently became 131K while a
// Qwen slot with the same request got its 512K. Override with
// QWEN_LLAMA_GEMMA4_MAX_CONTEXT (the launcher reads the same variable).
const GEMMA4_SAFE_MAX_CONTEXT = (() => {
  const raw = Number.parseInt(String(process.env.QWEN_LLAMA_GEMMA4_MAX_CONTEXT || ""), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 262144;
})();

function isGemma4Model(model = {}) {
  const aliases = Array.isArray(model?.aliases) ? model.aliases.join(" ") : "";
  const haystack = `${model?.key || ""} ${model?.label || ""} ${model?.family || ""} ${model?.path || ""} ${aliases}`
    .toLowerCase()
    .replace(/[/_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compact = haystack.replace(/\s+/g, "");
  return haystack.includes("gemma 4") || compact.includes("gemma4");
}

function normalizeLaunchContextSizeForModel(model, params = {}) {
  const requestedCtxSize = Number(params?.ctxSize || 0);
  if (!Number.isInteger(requestedCtxSize) || requestedCtxSize <= 0 || !isGemma4Model(model)) {
    return requestedCtxSize;
  }

  return Math.min(requestedCtxSize, GEMMA4_SAFE_MAX_CONTEXT);
}

// The llama.cpp-only extras (DRY, reasoning budget, chat-template override,
// ubatch). ds4 serves a GGUF but implements none of them, so it must not be
// treated as llama.cpp here. Keep in step with supportsTinyGrammar in
// public/app.js.
function supportsGgufExtras(model) {
  if (String(model?.launcher || "").trim() === "ds4") {
    return false;
  }
  return normalizeModelRuntime(model?.runtime || model?.launcher) === "gguf" && !isTq3Model(model);
}

// ===================================================================
// Selectable chat templates
//
// Without a selection llama.cpp uses whatever the GGUF embeds (or the
// repo's own chat_template.jinja, see resolve_chat_template_file in
// bin/qwen_llama). A catalog entry is an alternative the user can pick
// per model; `preferred: true` makes it the default for the models it
// supports, until the user explicitly saves the model default instead.
// ===================================================================

const CHAT_TEMPLATE_DEFAULT_KEY = "model-default";
const CHAT_TEMPLATE_CACHE_DIR = process.env.LLM3_CHAT_TEMPLATE_CACHE_DIR
  || path.join(HOME, "models", ".llm3-chat-templates");
const CHAT_TEMPLATE_CATALOG = [
  {
    key: "qwen-sharp",
    label: "Qwen Sharp",
    source: "peculiar-ragdoll",
    description: "Token-efficient Qwen template: terse-answer system prompt, reasoning-effort control, tool-call format enforcement and consecutive-tool-failure warnings.",
    repoId: "peculiar-ragdoll/Qwen-Sharp-Chat-Templates",
    revision: "main",
    remotePath: "chat_template.jinja",
    fileName: "qwen-sharp.jinja",
    preferred: true,
    supports: (model) => isQwen38TwentySevenBModel(model),
  },
];

function isQwen38TwentySevenBModel(model) {
  // Strip separators so "Qwen3.8-27B", "qwen_3_8 27b" and "Qwen3.8 27B" all match.
  const compact = modelTraitText(model).replace(/[\s._\-/]/g, "");
  return compact.includes("qwen38") && compact.includes("27b");
}

function getChatTemplateOptionsForModel(model) {
  // llama.cpp is the only launcher we pass --chat-template-file to.
  if (!supportsGgufExtras(model)) {
    return [];
  }
  return CHAT_TEMPLATE_CATALOG.filter((entry) => entry.supports(model));
}

function getChatTemplateEntry(templateKey) {
  const key = String(templateKey || "").trim();
  return CHAT_TEMPLATE_CATALOG.find((entry) => entry.key === key) || null;
}

// The saved choice wins; otherwise the preferred catalog entry does.
function resolveChatTemplateKey(model, savedKey) {
  const options = getChatTemplateOptionsForModel(model);
  if (!options.length) {
    return CHAT_TEMPLATE_DEFAULT_KEY;
  }
  const saved = String(savedKey || "").trim();
  if (saved === CHAT_TEMPLATE_DEFAULT_KEY) {
    return CHAT_TEMPLATE_DEFAULT_KEY;
  }
  if (options.some((entry) => entry.key === saved)) {
    return saved;
  }
  return options.find((entry) => entry.preferred)?.key || CHAT_TEMPLATE_DEFAULT_KEY;
}

function normalizeChatTemplateParam(model, params = {}) {
  const options = getChatTemplateOptionsForModel(model);
  if (!options.length) {
    return CHAT_TEMPLATE_DEFAULT_KEY;
  }
  const requested = String(params.chatTemplate || "").trim();
  if (!requested) {
    return CHAT_TEMPLATE_DEFAULT_KEY;
  }
  return options.some((entry) => entry.key === requested) ? requested : CHAT_TEMPLATE_DEFAULT_KEY;
}

function getSavedChatTemplateKey(dashboardConfig, modelKey) {
  const saved = dashboardConfig?.chatTemplates?.[String(modelKey || "")];
  return String(saved || "").trim();
}

// Downloads once into a shared cache -- the same template file serves every
// model it applies to, so it does not belong inside any one model directory.
async function ensureChatTemplateFile(templateKey) {
  const entry = getChatTemplateEntry(templateKey);
  if (!entry) {
    return "";
  }
  const targetPath = path.join(CHAT_TEMPLATE_CACHE_DIR, entry.fileName);
  try {
    const stats = await fs.stat(targetPath);
    if (stats.size > 0) {
      return targetPath;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const url = `https://huggingface.co/${entry.repoId}/resolve/${entry.revision}/${entry.remotePath}`;
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(HF_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Chat template download failed for ${entry.label} (HTTP ${response.status}).`);
  }
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`Chat template download for ${entry.label} returned an empty file.`);
  }
  await fs.mkdir(CHAT_TEMPLATE_CACHE_DIR, { recursive: true });
  await fs.writeFile(targetPath, body, "utf8");
  return targetPath;
}

// Resolves the selection to an on-disk path the launcher can be handed.
async function resolveChatTemplateForLaunch(params = {}) {
  const templateKey = String(params.chatTemplate || "").trim();
  if (!templateKey || templateKey === CHAT_TEMPLATE_DEFAULT_KEY) {
    return "";
  }
  return ensureChatTemplateFile(templateKey);
}

function buildChatTemplateOptionsPayload(model, savedKey) {
  const options = getChatTemplateOptionsForModel(model);
  if (!options.length) {
    return null;
  }
  return {
    selected: resolveChatTemplateKey(model, savedKey),
    saved: String(savedKey || "").trim() || null,
    options: [
      { key: CHAT_TEMPLATE_DEFAULT_KEY, label: "Model default", description: "Use the template embedded in the model (or its repo's chat_template.jinja)." },
      ...options.map((entry) => ({
        key: entry.key,
        label: entry.label,
        source: entry.source,
        description: entry.description,
        repoId: entry.repoId,
      })),
    ],
  };
}

function normalizeReasoningBudgetParam(model, params = {}) {
  if (!supportsGgufExtras(model)) {
    return null;
  }
  const value = Number.parseInt(String(params.reasoningBudget ?? ""), 10);
  if (!Number.isInteger(value) || value < -1) {
    return null;
  }
  return value;
}

// llama.cpp micro-batch. Bigger is faster for prompt eval alone, but a large ubatch is
// a long non-preemptible Metal command buffer that stalls every OTHER llama.cpp process
// on the same GPU -- measured 2026-08-21, slot1 fell 10.5 -> 3.7 tok/s while slot2 ran a
// prompt eval. Capped at the batch size, which llama.cpp requires.
function normalizeUbatchSizeParam(model, params = {}) {
  if (!supportsGgufExtras(model)) {
    return null;
  }
  const value = Number.parseInt(String(params.ubatchSize ?? ""), 10);
  if (!Number.isInteger(value) || value < 1 || value > 8192) {
    return null;
  }
  return value;
}

function normalizeMtpDraftMaxParam(model, params = {}) {
  // ds4 has its own embedded MTP head and the same depth knob (--mtp-draft),
  // so it keeps this control even though supportsGgufExtras excludes it.
  if (!supportsGgufExtras(model) && String(model?.launcher || "").trim() !== "ds4") {
    return null;
  }
  const value = Number.parseInt(String(params.mtpDraftMax ?? ""), 10);
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    return null;
  }
  return value;
}

// Keep in step with EMBEDDED_MTP_PATTERNS in public/app.js: Qwen3.8 embeds an
// MTP head without saying so in the file name. bin/qwen_llama makes the real
// call by reading the GGUF's tensors; this is the cheap name-level guess.
const EMBEDDED_MTP_PATTERNS = [/qwen\s*3\.?8/];

function buildGgufExtraArgs(params = {}) {
  const args = [];
  if (Number.isInteger(params.reasoningBudget) && params.reasoningBudget >= -1) {
    args.push("--reasoning-budget", String(params.reasoningBudget));
  }
  args.push(params.enableDry ? "--enable-dry" : "--no-dry");
  if (params.chatTemplateFile) {
    args.push("--chat-template-file", String(params.chatTemplateFile));
  }
  if (Number.isInteger(params.mtpDraftMax) && params.mtpDraftMax >= 1) {
    args.push("--mtp-draft-max", String(params.mtpDraftMax));
  }
  // Only sent when the user picked a value; otherwise bin/qwen_llama applies its own
  // default (512) so behaviour is unchanged for anyone who never touches the field.
  if (Number.isInteger(params.ubatchSize) && params.ubatchSize >= 1) {
    args.push("--ubatch-size", String(params.ubatchSize));
  }
  return args;
}

function normalizeLaunchParamsForModel(model, params = {}) {
  const launcher = resolveCompatibleLauncher(model, params.launcher);
  const grammarSelection = normalizeGrammarSelectionForModel(model, params);
  return {
    ...params,
    launcher,
    ctxSize: normalizeLaunchContextSizeForModel(model, params),
    thinking: model?.supportsThinking ? Boolean(params.thinking) : false,
    reasoningBudget: normalizeReasoningBudgetParam(model, params),
    enableDry: supportsGgufExtras(model) ? Boolean(params.enableDry) : false,
    mtpDraftMax: normalizeMtpDraftMaxParam(model, params),
    ubatchSize: normalizeUbatchSizeParam(model, params),
    chatTemplate: normalizeChatTemplateParam(model, params),
    ...grammarSelection,
    temperature: Number.isFinite(Number(params.temperature))
      ? Number(params.temperature)
      : LAUNCH_SAMPLING_DEFAULTS.temperature,
    topP: Number.isFinite(Number(params.topP))
      ? Number(params.topP)
      : LAUNCH_SAMPLING_DEFAULTS.topP,
    topK: Number.isInteger(Number(params.topK))
      ? Number(params.topK)
      : LAUNCH_SAMPLING_DEFAULTS.topK,
    minP: Number.isFinite(Number(params.minP))
      ? Number(params.minP)
      : LAUNCH_SAMPLING_DEFAULTS.minP,
    presencePenalty: Number.isFinite(Number(params.presencePenalty))
      ? Number(params.presencePenalty)
      : LAUNCH_SAMPLING_DEFAULTS.presencePenalty,
    repetitionPenalty: Number.isFinite(Number(params.repetitionPenalty))
      ? Number(params.repetitionPenalty)
      : LAUNCH_SAMPLING_DEFAULTS.repetitionPenalty,
  };
}

function validateLaunchSamplingParams(params) {
  if (!Number.isFinite(params.temperature) || params.temperature < 0) {
    return "temperature must be a non-negative number.";
  }
  if (!Number.isFinite(params.topP) || params.topP < 0 || params.topP > 1) {
    return "topP must be between 0 and 1.";
  }
  if (!Number.isInteger(params.topK) || params.topK < 0) {
    return "topK must be a non-negative integer.";
  }
  if (!Number.isFinite(params.minP) || params.minP < 0 || params.minP > 1) {
    return "minP must be between 0 and 1.";
  }
  if (!Number.isFinite(params.presencePenalty)) {
    return "presencePenalty must be a number.";
  }
  if (!Number.isFinite(params.repetitionPenalty) || params.repetitionPenalty <= 0) {
    return "repetitionPenalty must be greater than 0.";
  }
  return "";
}

function chooseLaunchContextLength(requestedValue, liveValue) {
  const requested = Number(requestedValue || 0);
  const live = Number(liveValue || 0);
  if (Number.isInteger(requested) && requested > 0) {
    return requested;
  }
  return Number.isInteger(live) && live > 0 ? live : 0;
}

function chooseSlotContextLength(statusValue, liveValue, fallbackValue) {
  const statusCtx = Number(statusValue || 0);
  const live = Number(liveValue || 0);
  const fallback = Number(fallbackValue || 0);
  if (Number.isInteger(statusCtx) && statusCtx > 0) {
    return statusCtx;
  }
  if (Number.isInteger(fallback) && fallback > 0) {
    return fallback;
  }
  return Number.isInteger(live) && live > 0 ? live : 0;
}

function resolveDefaultsLauncher(model, launcher) {
  return resolveCompatibleLauncher(model, launcher);
}

function indexOr(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

app.get("/api/models", async (_req, res) => {
  const [models, dashboardConfig] = await Promise.all([
    getModels(),
    readDashboardConfig(),
  ]);
  res.json(applyPreferredLaunchers(models, dashboardConfig));
});

app.get("/api/launchers", async (_req, res) => {
  try {
    res.json({ launchers: await listLaunchers() });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) || "Unable to load launchers." });
  }
});

app.post("/api/launchers/:launcherKey/update", async (req, res) => {
  try {
    const launcherKey = String(req.params.launcherKey || "").trim();
    if (!getLauncherDefinition(launcherKey)) {
      res.status(404).json({ error: "Unknown launcher." });
      return;
    }
    res.json(await updateLauncher(launcherKey));
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) || "Unable to update launcher." });
  }
});

app.get("/api/status", async (_req, res) => {
  res.json(await getSlotStatuses());
});

app.get("/api/system", async (_req, res) => {
  const statuses = await getSlotStatuses();
  res.json(await getSystemStats(statuses));
});

// Is a slot mid-generation right now? llama-server is launched with --metrics, so
// `llamacpp:requests_processing` is authoritative and, unlike the traffic log, is
// true *during* a generation rather than only once the response is flushed. Runtimes
// with no metrics endpoint fall back to the traffic log's mtime.
//
// Deliberately NOT folded into /api/overview: getSlotStatus shells out to ten
// launcher scripts per slot and is polled every 5s, which is both too slow and far
// too expensive for something the spinner needs at ~1s.
// /metrics is not a passive read: server-context.cpp posts a SERVER_TASK_TYPE_METRICS
// task and blocks on it. A timeout here aborts the HTTP request, llama.cpp notices the
// closed connection and logs `stop: cancel task`. With a 400 ms budget against a slot
// mid-prompt-eval that fired every single poll -- 258 cancelled tasks in 11 minutes,
// none of which ever reached a slot, which is noise that actively misleads anyone
// reading the server log. Budget generously instead; a late answer still beats a
// cancelled one.
const SLOT_ACTIVITY_PROBE_TIMEOUT_MS = 2500;
const SLOT_ACTIVITY_TRAFFIC_WINDOW_MS = 3000;

// Reads /metrics once and returns both the busy flag and the monotonic count of
// decoded tokens. Two shapes exist: llama.cpp serves Prometheus text, mlx-dspark
// serves JSON. mlx-dspark reports no "processing" gauge at all, so its busy answer
// is unknown here and gets derived from the token delta instead.
async function probeSlotMetrics(port) {
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
      signal: AbortSignal.timeout(SLOT_ACTIVITY_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const body = await response.text();
    if (body.trimStart().startsWith("{")) {
      // mlx-dspark's JSON /metrics carries lifetime means only; its live numbers come
      // from /rounds, which probeSlotThroughput tries first.
      return null;
    }
    const busyMatch = body.match(/^llamacpp:requests_processing\s+([\d.]+)$/m);
    const decodedMatch = body.match(/^llamacpp:tokens_predicted_total\s+([\d.]+)$/m);
    const secondsMatch = body.match(/^llamacpp:tokens_predicted_seconds_total\s+([\d.]+)$/m);
    return {
      busy: busyMatch ? Number(busyMatch[1]) > 0 : null,
      decoded: decodedMatch ? Number(decodedMatch[1]) : null,
      decodeSeconds: secondsMatch ? Number(secondsMatch[1]) : null,
    };
  } catch (_error) {
    // Port closed, no metrics, or slower than the probe budget. Return unknown so the
    // traffic fallback gets a say rather than asserting a hard "idle".
    return null;
  }
}

// An mlx-dspark slot serves /metrics on its PUBLIC port; a llama.cpp slot serves it
// on the gguf backend port. Try the backend first (a closed port refuses fast), then
// the public one, so both runtimes report without knowing which is loaded.
// A live tok/s needs a windowed source, not a lifetime mean — a slot that ran fast an
// hour ago and crawls now still reports the old average. Two windowed sources exist:
//
//   mlx-dspark  /rounds  — per speculative round: tokens committed and ms taken. Updates
//                          DURING a generation, so this is a true live rate.
//   llama.cpp   /metrics — tokens_predicted_total / tokens_predicted_seconds_total, both
//                          cumulative and both exact; differencing them between polls
//                          gives the rate of whatever finished in the window. These only
//                          move when a request COMPLETES, so it reads per-turn, not
//                          intra-generation. That is the best llama.cpp offers.
//
// Do NOT difference mlx-dspark's completion_tokens instead: it also only moves at
// completion, so it reads 0 for the whole generation and then spikes to a meaningless
// value (tokens of a whole reply divided by one poll interval). Measured and rejected.
const SLOT_ROUNDS_WINDOW = 24;
const slotRoundsSamples = new Map();
const slotCounterSamples = new Map();
const SLOT_THROUGHPUT_MAX_GAP_MS = 15000;

async function probeSlotRounds(port) {
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/rounds?limit=${SLOT_ROUNDS_WINDOW}`, {
      signal: AbortSignal.timeout(SLOT_ACTIVITY_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const rounds = (await response.json())?.rounds;
    if (!Array.isArray(rounds) || !rounds.length) {
      return null;
    }
    let tokens = 0;
    let ms = 0;
    for (const round of rounds) {
      tokens += Number(round?.committed) || 0;
      ms += Number(round?.ms) || 0;
    }
    const newest = rounds[rounds.length - 1];
    return {
      seq: Number(newest?.seq) || 0,
      rate: ms > 0 ? (tokens * 1000) / ms : null,
    };
  } catch (_error) {
    return null;
  }
}

// Rounds accumulate for the life of the server, so a rate alone cannot say whether the
// model is generating NOW. A moving `seq` can: it advances only while rounds are being
// produced. An unchanged seq means the window is history, so report idle and no rate.
function readRoundsThroughput(slotId, probe) {
  const previous = slotRoundsSamples.get(slotId);
  slotRoundsSamples.set(slotId, { seq: probe.seq, at: Date.now() });
  if (!previous || previous.seq === probe.seq) {
    return { busy: false, tokensPerSecond: null, phase: null };
  }
  return { busy: true, tokensPerSecond: probe.rate, phase: "decode" };
}

// Fallback for a runtime that publishes neither /rounds nor /metrics: the traffic log
// was written recently, so something is flowing.
async function probeSlotBusyViaTrafficLog(slot) {
  const logPath = getDefaultLogs(slot, "gguf")?.traffic;
  if (!logPath) {
    return false;
  }
  try {
    const stats = await fs.stat(logPath);
    return Date.now() - stats.mtimeMs < SLOT_ACTIVITY_TRAFFIC_WINDOW_MS;
  } catch (_error) {
    return false;
  }
}

// llama.cpp's live decode counter. /metrics only moves when a request COMPLETES
// (tokens_predicted_total reads 0 for the whole generation, verified on this box), but
// /slots exposes next_token[].n_decoded for the task in flight, which ticks per token.
// n_decoded restarts at 0 for each new task, so the sample is keyed by id_task and a
// changed key starts a fresh baseline instead of reporting a negative rate.
async function probeSlotLlamaSlots(port) {
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/slots`, {
      signal: AbortSignal.timeout(SLOT_ACTIVITY_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const slots = await response.json();
    if (!Array.isArray(slots)) {
      return null;
    }
    const processing = slots.filter((entry) => entry?.is_processing);
    let decoded = 0;
    let prompt = 0;
    const keys = [];
    for (const entry of processing) {
      const next = Array.isArray(entry?.next_token) ? entry.next_token[0] : entry?.next_token;
      decoded += Number(next?.n_decoded) || 0;
      prompt += Number(entry?.n_prompt_tokens_processed) || 0;
      keys.push(String(entry?.id_task ?? ""));
    }
    return { busy: processing.length > 0, decoded, prompt, key: keys.join(",") };
  } catch (_error) {
    return null;
  }
}

// Shared by /slots (llama.cpp) and any other per-task counter: difference the decoded
// count against wall time. `key` identifies the task set; when it changes the counter
// has restarted and the old sample is meaningless.
// Returns the rate AND which phase produced it. Two things make this awkward:
//
//  1. At 255K contexts a request spends most of its life in prefill with n_decoded
//     pinned at 0, so reporting only decode leaves the readout blank for minutes.
//     Prompt-processing speed is the number the user is actually waiting on.
//  2. The counters move in CHUNKS — llama.cpp advances n_prompt_tokens_processed by a
//     whole ubatch (2048) every ~16 s. Differencing consecutive 1 s polls therefore
//     reads 0 fifteen times out of sixteen and the readout flickers. So difference
//     against the oldest sample still inside a window instead, which averages the
//     chunks into a steady rate.
// 20 s, not 8 s: llama.cpp lands a 2048-token prefill chunk roughly every 16 s, so a
// shorter window frequently spans no chunk at all and the rate blinks out. The window
// must comfortably exceed the chunk period.
const SLOT_RATE_WINDOW_MS = 20000;
const slotSampleHistory = new Map();

function readTaskCounterThroughput(slotId, key, decoded, prompt) {
  const now = Date.now();
  let history = slotSampleHistory.get(slotId) || [];
  // A new task restarts the counters, so the old samples are not comparable.
  if (history.length && history[history.length - 1].key !== key) {
    history = [];
  }
  history.push({ key, decoded, prompt, at: now });
  // Keep one sample older than the window so the span is always >= the window.
  while (history.length > 2 && now - history[1].at > SLOT_RATE_WINDOW_MS) {
    history.shift();
  }
  slotSampleHistory.set(slotId, history);

  if (history.length < 2) {
    return null;
  }
  const oldest = history[0];
  const elapsedMs = now - oldest.at;
  if (elapsedMs <= 0 || elapsedMs > SLOT_THROUGHPUT_MAX_GAP_MS * 2) {
    return null;
  }
  const deltaDecoded = decoded - oldest.decoded;
  if (deltaDecoded > 0) {
    return { phase: "decode", rate: (deltaDecoded * 1000) / elapsedMs };
  }
  const deltaPrompt = prompt - oldest.prompt;
  if (deltaPrompt > 0) {
    return { phase: "prefill", rate: (deltaPrompt * 1000) / elapsedMs };
  }
  return { phase: prompt > 0 || decoded > 0 ? "prefill" : null, rate: null };
}

async function probeSlotThroughput(slot) {
  const ports = Number(slot.publicPort) === Number(slot.ggufBackendPort)
    ? [slot.ggufBackendPort]
    : [slot.ggufBackendPort, slot.publicPort];

  for (const port of ports) {
    const rounds = await probeSlotRounds(port);
    if (rounds) {
      return { ...readRoundsThroughput(slot.id, rounds), source: "rounds" };
    }
  }
  for (const port of ports) {
    const live = await probeSlotLlamaSlots(port);
    if (live) {
      const measured = live.busy
        ? readTaskCounterThroughput(slot.id, live.key, live.decoded, live.prompt)
        : (slotSampleHistory.delete(slot.id), null);
      return {
        busy: live.busy,
        tokensPerSecond: measured && Number.isFinite(measured.rate) ? measured.rate : null,
        phase: measured ? measured.phase : null,
        source: "slots",
      };
    }
  }
  for (const port of ports) {
    const metrics = await probeSlotMetrics(port);
    if (metrics) {
      return { busy: metrics.busy, tokensPerSecond: null, source: "metrics" };
    }
  }
  slotRoundsSamples.delete(slot.id);
  slotCounterSamples.delete(slot.id);
  return null;
}

app.get("/api/slots/activity", async (_req, res) => {
  const entries = await Promise.all(
    SLOT_DEFINITIONS.map(async (slot) => {
      const probe = await probeSlotThroughput(slot);
      const busy = probe?.busy == null
        ? await probeSlotBusyViaTrafficLog(slot)
        : probe.busy;
      const rate = probe?.tokensPerSecond;
      return [slot.id, {
        busy,
        source: probe?.busy == null ? "traffic" : probe.source,
        tokensPerSecond: Number.isFinite(rate) ? Math.round(rate * 10) / 10 : null,
        phase: probe?.phase || null,
      }];
    })
  );
  res.json({ activity: Object.fromEntries(entries) });
});

app.get("/api/overview", async (_req, res) => {
  res.json(await getOverviewData());
});


// ---------------------------------------------------------------------------
// Model Chat (Diagnostics -> Chat): a real conversation against one slot, with the
// runtime numbers beside it. Proxied through llm3 rather than called from the browser
// so that (a) neither runtime needs CORS config, (b) llama.cpp and mlx-dspark response
// differences are normalised here instead of in the UI, and (c) per-turn timings are
// measured next to the socket rather than after a browser event loop hop.
//
// The wire format to the browser is llm3's own, not the runtime's:
//   {"type":"delta","content":"...","reasoning":"..."}
//   {"type":"done","stats":{...}}
//   {"type":"error","message":"..."}
const CHAT_PROXY_TIMEOUT_MS = 30 * 60 * 1000;
const activeChatStreams = new Map();

function chatDeltaFrom(payload) {
  const choice = payload?.choices?.[0] || {};
  const delta = choice.delta || choice.message || {};
  return {
    content: typeof delta.content === "string" ? delta.content : "",
    reasoning: typeof delta.reasoning_content === "string"
      ? delta.reasoning_content
      : (typeof delta.reasoning === "string" ? delta.reasoning : ""),
    finish: choice.finish_reason || null,
  };
}

app.post("/api/chat/:slotId", async (req, res) => {
  const slot = getSlotDefinition(String(req.params.slotId || ""));
  if (!slot) {
    res.status(400).json({ error: "Unknown slot." });
    return;
  }
  const status = await getSlotStatus(slot);
  if (!status?.running) {
    res.status(409).json({ error: `${slot.label} has no running model.` });
    return;
  }
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!messages || !messages.length) {
    res.status(400).json({ error: "messages is required." });
    return;
  }

  const base = `http://${API_PUBLIC_HOST}:${slot.publicPort}`;
  const liveModels = await readModelsFromEndpoint(`${base}/v1/models`).catch(() => []);
  const slotModelId = String(status?.model?.modelId || status?.model?.key || "").trim();
  // Taking liveModels[0] blindly is only safe when /v1/models advertises what is
  // loaded, which is true of llama.cpp and mlx-dspark. mlx-vlm advertises a
  // CATALOGUE of downloadable models instead, so the first entry was an
  // unrelated repo -- and sending it as `model` made the server unload the
  // running model and start downloading that repo from Hugging Face. So: a
  // single advertised model is trusted, several are trusted only when one of
  // them is the model this slot actually has loaded.
  const advertised = liveModels.map(getEndpointModelId).filter(Boolean);
  const matched = advertised.length === 1
    ? advertised[0]
    : advertised.find((id) => id === slotModelId)
      || advertised.find((id) => slotModelId && (id.endsWith(slotModelId) || slotModelId.endsWith(id)))
      || "";
  const modelId = matched || slotModelId || advertised[0] || "";

  const payload = {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: Number.isFinite(Number(req.body?.temperature)) ? Number(req.body.temperature) : 0.7,
    top_p: Number.isFinite(Number(req.body?.topP)) ? Number(req.body.topP) : 0.8,
    top_k: Number.isInteger(Number(req.body?.topK)) ? Number(req.body.topK) : 20,
    max_tokens: Number.isInteger(Number(req.body?.maxTokens)) ? Number(req.body.maxTokens) : 2048,
  };
  // Only send a thinking switch when the caller asked for one: on a template that does
  // not know the kwarg an unsolicited value is at best ignored and at worst a hard
  // render error (Qwen3.8's template rejects reasoning_effort "high" outright).
  if (req.body?.thinking === false) {
    payload.chat_template_kwargs = { enable_thinking: false };
  }
  const effort = String(req.body?.reasoningEffort || "").trim().toLowerCase();
  if (effort && effort !== "off") {
    payload.reasoning_effort = effort;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (obj) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  };

  const controller = new AbortController();
  const previous = activeChatStreams.get(slot.id);
  if (previous) {
    previous.abort();
  }
  activeChatStreams.set(slot.id, controller);
  const timeout = setTimeout(() => controller.abort(), CHAT_PROXY_TIMEOUT_MS);
  timeout.unref?.();
  req.on("close", () => controller.abort());

  const startedAt = Date.now();
  let firstTokenAt = null;
  let content = "";
  let reasoning = "";
  let usage = null;
  let nativeTimings = null;
  let finish = null;

  try {
    const upstream = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer api" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "");
      throw new Error(`${upstream.status} ${body.trim() || upstream.statusText}`.trim());
    }
    if (!upstream.body?.getReader) {
      throw new Error("Runtime did not return a readable stream.");
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const parsed = parseSseDataFrames(buffer);
      buffer = parsed.buffer;
      for (const frame of parsed.frames) {
        if (frame === "[DONE]") continue;
        let event = null;
        try {
          event = JSON.parse(frame);
        } catch (_error) {
          continue;
        }
        if (event?.usage) usage = event.usage;
        if (event?.timings) nativeTimings = { ...(nativeTimings || {}), ...event.timings };
        if (event?.x_mlx_dspark) nativeTimings = { ...(nativeTimings || {}), ...event.x_mlx_dspark };
        const piece = chatDeltaFrom(event);
        if (piece.finish) finish = piece.finish;
        if (piece.content || piece.reasoning) {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          content += piece.content;
          reasoning += piece.reasoning;
          send({ type: "delta", content: piece.content, reasoning: piece.reasoning });
        }
      }
    }

    const endedAt = Date.now();
    const ttftMs = firstTokenAt === null ? null : firstTokenAt - startedAt;
    const decodeMs = firstTokenAt === null ? null : endedAt - firstTokenAt;
    const completionTokens = Number(usage?.completion_tokens) || null;
    send({
      type: "done",
      stats: {
        model: modelId,
        finishReason: finish,
        ttftMs,
        totalMs: endedAt - startedAt,
        decodeMs,
        promptTokens: Number(usage?.prompt_tokens) || null,
        completionTokens,
        reasoningChars: reasoning.length,
        contentChars: content.length,
        // Measured across the streamed window. The runtime's own figure, where it
        // reports one, rides along in `native` and the UI prefers it.
        tokensPerSecond: completionTokens && decodeMs > 0
          ? Math.round((completionTokens / (decodeMs / 1000)) * 10) / 10
          : null,
        native: nativeTimings,
      },
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    send({
      type: aborted ? "done" : "error",
      message: aborted ? "" : (error?.message || String(error)),
      stats: aborted ? { aborted: true, totalMs: Date.now() - startedAt } : undefined,
    });
  } finally {
    clearTimeout(timeout);
    if (activeChatStreams.get(slot.id) === controller) {
      activeChatStreams.delete(slot.id);
    }
    if (!res.writableEnded) {
      res.end();
    }
  }
});

app.post("/api/chat/:slotId/stop", (req, res) => {
  const slot = getSlotDefinition(String(req.params.slotId || ""));
  const controller = slot ? activeChatStreams.get(slot.id) : null;
  if (controller) {
    controller.abort();
  }
  res.json({ ok: true, stopped: Boolean(controller) });
});

app.get("/api/hermes/status", async (_req, res) => {
  res.json(await getHermesStatusData());
});

app.get("/api/hermes/feed/:runtime", async (req, res) => {
  const runtime = String(req.params.runtime || "").trim().toLowerCase();
  if (!["local", "remote"].includes(runtime)) {
    res.status(404).json({ error: "Unknown Hermes runtime." });
    return;
  }
  res.json(await getHermesFeedData(runtime));
});

app.post("/api/benchmarks/:slotId", async (req, res) => {
  const slot = getSlotDefinition(String(req.params.slotId || ""));
  if (!slot) {
    res.status(404).json({ error: "Unknown slot." });
    return;
  }

  const current = SLOT_BENCHMARKS.get(slot.id);
  if (current?.status === "running") {
    res.status(409).json({ error: "A benchmark is already running for this slot.", benchmark: serializeSlotBenchmark(current) });
    return;
  }

  try {
    const models = await getModels();
    const status = await getSlotStatus(slot, models);
    if (!status?.running) {
      res.status(409).json({ error: `${slot.label} is idle.` });
      return;
    }
    const benchmark = startSlotBenchmark(slot, status);
    res.json({
      ok: true,
      stdout: `Started throughput benchmark for ${slot.label}.`,
      benchmark: serializeSlotBenchmark(benchmark),
    });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) || "Unable to start benchmark." });
  }
});

app.post("/api/benchmark/rapid-mlx", async (req, res) => {
  const modelKey = String(req.body.modelKey || "");
  const modelPath = String(req.body.modelPath || "");
  const maxTokens = Number(req.body.maxTokens || 8192);
  const parallel = Number(req.body.parallel || 1);
  const prefillBatchSize = Number(req.body.prefillBatchSize || 1);

  if (!modelKey && !modelPath) {
    res.status(400).json({ error: "modelKey or modelPath is required." });
    return;
  }

  try {
    let effectivePath = modelPath;
    if (!effectivePath) {
      const models = await getModels();
      const model = models.find((m) => m.key === modelKey);
      if (!model) {
        res.status(404).json({ error: `Unknown model: ${modelKey}` });
        return;
      }
      effectivePath = model.path || modelKey;
    }

    const cmdArgs = [
      "bench",
      effectivePath,
      "--max-num-seqs",
      String(parallel),
      "--prefill-batch-size",
      String(prefillBatchSize),
      "--max-tokens",
      String(maxTokens),
    ];

    const { stdout, stderr } = await execFileAsync(
      path.join(HOME, ".venvs", "rapid-mlx", "bin", "rapid-mlx"),
      cmdArgs,
      getExecOptions({ timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }),
    );

    const output = (stdout || "") + (stderr || "");
    const promptMatch = output.match(/avg prompt throughput:\s*([\d.]+)\s*tokens\/s/);
    const genMatch = output.match(/avg generation throughput:\s*([\d.]+)\s*tokens\/s/);

    res.json({
      ok: true,
      model: modelKey || effectivePath,
      promptTokensPerSecond: promptMatch ? parseFloat(promptMatch[1]) : null,
      genTokensPerSecond: genMatch ? parseFloat(genMatch[1]) : null,
      rawOutput: output,
    });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) || "Benchmark failed.", stdout: error?.stdout, stderr: error?.stderr });
  }
});

app.get("/api/hf/search", async (req, res) => {
  try {
    const query = String(req.query.query || req.query.q || "").trim();
    const sort = String(req.query.sort || "downloads").trim();
    const direction = String(req.query.direction || "desc").trim();
    const results = await searchHuggingFaceCandidates({ query, sort, direction });
    res.json({ query, sort, direction, results });
  } catch (error) {
    res.status(502).json({ error: formatExecError(error) || "Hugging Face search failed." });
  }
});

app.get("/api/hf/downloads", async (_req, res) => {
  res.json({ jobs: await readHfDownloadJobs() });
});

app.post("/api/hf/downloads/clear", async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || "").trim();
    const failedOnly = Boolean(req.body?.failedOnly);
    res.json({ ok: true, jobs: await clearHfDownloadJobs({ jobId, failedOnly }) });
  } catch (error) {
    const message = formatExecError(error) || "Unable to clear download history.";
    const status = /active download/i.test(message) ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

app.post("/api/hf/downloads/cancel", async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || "").trim();
    if (!jobId) {
      res.status(400).json({ error: "jobId is required." });
      return;
    }
    res.json({ ok: true, jobs: await cancelHfJob(jobId) });
  } catch (error) {
    const message = formatExecError(error) || "Unable to cancel job.";
    const status = /unknown download job/i.test(message) ? 404 : 400;
    res.status(status).json({ error: message });
  }
});

app.post("/api/hf/downloads", async (req, res) => {
  try {
    const candidate = normalizeDownloadCandidate(req.body?.candidate);
    if (!candidate) {
      res.status(400).json({ error: "candidate is required." });
      return;
    }
    const job = await enqueueHfDownload(candidate);
    res.json({ ok: true, job, jobs: await readHfDownloadJobs() });
  } catch (error) {
    res.status(400).json({ error: formatExecError(error) || "Unable to queue download." });
  }
});

app.post("/api/hf/conversions", async (req, res) => {
  try {
    const candidate = normalizeConversionCandidate(req.body?.candidate);
    if (!candidate) {
      res.status(400).json({ error: "candidate is required." });
      return;
    }
    const job = await enqueueHfConversion(candidate, req.body?.quantization);
    res.json({ ok: true, job, jobs: await readHfDownloadJobs() });
  } catch (error) {
    res.status(400).json({ error: formatExecError(error) || "Unable to queue conversion." });
  }
});

app.post("/api/hf/companions", async (req, res) => {
  try {
    const job = await enqueueHfCompanion(req.body || {});
    res.json({ ok: true, job, jobs: await readHfDownloadJobs() });
  } catch (error) {
    res.status(400).json({ error: formatExecError(error) || "Unable to queue companion download." });
  }
});

app.post("/api/models/delete", async (req, res) => {
  try {
    const modelKey = String(req.body?.modelKey || "").trim();
    if (!modelKey) {
      res.status(400).json({ error: "modelKey is required." });
      return;
    }
    await deleteModelByKey(modelKey);
    const overview = await getOverviewData();
    res.json({ ok: true, stdout: "Model deleted.", ...overview });
  } catch (error) {
    const message = formatExecError(error) || "Unable to delete model.";
    const status = /running/i.test(message) ? 409 : 400;
    res.status(status).json({ error: message });
  }
});

app.get("/api/logs/:slotId/:kind", async (req, res) => {
  const slot = getSlotDefinition(String(req.params.slotId || ""));
  if (!slot) {
    res.status(404).json({ error: "Unknown slot." });
    return;
  }
  const kind = req.params.kind;
  if (!["server", "traffic", "proxy", "thinking", "llm3"].includes(kind)) {
    res.status(404).json({ error: "Unknown log kind." });
    return;
  }

  const offset = Number(req.query.offset || 0);

  // llm3's own log is one file for the whole dashboard, not one per slot. The
  // route still takes a slotId so the client can poll every kind through one
  // code path; the slot is simply ignored here.
  if (kind === "llm3") {
    // Three files, merged: server.log records what llm3 did and every failure it
    // returned, while the process stdout/stderr is where a stack trace, a crash
    // or anything a dependency printed actually lands. Reading only server.log
    // showed the attempt and never the reason. Always a full tail rather than an
    // incremental chunk, because three interleaved files have no single offset.
    const merged = await readLlm3Log();
    res.json({
      slotId: slot.id,
      kind,
      filePath: merged.sources.join(", "),
      nextOffset: 0,
      reset: true,
      content: merged.content,
    });
    return;
  }

  const status = await getSlotStatus(slot);
  const sourceKind = kind === "thinking" ? "proxy" : kind;
  const filePath = status.logs?.active?.[sourceKind] || getDefaultLogs(slot, "gguf")[sourceKind] || "";
  const serverClearOffset = kind === "thinking" ? await readThinkingClearOffset(slot, filePath) : 0;
  const chunk = kind === "thinking"
    ? await readThinkingLogChunk(filePath, offset, serverClearOffset)
    : await readLogChunk(filePath, offset);
  const content = kind === "thinking" ? chunk.content : chunk.content;
  const payload = {
    slotId: slot.id,
    kind,
    filePath,
    nextOffset: chunk.nextOffset,
    reset: chunk.reset,
    content,
  };
  if (kind === "thinking") {
    payload.clearOffset = serverClearOffset;
  }

  if (kind === "traffic") {
    payload.entries = parseTrafficEntries(chunk.content);
  }

  res.json(payload);
});

app.get("/api/logs/:slotId/thinking/clear-point", async (req, res) => {
  const slot = getSlotDefinition(String(req.params.slotId || ""));
  if (!slot) {
    res.status(404).json({ error: "Unknown slot." });
    return;
  }
  const status = await getSlotStatus(slot);
  const filePath = status.logs?.active?.proxy || getDefaultLogs(slot, "gguf").proxy || "";
  const clearOffset = await getLogClearPoint(filePath);
  res.json({
    slotId: slot.id,
    kind: "thinking",
    filePath,
    clearOffset,
  });
});

app.post("/api/logs/:slotId/thinking/clear", async (req, res) => {
  const slot = getSlotDefinition(String(req.params.slotId || ""));
  if (!slot) {
    res.status(404).json({ error: "Unknown slot." });
    return;
  }
  const status = await getSlotStatus(slot);
  const filePath = status.logs?.active?.proxy || getDefaultLogs(slot, "gguf").proxy || "";
  const clearOffset = await writeThinkingClearOffset(slot, filePath, await getLogClearPoint(filePath));
  res.json({
    ok: true,
    slotId: slot.id,
    kind: "thinking",
    filePath,
    clearOffset,
  });
});

app.get("/api/logs/:slotId/thinking/download", async (req, res) => {
  const slot = getSlotDefinition(String(req.params.slotId || ""));
  if (!slot) {
    res.status(404).json({ error: "Unknown slot." });
    return;
  }
  const status = await getSlotStatus(slot);
  const filePath = status.logs?.active?.proxy || getDefaultLogs(slot, "gguf").proxy || "";
  const clearOffset = await readThinkingClearOffset(slot, filePath);
  const content = await readThinkingLogContent(filePath, clearOffset);
  const filename = `${slot.id}-thinking-log.txt`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(content || "");
});

app.get("/api/diagnostics/errors", async (_req, res) => {
  try {
    res.json(await readDiagnosticsErrors());
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) || "Unable to read diagnostics." });
  }
});

app.post("/api/start", requireIdle, async (req, res) => {

  const modelKey = String(req.body.modelKey || "");
  const slot = getSlotDefinition(String(req.body.slotId || ""));
  const {
    ctxSize,
    parallel,
    thinking,
    reasoningBudget,
    enableDry,
    mtpDraftMax,
    ubatchSize,
    dsparkMode,
    reasoningEffort,
    enableTinyGrammar,
    enableStructuredGbnf,
    chatTemplate,
    launcher,
    temperature,
    topP,
    topK,
    minP,
    presencePenalty,
    repetitionPenalty,
  } = parseLauncherRequestBody(req.body);
  const requestedApplicationTargets = requestedApplicationTargetsFromPayload(req.body);

  if (!slot) {
    res.status(400).json({ error: "slotId is required." });
    return;
  }
  if (!modelKey) {
    res.status(400).json({ error: "modelKey is required." });
    return;
  }
  if (!Number.isInteger(ctxSize) || ctxSize <= 0) {
    res.status(400).json({ error: "ctxSize must be a positive integer." });
    return;
  }
  if (!Number.isInteger(parallel) || parallel <= 0) {
    res.status(400).json({ error: "parallel must be a positive integer." });
    return;
  }
  const samplingError = validateLaunchSamplingParams({
    temperature,
    topP,
    topK,
    minP,
    presencePenalty,
    repetitionPenalty,
  });
  if (samplingError) {
    res.status(400).json({ error: samplingError });
    return;
  }

  beginExclusiveAction();
  try {
    const models = await getModels();
    const model = models.find((entry) => entry.key === modelKey);
    if (!model) {
      res.status(404).json({ error: `Unknown model: ${modelKey}` });
      return;
    }
    const launchParams = normalizeLaunchParamsForModel(model, {
      ctxSize,
      parallel,
      thinking,
      reasoningBudget,
      enableDry,
      mtpDraftMax,
      ubatchSize,
      dsparkMode,
      reasoningEffort,
      enableTinyGrammar,
      enableStructuredGbnf,
      chatTemplate,
      launcher,
      temperature,
      topP,
      topK,
      minP,
      presencePenalty,
      repetitionPenalty,
    });
    // Downloads the template on first use; a failure here must not be silent,
    // because llama.cpp would otherwise quietly fall back to the embedded one.
    launchParams.chatTemplateFile = await resolveChatTemplateForLaunch(launchParams);
    const { stdout, integrationSync, syncErrors } = await startConfiguredModel(
      slot,
      model,
      launchParams,
      requestedApplicationTargets
    );
    const overview = await getOverviewData();
    res.json({
      ok: true,
      stdout,
      integration_sync: integrationSync,
      sync_errors: syncErrors,
      hermes_sync: integrationSync.hermes,
      openclaude_sync: integrationSync.openclaude,
      claude_sync: integrationSync.openclaude,
      chat_sync: integrationSync.chat,
      hermesm4_sync: integrationSync.hermesm4,
      compaction_sync: integrationSync.compaction,
      voiceapp_sync: integrationSync.voiceapp,
      podcastg_sync: integrationSync.podcastg,
      ...overview,
    });
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      error: formatExecError(error),
      stdout: error?.stdout,
      integration_sync: error?.integrationSync,
      hermes_sync: error?.integrationSync?.hermes,
      openclaude_sync: error?.integrationSync?.openclaude,
      claude_sync: error?.integrationSync?.openclaude,
      chat_sync: error?.integrationSync?.chat,
      hermesm4_sync: error?.integrationSync?.hermesm4,
      compaction_sync: error?.integrationSync?.compaction,
      voiceapp_sync: error?.integrationSync?.voiceapp,
      podcastg_sync: error?.integrationSync?.podcastg,
    });
  } finally {
    finishExclusiveAction();
  }
});

app.post("/api/defaults", requireIdle, async (req, res) => {

  const modelKey = String(req.body.modelKey || "");
  const slot = getSlotDefinition(String(req.body.slotId || ""));
  const {
    ctxSize,
    parallel,
    thinking,
    reasoningBudget,
    enableDry,
    mtpDraftMax,
    ubatchSize,
    dsparkMode,
    reasoningEffort,
    enableTinyGrammar,
    enableStructuredGbnf,
    chatTemplate,
    launcher,
    temperature,
    topP,
    topK,
    minP,
    presencePenalty,
    repetitionPenalty,
  } = parseLauncherRequestBody(req.body);

  if (!slot) {
    res.status(400).json({ error: "slotId is required." });
    return;
  }
  if (!modelKey) {
    res.status(400).json({ error: "modelKey is required." });
    return;
  }
  if (!Number.isInteger(ctxSize) || ctxSize <= 0) {
    res.status(400).json({ error: "ctxSize must be a positive integer." });
    return;
  }
  if (!Number.isInteger(parallel) || parallel <= 0) {
    res.status(400).json({ error: "parallel must be a positive integer." });
    return;
  }
  const samplingError = validateLaunchSamplingParams({
    temperature,
    topP,
    topK,
    minP,
    presencePenalty,
    repetitionPenalty,
  });
  if (samplingError) {
    res.status(400).json({ error: samplingError });
    return;
  }

  beginExclusiveAction();
  try {
    const models = await getModels();
    const model = models.find((entry) => entry.key === modelKey);
    if (!model) {
      res.status(404).json({ error: `Unknown model: ${modelKey}` });
      return;
    }

    const stdout = await setLauncherDefaults(
      slot,
      model,
      normalizeLaunchParamsForModel(model, {
        ctxSize,
        parallel,
        thinking,
        reasoningBudget,
        enableDry,
        mtpDraftMax,
        ubatchSize,
        dsparkMode,
        reasoningEffort,
        enableTinyGrammar,
        enableStructuredGbnf,
        chatTemplate,
        launcher,
        temperature,
        topP,
        topK,
        minP,
        presencePenalty,
        repetitionPenalty,
      })
    );
    const selectedLauncher = resolveDefaultsLauncher(model, launcher);
    await updateDashboardConfig((dashboardConfig) => {
      // Saving is what pins the template: without an entry here an eligible model
      // keeps following the catalog's preferred choice.
      const chatTemplates = { ...(dashboardConfig.chatTemplates || {}) };
      if (getChatTemplateOptionsForModel(model).length) {
        chatTemplates[model.key] = normalizeChatTemplateParam(model, { chatTemplate });
      }
      return {
        ...dashboardConfig,
        chatTemplates,
        preferredLaunchers: {
          ...(dashboardConfig.preferredLaunchers || {}),
          [model.key]: selectedLauncher,
        },
      };
    });
    const overview = await getOverviewData();
    res.json({ ok: true, stdout, ...overview });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) });
  } finally {
    finishExclusiveAction();
  }
});

// Persist a "soft" application-target preference without touching live routing.
// scope "model": remembered per model (gear-icon Save), used to pre-fill checkboxes
// whenever that model launches. scope "slot": remembered per slot (slot-dropdown Save),
// and mirrored into the active profile's slot config when one exists. Live routing
// (~/.claude/settings.json etc.) is only rewritten on Launch/Apply, never here.
app.post("/api/application-prefs", async (req, res) => {
  const scope = String(req.body?.scope || "").trim();
  if (scope !== "model" && scope !== "slot") {
    res.status(400).json({ error: "scope must be \"model\" or \"slot\"." });
    return;
  }
  const flags = normalizeApplicationFlagSet(req.body?.applicationTargets);

  try {
    if (scope === "model") {
      const modelKey = String(req.body?.modelKey || "").trim();
      if (!modelKey) {
        res.status(400).json({ error: "modelKey is required." });
        return;
      }
      await updateDashboardConfig((config) => ({
        ...config,
        modelApplicationPreferences: {
          ...(config.modelApplicationPreferences || {}),
          [modelKey]: flags,
        },
      }));
    } else {
      const slotId = String(req.body?.slotId || "").trim();
      if (!getSlotDefinition(slotId)) {
        res.status(400).json({ error: "slotId is required." });
        return;
      }
      await updateDashboardConfig((config) => {
        const activeProfileId = String(config.activeProfileId || "").trim();
        const profiles = activeProfileId
          ? config.profiles.map((profile) => {
            if (profile.id !== activeProfileId) {
              return profile;
            }
            return {
              ...profile,
              slots: {
                ...profile.slots,
                [slotId]: {
                  ...(profile.slots?.[slotId] || {}),
                  ...applicationFlagSetToProfileSlotFields(flags),
                },
              },
            };
          })
          : config.profiles;
        return {
          ...config,
          slotApplicationPreferences: {
            ...(config.slotApplicationPreferences || {}),
            [slotId]: flags,
          },
          profiles,
        };
      });
    }
    const overview = await getOverviewData();
    res.json({ ok: true, ...overview });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) });
  }
});

app.post("/api/hermes/restart", requireIdle, async (_req, res) => {

  beginExclusiveAction();
  try {
    const hermesRestart = await restartHermesService();
    if (hermesRestart.ok === false) {
      res.status(502).json({ error: hermesRestart.error, hermes_restart: hermesRestart });
      return;
    }

    const summary =
      hermesRestart.service_state
        ? `Hermes gateway restarted (${hermesRestart.service_state}).`
        : "Hermes gateway restarted.";
    const overview = await getOverviewData();
    res.json({
      ok: true,
      stdout: summary,
      hermes_restart: hermesRestart,
      ...overview,
    });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) });
  } finally {
    finishExclusiveAction();
  }
});

app.post("/api/llm3/restart", async (_req, res) => {
  try {
    res.json({
      ok: true,
      stdout: "Restarting llm3...",
    });

    setTimeout(() => {
      const child = spawn("pm2", ["restart", "llm3"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }, 150);
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) || "Failed to restart llm3." });
  }
});

// ========== Voice API Endpoints ==========

function serializeVoiceCatalogModel(model) {
  return {
    key: model.key,
    label: model.label,
    type: model.type,
    runtime: model.runtime,
    quality: model.quality,
    sizeLabel: model.sizeLabel,
    latency: model.latency,
    languages: Array.isArray(model.languages) ? model.languages : [],
    voices: Array.isArray(model.voices) ? model.voices : [],
  };
}

async function getVoiceCatalogResponse(modelKey = "") {
  const requestedModelKey = String(modelKey || "").trim();
  const models = (await getVoiceModels()).filter((model) => model.type === "tts");
  const selectedModels = requestedModelKey
    ? models.filter((model) => model.key === requestedModelKey)
    : models;
  return {
    requestedModelKey,
    models: selectedModels.map(serializeVoiceCatalogModel),
  };
}

async function sendVoiceStartResponse(req, res, options = {}) {
  if (actionInFlight) {
    res.status(409).json({ error: "Another action is already running." });
    return;
  }

  const requireTts = Boolean(options.requireTts);
  const modelKey = String(req.body?.modelKey || "");
  const voiceSlot = String(req.body?.voiceSlotId || "");
  const setHermes = Boolean(req.body?.setHermes);
  const setHermesM4 = Boolean(req.body?.setHermesM4);

  if (!voiceSlot) {
    res.status(400).json({ error: "voiceSlotId is required." });
    return;
  }
  if (!modelKey) {
    res.status(400).json({ error: "modelKey is required." });
    return;
  }

  const vSlot = VOICE_SLOT_DEFINITIONS.find((s) => s.id === voiceSlot);
  if (!vSlot) {
    res.status(400).json({ error: `Unknown voice slot: ${voiceSlot}` });
    return;
  }
  if (requireTts && vSlot.type !== "tts") {
    res.status(400).json({ error: `${voiceSlot} is not a TTS slot.` });
    return;
  }

  beginExclusiveAction();
  try {
    const voiceModels = await getVoiceModels();
    const voiceModel = voiceModels.find((m) => m.key === modelKey);
    if (!voiceModel) {
      res.status(404).json({ error: `Unknown voice model: ${modelKey}` });
      return;
    }
    if (requireTts && voiceModel.type !== "tts") {
      res.status(400).json({ error: `${modelKey} is not a TTS model.` });
      return;
    }

    if (voiceModel.type !== vSlot.type) {
      res.status(400).json({ error: `${modelKey} is ${voiceModel.type} but slot ${vSlot.id} is ${vSlot.type}` });
      return;
    }

    const profileVoiceConfig = await readActiveProfileVoiceSlotConfig(vSlot.id);
    const resolvedVoiceParams = resolveVoiceRuntimeParams(vSlot, voiceModel, req.body || {}, profileVoiceConfig);
    const stdout = await startVoiceModel(vSlot, voiceModel, resolvedVoiceParams);
    const dashboardConfig = await persistActiveProfileVoiceSelection(vSlot, voiceModel, resolvedVoiceParams);
    const proposedAppTargets = { ...dashboardConfig.applicationTargets };

    const integrationSync = {
      tts: {},
      stt: {},
      hermesm4: {},
    };

    if (setHermes) {
      const syncTarget = await buildVoiceSyncTarget(vSlot, voiceModel, resolvedVoiceParams);
      if (vSlot.type === "tts") {
        integrationSync.tts = await syncHermesTTSAfterLaunch(syncTarget);
        proposedAppTargets.voicetts = vSlot.id;
      } else {
        integrationSync.stt = await syncHermesSTTAfterLaunch(syncTarget);
        proposedAppTargets.voicestt = vSlot.id;
      }
    }

    if (setHermesM4) {
      const syncTarget = await buildVoiceSyncTarget(vSlot, voiceModel, resolvedVoiceParams);
      integrationSync.hermesm4 = await syncHermesM4VoiceAfterLaunch(syncTarget);
      proposedAppTargets[vSlot.type === "tts" ? "voicetts" : "voicestt"] = vSlot.id;
    }

    const syncErrors = [
      integrationSync.tts.ok === false ? `TTS Hermes sync failed: ${integrationSync.tts.error}` : "",
      integrationSync.stt.ok === false ? `STT Hermes sync failed: ${integrationSync.stt.error}` : "",
      integrationSync.hermesm4.ok === false ? `Hermes M4 voice sync failed: ${integrationSync.hermesm4.error}` : "",
    ].filter(Boolean);

    if (syncErrors.length > 0) {
      res.status(502).json({ error: syncErrors.join(" "), stdout, integration_sync: integrationSync });
      return;
    }

    if (JSON.stringify(dashboardConfig.applicationTargets) !== JSON.stringify(proposedAppTargets)) {
      await writeDashboardConfig({ ...dashboardConfig, applicationTargets: proposedAppTargets });
    }

    const overview = await getOverviewData();
    res.json({ ok: true, stdout, integration_sync: integrationSync, ...overview });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) });
  } finally {
    finishExclusiveAction();
  }
}

app.get("/api/voice/models", async (_req, res) => {
  res.json(await getVoiceModels());
});

app.get("/api/voice/voices", async (req, res) => {
  const catalog = await getVoiceCatalogResponse(req.query?.modelKey);
  if (catalog.requestedModelKey && !catalog.models.length) {
    res.status(404).json({ error: `Unknown TTS model: ${catalog.requestedModelKey}` });
    return;
  }
  res.json({ models: catalog.models });
});

app.get("/api/voice/tts/voices", async (req, res) => {
  const catalog = await getVoiceCatalogResponse(req.query?.modelKey);
  if (catalog.requestedModelKey && !catalog.models.length) {
    res.status(404).json({ error: `Unknown TTS model: ${catalog.requestedModelKey}` });
    return;
  }
  res.json({ models: catalog.models });
});

app.get("/api/voice/chatterbox/voices", async (req, res) => {
  try {
    const model = await getManagedChatterboxModel(req.query?.modelKey);
    const catalog = await listManagedChatterboxVoices(model.path, model.runtime);
    res.json({
      modelKey: model.key,
      modelLabel: model.label,
      defaultVoice: catalog.defaultVoice,
      voices: catalog.voices,
    });
  } catch (error) {
    res.status(400).json({ error: formatExecError(error) });
  }
});

app.get("/api/voice/chatterbox/voices/audio", async (req, res) => {
  const rawModelKey = String(req.query?.modelKey || "").trim();
  const rawVoiceName = String(req.query?.voiceName || "").trim();
  try {
    const model = await getManagedChatterboxModel(rawModelKey);
    const voiceName = normalizeManagedVoiceName(rawVoiceName);
    appendServerLogLine(`voice-preview request modelKey=${rawModelKey || "(empty)"} voiceName=${rawVoiceName || "(empty)"} normalizedVoice=${voiceName || "(empty)"}`);
    if (!voiceName) {
      appendServerLogLine("voice-preview rejected: missing voiceName");
      res.status(400).json({ error: "voiceName is required." });
      return;
    }
    const catalog = await listManagedChatterboxVoices(model.path, model.runtime);
    const voice = catalog.voices.find((entry) => entry.name === voiceName);
    if (!voice) {
      appendServerLogLine(`voice-preview missing voice: model=${model.key} available=${catalog.voices.map((entry) => entry.name).join(",")}`);
      res.status(404).json({ error: `Voice '${voiceName}' does not exist.` });
      return;
    }
    if (voice.builtin || !voice.prompt_path) {
      appendServerLogLine(`voice-preview unavailable clip: model=${model.key} voice=${voiceName} builtin=${voice.builtin} promptPath=${String(voice.prompt_path || "") || "(empty)"}`);
      res.status(400).json({ error: `Voice '${voiceName}' does not have a preview clip.` });
      return;
    }
    const resolvedPath = path.resolve(String(voice.prompt_path || ""));
    const modelRoot = path.resolve(model.path);
    if (!isPathWithin(modelRoot, resolvedPath)) {
      appendServerLogLine(`voice-preview rejected path: model=${model.key} voice=${voiceName} resolvedPath=${resolvedPath} modelRoot=${modelRoot}`);
      res.status(400).json({ error: `Voice '${voiceName}' is not managed by llm3.` });
      return;
    }
    const stats = await fs.stat(resolvedPath).catch(() => null);
    if (!stats?.isFile()) {
      appendServerLogLine(`voice-preview missing file: model=${model.key} voice=${voiceName} resolvedPath=${resolvedPath}`);
      res.status(404).json({ error: `Voice '${voiceName}' preview clip is missing.` });
      return;
    }
    appendServerLogLine(`voice-preview success: model=${model.key} voice=${voiceName} resolvedPath=${resolvedPath} bytes=${stats.size}`);
    res.type("audio/wav");
    res.sendFile(resolvedPath, { dotfiles: "allow" }, (error) => {
      if (error) {
        appendServerLogLine(`voice-preview sendFile error: model=${model.key} voice=${voiceName} status=${error.status || ""} detail=${error.message || "unknown sendFile error"}`);
        if (!res.headersSent) {
          res.status(error.statusCode || error.status || 500).json({ error: error.message || "Unable to stream voice preview." });
        }
      } else {
        appendServerLogLine(`voice-preview sendFile complete: model=${model.key} voice=${voiceName}`);
      }
    });
  } catch (error) {
    appendServerLogLine(`voice-preview error: modelKey=${rawModelKey || "(empty)"} voiceName=${rawVoiceName || "(empty)"} detail=${formatExecError(error) || "unknown error"}`);
    res.status(400).json({ error: formatExecError(error) });
  }
});

app.post("/api/voice/chatterbox/voices", express.json({ limit: "25mb" }), async (req, res) => {
  try {
    const model = await getManagedChatterboxModel(req.body?.modelKey);
    const voiceName = String(req.body?.voiceName || req.body?.name || "").trim();
    const audioBuffer = decodeBase64AudioPayload(req.body?.audioBase64 || req.body?.audio);
    if (!voiceName) {
      res.status(400).json({ error: "voiceName is required." });
      return;
    }
    if (!audioBuffer.length) {
      res.status(400).json({ error: "audioBase64 is required." });
      return;
    }
    if (!looksLikeWavBuffer(audioBuffer)) {
      res.status(400).json({ error: "Uploaded file must be a WAV clip." });
      return;
    }
    const catalog = await saveManagedChatterboxVoice(
      model,
      voiceName,
      audioBuffer,
      String(req.body?.fileName || "").trim()
    );
    res.json({
      ok: true,
      modelKey: model.key,
      defaultVoice: catalog.defaultVoice,
      voices: catalog.voices,
    });
  } catch (error) {
    res.status(400).json({ error: formatExecError(error) });
  }
});

app.post("/api/voice/chatterbox/voices/delete", async (req, res) => {
  try {
    const model = await getManagedChatterboxModel(req.body?.modelKey);
    const voiceName = String(req.body?.voiceName || "").trim();
    if (!voiceName) {
      res.status(400).json({ error: "voiceName is required." });
      return;
    }
    const catalog = await deleteManagedChatterboxVoice(model, voiceName);
    res.json({
      ok: true,
      modelKey: model.key,
      defaultVoice: catalog.defaultVoice,
      voices: catalog.voices,
    });
  } catch (error) {
    res.status(400).json({ error: formatExecError(error) });
  }
});

app.get("/api/voice/f5/voices", async (req, res) => {
  try {
    const model = await getManagedF5Model(req.query?.modelKey);
    const catalog = await listManagedF5Voices(model.path);
    res.json({
      modelKey: model.key,
      modelLabel: model.label,
      defaultVoice: catalog.defaultVoice,
      voices: catalog.voices,
    });
  } catch (error) {
    res.status(400).json({ error: formatExecError(error) });
  }
});

app.get("/api/voice/f5/voices/audio", async (req, res) => {
  const rawModelKey = String(req.query?.modelKey || "").trim();
  const rawVoiceName = String(req.query?.voiceName || "").trim();
  try {
    const model = await getManagedF5Model(rawModelKey);
    const voiceName = normalizeManagedVoiceName(rawVoiceName);
    if (!voiceName) {
      res.status(400).json({ error: "voiceName is required." });
      return;
    }
    const catalog = await listManagedF5Voices(model.path);
    const voice = catalog.voices.find((entry) => entry.name === voiceName);
    if (!voice) {
      res.status(404).json({ error: `Voice '${voiceName}' does not exist.` });
      return;
    }
    if (!voice.prompt_path) {
      res.status(400).json({ error: `Voice '${voiceName}' does not have a preview clip.` });
      return;
    }
    const resolvedPath = path.resolve(String(voice.prompt_path || ""));
    const modelRoot = path.resolve(model.path);
    if (!isPathWithin(modelRoot, resolvedPath)) {
      res.status(400).json({ error: `Voice '${voiceName}' is not managed by llm3.` });
      return;
    }
    const stats = await fs.stat(resolvedPath).catch(() => null);
    if (!stats?.isFile()) {
      res.status(404).json({ error: `Voice '${voiceName}' preview clip is missing.` });
      return;
    }
    res.type("audio/wav");
    res.sendFile(resolvedPath, { dotfiles: "allow" }, (error) => {
      if (error && !res.headersSent) {
        res.status(error.statusCode || error.status || 500).json({ error: error.message || "Unable to stream voice preview." });
      }
    });
  } catch (error) {
    res.status(400).json({ error: formatExecError(error) });
  }
});

app.post("/api/voice/f5/voices", express.json({ limit: "25mb" }), async (req, res) => {
  try {
    const model = await getManagedF5Model(req.body?.modelKey);
    const voiceName = String(req.body?.voiceName || req.body?.name || "").trim();
    const referenceText = String(req.body?.referenceText || req.body?.refText || "").trim();
    const audioBuffer = decodeBase64AudioPayload(req.body?.audioBase64 || req.body?.audio);
    if (!voiceName) {
      res.status(400).json({ error: "voiceName is required." });
      return;
    }
    if (!referenceText) {
      res.status(400).json({ error: "referenceText is required." });
      return;
    }
    if (!audioBuffer.length) {
      res.status(400).json({ error: "audioBase64 is required." });
      return;
    }
    if (!looksLikeWavBuffer(audioBuffer)) {
      res.status(400).json({ error: "Uploaded file must be a WAV clip." });
      return;
    }
    const catalog = await saveManagedF5Voice(
      model,
      voiceName,
      audioBuffer,
      referenceText,
      String(req.body?.fileName || "").trim()
    );
    res.json({
      ok: true,
      modelKey: model.key,
      defaultVoice: catalog.defaultVoice,
      voices: catalog.voices,
    });
  } catch (error) {
    res.status(400).json({ error: formatExecError(error) });
  }
});

app.post("/api/voice/f5/voices/delete", async (req, res) => {
  try {
    const model = await getManagedF5Model(req.body?.modelKey);
    const voiceName = String(req.body?.voiceName || "").trim();
    if (!voiceName) {
      res.status(400).json({ error: "voiceName is required." });
      return;
    }
    const catalog = await deleteManagedF5Voice(model, voiceName);
    res.json({
      ok: true,
      modelKey: model.key,
      defaultVoice: catalog.defaultVoice,
      voices: catalog.voices,
    });
  } catch (error) {
    res.status(400).json({ error: formatExecError(error) });
  }
});

app.get("/api/voice/status", async (_req, res) => {
  res.json(await getVoiceSlotStatuses());
});

app.get("/api/voice/health/:voiceSlotId", async (req, res) => {
  const voiceSlotId = String(req.params?.voiceSlotId || "").trim();
  const vSlot = VOICE_SLOT_DEFINITIONS.find((slot) => slot.id === voiceSlotId);
  if (!vSlot) {
    res.status(400).json({ error: `Unknown voice slot: ${voiceSlotId}` });
    return;
  }

  const runtimeUrl = `http://127.0.0.1:${vSlot.publicPort}/health`;
  try {
    const upstream = await fetch(runtimeUrl, { method: "GET", signal: AbortSignal.timeout(VOICE_RUNTIME_PROBE_TIMEOUT_MS) });
    const payload = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
    res.status(upstream.status);
    res.set("content-type", contentType);
    res.send(payload);
  } catch (error) {
    res.status(502).json({ error: formatExecError(error) || `Voice health check failed for ${voiceSlotId}` });
  }
});

app.post("/api/voice/synthesize", async (req, res) => {
  const voiceSlotId = String(req.body?.voiceSlotId || "").trim();
  const text = String(req.body?.text || "");
  const voiceName = String(req.body?.voiceName || "");
  const audioFormat = String(req.body?.audioFormat || "wav").trim() || "wav";
  const sampleRate = Number(req.body?.sampleRate || 0);

  if (!voiceSlotId) {
    res.status(400).json({ error: "voiceSlotId is required." });
    return;
  }
  if (!text.trim()) {
    res.status(400).json({ error: "text is required." });
    return;
  }

  const vSlot = VOICE_SLOT_DEFINITIONS.find((slot) => slot.id === voiceSlotId);
  if (!vSlot) {
    res.status(400).json({ error: `Unknown voice slot: ${voiceSlotId}` });
    return;
  }
  if (vSlot.type !== "tts") {
    res.status(400).json({ error: `${voiceSlotId} is not a TTS slot.` });
    return;
  }

  const runtimeUrl = `http://127.0.0.1:${vSlot.publicPort}/tts`;
  const runtimeModelKey = vSlot.status?.model?.key || "";
  try {
    let managedVoicePayload = {};
    if (runtimeModelKey) {
      const runtimeModels = await getVoiceModels();
      const runtimeModel = runtimeModels.find((entry) => entry.key === runtimeModelKey) || null;
      if (isManagedF5Runtime(runtimeModel?.runtime)) {
        managedVoicePayload = await resolveManagedF5VoiceRequestPayload(runtimeModel, voiceName);
      }
    }
    const upstream = await fetch(runtimeUrl, {
      method: "POST",
      signal: AbortSignal.timeout(VOICE_RUNTIME_SYNTH_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice: voiceName,
        format: audioFormat,
        sample_rate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : undefined,
        ...managedVoicePayload,
        ...buildVoiceTtsRuntimePayload(runtimeModelKey, req.body || {}),
      }),
    });
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const body = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.set("content-type", contentType);
    res.send(body);
  } catch (error) {
    res.status(502).json({ error: formatExecError(error) || `Voice synthesis failed for ${voiceSlotId}` });
  }
});

app.get("/api/voice/benchmark", async (_req, res) => {
  let state = await readVoiceBenchmarkState();
  if (state && ["queued", "running", "restoring"].includes(String(state.status || "")) && !voiceBenchmarkTaskPromise) {
    state = await writeVoiceBenchmarkState({
      ...state,
      status: "error",
      finishedAt: new Date().toISOString(),
      currentStage: "error",
      currentStageDetail: "The llm3 server restarted while this benchmark was running. Partial results were preserved.",
      error: "The llm3 server restarted while this benchmark was running.",
    });
  }
  res.json(decorateVoiceBenchmarkState(state));
});

app.get("/api/voice/benchmark/audio/:runId/:fileName", async (req, res) => {
  // Express decodes the params, so a runId of "..%2F..%2Fetc" would otherwise
  // walk out of the runs directory. Reduce both to single path segments and
  // confirm the result stays under the runs root.
  const runId = path.basename(String(req.params?.runId || "").trim());
  const fileName = path.basename(String(req.params?.fileName || "").trim());
  if (!runId || !fileName || runId === "." || runId === ".." || fileName === "." || fileName === "..") {
    res.status(400).json({ error: "runId and fileName are required." });
    return;
  }
  const filePath = path.join(VOICE_BENCHMARK_RUNS_DIR, runId, fileName);
  if (!isPathWithin(VOICE_BENCHMARK_RUNS_DIR, filePath)) {
    res.status(400).json({ error: "Invalid benchmark audio path." });
    return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error("not-file");
    }
    const ext = path.extname(fileName).toLowerCase();
    const mime = ({
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
    })[ext] || "application/octet-stream";
    const payload = await fs.readFile(filePath);
    res.set("content-type", mime);
    res.set("cache-control", "no-store");
    res.send(payload);
  } catch (_error) {
    res.status(404).json({ error: "Benchmark audio not found." });
  }
});

app.post("/api/voice/benchmark/start", async (req, res) => {
  const text = String(req.body?.text || "");
  const voiceSlotId = String(req.body?.voiceSlotId || "").trim();
  const audioFormat = String(req.body?.audioFormat || "wav").trim().toLowerCase() || "wav";
  const sampleRate = Number(req.body?.sampleRate || 0);
  // Queue entries let one model run several times with different voices.
  const queue = Array.isArray(req.body?.queue)
    ? req.body.queue
      .map((entry) => ({
        modelKey: String(entry?.modelKey || "").trim(),
        voiceName: String(entry?.voiceName || "").trim(),
      }))
      .filter((entry) => entry.modelKey)
    : [];
  const selectedModelKeys = queue.length
    ? queue.map((entry) => entry.modelKey)
    : (Array.isArray(req.body?.selectedModelKeys)
      ? req.body.selectedModelKeys.map((entry) => String(entry || "").trim()).filter(Boolean)
      : []);
  const selectedVoices = req.body?.selectedVoices && typeof req.body.selectedVoices === "object" && !Array.isArray(req.body.selectedVoices)
    ? Object.fromEntries(
      Object.entries(req.body.selectedVoices)
        .map(([modelKey, voiceName]) => [String(modelKey || "").trim(), String(voiceName || "").trim()])
        .filter(([modelKey, voiceName]) => modelKey && voiceName)
    )
    : {};
  const selectedTunings = normalizeVoiceBenchmarkSelectedTunings(req.body?.selectedTunings);

  if (!text.trim()) {
    res.status(400).json({ error: "text is required." });
    return;
  }
  if (!voiceSlotId) {
    res.status(400).json({ error: "voiceSlotId is required." });
    return;
  }
  if (!selectedModelKeys.length) {
    res.status(400).json({ error: "selectedModelKeys is required." });
    return;
  }
  if (!["wav", "mp3", "ogg"].includes(audioFormat)) {
    res.status(400).json({ error: "audioFormat must be wav, mp3, or ogg." });
    return;
  }
  if (voiceBenchmarkTaskPromise) {
    res.status(409).json({ error: "A voice benchmark is already running." });
    return;
  }

  const slot = VOICE_SLOT_DEFINITIONS.find((entry) => entry.id === voiceSlotId);
  if (!slot || slot.type !== "tts") {
    res.status(400).json({ error: `Unknown TTS slot: ${voiceSlotId}` });
    return;
  }

  const previous = await readVoiceBenchmarkState();
  if (previous?.runId) {
    await clearVoiceBenchmarkAudioArtifacts(previous.results, previous.runId);
    await fs.rm(path.join(VOICE_BENCHMARK_RUNS_DIR, previous.runId), { recursive: true, force: true }).catch(() => {});
  }

  const runState = await writeVoiceBenchmarkState({
    runId: randomUUID().slice(0, 8),
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: "",
    text,
    textDirection: detectTextDirection(text),
    voiceSlotId,
    slotId: voiceSlotId,
    audioFormat,
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000,
    selectedModelKeys,
    queue,
    selectedVoices,
    selectedTunings,
    cancelRequested: false,
    completedCount: 0,
    totalCount: selectedModelKeys.length,
    currentModelKey: "",
    currentModelLabel: "",
    currentStage: "queued",
    currentStageDetail: `Queued ${selectedModelKeys.length} TTS model${selectedModelKeys.length === 1 ? "" : "s"} for benchmarking.`,
    restorationNote: "",
    results: [],
  });

  clearOverviewCache();
  voiceBenchmarkTaskPromise = runVoiceBenchmarkJob(runState)
    .catch(async (error) => {
      await updateVoiceBenchmarkState((current) => ({
        ...current,
        status: "error",
        finishedAt: new Date().toISOString(),
        currentStage: "error",
        currentStageDetail: error.message || "Voice benchmark failed.",
        error: error.message || "Voice benchmark failed.",
      }));
    })
    .finally(() => {
      voiceBenchmarkTaskPromise = null;
    });

  res.json(decorateVoiceBenchmarkState(runState));
});

app.post("/api/voice/benchmark/cancel", async (_req, res) => {
  const state = await readVoiceBenchmarkState();
  if (!state || !(state.status === "queued" || state.status === "running" || state.status === "restoring")) {
    res.status(409).json({ error: "No voice benchmark is currently running." });
    return;
  }
  const next = await updateVoiceBenchmarkState((current) => ({
    ...current,
    cancelRequested: true,
    currentStageDetail: "Cancellation requested. The current step will finish, then llm3 will restore the previous TTS runtime.",
  }));
  res.json(decorateVoiceBenchmarkState(next));
});

app.post("/api/voice/start", async (req, res) => {
  return sendVoiceStartResponse(req, res);
});

app.post("/api/voice/tts/start", async (req, res) => {
  return sendVoiceStartResponse(req, res, { requireTts: true });
});

app.post("/api/voice/stop", requireIdle, async (req, res) => {

  const requestedVoiceSlot = String(req.body?.voiceSlotId || "").trim();
  const targetSlots = requestedVoiceSlot
    ? [VOICE_SLOT_DEFINITIONS.find((s) => s.id === requestedVoiceSlot)].filter(Boolean)
    : VOICE_SLOT_DEFINITIONS;

  beginExclusiveAction();
  try {
    const output = [];
    for (const vSlot of targetSlots) {
      output.push(await safeStopVoice(Voice_TTS_LAUNCHER, vSlot));
      output.push(await safeStopVoice(Voice_STT_LAUNCHER, vSlot));
      // Disable STT/TTS in hermes-agent config when stopping
      if (vSlot) {
        if (vSlot.type === "stt") {
          await syncHermesM4VoiceAfterStop({ type: "stt" });
        } else {
          await syncHermesM4VoiceAfterStop({ type: "tts" });
        }
      }
    }
    const overview = await getOverviewData();
    res.json({ ok: true, stdout: output.filter(Boolean).join("\n").trim(), ...overview });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) });
  } finally {
    finishExclusiveAction();
  }
});

app.post("/api/voice/defaults", requireIdle, async (req, res) => {

  const modelKey = String(req.body?.modelKey || "");
  const voiceSlotId = String(req.body?.voiceSlotId || "");
  const voiceName = String(req.body?.voiceName || "");
  const audioFormat = String(req.body?.audioFormat || "wav");
  const sampleRate = Number(req.body?.sampleRate || 0);

  if (!voiceSlotId) {
    res.status(400).json({ error: "voiceSlotId is required." });
    return;
  }
  if (!modelKey) {
    res.status(400).json({ error: "modelKey is required." });
    return;
  }

  const vSlot = VOICE_SLOT_DEFINITIONS.find((s) => s.id === voiceSlotId);
  if (!vSlot) {
    res.status(400).json({ error: `Unknown voice slot: ${voiceSlotId}` });
    return;
  }

  beginExclusiveAction();
  try {
    const voiceModels = await getVoiceModels();
    const voiceModel = voiceModels.find((m) => m.key === modelKey);
    if (!voiceModel) {
      res.status(404).json({ error: `Unknown voice model: ${modelKey}` });
      return;
    }
    const profileVoiceConfig = await readActiveProfileVoiceSlotConfig(vSlot.id);
    const resolvedVoiceParams = resolveVoiceRuntimeParams(vSlot, voiceModel, req.body || {}, profileVoiceConfig);
    const stdout = await setVoiceDefaults(vSlot, voiceModel, resolvedVoiceParams);
    await persistActiveProfileVoiceSelection(vSlot, voiceModel, resolvedVoiceParams);
    const overview = await getOverviewData();
    res.json({ ok: true, stdout, ...overview });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) });
  } finally {
    finishExclusiveAction();
  }
});

app.post("/api/voice/restart", requireIdle, async (_req, res) => {

  beginExclusiveAction();
  try {
    const voiceRestart = await restartVoiceModels();
    if (voiceRestart.ok === false) {
      res.status(502).json({ error: voiceRestart.error, voice_restart: voiceRestart });
      return;
    }
    const overview = await getOverviewData();
    res.json({ ok: true, stdout: "Voice models restarted.", voice_restart: voiceRestart, ...overview });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) });
  } finally {
    finishExclusiveAction();
  }
});

app.post("/api/voice/slot-config", async (req, res) => {
  const voiceSlotId = String(req.body?.voiceSlotId || "");
  const runtimeBaseUrl = String(req.body?.runtimeBaseUrl || "").trim();

  const vSlot = VOICE_SLOT_DEFINITIONS.find((s) => s.id === voiceSlotId);
  if (!vSlot) {
    res.status(400).json({ error: "Unknown voice slot." });
    return;
  }
  await writeVoiceSlotRuntimeBaseUrl(vSlot.id, runtimeBaseUrl);
  const overview = await getOverviewData();
  res.json({ ok: true, voiceSlotId, runtimeBaseUrl, ...overview });
});

app.get("/api/voice/logs/:voiceSlotId/:kind", async (req, res) => {
  const vSlotId = String(req.params.voiceSlotId || "");
  const kind = req.params.kind;
  const vSlot = VOICE_SLOT_DEFINITIONS.find((s) => s.id === vSlotId);
  if (!vSlot) {
    res.status(404).json({ error: "Unknown voice slot." });
    return;
  }
  if (!["server", "traffic"].includes(kind)) {
    res.status(404).json({ error: "Unknown log kind." });
    return;
  }

  const offset = Number(req.query.offset || 0);
  const status = await getVoiceSlotStatus(vSlot);
  const filePath = status?.logs?.active?.[kind] || getDefaultVoiceLogs(vSlot)[kind] || "";
  const chunk = await readLogChunk(filePath, offset);
  const payload = {
    voiceSlotId: vSlot.id,
    kind,
    filePath,
    nextOffset: chunk.nextOffset,
    reset: chunk.reset,
    content: chunk.content,
  };
  res.json(payload);
});

app.get("/api/sync-target", async (_req, res) => {
  const integrationTargets = await readIntegrationTargetSlotIds();
  res.json({ slotId: integrationTargets.openclaude, integrationTargets });
});

app.post("/api/sync-target", async (req, res) => {
  const slot = getSlotDefinition(String(req.body.slotId || ""));
  if (!slot) {
    res.status(400).json({ error: "slotId is required." });
    return;
  }
  await updateDashboardConfig((dashboardConfig) => ({
    ...dashboardConfig,
    applicationTargets: buildDefaultApplicationTargets(slot.id),
  }));
  const overview = await getOverviewData();
  res.json({ ok: true, slotId: slot.id, integrationTargets: overview.integrationTargets, ...overview });
});

app.post("/api/applications/:applicationKey", requireIdle, async (req, res) => {

  const application = getApplicationDefinition(String(req.params.applicationKey || "").trim());
  if (!application) {
    res.status(404).json({ error: "Unknown application." });
    return;
  }
  if (application.slotKind === "voice") {
    res.status(400).json({ error: `${application.label} is managed from the Voice tab.` });
    return;
  }

  const slot = getSlotDefinition(String(req.body?.slotId || ""));
  if (!slot) {
    res.status(400).json({ error: "slotId is required." });
    return;
  }

  beginExclusiveAction();
  try {
    const status = await getSlotStatus(slot);
    if (!status?.running) {
      res.status(409).json({ error: `${application.label} can only target a running slot. Launch a model in ${slot.label} first.` });
      return;
    }

    const target = await buildSlotSyncTarget(slot, status);
    const syncResult = await syncApplicationTarget(application.key, target);
    if (syncResult.ok === false) {
      res.status(502).json({
        error: syncResult.error || `${application.label} sync failed.`,
        application: application.key,
        sync: syncResult,
      });
      return;
    }

    await updateDashboardConfig((dashboardConfig) => ({
      ...dashboardConfig,
      applicationTargets: {
        ...dashboardConfig.applicationTargets,
        [application.key]: slot.id,
      },
    }));

    const overview = await getOverviewData();
    res.json({
      ok: true,
      stdout: `${application.label} now points to ${slot.label}.`,
      application: { key: application.key, label: application.label, slotId: slot.id },
      sync: syncResult,
      ...overview,
    });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) });
  } finally {
    finishExclusiveAction();
  }
});

app.post("/api/slot-config", async (req, res) => {
  const slot = getSlotDefinition(String(req.body.slotId || ""));
  if (!slot) {
    res.status(400).json({ error: "slotId is required." });
    return;
  }

  const runtimeBaseUrl = String(req.body.runtimeBaseUrl || "").trim();
  await writeSlotRuntimeBaseUrl(slot.id, runtimeBaseUrl);
  const overview = await getOverviewData();
  res.json({ ok: true, slotId: slot.id, runtimeBaseUrl, ...overview });
});

// Renaming a slot is a label change, not a runtime action, so it does not go
// through requireIdle: it must work while models are loaded.
app.post("/api/slots/name", async (req, res) => {
  const slot = getSlotDefinition(String(req.body?.slotId || ""));
  if (!slot) {
    res.status(400).json({ error: "slotId is required." });
    return;
  }

  const name = normalizeSlotName(req.body?.name);
  try {
    let scope = "global";
    await updateDashboardConfig((dashboardConfig) => {
      const activeProfile = getDashboardProfile(dashboardConfig.profiles, dashboardConfig.activeProfileId);
      // With a profile applied the name belongs to that profile, so switching
      // profiles switches the names too. Otherwise it is a global name.
      if (activeProfile) {
        scope = "profile";
        return {
          ...dashboardConfig,
          profiles: dashboardConfig.profiles.map((profile) => (profile.id === activeProfile.id
            ? {
              ...profile,
              slots: {
                ...profile.slots,
                [slot.id]: { ...(profile.slots?.[slot.id] || {}), name },
              },
              updatedAt: new Date().toISOString(),
            }
            : profile)),
        };
      }
      const slotNames = { ...(dashboardConfig.slotNames || {}) };
      if (name) {
        slotNames[slot.id] = name;
      } else {
        delete slotNames[slot.id];
      }
      return { ...dashboardConfig, slotNames };
    });
    clearOverviewCache();
    const overview = await getOverviewData();
    const scopeLabel = scope === "profile" ? "the active profile" : "all slots";
    res.json({
      ok: true,
      stdout: name
        ? `Renamed ${slot.label} to ${name} in ${scopeLabel}.`
        : `Cleared the name of ${slot.label} in ${scopeLabel}.`,
      slotId: slot.id,
      name,
      scope,
      ...overview,
    });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) || "Unable to rename the slot." });
  }
});

app.post("/api/profiles/save", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required." });
    return;
  }

  try {
    const profileId = String(req.body?.profileId || "").trim();
    const isDefault = Boolean(req.body?.isDefault);
    const existingProfile = profileId
      ? getDashboardProfile((await readDashboardConfig()).profiles, profileId)
      : null;
    const normalizedSlots = normalizeProfileSlots(
      carryForwardSlotNames(req.body?.slots, existingProfile)
    );
    const normalizedVoiceSlots = normalizeProfileVoiceSlots(req.body?.voiceSlots);
    const nextProfile = {
      id: profileId || randomUUID(),
      name,
      color: normalizeDashboardHexColor(req.body?.color),
      slots: normalizedSlots,
      voiceSlots: normalizedVoiceSlots,
      updatedAt: new Date().toISOString(),
    };
    await updateDashboardConfig((dashboardConfig) => {
      const existingProfiles = Array.isArray(dashboardConfig.profiles) ? dashboardConfig.profiles : [];
      const otherProfiles = existingProfiles.filter((profile) => profile.id !== nextProfile.id);
      const nextProfiles = [...otherProfiles, nextProfile];
      const nextDefaultProfileId = isDefault
        ? nextProfile.id
        : dashboardConfig.defaultProfileId === nextProfile.id
          ? ""
          : dashboardConfig.defaultProfileId || "";
      return {
        ...dashboardConfig,
        profiles: nextProfiles,
        defaultProfileId: nextDefaultProfileId,
        activeProfileId: dashboardConfig.activeProfileId || "",
      };
    });
    const overview = await getOverviewData();
    res.json({
      ok: true,
      stdout: `Saved profile ${nextProfile.name}.`,
      profileId: nextProfile.id,
      ...overview,
    });
  } catch (error) {
    res.status(500).json({ error: formatExecError(error) || "Unable to save profile." });
  }
});

app.post("/api/profiles/apply", requireIdle, async (req, res) => {

  const profileId = String(req.body?.profileId || "").trim();
  if (!profileId) {
    res.status(400).json({ error: "profileId is required." });
    return;
  }

  beginExclusiveAction();
  try {
    const result = await applySavedProfile(profileId);
    const overview = await getOverviewData();
    res.json({
      ok: true,
      stdout: result.stdout,
      profileId,
      profileName: result.profileName || "",
      ...overview,
    });
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      error: formatExecError(error) || "Unable to apply profile.",
      stdout: error?.stdout || "",
      stderr: error?.stderr || "",
      integration_sync: error?.integrationSync,
      profileId,
      profileName: error?.profileName || "",
    });
  } finally {
    finishExclusiveAction();
  }
});

app.post("/api/profiles/delete", requireIdle, async (req, res) => {

  const profileId = String(req.body?.profileId || "").trim();
  if (!profileId) {
    res.status(400).json({ error: "profileId is required." });
    return;
  }

  try {
    const profile = await deleteDashboardProfile(profileId);
    const overview = await getOverviewData();
    res.json({
      ok: true,
      stdout: `Deleted profile ${profile.name}.`,
      profileId,
      ...overview,
    });
  } catch (error) {
    const statusCode = String(error?.message || "").startsWith("Unknown profile:") ? 404 : 500;
    res.status(statusCode).json({ error: formatExecError(error) || "Unable to delete profile." });
  }
});

app.post("/api/stop", async (req, res) => {
  const requestedSlot = String(req.body?.slotId || "").trim();
  const slot = requestedSlot ? getSlotDefinition(requestedSlot) : null;
  if (requestedSlot && !slot) {
    res.status(400).json({ error: "Unknown slot." });
    return;
  }

  logSlotAction("POST /api/stop", `slot=${slot?.id || "ALL"} ${describeRequester(req)}`);
  const interruptingAction = actionInFlight;
  if (interruptingAction) {
    requestActionAbort();
  } else {
    beginExclusiveAction();
  }
  try {
    const output = await stopAllRuntimes({ slotId: slot?.id || "" });
    const overview = await getOverviewData();
    res.json({
      ok: true,
      stdout: [
        interruptingAction ? "Stop requested. Cancelling the current startup action." : "",
        output.join("\n").trim(),
      ].filter(Boolean).join("\n").trim(),
      ...overview,
    });
  } catch (error) {
    res.status(error?.statusCode || 500).json({ error: formatExecError(error) });
  } finally {
    if (!interruptingAction) {
      finishExclusiveAction();
    }
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

// Express 5 forwards a rejected async handler here. Without this the default
// handler answers with an HTML stack trace; the dashboard expects JSON.
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, _next) => {
  const status = Number(error?.status || error?.statusCode) || 500;
  const message = error?.message || "Internal server error.";
  if (status >= 500) {
    console.error(`[llm3] ${req.method} ${req.originalUrl} failed:`, error);
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: message });
});

// Slot start/stop was previously not logged anywhere, so a backend that
// vanished mid-request was indistinguishable from a crash: llama-server exits
// via the same clean "cleaning up before exit" path either way, and the
// launcher removes current.json and both pid files on stop. Record every
// transition with its trigger so "it crashed" can be answered from the log.
function logSlotAction(action, detail = "") {
  appendServerLogLine(`slot-action ${action}${detail ? ` ${detail}` : ""}`);
}

// The log recorded what was attempted and never what went wrong: a failed launch
// returned its reason in the HTTP response and left no trace on disk, so the
// Logs tab showed a start-model line followed by nothing at all.
//
// One hook rather than a call in every catch, because most rejections never
// reach a catch: they are validation returns ("Unknown model", "ctxSize must
// be...", a 409 from requireIdle) that answer and return from inside the try.
// Only mutating requests are logged; a polling GET that 404s is noise.
function logFailedActionResponse(req, res, body) {
  if (req.method === "GET" || res.statusCode < 400) {
    return;
  }
  const detail = [
    String(body?.error || "").trim() || `HTTP ${res.statusCode}`,
    body?.stdout ? `stdout:\n${String(body.stdout).trim()}` : "",
    body?.stderr ? `stderr:\n${String(body.stderr).trim()}` : "",
    Array.isArray(body?.sync_errors) && body.sync_errors.length ? `sync: ${body.sync_errors.join(" ")}` : "",
  ].filter(Boolean).join("\n");
  appendServerLogLine(`ERROR ${req.method} ${req.originalUrl} -> ${res.statusCode}: ${detail}`);
}

function describeRequester(req) {
  if (!req) {
    return "internal";
  }
  const ip = String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "") || "unknown";
  const agent = String(req.get?.("user-agent") || "").slice(0, 60);
  return `client=${ip}${agent ? ` ua="${agent}"` : ""}`;
}

async function stopAllRuntimes({ slotId = "" } = {}) {
  const requestedSlot = String(slotId || "").trim();
  const slot = requestedSlot ? getSlotDefinition(requestedSlot) : null;
  if (requestedSlot && !slot) {
    throw new Error("Unknown slot.");
  }
  logSlotAction("stop-runtimes", `slot=${requestedSlot || "ALL"}`);

  const output = [];
  const targetSlots = slot ? [slot] : SLOT_DEFINITIONS;
  const dashboardConfig = await readDashboardConfig();
  // Compaction is the one role whose consumer keeps calling the endpoint on its
  // own schedule, so leaving it pointed at a stopped slot means silent failures
  // until the next launch. Reset it from whichever slot currently holds the
  // role -- there is no compaction slot any more.
  const compactionStopTargets = await Promise.all(
    COMPACTION_ROLE_RESETS
      .map((role) => ({ role, slot: getSlotDefinition(String(dashboardConfig?.applicationTargets?.[role.key] || "").trim()) }))
      .filter(({ slot: roleSlot }) => roleSlot && targetSlots.some((currentSlot) => currentSlot.id === roleSlot.id))
      .map(async ({ role, slot: roleSlot }) => ({
        role,
        target: { slotId: roleSlot.id, runtimeBaseUrl: await readSlotRuntimeBaseUrl(roleSlot.id) },
      }))
  );
  for (const currentSlot of targetSlots) {
    output.push(await safeStop(OPTIQ_LAUNCHER, currentSlot));
    output.push(await safeStop(MTPLX_LAUNCHER, currentSlot));
    output.push(await safeStop(MLX_DSPARK_LAUNCHER, currentSlot));
    output.push(await safeStop(MLX_VLM_LAUNCHER, currentSlot));
    output.push(await safeStop(DS4_LAUNCHER, currentSlot));
    output.push(await safeStop(RAPID_MLX_LAUNCHER, currentSlot));
    output.push(await safeStop(DFLASH_LAUNCHER, currentSlot));
    output.push(await safeStop(MLX_LAUNCHER, currentSlot));
    output.push(await safeStop(BEELLAMA_LAUNCHER, currentSlot));
    output.push(await safeStop(GGUF_TQ3_LAUNCHER, currentSlot));
    output.push(await safeStop(GGUF_LAUNCHER, currentSlot));
  }

  if (!slot) {
    for (const vSlot of VOICE_SLOT_DEFINITIONS) {
      output.push(await safeStopVoice(Voice_TTS_LAUNCHER, vSlot));
      output.push(await safeStopVoice(Voice_STT_LAUNCHER, vSlot));
    }
  }

  for (const { role, target } of compactionStopTargets) {
    const reset = await role.reset(target);
    // A failed reset is reported, never fatal. It used to throw a 502 that
    // aborted the caller -- and since a start stops the slot first, an
    // unreachable machine made that slot impossible to load at all.
    if (reset.ok === false) {
      output.push(`${role.label} still points at ${target.slotId} and could not be reset: ${reset.error || "reason unknown"}`);
    } else if (reset.changed) {
      output.push(`${role.label} routing reset.`);
    }
  }

  clearOverviewCache();
  return output.filter(Boolean);
}

const COMPACTION_ROLE_RESETS = [
  { key: "compaction", label: "Remote Hermes compaction", reset: (target) => syncHermesCompactionRemoteAfterStop(target) },
  { key: "compactionm4", label: "Local Hermes compaction", reset: (target) => syncHermesM4CompactionAfterStop(target) },
];

async function startConfiguredModel(slot, model, params, requestedApplicationTargets = {}) {
  assertActionNotAborted();
  params = normalizeLaunchParamsForModel(model, params);
  const launchCompatibilityError = await getLaunchCompatibilityError(slot, model);
  if (launchCompatibilityError) {
    const error = new Error(launchCompatibilityError);
    error.statusCode = 409;
    throw error;
  }

  logSlotAction("start-model", `slot=${slot.id} model=${model?.label || model?.key || "?"} launcher=${params.launcher || model.launcher || "?"}`);
  await stopAllRuntimes({ slotId: slot.id });
  assertActionNotAborted();
  const stdout = await startModel(slot, model, params);
  assertActionNotAborted();
  await markModelUsed(model);
  const dashboardConfig = await readDashboardConfig();
  const proposedApplicationTargets = {
    ...dashboardConfig.applicationTargets,
  };
  for (const [key, enabled] of Object.entries(requestedApplicationTargets)) {
    if (enabled) {
      proposedApplicationTargets[key] = slot.id;
    }
  }

  const proposedIntegrationTargets = applicationTargetsToIntegrationTargets(proposedApplicationTargets);
  const appKeysToSync = getLaunchableApplicationKeys().filter((key) => proposedApplicationTargets[key] === slot.id);
  const shouldSyncAnyApplication = appKeysToSync.length > 0;
  const syncTarget = shouldSyncAnyApplication
    ? await buildLaunchSyncTarget(slot, model, params)
    : null;
  const integrationSync = Object.fromEntries(
    await Promise.all(
      getLaunchableApplicationKeys().map(async (key) => {
        if (proposedApplicationTargets[key] === slot.id) {
          return [key, await syncApplicationTarget(key, syncTarget)];
        }
        const targetSlot = proposedApplicationTargets[key];
        return [key, { ok: true, skipped: true, reason: `${key} target is ${targetSlot}` }];
      })
    )
  );
  const syncErrors = getFailedIntegrationSyncMessages(integrationSync);
  if (
    JSON.stringify(dashboardConfig.applicationTargets) !== JSON.stringify(proposedApplicationTargets)
  ) {
    await writeDashboardConfig({
      ...dashboardConfig,
      applicationTargets: proposedApplicationTargets,
    });
  }
  clearOverviewCache();
  return { stdout, integrationSync, syncErrors };
}

function getFailedIntegrationSyncMessages(integrationSync = {}) {
  return Object.entries(integrationSync)
    .filter(([, result]) => result?.ok === false)
    .map(([key, result]) => `${key} sync failed: ${result.error}`);
}

async function applySavedProfile(profileId) {
  assertActionNotAborted();
  const dashboardConfig = await readDashboardConfig();
  const profile = getDashboardProfile(dashboardConfig.profiles, profileId);
  if (!profile) {
    throw new Error(`Unknown profile: ${profileId}`);
  }
  const profileName = String(profile.name || "").trim();
  logSlotAction("apply-profile", `profile=${profileName || profileId}`);

  try {
    const output = [];
    output.push(...await stopAllRuntimes());

    for (const slot of SLOT_DEFINITIONS) {
      assertActionNotAborted();
      const slotConfig = normalizeProfileSlotConfig(slot.id, profile.slots?.[slot.id]);
      await writeSlotRuntimeBaseUrl(slot.id, slotConfig.runtimeBaseUrl);
    }
    for (const voiceSlot of VOICE_SLOT_DEFINITIONS) {
      assertActionNotAborted();
      const voiceConfig = normalizeProfileVoiceSlotConfig(voiceSlot.id, profile.voiceSlots?.[voiceSlot.id]);
      await writeVoiceSlotRuntimeBaseUrl(voiceSlot.id, voiceConfig.runtimeBaseUrl);
    }

    const models = await getModels();
    for (const slot of SLOT_DEFINITIONS) {
      assertActionNotAborted();
      const slotConfig = normalizeProfileSlotConfig(slot.id, profile.slots?.[slot.id]);
      if (!slotConfig.enabled || !slotConfig.modelKey) {
        continue;
      }
      const model = models.find((entry) => entry.key === slotConfig.modelKey);
      if (!model) {
        throw new Error(`Unknown model in profile ${profile.name}: ${slotConfig.modelKey}`);
      }
      const result = await startConfiguredModel(
        slot,
        model,
        {
          ctxSize: slotConfig.ctxSize,
          parallel: slotConfig.parallel,
          thinking: slotConfig.thinking,
          reasoningBudget: slotConfig.reasoningBudget,
          enableDry: slotConfig.enableDry,
          mtpDraftMax: slotConfig.mtpDraftMax,
          ubatchSize: slotConfig.ubatchSize,
          enableTinyGrammar: slotConfig.enableTinyGrammar,
          enableStructuredGbnf: slotConfig.enableStructuredGbnf,
          launcher: slotConfig.launcher || dashboardConfig.preferredLaunchers?.[model.key] || "",
          temperature: slotConfig.temperature,
          topP: slotConfig.topP,
          topK: slotConfig.topK,
          minP: slotConfig.minP,
          presencePenalty: slotConfig.presencePenalty,
          repetitionPenalty: slotConfig.repetitionPenalty,
        },
        buildRequestedApplicationTargetsFromProfileSlot(slotConfig)
      );
      output.push(result.stdout);
    }

    const voiceModels = await getVoiceModels();
    const proposedVoiceApplicationTargets = {};
    for (const voiceSlot of VOICE_SLOT_DEFINITIONS) {
      assertActionNotAborted();
      const voiceConfig = normalizeProfileVoiceSlotConfig(voiceSlot.id, profile.voiceSlots?.[voiceSlot.id]);
      if (!voiceConfig.enabled || !voiceConfig.modelKey) {
        continue;
      }
      const voiceModel = voiceModels.find((entry) => entry.key === voiceConfig.modelKey);
      if (!voiceModel) {
        throw new Error(`Unknown voice model in profile ${profile.name}: ${voiceConfig.modelKey}`);
      }
      if (voiceModel.type !== voiceSlot.type) {
        throw new Error(`Voice model ${voiceConfig.modelKey} is ${voiceModel.type}, not ${voiceSlot.type}.`);
      }

      output.push(
        await startVoiceModel(voiceSlot, voiceModel, {
          voiceName: voiceConfig.voiceName,
          audioFormat: voiceConfig.audioFormat,
          sampleRate: voiceConfig.sampleRate,
          tuning: normalizeVoiceTtsTuningParams(voiceConfig, voiceModel),
        })
      );

      if (voiceConfig.setHermes || voiceConfig.setHermesM4) {
        const syncTarget = await buildVoiceSyncTarget(voiceSlot, voiceModel, {
          voiceName: voiceConfig.voiceName,
          audioFormat: voiceConfig.audioFormat,
          sampleRate: voiceConfig.sampleRate,
          tuning: normalizeVoiceTtsTuningParams(voiceConfig, voiceModel),
        });
        if (voiceConfig.setHermes) {
          const voiceSync = voiceSlot.type === "tts"
            ? await syncHermesTTSAfterLaunch(syncTarget)
            : await syncHermesSTTAfterLaunch(syncTarget);
          if (voiceSync?.ok === false) {
            throw new Error(`${voiceSlot.type.toUpperCase()} Hermes sync failed: ${voiceSync.error || "unknown error"}`);
          }
          proposedVoiceApplicationTargets[voiceSlot.type === "tts" ? "voicetts" : "voicestt"] = voiceSlot.id;
        }
        if (voiceConfig.setHermesM4) {
          const m4Sync = await syncHermesM4VoiceAfterLaunch(syncTarget);
          if (m4Sync?.ok === false) {
            throw new Error(`Hermes M4 ${voiceSlot.type.toUpperCase()} sync failed: ${m4Sync.error || "unknown error"}`);
          }
          proposedVoiceApplicationTargets[voiceSlot.type === "tts" ? "voicetts" : "voicestt"] = voiceSlot.id;
        }
      }
    }

    await updateDashboardConfig((refreshedConfig) => ({
      ...refreshedConfig,
      applicationTargets: {
        ...refreshedConfig.applicationTargets,
        ...proposedVoiceApplicationTargets,
      },
      activeProfileId: profile.id,
    }));
    clearOverviewCache();

    return {
      profile,
      profileName,
      stdout: output.filter(Boolean).join("\n").trim() || `Applied profile ${profile.name}.`,
    };
  } catch (error) {
    if (!error.profileName && profileName) {
      error.profileName = profileName;
    }
    throw error;
  }
}

async function deleteDashboardProfile(profileId) {
  let profile = null;
  await updateDashboardConfig((dashboardConfig) => {
    profile = getDashboardProfile(dashboardConfig.profiles, profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }
    return {
      ...dashboardConfig,
      profiles: (Array.isArray(dashboardConfig.profiles) ? dashboardConfig.profiles : []).filter((entry) => entry.id !== profile.id),
      defaultProfileId: dashboardConfig.defaultProfileId === profile.id ? "" : dashboardConfig.defaultProfileId || "",
      activeProfileId: dashboardConfig.activeProfileId === profile.id ? "" : dashboardConfig.activeProfileId || "",
    };
  });

  return profile;
}

let defaultProfileBootPromise = null;

async function startDefaultProfileOnBoot() {
  if (defaultProfileBootPromise) {
    return defaultProfileBootPromise;
  }
  defaultProfileBootPromise = (async () => {
    const dashboardConfig = await readDashboardConfig();
    if (!dashboardConfig.defaultProfileId) {
      return;
    }
    beginExclusiveAction();
    try {
      await applySavedProfile(dashboardConfig.defaultProfileId);
      clearOverviewCache();
    } catch (error) {
      console.error(`Failed to start default profile: ${formatExecError(error)}`);
    } finally {
      finishExclusiveAction();
    }
  })();
  return defaultProfileBootPromise;
}

if (require.main === module) {
  startServer();
}

async function runLauncher(script, args, options = {}) {
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0;
  const { stdout, stderr } = await execFileAsync(script, args, getLauncherExecOptions({
    maxBuffer: ACTION_BUFFER,
    ...(timeout > 0 ? { timeout } : {}),
  }));
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

async function safeStop(script, slot) {
  try {
    return await runLauncher(script, ["--slot", slot.id, "--stop"]);
  } catch (_error) {
    return "";
  }
}

async function startModel(slot, model, params) {
  const launcher = params.launcher || model.launcher;

  if (launcher === "dflash") {
    return runLauncher(DFLASH_LAUNCHER, [
      "--slot",
      slot.id,
      "--model",
      model.key,
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "rapid-mlx") {
    return runLauncher(RAPID_MLX_LAUNCHER, [
      "--slot",
      slot.id,
      "--model",
      model.key,
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "mlx-dspark") {
    return runLauncher(MLX_DSPARK_LAUNCHER, [
      "--slot",
      slot.id,
      "--model",
      model.key,
      ...(params.dsparkMode ? ["--mode", params.dsparkMode] : []),
      ...(params.reasoningEffort ? ["--reasoning-effort", params.reasoningEffort] : []),
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--port",
      String(slot.publicPort),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
      "--start",
    ]);
  }

  // ds4 takes the pack GGUF path; it finds the mandatory PLE sidecar next to it
  // by itself. MTP and its draft depth come from the slot's saved ds4 defaults
  // (bin/run-ds4-api.sh --set-defaults), because they have no llm3 UI control
  // yet; the launcher's own default is MTP on at draft 2, which is the fastest
  // configuration measured on this box.
  if (launcher === "ds4") {
    return runLauncher(DS4_LAUNCHER, [
      "--slot",
      slot.id,
      "--model",
      model.key,
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--port",
      String(slot.publicPort),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
      ...(Number.isInteger(params.mtpDraftMax) && params.mtpDraftMax >= 1
        ? ["--mtp-draft", String(params.mtpDraftMax)]
        : []),
      "--start",
    ]);
  }

  if (launcher === "mlx-vlm") {
    return runLauncher(MLX_VLM_LAUNCHER, [
      "--slot",
      slot.id,
      "--model",
      model.key,
      ...(params.reasoningEffort ? ["--reasoning-effort", params.reasoningEffort] : []),
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--port",
      String(slot.publicPort),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
      "--start",
    ]);
  }

  if (launcher === "mtplx") {
    return runLauncher(MTPLX_LAUNCHER, [
      "--slot",
      slot.id,
      "--model",
      model.key,
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--port",
      String(slot.publicPort),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "optiq") {
    return runLauncher(OPTIQ_LAUNCHER, [
      "--slot",
      slot.id,
      "--model",
      model.key,
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--port",
      String(slot.publicPort),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "mlx") {
    return runLauncher(MLX_LAUNCHER, [
      "--slot",
      slot.id,
      "--model",
      model.key,
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "turboquant") {
    return runLauncher(TURBO_QUANT_LAUNCHER, [
      "--slot",
      slot.id,
      "--model",
      model.key,
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "gguf-tq3") {
    return runLauncher(GGUF_TQ3_LAUNCHER, [
      "--slot",
      slot.id,
      model.key,
      "--ctx-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
      params.thinking ? "--thinking" : "--no-thinking",
      ...buildQwenGrammarArgs(params),
      ...buildGgufExtraArgs(params),
    ]);
  }

  if (launcher === "beellama") {
    return runLauncher(BEELLAMA_LAUNCHER, [
      "--slot",
      slot.id,
      model.key,
      "--ctx-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
      params.thinking ? "--thinking" : "--no-thinking",
      ...buildQwenGrammarArgs(params),
      ...buildGgufExtraArgs(params),
    ]);
  }

  return runLauncher(GGUF_LAUNCHER, [
    "--slot",
    slot.id,
    model.key,
    "--ctx-size",
    String(params.ctxSize),
    "--parallel",
    String(params.parallel),
    "--temperature",
    String(params.temperature),
    "--top-p",
    String(params.topP),
    "--top-k",
    String(params.topK),
    "--min-p",
    String(params.minP),
    "--presence-penalty",
    String(params.presencePenalty),
    "--repetition-penalty",
    String(params.repetitionPenalty),
    params.thinking ? "--thinking" : "--no-thinking",
    ...buildQwenGrammarArgs(params),
      ...buildGgufExtraArgs(params),
  ]);
}

async function setLauncherDefaults(slot, model, params) {
  params = normalizeLaunchParamsForModel(model, params);
  const launcher = resolveDefaultsLauncher(model, params.launcher);

  if (launcher === "dflash") {
    return runLauncher(DFLASH_LAUNCHER, [
      "--slot",
      slot.id,
      "--set-defaults",
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "mlx") {
    return runLauncher(MLX_LAUNCHER, [
      "--slot",
      slot.id,
      "--set-defaults",
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "mlx-dspark") {
    return runLauncher(MLX_DSPARK_LAUNCHER, [
      "--slot",
      slot.id,
      "--set-defaults",
      ...(params.dsparkMode ? ["--mode", params.dsparkMode] : []),
      ...(params.reasoningEffort ? ["--reasoning-effort", params.reasoningEffort] : []),
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "ds4") {
    return runLauncher(DS4_LAUNCHER, [
      "--slot",
      slot.id,
      "--set-defaults",
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
      ...(Number.isInteger(params.mtpDraftMax) && params.mtpDraftMax >= 1
        ? ["--mtp-draft", String(params.mtpDraftMax)]
        : []),
    ]);
  }

  if (launcher === "mlx-vlm") {
    return runLauncher(MLX_VLM_LAUNCHER, [
      "--slot",
      slot.id,
      "--set-defaults",
      ...(params.reasoningEffort ? ["--reasoning-effort", params.reasoningEffort] : []),
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "mtplx") {
    return runLauncher(MTPLX_LAUNCHER, [
      "--slot",
      slot.id,
      "--set-defaults",
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "optiq") {
    return runLauncher(OPTIQ_LAUNCHER, [
      "--slot",
      slot.id,
      "--set-defaults",
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "turboquant") {
    return runLauncher(TURBO_QUANT_LAUNCHER, [
      "--slot",
      slot.id,
      "--set-defaults",
      "--context-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
    ]);
  }

  if (launcher === "gguf-tq3") {
    return runLauncher(GGUF_TQ3_LAUNCHER, [
      "--slot",
      slot.id,
      "--set-defaults",
      "--ctx-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
      params.thinking ? "--thinking" : "--no-thinking",
      ...buildQwenGrammarArgs(params),
      ...buildGgufExtraArgs(params),
    ]);
  }

  if (launcher === "beellama") {
    return runLauncher(BEELLAMA_LAUNCHER, [
      "--slot",
      slot.id,
      "--set-defaults",
      "--ctx-size",
      String(params.ctxSize),
      "--parallel",
      String(params.parallel),
      "--temperature",
      String(params.temperature),
      "--top-p",
      String(params.topP),
      "--top-k",
      String(params.topK),
      "--min-p",
      String(params.minP),
      "--presence-penalty",
      String(params.presencePenalty),
      "--repetition-penalty",
      String(params.repetitionPenalty),
      params.thinking ? "--thinking" : "--no-thinking",
      ...buildQwenGrammarArgs(params),
      ...buildGgufExtraArgs(params),
    ]);
  }

  return runLauncher(GGUF_LAUNCHER, [
    "--slot",
    slot.id,
    "--set-defaults",
    "--ctx-size",
      String(params.ctxSize),
    "--parallel",
    String(params.parallel),
    "--temperature",
    String(params.temperature),
    "--top-p",
    String(params.topP),
    "--top-k",
    String(params.topK),
    "--min-p",
    String(params.minP),
    "--presence-penalty",
    String(params.presencePenalty),
    "--repetition-penalty",
    String(params.repetitionPenalty),
    params.thinking ? "--thinking" : "--no-thinking",
    ...buildQwenGrammarArgs(params),
      ...buildGgufExtraArgs(params),
  ]);
}

const BENCHMARK_RESULTS_ROOT = path.join(REPO_ROOT, "benchmarks", "results");
const BENCHMARK_RANK_CACHE_TTL_MS = 30_000;
let benchmarkRankCache = { at: 0, byPath: new Map() };

async function getBenchmarkRankings() {
  const now = Date.now();
  if (now - benchmarkRankCache.at < BENCHMARK_RANK_CACHE_TTL_MS) {
    return benchmarkRankCache.byPath;
  }
  const byPath = new Map();
  const entries = await fs.readdir(BENCHMARK_RESULTS_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(await fs.readFile(path.join(BENCHMARK_RESULTS_ROOT, entry.name, "benchmark.json"), "utf8"));
    } catch (_error) {
      continue;
    }
    const modelPath = String(payload?.path || payload?.modelKey || "").trim();
    if (!modelPath) {
      continue;
    }
    const resolved = path.resolve(modelPath);
    const overall = Number(payload?.benchmarks?.quality?.overallAverage);
    const decodeTps = Number(payload?.benchmarks?.throughput?.tokensPerSecond);
    const existing = byPath.get(resolved) || { overall: null, decodeTps: null, label: String(payload?.modelLabel || "") };
    if (Number.isFinite(overall) && (existing.overall == null || overall > existing.overall)) {
      existing.overall = overall;
    }
    if (Number.isFinite(decodeTps) && (existing.decodeTps == null || decodeTps > existing.decodeTps)) {
      existing.decodeTps = decodeTps;
    }
    byPath.set(resolved, existing);
  }
  const ranked = [...byPath.entries()]
    .filter(([, value]) => value.overall != null)
    .sort((left, right) => (right[1].overall - left[1].overall) || ((right[1].decodeTps || 0) - (left[1].decodeTps || 0)));
  ranked.slice(0, 3).forEach(([key, value], index) => {
    value.rank = index + 1;
    byPath.set(key, value);
  });
  benchmarkRankCache = { at: now, byPath };
  return byPath;
}

function annotateModelsWithBenchmarks(models, rankings) {
  if (!rankings || rankings.size === 0) {
    return models;
  }
  return models.map((model) => {
    const resolved = resolveModelPath(model);
    const entry = resolved ? rankings.get(resolved) : null;
    if (!entry) {
      return model;
    }
    return {
      ...model,
      benchmark: {
        ...(entry.rank ? { rank: entry.rank } : {}),
        ...(entry.overall != null ? { overall: entry.overall } : {}),
        ...(entry.decodeTps != null ? { decodeTps: entry.decodeTps } : {}),
      },
    };
  });
}

async function getModels() {
  const includeExperimental = experimentalMlxLaunchersEnabled();
  const [ggufRaw, mlxRaw, optiqRaw, dflashRaw, turboquantRaw, downloadedModels] = await Promise.all([
    readModelsFromScript(GGUF_LAUNCHER, "--list-json"),
    includeExperimental ? readModelsFromScript(MLX_LAUNCHER, "--list-json") : Promise.resolve([]),
    includeExperimental ? readModelsFromScript(OPTIQ_LAUNCHER, "--list-json") : Promise.resolve([]),
    includeExperimental ? readModelsFromScript(DFLASH_LAUNCHER, "--list-json") : Promise.resolve([]),
    includeExperimental ? readModelsFromScript(TURBO_QUANT_LAUNCHER, "--list-json") : Promise.resolve([]),
    scanDownloadedModels(),
  ]);

  const ggufModels = ggufRaw.map((model) => applyLauncherMetadata({ ...model, runtime: "gguf" }));
  const mlxModels = mlxRaw.map((model) => applyLauncherMetadata({ ...model, runtime: "mlx" }));
  const optiqModels = optiqRaw.map((model) => applyLauncherMetadata({ ...model, runtime: "mlx", launcher: "optiq" }));
  const dflashModels = dflashRaw.map((model) => applyLauncherMetadata({ ...model, runtime: "dflash" }));
  const turboquantModels = turboquantRaw.map((model) => applyLauncherMetadata({ ...model, runtime: "turboquant" }));

  const unmanagedLocalModels = await scanUnmanagedLocalModels([...ggufModels, ...mlxModels, ...optiqModels, ...dflashModels, ...turboquantModels, ...downloadedModels]);
  const all = [...ggufModels, ...mlxModels, ...optiqModels, ...dflashModels, ...turboquantModels, ...downloadedModels, ...unmanagedLocalModels];
  const deduped = new Map();
  for (const model of all) {
    deduped.set(getModelDedupeKey(model), model);
  }
  const rankings = await getBenchmarkRankings().catch(() => new Map());
  return annotateModelsWithBenchmarks([...deduped.values()], rankings).sort((left, right) => {
    const runtimeCompare = String(left.runtime || "").localeCompare(String(right.runtime || ""));
    if (runtimeCompare !== 0) {
      return runtimeCompare;
    }
    return String(left.label || left.key || "").localeCompare(String(right.label || right.key || ""));
  });
}

async function readModelsFromScript(script, flag) {
  try {
    const output = await runLauncher(script, [flag]);
    return JSON.parse(output);
  } catch (error) {
    const fallback = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    if (fallback) {
      try {
        return JSON.parse(fallback);
      } catch (_parseError) {
        // Fall through to the empty-state return below.
      }
    }
    return [];
  }
}

async function scanDownloadedModels() {
  const repoEntries = await fs.readdir(HF_MODELS_ROOT, { withFileTypes: true }).catch(() => []);
  const models = [];

  for (const entry of repoEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const repoDir = path.join(HF_MODELS_ROOT, entry.name);
    const metadata = await readDownloadedMetadata(repoDir);
    const repoFiles = await collectFilesRecursive(repoDir);
    const hasVisionProjector = repoFiles.some((filePath) => isVisionProjectorFile(filePath));
    const hasDs4PleSidecar = repoFiles.some((filePath) => isDs4PleSidecarFile(filePath));
    const ggufCandidatePaths = repoFiles.filter((filePath) => {
      return /\.gguf$/i.test(filePath)
        && !isVisionProjectorFile(filePath)
        && !isDs4PleSidecarFile(filePath);
    });
    const relativeGgufPath = (filePath) => path.relative(repoDir, filePath).replace(/\\/g, "/");
    // The ds4 pack's own base GGUF ends in "-MTP.gguf" and would otherwise be
    // partitioned away as a draft head, leaving the repo with no model at all.
    const mainGgufPaths = new Set(
      hasDs4PleSidecar
        ? ggufCandidatePaths.map(relativeGgufPath)
        : partitionMtpGgufPaths(ggufCandidatePaths.map(relativeGgufPath)).main
    );
    const ggufFiles = ggufCandidatePaths.filter((filePath) => mainGgufPaths.has(relativeGgufPath(filePath)));

    // A split GGUF is ONE model: llama.cpp loads it through shard 00001 and
    // pulls in the rest. Listing every shard offered four entries for the same
    // model, three of which cannot be loaded at all.
    const shardGroups = new Map();
    for (const filePath of ggufFiles) {
      const groupKey = ggufSplitGroupKey(filePath);
      if (!shardGroups.has(groupKey)) {
        shardGroups.set(groupKey, []);
      }
      shardGroups.get(groupKey).push(filePath);
    }
    const groupedGgufFiles = [];
    const groupSizeBytes = new Map();
    const groupMissingShards = new Map();
    for (const [, shards] of shardGroups) {
      shards.sort((left, right) => left.localeCompare(right));
      let total = 0;
      for (const shard of shards) {
        const shardStat = await fs.stat(shard).catch(() => null);
        total += shardStat?.isFile() ? shardStat.size : 0;
      }
      groupedGgufFiles.push(shards[0]);
      groupSizeBytes.set(shards[0], total);
      // The filename says how many shards the set should have. Fewer on disk
      // means an interrupted download or a half-finished delete, and llama.cpp
      // cannot load any of it -- so say so instead of listing the lowest
      // survivor as though it were a working model.
      const expected = Number(SPLIT_GGUF_PATTERN.exec(shards[0])?.[2] || 0);
      if (expected > shards.length) {
        groupMissingShards.set(shards[0], { have: shards.length, expected });
      }
    }

    for (const filePath of groupedGgufFiles) {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      // Size is the whole set, not just the shard we load through.
      const modelSizeBytes = groupSizeBytes.get(filePath) ?? stat.size;
      const basename = path.basename(filePath, ".gguf");
      const relativePath = path.relative(repoDir, filePath).replace(/\\/g, "/");
      models.push(applyLauncherMetadata({
        key: filePath,
        label: prettifyModelName(metadata?.label || basename),
        path: filePath,
        repoId: metadata?.repoId || "",
        downloadId: metadata?.repoId ? `gguf:${metadata.repoId}:${relativePath}` : "",
        hfUrl: metadata?.hfUrl || "",
        sizeBytes: modelSizeBytes,
        sizeLabel: formatBytes(modelSizeBytes),
        family: metadata?.family || inferModelFamily(basename),
        aliases: uniqueStrings([basename, metadata?.repoId]),
        source: metadata?.source || "huggingface",
        downloaded: true,
        deletable: true,
        quantization: parseQuantization(basename),
        vision: hasVisionProjector,
        ds4Pack: hasDs4PleSidecar,
        incompleteShards: groupMissingShards.get(filePath) || null,
      }));
    }

    if (ggufFiles.length > 0) {
      continue;
    }

    // Skip models that are served by turboquant launcher — don't double-classify as MLX
    if (metadata?.runtime === "turboquant") {
      continue;
    }

    if (!(await isMlxModelDirectory(repoDir))) {
      continue;
    }

    const mtplxSupport = await detectMtplxModelSupport(repoDir);
    const modelRuntime = mtplxSupport.canRun ? "mtplx" : "mlx";

    const sizeBytes = await getDirectorySize(repoDir);
    const modelData = {
      key: repoDir,
      label: prettifyModelName(metadata?.label || path.basename(repoDir)),
      path: repoDir,
      repoId: metadata?.repoId || "",
      downloadId: metadata?.repoId ? `mlx:${metadata.repoId}` : "",
      hfUrl: metadata?.hfUrl || "",
      sizeBytes,
      sizeLabel: formatBytes(sizeBytes),
      family: metadata?.family || inferModelFamily(path.basename(repoDir)),
      aliases: uniqueStrings([path.basename(repoDir), metadata?.repoId]),
      runtime: modelRuntime,
      mtplxSupport,
      source: metadata?.source || "huggingface",
      downloaded: true,
      deletable: true,
      quantization: metadata?.quantization || parseQuantization(path.basename(repoDir)),
      vision: metadata?.vision === true || mlxDirDeclaresVision(repoDir),
    };
    models.push(applyLauncherMetadata(modelData));
  }

  return models;
}

async function scanUnmanagedLocalModels(existingModels = []) {
  const repoEntries = await fs.readdir(MODELS_ROOT, { withFileTypes: true }).catch(() => []);
  const knownPaths = new Set(existingModels.map((model) => resolveModelPath(model)).filter(Boolean));
  const models = [];

  for (const entry of repoEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === path.basename(HF_MODELS_ROOT) || entry.name === path.basename(VOICE_MODELS_ROOT) || entry.name.startsWith("voice-") || entry.name === "turboquant") {
      continue;
    }

    const repoDir = path.join(MODELS_ROOT, entry.name);
    if (knownPaths.has(path.resolve(repoDir))) {
      continue;
    }

    if (!(await isMlxModelDirectory(repoDir))) {
      continue;
    }

    const mtplxSupport = await detectMtplxModelSupport(repoDir);
    const modelRuntime = mtplxSupport.canRun ? "mtplx" : "mlx";

    const metadata = await readDownloadedMetadata(repoDir);
    const sizeBytes = await getDirectorySize(repoDir);
    models.push(applyLauncherMetadata({
      key: repoDir,
      label: prettifyModelName(metadata?.label || path.basename(repoDir)),
      path: repoDir,
      repoId: metadata?.repoId || "",
      downloadId: metadata?.repoId ? `mlx:${metadata.repoId}` : "",
      hfUrl: metadata?.hfUrl || "",
      sizeBytes,
      sizeLabel: formatBytes(sizeBytes),
      family: metadata?.family || inferModelFamily(path.basename(repoDir)),
      aliases: uniqueStrings([path.basename(repoDir), metadata?.repoId]),
      runtime: modelRuntime,
      mtplxSupport,
      source: metadata?.source || "local",
      downloaded: true,
      deletable: true,
      quantization: metadata?.quantization || parseQuantization(path.basename(repoDir)),
      vision: metadata?.vision === true || mlxDirDeclaresVision(repoDir),
    }));
  }

  return models;
}

function resolveModelPath(model) {
  const rawPath = String(model?.path || model?.key || "").trim();
  return rawPath ? path.resolve(rawPath) : "";
}

function getModelDedupeKey(model) {
  return resolveModelPath(model) || String(model?.key || "");
}

async function collectFilesRecursive(rootDir) {
  const pending = [rootDir];
  const files = [];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function readDownloadedMetadata(repoDir) {
  try {
    const payload = JSON.parse(await fs.readFile(path.join(repoDir, ".llm3-hf.json"), "utf8"));
    const aliases = Array.isArray(payload?.aliases)
      ? payload.aliases.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    const familySource = [
      payload?.family,
      payload?.repoId,
      path.basename(String(repoDir || "")),
      ...aliases,
    ].join(" ");
    const normalizedFamily = inferModelFamily(familySource);
    return {
      source: String(payload?.source || "huggingface").trim() || "huggingface",
      repoId: String(payload?.repoId || "").trim(),
      hfUrl: String(payload?.hfUrl || "").trim(),
      label: String(payload?.label || "").trim(),
      family: normalizedFamily !== "Downloaded model" ? normalizedFamily : String(payload?.family || "").trim(),
      quantization: String(payload?.quantization || "").trim(),
      vision: payload?.vision === true,
      aliases,
      chatTemplateFile: String(payload?.chatTemplateFile || "").trim(),
      chatTemplateSourceRepoId: String(payload?.chatTemplateSourceRepoId || "").trim(),
      chatTemplateSourcePath: String(payload?.chatTemplateSourcePath || "").trim(),
    };
  } catch (_error) {
    return null;
  }
}

async function isMlxModelDirectory(dirPath) {
  const configPath = path.join(dirPath, "config.json");
  const configExists = await fs.stat(configPath).then((stat) => stat.isFile()).catch(() => false);
  if (!configExists) {
    return false;
  }

  const files = await collectFilesRecursive(dirPath);
  return files.some((filePath) => /\.(safetensors|bin|npz|npy)$/i.test(filePath));
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function hasTruthyFieldRecursive(value, fieldName) {
  if (Array.isArray(value)) {
    return value.some((entry) => hasTruthyFieldRecursive(entry, fieldName));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, fieldName) && Boolean(value[fieldName])) {
    return true;
  }
  return Object.values(value).some((entry) => hasTruthyFieldRecursive(entry, fieldName));
}

function hasPositiveNumericFieldRecursive(value, fieldName) {
  if (Array.isArray(value)) {
    return value.some((entry) => hasPositiveNumericFieldRecursive(entry, fieldName));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, fieldName)) {
    const numericValue = Number(value[fieldName]);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return true;
    }
  }
  return Object.values(value).some((entry) => hasPositiveNumericFieldRecursive(entry, fieldName));
}

function hasEmbeddedMtpWeights(indexPayload) {
  const weightMap = indexPayload?.weight_map;
  if (!weightMap || typeof weightMap !== "object") {
    return false;
  }
  return Object.keys(weightMap).some((tensorName) => /(^|\.)mtp(\.|$)/i.test(String(tensorName || "")));
}

function parseJsonFromCandidates(candidates = []) {
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (!text) {
      continue;
    }
    try {
      return JSON.parse(text);
    } catch (_error) {
      // Try the next candidate.
    }
  }
  return null;
}

function normalizeMtplxInspectSupport(payload) {
  const compat = payload?.compatibility;
  if (!compat || typeof compat !== "object") {
    return null;
  }
  const canRun = Boolean(compat.can_run);
  const missingExpectedKeys = Array.isArray(payload?.mtp?.missing_expected_keys)
    ? payload.mtp.missing_expected_keys.map((key) => String(key || "").trim()).filter(Boolean)
    : [];
  return {
    recognized: Boolean(compat.recognized || payload.architecture_recognized),
    canRun,
    runtimeCompatibility: String(compat.runtime_compatibility || payload.runtime_compatibility || (canRun ? "native" : "unsupported")).trim() || (canRun ? "native" : "unsupported"),
    supportLevel: String(compat.support_level || payload.support_level || (canRun ? "native" : "unsupported")).trim() || (canRun ? "native" : "unsupported"),
    message: String(compat.message || compat.support_notes || payload.support_notes || "").trim(),
    mtpMissingExpectedKeys: missingExpectedKeys,
    mtpPassesTensorGate: payload?.mtp?.passes_tensor_gate === true,
    mtpTensorCount: Number.isFinite(Number(payload?.mtp?.tensor_count)) ? Number(payload.mtp.tensor_count) : null,
  };
}

async function inspectMtplxModelSupport(dirPath) {
  if (String(process.env.LLM3_MTPLX_INSPECT || "").trim().toLowerCase() === "false") {
    return null;
  }
  const binaryPath = String(MTPLX_BINARY || "").trim();
  if (!binaryPath) {
    return null;
  }
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, [
      "inspect",
      "--json",
      "--no-strict-exit-code",
      "--model",
      dirPath,
    ], getExecOptions({
      timeout: MTPLX_INSPECT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }));
    return normalizeMtplxInspectSupport(parseJsonFromCandidates([stdout, stderr]));
  } catch (error) {
    return normalizeMtplxInspectSupport(parseJsonFromCandidates([error?.stdout, error?.stderr]));
  }
}

async function detectMtplxModelSupport(dirPath) {
  const runtimeContractPath = path.join(dirPath, "mtplx_runtime.json");
  const mtpSidecarPath = path.join(dirPath, "mtp.safetensors");
  const [config, modelIndex, hasRuntimeContract, hasMtpSidecar] = await Promise.all([
    readJsonIfExists(path.join(dirPath, "config.json")),
    readJsonIfExists(path.join(dirPath, "model.safetensors.index.json")),
    fs.stat(runtimeContractPath).then((stat) => stat.isFile()).catch(() => false),
    fs.stat(mtpSidecarPath).then((stat) => stat.isFile()).catch(() => false),
  ]);

  const hasEmbeddedWeights = hasEmbeddedMtpWeights(modelIndex);
  const hasMtpMarkers = hasPositiveNumericFieldRecursive(config, "mtp_num_hidden_layers")
    || hasTruthyFieldRecursive(config, "mtp_file")
    || hasTruthyFieldRecursive(config, "mtplx_policy")
    || hasTruthyFieldRecursive(config, "mtplx_mtp_quantization");
  const recognized = hasRuntimeContract || hasMtpSidecar || hasEmbeddedWeights || hasMtpMarkers;
  const inspectedSupport = recognized ? await inspectMtplxModelSupport(dirPath) : null;
  if (inspectedSupport) {
    if (
      !inspectedSupport.canRun
      && hasRuntimeContract
      && hasMtpSidecar
      && inspectedSupport.runtimeCompatibility === "needs-grafting"
      && inspectedSupport.supportLevel === "native-backend-needs-contract-repair"
      && inspectedSupport.mtpMissingExpectedKeys.length === 0
    ) {
      return {
        ...inspectedSupport,
        canRun: true,
        runtimeCompatibility: "native-contracted-sidecar",
        supportLevel: "verified-native-contracted-sidecar",
        hasRuntimeContract,
        hasMtpSidecar,
        hasEmbeddedWeights,
        hasMtpMarkers,
        message: "Runtime contract and complete MTP sidecar found; inspector repair gate reported no missing expected tensors.",
      };
    }
    return {
      ...inspectedSupport,
      hasRuntimeContract,
      hasMtpSidecar,
      hasEmbeddedWeights,
      hasMtpMarkers,
    };
  }
  const canRun = hasRuntimeContract || hasMtpSidecar || hasEmbeddedWeights;

  if (canRun) {
    return {
      recognized: true,
      canRun: true,
      runtimeCompatibility: hasRuntimeContract ? "native" : hasEmbeddedWeights ? "embedded-mtp-weights" : "sidecar-mtp-weights",
      supportLevel: hasRuntimeContract ? "verified-native" : hasEmbeddedWeights ? "native-backend-embedded-mtp-weights" : "native-backend-sidecar-mtp-weights",
      hasRuntimeContract,
      hasMtpSidecar,
      hasEmbeddedWeights,
      hasMtpMarkers,
      message: hasRuntimeContract
        ? "Verified MTPLX runtime contract found."
        : hasEmbeddedWeights
          ? "Embedded MTP tensors found in the MLX weight index."
          : "MTP sidecar weights found for this MLX model.",
    };
  }

  if (recognized) {
    return {
      recognized: true,
      canRun: false,
      runtimeCompatibility: "missing-mtp-weights",
      supportLevel: "native-backend-missing-mtp-weights",
      hasRuntimeContract,
      hasMtpSidecar,
      hasEmbeddedWeights,
      hasMtpMarkers,
      message: "MTPLX markers were detected, but this model does not include runnable MTP weights yet.",
    };
  }

  return {
    recognized: false,
    canRun: false,
    runtimeCompatibility: "unsupported",
    supportLevel: "unsupported",
    hasRuntimeContract,
    hasMtpSidecar,
    hasEmbeddedWeights,
    hasMtpMarkers,
    message: "",
  };
}

async function getDirectorySize(dirPath) {
  const files = await collectFilesRecursive(dirPath);
  let total = 0;
  for (const filePath of files) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) {
      total += stat.size;
    }
  }
  return total;
}

function prettifyModelName(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferModelFamily(value) {
  const source = String(value || "");
  const normalized = prettifyModelName(source).toLowerCase();
  const compact = normalized.replace(/\s+/g, "");
  const known = ["Qwen 3.6", "Qwen 3.5", "Qwen", "Gemma 4", "Gemma", "Llama", "GLM", "Huihui", "Qwopus"];
  const match = known.find((item) => {
    const itemNormalized = prettifyModelName(item).toLowerCase();
    const itemCompact = itemNormalized.replace(/\s+/g, "");
    return normalized.includes(itemNormalized) || compact.includes(itemCompact);
  });
  return match || "Downloaded model";
}

function parseQuantization(value) {
  const upper = String(value || "").toUpperCase();
  const patterns = [
    /UD-Q\d+_[A-Z0-9_]+/,
    /UD-IQ\d+_[A-Z0-9_]+/,
    /IQ\d+_[A-Z0-9_]+/,
    /Q\d+_[A-Z0-9_]+/,
    /Q\d+_[0-9]+_[0-9]+/,
    /Q\d+_[0-9]+/,
    /Q\d+[A-Z_0-9-]*/,
    /MXFP4(?:_MOE)?/,
    /BF16/,
    /F16/,
    /FLOAT16/,
    // MLX repos label quants both ways: a "8bit" repo name and a "4-bit/" folder.
    // \b\d+BIT\b cannot see the hyphenated form, so multi-folder MLX repos came back
    // with no quant label at all. Normalised below so both yield 4BIT / 8BIT.
    /\b\d+-BIT\b/,
    /\b\d+BIT\b/,
  ];
  for (const pattern of patterns) {
    const match = upper.match(pattern);
    if (match) {
      return match[0].replace(/-BIT$/, "BIT");
    }
  }
  return "";
}

function getHfProvider(repoId) {
  return String(repoId || "").split("/")[0].trim();
}

function extractHfRepoIdFromUrl(value) {
  const match = String(value || "").trim().match(/^https?:\/\/(?:www\.)?huggingface\.co\/([^?#]+)/i);
  if (!match) {
    return "";
  }
  const segments = match[1].split("/").map((entry) => entry.trim()).filter(Boolean);
  if (segments.length < 2) {
    return "";
  }
  if (segments[0].toLowerCase() === "models" && segments.length >= 3) {
    return `${segments[1]}/${segments[2]}`;
  }
  if (["datasets", "spaces"].includes(segments[0].toLowerCase())) {
    return "";
  }
  return `${segments[0]}/${segments[1]}`;
}

function collapseSearchValue(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenizeSearchValue(value) {
  return String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function stripHfSearchDecorators(value, options = {}) {
  const quantization = String(options.quantization || "").trim();
  const runtime = String(options.runtime || "").trim();
  let cleaned = String(value || "");
  if (quantization) {
    cleaned = cleaned.replace(new RegExp(escapeRegExp(quantization), "ig"), " ");
  }
  if (runtime) {
    cleaned = cleaned.replace(new RegExp(`\\b${escapeRegExp(runtime)}\\b`, "ig"), " ");
  }
  return cleaned.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseHfSearchQuery(query) {
  const input = String(query || "").trim();
  const raw = extractHfRepoIdFromUrl(input) || input;
  const slashParts = raw.split("/").map((value) => value.trim()).filter(Boolean);
  const provider = slashParts.length > 1 ? slashParts[0] : "";
  const runtimeMatch = raw.match(/\b(gguf|mlx|mtplx)\b/i);
  const runtime = runtimeMatch ? runtimeMatch[1].toLowerCase() : "";
  const quantization = parseQuantization(raw);
  const repoQuery = slashParts.length > 1 ? slashParts.slice(1).join("/") : raw;
  const modelHint = stripHfSearchDecorators(repoQuery, { quantization, runtime });
  const exactRepoIds = uniqueStrings([
    provider && repoQuery && !/\s/.test(repoQuery) ? `${provider}/${repoQuery}` : "",
    provider && modelHint && !/\s/.test(modelHint) ? `${provider}/${modelHint}` : "",
  ]);
  const terms = uniqueStrings(
    tokenizeSearchValue(stripHfSearchDecorators(raw, { quantization, runtime }))
      .filter((term) => term.length > 1)
  );
  return {
    input,
    raw,
    rawLower: raw.toLowerCase(),
    hasQuery: Boolean(raw),
    provider,
    providerLower: provider.toLowerCase(),
    runtime,
    quantization,
    repoQuery,
    modelHint,
    modelHintCollapsed: collapseSearchValue(modelHint),
    collapsed: collapseSearchValue(raw),
    exactRepoIds,
    terms,
  };
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

async function searchHuggingFaceCandidates({ query, sort, direction }) {
  const search = parseHfSearchQuery(query);
  const repos = await fetchHfSearchRepos(search);
  const detailedRepos = await Promise.all(
    repos.slice(0, search.hasQuery ? 36 : 24).map(async (repo) => {
      try {
        return await fetchHfRepoDetails(repo.id);
      } catch (_error) {
        return repo;
      }
    })
  );

  const candidates = detailedRepos.flatMap((repo) => buildHfCandidates(repo, { includeFallback: search.hasQuery }));
  const filteredCandidates = filterHfCandidates(candidates, search);
  const sorted = sortHfCandidates(filteredCandidates.length > 0 ? filteredCandidates : candidates, sort, direction, search);
  return sorted.slice(0, search.hasQuery ? 80 : 120);
}

function buildHfSearchQueries(search) {
  if (!search?.hasQuery) {
    return ["gguf", "mlx"];
  }
  return uniqueStrings([
    search.raw,
    search.provider && search.modelHint ? `${search.provider}/${search.modelHint}` : "",
    search.provider && search.modelHint ? `${search.provider} ${search.modelHint}` : "",
    search.modelHint || search.raw,
    search.runtime ? `${search.modelHint || search.raw} ${search.runtime}` : "",
    search.quantization ? `${search.modelHint || search.raw} ${search.quantization}` : "",
  ]).slice(0, 6);
}

async function fetchHfSearchRepos(search) {
  const queries = buildHfSearchQueries(search);
  const searchLimit = search?.hasQuery ? 36 : 20;
  const [results, exactRepos] = await Promise.all([
    Promise.all(
      queries.map(async (currentQuery) => {
        const url = new URL("https://huggingface.co/api/models");
        url.searchParams.set("search", currentQuery);
        url.searchParams.set("limit", String(searchLimit));
        url.searchParams.set("sort", "downloads");
        url.searchParams.set("direction", "-1");
        url.searchParams.set("full", "true");
        const payload = await fetchHfJson(url.toString()).catch(() => []);
        return Array.isArray(payload) ? payload : [];
      })
    ),
    Promise.all(
      (search?.exactRepoIds || []).map(async (repoId) => {
        try {
          return await fetchHfRepoDetails(repoId);
        } catch (_error) {
          return null;
        }
      })
    ),
  ]);

  const deduped = new Map();
  for (const row of [...exactRepos.filter(Boolean), ...results.flat()]) {
    const repoId = String(row?.id || row?.modelId || "").trim();
    if (repoId && !deduped.has(repoId)) {
      deduped.set(repoId, row);
    }
  }
  return [...deduped.values()];
}

async function fetchHfRepoDetails(repoId) {
  const safeRepoId = String(repoId || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return fetchHfJson(`https://huggingface.co/api/models/${safeRepoId}?blobs=true`);
}

async function fetchHfJson(url) {
  const headers = { "user-agent": HF_USER_AGENT };
  if (process.env.HF_TOKEN) {
    headers.authorization = `Bearer ${process.env.HF_TOKEN}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(HF_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Hugging Face request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

const SPLIT_GGUF_PATTERN = /-(\d{5})-of-(\d{5})\.gguf$/i;

// Shards of one split model collapse to a single key, so "…-00002-of-00003.gguf"
// and "…-00001-of-00003.gguf" are recognized as the same downloadable model.
function ggufSplitGroupKey(filePath) {
  const value = String(filePath || "").trim();
  return SPLIT_GGUF_PATTERN.test(value) ? value.replace(SPLIT_GGUF_PATTERN, ".gguf") : value;
}

// Last line of defence against the "picked Q6_K, downloaded the whole repo" bug.
// A GGUF download may legitimately carry: the other shards of the SAME split
// model, the vision projectors (mmproj-*), non-GGUF sidecars (templates,
// tokenizers), and genuine MTP draft heads. Any OTHER .gguf in the list is a
// different full quantization and must never ride along — bundling those turned
// a 22GB Q6_K pick into a 279GB whole-repo pull. This runs on every enqueue, so
// a stale browser tab or a favorite persisted before the fix cannot replay one.
function pruneForeignQuantFiles(files, options = {}) {
  const entries = Array.isArray(files) ? files : [];
  if (entries.length === 0) {
    return entries;
  }
  const primaryPath = String(options.primaryPath || entries[0]?.path || "").trim();
  if (!/\.gguf$/i.test(primaryPath)) {
    // MLX/repo-snapshot downloads are whole-repo by design; leave them alone.
    return entries;
  }
  const primaryGroup = ggufSplitGroupKey(primaryPath).toLowerCase();
  return entries.filter((entry) => {
    const filePath = String(entry?.path || "").trim();
    if (!filePath || filePath === primaryPath) {
      return true;
    }
    if (!/\.gguf$/i.test(filePath)) {
      return true;
    }
    if (ggufSplitGroupKey(filePath).toLowerCase() === primaryGroup) {
      return true;
    }
    if (isVisionProjectorFile(filePath)) {
      return true;
    }
    return isMtpDraftHeadGgufPath(filePath);
  });
}

function buildHfCandidates(repo, options = {}) {
  const siblings = Array.isArray(repo?.siblings) ? repo.siblings : [];
  const repoId = String(repo?.id || repo?.modelId || "").trim();
  if (!repoId) {
    return [];
  }

  const hfUrl = `https://huggingface.co/${repoId}`;
  const baseCandidate = {
    repoId,
    provider: getHfProvider(repoId),
    hfUrl,
    likes: Number(repo?.likes || 0),
    downloads: Number(repo?.downloads || 0),
    family: inferRepoFamily(repo),
    tags: uniqueStrings(Array.isArray(repo?.tags) ? repo.tags : []),
  };

  const ggufSiblingEntries = siblings.filter((entry) => {
    const name = String(entry?.rfilename || "");
    return /\.gguf$/i.test(name) && !isVisionProjectorFile(name);
  });
  const mainGgufNames = new Set(
    partitionMtpGgufPaths(ggufSiblingEntries.map((entry) => String(entry?.rfilename || ""))).main
  );
  const ggufFiles = ggufSiblingEntries.filter((entry) => mainGgufNames.has(String(entry?.rfilename || "")));
  const mmprojFiles = siblings
    .filter((entry) => isVisionProjectorFile(String(entry?.rfilename || "")))
    .map((entry) => ({
      path: String(entry?.rfilename || "").trim(),
      sizeBytes: Number(entry?.lfs?.size || entry?.size || 0),
    }))
    .filter((entry) => entry.path);
  // Same-repo MTP draft heads (mtp-*.gguf, MTP/*.gguf) are speculative-decoding
  // companions for ANY family — bundle them so a QAT/MTP download is complete.
  const mtpSiblingFiles = ggufSiblingEntries
    .filter((entry) => !mainGgufNames.has(String(entry?.rfilename || "")))
    .map((entry) => ({
      path: String(entry?.rfilename || "").trim(),
      sizeBytes: Number(entry?.lfs?.size || entry?.size || 0),
    }))
    .filter((entry) => entry.path);
  const template = buildChatTemplateSpec(repo, ".llm3-chat-template.jinja");
  // Multi-part GGUFs (…-00001-of-00003.gguf) must be downloaded as a set —
  // llama.cpp loads via the first shard but needs every shard on disk. Group
  // them into a single candidate instead of offering broken per-shard rows.
  const ggufGroups = new Map();
  for (const entry of ggufFiles) {
    const entryPath = String(entry?.rfilename || "").trim();
    if (!entryPath) {
      continue;
    }
    const groupKey = ggufSplitGroupKey(entryPath);
    if (!ggufGroups.has(groupKey)) {
      ggufGroups.set(groupKey, []);
    }
    ggufGroups.get(groupKey).push(entry);
  }
  const candidates = [...ggufGroups.entries()].map(([groupKey, groupEntries]) => {
    groupEntries.sort((left, right) => String(left?.rfilename || "").localeCompare(String(right?.rfilename || "")));
    const partFiles = groupEntries.map((part) => ({
      path: String(part?.rfilename || "").trim(),
      sizeBytes: Number(part?.lfs?.size || part?.size || 0),
    }));
    const filePath = partFiles[0].path;
    const fileName = path.basename(groupKey);
    const sizeBytes = partFiles.reduce((sum, part) => sum + part.sizeBytes, 0);
    const quantization = parseQuantization(fileName);
    let mtpDraft = buildGemmaMtpDraftSpec(repo, groupKey);
    if (!mtpDraft && mtpSiblingFiles.length > 0) {
      mtpDraft = {
        repoId,
        revision: String(repo?.sha || "main"),
        sourcePath: mtpSiblingFiles[0].path,
        outputPath: mtpSiblingFiles[0].path,
        sizeBytes: mtpSiblingFiles[0].sizeBytes,
      };
    }
    const mtpFiles = mtpDraft ? [{
      path: mtpDraft.outputPath,
      sourcePath: mtpDraft.sourcePath,
      repoId: mtpDraft.repoId,
      revision: mtpDraft.revision,
      sizeBytes: Number(mtpDraft.sizeBytes || 0),
    }] : [];
    for (const sibling of mtpSiblingFiles) {
      if (!mtpFiles.some((existing) => existing.path === sibling.path)) {
        mtpFiles.push({ ...sibling });
      }
    }
    return {
      id: `gguf:${repoId}:${filePath}`,
      name: fileName,
      fullName: `${repoId}/${fileName}`,
      runtime: "gguf",
      quantization,
      vision: mmprojFiles.length > 0,
      sizeBytes,
      sizeLabel: formatBytes(sizeBytes),
      ...(partFiles.length > 1 ? { multiPart: partFiles.length } : {}),
      ...baseCandidate,
      downloadSpec: {
        type: "single-file",
        runtime: "gguf",
        repoId,
        revision: String(repo?.sha || "main"),
        files: [...partFiles, ...mmprojFiles, ...mtpFiles],
      },
      template,
      ...(mtpDraft ? { mtpDraft } : {}),
    };
  });

  if (candidates.length > 0) {
    return candidates;
  }

  if (isLikelyMlxRepo(repo)) {
    const mlxTemplate = buildChatTemplateSpec(repo, "chat_template.jinja");
    const runtime = repoHasMtplxArtifacts(repo) ? "mtplx" : "mlx";
    const revision = String(repo?.sha || "main");
    const leafName = repoId.split("/").at(-1) || repoId;
    const { models, companions } = groupMlxModelDirectories(siblings);
    // The draft head rides along with every variant, keeping its own folder so the
    // runtime can still find it; it is small next to the weights.
    const companionFiles = companions.flatMap(({ entries }) => selectMlxDownloadFiles(entries));

    if (models.length > 0) {
      const mlxCandidates = models.map(({ dir, entries }) => {
        const dirFiles = selectMlxDownloadFiles(entries).map((entry) => ({
          // Flatten the folder locally: MLX expects config.json beside the weights,
          // not nested under 4-bit/. sourcePath stays the real repo path.
          path: dir ? entry.path.slice(dir.length + 1) : entry.path,
          sourcePath: entry.path,
          sizeBytes: entry.sizeBytes,
        }));
        const files = [...dirFiles, ...companionFiles];
        const sizeBytes = files.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0);
        return {
          id: dir ? `${runtime}:${repoId}:${dir}` : `${runtime}:${repoId}`,
          name: dir ? `${leafName} · ${dir}` : leafName,
          fullName: dir ? `${repoId}/${dir}` : repoId,
          runtime,
          // The folder name is the most reliable quant label in these repos.
          quantization: parseQuantization(dir) || parseQuantization([repoId, ...repo.tags || []].join(" ")),
          vision: repoSupportsVision(repo),
          sizeBytes,
          sizeLabel: formatBytes(sizeBytes),
          ...baseCandidate,
          // Keeps each variant in its own directory; without it every quant in the
          // repo would download over the top of the previous one.
          ...(dir ? { directory: dir } : {}),
          downloadSpec: {
            type: "repo-snapshot",
            runtime,
            repoId,
            revision,
            files,
          },
          template: mlxTemplate,
        };
      });
      if (mlxCandidates.length > 0) {
        return mlxCandidates;
      }
    }

    // No recognisable model folder (unusual layout): fall back to the old
    // whole-repo snapshot rather than showing nothing.
    const files = selectMlxDownloadFiles(siblings);
    if (files.length > 0) {
      const sizeBytes = files.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0);
      return [
        {
          id: `${runtime}:${repoId}`,
          name: leafName,
          fullName: repoId,
          runtime,
          quantization: parseQuantization([repoId, ...repo.tags || []].join(" ")),
          vision: repoSupportsVision(repo),
          sizeBytes,
          sizeLabel: formatBytes(sizeBytes),
          ...baseCandidate,
          downloadSpec: {
            type: "repo-snapshot",
            runtime,
            repoId,
            revision,
            files,
          },
          template: mlxTemplate,
        },
      ];
    }
  }

  if (!options.includeFallback) {
    return [];
  }

  return [buildHfBrowseCandidate(repo, baseCandidate)].filter(Boolean);
}

// A genuine MTP *draft head* is a small, SEPARATE GGUF whose name advertises MTP
// but carries NO quantization token — e.g. mtp-gemma-4-31B-it.gguf or
// model-mtp-draft.gguf. Those are speculative-decoding companions and get
// bundled with the model they accelerate.
//
// A file whose name advertises MTP but ALSO carries a real quant token
// (…-MTP-Q6_K.gguf, …-MTP-IQ4_XS.gguf, MTP/model-MTP-Q8_0.gguf) is a FULL
// alternate quantization, NOT a draft head, and must stay its own selectable
// row. Treating those as companions made selecting one quant drag in every other
// quant in the repo: DavidAU-style repos name all ~15 quants "…-MTP-<quant>.gguf",
// which turned a 27.7GB single-file download into a 285GB whole-repo pull.
function isMtpDraftHeadGgufPath(value) {
  const lower = String(value || "").toLowerCase();
  if (!lower.endsWith(".gguf")) {
    return false;
  }
  const base = lower.split("/").pop() || "";
  // Draft sidecars live in an MTP/ directory or use an "mtp-" basename prefix
  // (e.g. MTP/gemma-4-31B-it-MTP-Q8_0.gguf, mtp-gemma-4-31B-it.gguf).
  if (/(?:^|\/)mtp\//.test(lower) || base.startsWith("mtp-")) {
    return true;
  }
  // A top-level "-mtp" name is only a draft head when it is NOT a full quant:
  // "…-MTP-Q6_K.gguf" (quant terminal) is a full alternate quantization and must
  // stay a selectable row, while "…-Q8_0-MTP.gguf" or "model-mtp-draft.gguf"
  // (quant non-terminal or absent) is a draft head. Bundling full quants as
  // companions turned a 27.7GB DavidAU download into a 285GB whole-repo pull.
  if (!/-mtp(?:-|\.gguf$)/.test(base)) {
    return false;
  }
  const stem = base.replace(/\.gguf$/, "");
  const quant = parseQuantization(stem);
  const endsWithQuant = quant !== "" && stem.toUpperCase().endsWith(quant);
  return !endsWithQuant;
}

function partitionMtpGgufPaths(paths) {
  const main = [];
  const drafts = [];
  for (const value of paths) {
    (isMtpDraftHeadGgufPath(value) ? drafts : main).push(value);
  }
  // A repo can't be all draft heads and no model; surface them as main rather
  // than hiding the repo from the Models list entirely.
  if (main.length === 0 && drafts.length > 0) {
    return { main: drafts, drafts: [] };
  }
  return { main, drafts };
}

function buildGemmaMtpDraftSpec(repo, modelPath) {
  const repoId = String(repo?.id || repo?.modelId || "").trim();
  const revision = String(repo?.sha || "main").trim() || "main";
  if (!repoId || inferRepoFamily(repo) !== "Gemma 4") {
    return null;
  }

  const stem = deriveGemmaMtpStem(path.basename(String(modelPath || "").trim()));
  if (!stem) {
    return null;
  }

  const siblings = Array.isArray(repo?.siblings) ? repo.siblings : [];
  const sameRepoCandidates = [
    `mtp-${stem}.gguf`,
    `MTP/${stem}-Q8_0-MTP.gguf`,
    `MTP/${stem}-MTP-Q8_0.gguf`,
  ];
  const localSibling = sameRepoCandidates
    .map((sourcePath) => {
      const sibling = siblings.find((entry) => String(entry?.rfilename || "").trim().toLowerCase() === sourcePath.toLowerCase());
      return sibling ? { sibling, sourcePath } : null;
    })
    .find(Boolean);

  if (localSibling) {
    return {
      repoId,
      revision,
      sourcePath: localSibling.sourcePath,
      outputPath: localSibling.sourcePath,
      sizeBytes: Number(localSibling.sibling?.lfs?.size || localSibling.sibling?.size || 0),
    };
  }

  const fallbackRepoId = repoId.replace(/-qat-gguf$/i, "-GGUF");
  if (!fallbackRepoId || fallbackRepoId === repoId) {
    return null;
  }

  const fallbackSourcePath = `MTP/${stem}-MTP-Q8_0.gguf`;
  return {
    repoId: fallbackRepoId,
    revision: "main",
    sourcePath: fallbackSourcePath,
    outputPath: fallbackSourcePath,
    sizeBytes: 0,
  };
}

function deriveGemmaMtpStem(fileName) {
  const raw = String(fileName || "").trim();
  if (!/\.gguf$/i.test(raw)) {
    return "";
  }
  let stem = raw.replace(/\.gguf$/i, "");
  stem = stem.replace(/-qat(?=-|$)/i, "");
  stem = stem.replace(/-(?:UD-[A-Z0-9_]+|IQ\d+[A-Z0-9_]*|Q\d+[A-Z0-9_]*|BF16|F16|FLOAT16)$/i, "");
  return /^gemma-4-.*-it$/i.test(stem) ? stem : "";
}

function buildHfBrowseCandidate(repo, baseCandidate = {}) {
  const repoId = String(repo?.id || repo?.modelId || "").trim();
  if (!repoId) {
    return null;
  }
  const tags = uniqueStrings(Array.isArray(repo?.tags) ? repo.tags : []);
  const sizeBytes = Number(repo?.usedStorage || 0);
  const template = buildChatTemplateSpec(repo, ".llm3-chat-template.jinja");
  const baseModelRepoId = extractBaseModelRepoId(repo);
  const quantizationMethod = String(repo?.config?.quantization_config?.quant_method || "").trim().toLowerCase();
  const libraryName = String(repo?.library_name || "").trim();
  return {
    ...baseCandidate,
    id: `repo:${repoId}`,
    name: repoId.split("/").at(-1) || repoId,
    fullName: repoId,
    runtime: inferHfRepoRuntime(repo),
    quantization: parseQuantization([repoId, ...tags].join(" ")),
    vision: repoSupportsVision(repo),
    ...(libraryName ? { libraryName } : {}),
    ...(baseModelRepoId ? { baseModelRepoId } : {}),
    ...(quantizationMethod ? { quantizationMethod } : {}),
    sizeBytes,
    sizeLabel: sizeBytes > 0 ? formatBytes(sizeBytes) : "n/a",
    browseOnly: true,
    ...(template ? { template } : {}),
  };
}

function inferRepoFamily(repo) {
  const baseModelRepoId = extractBaseModelRepoId(repo);
  if (baseModelRepoId) {
    const raw = baseModelRepoId;
    const label = raw.split("/").at(-1) || raw;
    const inferred = inferModelFamily(label);
    if (inferred !== "Downloaded model") {
      return inferred;
    }
  }
  return inferModelFamily(String(repo?.id || ""));
}

function extractBaseModelRepoId(repo) {
  const tags = Array.isArray(repo?.tags) ? repo.tags : [];
  const preferred = tags.find((tag) => {
    const value = String(tag || "");
    return value.startsWith("base_model:") && !value.startsWith("base_model:quantized:");
  });
  const fallback = preferred || tags.find((tag) => String(tag || "").startsWith("base_model:"));
  if (!fallback) {
    return "";
  }
  const parts = String(fallback).split(":").slice(1).map((value) => value.trim()).filter(Boolean);
  if (parts[0] === "quantized") {
    parts.shift();
  }
  return parts.join(":").trim();
}

function findSiblingPath(siblings, fileName) {
  const target = String(fileName || "").toLowerCase();
  if (!target) {
    return "";
  }
  const match = (Array.isArray(siblings) ? siblings : []).find((entry) => {
    const siblingPath = String(entry?.rfilename || "").trim();
    return siblingPath && siblingPath.toLowerCase() === target;
  });
  return String(match?.rfilename || "").trim();
}

function buildChatTemplateSpec(repo, outputPath = ".llm3-chat-template.jinja") {
  const repoId = String(repo?.id || repo?.modelId || "").trim();
  if (!repoId) {
    return null;
  }
  const siblings = Array.isArray(repo?.siblings) ? repo.siblings : [];
  const revision = String(repo?.sha || "main").trim() || "main";
  const baseModelRepoId = extractBaseModelRepoId(repo);
  const sourceRepoIds = uniqueStrings([repoId, baseModelRepoId]);
  const sources = [];

  for (const sourceRepoId of sourceRepoIds) {
    if (sourceRepoId === repoId) {
      const chatTemplatePath = findSiblingPath(siblings, "chat_template.jinja");
      const chatTemplateJsonPath = findSiblingPath(siblings, "chat_template.json");
      const tokenizerConfigPath = findSiblingPath(siblings, "tokenizer_config.json");
      if (chatTemplatePath) {
        sources.push({ repoId: sourceRepoId, revision, path: chatTemplatePath });
      }
      if (chatTemplateJsonPath) {
        sources.push({ repoId: sourceRepoId, revision, path: chatTemplateJsonPath });
      }
      if (tokenizerConfigPath) {
        sources.push({ repoId: sourceRepoId, revision, path: tokenizerConfigPath });
      }
      continue;
    }
    sources.push(
      { repoId: sourceRepoId, revision: "main", path: "chat_template.jinja" },
      { repoId: sourceRepoId, revision: "main", path: "chat_template.json" },
      { repoId: sourceRepoId, revision: "main", path: "tokenizer_config.json" },
    );
  }

  if (sources.length === 0) {
    return null;
  }
  return {
    outputPath,
    sources,
  };
}

function repoHasMlxNaming(repo) {
  const repoId = String(repo?.id || repo?.modelId || "").toLowerCase();
  const tags = (Array.isArray(repo?.tags) ? repo.tags : []).map((value) => String(value || "").toLowerCase());
  const libraryName = String(repo?.library_name || "").toLowerCase();
  return (
    libraryName === "mlx" ||
    libraryName === "mtplx" ||
    repoId.includes("mlx") ||
    repoId.includes("mtplx") ||
    tags.some((tag) => tag.includes("mlx") || tag.includes("mtplx"))
  );
}

function isLikelyMlxRepo(repo) {
  return repoHasMlxNaming(repo) || repoHasMtplxArtifacts(repo);
}

function repoHasMtplxArtifacts(repo) {
  const siblings = Array.isArray(repo?.siblings) ? repo.siblings : [];
  const names = new Set(
    siblings
      .map((entry) => String(entry?.rfilename || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (names.has("mtplx_runtime.json")) {
    return true;
  }
  // mtp.safetensors alone is NOT an MTPLX marker: upstream PyTorch repos
  // (Qwen3.8-27B-FP8 and friends) ship the MTP head next to the safetensors
  // weights. Treating those as MLX snapshots gave them runtime "mtplx", which
  // the download endpoint rejects ("candidate is required.") and which hides
  // the Convert-to-GGUF action. Only count it inside an MLX-flavoured repo,
  // where it distinguishes an MTPLX conversion from a plain MLX one.
  if (names.has("mtp.safetensors") && repoHasMlxNaming(repo)) {
    return true;
  }
  const repoText = [
    repo?.id,
    repo?.modelId,
    repo?.library_name,
    ...(Array.isArray(repo?.tags) ? repo.tags : []),
  ].join(" ").toLowerCase();
  return repoText.includes("mtplx");
}

// An MLX repo often ships several complete models in sibling folders (4-bit/, 6-bit/,
// 8-bit/) with an optional mtp/ draft head, and sometimes a model at the root as well.
// selectMlxDownloadFiles() used to hand back every sibling as ONE candidate, so the tab
// offered a single row that would have pulled every quant into one directory -- ~82 GiB
// for orcarouter/Qwen3.8-27B-MLX, and unloadable, since MLX wants exactly one
// config.json beside its weights. Split the repo into one candidate per model folder.
const MLX_WEIGHT_PATTERN = /\.(safetensors|npz)$/i;

function isMtpCompanionDir(dir) {
  return /(^|[-_/])mtp([-_/]|$)/i.test(String(dir || ""));
}

// A folder is a model when it holds a config.json next to at least one weight shard.
// "" is the repo root, which counts too when the root itself carries a model.
function groupMlxModelDirectories(siblings) {
  const byDir = new Map();
  for (const entry of siblings) {
    const filePath = String(entry?.rfilename || "").trim();
    if (!filePath) {
      continue;
    }
    const slash = filePath.lastIndexOf("/");
    const dir = slash === -1 ? "" : filePath.slice(0, slash);
    if (!byDir.has(dir)) {
      byDir.set(dir, []);
    }
    byDir.get(dir).push(entry);
  }
  const models = [];
  const companions = [];
  for (const [dir, entries] of byDir) {
    const names = entries.map((entry) => path.basename(String(entry?.rfilename || "")));
    const hasConfig = names.some((name) => name.toLowerCase() === "config.json");
    const hasWeights = names.some((name) => MLX_WEIGHT_PATTERN.test(name));
    if (!hasConfig || !hasWeights) {
      continue;
    }
    // mtp/ carries a config.json and weights too, but it is a speculative-decoding
    // draft head, not something anyone wants to chat with. Same call the GGUF path
    // already makes for mtp-*.gguf.
    (isMtpCompanionDir(dir) ? companions : models).push({ dir, entries });
  }
  return { models, companions };
}

function selectMlxDownloadFiles(siblings) {
  const docPattern = /\.(md|png|jpg|jpeg|gif|webp|svg|html)$/i;
  return siblings
    .map((entry) => ({
      path: String(entry?.rfilename || "").trim(),
      sizeBytes: Number(entry?.lfs?.size || entry?.size || 0),
    }))
    .filter((entry) => {
      const filePath = entry.path;
      if (!filePath || filePath === ".gitattributes") {
        return false;
      }
      if (docPattern.test(filePath)) {
        return false;
      }
      return true;
    });
}

function matchesHfSearchQuantization(candidate, quantization) {
  const target = String(quantization || "").toUpperCase();
  if (!target) {
    return true;
  }
  return [candidate?.quantization, candidate?.fullName, candidate?.repoId, ...(candidate?.tags || [])]
    .some((value) => String(value || "").toUpperCase().includes(target));
}

function buildHfCandidateSearchText(candidate) {
  return [
    candidate?.provider,
    candidate?.repoId,
    candidate?.fullName,
    candidate?.runtime,
    candidate?.family,
    candidate?.quantization,
    ...(candidate?.tags || []),
  ].join(" ");
}

function inferHfRepoRuntime(repo) {
  const libraryName = String(repo?.library_name || "").trim().toLowerCase();
  if (libraryName) {
    return libraryName;
  }
  const tags = (Array.isArray(repo?.tags) ? repo.tags : []).map((value) => String(value || "").toLowerCase());
  if (tags.includes("mlx") || tags.some((tag) => tag.includes("mlx"))) {
    return "mlx";
  }
  if (tags.includes("gguf") || tags.some((tag) => tag.includes("gguf"))) {
    return "gguf";
  }
  const pipelineTag = String(repo?.pipeline_tag || "").trim().toLowerCase();
  return pipelineTag || "other";
}

function repoSupportsVision(repo) {
  const pipelineTag = String(repo?.pipeline_tag || "").trim().toLowerCase();
  if (pipelineTag === "image-text-to-text") {
    return true;
  }
  const tags = Array.isArray(repo?.tags) ? repo.tags : [];
  const text = [pipelineTag, ...tags].join(" ").toLowerCase();
  return /(vision|vl|image-text-to-text|multimodal|qwen2vl|qwen25vl|qwen25o)/.test(text);
}

function scoreHfCandidate(candidate, search) {
  if (!search?.hasQuery) {
    return 0;
  }

  const provider = String(candidate?.provider || getHfProvider(candidate?.repoId)).toLowerCase();
  const runtime = String(candidate?.runtime || "").toLowerCase();
  const repoId = String(candidate?.repoId || "").toLowerCase();
  const fullName = String(candidate?.fullName || "").toLowerCase();
  const exactRepoMatch = (search.exactRepoIds || []).some((repo) => String(repo || "").toLowerCase() === repoId);

  if (exactRepoMatch) {
    let exactScore = 5000;
    if (search.runtime && runtime === search.runtime) {
      exactScore += 150;
    }
    if (search.quantization && matchesHfSearchQuantization(candidate, search.quantization)) {
      exactScore += 250;
    }
    return exactScore;
  }

  if (search.providerLower && provider !== search.providerLower) {
    return Number.NEGATIVE_INFINITY;
  }
  if (search.runtime && runtime !== search.runtime) {
    return Number.NEGATIVE_INFINITY;
  }
  if (search.quantization && !matchesHfSearchQuantization(candidate, search.quantization)) {
    return Number.NEGATIVE_INFINITY;
  }

  const searchText = buildHfCandidateSearchText(candidate);
  const searchTextLower = searchText.toLowerCase();
  const searchTextCollapsed = collapseSearchValue(searchText);
  let matchedSomething = false;

  if (search.modelHintCollapsed && !searchTextCollapsed.includes(search.modelHintCollapsed) && (search.providerLower || search.quantization || search.runtime)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  if (search.collapsed && searchTextCollapsed === search.collapsed) {
    score += 2400;
    matchedSomething = true;
  } else if (search.collapsed && searchTextCollapsed.includes(search.collapsed)) {
    score += 1600;
    matchedSomething = true;
  }
  if (repoId === search.rawLower || fullName === search.rawLower) {
    score += 2200;
    matchedSomething = true;
  } else if (search.rawLower && (repoId.includes(search.rawLower) || fullName.includes(search.rawLower))) {
    score += 900;
    matchedSomething = true;
  }
  if (search.modelHintCollapsed && searchTextCollapsed.includes(search.modelHintCollapsed)) {
    score += 800;
    matchedSomething = true;
  }

  let matchedTerms = 0;
  for (const term of search.terms) {
    if (searchTextLower.includes(term)) {
      matchedTerms += 1;
      score += 90;
      matchedSomething = true;
    }
  }
  if (search.terms.length > 1 && matchedTerms === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  if (search.providerLower) {
    score += 300;
  }
  if (search.quantization) {
    score += 250;
  }
  if (search.runtime) {
    score += 150;
  }
  if (!matchedSomething) {
    return Number.NEGATIVE_INFINITY;
  }
  return score;
}

function filterHfCandidates(candidates, search) {
  if (!search?.hasQuery) {
    return candidates;
  }
  return candidates.filter((candidate) => Number.isFinite(scoreHfCandidate(candidate, search)));
}

function sortHfCandidates(candidates, sort, direction, search) {
  const field = ["downloads", "likes", "name", "size"].includes(String(sort)) ? String(sort) : "downloads";
  const multiplier = String(direction).toLowerCase() === "asc" ? 1 : -1;
  return [...candidates].sort((left, right) => {
    if (search?.hasQuery) {
      const scoreDelta = scoreHfCandidate(right, search) - scoreHfCandidate(left, search);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
    }
    if (field === "name") {
      return multiplier * String(left.fullName || "").localeCompare(String(right.fullName || ""));
    }
    if (field === "size") {
      return multiplier * ((Number(left.sizeBytes || 0) - Number(right.sizeBytes || 0)) || String(left.fullName || "").localeCompare(String(right.fullName || "")));
    }
    return multiplier * ((Number(left[field] || 0) - Number(right[field] || 0)) || String(left.fullName || "").localeCompare(String(right.fullName || "")));
  });
}

function normalizeDownloadCandidate(candidate) {
  const repoId = String(candidate?.repoId || candidate?.downloadSpec?.repoId || "").trim();
  const runtime = String(candidate?.runtime || candidate?.downloadSpec?.runtime || "").trim();
  // "mtplx" is a first-class runtime everywhere else (launchers, status, logs);
  // leaving it out here made every genuine MTPLX repo fail with the misleading
  // "candidate is required." on download.
  if (!repoId || !["gguf", "mlx", "mtplx"].includes(runtime)) {
    return null;
  }

  const rawFiles = Array.isArray(candidate?.downloadSpec?.files)
    ? candidate.downloadSpec.files.map((entry) => {
        const normalized = {
          path: String(entry?.path || "").replace(/^\/+/, ""),
          sizeBytes: Number(entry?.sizeBytes || 0),
        };
        // Companion files (MTP drafts via cross-repo fallback) carry their own
        // repo/source/revision; the worker consumes these per-file overrides.
        const fileRepoId = String(entry?.repoId || "").trim();
        const fileSourcePath = String(entry?.sourcePath || "").replace(/^\/+/, "");
        const fileRevision = String(entry?.revision || "").trim();
        if (fileRepoId && !fileRepoId.includes("..")) {
          normalized.repoId = fileRepoId;
        }
        if (fileSourcePath && !fileSourcePath.includes("..")) {
          normalized.sourcePath = fileSourcePath;
        }
        if (fileRevision && !fileRevision.includes("..")) {
          normalized.revision = fileRevision;
        }
        return normalized;
      }).filter((entry) => entry.path && !entry.path.includes(".."))
    : [];
  const files = pruneForeignQuantFiles(rawFiles);
  if (files.length === 0) {
    return null;
  }

  const template = normalizeDownloadTemplate(candidate?.template);
  // A draft head that the prune above rejected is a full quant in disguise;
  // keeping it would record a sidecar path that never lands on disk.
  const filePaths = new Set(files.map((entry) => entry.path));
  const rawMtpDraft = normalizeDownloadMtpDraft(candidate?.mtpDraft);
  const mtpDraft = rawMtpDraft && filePaths.has(rawMtpDraft.outputPath) ? rawMtpDraft : null;

  return {
    id: String(candidate?.id || `${runtime}:${repoId}`).trim(),
    label: String(candidate?.fullName || candidate?.label || candidate?.name || repoId).trim(),
    fullName: String(candidate?.fullName || candidate?.label || candidate?.name || repoId).trim(),
    name: String(candidate?.name || repoId.split("/").at(-1) || repoId).trim(),
    repoId,
    runtime,
    family: String(candidate?.family || inferModelFamily(repoId)).trim(),
    hfUrl: String(candidate?.hfUrl || `https://huggingface.co/${repoId}`).trim(),
    quantization: String(candidate?.quantization || "").trim(),
    likes: Number(candidate?.likes || 0),
    downloads: Number(candidate?.downloads || 0),
    sizeBytes: Number(candidate?.sizeBytes || files.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0)),
    sizeLabel: formatBytes(Number(candidate?.sizeBytes || files.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0))),
    downloadSpec: {
      type: String(candidate?.downloadSpec?.type || (runtime === "gguf" ? "single-file" : "repo-snapshot")).trim(),
      runtime,
      repoId,
      revision: String(candidate?.downloadSpec?.revision || "main").trim() || "main",
      files,
    },
    // Which folder inside the repo this variant came from. enqueueHfDownload needs it
    // to give each quant its own target directory; dropping it here made every variant
    // of a multi-folder repo download over the top of the last one.
    ...(String(candidate?.directory || "").trim() && !String(candidate.directory).includes("..")
      ? { directory: String(candidate.directory).trim() }
      : {}),
    ...(template ? { template } : {}),
    ...(mtpDraft ? { mtpDraft } : {}),
  };
}

function normalizeDownloadMtpDraft(mtpDraft) {
  if (!mtpDraft || typeof mtpDraft !== "object") {
    return null;
  }
  const outputPath = String(mtpDraft.outputPath || mtpDraft.path || "").replace(/^\/+/, "");
  if (!outputPath || outputPath.includes("..")) {
    return null;
  }
  const normalized = { outputPath, sizeBytes: Number(mtpDraft.sizeBytes || 0) };
  const repoId = String(mtpDraft.repoId || "").trim();
  const sourcePath = String(mtpDraft.sourcePath || "").replace(/^\/+/, "");
  const revision = String(mtpDraft.revision || "").trim();
  if (repoId && !repoId.includes("..")) {
    normalized.repoId = repoId;
  }
  if (sourcePath && !sourcePath.includes("..")) {
    normalized.sourcePath = sourcePath;
  }
  if (revision && !revision.includes("..")) {
    normalized.revision = revision;
  }
  return normalized;
}

const UNSUPPORTED_HF_CONVERSION_QUANT_METHODS = new Set([
  "auto-round",
  "autoround",
  "awq",
  "bitsandbytes",
  "bnb",
  "exl2",
  "gptq",
  "modelopt",
]);

const UNSUPPORTED_HF_CONVERSION_LIBRARY_MARKERS = [
  "model optimizer",
  "modelopt",
];

function normalizeConversionSourceHints(candidate) {
  const tags = uniqueStrings(Array.isArray(candidate?.tags) ? candidate.tags : []);
  const normalizedTags = tags.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  const quantizationMethod = String(candidate?.quantizationMethod || "").trim().toLowerCase()
    || (normalizedTags.includes("auto-round") || normalizedTags.includes("autoround")
      ? "auto-round"
      : normalizedTags.includes("awq")
        ? "awq"
        : normalizedTags.includes("gptq")
          ? "gptq"
          : normalizedTags.includes("modelopt")
            ? "modelopt"
            : "");
  const libraryName = String(candidate?.libraryName || candidate?.library_name || "").trim();
  return { tags, normalizedTags, quantizationMethod, libraryName };
}

function describeUnsupportedConversionSource(candidate) {
  const { normalizedTags, quantizationMethod, libraryName } = normalizeConversionSourceHints(candidate);
  if (UNSUPPORTED_HF_CONVERSION_QUANT_METHODS.has(quantizationMethod)) {
    return `unsupported quantization method "${quantizationMethod}"`;
  }
  const normalizedLibrary = libraryName.toLowerCase();
  if (normalizedLibrary && UNSUPPORTED_HF_CONVERSION_LIBRARY_MARKERS.some((marker) => normalizedLibrary.includes(marker))) {
    return `unsupported library "${libraryName}"`;
  }
  if (normalizedTags.includes("modelopt")) {
    return "unsupported ModelOpt quantization";
  }
  return "";
}

function normalizeConversionCandidate(candidate) {
  const repoId = String(candidate?.repoId || "").trim();
  if (!repoId) {
    return null;
  }
  const runtime = String(candidate?.runtime || "").trim().toLowerCase();
  if (!runtime || ["gguf", "mlx", "dflash"].includes(runtime)) {
    return null;
  }
  const { tags, quantizationMethod, libraryName } = normalizeConversionSourceHints(candidate);
  const template = normalizeDownloadTemplate(candidate?.template);
  const baseModelRepoId = String(candidate?.baseModelRepoId || extractBaseModelRepoId({ tags }) || "").trim();
  const unsupportedReason = describeUnsupportedConversionSource({ tags, quantizationMethod, libraryName });
  const conversionRepoId = unsupportedReason && baseModelRepoId ? baseModelRepoId : repoId;
  const blockedReason = unsupportedReason && !baseModelRepoId
    ? `This repo uses ${unsupportedReason}, so it cannot be converted directly to GGUF.`
    : "";
  return {
    id: String(candidate?.id || `repo:${repoId}`).trim(),
    label: String(candidate?.fullName || candidate?.label || candidate?.name || repoId).trim(),
    fullName: String(candidate?.fullName || candidate?.label || candidate?.name || repoId).trim(),
    name: String(candidate?.name || repoId.split("/").at(-1) || repoId).trim(),
    repoId,
    runtime,
    family: String(candidate?.family || inferModelFamily(repoId)).trim(),
    hfUrl: String(candidate?.hfUrl || `https://huggingface.co/${repoId}`).trim(),
    quantization: String(candidate?.quantization || "").trim(),
    likes: Number(candidate?.likes || 0),
    downloads: Number(candidate?.downloads || 0),
    sizeBytes: Number(candidate?.sizeBytes || 0),
    sizeLabel: String(candidate?.sizeLabel || (candidate?.sizeBytes ? formatBytes(candidate.sizeBytes) : "n/a")).trim(),
    tags,
    ...(libraryName ? { libraryName } : {}),
    ...(baseModelRepoId ? { baseModelRepoId } : {}),
    ...(quantizationMethod ? { quantizationMethod } : {}),
    ...(conversionRepoId ? { conversionRepoId } : {}),
    ...(blockedReason ? { conversionBlockedReason: blockedReason } : {}),
    browseOnly: true,
    ...(template ? { template } : {}),
  };
}

function normalizeDownloadTemplate(template) {
  const outputPath = String(template?.outputPath || "").replace(/^\/+/, "").trim();
  if (!outputPath || outputPath.includes("..")) {
    return null;
  }
  const sources = Array.isArray(template?.sources)
    ? template.sources.map((entry) => ({
        repoId: String(entry?.repoId || "").trim(),
        revision: String(entry?.revision || "main").trim() || "main",
        path: String(entry?.path || "").replace(/^\/+/, "").trim(),
      })).filter((entry) => entry.repoId && entry.path && !entry.path.includes(".."))
    : [];
  if (sources.length === 0) {
    return null;
  }
  return { outputPath, sources };
}

// The browser posts back a candidate it may have been holding for days — an open
// SPA tab, or a favorite persisted in localStorage. Rebuild the file list from
// the live repo listing so the download always reflects TODAY's resolver, not
// whatever the client cached. Conversions already do this via fetchHfRepoDetails.
async function resolveHfDownloadCandidate(candidate) {
  const repoId = String(candidate?.repoId || "").trim();
  const primaryPath = String(candidate?.downloadSpec?.files?.[0]?.path || "").trim();
  let repo = null;
  try {
    repo = await fetchHfRepoDetails(repoId);
  } catch (_error) {
    // Offline or rate-limited: fall back to the client's spec, which
    // normalizeDownloadCandidate has already pruned of foreign quants.
    return candidate;
  }

  const rebuilt = buildHfCandidates(repo);
  const match = rebuilt.find((entry) => entry.id === candidate.id)
    || rebuilt.find((entry) => String(entry?.downloadSpec?.files?.[0]?.path || "") === primaryPath)
    || rebuilt.find((entry) => String(entry?.name || "") === String(candidate?.name || ""));
  if (match) {
    const normalized = normalizeDownloadCandidate({ ...match, id: candidate.id });
    if (normalized) {
      return normalized;
    }
  }

  const siblings = Array.isArray(repo?.siblings) ? repo.siblings : [];
  if (primaryPath && !siblings.some((entry) => String(entry?.rfilename || "").trim() === primaryPath)) {
    throw new Error(`${primaryPath} is no longer in ${repoId}. Re-run the search and pick the file again.`);
  }
  return candidate;
}

async function enqueueHfDownload(candidate) {
  const resolved = await resolveHfDownloadCandidate(candidate);
  return enqueueHfJob({
    kind: "download",
    candidate: resolved,
    totalBytes: resolved.downloadSpec.files.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0),
    targetDir: path.join(
      HF_MODELS_ROOT,
      sanitizeRepoId(resolved.directory ? `${resolved.repoId}/${resolved.directory}` : resolved.repoId)
    ),
  });
}

const CONVERSION_SOURCE_SUBDIR = ".source";
// Top-level repo files the converter needs besides the weights themselves.
const CONVERSION_SUPPORT_FILES = new Set([
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "tokenizer.model",
  "special_tokens_map.json",
  "vocab.json",
  "merges.txt",
  "added_tokens.json",
  "chat_template.json",
  "chat_template.jinja",
  "preprocessor_config.json",
  "video_preprocessor_config.json",
  "processor_config.json",
  "model.safetensors.index.json",
  "pytorch_model.bin.index.json",
]);

function normalizeConversionQuantization(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) {
    return DEFAULT_CONVERSION_QUANTIZATION;
  }
  if (!CONVERSION_QUANT_PLANS[normalized]) {
    throw new Error(`Unsupported quantization "${normalized}". Choose one of: ${Object.keys(CONVERSION_QUANT_PLANS).join(", ")}.`);
  }
  return normalized;
}

function selectConversionSourceFiles(repo) {
  const siblings = Array.isArray(repo?.siblings) ? repo.siblings : [];
  const entries = siblings
    .map((entry) => ({
      path: String(entry?.rfilename || "").trim(),
      sizeBytes: Number(entry?.lfs?.size || entry?.size || 0),
    }))
    .filter((entry) => entry.path && !entry.path.includes("..") && !entry.path.includes("/"));
  let weights = entries.filter((entry) => /\.safetensors$/i.test(entry.path));
  // Some repos ship both sharded model-*.safetensors and a duplicate
  // consolidated.safetensors — only one copy of the weights is needed.
  if (weights.some((entry) => /^model[^/]*\.safetensors$/i.test(entry.path))) {
    weights = weights.filter((entry) => /^model[^/]*\.safetensors$/i.test(entry.path));
  }
  if (weights.length === 0) {
    weights = entries.filter((entry) => /^pytorch_model[^/]*\.bin$/i.test(entry.path));
  }
  const support = entries.filter((entry) => CONVERSION_SUPPORT_FILES.has(entry.path.toLowerCase()));
  return { weights, support };
}

async function enqueueHfConversion(candidate, quantizationRaw) {
  if (candidate.conversionBlockedReason) {
    throw new Error(candidate.conversionBlockedReason);
  }
  const quantization = normalizeConversionQuantization(quantizationRaw);
  const targetDir = path.join(HF_MODELS_ROOT, `${sanitizeRepoId(candidate.repoId)}__gguf`);
  const existingFiles = await collectFilesRecursive(targetDir).catch(() => []);
  if (existingFiles.some((filePath) => filePath.toLowerCase().endsWith(".gguf"))) {
    throw new Error("A converted GGUF for this repo already exists on disk.");
  }
  const sourceRepoId = String(candidate.conversionRepoId || candidate.repoId).trim();
  const sourceRepo = await fetchHfRepoDetails(sourceRepoId);
  const revision = String(sourceRepo?.sha || "main").trim() || "main";
  const { weights, support } = selectConversionSourceFiles(sourceRepo);
  if (weights.length === 0) {
    throw new Error(`No convertible weights (*.safetensors) found in ${sourceRepoId}.`);
  }
  const files = [...support, ...weights].map((entry) => ({
    path: `${CONVERSION_SOURCE_SUBDIR}/${entry.path}`,
    sourcePath: entry.path,
    repoId: sourceRepoId,
    revision,
    sizeBytes: entry.sizeBytes,
  }));
  candidate.downloadSpec = {
    type: "conversion-source",
    runtime: "gguf",
    repoId: sourceRepoId,
    revision,
    files,
  };
  return enqueueHfJob({
    kind: "convert",
    candidate,
    totalBytes: files.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0),
    targetDir,
    conversion: {
      quantization,
      sourceRepoId,
      revision,
      sourceDir: CONVERSION_SOURCE_SUBDIR,
    },
  });
}

const COMPANION_KINDS = new Set(["mtp", "mmproj", "template", "other"]);

async function enqueueHfCompanion(payload) {
  const targetDir = path.resolve(String(payload?.targetDir || "").trim());
  if (!targetDir || !isPathWithin(MODELS_ROOT, targetDir) || !fsSync.existsSync(targetDir)) {
    throw new Error("targetDir must be an existing model directory under ~/models.");
  }
  const repoId = String(payload?.repoId || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoId)) {
    throw new Error("repoId must look like owner/repo.");
  }
  const sourcePath = String(payload?.filePath || "").replace(/^\/+/, "").trim();
  if (!sourcePath || sourcePath.includes("..")) {
    throw new Error("filePath is required (path of the file inside the repo).");
  }
  const requestedKind = String(payload?.kind || "").trim().toLowerCase();
  const kind = COMPANION_KINDS.has(requestedKind) ? requestedKind : "other";
  const revision = String(payload?.revision || "main").trim() || "main";

  const isTemplate = kind === "template";
  const candidate = {
    id: `companion:${repoId}:${sourcePath}:${path.basename(targetDir)}`,
    label: `${path.basename(sourcePath)} → ${path.basename(targetDir)}`,
    fullName: `${repoId}/${sourcePath}`,
    name: path.basename(sourcePath),
    repoId,
    runtime: "gguf",
    family: "Companion file",
    hfUrl: `https://huggingface.co/${repoId}`,
    sizeBytes: 0,
    sizeLabel: "n/a",
    companion: { kind },
    downloadSpec: {
      type: "companion",
      runtime: "gguf",
      repoId,
      revision,
      // Template companions are materialized via the template pipeline (which
      // understands tokenizer_config.json/chat_template.json), not raw copies.
      files: isTemplate ? [] : [{ path: sourcePath, sourcePath, repoId, revision, sizeBytes: 0 }],
    },
    ...(isTemplate
      ? { template: { outputPath: ".llm3-chat-template.jinja", sources: [{ repoId, revision, path: sourcePath }] } }
      : {}),
  };
  return enqueueHfJob({ kind: "companion", candidate, totalBytes: 0, targetDir });
}

async function enqueueHfJob({ kind, candidate, totalBytes, targetDir, conversion = null }) {
  if (!fsSync.existsSync(HF_DOWNLOAD_WORKER)) {
    throw new Error(`Missing download worker: ${HF_DOWNLOAD_WORKER}`);
  }
  await fs.mkdir(HF_JOBS_DIR, { recursive: true });
  await fs.mkdir(HF_MODELS_ROOT, { recursive: true });
  const activeJobs = await readHfDownloadJobs();
  const duplicate = activeJobs.find((job) => {
    if (!isActiveHfJob(job)) {
      return false;
    }
    return String(job?.candidate?.id || "") === String(candidate?.id || "")
      || String(job?.targetDir || "") === String(targetDir || "");
  });
  if (duplicate) {
    throw new Error(`An active ${duplicate.kind || "download"} job already exists for this model.`);
  }

  const job = {
    id: randomUUID(),
    kind,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bytesDownloaded: 0,
    totalBytes: Number(totalBytes || 0),
    progressPct: 0,
    message: kind === "convert" ? "Queued for conversion" : "Queued",
    candidate,
    targetDir,
    cancelRequested: false,
    ...(conversion ? { conversion } : {}),
  };

  const jobPath = getHfJobPath(job.id);
  // Worker output used to go to /dev/null, so a job that died for a reason the
  // worker never got to record left nothing to read -- the UI showed "failed"
  // with the last progress line and no cause. Keep it on disk instead; it is a
  // few KB per job and it is the only place a stack trace can land.
  await fs.mkdir(HF_JOB_LOGS_DIR, { recursive: true });
  const logPath = getHfJobLogPath(job.id);
  job.logPath = logPath;
  await fs.writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  const pid = await spawnDetachedHfWorker(jobPath, logPath);
  await writeHfJob(jobPath, { pid });
  return { ...job, pid };
}

// Start the download worker so that it is NOT a descendant of this process.
//
// spawn({detached:true}) was not enough: the child only gets reparented once
// its parent exits, so at the moment pm2 restarts llm3 the worker is still a
// direct child, and pm2's treekill -- which walks the tree by parent pid --
// signalled it. A routine `pm2 restart llm3` therefore aborted downloads
// mid-file. Interposing a shell that backgrounds the worker and exits
// immediately hands the worker to launchd within milliseconds, so the tree
// walk never sees it. The shell prints the worker's pid, which is what the
// reconciler later uses to tell "still running" from "died".
//
// ecosystem.config.cjs also sets treekill:false; this does not depend on it,
// because that setting is only re-read when the app is re-added to pm2.
function spawnDetachedHfWorker(jobPath, logPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/bin/sh",
      ["-c", '"$1" "$2" "$3" >>"$4" 2>&1 & echo $!', "sh", process.execPath, HF_DOWNLOAD_WORKER, jobPath, logPath],
      {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...NORMALIZED_EXEC_ENV, HF_LLAMA_CPP_DIR, HF_TOOLS_DIR },
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", reject);
    child.on("close", () => {
      const pid = Number(stdout.trim());
      if (!Number.isInteger(pid) || pid <= 0) {
        reject(new Error("Download worker did not report a pid."));
        return;
      }
      resolve(pid);
    });
    child.unref();
  });
}

function getHfJobPath(jobId) {
  return path.join(HF_JOBS_DIR, `${jobId}.json`);
}

function getHfJobLogPath(jobId) {
  return path.join(HF_JOB_LOGS_DIR, `${jobId}.log`);
}

// Last non-empty line of a worker log, for the reconciler to attach to a job
// that died without recording a reason of its own.
async function readHfJobLogTail(jobId) {
  const raw = await fs.readFile(getHfJobLogPath(jobId), "utf8").catch(() => "");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
}

// How long an active job may sit without a recorded worker pid before it is
// treated as dead rather than as mid-spawn.
const HF_JOB_PID_GRACE_MS = 60_000;

function isActiveHfJob(job) {
  return ["queued", "running", "cancelling"].includes(String(job?.status || "").toLowerCase());
}

function isClearableHfJob(job) {
  return !isActiveHfJob(job);
}

function isFailedLikeHfJob(job) {
  return ["failed", "cancelled"].includes(String(job?.status || "").toLowerCase());
}

function canCancelHfJob(job) {
  return isActiveHfJob(job);
}

function isHfJobCancellationRequested(job) {
  return Boolean(job?.cancelRequested) || String(job?.status || "").toLowerCase() === "cancelling";
}

function isProcessAlive(pid) {
  const numericPid = Number(pid || 0);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

async function readHfJob(jobId) {
  const jobPath = getHfJobPath(jobId);
  const raw = await fs.readFile(jobPath, "utf8").catch(() => "");
  return raw ? JSON.parse(raw) : null;
}

async function writeHfJob(jobPath, patch) {
  const raw = await fs.readFile(jobPath, "utf8");
  const current = raw ? JSON.parse(raw) : {};
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(jobPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

async function readHfDownloadJobs() {
  const entries = await fs.readdir(HF_JOBS_DIR, { withFileTypes: true }).catch(() => []);
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const jobPath = path.join(HF_JOBS_DIR, entry.name);
      const payload = JSON.parse(await fs.readFile(jobPath, "utf8"));
      const reconciled = await reconcileHfJobState(jobPath, payload);
      jobs.push({
        ...reconciled,
        canCancel: canCancelHfJob(reconciled),
        canClear: isClearableHfJob(reconciled),
      });
    } catch (_error) {
      // Ignore malformed job files.
    }
  }
  return jobs.sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
}

async function reconcileHfJobState(jobPath, job) {
  if (!isActiveHfJob(job)) {
    return job;
  }
  const pid = Number(job?.pid || 0);
  const hasPid = Number.isInteger(pid) && pid > 0;
  if (hasPid && isProcessAlive(pid)) {
    return job;
  }
  if (!hasPid) {
    // enqueueHfJob writes the job file a few milliseconds before it records the
    // worker pid, so a brand-new job legitimately has none yet. But a job that
    // lost its pid (a force-cancel that never completed) would otherwise stay
    // "active" forever — permanently blocking both the clear button and any
    // re-queue for the same target dir. Age it out past the spawn window.
    const lastTouchedAt = Date.parse(String(job?.updatedAt || job?.createdAt || ""));
    if (!Number.isFinite(lastTouchedAt) || Date.now() - lastTouchedAt < HF_JOB_PID_GRACE_MS) {
      return job;
    }
  }

  const cancellationRequested = isHfJobCancellationRequested(job);
  if (cancellationRequested || String(job?.status || "").toLowerCase() === "cancelling") {
    await cleanupHfJobArtifacts(job);
    return await writeHfJob(jobPath, {
      status: "cancelled",
      message: "Cancelled",
      cancelRequested: true,
      pid: 0,
      progressPct: 0,
    });
  }

  await cleanupHfJobArtifacts(job);
  // The worker records its own reason when it can. Reaching here means it did
  // not -- it was killed, or it crashed hard -- and the stored message is only
  // the last progress line, which reads as if that file was at fault. Say what
  // actually happened and attach whatever the worker log caught.
  const logTail = await readHfJobLogTail(job.id);
  const progressNote = String(job?.message || "").trim();
  const message = [
    "Worker exited without reporting a reason (killed or crashed). Re-queue to resume; finished files are kept.",
    progressNote ? `Last step: ${progressNote}.` : "",
    logTail ? `Worker log: ${logTail}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return await writeHfJob(jobPath, {
    status: "failed",
    message,
    pid: 0,
  });
}

async function clearHfDownloadJobs(options = {}) {
  const jobId = String(options.jobId || "").trim();
  const failedOnly = Boolean(options.failedOnly);
  const entries = await fs.readdir(HF_JOBS_DIR, { withFileTypes: true }).catch(() => []);
  let foundJob = false;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const jobPath = path.join(HF_JOBS_DIR, entry.name);
    const raw = await fs.readFile(jobPath, "utf8").catch(() => "");
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch (_error) {
      payload = null;
    }
    if (!payload) {
      continue;
    }
    if (jobId && payload.id !== jobId) {
      continue;
    }
    foundJob = true;
    if (!isClearableHfJob(payload)) {
      if (jobId) {
        throw new Error("Cannot clear an active download.");
      }
      continue;
    }
    if (failedOnly && !isFailedLikeHfJob(payload)) {
      continue;
    }
    await cleanupHfJobArtifacts(payload);
    await fs.rm(jobPath, { force: true });
  }

  if (jobId && !foundJob) {
    throw new Error(`Unknown download job: ${jobId}`);
  }
  return readHfDownloadJobs();
}

async function cancelHfJob(jobId) {
  const jobPath = getHfJobPath(jobId);
  const payload = await readHfJob(jobId);
  if (!payload) {
    throw new Error(`Unknown download job: ${jobId}`);
  }
  const current = await reconcileHfJobState(jobPath, payload);
  if (!canCancelHfJob(current)) {
    throw new Error("Cannot cancel a finished job.");
  }
  const updated = await writeHfJob(jobPath, {
    status: "cancelling",
    message: String(current?.status || "").toLowerCase() === "cancelling" ? "Force cancelling" : "Cancelling",
    cancelRequested: true,
  });
  const pid = Number(updated?.pid || current?.pid || 0);
  if (pid > 0 && isProcessAlive(pid)) {
    const signal = String(current?.status || "").toLowerCase() === "cancelling" ? "SIGKILL" : "SIGTERM";
    try {
      // Workers are detached group leaders; signal the whole group so child
      // processes (e.g. a running GGUF converter) don't outlive the worker.
      process.kill(-pid, signal);
    } catch (_error) {
      try {
        process.kill(pid, signal);
      } catch (_innerError) {
        // Ignore races with already-exited workers.
      }
    }
  } else {
    await reconcileHfJobState(jobPath, updated);
  }
  return readHfDownloadJobs();
}

// A cancelled parallel download leaves both "<file>.partial-<pid>" and the
// "<file>.partial-<pid>.parts" directory of range chunks behind. Matching on the
// job's own pid missed both whenever the pid was already lost (a force-cancel
// records pid 0), stranding gigabytes of chunks on disk — so sweep by shape
// instead. enqueueHfJob forbids two active jobs on one target dir, so nothing
// else can own these.
async function removePartialArtifacts(outputPath) {
  const dir = path.dirname(outputPath);
  const prefix = `${path.basename(outputPath)}.partial-`;
  const entries = await fs.readdir(dir).catch(() => []);
  for (const name of entries) {
    if (name.startsWith(prefix) && /\.partial-\d+(\.parts)?$/.test(name)) {
      await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function cleanupHfJobArtifacts(job) {
  const targetDir = path.resolve(String(job?.targetDir || ""));
  if (!targetDir || !isPathWithin(MODELS_ROOT, targetDir)) {
    return;
  }
  if (String(job?.kind || "") === "convert") {
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    await pruneEmptyParents(path.dirname(targetDir), MODELS_ROOT);
    return;
  }

  const files = Array.isArray(job?.candidate?.downloadSpec?.files) ? job.candidate.downloadSpec.files : [];
  for (const entry of files) {
    const relativePath = String(entry?.path || "").replace(/^\/+/, "");
    if (!relativePath || relativePath.includes("..")) {
      continue;
    }
    const outputPath = path.join(targetDir, relativePath);
    const expectedSize = Number(entry?.sizeBytes || 0);
    const stat = await fs.stat(outputPath).catch(() => null);
    if (stat?.isFile() && expectedSize > 0 && stat.size !== expectedSize) {
      await fs.rm(outputPath, { force: true }).catch(() => {});
    }
    await removePartialArtifacts(outputPath);
  }
  await fs.rm(path.join(targetDir, ".llm3-hf.json"), { force: true }).catch(() => {});
  await fs.rm(path.join(targetDir, ".llm3-chat-template.jinja"), { force: true }).catch(() => {});
  await pruneEmptyParents(targetDir, MODELS_ROOT);
}

function hfJobTouchesPath(job, targetPath) {
  const resolvedTarget = path.resolve(String(targetPath || ""));
  const targetDir = path.resolve(String(job?.targetDir || ""));
  if (!resolvedTarget || !targetDir) {
    return false;
  }
  if (resolvedTarget === targetDir) {
    return true;
  }
  const files = Array.isArray(job?.candidate?.downloadSpec?.files) ? job.candidate.downloadSpec.files : [];
  return files.some((entry) => {
    const relativePath = String(entry?.path || "").replace(/^\/+/, "");
    if (!relativePath || relativePath.includes("..")) {
      return false;
    }
    return path.resolve(path.join(targetDir, relativePath)) === resolvedTarget;
  });
}

async function pruneHfJobsForTargetPath(targetPath) {
  const entries = await fs.readdir(HF_JOBS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const jobPath = path.join(HF_JOBS_DIR, entry.name);
    const raw = await fs.readFile(jobPath, "utf8").catch(() => "");
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch (_error) {
      payload = null;
    }
    if (!payload || !isClearableHfJob(payload) || !hfJobTouchesPath(payload, targetPath)) {
      continue;
    }
    await fs.rm(jobPath, { force: true });
  }
}

async function deleteModelByKey(modelKey) {
  const models = await getModels();
  const model = models.find((entry) => entry.key === modelKey);
  if (!model) {
    throw new Error(`Unknown model: ${modelKey}`);
  }

  const targetPath = path.resolve(String(model.path || model.key || ""));
  if (!targetPath || !isPathWithin(MODELS_ROOT, targetPath)) {
    throw new Error("Refusing to delete paths outside ~/models.");
  }

  const statuses = await getSlotStatuses(models);
  const runningSlot = statuses.find((status) => {
    const currentPath = path.resolve(String(status?.model?.path || status?.model?.key || ""));
    return status?.running && currentPath === targetPath;
  });
  if (runningSlot) {
    throw new Error(`${runningSlot.slotLabel} is still running this model. Stop it first.`);
  }

  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat) {
    // Model files already removed from disk — clean up HF jobs and return.
    await pruneHfJobsForTargetPath(targetPath);
    await pruneEmptyParents(path.dirname(targetPath), MODELS_ROOT);
    return;
  }

  if (stat.isDirectory()) {
    await fs.rm(targetPath, { recursive: true, force: false });
    await pruneHfJobsForTargetPath(targetPath);
    await pruneEmptyParents(path.dirname(targetPath), MODELS_ROOT);
    return;
  }

  // A split GGUF is one model spread over N files. The listing already treats
  // it that way -- it shows the whole set's size under the shard llama.cpp
  // loads through -- so the delete has to as well. Removing only that shard
  // left every other shard on disk, and the next scan simply promoted the
  // lowest survivor to be the model: deleting a 181GB DeepSeek freed 28GB and
  // the model came back named "…-00002-of-00003".
  for (const shard of await splitGgufSiblings(targetPath)) {
    await fs.unlink(shard).catch(() => {});
  }
  await fs.unlink(targetPath).catch(() => {});
  await pruneHfJobsForTargetPath(targetPath);
  await pruneEmptyParents(path.dirname(targetPath), MODELS_ROOT);
}

// Every other shard of the split set `filePath` belongs to, first shard or
// not. Returns [] for a single-file model, so the caller needs no special
// case. Siblings are matched inside the same directory only, and each is
// re-checked against MODELS_ROOT before it can be handed back for deletion.
async function splitGgufSiblings(filePath) {
  const target = path.resolve(String(filePath || ""));
  if (!SPLIT_GGUF_PATTERN.test(target)) {
    return [];
  }
  const groupKey = ggufSplitGroupKey(target);
  const dir = path.dirname(target);
  const entries = await fs.readdir(dir).catch(() => []);
  const siblings = [];
  for (const entry of entries) {
    const candidate = path.join(dir, entry);
    if (candidate === target || !SPLIT_GGUF_PATTERN.test(candidate)) {
      continue;
    }
    if (ggufSplitGroupKey(candidate) !== groupKey || !isPathWithin(MODELS_ROOT, candidate)) {
      continue;
    }
    const candidateStat = await fs.stat(candidate).catch(() => null);
    if (candidateStat?.isFile()) {
      siblings.push(candidate);
    }
  }
  return siblings;
}

function isPathWithin(parentPath, targetPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Files llm3 writes beside a downloaded repo. They describe the download, so
// once the last model file under the repo is gone they describe nothing. Left
// behind they keep the repo directory alive, which is what turned a completed
// delete into an empty ~/models/hf/<repo>/ folder that looked like leftovers.
// The same two names are already removed together by the download cleanup path.
const DISPOSABLE_REPO_SIDECARS = new Set([
  ".llm3-hf.json",
  ".llm3-chat-template.jinja",
  ".DS_Store",
]);

async function pruneEmptyParents(startDir, stopDir) {
  let currentDir = path.resolve(startDir);
  const boundary = path.resolve(stopDir);
  while (isPathWithin(boundary, currentDir) && currentDir !== boundary) {
    const entries = await fs.readdir(currentDir).catch(() => null);
    if (!entries) {
      break;
    }
    // A directory holding nothing but llm3's own sidecars counts as empty. Any
    // real survivor -- another quant folder, an mmproj, a tokenizer -- stops
    // the walk, so a repo with a second quant still installed is never touched.
    const survivors = entries.filter((entry) => !DISPOSABLE_REPO_SIDECARS.has(entry));
    if (survivors.length > 0) {
      break;
    }
    for (const entry of entries) {
      await fs.rm(path.join(currentDir, entry), { force: true }).catch(() => {});
    }
    await fs.rmdir(currentDir).catch(() => {});
    currentDir = path.dirname(currentDir);
  }
}

function sanitizeRepoId(repoId) {
  return String(repoId || "")
    .trim()
    .replace(/[\/\\]+/g, "__")
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
}

async function readDefaultsFromScript(script, slot) {
  try {
    const output = await runLauncher(script, ["--slot", slot.id, "--defaults-json"], { timeoutMs: DEFAULTS_SCRIPT_TIMEOUT_MS });
    return JSON.parse(output);
  } catch (_error) {
    return {
      contextSize: 262144,
      contextSizeLabel: "256K",
      parallel: 1,
      thinking: false,
      reasoningBudget: -1,
      enableDry: false,
      mtpDraftMax: 2,
      enableTinyGrammar: false,
      enableStructuredGbnf: false,
      temperature: LAUNCH_SAMPLING_DEFAULTS.temperature,
      topP: LAUNCH_SAMPLING_DEFAULTS.topP,
      topK: LAUNCH_SAMPLING_DEFAULTS.topK,
      minP: LAUNCH_SAMPLING_DEFAULTS.minP,
      presencePenalty: LAUNCH_SAMPLING_DEFAULTS.presencePenalty,
      repetitionPenalty: LAUNCH_SAMPLING_DEFAULTS.repetitionPenalty,
    };
  }
}

async function getSlotStatuses(models = null) {
  const sharedModels = models || (await getModels());
  return Promise.all(SLOT_DEFINITIONS.map((slot) => getSlotStatus(slot, sharedModels)));
}

async function getSlotStatus(slot, models = null) {
  const sharedModels = models || (await getModels());
  // NB the names below must stay aligned with the promise order. They silently
  // drifted once: nine names were destructured from ten promises, so
  // `optiqStatus` actually held mlx-dspark's result, `dflashStatus` held
  // optiq's, `turboquantStatus` held dflash's, and turboquant's own result was
  // dropped -- a running turboquant slot reported idle. Each entry is now one
  // {key, status} pair so adding a launcher cannot reintroduce that.
  const statusChecks = [
    ["gguf", GGUF_LAUNCHER],
    ["gguf-tq3", GGUF_TQ3_LAUNCHER],
    ["beellama", BEELLAMA_LAUNCHER],
    ["mlx", MLX_LAUNCHER],
    ["rapid-mlx", RAPID_MLX_LAUNCHER],
    ["mtplx", MTPLX_LAUNCHER],
    ["mlx-dspark", MLX_DSPARK_LAUNCHER],
    ["mlx-vlm", MLX_VLM_LAUNCHER],
    ["ds4", DS4_LAUNCHER],
    ["optiq", OPTIQ_LAUNCHER],
    ["dflash", DFLASH_LAUNCHER],
    ["turboquant", TURBO_QUANT_LAUNCHER],
  ];
  const statusResults = await Promise.all(
    statusChecks.map(([key, launcher]) =>
      readStatusFromScript(launcher, slot, getDefaultLogs(slot, key), key)),
  );
  const statusByKey = new Map(statusChecks.map(([key], index) => [key, statusResults[index]]));

  // Only one runtime owns a slot at a time -- they share the public port -- so
  // this order only decides who wins if a previous runtime left a stale state
  // file behind. Most specific first.
  const statusPrecedence = [
    "turboquant", "rapid-mlx", "dflash", "mtplx", "optiq",
    "mlx-dspark", "mlx-vlm", "ds4", "mlx", "gguf-tq3", "beellama", "gguf",
  ];
  for (const key of statusPrecedence) {
    const candidate = statusByKey.get(key);
    if (candidate?.running) {
      return normalizeSlotStatus(slot, candidate);
    }
  }

  const fallbackStatus = await detectLiveRuntimeStatus(slot, sharedModels);
  if (fallbackStatus) {
    return normalizeSlotStatus(slot, fallbackStatus);
  }

  return createIdleStatus(slot);
}

async function normalizeSlotStatus(slot, status) {
  if (!status?.running) {
    return status;
  }

  const runtime = String(status?.model?.runtime || status?.model?.launcher || "").trim();
  if (runtime !== "gguf") {
    return status;
  }

  const contextLength = await resolveSlotContextLength(slot, status);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    return status;
  }

  return {
    ...status,
    params: {
      ...(status.params || {}),
      ctxSize: contextLength,
    },
  };
}

async function computeOverviewData() {
  const discoveredModels = await getModels();
  const [statuses, dashboardConfig, slotDefaults] = await Promise.all([
    getSlotStatuses(discoveredModels),
    readDashboardConfig(),
    Promise.all(SLOT_DEFINITIONS.map(async (slot) => ({
      slotId: slot.id,
      defaults: {
        gguf: await readDefaultsFromScript(GGUF_LAUNCHER, slot),
        "gguf-tq3": await readDefaultsFromScript(GGUF_TQ3_LAUNCHER, slot),
        beellama: await readDefaultsFromScript(BEELLAMA_LAUNCHER, slot),
        mlx: await readDefaultsFromScript(MLX_LAUNCHER, slot),
        "rapid-mlx": await readDefaultsFromScript(RAPID_MLX_LAUNCHER, slot),
        mtplx: await readDefaultsFromScript(MTPLX_LAUNCHER, slot),
        "mlx-dspark": await readDefaultsFromScript(MLX_DSPARK_LAUNCHER, slot),
        "mlx-vlm": await readDefaultsFromScript(MLX_VLM_LAUNCHER, slot),
        ds4: await readDefaultsFromScript(DS4_LAUNCHER, slot),
        optiq: await readDefaultsFromScript(OPTIQ_LAUNCHER, slot),
        dflash: await readDefaultsFromScript(DFLASH_LAUNCHER, slot),
        turboquant: await readDefaultsFromScript(TURBO_QUANT_LAUNCHER, slot),
      },
    }))),
  ]);

  const usedModelKeys = new Set(dashboardConfig.usedModelKeys || []);
  for (const status of statuses) {
    const model = resolveModelRecordByStatus(status, discoveredModels);
    if (model?.key) {
      usedModelKeys.add(model.key);
    }
  }
  const models = applyPreferredLaunchers(discoveredModels, dashboardConfig).map((model) => ({
    ...model,
    isNew: Boolean(model.downloaded && !usedModelKeys.has(model.key)),
  }));

  const applicationTargets = dashboardConfig.applicationTargets;
  const integrationTargets = dashboardConfig.integrationTargets;
  const defaultsBySlotId = Object.fromEntries(slotDefaults.map((entry) => [entry.slotId, entry.defaults]));
  const slots = SLOT_DEFINITIONS.map((slot) => ({
    ...slot,
    // `label` stays the built-in name so nothing that keys off it changes;
    // `name` is what the UI shows.
    name: resolveSlotName(slot, dashboardConfig),
    defaultName: slot.label,
    savedSlotName: normalizeSlotName(dashboardConfig.slotNames?.[slot.id]),
    runtimeBaseUrl: getSlotRuntimeBaseUrl(slot, dashboardConfig),
    configuredRuntimeBaseUrl: dashboardConfig.slotRuntimeBaseUrls?.[slot.id] || "",
    syncTarget: integrationTargets.openclaude === slot.id,
    applicationTargets: buildSlotApplicationFlags(slot, applicationTargets),
    integrationTargets: buildSlotIntegrationFlags(slot, integrationTargets),
    defaults: defaultsBySlotId[slot.id],
    benchmark: serializeSlotBenchmark(SLOT_BENCHMARKS.get(slot.id)),
    status: statuses.find((entry) => entry.slotId === slot.id) || createIdleStatus(slot),
  }));

  const voiceModels = await getVoiceModels();
  const voiceStatuses = await getVoiceSlotStatuses(voiceModels);
  const voiceSlots = VOICE_SLOT_DEFINITIONS.map((vSlot) => ({
    ...vSlot,
    runtimeBaseUrl: getVoiceSlotRuntimeBaseUrl(vSlot, dashboardConfig),
    configuredRuntimeBaseUrl: dashboardConfig.voiceRuntimeBaseUrls?.[vSlot.id] || "",
    applicationTargets: Object.fromEntries(
      APPLICATION_KEYS.map((key) => [key, applicationTargets[key] === vSlot.id])
    ),
    status: voiceStatuses.find((entry) => entry.slotId === vSlot.id) || createIdleVoiceStatus(vSlot),
  }));

  const system = await getSystemStats(statuses);
  // Chat-template eligibility is decided server-side so the catalog and its
  // matching rules live in exactly one place.
  const modelsWithChatTemplates = models.map((model) => {
    const chatTemplate = buildChatTemplateOptionsPayload(model, getSavedChatTemplateKey(dashboardConfig, model.key));
    return chatTemplate ? { ...model, chatTemplate } : model;
  });
  return {
    models: modelsWithChatTemplates,
    slots,
    voiceModels,
    voiceSlots,
    runtime: {
      serviceMode: SERVICE_MODE,
      launchdDomain: LAUNCHD_DOMAIN || null,
      user: RUNTIME_USER,
      home: HOME,
      xdgStateHome: DEFAULT_XDG_STATE_HOME,
      guiLaunchDomain: getClaudeProxyLaunchDomain() || null,
      lanIp: getLanIp(),
    },
    system,
    actionInFlight,
    applications: buildApplicationRows(applicationTargets),
    // The launch modal groups the routing toggles by machine. The labels come
    // from LLM3_LOCAL_LABEL / LLM3_REMOTE_LABEL, so they must be served rather
    // than duplicated as literals in public/app.js.
    applicationMachines: APPLICATION_MACHINES.map((machine) => ({ ...machine })),
    // Same for the application names: the generic integrations take theirs from .env.
    applicationLabels: Object.fromEntries(APPLICATION_DEFINITIONS.map((entry) => [
      entry.key,
      { label: entry.label, badgeLabel: entry.badgeLabel, description: entry.description || "" },
    ])),
    applicationTargets,
    integrationTargets,
    profiles: dashboardConfig.profiles,
    defaultProfileId: dashboardConfig.defaultProfileId || "",
    activeProfileId: dashboardConfig.activeProfileId || "",
    preferredLaunchers: dashboardConfig.preferredLaunchers || {},
    modelApplicationPreferences: dashboardConfig.modelApplicationPreferences || {},
    slotApplicationPreferences: dashboardConfig.slotApplicationPreferences || {},
    syncTargetSlotId: integrationTargets.openclaude,
  };
}

async function getOverviewData() {
  const now = Date.now();
  if (overviewCache.value && overviewCache.expiresAt > now) {
    return overviewCache.value;
  }
  if (overviewCache.promise) {
    return overviewCache.promise;
  }

  overviewCache.promise = computeOverviewData()
    .then((value) => {
      overviewCache = {
        expiresAt: Date.now() + OVERVIEW_CACHE_TTL_MS,
        value,
        promise: null,
      };
      return value;
    })
    .catch((error) => {
      overviewCache = { expiresAt: 0, value: null, promise: null };
      throw error;
    });

  return overviewCache.promise;
}

function clearOverviewCache() {
  overviewCache = { expiresAt: 0, value: null, promise: null };
}

async function getHermesStatusData() {
  const now = Date.now();
  if (hermesStatusCache.value && hermesStatusCache.expiresAt > now) {
    return hermesStatusCache.value;
  }
  if (hermesStatusCache.promise) {
    return hermesStatusCache.promise;
  }

  hermesStatusCache.promise = computeHermesStatusData()
    .then((value) => {
      hermesStatusCache = {
        expiresAt: Date.now() + HERMES_STATUS_CACHE_TTL_MS,
        value,
        promise: null,
      };
      return value;
    })
    .catch((error) => {
      hermesStatusCache = { expiresAt: 0, value: null, promise: null };
      throw error;
    });

  return hermesStatusCache.promise;
}

async function computeHermesStatusData() {
  const [local, remote] = await Promise.all([
    readLocalHermesStatus(),
    readRemoteHermesStatus(),
  ]);
  return {
    updatedAt: new Date().toISOString(),
    local,
    remote,
  };
}

async function readLocalHermesStatus() {
  const [online, logInfo, sessionInfo] = await Promise.all([
    isLocalHermesGatewayOnline(),
    readLocalHermesLogActivity(),
    readLatestHermesSessionSummary(HERMES_SESSIONS_DIR),
  ]);
  return finalizeHermesRuntimeStatus({
    key: "local",
    label: "Hermes M4",
    online,
    hostLabel: "local",
    sessionInfo,
    logInfo,
  });
}

async function readRemoteHermesStatus() {
  if (!isRemoteSyncEnabled(process.env.HERMES_SYNC_ENABLED, HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return buildHermesRuntimeStatus({
      key: "remote",
      label: "Hermes Agent",
      hostLabel: HERMES_SYNC_HOST,
      online: false,
      detail: "Remote Hermes sync is disabled.",
      updatedAt: new Date().toISOString(),
    });
  }
  if (!hasRemoteShellAuth(HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return buildHermesRuntimeStatus({
      key: "remote",
      label: "Hermes Agent",
      hostLabel: HERMES_SYNC_HOST,
      online: false,
      detail: buildRemoteShellAuthError("Hermes status", "HERMES_SYNC_PASSWORD", "HERMES_SYNC_SSH_KEY", HERMES_SYNC_SSH_KEY),
      updatedAt: new Date().toISOString(),
    });
  }

  try {
    const output = await runRemoteShell(
      HERMES_SYNC_HOST,
      HERMES_SYNC_USER,
      {
        password: HERMES_SYNC_PASSWORD,
        sshKeyPath: HERMES_SYNC_SSH_KEY,
      },
      buildRemoteHermesStatusScript()
    );
    const payload = extractTaggedValue(output, "__HERMES_STATUS__", "__END__");
    const parsed = payload ? JSON.parse(payload) : null;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Remote Hermes status did not return structured data.");
    }
    return finalizeHermesRuntimeStatus({
      key: "remote",
      label: "Hermes Agent",
      online: Boolean(parsed.online),
      hostLabel: HERMES_SYNC_HOST,
      sessionInfo: parsed.session || null,
      logInfo: parsed.log || null,
      serviceState: String(parsed.serviceState || "").trim(),
    });
  } catch (error) {
    return buildHermesRuntimeStatus({
      key: "remote",
      label: "Hermes Agent",
      hostLabel: HERMES_SYNC_HOST,
      online: false,
      detail: formatExecError(error) || "Unable to read remote Hermes status.",
      updatedAt: new Date().toISOString(),
    });
  }
}

async function getHermesFeedData(runtime) {
  return runtime === "remote"
    ? readRemoteHermesFeed()
    : readLocalHermesFeed();
}

async function readLocalHermesFeed() {
  const status = await readLocalHermesStatus();
  const sessionFeed = await readLatestHermesSessionFeed(HERMES_SESSIONS_DIR);
  const logFeed = await readHermesLogFeed(HERMES_AGENT_LOG_PATH);
  return buildHermesFeedPayload({
    runtime: "local",
    status,
    sessionFeed,
    logFeed,
  });
}

async function readRemoteHermesFeed() {
  try {
    const status = await readRemoteHermesStatus();
    if (!isRemoteSyncEnabled(process.env.HERMES_SYNC_ENABLED, HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
      return buildHermesFeedPayload({ runtime: "remote", status, sessionFeed: null, logFeed: null });
    }
    if (!hasRemoteShellAuth(HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
      return buildHermesFeedPayload({ runtime: "remote", status, sessionFeed: null, logFeed: null });
    }
    const output = await runRemoteShell(
      HERMES_SYNC_HOST,
      HERMES_SYNC_USER,
      {
        password: HERMES_SYNC_PASSWORD,
        sshKeyPath: HERMES_SYNC_SSH_KEY,
      },
      buildRemoteHermesFeedScript()
    );
    const payload = extractTaggedValue(output, "__HERMES_FEED__", "__END__");
    const parsed = payload ? JSON.parse(payload) : null;
    return buildHermesFeedPayload({
      runtime: "remote",
      status,
      sessionFeed: parsed?.session || null,
      logFeed: parsed?.log || null,
      overrideUpdatedAt: String(parsed?.updatedAt || ""),
      overrideSessionId: String(parsed?.session?.sessionId || ""),
    });
  } catch (error) {
    const status = await readRemoteHermesStatus();
    return buildHermesFeedPayload({
      runtime: "remote",
      status: {
        ...status,
        detail: status?.detail || (formatExecError(error) || "Unable to read remote Hermes feed."),
      },
      sessionFeed: null,
      logFeed: null,
    });
  }
}

function buildHermesFeedPayload({ runtime, status, sessionFeed, logFeed, overrideUpdatedAt = "", overrideSessionId = "" }) {
  const label = String(status?.label || (runtime === "remote" ? "Hermes Agent" : "Hermes M4"));
  const hostLabel = String(status?.hostLabel || (runtime === "remote" ? HERMES_SYNC_HOST : "local"));
  const sessionEntries = Array.isArray(sessionFeed?.entries) ? sessionFeed.entries : [];
  const logEntries = Array.isArray(logFeed?.entries) ? logFeed.entries : [];
  const statusDetail = String(status?.detail || "").trim();
  const entries = [...sessionEntries, ...logEntries]
    .slice(-HERMES_FEED_ENTRY_LIMIT)
    .map((entry, index) => ({
      id: String(entry?.id || `${runtime}-${index + 1}`),
      kind: String(entry?.kind || "log"),
      kindLabel: String(entry?.kindLabel || humanizeHermesFeedKind(entry?.kind || "log")),
      title: String(entry?.title || "Activity"),
      detail: String(entry?.detail || "").trim(),
      timestamp: String(entry?.timestamp || ""),
      timestampLabel: formatHermesFeedTimestamp(entry?.timestamp),
      stepLabel: String(entry?.stepLabel || ""),
      source: String(entry?.source || ""),
    }))
    .filter((entry) => entry.detail);
  if (!entries.length && statusDetail) {
    entries.push({
      id: `${runtime}-status-fallback`,
      kind: "log",
      kindLabel: humanizeHermesFeedKind("log"),
      title: "Latest runtime activity",
      detail: statusDetail,
      timestamp: String(status?.lastActivityAt || status?.updatedAt || ""),
      timestampLabel: formatHermesFeedTimestamp(status?.lastActivityAt || status?.updatedAt || ""),
      stepLabel: "",
      source: "status",
    });
  }

  return {
    runtime,
    label,
    hostLabel,
    online: Boolean(status?.online),
    working: Boolean(status?.working),
    state: String(status?.state || "offline"),
    serviceState: String(status?.serviceState || ""),
    sessionId: String(overrideSessionId || sessionFeed?.sessionId || status?.sessionId || ""),
    updatedAt: String(overrideUpdatedAt || sessionFeed?.updatedAt || logFeed?.updatedAt || status?.updatedAt || new Date().toISOString()),
    entries,
  };
}

async function readLatestHermesSessionFeed(sessionsDir) {
  const directoryEntries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(
    directoryEntries
      .filter((entry) => entry.isFile() && /^session_.*\.json$/i.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(sessionsDir, entry.name);
        const stat = await fs.stat(filePath).catch(() => null);
        return stat ? { filePath, fileName: entry.name, stat } : null;
      })
  );
  const recentFiles = candidates
    .filter(Boolean)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
    .slice(0, 8);

  for (const file of recentFiles) {
    const raw = await fs.readFile(file.filePath, "utf8").catch(() => "");
    if (!raw) {
      continue;
    }
    try {
      const payload = JSON.parse(raw);
      return {
        sessionId: String(payload?.session_id || "").trim(),
        updatedAt: file.stat?.mtime ? new Date(file.stat.mtime).toISOString() : "",
        entries: buildHermesSessionFeedEntries(payload),
      };
    } catch (_error) {
      continue;
    }
  }

  return null;
}

function buildHermesSessionFeedEntries(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const entries = [];
  let step = 1;

  for (const message of messages) {
    const role = String(message?.role || "").trim();
    if (role === "user") {
      const content = formatHermesFeedDetail(message.content, 2400);
      if (content) {
        entries.push({
          id: `user-${step}`,
          kind: "user",
          title: "User message",
          detail: content,
          stepLabel: `Step ${step}`,
          source: "session",
        });
        step += 1;
      }
      continue;
    }

    if (role === "assistant") {
      const reasoning = formatHermesFeedDetail(message.reasoning, 3200);
      if (reasoning) {
        entries.push({
          id: `assistant-thinking-${step}`,
          kind: "thinking",
          title: "Internal reasoning",
          detail: reasoning,
          stepLabel: `Step ${step}`,
          source: "session",
        });
        step += 1;
      }

      const assistantContent = String(message.content == null ? "" : message.content).trim();
      const placeholder = extractCallingToolPlaceholder(assistantContent);
      const cleanedAssistant = formatHermesFeedDetail(removeCallingToolPlaceholder(assistantContent), 3200);
      if (cleanedAssistant) {
        entries.push({
          id: `assistant-${step}`,
          kind: "assistant",
          title: "Assistant message",
          detail: cleanedAssistant,
          stepLabel: `Step ${step}`,
          source: "session",
        });
        step += 1;
      }
      if (placeholder) {
        entries.push({
          id: `assistant-tool-placeholder-${step}`,
          kind: "tool_call",
          title: "Assistant started tool",
          detail: `Running ${placeholder}`,
          stepLabel: `Step ${step}`,
          source: "session",
        });
        step += 1;
      }

      for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        entries.push({
          id: `tool-call-${step}-${String(toolCall?.id || "").trim() || entries.length + 1}`,
          kind: "tool_call",
          title: summarizeHermesToolCall(toolCall) || "Tool call",
          detail: formatHermesToolCallDetail(toolCall),
          stepLabel: `Step ${step}`,
          source: "session",
        });
        step += 1;
      }
      continue;
    }

    if (role === "tool") {
      const content = formatHermesFeedDetail(message.content, 3600);
      if (content) {
        entries.push({
          id: `tool-output-${step}`,
          kind: "tool_output",
          title: "Tool output",
          detail: content,
          stepLabel: `Step ${step}`,
          source: "session",
        });
        step += 1;
      }
    }
  }

  return entries.slice(-HERMES_FEED_ENTRY_LIMIT);
}

async function readHermesLogFeed(logPath) {
  const { content, modifiedAt } = await readLogTail(logPath, HERMES_STATUS_LOG_TAIL_LIMIT);
  const lines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const parsed = parseHermesLogLine(line);
    if (!parsed || isNoiseHermesLogMessage(parsed.message)) {
      continue;
    }
    entries.push({
      id: `log-${entries.length + 1}`,
      kind: "log",
      title: summarizeHermesLogMessage(parsed.message) || "Gateway activity",
      detail: parsed.message,
      timestamp: parsed.timestamp || "",
      source: "log",
    });
  }
  return {
    updatedAt: modifiedAt ? new Date(modifiedAt).toISOString() : "",
    entries: entries.slice(-HERMES_FEED_LOG_LIMIT),
  };
}

async function isLocalHermesGatewayOnline() {
  try {
    const { stdout } = await execFileAsync("launchctl", ["list", HERMES_M4_LAUNCH_LABEL], getExecOptions({
      timeout: 1500,
      maxBuffer: 256 * 1024,
    }));
    const pidMatch = String(stdout || "").match(/"PID"\s*=\s*([0-9]+)/);
    if (pidMatch) {
      return Number(pidMatch[1]) > 0;
    }
  } catch (_error) {
    // Fall through to pgrep.
  }

  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "hermes.*gateway run"], getExecOptions({
      timeout: 1500,
      maxBuffer: 64 * 1024,
    }));
    return String(stdout || "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .length > 0;
  } catch (_error) {
    return false;
  }
}

async function restartLocalHermesGateway() {
  if (!HERMES_M4_RESTART_ON_VOICE_SYNC) {
    return { ok: true, skipped: true, reason: "disabled" };
  }

  const launchDomain =
    Number.isInteger(LAUNCHD_GUI_UID) && LAUNCHD_GUI_UID > 0
      ? `gui/${LAUNCHD_GUI_UID}/${HERMES_M4_LAUNCH_LABEL}`
      : HERMES_M4_LAUNCH_LABEL;

  try {
    await execFileAsync("launchctl", ["kickstart", "-k", launchDomain], getExecOptions({
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    }));
    return { ok: true, launch_label: HERMES_M4_LAUNCH_LABEL, launch_domain: launchDomain };
  } catch (error) {
    return {
      ok: false,
      launch_label: HERMES_M4_LAUNCH_LABEL,
      launch_domain: launchDomain,
      error: formatExecError(error) || "Hermes M4 gateway restart failed.",
    };
  }
}

async function readLocalHermesLogActivity() {
  const { content, modifiedAt } = await readLogTail(HERMES_AGENT_LOG_PATH, HERMES_STATUS_LOG_TAIL_LIMIT);
  return summarizeHermesLogActivity(content, modifiedAt);
}

async function readLatestHermesSessionSummary(sessionsDir) {
  const directoryEntries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(
    directoryEntries
      .filter((entry) => entry.isFile() && /^session_.*\.json$/i.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(sessionsDir, entry.name);
        const stat = await fs.stat(filePath).catch(() => null);
        return stat ? { filePath, fileName: entry.name, stat } : null;
      })
  );

  const recentFiles = candidates
    .filter(Boolean)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
    .slice(0, 8);

  for (const file of recentFiles) {
    const raw = await fs.readFile(file.filePath, "utf8").catch(() => "");
    if (!raw) {
      continue;
    }
    try {
      const payload = JSON.parse(raw);
      return summarizeHermesSessionPayload(payload, file.stat, file.fileName);
    } catch (_error) {
      continue;
    }
  }

  return null;
}

function summarizeHermesSessionPayload(payload, stat, fileName = "") {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const updatedAt = stat?.mtime ? new Date(stat.mtime).toISOString() : "";
  const sessionId = String(payload?.session_id || "").trim();
  const lastMessage = messages.at(-1) || null;
  const inProgress = Boolean(
    (lastMessage?.role === "assistant" && Array.isArray(lastMessage?.tool_calls) && lastMessage.tool_calls.length)
    || lastMessage?.role === "tool"
  );

  let fallbackUser = "";
  let fallbackTool = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] || {};
    const role = String(message.role || "").trim();
    if (role === "assistant") {
      const reasoning = normalizeHermesDetail(message.reasoning);
      if (reasoning) {
        return {
          updatedAt,
          sessionId,
          fileName,
          inProgress,
          detail: `Thinking: ${reasoning}`,
          source: "reasoning",
        };
      }
      const content = normalizeHermesDetail(message.content);
      const callingTool = summarizeCallingToolPlaceholder(content);
      if (callingTool) {
        return {
          updatedAt,
          sessionId,
          fileName,
          inProgress,
          detail: callingTool,
          source: "tool_call_placeholder",
        };
      }
      if (content) {
        return {
          updatedAt,
          sessionId,
          fileName,
          inProgress,
          detail: `Assistant: ${content}`,
          source: "assistant",
        };
      }
      const toolCallDetail = summarizeHermesToolCalls(message.tool_calls);
      if (toolCallDetail) {
        return {
          updatedAt,
          sessionId,
          fileName,
          inProgress,
          detail: toolCallDetail,
          source: "tool_calls",
        };
      }
    }
    if (!fallbackTool && role === "tool") {
      const content = normalizeHermesDetail(message.content);
      if (content) {
        fallbackTool = `Latest tool output: ${content}`;
      }
    }
    if (!fallbackUser && role === "user") {
      const content = normalizeHermesDetail(message.content);
      if (content) {
        fallbackUser = `Task: ${content}`;
      }
    }
  }

  return {
    updatedAt,
    sessionId,
    fileName,
    inProgress,
    detail: fallbackTool || fallbackUser || `Session ${sessionId || fileName || "unknown"}`,
    source: fallbackTool ? "tool" : fallbackUser ? "user" : "session",
  };
}

function summarizeHermesToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) {
    return "";
  }
  const details = toolCalls
    .map((toolCall) => summarizeHermesToolCall(toolCall))
    .filter(Boolean);
  if (!details.length) {
    return "";
  }
  if (details.length === 1) {
    return details[0];
  }
  return `${details[0]} (+${details.length - 1} more)`;
}

function summarizeHermesToolCall(toolCall) {
  const fn = String(toolCall?.function?.name || "").trim();
  const argsText = String(toolCall?.function?.arguments || "").trim();
  const args = parseJsonObject(argsText);
  if (fn === "terminal") {
    const command = normalizeHermesDetail(args?.command || args?.cmd || "");
    return command ? `Running terminal: ${command}` : "Running terminal command";
  }
  if (fn === "skill_view") {
    const name = normalizeHermesDetail(args?.name || "");
    return name ? `Loading skill: ${name}` : "Loading skill";
  }
  if (fn === "skill_search") {
    const query = normalizeHermesDetail(args?.query || "");
    return query ? `Searching skills: ${query}` : "Searching skills";
  }
  if (fn === "grep_files") {
    const pattern = normalizeHermesDetail(args?.pattern || args?.query || "");
    return pattern ? `Searching code: ${pattern}` : "Searching code";
  }
  if (!fn) {
    return "";
  }
  return `Running ${fn}`;
}

function humanizeHermesFeedKind(kind) {
  const value = String(kind || "").trim();
  if (value === "tool_call") {
    return "Tool Call";
  }
  if (value === "tool_output") {
    return "Tool Output";
  }
  if (value === "thinking") {
    return "Thinking";
  }
  if (value === "assistant") {
    return "Assistant";
  }
  if (value === "user") {
    return "User";
  }
  return "Log";
}

function formatHermesToolCallDetail(toolCall) {
  const fn = String(toolCall?.function?.name || "").trim();
  const argsText = String(toolCall?.function?.arguments || "").trim();
  const parsed = parseJsonObject(argsText);
  const renderedArgs = parsed ? safeJsonStringify(parsed, 2) : argsText;
  return [`tool: ${fn || "unknown"}`, renderedArgs ? `args:\n${renderedArgs}` : ""].filter(Boolean).join("\n");
}

function formatHermesFeedDetail(value, limit = 3200) {
  const text = typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : safeJsonStringify(value, 2);
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function extractCallingToolPlaceholder(content) {
  const matched = String(content || "").match(/\[Calling tool:\s*([^>\]]+)/i);
  return matched?.[1] ? String(matched[1]).trim() : "";
}

function removeCallingToolPlaceholder(content) {
  return String(content || "").replace(/\s*\[Calling tool:[^\]]+\]\s*/gi, " ").replace(/\s+/g, " ").trim();
}

function formatHermesFeedTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const date = new Date(raw.includes("T") ? raw : raw.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function summarizeCallingToolPlaceholder(content) {
  const matched = String(content || "").match(/^\[Calling tool:\s*([^>\]]+)/i);
  if (!matched?.[1]) {
    return "";
  }
  return `Running ${normalizeHermesDetail(matched[1])}`;
}

function summarizeHermesLogActivity(content, modifiedAt) {
  const lines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const now = Date.now();
  let lastInbound = null;
  let lastResponse = null;
  let lastMeaningful = null;

  for (const line of lines) {
    const parsed = parseHermesLogLine(line);
    if (!parsed) {
      continue;
    }
    const message = parsed.message;
    if (/inbound message:/i.test(message)) {
      lastInbound = {
        timestamp: parsed.timestamp,
        detail: extractInboundHermesDetail(message),
      };
      continue;
    }
    if (/response ready:/i.test(message)) {
      lastResponse = {
        timestamp: parsed.timestamp,
        detail: normalizeHermesDetail(message),
      };
      continue;
    }
    if (!isNoiseHermesLogMessage(message)) {
      lastMeaningful = {
        timestamp: parsed.timestamp,
        detail: summarizeHermesLogMessage(message),
      };
    }
  }

  const lastInboundAt = lastInbound?.timestamp ? Date.parse(lastInbound.timestamp) : 0;
  const lastResponseAt = lastResponse?.timestamp ? Date.parse(lastResponse.timestamp) : 0;
  const workingFromLog = Boolean(
    lastInboundAt
    && lastInboundAt >= lastResponseAt
    && now - lastInboundAt <= HERMES_STATUS_ACTIVE_WINDOW_MS
  );

  return {
    updatedAt: modifiedAt ? new Date(modifiedAt).toISOString() : "",
    working: workingFromLog,
    detail: workingFromLog
      ? (lastMeaningful?.timestamp && Date.parse(lastMeaningful.timestamp) >= lastInboundAt
          ? lastMeaningful.detail
          : lastInbound?.detail || "")
      : (lastMeaningful?.detail || lastResponse?.detail || ""),
    lastInboundAt: lastInbound?.timestamp || "",
    lastResponseAt: lastResponse?.timestamp || "",
    lastActivityAt: lastMeaningful?.timestamp || lastResponse?.timestamp || lastInbound?.timestamp || "",
  };
}

function parseHermesLogLine(line) {
  const match = String(line || "").match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+\s+\w+\s+[^:]+:\s+(.*)$/);
  if (!match) {
    return null;
  }
  const isoLike = match[1].replace(" ", "T");
  return {
    timestamp: Number.isNaN(Date.parse(isoLike)) ? "" : `${isoLike}`,
    message: String(match[2] || "").trim(),
  };
}

function extractInboundHermesDetail(message) {
  const matched = String(message || "").match(/msg='([^']+)/i);
  if (matched?.[1]) {
    return `Handling message: ${normalizeHermesDetail(matched[1])}`;
  }
  return summarizeHermesLogMessage(message);
}

function isNoiseHermesLogMessage(message) {
  const text = String(message || "").trim();
  return [
    /^✓ /,
    /^Connected to /i,
    /^Disconnected from /i,
    /^\[Homeassistant\]/i,
    /^\[Telegram\]/i,
    /^\[Telegram\] Connected to /i,
    /^\[Telegram\] Disconnected/i,
    /^Telegram menu:/i,
    /^Gateway running with /i,
    /^Channel directory built:/i,
    /^Press Ctrl\+C to stop$/i,
    /^Cron ticker started/i,
    /^kanban dispatcher:/i,
    /^\[Telegram\] Flushing text batch/i,
    /^\[Telegram\] Sending response/i,
    /^response ready:/i,
    /^Application started$/i,
    /^Scheduler started$/i,
    /^DoH discovery yielded/i,
    /fallback IPs/i,
    /^Stopping gateway/i,
    /^Gateway stopped$/i,
    /^Cron ticker stopped$/i,
    /^Exiting with code /i,
    /^Application is stopping/i,
    /^Application\.stop\(\) complete/i,
    /^Scheduler has been shut down/i,
    /^Invalidated run generation/i,
    /^Shutdown diagnostic/i,
    /^Connecting to /i,
    /^Starting Hermes Gateway/i,
    /^Session storage:/i,
    /^Agent budget:/i,
    /^Previous gateway exited cleanly/i,
    /^Plugin /i,
    /^MCP /i,
  ].some((pattern) => pattern.test(text));
}

function summarizeHermesLogMessage(message) {
  const text = normalizeHermesDetail(message);
  if (!text) {
    return "";
  }
  if (/^Loaded environment variables/i.test(text)) {
    return "Loaded Hermes environment";
  }
  if (/^Auxiliary /i.test(text)) {
    return text;
  }
  if (/^Invalidated run generation/i.test(text)) {
    return "Session reset or stop applied";
  }
  if (/^Received SIGTERM\/SIGINT/i.test(text)) {
    return "Gateway restart in progress";
  }
  if (/^Shutdown diagnostic/i.test(text)) {
    return "Gateway shutdown diagnostic captured";
  }
  return text;
}

function finalizeHermesRuntimeStatus({ key, label, online, hostLabel, sessionInfo, logInfo, serviceState = "" }) {
  const sessionUpdatedAt = sessionInfo?.updatedAt ? Date.parse(sessionInfo.updatedAt) : 0;
  const logActivityAt = logInfo?.lastActivityAt ? Date.parse(logInfo.lastActivityAt) : 0;
  const recentSessionActive = Boolean(
    sessionInfo?.inProgress
    && sessionUpdatedAt
    && Date.now() - sessionUpdatedAt <= HERMES_STATUS_ACTIVE_WINDOW_MS
  );
  const prefersSession = Boolean(sessionUpdatedAt && sessionUpdatedAt >= logActivityAt);
  const working = Boolean(online && (logInfo?.working || recentSessionActive));
  const primaryDetail = working
    ? (recentSessionActive && sessionInfo?.detail ? sessionInfo.detail : logInfo?.detail || sessionInfo?.detail || "")
    : (
        prefersSession
          ? sessionInfo?.detail || logInfo?.detail || ""
          : (logInfo?.detail || (logActivityAt ? "" : sessionInfo?.detail || ""))
      );
  const detail = normalizeHermesDetail(primaryDetail) || (online ? "Gateway online and idle." : "Gateway offline.");
  const updatedAt = [sessionInfo?.updatedAt, logInfo?.updatedAt, logInfo?.lastActivityAt]
    .filter(Boolean)
    .sort()
    .at(-1) || new Date().toISOString();
  return buildHermesRuntimeStatus({
    key,
    label,
    hostLabel,
    online,
    working,
    detail,
    updatedAt,
    serviceState,
    sessionId: (prefersSession || recentSessionActive) ? (sessionInfo?.sessionId || "") : "",
    source: working
      ? (recentSessionActive && sessionInfo?.detail ? "session" : logInfo?.detail ? "log" : "")
      : (prefersSession ? (sessionInfo?.source || (logInfo?.detail ? "log" : "")) : (logInfo?.detail ? "log" : (sessionInfo?.source || ""))),
    lastActivityAt: sessionUpdatedAt > logActivityAt ? sessionInfo?.updatedAt || "" : logInfo?.lastActivityAt || "",
  });
}

function buildHermesRuntimeStatus({
  key,
  label,
  hostLabel,
  online,
  working = false,
  detail = "",
  updatedAt = "",
  serviceState = "",
  sessionId = "",
  source = "",
  lastActivityAt = "",
}) {
  const state = working ? "working" : online ? "online" : "offline";
  const statusLabel = working ? "working" : online ? "online" : "offline";
  const tooltipLines = [
    `${label} (${hostLabel})`,
    `Status: ${statusLabel}${serviceState ? ` [${serviceState}]` : ""}`,
    detail ? `Activity: ${detail}` : "",
    sessionId ? `Session: ${sessionId}` : "",
    lastActivityAt ? `Last activity: ${lastActivityAt}` : "",
    updatedAt ? `Updated: ${updatedAt}` : "",
  ].filter(Boolean);
  return {
    key,
    label,
    hostLabel,
    online: Boolean(online),
    working: Boolean(online && working),
    state,
    detail,
    tooltip: tooltipLines.join("\n"),
    updatedAt,
    serviceState,
    sessionId,
    source,
    lastActivityAt,
  };
}

function normalizeHermesDetail(value) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return "";
  }
  return text.length > HERMES_STATUS_DETAIL_LIMIT ? `${text.slice(0, HERMES_STATUS_DETAIL_LIMIT - 1).trimEnd()}…` : text;
}

function parseJsonObject(value) {
  if (!String(value || "").trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function safeJsonStringify(value, indent = 2) {
  try {
    return JSON.stringify(value, null, indent);
  } catch (_error) {
    return String(value == null ? "" : value);
  }
}

function buildRemoteHermesStatusScript() {
  return [
    "set -euo pipefail",
    `export SERVICE_NAME=${shellQuote(HERMES_SYNC_SERVICE)}`,
    `export HERMES_HOME=${shellQuote(HERMES_SYNC_HOME)}`,
    "python3 - <<'PY'",
    "import glob, json, os, re, subprocess, time",
    "service = os.environ.get('SERVICE_NAME', 'hermes-gateway.service')",
    "home = os.path.expanduser(os.environ.get('HERMES_HOME', '~/.hermes'))",
    "log_path = os.path.join(home, 'logs', 'agent.log')",
    "sessions_dir = os.path.join(home, 'sessions')",
    "active_window_ms = 15 * 60 * 1000",
    "detail_limit = 220",
    "def norm(value):",
    "    text = re.sub(r'\\s+', ' ', str(value or '')).strip()",
    "    return text[:detail_limit - 1].rstrip() + '…' if len(text) > detail_limit else text",
    "def parse_log_line(line):",
    "    match = re.match(r'^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}),\\d+\\s+\\w+\\s+[^:]+:\\s+(.*)$', line)",
    "    if not match:",
    "        return None",
    "    ts = match.group(1).replace(' ', 'T')",
    "    return {'timestamp': ts, 'message': match.group(2).strip()}",
    "def inbound_detail(message):",
    "    matched = re.search(r\"msg='([^']+)\", message)",
    "    return f\"Handling message: {norm(matched.group(1))}\" if matched else norm(message)",
    "def noise(message):",
    "    patterns = [r'^✓ ', r'^Connected to ', r'^Disconnected from ', r'^\\[Homeassistant\\]', r'^\\[Telegram\\]', r'^Telegram menu:', r'^Gateway running with ', r'^Channel directory built:', r'^Press Ctrl\\+C to stop$', r'^Cron ticker started', r'^kanban dispatcher:', r'^response ready:', r'^Application started$', r'^Scheduler started$', r'^DoH discovery yielded', r'fallback IPs', r'^Stopping gateway', r'^Gateway stopped$', r'^Cron ticker stopped$', r'^Exiting with code ', r'^Application is stopping', r'^Application\\.stop\\(\\) complete', r'^Scheduler has been shut down', r'^Invalidated run generation', r'^Shutdown diagnostic', r'^Connecting to ', r'^Starting Hermes Gateway', r'^Session storage:', r'^Agent budget:', r'^Previous gateway exited cleanly', r'^Plugin ', r'^MCP ' ]",
    "    return any(re.search(pattern, message) for pattern in patterns)",
    "def summarize_log_message(message):",
    "    text = norm(message)",
    "    if re.search(r'^Loaded environment variables', text):",
    "        return 'Loaded Hermes environment'",
    "    if re.search(r'^Auxiliary ', text):",
    "        return text",
    "    if re.search(r'^Invalidated run generation', text):",
    "        return 'Session reset or stop applied'",
    "    if re.search(r'^Received SIGTERM/SIGINT', text):",
    "        return 'Gateway restart in progress'",
    "    return text",
    "def summarize_tool_call(tool_call):",
    "    fn = str(((tool_call or {}).get('function') or {}).get('name') or '').strip()",
    "    arg_text = str(((tool_call or {}).get('function') or {}).get('arguments') or '').strip()",
    "    args = None",
    "    if arg_text:",
    "        try:",
    "            args = json.loads(arg_text)",
    "        except Exception:",
    "            args = None",
    "    if fn == 'terminal':",
    "        cmd = norm((args or {}).get('command') or (args or {}).get('cmd') or '')",
    "        return f'Running terminal: {cmd}' if cmd else 'Running terminal command'",
    "    if fn == 'skill_view':",
    "        name = norm((args or {}).get('name') or '')",
    "        return f'Loading skill: {name}' if name else 'Loading skill'",
    "    if fn == 'skill_search':",
    "        query = norm((args or {}).get('query') or '')",
    "        return f'Searching skills: {query}' if query else 'Searching skills'",
    "    return f'Running {fn}' if fn else ''",
    "def summarize_tool_calls(tool_calls):",
    "    details = [summarize_tool_call(item) for item in (tool_calls or [])]",
    "    details = [item for item in details if item]",
    "    if not details:",
    "        return ''",
    "    return details[0] + (f' (+{len(details) - 1} more)' if len(details) > 1 else '')",
    "def summarize_session():",
    "    try:",
    "        files = sorted(glob.glob(os.path.join(sessions_dir, 'session_*.json')), key=os.path.getmtime, reverse=True)[:8]",
    "    except Exception:",
    "        files = []",
    "    for file_path in files:",
    "        try:",
    "            with open(file_path, 'r', encoding='utf-8') as handle:",
    "                payload = json.load(handle)",
    "        except Exception:",
    "            continue",
    "        messages = payload.get('messages') or []",
    "        last_message = messages[-1] if messages else {}",
    "        in_progress = bool((last_message.get('role') == 'assistant' and (last_message.get('tool_calls') or [])) or last_message.get('role') == 'tool')",
    "        fallback_user = ''",
    "        fallback_tool = ''",
    "        for message in reversed(messages):",
    "            role = str(message.get('role') or '').strip()",
    "            if role == 'assistant':",
    "                reasoning = norm(message.get('reasoning'))",
    "                if reasoning:",
    "                    return {'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(os.path.getmtime(file_path))), 'sessionId': str(payload.get('session_id') or ''), 'inProgress': in_progress, 'detail': f'Thinking: {reasoning}', 'source': 'reasoning'}",
    "                content = norm(message.get('content'))",
    "                placeholder = re.match(r'^\\[Calling tool:\\s*([^>\\]]+)', content or '')",
    "                if placeholder:",
    "                    return {'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(os.path.getmtime(file_path))), 'sessionId': str(payload.get('session_id') or ''), 'inProgress': in_progress, 'detail': f'Running {norm(placeholder.group(1))}', 'source': 'tool_call_placeholder'}",
    "                if content:",
    "                    return {'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(os.path.getmtime(file_path))), 'sessionId': str(payload.get('session_id') or ''), 'inProgress': in_progress, 'detail': f'Assistant: {content}', 'source': 'assistant'}",
    "                tool_detail = summarize_tool_calls(message.get('tool_calls') or [])",
    "                if tool_detail:",
    "                    return {'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(os.path.getmtime(file_path))), 'sessionId': str(payload.get('session_id') or ''), 'inProgress': in_progress, 'detail': tool_detail, 'source': 'tool_calls'}",
    "            if not fallback_tool and role == 'tool':",
    "                content = norm(message.get('content'))",
    "                if content:",
    "                    fallback_tool = f'Latest tool output: {content}'",
    "            if not fallback_user and role == 'user':",
    "                content = norm(message.get('content'))",
    "                if content:",
    "                    fallback_user = f'Task: {content}'",
    "        return {'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(os.path.getmtime(file_path))), 'sessionId': str(payload.get('session_id') or ''), 'inProgress': in_progress, 'detail': fallback_tool or fallback_user or 'Recent Hermes session activity', 'source': 'fallback'}",
    "    return None",
    "def summarize_log():",
    "    try:",
    "        with open(log_path, 'r', encoding='utf-8', errors='ignore') as handle:",
    "            handle.seek(0, os.SEEK_END)",
    "            size = handle.tell()",
    "            start = max(0, size - (256 * 1024))",
    "            handle.seek(start)",
    "            text = handle.read()",
    "        modified_at = time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(os.path.getmtime(log_path))) if os.path.exists(log_path) else ''",
    "    except Exception:",
    "        return {'updatedAt': '', 'working': False, 'detail': '', 'lastInboundAt': '', 'lastResponseAt': '', 'lastActivityAt': ''}",
    "    lines = [line.strip() for line in text.splitlines() if line.strip()]",
    "    last_inbound = None",
    "    last_response = None",
    "    last_meaningful = None",
    "    for line in lines:",
    "        parsed = parse_log_line(line)",
    "        if not parsed:",
    "            continue",
    "        message = parsed['message']",
    "        if re.search(r'inbound message:', message, re.I):",
    "            last_inbound = {'timestamp': parsed['timestamp'], 'detail': inbound_detail(message)}",
    "            continue",
    "        if re.search(r'response ready:', message, re.I):",
    "            last_response = {'timestamp': parsed['timestamp'], 'detail': norm(message)}",
    "            continue",
    "        if not noise(message):",
    "            last_meaningful = {'timestamp': parsed['timestamp'], 'detail': summarize_log_message(message)}",
    "    def to_ms(value):",
    "        if not value:",
    "            return 0",
    "        try:",
    "            return int(time.mktime(time.strptime(value, '%Y-%m-%dT%H:%M:%S')) * 1000)",
    "        except Exception:",
    "            return 0",
    "    now_ms = int(time.time() * 1000)",
    "    inbound_ms = to_ms((last_inbound or {}).get('timestamp'))",
    "    response_ms = to_ms((last_response or {}).get('timestamp'))",
    "    working = bool(inbound_ms and inbound_ms >= response_ms and now_ms - inbound_ms <= active_window_ms)",
    "    detail = ''",
    "    if working:",
    "        last_meaningful_ms = to_ms((last_meaningful or {}).get('timestamp'))",
    "        detail = ((last_meaningful or {}).get('detail') if last_meaningful_ms >= inbound_ms else '') or (last_inbound or {}).get('detail') or ''",
    "    else:",
    "        detail = ((last_meaningful or {}).get('detail') or (last_response or {}).get('detail') or '')",
    "    return {'updatedAt': modified_at, 'working': working, 'detail': detail, 'lastInboundAt': (last_inbound or {}).get('timestamp') or '', 'lastResponseAt': (last_response or {}).get('timestamp') or '', 'lastActivityAt': ((last_meaningful or {}).get('timestamp') or (last_response or {}).get('timestamp') or (last_inbound or {}).get('timestamp') or '')}",
    "service_state = ''",
    "online = False",
    "try:",
    "    service_state = subprocess.check_output(['systemctl', '--user', 'is-active', service], text=True, stderr=subprocess.DEVNULL).strip()",
    "    online = service_state.startswith('active')",
    "except Exception:",
    "    service_state = 'inactive'",
    "payload = {'online': online, 'serviceState': service_state, 'session': summarize_session(), 'log': summarize_log()}",
    "print('__HERMES_STATUS__' + json.dumps(payload, ensure_ascii=False) + '__END__')",
    "PY",
  ].join('\n');
}

function buildRemoteHermesFeedScript() {
  return [
    "set -euo pipefail",
    `export SERVICE_NAME=${shellQuote(HERMES_SYNC_SERVICE)}`,
    `export HERMES_HOME=${shellQuote(HERMES_SYNC_HOME)}`,
    "python3 - <<'PY'",
    "import glob, json, os, re, subprocess, time",
    "service = os.environ.get('SERVICE_NAME', 'hermes-gateway.service')",
    "home = os.path.expanduser(os.environ.get('HERMES_HOME', '~/.hermes'))",
    "log_path = os.path.join(home, 'logs', 'agent.log')",
    "sessions_dir = os.path.join(home, 'sessions')",
    "feed_log_limit = 48",
    "feed_entry_limit = 240",
    "def norm(value, limit=3200):",
    "    if isinstance(value, (dict, list)):",
    "        text = json.dumps(value, ensure_ascii=False, indent=2)",
    "    else:",
    "        text = str(value or '').strip()",
    "    if not text:",
    "        return ''",
    "    return text[:limit - 1].rstrip() + '…' if len(text) > limit else text",
    "def parse_json(value):",
    "    if not str(value or '').strip():",
    "        return None",
    "    try:",
    "        return json.loads(value)",
    "    except Exception:",
    "        return None",
    "def parse_log_line(line):",
    "    match = re.match(r'^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}),\\d+\\s+\\w+\\s+[^:]+:\\s+(.*)$', line)",
    "    if not match:",
    "        return None",
    "    return {'timestamp': match.group(1).replace(' ', 'T'), 'message': match.group(2).strip()}",
    "def noise(message):",
    "    patterns = [r'^✓ ', r'^Connected to ', r'^Disconnected from ', r'^\\[Homeassistant\\]', r'^\\[Telegram\\]', r'^Telegram menu:', r'^Gateway running with ', r'^Channel directory built:', r'^Press Ctrl\\+C to stop$', r'^Cron ticker started', r'^kanban dispatcher:', r'^response ready:', r'^Application started$', r'^Scheduler started$', r'^DoH discovery yielded', r'fallback IPs', r'^Stopping gateway', r'^Gateway stopped$', r'^Cron ticker stopped$', r'^Exiting with code ', r'^Application is stopping', r'^Application\\.stop\\(\\) complete', r'^Scheduler has been shut down', r'^Invalidated run generation', r'^Shutdown diagnostic', r'^Connecting to ', r'^Starting Hermes Gateway', r'^Session storage:', r'^Agent budget:', r'^Previous gateway exited cleanly', r'^Plugin ', r'^MCP ' ]",
    "    return any(re.search(pattern, message) for pattern in patterns)",
    "def summarize_log(message):",
    "    text = norm(message, 600)",
    "    if re.search(r'^Loaded environment variables', text):",
    "        return 'Loaded Hermes environment'",
    "    if re.search(r'^Auxiliary ', text):",
    "        return text",
    "    if re.search(r'^Received SIGTERM/SIGINT', text):",
    "        return 'Gateway restart in progress'",
    "    return text",
    "def tool_title(tool_call):",
    "    fn = str(((tool_call or {}).get('function') or {}).get('name') or '').strip()",
    "    args_text = str(((tool_call or {}).get('function') or {}).get('arguments') or '').strip()",
    "    args = parse_json(args_text) or {}",
    "    if fn == 'terminal':",
    "        cmd = norm(args.get('command') or args.get('cmd') or '', 220)",
    "        return f'Running terminal: {cmd}' if cmd else 'Running terminal command'",
    "    if fn == 'skill_view':",
    "        name = norm(args.get('name') or '', 220)",
    "        return f'Loading skill: {name}' if name else 'Loading skill'",
    "    if fn == 'skill_search':",
    "        query = norm(args.get('query') or '', 220)",
    "        return f'Searching skills: {query}' if query else 'Searching skills'",
    "    return f'Running {fn}' if fn else 'Tool call'",
    "def tool_detail(tool_call):",
    "    fn = str(((tool_call or {}).get('function') or {}).get('name') or '').strip()",
    "    args_text = str(((tool_call or {}).get('function') or {}).get('arguments') or '').strip()",
    "    parsed = parse_json(args_text)",
    "    rendered = json.dumps(parsed, ensure_ascii=False, indent=2) if parsed is not None else args_text",
    "    parts = [f'tool: {fn or \"unknown\"}']",
    "    if rendered:",
    "        parts.append(f'args:\\n{rendered}')",
    "    return '\\n'.join(parts)",
    "def strip_placeholder(content):",
    "    return re.sub(r'\\s*\\[Calling tool:[^\\]]+\\]\\s*', ' ', str(content or '')).strip()",
    "def extract_placeholder(content):",
    "    match = re.search(r'\\[Calling tool:\\s*([^>\\]]+)', str(content or ''))",
    "    return str(match.group(1)).strip() if match else ''",
    "def latest_session():",
    "    try:",
    "        files = sorted(glob.glob(os.path.join(sessions_dir, 'session_*.json')), key=os.path.getmtime, reverse=True)[:8]",
    "    except Exception:",
    "        files = []",
    "    for file_path in files:",
    "        try:",
    "            with open(file_path, 'r', encoding='utf-8') as handle:",
    "                payload = json.load(handle)",
    "        except Exception:",
    "            continue",
    "        messages = payload.get('messages') or []",
    "        entries = []",
    "        step = 1",
    "        for message in messages:",
    "            role = str(message.get('role') or '').strip()",
    "            if role == 'user':",
    "                content = norm(message.get('content'), 2400)",
    "                if content:",
    "                    entries.append({'id': f'user-{step}', 'kind': 'user', 'title': 'User message', 'detail': content, 'stepLabel': f'Step {step}', 'source': 'session'})",
    "                    step += 1",
    "                continue",
    "            if role == 'assistant':",
    "                reasoning = norm(message.get('reasoning'), 3200)",
    "                if reasoning:",
    "                    entries.append({'id': f'assistant-thinking-{step}', 'kind': 'thinking', 'title': 'Internal reasoning', 'detail': reasoning, 'stepLabel': f'Step {step}', 'source': 'session'})",
    "                    step += 1",
    "                content = str(message.get('content') or '').strip()",
    "                placeholder = extract_placeholder(content)",
    "                cleaned = norm(strip_placeholder(content), 3200)",
    "                if cleaned:",
    "                    entries.append({'id': f'assistant-{step}', 'kind': 'assistant', 'title': 'Assistant message', 'detail': cleaned, 'stepLabel': f'Step {step}', 'source': 'session'})",
    "                    step += 1",
    "                if placeholder:",
    "                    entries.append({'id': f'placeholder-{step}', 'kind': 'tool_call', 'title': 'Assistant started tool', 'detail': f'Running {placeholder}', 'stepLabel': f'Step {step}', 'source': 'session'})",
    "                    step += 1",
    "                for tool_call in (message.get('tool_calls') or []):",
    "                    entries.append({'id': f'tool-call-{step}-{len(entries)+1}', 'kind': 'tool_call', 'title': tool_title(tool_call), 'detail': tool_detail(tool_call), 'stepLabel': f'Step {step}', 'source': 'session'})",
    "                    step += 1",
    "                continue",
    "            if role == 'tool':",
    "                content = norm(message.get('content'), 3600)",
    "                if content:",
    "                    entries.append({'id': f'tool-output-{step}', 'kind': 'tool_output', 'title': 'Tool output', 'detail': content, 'stepLabel': f'Step {step}', 'source': 'session'})",
    "                    step += 1",
    "        return {'sessionId': str(payload.get('session_id') or ''), 'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(os.path.getmtime(file_path))), 'entries': entries[-feed_entry_limit:]}",
    "    return None",
    "def log_feed():",
    "    try:",
    "        with open(log_path, 'r', encoding='utf-8', errors='ignore') as handle:",
    "            handle.seek(0, os.SEEK_END)",
    "            size = handle.tell()",
    "            start = max(0, size - (256 * 1024))",
    "            handle.seek(start)",
    "            text = handle.read()",
    "        updated_at = time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(os.path.getmtime(log_path))) if os.path.exists(log_path) else ''",
    "    except Exception:",
    "        return {'updatedAt': '', 'entries': []}",
    "    entries = []",
    "    for line in [line.strip() for line in text.splitlines() if line.strip()]:",
    "        parsed = parse_log_line(line)",
    "        if not parsed or noise(parsed['message']):",
    "            continue",
    "        entries.append({'id': f'log-{len(entries)+1}', 'kind': 'log', 'title': summarize_log(parsed['message']), 'detail': parsed['message'], 'timestamp': parsed['timestamp'], 'source': 'log'})",
    "    return {'updatedAt': updated_at, 'entries': entries[-feed_log_limit:]}",
    "service_state = ''",
    "online = False",
    "try:",
    "    service_state = subprocess.check_output(['systemctl', '--user', 'is-active', service], text=True, stderr=subprocess.DEVNULL).strip()",
    "    online = service_state.startswith('active')",
    "except Exception:",
    "    service_state = 'inactive'",
    "session = latest_session()",
    "log = log_feed()",
    "payload = {'updatedAt': log.get('updatedAt') or (session or {}).get('updatedAt') or '', 'online': online, 'serviceState': service_state, 'session': session, 'log': log}",
    "print('__HERMES_FEED__' + json.dumps(payload, ensure_ascii=False) + '__END__')",
    "PY",
  ].join('\\n');
}

function serializeSlotBenchmark(benchmark) {
  if (!benchmark) {
    return null;
  }
  return {
    slotId: benchmark.slotId,
    slotLabel: benchmark.slotLabel,
    status: benchmark.status,
    standardId: benchmark.standardId,
    standardLabel: benchmark.standardLabel,
    promptSummary: benchmark.promptSummary,
    startedAt: benchmark.startedAt,
    updatedAt: benchmark.updatedAt,
    endedAt: benchmark.endedAt || null,
    endpoint: benchmark.endpoint || "",
    modelId: benchmark.modelId || "",
    error: benchmark.error || "",
    progress: {
      elapsedMs: Number(benchmark.progress?.elapsedMs || 0),
      firstTokenMs: Number(benchmark.progress?.firstTokenMs || 0) || null,
      receivedChars: Number(benchmark.progress?.receivedChars || 0),
      chunkCount: Number(benchmark.progress?.chunkCount || 0),
    },
    result: benchmark.result ? { ...benchmark.result } : null,
  };
}

function startSlotBenchmark(slot, status) {
  const benchmark = {
    slotId: slot.id,
    slotLabel: slot.label,
    status: "running",
    standardId: SLOT_BENCHMARK_STANDARD.id,
    standardLabel: SLOT_BENCHMARK_STANDARD.label,
    promptSummary: SLOT_BENCHMARK_STANDARD.promptSummary,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    endedAt: null,
    endpoint: `http://${API_PUBLIC_HOST}:${slot.publicPort}/v1/chat/completions`,
    modelId: String(status?.model?.key || status?.model?.label || "").trim(),
    error: "",
    progress: {
      elapsedMs: 0,
      firstTokenMs: null,
      receivedChars: 0,
      chunkCount: 0,
    },
    result: null,
  };
  SLOT_BENCHMARKS.set(slot.id, benchmark);
  void executeSlotBenchmark(slot, benchmark);
  return benchmark;
}

async function executeSlotBenchmark(slot, benchmark) {
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLOT_BENCHMARK_STANDARD.timeoutMs);
  timeout.unref?.();
  const heartbeat = setInterval(() => {
    benchmark.progress.elapsedMs = Date.now() - startedAtMs;
    benchmark.updatedAt = new Date().toISOString();
  }, 250);
  heartbeat.unref?.();

  try {
    const liveModels = await readModelsFromEndpoint(`http://${API_PUBLIC_HOST}:${slot.publicPort}/v1/models`);
    const modelId = String(liveModels[0]?.id || liveModels[0]?.name || benchmark.modelId || "").trim();
    if (!modelId) {
      throw new Error("Active runtime did not return a model ID.");
    }
    benchmark.modelId = modelId;
    benchmark.updatedAt = new Date().toISOString();

    const response = await fetch(benchmark.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer api",
      },
      body: JSON.stringify({
        ...SLOT_BENCHMARK_STANDARD.request,
        model: modelId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Benchmark request failed: ${response.status} ${body.trim() || response.statusText}`.trim());
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new Error("Benchmark response did not provide a readable stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let outputText = "";
    let usage = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const parsed = parseSseDataFrames(buffer);
      buffer = parsed.buffer;
      for (const frame of parsed.frames) {
        if (frame === "[DONE]") {
          continue;
        }
        let payload = null;
        try {
          payload = JSON.parse(frame);
        } catch (_error) {
          continue;
        }
        if (payload?.usage) {
          usage = payload.usage;
        }
        const deltaText = extractBenchmarkDeltaText(payload);
        if (!deltaText) {
          continue;
        }
        outputText += deltaText;
        benchmark.progress.receivedChars = outputText.length;
        benchmark.progress.chunkCount += 1;
        if (!benchmark.progress.firstTokenMs) {
          benchmark.progress.firstTokenMs = Date.now() - startedAtMs;
        }
        benchmark.updatedAt = new Date().toISOString();
      }
    }

    const elapsedMs = Date.now() - startedAtMs;
    benchmark.status = "completed";
    benchmark.endedAt = new Date().toISOString();
    benchmark.progress.elapsedMs = elapsedMs;
    benchmark.result = computeSlotBenchmarkMetrics({
      elapsedMs,
      firstTokenMs: benchmark.progress.firstTokenMs,
      outputText,
      usage,
    });
  } catch (error) {
    benchmark.status = "failed";
    benchmark.endedAt = new Date().toISOString();
    benchmark.progress.elapsedMs = Date.now() - startedAtMs;
    benchmark.error = error?.name === "AbortError"
      ? `Benchmark timed out after ${Math.round(SLOT_BENCHMARK_STANDARD.timeoutMs / 1000)}s.`
      : (formatExecError(error) || error.message || "Benchmark failed.");
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    benchmark.updatedAt = new Date().toISOString();
  }
}

function parseSseDataFrames(buffer) {
  let remaining = String(buffer || "").replace(/\r\n/g, "\n");
  const frames = [];
  let boundary = remaining.indexOf("\n\n");
  while (boundary !== -1) {
    const rawFrame = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + 2);
    const data = rawFrame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (data) {
      frames.push(data);
    }
    boundary = remaining.indexOf("\n\n");
  }
  return { frames, buffer: remaining };
}

function extractBenchmarkDeltaText(payload) {
  const content = payload?.choices?.[0]?.delta?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

function estimateTextTokens(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.round(normalized.length / 4));
}

function computeSlotBenchmarkMetrics({ elapsedMs, firstTokenMs, outputText, usage }) {
  const elapsed = Math.max(1, Number(elapsedMs) || 0);
  const promptTokensRaw = Number(usage?.prompt_tokens || 0);
  const completionTokensRaw = Number(usage?.completion_tokens || 0);
  const promptTokens = promptTokensRaw > 0 ? promptTokensRaw : null;
  const completionTokens = completionTokensRaw > 0 ? completionTokensRaw : estimateTextTokens(outputText);
  const totalTokensRaw = Number(usage?.total_tokens || 0);
  const totalTokens = totalTokensRaw > 0
    ? totalTokensRaw
    : (promptTokens ? promptTokens + completionTokens : completionTokens);
  const normalizedFirstTokenMs = Number(firstTokenMs || 0);
  const receivedChars = String(outputText || "").length;
  return {
    elapsedMs: elapsed,
    firstTokenMs: normalizedFirstTokenMs > 0 ? normalizedFirstTokenMs : null,
    promptTokens,
    completionTokens,
    totalTokens,
    completionTokensEstimated: completionTokensRaw <= 0,
    receivedChars,
    charsPerSecond: round1((receivedChars * 1000) / elapsed),
    completionTokensPerSecond: round1((completionTokens * 1000) / elapsed),
    outputPreview: String(outputText || "").trim().slice(0, 160),
  };
}

async function readStatusFromScript(script, slot, fallbackLogs, launcher) {
  try {
    const output = await runLauncher(script, ["--slot", slot.id, "--status-json"], { timeoutMs: STATUS_SCRIPT_TIMEOUT_MS });
    const payload = JSON.parse(output);
    if (!payload.running) {
      return {
        slotId: slot.id,
        slotLabel: slot.label,
        slotIndex: slot.index,
        running: false,
        lastCrash: payload.lastCrash || null,
        logs: {
          gguf: getDefaultLogs(slot, "gguf"),
          "gguf-tq3": getDefaultLogs(slot, "gguf-tq3"),
          beellama: getDefaultLogs(slot, "beellama"),
          mlx: getDefaultLogs(slot, "mlx"),
          "rapid-mlx": getDefaultLogs(slot, "rapid-mlx"),
          mtplx: getDefaultLogs(slot, "mtplx"),
          optiq: getDefaultLogs(slot, "optiq"),
          dflash: getDefaultLogs(slot, "dflash"),
          turboquant: getDefaultLogs(slot, "turboquant"),
          active: { ...fallbackLogs },
        },
      };
    }

    return {
      ...payload,
      slotId: slot.id,
      slotLabel: slot.label,
      slotIndex: slot.index,
      lastCrash: payload.lastCrash || null,
      model: {
        ...payload.model,
        launcher,
        runtime: normalizeModelRuntime(payload.model?.runtime || launcher),
      },
      params: {
        ...(payload.params || {}),
        enableTinyGrammar:
          payload.params?.enableTinyGrammar ??
          (launcher === "gguf" && String(payload.model?.family || "").toLowerCase().startsWith("qwen")),
        enableStructuredGbnf: payload.params?.enableStructuredGbnf ?? false,
      },
      logs: {
        gguf: getDefaultLogs(slot, "gguf"),
        "gguf-tq3": getDefaultLogs(slot, "gguf-tq3"),
        beellama: getDefaultLogs(slot, "beellama"),
        mlx: getDefaultLogs(slot, "mlx"),
        "rapid-mlx": getDefaultLogs(slot, "rapid-mlx"),
        mtplx: getDefaultLogs(slot, "mtplx"),
        optiq: getDefaultLogs(slot, "optiq"),
        dflash: getDefaultLogs(slot, "dflash"),
        turboquant: getDefaultLogs(slot, "turboquant"),
        [launcher]: {
          server: payload.logs?.server || fallbackLogs.server,
          traffic: payload.logs?.traffic || fallbackLogs.traffic,
          proxy: payload.logs?.proxy || fallbackLogs.proxy,
        },
        active: {
          server: payload.logs?.server || fallbackLogs.server,
          traffic: payload.logs?.traffic || fallbackLogs.traffic,
          proxy: payload.logs?.proxy || fallbackLogs.proxy,
        },
      },
    };
  } catch (_error) {
      return {
        slotId: slot.id,
        slotLabel: slot.label,
        slotIndex: slot.index,
        running: false,
        lastCrash: null,
        logs: {
          gguf: getDefaultLogs(slot, "gguf"),
          "gguf-tq3": getDefaultLogs(slot, "gguf-tq3"),
          beellama: getDefaultLogs(slot, "beellama"),
          mlx: getDefaultLogs(slot, "mlx"),
          "rapid-mlx": getDefaultLogs(slot, "rapid-mlx"),
          mtplx: getDefaultLogs(slot, "mtplx"),
          optiq: getDefaultLogs(slot, "optiq"),
          dflash: getDefaultLogs(slot, "dflash"),
          turboquant: getDefaultLogs(slot, "turboquant"),
          active: { ...fallbackLogs },
        },
      };
  }
}

function resolveModelRecordByStatus(status, models) {
  if (!status?.model) {
    return null;
  }

  const candidates = [
    String(status.model.key || "").trim(),
    String(status.model.path || "").trim(),
  ].filter(Boolean);
  return models.find((entry) => {
    const entryPath = resolveModelPath(entry);
    return candidates.includes(String(entry.key || "").trim()) || (entryPath && candidates.includes(entryPath));
  }) || null;
}

function isKnownMemoryHeavyDflashModel(model) {
  const key = String(model?.key || "").toLowerCase();
  const label = String(model?.label || "").toLowerCase();
  return String(model?.runtime || "").trim() === "dflash" && (key.includes("bf16") || label.includes("bf16"));
}

function formatModelFootprint(model) {
  const sizeBytes = getModelFootprintBytes(model);
  if (sizeBytes > 0) {
    return `${model.label || model.key} (${formatBytes(sizeBytes)})`;
  }
  return model?.label || model?.key || "unknown model";
}

function getModelFootprintBytes(model) {
  const direct = Number(model?.sizeBytes || 0);
  if (direct > 0) {
    return direct;
  }

  const label = String(model?.sizeLabel || "").trim();
  const match = label.match(/([\d.]+)\s*([KMGT]?)(?:i)?B/i);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const unit = String(match[2] || "").toUpperCase();
  const power = { "": 0, K: 1, M: 2, G: 3, T: 4 }[unit];
  if (power == null) {
    return 0;
  }
  return Math.round(value * 1024 ** power);
}

async function getLaunchCompatibilityError(slot, model, models) {
  if (!isKnownMemoryHeavyDflashModel(model)) {
    return "";
  }

  const statuses = await getSlotStatuses(models);
  const otherRunning = statuses
    .filter((status) => status?.running && status.slotId !== slot.id)
    .map((status) => ({
      status,
      model: resolveModelRecordByStatus(status, models) || status.model || null,
    }))
    .filter((entry) => entry.model);

  if (!otherRunning.length) {
    return "";
  }

  const largeConflicts = otherRunning.filter((entry) => getModelFootprintBytes(entry.model) >= 25 * 1024 * 1024 * 1024);
  if (!largeConflicts.length) {
    return "";
  }

  const conflictSummary = largeConflicts.map((entry) => formatModelFootprint(entry.model)).join(", ");
  return `Qwen3.6-27B bf16 DFlash is not stable while another large model is loaded on this Mac. Conflicting runtime: ${conflictSummary}. Stop the other slot first, or use Qwen3.6-27B-MXFP4-DFlash instead.`;
}

// Thinking tokens are billed as OUTPUT tokens. A harness whose output cap was tuned
// for a non-thinking model therefore truncates the model MID-THOUGHT: it spends the
// whole budget reasoning and returns a message with no text and no tool call, which
// OpenCode renders as silence and treats as "turn over". Observed 2026-08-22 on
// Qwen3.8-27B at reasoning_effort=medium — 13,335 chars of reasoning, 4000/4000
// output tokens, zero text parts. So the cap has to scale with the reasoning effort
// the slot was actually launched with, which is why llm3 now owns this field.
// Ceiling is mlx-dspark's own --max-tokens-cap default (32768).
// Budgets are keyed to how much the template actually restrains thinking, not to how
// the level *sounds*: "medium" injects NO instruction (unguided thinking, measured at
// 36k chars / ~11k tokens on a planning step), so it needs nearly as much room as
// xhigh. Only "low" tells the model to be brief.
const HARNESS_OUTPUT_LIMIT_BY_EFFORT = Object.freeze({
  off: 4000,
  low: 8000,
  medium: 24000,
  xhigh: 32000,
});
// "" means the launcher passed no --reasoning-effort, so the model's own chat
// template decides — Qwen3.8's asks for xhigh, so budget for the worst case.
const DEFAULT_HARNESS_OUTPUT_LIMIT = 32000;

function resolveHarnessOutputLimit(reasoningEffort, contextLength = 0) {
  const key = String(reasoningEffort ?? "").trim().toLowerCase();
  const base = HARNESS_OUTPUT_LIMIT_BY_EFFORT[key] || DEFAULT_HARNESS_OUTPUT_LIMIT;
  // Never let the reply budget crowd out the context it has to fit inside.
  const ctx = Number(contextLength || 0);
  if (Number.isInteger(ctx) && ctx > 0) {
    return Math.max(4000, Math.min(base, Math.floor(ctx / 4)));
  }
  return base;
}

// Only launchers that actually expose a reasoning-effort knob get an llm3-owned
// output cap; everything else keeps whatever the file already had. The launcher
// name arrives as `launcher` on a launch request but as `runtime` in the state file
// the launcher writes, so accept either rather than depending on normalisation.
function syncTargetReasoningEffort(model, source) {
  const names = Array.isArray(model) ? model : [model];
  const isDspark = names.some((name) => String(name || "").trim() === "mlx-dspark");
  if (!isDspark) {
    return undefined;
  }
  return String(source ?? "").trim().toLowerCase();
}

async function buildLaunchSyncTarget(slot, model, params) {
  const status = await getSlotStatus(slot);
  const contextLength = await resolveLaunchContextLength(slot, params, status);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    throw new Error(`Invalid launch context length: ${params?.ctxSize}`);
  }
  const liveRuntimeModelId = await fetchRuntimeModelId(slot, status, model);
  const modelId = chooseLaunchSyncModelId(liveRuntimeModelId, model, status?.model);
  if (!modelId) {
    throw new Error("Unable to determine the live runtime model name for launch sync.");
  }

  return enrichSyncTargetWithVision({
    slotId: slot.id,
    modelId,
    contextLength,
    reasoningEffort: syncTargetReasoningEffort(
      [params?.launcher, status?.model?.launcher, status?.model?.runtime],
      params?.reasoningEffort ?? status?.params?.reasoningEffort),
    apiKey: getRuntimeApiKey(status?.model?.runtime),
    runtimeBaseUrl: await resolveLiveSlotRuntimeBaseUrl(slot, status),
  }, [slot.id]);
}

async function resolveLaunchContextLength(slot, params, status = null) {
  const liveValue = await resolveLiveRuntimeContextLength(slot, status);
  return chooseLaunchContextLength(params?.ctxSize, liveValue);
}

async function buildSlotSyncTarget(slot, status) {
  const contextLength = await resolveSlotContextLength(slot, status);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    throw new Error(`Unable to determine the live context length for ${slot.label}.`);
  }

  const modelId = getPreferredRuntimeModelId(status?.model) || (await fetchRuntimeModelId(slot, status, status?.model));
  if (!modelId) {
    throw new Error(`Unable to determine the live runtime model name for ${slot.label}.`);
  }

  return enrichSyncTargetWithVision({
    slotId: slot.id,
    modelId,
    contextLength,
    reasoningEffort: syncTargetReasoningEffort(
      [status?.model?.launcher, status?.model?.runtime],
      status?.params?.reasoningEffort),
    apiKey: getRuntimeApiKey(status?.model?.runtime),
    runtimeBaseUrl: await resolveLiveSlotRuntimeBaseUrl(slot, status),
  }, [slot.id]);
}

async function enrichSyncTargetWithVision(target, preferredSlotIds = []) {
  const visionTarget = await resolveVisionSyncTarget(preferredSlotIds);
  return {
    ...target,
    // resolveVisionSyncTarget checks this slot first, so it comes back as its own
    // vision target only when its model has an mmproj -- i.e. this is "does the
    // launched model itself accept images", as opposed to the vision* fields
    // below, which point at whichever slot can serve vision for it.
    supportsVision: Boolean(visionTarget?.slotId && visionTarget.slotId === target.slotId),
    // False when no slot serves vision at all -- the vision* fields below then
    // fall back to the main target, and consumers must not treat that as vision.
    hasVisionTarget: Boolean(visionTarget?.slotId),
    visionModelId: visionTarget?.modelId || target.modelId,
    visionApiKey: visionTarget?.apiKey || target.apiKey,
    visionRuntimeBaseUrl: visionTarget?.runtimeBaseUrl || target.runtimeBaseUrl,
    visionSlotId: visionTarget?.slotId || target.slotId,
  };
}

async function resolveVisionSyncTarget(preferredSlotIds = []) {
  const statuses = await getSlotStatuses();
  const dashboardConfig = await readDashboardConfig();
  const orderedSlotIds = [
    ...preferredSlotIds,
    dashboardConfig?.applicationTargets?.hermes || "",
    ...SLOT_DEFINITIONS.map((slot) => slot.id),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);

  const statusBySlotId = new Map(statuses.map((status) => [status.slotId, status]));
  for (const slotId of orderedSlotIds) {
    const slot = getSlotDefinition(slotId);
    const status = statusBySlotId.get(slotId);
    if (!slot || !status?.running || !(await modelSupportsVision(status.model))) {
      continue;
    }

    const modelId = getPreferredRuntimeModelId(status.model) || (await fetchRuntimeModelId(slot, status, status?.model));
    if (!modelId) {
      continue;
    }

    return {
      slotId,
      modelId,
      apiKey: getRuntimeApiKey(status?.model?.runtime),
      runtimeBaseUrl: await resolveLiveSlotRuntimeBaseUrl(slot, status),
    };
  }

  return null;
}

async function modelSupportsVision(model) {
  if (!model) {
    return false;
  }

  if (model.vision === true) {
    return true;
  }

  if (String(model.runtime || "").trim() !== "gguf") {
    return false;
  }

  const modelPath = String(model.path || "").trim();
  if (!modelPath) {
    return false;
  }

  const root = path.extname(modelPath).toLowerCase() === ".gguf" ? path.dirname(modelPath) : modelPath;
  try {
    const entries = await fs.readdir(root);
    return entries.some((entry) => isVisionProjectorFile(entry));
  } catch (_error) {
    return false;
  }
}

function isVisionProjectorFile(value) {
  const name = path.basename(String(value || "").trim());
  if (!/\.gguf$/i.test(name)) {
    return false;
  }
  // "mmproj" is projector-specific wherever it appears in the name.
  if (/mmproj/i.test(name)) {
    return true;
  }
  // "<model>-vision-f16.gguf" and friends. Anchored on the float type on
  // purpose: projectors ship unquantized, so a real model would not be named
  // this way, whereas a bare /vision/ match would swallow vision-LLM weights.
  if (/(^|[-_.])vision[-_.](f16|f32|bf16|fp16|fp32)\.gguf$/i.test(name)) {
    return true;
  }
  return /(^|[-_.])(clip|projector)[-_.](f16|f32|bf16|fp16|fp32)\.gguf$/i.test(name);
}

async function resolveSlotContextLength(slot, status) {
  const liveValue = await resolveLiveRuntimeContextLength(slot, status);
  const launcher = String(status?.model?.launcher || "").trim();
  const runtime = launcher === "beellama"
    ? "beellama"
    : launcher === "gguf-tq3"
    ? "gguf-tq3"
    : status?.model?.runtime === "dflash"
    ? "dflash"
    : status?.model?.runtime === "mtplx"
      ? "mtplx"
      : status?.model?.runtime === "turboquant"
        ? "turboquant"
    : status?.model?.runtime === "mlx"
      ? "mlx"
      : "gguf";
  const defaults = await readDefaultsFromScript(
    runtime === "dflash"
      ? DFLASH_LAUNCHER
      : runtime === "beellama"
        ? BEELLAMA_LAUNCHER
      : runtime === "gguf-tq3"
        ? GGUF_TQ3_LAUNCHER
      : runtime === "mtplx"
        ? MTPLX_LAUNCHER
        : runtime === "turboquant"
          ? TURBO_QUANT_LAUNCHER
          : runtime === "mlx"
            ? MLX_LAUNCHER
            : GGUF_LAUNCHER,
    slot,
  );
  return chooseSlotContextLength(
    status?.params?.ctxSize,
    liveValue,
    defaults?.contextSize || defaults?.ctxSize,
  );
}

async function resolveLiveRuntimeContextLength(slot, status = null) {
  const runtimeBaseUrl = await resolveLiveSlotRuntimeBaseUrl(slot, status);
  const props = await readJsonFromEndpoint(
    `${runtimeServerBaseUrl(runtimeBaseUrl || `http://${API_PUBLIC_HOST}:${slot.publicPort}`)}/props`,
    {
      timeoutMs: 1500,
      maxBytes: 1024 * 1024,
      apiKey: getRuntimeApiKey(status?.model?.runtime),
    }
  );
  const nCtx = Number(
    props?.default_generation_settings?.n_ctx
    || props?.default_generation_settings?.params?.n_ctx
    || 0
  );
  return Number.isInteger(nCtx) && nCtx > 0 ? nCtx : 0;
}

async function resolveLiveSlotRuntimeBaseUrl(slot, status = null) {
  const configuredBaseUrl = await readSlotRuntimeBaseUrl(slot.id);
  const livePort = Number(status?.network?.publicPort || 0);
  if (!Number.isInteger(livePort) || livePort <= 0) {
    return configuredBaseUrl;
  }

  const fallback = `http://${API_PUBLIC_HOST}:${livePort}/v1`;
  const source = String(configuredBaseUrl || fallback).trim();
  try {
    const url = new URL(source);
    url.port = String(livePort);
    url.pathname = "/v1";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch (_error) {
    return fallback;
  }
}

async function syncHermesAfterLaunch(target) {
  const payload = {
    provider: "custom",
    api_key: String(target?.apiKey || "api"),
    model: target.modelId,
    vision_api_key: String(target?.visionApiKey || target?.apiKey || "api"),
    vision_model: target.visionModelId || target.modelId,
    context_length: target.contextLength,
    base_url: HERMES_SYNC_BASE_URL || target.runtimeBaseUrl,
    vision_base_url: HERMES_SYNC_BASE_URL || target.visionRuntimeBaseUrl || target.runtimeBaseUrl,
  };
  if (!isRemoteSyncEnabled(process.env.HERMES_SYNC_ENABLED, HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!hasRemoteShellAuth(HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return { ok: false, error: buildRemoteShellAuthError("Hermes sync", "HERMES_SYNC_PASSWORD", "HERMES_SYNC_SSH_KEY", HERMES_SYNC_SSH_KEY) };
  }

  try {
    const output = await runRemoteShell(
      HERMES_SYNC_HOST,
      HERMES_SYNC_USER,
      {
        password: HERMES_SYNC_PASSWORD,
        sshKeyPath: HERMES_SYNC_SSH_KEY,
      },
        buildHermesSyncRemoteScript(payload)
    );
    return parseHermesSyncOutput(output);
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || "Hermes sync failed.",
    };
  }
}

async function updateContextLengthCache(cachePath, target) {
  const modelId = String(target?.modelId || "").trim();
  const baseUrl = String(target?.runtimeBaseUrl || "").trim();
  const contextLength = Number(target?.contextLength || 0);
  if (!modelId || !baseUrl || !Number.isInteger(contextLength) || contextLength <= 0) {
    return false;
  }

  let cache = {};
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    cache = yaml.load(raw) || {};
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const contextLengths = (cache.context_lengths && typeof cache.context_lengths === "object")
    ? cache.context_lengths
    : {};
  const key = `${modelId}@${baseUrl}`;
  if (Number(contextLengths[key]) === contextLength) {
    return false;
  }
  contextLengths[key] = contextLength;
  cache.context_lengths = contextLengths;

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, yaml.dump(cache, { noRefs: true, indent: 2 }), "utf8");
  return true;
}

async function removeContextLengthCacheEntry(cachePath, target) {
  const modelId = String(target?.modelId || "").trim();
  const baseUrl = String(target?.runtimeBaseUrl || "").trim();
  if (!modelId || !baseUrl) {
    return false;
  }

  let cache = {};
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    cache = yaml.load(raw) || {};
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const contextLengths = (cache.context_lengths && typeof cache.context_lengths === "object")
    ? { ...cache.context_lengths }
    : {};
  const key = `${modelId}@${baseUrl}`;
  if (!(key in contextLengths)) {
    return false;
  }

  delete contextLengths[key];
  cache.context_lengths = contextLengths;

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, yaml.dump(cache, { noRefs: true, indent: 2 }), "utf8");
  return true;
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function readYamlObjectWithFallback(primaryPath, fallbackPath = "") {
  const candidates = [primaryPath, fallbackPath].map((value) => String(value || "").trim()).filter(Boolean);
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      return ensureObject(yaml.load(raw));
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return {};
}

async function copyFileIfMissing(targetPath, sourcePath = "") {
  const destination = String(targetPath || "").trim();
  const source = String(sourcePath || "").trim();
  if (!destination || !source || destination === source || fsSync.existsSync(destination) || !fsSync.existsSync(source)) {
    return false;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  return true;
}

// Hermes Agent refuses to start when model.context_length is below this, so a
// sync that writes a smaller value produces a profile that cannot boot at all.
// Fail the sync loudly here instead: the symptom otherwise surfaces much later
// as a consumer (podG) treating the startup error text as model output.
// Not clamped on purpose — if the server genuinely serves a smaller window,
// claiming 64K would just move the failure to request time.
const HERMES_AGENT_MIN_CONTEXT_LENGTH = 64000;

// Does this target actually point at something that can read images?
//
// enrichSyncTargetWithVision sets hasVisionTarget and, when nothing serves vision,
// falls visionModelId back to the launched model -- so "flag set" is the primary
// signal. The second clause is a safety net for hand-built targets that carry a
// distinct vision model but omit the flag: a visionModelId that differs from the
// main model can only have come from a real vision slot, and in the no-vision case
// the two are equal by construction, so this cannot resurrect the original bug.
function targetHasUsableVision(target) {
  if (target?.hasVisionTarget) {
    return true;
  }
  const visionModelId = String(target?.visionModelId || "").trim();
  return Boolean(visionModelId) && visionModelId !== String(target?.modelId || "").trim();
}

function applyLocalHermesModelTarget(configInput, target) {
  const contextLength = Number(target?.contextLength);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    throw new Error("Local Hermes sync requires a positive context length.");
  }
  if (contextLength < HERMES_AGENT_MIN_CONTEXT_LENGTH) {
    throw new Error(
      `Local Hermes sync refused: context length ${contextLength} is below the ${HERMES_AGENT_MIN_CONTEXT_LENGTH} minimum required by Hermes Agent. `
      + `Relaunch the slot with a larger ctxSize (or pick a model with a bigger window) before binding a Hermes profile to it.`
    );
  }

  const config = ensureObject(configInput);
  const modelCfg = ensureObject(config.model);
  const prevModelBaseUrl = String(modelCfg.base_url || "");
  const prevModelId = String(modelCfg.model || modelCfg.default || "");
  const prevProvider = String(modelCfg.provider || "");
  const prevApiKey = String(modelCfg.api_key || "");
  const prevContextLength = Number(modelCfg.context_length);
  modelCfg.base_url = target.runtimeBaseUrl;
  modelCfg.model = target.modelId;
  modelCfg.default = target.modelId;
  modelCfg.provider = "custom";
  modelCfg.api_key = String(target?.apiKey || "api");
  modelCfg.context_length = contextLength;
  config.model = modelCfg;

  const auxiliaryCfg = ensureObject(config.auxiliary);
  const visionCfg = ensureObject(auxiliaryCfg.vision);
  const prevVisionProvider = String(visionCfg.provider || "");
  const prevVisionApiKey = String(visionCfg.api_key || "");
  const prevVisionModel = String(visionCfg.model || "");
  const prevVisionBaseUrl = String(visionCfg.base_url || "");
  // Only claim vision when a slot actually serves it. enrichSyncTargetWithVision
  // falls visionModelId back to the launched model when nothing does, and writing
  // that here told Hermes a text-only model could read images -- requests then
  // "succeed" and return nonsense instead of failing honestly. When there is no
  // vision target the previous block is left as-is rather than cleared: a stale
  // pointer is recoverable, silently mislabelling the text model is not.
  if (targetHasUsableVision(target)) {
    visionCfg.provider = String(visionCfg.provider || "custom");
    visionCfg.api_key = String(target?.visionApiKey || target?.apiKey || visionCfg.api_key || "api");
    visionCfg.model = String(target?.visionModelId || target.modelId);
    visionCfg.base_url = String(target?.visionRuntimeBaseUrl || target.runtimeBaseUrl);
  }
  auxiliaryCfg.vision = visionCfg;

  const compressionCfg = ensureObject(auxiliaryCfg.compression);
  const prevCompressionContextLength = Number(compressionCfg.context_length);
  const prevCompressionProvider = String(compressionCfg.provider || "");
  const prevCompressionApiKey = String(compressionCfg.api_key || "");
  const prevCompressionModel = String(compressionCfg.model || "");
  const prevCompressionBaseUrl = String(compressionCfg.base_url || "");
  compressionCfg.context_length = contextLength;
  compressionCfg.provider = "custom";
  compressionCfg.api_key = String(target?.apiKey || compressionCfg.api_key || "api");
  compressionCfg.model = String(target.modelId);
  compressionCfg.base_url = String(target.runtimeBaseUrl);
  auxiliaryCfg.compression = compressionCfg;

  const sessionSearchCfg = ensureObject(auxiliaryCfg.session_search);
  const prevSessionSearchProvider = String(sessionSearchCfg.provider || "");
  const prevSessionSearchApiKey = String(sessionSearchCfg.api_key || "");
  const prevSessionSearchModel = String(sessionSearchCfg.model || "");
  const prevSessionSearchBaseUrl = String(sessionSearchCfg.base_url || "");
  sessionSearchCfg.provider = "custom";
  sessionSearchCfg.api_key = String(target?.apiKey || sessionSearchCfg.api_key || "api");
  sessionSearchCfg.model = String(target.modelId);
  sessionSearchCfg.base_url = String(target.runtimeBaseUrl);
  auxiliaryCfg.session_search = sessionSearchCfg;
  config.auxiliary = auxiliaryCfg;

  const configChanged = (
    prevModelBaseUrl !== String(target.runtimeBaseUrl || "")
    || prevModelId !== String(target.modelId || "")
    || prevProvider !== "custom"
    || prevApiKey !== String(modelCfg.api_key || "")
    || prevContextLength !== contextLength
    || prevVisionProvider !== String(visionCfg.provider || "")
    || prevVisionApiKey !== String(visionCfg.api_key || "")
    || prevVisionModel !== String(visionCfg.model || "")
    || prevVisionBaseUrl !== String(visionCfg.base_url || "")
    || prevCompressionContextLength !== contextLength
    || prevCompressionProvider !== String(compressionCfg.provider || "")
    || prevCompressionApiKey !== String(compressionCfg.api_key || "")
    || prevCompressionModel !== String(compressionCfg.model || "")
    || prevCompressionBaseUrl !== String(compressionCfg.base_url || "")
    || prevSessionSearchProvider !== String(sessionSearchCfg.provider || "")
    || prevSessionSearchApiKey !== String(sessionSearchCfg.api_key || "")
    || prevSessionSearchModel !== String(sessionSearchCfg.model || "")
    || prevSessionSearchBaseUrl !== String(sessionSearchCfg.base_url || "")
  );

  return {
    config,
    contextLength,
    configChanged,
    visionCfg,
  };
}

function applyPodgHermesProfileDefaults(configInput) {
  const config = ensureObject(configInput);

  const approvalsCfg = ensureObject(config.approvals);
  approvalsCfg.mode = "off";
  approvalsCfg.destructive_slash_confirm = false;
  config.approvals = approvalsCfg;

  const agentCfg = ensureObject(config.agent);
  const disabledToolsets = new Set(Array.isArray(agentCfg.disabled_toolsets) ? agentCfg.disabled_toolsets : []);
  disabledToolsets.add("session_search");
  agentCfg.disabled_toolsets = [...disabledToolsets];
  agentCfg.max_turns = Math.max(50000, Number(agentCfg.max_turns) || 0);
  agentCfg.reasoning_effort = "xhigh";
  config.agent = agentCfg;

  config.platform_toolsets = {
    ...ensureObject(config.platform_toolsets),
    cli: ["web", "file", "no_mcp"],
  };

  const guardrailsCfg = ensureObject(config.tool_loop_guardrails);
  guardrailsCfg.hard_stop_enabled = true;
  guardrailsCfg.warnings_enabled = true;
  config.tool_loop_guardrails = guardrailsCfg;

  const platformsCfg = ensureObject(config.platforms);
  for (const [platformKey, platformValue] of Object.entries(platformsCfg)) {
    if (platformValue && typeof platformValue === "object" && !Array.isArray(platformValue)) {
      platformsCfg[platformKey] = {
        ...platformValue,
        enabled: false,
      };
    }
  }
  config.platforms = platformsCfg;

  return config;
}

async function syncLocalHermesProfileAfterLaunch(target, options = {}) {
  const enabled = options.enabled !== false;
  if (!enabled) {
    return { ok: true, skipped: true, reason: "disabled" };
  }

  const label = String(options.label || "Local Hermes profile").trim() || "Local Hermes profile";
  const configPath = String(options.configPath || "").trim();
  const cachePath = String(options.cachePath || "").trim();
  const envPath = String(options.envPath || "").trim();
  const seedConfigPath = String(options.seedConfigPath || "").trim();
  const seedCachePath = String(options.seedCachePath || "").trim();
  const seedEnvPath = String(options.seedEnvPath || "").trim();
  const customizeConfig = typeof options.customizeConfig === "function" ? options.customizeConfig : (config) => config;
  const restartFn = typeof options.restart === "function" ? options.restart : null;
  const unchangedReason = String(options.unchangedReason || "unchanged").trim() || "unchanged";

  if (!configPath || !cachePath) {
    return { ok: false, error: `${label} is not configured.` };
  }

  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const seededEnv = envPath ? await copyFileIfMissing(envPath, seedEnvPath) : false;
    const seededCache = seedCachePath ? await copyFileIfMissing(cachePath, seedCachePath) : false;
    const baseConfig = await readYamlObjectWithFallback(configPath, seedConfigPath);
    const originalConfigJson = JSON.stringify(baseConfig);
    const preparedConfig = customizeConfig(baseConfig, target) || baseConfig;
    const syncResult = applyLocalHermesModelTarget(preparedConfig, target);
    const configChanged = !fsSync.existsSync(configPath) || JSON.stringify(syncResult.config) !== originalConfigJson;

    if (configChanged) {
      await fs.writeFile(configPath, yaml.dump(syncResult.config, { noRefs: true, indent: 2 }), "utf8");
    }

    const cacheUpdated = await updateContextLengthCache(cachePath, target);
    const restartNeeded = configChanged || cacheUpdated;
    const restart = restartFn
      ? (restartNeeded ? await restartFn(target) : { ok: true, skipped: true, reason: unchangedReason })
      : { ok: true, skipped: true, reason: restartNeeded ? "not_required" : unchangedReason };

    return {
      ok: restart.ok !== false,
      model: target.modelId,
      context_length: syncResult.contextLength,
      base_url: target.runtimeBaseUrl,
      vision_model: syncResult.visionCfg.model,
      vision_base_url: syncResult.visionCfg.base_url,
      config_path: configPath,
      cache_path: cachePath,
      ...(envPath ? { env_path: envPath } : {}),
      config_changed: configChanged,
      cache_updated: cacheUpdated,
      seeded_env: seededEnv,
      seeded_cache: seededCache,
      restart,
      ...(restart.ok === false ? { error: restart.error } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || `${label} sync failed.`,
    };
  }
}

async function syncHermesM4AfterLaunch(target) {
  return syncLocalHermesProfileAfterLaunch(target, {
    enabled: HERMES_M4_ENABLED,
    label: "Hermes M4",
    configPath: HERMES_M4_CONFIG_PATH,
    cachePath: HERMES_M4_CACHE_PATH,
    envPath: path.join(path.dirname(HERMES_M4_CONFIG_PATH), ".env"),
    seedConfigPath: DEFAULT_HERMES_M4_CONFIG_PATH,
    seedCachePath: HERMES_M4_CACHE_PATH,
    seedEnvPath: path.join(HERMES_M4_HOME, ".env"),
    restart: restartLocalHermesGateway,
  });
}

function applyHermesCompactionConfig(configInput, target) {
  const config = (configInput && typeof configInput === "object") ? configInput : {};
  const runtimeBaseUrl = String(target?.runtimeBaseUrl || "").trim();
  const modelId = String(target?.modelId || "").trim();

  const compressionCfg = (config.compression && typeof config.compression === "object") ? config.compression : {};
  compressionCfg.enabled = true;
  if (!Number.isFinite(Number(compressionCfg.threshold))) {
    compressionCfg.threshold = 0.50;
  }
  compressionCfg.target_ratio = 0.75;
  config.compression = compressionCfg;

  const auxiliaryCfg = (config.auxiliary && typeof config.auxiliary === "object") ? config.auxiliary : {};
  const compCfg = (auxiliaryCfg.compression && typeof auxiliaryCfg.compression === "object") ? auxiliaryCfg.compression : {};
  compCfg.provider = "auto";
  compCfg.api_key = String(target?.apiKey || compCfg.api_key || "api");
  compCfg.model = modelId;
  compCfg.base_url = runtimeBaseUrl;
  delete compCfg.context_length;
  auxiliaryCfg.compression = compCfg;
  config.auxiliary = auxiliaryCfg;

  return config;
}

function resetHermesCompactionConfig(configInput, target) {
  const config = (configInput && typeof configInput === "object") ? configInput : {};
  const runtimeBaseUrl = String(target?.runtimeBaseUrl || "").trim();
  const modelId = String(target?.modelId || "").trim();
  const auxiliaryCfg = (config.auxiliary && typeof config.auxiliary === "object") ? config.auxiliary : {};
  const compCfg = (auxiliaryCfg.compression && typeof auxiliaryCfg.compression === "object") ? auxiliaryCfg.compression : {};
  const currentProvider = String(compCfg.provider || "").trim();
  const currentApiKey = String(compCfg.api_key || "").trim();
  const currentModel = String(compCfg.model || "").trim();
  const currentBaseUrl = String(compCfg.base_url || "").trim();
  const hasContextLength = Object.prototype.hasOwnProperty.call(compCfg, "context_length");

  let matchesTarget = false;
  if (runtimeBaseUrl && currentBaseUrl) {
    matchesTarget = currentBaseUrl === runtimeBaseUrl;
  } else if (modelId && currentModel) {
    matchesTarget = currentModel === modelId;
  } else if (!runtimeBaseUrl && !modelId) {
    matchesTarget = Boolean(currentModel || currentBaseUrl);
  }

  if (!matchesTarget) {
    return {
      config,
      changed: false,
      resetTarget: null,
    };
  }

  compCfg.provider = "auto";
  compCfg.api_key = "";
  compCfg.model = "";
  compCfg.base_url = "";
  delete compCfg.context_length;
  auxiliaryCfg.compression = compCfg;
  config.auxiliary = auxiliaryCfg;

  return {
    config,
    changed: currentProvider !== "auto"
      || currentApiKey !== ""
      || currentModel !== ""
      || currentBaseUrl !== ""
      || hasContextLength,
    resetTarget: {
      modelId: currentModel,
      runtimeBaseUrl: currentBaseUrl,
    },
  };
}

async function syncHermesM4CompactionAfterLaunch(target) {
  if (!HERMES_M4_ENABLED) {
    return { ok: true, skipped: true, reason: "disabled" };
  }

  try {
    const contextLength = Number(target?.contextLength);
    if (!Number.isInteger(contextLength) || contextLength <= 0) {
      return { ok: false, error: "Hermes M4 compaction sync requires a positive context length." };
    }
    const raw = await fs.readFile(HERMES_M4_CONFIG_PATH, "utf8");
    const config = applyHermesCompactionConfig(yaml.load(raw) || {}, target);
    await fs.writeFile(HERMES_M4_CONFIG_PATH, yaml.dump(config, { noRefs: true, indent: 2 }), "utf8");
    const cacheUpdated = await updateContextLengthCache(HERMES_M4_CACHE_PATH, target);
    return {
      ok: true,
      model: target.modelId,
      context_length: contextLength,
      base_url: target.runtimeBaseUrl,
      config_path: HERMES_M4_CONFIG_PATH,
      cache_path: HERMES_M4_CACHE_PATH,
      cache_updated: cacheUpdated,
    };
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || "Hermes M4 compaction sync failed.",
    };
  }
}

async function syncHermesM4CompactionAfterStop(target) {
  if (!HERMES_M4_ENABLED) {
    return { ok: true, skipped: true, reason: "disabled" };
  }

  try {
    const raw = await fs.readFile(HERMES_M4_CONFIG_PATH, "utf8");
    const { config, changed, resetTarget } = resetHermesCompactionConfig(yaml.load(raw) || {}, target);
    if (!changed) {
      return {
        ok: true,
        skipped: true,
        reason: "Hermes M4 compaction config did not reference the stopped target.",
        config_path: HERMES_M4_CONFIG_PATH,
        cache_path: HERMES_M4_CACHE_PATH,
        cache_updated: false,
      };
    }

    await fs.writeFile(HERMES_M4_CONFIG_PATH, yaml.dump(config, { noRefs: true, indent: 2 }), "utf8");
    const cacheUpdated = await removeContextLengthCacheEntry(HERMES_M4_CACHE_PATH, resetTarget);
    return {
      ok: true,
      changed: true,
      model: resetTarget?.modelId || "",
      base_url: resetTarget?.runtimeBaseUrl || "",
      config_path: HERMES_M4_CONFIG_PATH,
      cache_path: HERMES_M4_CACHE_PATH,
      cache_updated: cacheUpdated,
    };
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || "Hermes M4 compaction reset failed.",
    };
  }
}

async function syncHermesCompactionAfterLaunch(target) {
  const [remoteResult, localResult] = await Promise.all([
    syncHermesCompactionRemoteAfterLaunch(target),
    syncHermesM4CompactionAfterLaunch(target),
  ]);

  if (remoteResult.ok === false) {
    return {
      ok: false,
      error: remoteResult.error || "Remote Hermes compaction sync failed.",
      remote: remoteResult,
      local: localResult,
    };
  }
  if (localResult.ok === false) {
    return {
      ok: false,
      error: localResult.error || "Local Hermes compaction sync failed.",
      remote: remoteResult,
      local: localResult,
    };
  }

  return {
    ok: true,
    model: target.modelId,
    context_length: Number(target.contextLength),
    base_url: target.runtimeBaseUrl,
    remote: remoteResult,
    local: localResult,
  };
}

async function syncHermesCompactionAfterStop(target) {
  const [remoteResult, localResult] = await Promise.all([
    syncHermesCompactionRemoteAfterStop(target),
    syncHermesM4CompactionAfterStop(target),
  ]);

  if (remoteResult.ok === false) {
    return {
      ok: false,
      error: remoteResult.error || "Remote Hermes compaction reset failed.",
      remote: remoteResult,
      local: localResult,
    };
  }
  if (localResult.ok === false) {
    return {
      ok: false,
      error: localResult.error || "Local Hermes compaction reset failed.",
      remote: remoteResult,
      local: localResult,
    };
  }

  return {
    ok: true,
    changed: Boolean(remoteResult.changed || localResult.changed),
    remote: remoteResult,
    local: localResult,
  };
}

async function syncHermesCompactionRemoteAfterLaunch(target) {
  if (!isRemoteSyncEnabled(process.env.HERMES_SYNC_ENABLED, HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!hasRemoteShellAuth(HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return { ok: false, error: buildRemoteShellAuthError("Hermes sync", "HERMES_SYNC_PASSWORD", "HERMES_SYNC_SSH_KEY", HERMES_SYNC_SSH_KEY) };
  }

  const payload = {
    api_key: String(target?.apiKey || "api"),
    model: target.modelId,
    context_length: target.contextLength,
    base_url: HERMES_SYNC_BASE_URL || target.runtimeBaseUrl,
  };

  try {
    const output = await runRemoteShell(
      HERMES_SYNC_HOST,
      HERMES_SYNC_USER,
      {
        password: HERMES_SYNC_PASSWORD,
        sshKeyPath: HERMES_SYNC_SSH_KEY,
      },
      buildHermesCompactionRemoteScript(payload)
    );
    return parseHermesSyncOutput(output);
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || "Hermes compaction sync failed.",
    };
  }
}

async function syncHermesCompactionRemoteAfterStop(target) {
  if (!isRemoteSyncEnabled(process.env.HERMES_SYNC_ENABLED, HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!hasRemoteShellAuth(HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return { ok: false, error: buildRemoteShellAuthError("Hermes sync", "HERMES_SYNC_PASSWORD", "HERMES_SYNC_SSH_KEY", HERMES_SYNC_SSH_KEY) };
  }

  const payload = {
    model: target.modelId || "",
    base_url: HERMES_SYNC_BASE_URL || target.runtimeBaseUrl || "",
  };

  try {
    const output = await runRemoteShell(
      HERMES_SYNC_HOST,
      HERMES_SYNC_USER,
      {
        password: HERMES_SYNC_PASSWORD,
        sshKeyPath: HERMES_SYNC_SSH_KEY,
      },
      buildHermesCompactionResetRemoteScript(payload)
    );
    return parseHermesSyncOutput(output);
  } catch (error) {
    // A remote Hermes that cannot be reached is not routing anything at this
    // slot, so it must not block a local launch. Report it as skipped with the
    // reason; every other failure stays a failure.
    if (error?.remoteUnreachable) {
      return {
        ok: true,
        skipped: true,
        reason: `remote Hermes on ${HERMES_SYNC_HOST} is unreachable: ${error.message}`,
      };
    }
    return {
      ok: false,
      error: formatExecError(error) || "Hermes compaction reset failed.",
    };
  }
}

async function syncHermesM4VoiceAfterLaunch(target) {
  if (!HERMES_M4_ENABLED) {
    return { ok: true, skipped: true, reason: "disabled" };
  }

  try {
    const raw = await fs.readFile(HERMES_M4_CONFIG_PATH, "utf8");
    const config = yaml.load(raw) || {};
    const sectionKey = target?.type === "stt" ? "stt" : "tts";
    const section = (config[sectionKey] && typeof config[sectionKey] === "object") ? config[sectionKey] : {};
    const runtimeBaseUrl = String(target.runtimeBaseUrl || "").trim();

    if (sectionKey === "stt") {
      // STT: use 'openai' provider since the llm3 STT proxy exposes
      // /audio/transcriptions (OpenAI-compatible endpoint).
      section["enabled"] = true;
      section["provider"] = "openai";
      section["model"] = target.modelId;
      if (!section["openai"]) section["openai"] = {};
      section["openai"]["model"] = target.modelId;
      // hermes-agent requires stt.openai.api_key to use a custom base_url;
      // a dummy value triggers the local path instead of cloud OpenAI.
      section["openai"]["api_key"] = "local-stt";
      if (runtimeBaseUrl) {
        section["base_url"] = runtimeBaseUrl;
        section["openai"]["base_url"] = runtimeBaseUrl;
      }
    } else {
      // TTS: expose the llm3 /tts endpoint through Hermes' command-provider
      // interface so Telegram replies use the selected local model.
      const tuning = normalizeVoiceTtsTuningParams(target.tuning || target, target.modelId);
      section["enabled"] = true;
      section["provider"] = "llm3_voice";
      section["model"] = target.modelId;
      section["voice"] = String(target.voiceName || "");
      if (!section["llm3"]) section["llm3"] = {};
      section["llm3"]["model"] = target.modelId;
      section["llm3"]["voice"] = String(target.voiceName || "");
      if (voiceModelSupportsTuning(target.modelId)) {
        section["llm3"]["exaggeration"] = tuning.exaggeration;
        section["llm3"]["cfg_weight"] = tuning.cfgWeight;
        section["llm3"]["temperature"] = tuning.temperature;
        section["llm3"]["repetition_penalty"] = tuning.repetitionPenalty;
        section["llm3"]["min_p"] = tuning.minP;
        section["llm3"]["top_p"] = tuning.topP;
      }
      if (runtimeBaseUrl) {
        section["base_url"] = runtimeBaseUrl;
        section["llm3"]["base_url"] = runtimeBaseUrl;
      }
      if (!section["providers"] || typeof section["providers"] !== "object") section["providers"] = {};
      section["providers"]["llm3_voice"] = {
        type: "command",
        command: [
          `python3 ${shellQuote(path.join(__dirname, "voice-tts-client.py"))}`,
          `--base-url ${shellQuote(runtimeBaseUrl)}`,
          "--input {input_path}",
          "--output {output_path}",
          `--voice ${shellQuote(String(target.voiceName || ""))}`,
          `--model ${shellQuote(target.modelId)}`,
          ...(voiceModelSupportsTuning(target.modelId) ? [
            `--exaggeration ${shellQuote(String(tuning.exaggeration))}`,
            `--cfg-weight ${shellQuote(String(tuning.cfgWeight))}`,
            `--temperature ${shellQuote(String(tuning.temperature))}`,
            `--repetition-penalty ${shellQuote(String(tuning.repetitionPenalty))}`,
            `--min-p ${shellQuote(String(tuning.minP))}`,
            `--top-p ${shellQuote(String(tuning.topP))}`,
          ] : []),
        ].join(" "),
        output_format: "mp3",
        voice_compatible: true,
        timeout: 240,
        model: target.modelId,
        voice: String(target.voiceName || ""),
        ...(voiceModelSupportsTuning(target.modelId) ? {
          exaggeration: tuning.exaggeration,
          cfg_weight: tuning.cfgWeight,
          temperature: tuning.temperature,
          repetition_penalty: tuning.repetitionPenalty,
          min_p: tuning.minP,
          top_p: tuning.topP,
        } : {}),
      };
    }

    config[sectionKey] = section;

    await fs.writeFile(HERMES_M4_CONFIG_PATH, yaml.dump(config, { noRefs: true, indent: 2 }), "utf8");
    const restart = await restartLocalHermesGateway();
    return {
      ok: restart.ok !== false,
      type: sectionKey,
      model: target.modelId,
      voice: sectionKey === "tts" ? String(target.voiceName || "") : "",
      base_url: runtimeBaseUrl,
      config_path: HERMES_M4_CONFIG_PATH,
      restart,
      ...(restart.ok === false ? { error: restart.error } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || "Hermes M4 voice sync failed.",
    };
  }
}

async function syncHermesM4VoiceAfterStop(target) {
  if (!HERMES_M4_ENABLED) {
    return { ok: true, skipped: true, reason: "disabled" };
  }

  try {
    const raw = await fs.readFile(HERMES_M4_CONFIG_PATH, "utf8");
    const config = yaml.load(raw) || {};
    const sectionKey = target?.type === "stt" ? "stt" : "tts";
    const section = config[sectionKey] || {};

    // Disable STT/TTS config
    section["enabled"] = false;

    config[sectionKey] = section;

    await fs.writeFile(HERMES_M4_CONFIG_PATH, yaml.dump(config, { noRefs: true, indent: 2 }), "utf8");
    return {
      ok: true,
      type: sectionKey,
      config_path: HERMES_M4_CONFIG_PATH,
    };
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || "Hermes M4 voice stop sync failed.",
    };
  }
}

async function syncClaudeCodeAfterLaunch(target) {
  if (!CLAUDE_SYNC_ENABLED) {
    return { ok: true, skipped: true, reason: "disabled" };
  }

  try {
    await Promise.all([
      updateClaudeProxyEnv(target),
      updateClaudeSettings(target),
    ]);
    const proxyStatus = await restartClaudeProxy(target);
    return {
      ok: true,
      model: target.modelId,
      context_length: target.contextLength,
      base_url: target.runtimeBaseUrl,
      proxy: proxyStatus,
    };
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || "OpenClaude sync failed.",
    };
  }
}

async function syncLibreChatAfterLaunch(target) {
  if (!isRemoteSyncEnabled(process.env.LIBRECHAT_SYNC_ENABLED, LIBRECHAT_SYNC_PASSWORD, LIBRECHAT_SYNC_SSH_KEY)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!hasRemoteShellAuth(LIBRECHAT_SYNC_PASSWORD, LIBRECHAT_SYNC_SSH_KEY)) {
    return { ok: false, error: buildRemoteShellAuthError("LibreChat sync", "LIBRECHAT_SYNC_PASSWORD", "LIBRECHAT_SYNC_SSH_KEY", LIBRECHAT_SYNC_SSH_KEY) };
  }

  try {
    const output = await runRemoteShell(
      LIBRECHAT_SYNC_HOST,
      LIBRECHAT_SYNC_USER,
      {
        password: LIBRECHAT_SYNC_PASSWORD,
        sshKeyPath: LIBRECHAT_SYNC_SSH_KEY,
      },
      buildLibreChatSyncRemoteScript(target)
    );
    return parseLibreChatSyncOutput(output);
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || "LibreChat sync failed.",
    };
  }
}

async function syncRemoteJsonAppAfterLaunch(target) {
  if (!isRemoteSyncEnabled(process.env.REMOTE_JSON_APP_SYNC_ENABLED, REMOTE_JSON_APP_SYNC_PASSWORD, REMOTE_JSON_APP_SYNC_SSH_KEY)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!hasRemoteShellAuth(REMOTE_JSON_APP_SYNC_PASSWORD, REMOTE_JSON_APP_SYNC_SSH_KEY)) {
    return { ok: false, error: buildRemoteShellAuthError(`${REMOTE_JSON_APP_LABEL} sync`, "REMOTE_JSON_APP_SYNC_PASSWORD", "REMOTE_JSON_APP_SYNC_SSH_KEY", REMOTE_JSON_APP_SYNC_SSH_KEY) };
  }
  if (!REMOTE_JSON_APP_SYNC_CONFIG_PATH) {
    return { ok: false, error: `${REMOTE_JSON_APP_LABEL} sync is not configured: set REMOTE_JSON_APP_SYNC_CONFIG_PATH.` };
  }

  try {
    const output = await runRemoteShell(
      REMOTE_JSON_APP_SYNC_HOST,
      REMOTE_JSON_APP_SYNC_USER,
      {
        password: REMOTE_JSON_APP_SYNC_PASSWORD,
        sshKeyPath: REMOTE_JSON_APP_SYNC_SSH_KEY,
      },
      buildRemoteJsonAppSyncScript(target)
    );
    return parseRemoteJsonAppSyncOutput(output);
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || `${REMOTE_JSON_APP_LABEL} sync failed.`,
    };
  }
}

function buildSqliteAppSyncScript(target) {
  const dbPath = String(SQLITE_APP_SYNC_DB_PATH || "").trim();
  const baseUrl = String(target?.runtimeBaseUrl || "").trim();
  const modelId = String(target?.modelId || "").trim();
  const apiKey = String(SQLITE_APP_SYNC_API_KEY || "api").trim() || "api";
  const pm2App = String(SQLITE_APP_SYNC_PM2_APP || "").trim();

  const sql = [
    "BEGIN IMMEDIATE;",
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    `INSERT INTO settings (key, value) VALUES ('hermes_base_url', ${sqliteQuote(baseUrl)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    `INSERT INTO settings (key, value) VALUES ('llm_model', ${sqliteQuote(modelId)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    `INSERT INTO settings (key, value) VALUES ('hermes_api_key', COALESCE(NULLIF((SELECT value FROM settings WHERE key = 'hermes_api_key' LIMIT 1), ''), ${sqliteQuote(apiKey)})) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    "COMMIT;",
  ].join("\n");
  const payloadBase64 = Buffer.from(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    model: modelId,
    db_path: dbPath,
    pm2_app: pm2App || null,
  }), "utf8").toString("base64");

  return [
    "set -euo pipefail",
    `DB_PATH=${shellQuote(dbPath)}`,
    `SQL=${shellQuote(sql)}`,
    "mkdir -p \"$(dirname \"$DB_PATH\")\"",
    "sqlite3 \"$DB_PATH\" \"$SQL\"",
    `PAYLOAD_BASE64=${shellQuote(payloadBase64)}`,
    "python3 - <<'PY' \"$PAYLOAD_BASE64\"",
    "import base64",
    "import sys",
    "print('__SQLITE_APP_SYNC__' + base64.b64decode(sys.argv[1]).decode('utf-8'))",
    "PY",
    ...(pm2App
      ? [
          "if command -v pm2 >/dev/null 2>&1 && pm2 describe " + shellQuote(pm2App) + " >/dev/null 2>&1; then",
          `  pm2 restart ${shellQuote(pm2App)} >/dev/null`,
          `  printf '__SQLITE_APP_PM2__%s__END__\\n' ${shellQuote(pm2App)}`,
          "else",
          `  printf '__SQLITE_APP_PM2_MISSING__%s__END__\\n' ${shellQuote(pm2App)}`,
          "fi",
        ]
      : []),
  ].join("\n");
}

async function syncSqliteAppAfterLaunch(target) {
  if (!SQLITE_APP_SYNC_ENABLED) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!SQLITE_APP_SYNC_DB_PATH) {
    return { ok: false, error: `${SQLITE_APP_LABEL} sync is not configured: set SQLITE_APP_SYNC_DB_PATH.` };
  }

  try {
    const output = await execFileAsync("bash", ["-c", buildSqliteAppSyncScript(target)], getExecOptions({
      maxBuffer: 256 * 1024,
      cwd: SQLITE_APP_SYNC_ROOT || undefined,
    }));
    return parseSqliteAppSyncOutput([output.stdout, output.stderr].filter(Boolean).join("\n"));
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || `${SQLITE_APP_LABEL} sync failed.`,
    };
  }
}

async function syncPm2LlmWebsiteAfterLaunch(target, options = {}) {
  const enabled = options.enabled !== false;
  if (!enabled) {
    return { ok: true, skipped: true, reason: "disabled" };
  }

  const rootDir = String(options.rootDir || "").trim();
  const pm2App = String(options.pm2App || "").trim();
  const serviceName = String(options.serviceName || pm2App || "application");
  if (!rootDir || !pm2App) {
    return { ok: false, error: `${serviceName} sync is not configured.` };
  }

  try {
    const llmUrl = String(target?.runtimeBaseUrl || "").trim().replace(/\/v1$/, "");
    const output = await execFileAsync("pm2", ["restart", pm2App, "--update-env"], getExecOptions({
      maxBuffer: 256 * 1024,
      cwd: rootDir,
      env: {
        ...process.env,
        LLM_URL: llmUrl,
        LLM_MODEL: String(target?.modelId || ""),
        LLM_API_KEY: "local",
      },
    }));

    return {
      ok: true,
      pm2_app: pm2App,
      llm_url: llmUrl,
      model: target?.modelId,
      stdout: output.stdout,
      stderr: output.stderr || "",
    };
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || `${serviceName} sync failed.`,
    };
  }
}

async function syncVoiceAppAfterLaunch(target) {
  return syncPm2LlmWebsiteAfterLaunch(target, {
    enabled: VOICE_APP_SYNC_ENABLED,
    rootDir: VOICE_APP_ROOT,
    pm2App: VOICE_APP_PM2_APP,
    serviceName: VOICE_APP_LABEL,
  });
}

async function syncPodcastGAfterLaunch(target) {
  return syncLocalHermesProfileAfterLaunch(target, {
    enabled: PODG_HERMES_ENABLED,
    label: "PodG",
    configPath: PODG_HERMES_CONFIG_PATH,
    cachePath: PODG_HERMES_CACHE_PATH,
    envPath: PODG_HERMES_ENV_PATH,
    seedConfigPath: HERMES_M4_CONFIG_PATH,
    seedCachePath: HERMES_M4_CACHE_PATH,
    seedEnvPath: path.join(HERMES_M4_HOME, ".env"),
    customizeConfig: applyPodgHermesProfileDefaults,
  });
}

async function syncPodGAutoGenAfterLaunch(target) {
  return syncLocalHermesProfileAfterLaunch(target, {
    enabled: PODG_AUTO_RANDOM_HERMES_ENABLED,
    label: "PodG-AG",
    configPath: PODG_AUTO_RANDOM_HERMES_CONFIG_PATH,
    cachePath: PODG_AUTO_RANDOM_HERMES_CACHE_PATH,
    envPath: PODG_AUTO_RANDOM_HERMES_ENV_PATH,
    seedConfigPath: HERMES_M4_CONFIG_PATH,
    seedCachePath: HERMES_M4_CACHE_PATH,
    seedEnvPath: path.join(HERMES_M4_HOME, ".env"),
    customizeConfig: applyPodgHermesProfileDefaults,
  });
}

// ===================================================================
// Gaming PC (Windows) config sync
//
// The four PC apps keep their model pointer in a config file on
// the gaming PC. Reads come back over `powershell -EncodedCommand`
// (base64 UTF-16LE, so no quoting survives to break us); writes go up
// with scp because an EncodedCommand carrying a 15KB payload would blow
// past the 32767-char Windows command line limit.
// ===================================================================

async function runGamingPcPowerShell(command) {
  const encoded = Buffer.from(String(command), "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    "ssh",
    [
      ...sshHostKeyArgs(),
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${GAMING_PC_SYNC_TIMEOUT_SECONDS}`,
      "-i", GAMING_PC_SYNC_SSH_KEY,
      `${GAMING_PC_SYNC_USER}@${GAMING_PC_SYNC_HOST}`,
      `powershell -NoProfile -EncodedCommand ${encoded}`,
    ],
    getExecOptions({ maxBuffer: ACTION_BUFFER }),
  );
  // stderr carries PowerShell's CLIXML progress noise; only stdout is payload.
  return String(stdout || "");
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function readGamingPcFile(remotePath) {
  const output = await runGamingPcPowerShell(
    `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${powerShellQuote(remotePath)}))`
  );
  const encoded = output.replace(/[^A-Za-z0-9+/=]/g, "");
  if (!encoded) {
    throw new Error(`Unable to read ${remotePath} on the Gaming PC.`);
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

async function writeGamingPcFile(remotePath, contents) {
  // Keep one rollback copy next to the file before overwriting it.
  await runGamingPcPowerShell(
    `$p = ${powerShellQuote(remotePath)}; if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination ($p + '.llm3.bak') -Force }`
  );

  // mkdtemp, not a pid+timestamp name: the four PC syncs run concurrently from
  // one launch and collided inside the same millisecond, so all four scp'd the
  // same interleaved staging file and every config ended up with the same bytes.
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm3-gamingpc-"));
  const stagingPath = path.join(stagingDir, path.basename(remotePath.replace(/\\/g, "/")));
  try {
    await fs.writeFile(stagingPath, contents, "utf8");
    await execFileAsync(
      "scp",
      [
        ...sshHostKeyArgs(),
        "-o", "BatchMode=yes",
        "-o", `ConnectTimeout=${GAMING_PC_SYNC_TIMEOUT_SECONDS}`,
        "-i", GAMING_PC_SYNC_SSH_KEY,
        stagingPath,
        `${GAMING_PC_SYNC_USER}@${GAMING_PC_SYNC_HOST}:${remotePath.replace(/\\/g, "/")}`,
      ],
      getExecOptions({ maxBuffer: ACTION_BUFFER }),
    );
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}

function gamingPcSyncPreflight(label) {
  if (!GAMING_PC_SYNC_ENABLED) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!resolveReadableRemoteSshKey(GAMING_PC_SYNC_SSH_KEY)) {
    return {
      ok: false,
      error: `${label} sync needs a readable SSH key at ${GAMING_PC_SYNC_SSH_KEY} (set GAMING_PC_SYNC_SSH_KEY to override).`,
    };
  }
  return null;
}

// Every PC sync is read -> transform -> write-back, so the only per-app part is
// the transform. `transform` returns the new file text, or null to leave it be.
async function syncGamingPcConfig(label, remotePath, transform) {
  const preflight = gamingPcSyncPreflight(label);
  if (preflight) {
    return preflight;
  }

  try {
    const original = await readGamingPcFile(remotePath);
    const updated = transform(original);
    if (updated == null) {
      return { ok: true, skipped: true, reason: "unchanged", config_path: remotePath };
    }
    if (updated === original) {
      return { ok: true, changed: false, reason: "unchanged", config_path: remotePath };
    }
    await writeGamingPcFile(remotePath, updated);
    return { ok: true, changed: true, config_path: remotePath, host: GAMING_PC_SYNC_HOST };
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || `${label} sync failed.`,
    };
  }
}

function toV1BaseUrl(value) {
  const url = String(value || "").trim().replace(/\/$/, "");
  if (!url) {
    return "";
  }
  return /\/v1$/.test(url) ? url : `${url}/v1`;
}

function requireGamingPcTarget(target) {
  const modelId = String(target?.modelId || "").trim();
  const runtimeBaseUrl = String(target?.runtimeBaseUrl || "").trim();
  if (!modelId || !runtimeBaseUrl) {
    throw new Error("Gaming PC sync requires a model id and a runtime base URL.");
  }
  const contextLength = Number(target?.contextLength);
  return {
    modelId,
    runtimeBaseUrl,
    // OMP addresses the server root; PI/OpenCode want the /v1 suffix.
    rootBaseUrl: runtimeBaseUrl.replace(/\/v1\/?$/, ""),
    v1BaseUrl: /\/v1\/?$/.test(runtimeBaseUrl) ? runtimeBaseUrl.replace(/\/$/, "") : `${runtimeBaseUrl.replace(/\/$/, "")}/v1`,
    contextLength: Number.isInteger(contextLength) && contextLength > 0 ? contextLength : null,
    apiKey: String(target?.apiKey || "api-key"),
    supportsVision: Boolean(target?.supportsVision),
    hasVisionTarget: Boolean(target?.hasVisionTarget),
    visionModelId: String(target?.visionModelId || "").trim(),
    visionV1BaseUrl: toV1BaseUrl(target?.visionRuntimeBaseUrl || target?.runtimeBaseUrl),
    // Deliberately preserves undefined-vs-"" : undefined means the launcher has no
    // reasoning knob and the harness keeps its own output cap, while "" means the
    // slot launched on the model template's own default. Collapsing them would make
    // every GGUF slot claim a 32k reply budget it never asked for.
    reasoningEffort: target?.reasoningEffort === undefined || target?.reasoningEffort === null
      ? undefined
      : String(target.reasoningEffort).trim().toLowerCase(),
  };
}

function applyHermesPcConfig(original, target) {
  requireGamingPcTarget(target);
  // Same transform the local/remote Hermes profiles use, so all three stay in step.
  const config = applyLocalHermesModelTarget(yaml.load(original) || {}, target).config;
  return yaml.dump(config, { noRefs: true, indent: 2 });
}

async function syncHermesPcAfterLaunch(target) {
  return syncGamingPcConfig("Hermes PC", GAMING_PC_CONFIG_PATHS.hermes, (original) =>
    applyHermesPcConfig(original, target));
}

// OMP's config.yml points modelRoles.* at "<provider>/<modelId>", so renaming
// the model in models.yaml orphans every role that referenced the old name.
function applyOmpPcSettings(original, modelAlias, providerKey, previousModelId) {
  const config = yaml.load(original) || {};
  const roles = ensureObject(config.modelRoles);
  const target = `${providerKey}/${modelAlias}`;
  const stale = previousModelId ? `${providerKey}/${previousModelId}` : "";
  let changed = false;
  for (const [role, value] of Object.entries(roles)) {
    // Only repoint roles that referenced this provider -- a role deliberately
    // pinned to some other provider is not ours to touch.
    const current = String(value || "");
    if (current === target) {
      continue;
    }
    if (current === stale || current.startsWith(`${providerKey}/`)) {
      roles[role] = target;
      changed = true;
    }
  }
  if (!Object.keys(roles).length) {
    roles.default = target;
    changed = true;
  }
  if (!changed) {
    return null;
  }
  config.modelRoles = roles;
  return yaml.dump(config, { noRefs: true, indent: 2 });
}

function applyOmpPcConfig(original, spec) {
  const config = yaml.load(original) || {};
  const providers = ensureObject(config.providers);
  const providerKey = Object.keys(providers)[0];
  if (!providerKey) {
    throw new Error("OMP PC config has no providers to update.");
  }
  const provider = ensureObject(providers[providerKey]);
  provider.baseUrl = spec.rootBaseUrl;
  provider.apiKey = provider.apiKey || spec.apiKey;
  const models = Array.isArray(provider.models) && provider.models.length
    ? provider.models
    : [{}];
  const primary = ensureObject(models[0]);
  // The id tracks the launched model. It used to be `primary.id || spec.modelId`,
  // i.e. filled only when absent, so models.yaml stayed pinned to whatever was first
  // written there and OMP kept reporting a long-dead model. Renaming is safe *here*
  // -- unlike PI, whose selection lives in a session log llm3 never sees -- because
  // the only thing referencing this id is config.yml's modelRoles, and
  // syncOmpPcAfterLaunch repoints those in the same sync via applyOmpPcSettings.
  primary.id = spec.modelId;
  primary.name = spec.modelId;
  primary.input = spec.supportsVision ? ["text", "image"] : ["text"];
  if (spec.contextLength) {
    primary.contextWindow = spec.contextLength;
  }
  models[0] = primary;
  provider.models = models;
  providers[providerKey] = provider;
  config.providers = providers;
  return yaml.dump(config, { noRefs: true, indent: 2 });
}

async function syncOmpPcAfterLaunch(target) {
  const spec = requireGamingPcTarget(target);
  let providerKey = "";
  let previousModelId = "";
  let modelAlias = "";
  const models = await syncGamingPcConfig("OMP PC", GAMING_PC_CONFIG_PATHS.omp, (original) => {
    const config = yaml.load(original) || {};
    providerKey = Object.keys(ensureObject(config.providers))[0] || "";
    previousModelId = String(ensureObject(ensureObject(config.providers)[providerKey])?.models?.[0]?.id || "");
    const updated = applyOmpPcConfig(original, spec);
    modelAlias = String((yaml.load(updated) || {})?.providers?.[providerKey]?.models?.[0]?.id || "");
    return updated;
  });
  if (models.ok === false || !providerKey || !modelAlias) {
    return models;
  }
  const settings = await syncGamingPcConfig("OMP PC settings", GAMING_PC_CONFIG_PATHS.ompSettings, (original) =>
    applyOmpPcSettings(original, modelAlias, providerKey, previousModelId));
  return settings.ok === false
    ? { ...settings, error: `OMP PC model list updated but ${settings.error}` }
    : { ...models, settings };
}

function pickPiProviderKeys(config) {
  const keys = Object.keys(ensureObject(config?.providers));
  return {
    main: keys.find((key) => !/vision/i.test(key)) || keys[0] || "",
    vision: keys.find((key) => /vision/i.test(key)) || "",
  };
}

// PI names its active model in settings.json, separately from models.json.
// Rewriting the model list without this leaves defaultModel pointing at a model
// that no longer exists, and PI silently falls back to its cloud provider.
// Takes the alias actually written into models.json, NOT the live model name --
// pointing defaultModel at a name that is not in the provider is what sent PI to
// its cloud fallback in the first place.
function applyPiPcSettings(original, modelAlias, providerKey) {
  const settings = JSON.parse(original);
  if (settings.defaultProvider === providerKey && settings.defaultModel === modelAlias) {
    return null;
  }
  settings.defaultProvider = providerKey || settings.defaultProvider;
  settings.defaultModel = modelAlias;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function applyPiPcConfig(original, spec) {
  const config = JSON.parse(original);
  const providers = ensureObject(config.providers);
  const { main: providerKey, vision: visionProviderKey } = pickPiProviderKeys(config);
  if (!providerKey) {
    throw new Error("PI PC config has no providers to update.");
  }
  const provider = ensureObject(providers[providerKey]);
  provider.baseUrl = spec.v1BaseUrl;
  provider.apiKey = provider.apiKey || spec.apiKey;
  const models = Array.isArray(provider.models) && provider.models.length ? provider.models : [{}];
  const primary = ensureObject(models[0]);
  // The id tracks the live model. This was a stable alias, on the grounds that PI
  // remembers a per-project selection in its session log and a rename orphans it --
  // but the practical cost was worse: models.json and settings.json sat on a model
  // no slot had served for weeks, so PI reported the wrong model to the user with
  // no way to tell. syncPiPcAfterLaunch repoints settings.json's defaultModel from
  // the alias it reads back, so the global default stays valid across the rename;
  // only a per-project override needs reselecting once.
  primary.id = spec.modelId;
  primary.input = spec.supportsVision ? ["text", "image"] : ["text"];
  if (spec.contextLength) {
    primary.contextWindow = spec.contextLength;
  }
  models[0] = primary;
  provider.models = models;
  providers[providerKey] = provider;

  // The vision provider tracks whichever slot can serve images, which may be a
  // different slot than the one being launched -- that is the point of having it.
  if (visionProviderKey && spec.hasVisionTarget && spec.visionModelId) {
    const visionProvider = ensureObject(providers[visionProviderKey]);
    visionProvider.baseUrl = spec.visionV1BaseUrl;
    visionProvider.apiKey = visionProvider.apiKey || spec.apiKey;
    const visionModels = Array.isArray(visionProvider.models) && visionProvider.models.length
      ? visionProvider.models
      : [{}];
    const visionPrimary = ensureObject(visionModels[0]);
    // Follows whichever slot serves images, which may not be the launched one.
    visionPrimary.id = spec.visionModelId;
    visionPrimary.input = ["text", "image"];
    if (spec.contextLength) {
      visionPrimary.contextWindow = spec.contextLength;
    }
    visionModels[0] = visionPrimary;
    visionProvider.models = visionModels;
    providers[visionProviderKey] = visionProvider;
  }

  config.providers = providers;
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function syncPiPcAfterLaunch(target) {
  const spec = requireGamingPcTarget(target);
  let providerKey = "";
  let modelAlias = "";
  const models = await syncGamingPcConfig("PI PC", GAMING_PC_CONFIG_PATHS.pi, (original) => {
    providerKey = pickPiProviderKeys(JSON.parse(original)).main;
    const updated = applyPiPcConfig(original, spec);
    modelAlias = String(JSON.parse(updated).providers?.[providerKey]?.models?.[0]?.id || "");
    return updated;
  });
  if (models.ok === false || !providerKey || !modelAlias) {
    return models;
  }
  // Must follow the model list: a defaultModel that no longer exists sends PI
  // to its cloud fallback, which fails with a 401 from a placeholder key.
  const settings = await syncGamingPcConfig("PI PC settings", GAMING_PC_CONFIG_PATHS.piSettings, (original) =>
    applyPiPcSettings(original, modelAlias, providerKey));
  return settings.ok === false
    ? { ...settings, error: `PI PC model list updated but ${settings.error}` }
    : { ...models, settings };
}

// opencode.jsonc is hand-maintained and carries trailing commas, so it is not
// strict JSON and must not be round-tripped through JSON.parse/stringify --
// these are surgical edits that leave the rest of the file byte-identical.
// Finds `"<key>": {` and returns the [start, end] span of its balanced braces,
// so we can edit one provider without parsing the file as a whole.
function findJsoncObjectSpan(text, key) {
  const marker = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*\\{`);
  const match = text.match(marker);
  if (!match) {
    return null;
  }
  const open = match.index + match[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start: open, end: i + 1 };
      }
    }
  }
  return null;
}

// Rewrites one provider block in place: its baseURL, and its models map reduced
// to the single model it now serves. The map is replaced rather than merged so
// that stale entries from previous launches cannot pile up -- OpenCode would
// otherwise offer models the slot no longer serves. Every reference to the old
// name (the top-level selector, compaction.model) is repointed by
// applyOpenCodePcConfig in the same write, so nothing is left dangling.
function rewriteOpenCodeProvider(text, providerKey, { baseUrl, contextLimit, outputLimit = null, vision, modelId }) {
  const span = findJsoncObjectSpan(text, providerKey);
  if (!span) {
    return null;
  }
  let block = text.slice(span.start, span.end);

  const baseUrlPattern = /("baseURL"\s*:\s*)"[^"]*"/;
  // Test for the key rather than comparing before/after: a relaunch onto the
  // same slot writes an identical URL, and that is a success, not a miss.
  if (!baseUrlPattern.test(block)) {
    throw new Error(`OpenCode PC config has no baseURL under the "${providerKey}" provider.`);
  }
  block = block.replace(baseUrlPattern, `$1"${baseUrl}"`);

  const modelsSpan = findJsoncObjectSpan(block, "models");
  if (!modelsSpan) {
    throw new Error(`OpenCode PC config has no models map under the "${providerKey}" provider.`);
  }
  const modelsBlock = block.slice(modelsSpan.start, modelsSpan.end);

  // llm3 owns this cap only when the caller derived one from the slot's reasoning
  // effort (see resolveHarnessOutputLimit) — a thinking model needs room for the
  // reasoning AND the answer, or it returns an empty message. Otherwise keep the
  // file's hand-tuned value: the providers use different ones (4000 for chat, 10000
  // for the compaction model) and nothing upstream knows better.
  const outputMatch = modelsBlock.match(/"output"\s*:\s*(\d+)/);
  const resolvedOutput = Number.isInteger(outputLimit) && outputLimit > 0
    ? String(outputLimit)
    : (outputMatch ? outputMatch[1] : "4000");

  const rebuilt = [
    "{",
    `        ${JSON.stringify(modelId)}: {`,
    `          "name": ${JSON.stringify(modelId)},`,
    '          "limit": {',
    `            "context": ${contextLimit},`,
    `            "output": ${resolvedOutput}`,
    "          },",
    // OpenCode's schema (https://opencode.ai/config.json) has no "vision"
    // property at all -- image support is "attachment" plus modalities.input.
    // llm3 wrote "vision": true for months and OpenCode silently ignored it, so
    // a vision-capable slot still reported no image support on the Gaming PC.
    `          "attachment": ${vision ? "true" : "false"},`,
    '          "modalities": {',
    `            "input": [${vision ? '"text", "image"' : '"text"'}],`,
    '            "output": ["text"]',
    "          }",
    "        }",
    "      }",
  ].join("\n");

  block = block.slice(0, modelsSpan.start) + rebuilt + block.slice(modelsSpan.end);
  return text.slice(0, span.start) + block + text.slice(span.end);
}

// Reads back the model name that actually ended up in a provider block, so the
// selectors can be pointed at it rather than at what we assumed we wrote. Same
// shape as syncPiPcAfterLaunch, which re-reads models[0].id for its settings sync.
function readOpenCodeProviderModel(text, providerKey) {
  const span = findJsoncObjectSpan(text, providerKey);
  if (!span) {
    return "";
  }
  const block = text.slice(span.start, span.end);
  const modelsSpan = findJsoncObjectSpan(block, "models");
  if (!modelsSpan) {
    return "";
  }
  const modelsBlock = block.slice(modelsSpan.start, modelsSpan.end);
  const first = modelsBlock.match(/"([^"]+)"\s*:\s*\{/);
  return first ? first[1] : "";
}

// Repoints every `"model": "<provider>/<name>"` selector at that provider's
// current model, leaving the provider half alone -- compaction deliberately
// names the vision provider while the top-level selector names the main one.
// Global on purpose: both selectors share the field name "model", so a
// first-match replace would repoint the top-level one twice and never reach
// compaction. Providers we did not refresh are skipped, so a hand-written
// selector pointing at some other provider survives untouched.
function repointOpenCodeSelectors(text, aliases) {
  return text.replace(
    /("model"\s*:\s*")([^"/]+)\/([^"]*)(")/g,
    (whole, head, provider, model, tail) => {
      const next = aliases[provider];
      return next ? `${head}${provider}/${next}${tail}` : whole;
    },
  );
}

// opencode.jsonc is hand-maintained and was assumed to tolerate trailing commas.
// It does not: OpenCode's parser rejects `},` before a closing brace, so a stray comma
// after the last provider entry takes the whole config down and OpenCode falls back to
// its defaults. llm3 rewrites this file anyway, so normalise them away on the way out.
//
// Deliberately character-wise rather than a regex: the file carries // and /* */
// comments and strings that can contain braces or commas, and a regex would happily
// eat a comma inside "cwd": "C:\\Users\\..." or inside a comment.
function stripJsoncTrailingCommas(text) {
  const out = [...String(text)];
  let state = "default"; // default | string | line-comment | block-comment
  let escaped = false;
  let lastSignificant = -1;

  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    const next = out[i + 1];

    if (state === "string") {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        state = "default";
        lastSignificant = i;
      }
      continue;
    }
    if (state === "line-comment") {
      if (ch === "\n") {
        state = "default";
      }
      continue;
    }
    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        state = "default";
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      state = "string";
      lastSignificant = i;
      continue;
    }
    if (ch === "/" && next === "/") {
      state = "line-comment";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block-comment";
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      continue;
    }
    if ((ch === "}" || ch === "]") && lastSignificant >= 0 && out[lastSignificant] === ",") {
      out[lastSignificant] = "";
    }
    lastSignificant = i;
  }

  return out.join("");
}

function applyOpenCodePcConfig(original, spec) {
  const contextLimit = spec.contextLength || 240000;
  // undefined = this launcher has no reasoning-effort knob, so keep the file's own
  // hand-tuned "output". A string (including "") means llm3 launched the slot with a
  // known thinking budget and owns the cap. See resolveHarnessOutputLimit.
  const outputLimit = spec.reasoningEffort === undefined || spec.reasoningEffort === null
    ? null
    : resolveHarnessOutputLimit(spec.reasoningEffort, contextLimit);
  let updated = rewriteOpenCodeProvider(original, "llama.cpp", {
    baseUrl: spec.v1BaseUrl,
    contextLimit,
    outputLimit,
    vision: spec.supportsVision,
    modelId: spec.modelId,
  });
  if (!updated) {
    throw new Error("OpenCode PC config has no \"llama.cpp\" provider block to update.");
  }

  // The vision provider tracks whichever slot serves images, which may be a
  // different slot than the one being launched -- that is the point of having it.
  if (spec.hasVisionTarget && spec.visionModelId) {
    updated = rewriteOpenCodeProvider(updated, "llama.cpp-vision", {
      baseUrl: spec.visionV1BaseUrl,
      contextLimit,
      vision: true,
      modelId: spec.visionModelId,
    }) || updated;
  }

  // Selectors must follow the model list. A selector naming a model that is no
  // longer in the file drops OpenCode onto its own default -- the same failure
  // syncPiPcAfterLaunch guards against for PI's defaultModel.
  const aliases = {
    "llama.cpp": readOpenCodeProviderModel(updated, "llama.cpp"),
  };
  if (spec.hasVisionTarget && spec.visionModelId) {
    aliases["llama.cpp-vision"] = readOpenCodeProviderModel(updated, "llama.cpp-vision");
  }
  return stripJsoncTrailingCommas(repointOpenCodeSelectors(updated, aliases));
}

async function syncOpenCodePcAfterLaunch(target) {
  return syncGamingPcConfig("OpenCode PC", GAMING_PC_CONFIG_PATHS.opencode, (original) =>
    applyOpenCodePcConfig(original, requireGamingPcTarget(target)));
}

async function syncApplicationTarget(applicationKey, target) {
  if (applicationKey === "hermes") {
    return syncHermesAfterLaunch(target);
  }
  if (applicationKey === "compaction") {
    return syncHermesCompactionRemoteAfterLaunch(target);
  }
  if (applicationKey === "compactionm4") {
    return syncHermesM4CompactionAfterLaunch(target);
  }
  if (applicationKey === "remotejsonapp") {
    return syncRemoteJsonAppAfterLaunch(target);
  }
  if (applicationKey === "sqliteapp") {
    return syncSqliteAppAfterLaunch(target);
  }
  if (applicationKey === "librechat") {
    return syncLibreChatAfterLaunch(target);
  }
  if (applicationKey === "claudecode") {
    return syncClaudeCodeAfterLaunch(target);
  }
  if (applicationKey === "hermesm4") {
    return syncHermesM4AfterLaunch(target);
  }
  if (applicationKey === "voiceapp") {
    return syncVoiceAppAfterLaunch(target);
  }
  if (applicationKey === "podcastg") {
    return syncPodcastGAfterLaunch(target);
  }
  if (applicationKey === "podgag") {
    return syncPodGAutoGenAfterLaunch(target);
  }
  if (applicationKey === "hermespc") {
    return syncHermesPcAfterLaunch(target);
  }
  if (applicationKey === "opencodepc") {
    return syncOpenCodePcAfterLaunch(target);
  }
  if (applicationKey === "omppc") {
    return syncOmpPcAfterLaunch(target);
  }
  if (applicationKey === "pipc") {
    return syncPiPcAfterLaunch(target);
  }
  return { ok: false, error: `Unsupported application: ${applicationKey}` };
}

async function detectLiveRuntimeStatus(slot, models) {
  const proxyProcess = await getListeningProcess(slot.publicPort);
  if (!proxyProcess) {
    // MTPLX runs directly on its backend port (no proxy layer)
    const mtplxProcess = await getListeningProcess(slot.mtplxBackendPort);
    if (mtplxProcess && detectRuntimeFromProcess(mtplxProcess.command) === "mtplx") {
      const liveModels = await readModelsFromEndpoint(`http://${API_PUBLIC_HOST}:${slot.mtplxBackendPort}/v1/models`);
      if (liveModels.length) {
        const modelId = String(liveModels[0]?.id || liveModels[0]?.name || "").trim();
        const matchedModel = findModelByRuntimeId(models, modelId);
        return {
          slotId: slot.id,
          slotLabel: slot.label,
          slotIndex: slot.index,
          running: true,
          model: matchedModel
            ? { ...matchedModel, launcher: "mtplx", runtime: "mtplx" }
            : { key: modelId || "live-runtime", label: modelId || "Live MTPLX", family: "MLX", sizeLabel: "", launcher: "mtplx", runtime: "mtplx" },
          params: inferParamsFromCommand(mtplxProcess.command, "mtplx"),
          network: { publicHost: API_PUBLIC_HOST, publicPort: slot.publicPort, backendHost: "127.0.0.1", backendPort: slot.mtplxBackendPort },
          logs: { gguf: getDefaultLogs(slot, "gguf"), "gguf-tq3": getDefaultLogs(slot, "gguf-tq3"), beellama: getDefaultLogs(slot, "beellama"), mlx: getDefaultLogs(slot, "mlx"), "rapid-mlx": getDefaultLogs(slot, "rapid-mlx"), mtplx: getDefaultLogs(slot, "mtplx"), optiq: getDefaultLogs(slot, "optiq"), dflash: getDefaultLogs(slot, "dflash"), turboquant: getDefaultLogs(slot, "turboquant"), active: getDefaultLogs(slot, "mtplx") },
          pids: { proxy: mtplxProcess.pid, backend: null },
          startedAt: null,
        };
      }
    }
    return null;
  }

  const liveModels = await readModelsFromEndpoint(`http://${API_PUBLIC_HOST}:${slot.publicPort}/v1/models`);
  if (!liveModels.length) {
    return null;
  }

  const modelId = String(liveModels[0]?.id || liveModels[0]?.name || "").trim();
  const matchedModel = findModelByRuntimeId(models, modelId);
  const runtime =
    matchedModel?.runtime ||
    detectRuntimeFromProcess(proxyProcess.command) ||
    detectRuntimeFromEndpointModel(liveModels[0]);
  const launcher =
    detectLauncherFromProcess(proxyProcess.command) ||
    String(matchedModel?.launcher || "").trim() ||
    runtime;

  if (!runtime || !launcher) {
    return null;
  }

  const backendPort = inferBackendPort(proxyProcess.command, runtime, slot, launcher);
  const backendProcess = backendPort ? await getListeningProcess(backendPort) : null;
  const fallbackLogs = getDefaultLogs(slot, launcher);

  return {
    slotId: slot.id,
    slotLabel: slot.label,
    slotIndex: slot.index,
    running: true,
    model: matchedModel
      ? {
          ...matchedModel,
          launcher,
          runtime: matchedModel.runtime || runtime,
        }
      : {
          key: modelId || "live-runtime",
          label: modelId || "Live Runtime",
          family: runtime === "dflash" ? "DFlash" : runtime === "mlx" ? "MLX" : "GGUF",
          sizeLabel: "",
          launcher,
          runtime,
        },
    params: inferParamsFromCommand(proxyProcess.command, runtime),
    network: {
      publicHost: API_PUBLIC_HOST,
      publicPort: slot.publicPort,
      backendHost: "127.0.0.1",
      backendPort,
    },
    logs: {
      gguf: getDefaultLogs(slot, "gguf"),
      "gguf-tq3": getDefaultLogs(slot, "gguf-tq3"),
      beellama: getDefaultLogs(slot, "beellama"),
      mlx: getDefaultLogs(slot, "mlx"),
      "rapid-mlx": getDefaultLogs(slot, "rapid-mlx"),
      mtplx: getDefaultLogs(slot, "mtplx"),
      optiq: getDefaultLogs(slot, "optiq"),
      dflash: getDefaultLogs(slot, "dflash"),
      turboquant: getDefaultLogs(slot, "turboquant"),
      active: fallbackLogs,
    },
    pids: {
      proxy: proxyProcess.pid,
      backend: backendProcess?.pid || null,
    },
    startedAt: null,
  };
}

async function getSystemStats(statuses = null) {
  const runningStatuses = Array.isArray(statuses) ? statuses : await getSlotStatuses();
  const [memory, processes, disk] = await Promise.all([
    getMemoryStats(),
    getProcessStats(runningStatuses),
    getDiskStats(),
  ]);
  const gpu = await getGpuStats(runningStatuses, memory);
  const uptimeSeconds = Math.max(0, Math.floor(os.uptime()));

  // Every running backend, not just the first one found. modelRssBytes used to
  // report a single slot, so with two models loaded the figure beside the RAM
  // badge described one of them and silently ignored the other.
  const modelBackends = Object.entries(processes)
    .map(([slotId, entry]) => (entry?.backend ? { slotId, ...entry.backend } : null))
    .filter(Boolean);
  const modelResidentBytes = modelBackends.reduce((sum, entry) => sum + Number(entry.rssBytes || 0), 0);

  // Why the slot cards can never add up to the badge.
  //
  // A slot card shows its backend's RSS. llama.cpp's Metal backend hands the
  // GPU buffers created over its own memory with StorageModeShared, and the
  // kernel wires those pages so the GPU can reach them. Wired pages leave the
  // active/inactive queues, macOS attributes them to no process, and neither
  // ps, footprint nor vmmap reports them -- vmmap catches ComfyUI's IOAccelerator
  // buffers but sees ~10 MB for a llama-server holding tens of gigabytes.
  //
  // Measured 2026-09-10 with one inference request on a loaded slot: wired went
  // 31.3 -> 33.9 -> 32.5 GB while the slot's RSS stayed at 26.5 GB throughout.
  // So the badge (wired + app memory + compressed) counts a large block that no
  // slot can claim, and the difference read as tens of missing gigabytes.
  //
  // There is no per-process number to be had: llama.cpp's /props, /metrics and
  // /slots report no memory at all. So name the block instead of hiding it.
  const wiredBytes = Number(memory?.breakdown?.wiredBytes || 0);
  const attribution = {
    modelResidentBytes,
    wiredBytes,
    compressedBytes: Number(memory?.breakdown?.compressedBytes || 0),
    appMemoryBytes: Number(memory?.breakdown?.appMemoryBytes || 0),
    slots: modelBackends.map((entry) => ({
      slotId: entry.slotId,
      pid: entry.pid,
      rssBytes: Number(entry.rssBytes || 0),
    })),
    note:
      "Wired holds the GPU's Metal working set and the kernel's own pages. macOS "
      + "reports it per machine, never per process, so a slot card cannot include its share.",
  };

  return {
    cpu: {
      overallPercent: cpuPercent,
      performanceCores: await getPerformanceCoreCount(),
      logicalCores: os.cpus().length,
      uptime: uptimeSeconds,
      bootedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
    },
    memory: {
      ...memory,
      modelRssBytes: modelResidentBytes,
      modelPercentOfSystem:
        memory.totalBytes > 0 ? round1((modelResidentBytes / memory.totalBytes) * 100) : 0,
      attribution,
    },
    gpu,
    disk,
    processes,
  };
}

async function getGpuStats(statuses, memory) {
  const fallback = {
    available: false,
    percent: null,
    note: "Metal telemetry unavailable until an MLX/Metal log line is emitted.",
    kind: "metal_memory",
  };

  const activeStatus = (Array.isArray(statuses) ? statuses : []).find((entry) => entry?.running && entry?.logs?.active);
  const logPath = activeStatus?.logs?.active?.server || activeStatus?.logs?.active?.proxy || "";
  if (!logPath) {
    return fallback;
  }

  const stat = await fs.stat(logPath).catch(() => null);
  if (!stat || stat.size === 0) {
    return fallback;
  }

  const length = Math.min(stat.size, 1024 * 1024);
  const start = Math.max(0, stat.size - length);
  const handle = await fs.open(logPath, "r").catch(() => null);
  if (!handle) {
    return fallback;
  }

  let content = "";
  try {
    const tailBuffer = Buffer.alloc(length);
    await handle.read(tailBuffer, 0, length, start);
    content = tailBuffer.toString("utf8");

    if (start > 0) {
      const headLength = Math.min(stat.size, 256 * 1024);
      const headBuffer = Buffer.alloc(headLength);
      await handle.read(headBuffer, 0, headLength, 0);
      content = `${headBuffer.toString("utf8")}\n${content}`;
    }
  } finally {
    await handle.close();
  }

  const metalLines = content
    .split("\n")
    .filter((line) => line.includes("[Metal memory]"));
  const latest = metalLines.at(-1);
  if (!latest) {
    return parseLlamaMetalStats(content, memory) || fallback;
  }

  const activeMatch = latest.match(/active=([0-9.]+)GB/);
  const peakMatch = latest.match(/peak=([0-9.]+)GB/);
  const cacheMatch = latest.match(/cache=([0-9.]+)GB/);
  if (!activeMatch) {
    return fallback;
  }

  const activeGb = Number(activeMatch[1]);
  const peakGb = peakMatch ? Number(peakMatch[1]) : null;
  const cacheGb = cacheMatch ? Number(cacheMatch[1]) : null;
  const activeBytes = activeGb * 1024 ** 3;
  const peakBytes = peakGb === null ? null : peakGb * 1024 ** 3;
  const cacheBytes = cacheGb === null ? null : cacheGb * 1024 ** 3;
  const percent = memory.totalBytes > 0 ? round1((activeBytes / memory.totalBytes) * 100) : null;

  return {
    available: true,
    percent,
    activeBytes,
    peakBytes,
    cacheBytes,
    kind: "metal_memory",
    note: `Metal active ${formatBytes(activeBytes)}${peakBytes ? ` · peak ${formatBytes(peakBytes)}` : ""}${
      cacheBytes ? ` · cache ${formatBytes(cacheBytes)}` : ""
    }`,
  };
}

function parseLlamaMetalStats(content, memory) {
  if (!content.includes("ggml_metal") && !content.includes("MTL0")) {
    return null;
  }

  const offloadMatch = content.match(/offloaded\s+(\d+)\/(\d+)\s+layers to GPU/);
  const workingSetMatch = content.match(/recommendedMaxWorkingSetSize\s+=\s+([0-9.]+)\s+MB/);
  const projectedMatch = content.match(/projected to use\s+([0-9.]+)\s+MiB of device memory/);
  const bufferMatches = [...content.matchAll(/MTL0[^=\n]*buffer size\s+=\s+([0-9.]+)\s+MiB/g)];

  const bufferBytes = bufferMatches.reduce((sum, match) => sum + Number(match[1]) * 1024 ** 2, 0);
  const projectedBytes = projectedMatch ? Number(projectedMatch[1]) * 1024 ** 2 : 0;
  const activeBytes = Math.max(bufferBytes, projectedBytes);
  if (!activeBytes) {
    return null;
  }

  const workingSetBytes = workingSetMatch ? Number(workingSetMatch[1]) * 1024 ** 2 : null;
  const denominator = workingSetBytes || memory.totalBytes;
  const percent = denominator > 0 ? round1((activeBytes / denominator) * 100) : null;
  const layerNote = offloadMatch ? ` · offloaded ${offloadMatch[1]}/${offloadMatch[2]} layers` : "";
  const capacityNote = workingSetBytes ? ` of ${formatBytes(workingSetBytes)} Metal working set` : "";

  return {
    available: true,
    percent,
    activeBytes,
    peakBytes: null,
    cacheBytes: null,
    kind: "llama_metal_memory",
    note: `Metal allocated ${formatBytes(activeBytes)}${capacityNote}${layerNote}`,
  };
}

// macOS "memory pressure" is a kernel verdict, not a percentage: 1 normal,
// 2 warning, 4 critical. Use it when it is readable, because no ratio derived
// from vm_stat says the same thing -- a machine can sit at 95 percent occupied
// by clean cache under no pressure at all.
async function readMemoryPressureLabel() {
  try {
    const { stdout } = await execFileAsync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { maxBuffer: 4096 });
    const level = Number(String(stdout).trim());
    if (level >= 4) return "high";
    if (level >= 2) return "medium";
    if (level >= 1) return "normal";
  } catch (_error) {
    // Fall through to the ratio below.
  }
  return "";
}

// WHAT COUNTS AS "USED" HERE, and why it is not free+inactive.
//
// This used to report used = total - (free + inactive + speculative), which
// counts every ACTIVE page as occupied. On this box that read 50.6 percent
// while the true occupancy was about 11: the difference was 108 GiB of clean
// file-backed pages -- the unified buffer cache holding model weights that had
// just been read or mmapped. Those pages are handed back the instant anything
// asks for them, and a model runtime mapping a 41.7 GiB pack (ds4, llama.cpp
// and MLX all mmap their weights) will always park a large amount there.
// Reporting that as consumed memory made a healthy machine look nearly full.
//
// So "used" is now what Activity Monitor calls Memory Used:
//     wired + app memory (anonymous pages) + compressed
// and the cache is reported separately in the breakdown, so a loaded model is
// still visible without inflating the gauge. vm_stat's own accounting supports
// the split: active + inactive + speculative equals anonymous + file-backed,
// and wired and the compressor sit outside all three queues, so nothing here
// is double counted.
async function getMemoryStats() {
  const totalBytes = os.totalmem();
  let pageSize = 4096;
  const pages = {
    free: 0,
    active: 0,
    inactive: 0,
    speculative: 0,
    wired: 0,
    compressed: 0,
    fileBacked: 0,
    anonymous: 0,
  };

  try {
    const { stdout } = await execFileAsync("vm_stat", [], { maxBuffer: 256 * 1024 });
    const sizeMatch = stdout.match(/page size of (\d+) bytes/);
    if (sizeMatch) {
      pageSize = Number(sizeMatch[1]);
    }

    for (const line of stdout.split("\n")) {
      const match = line.match(/^Pages (.+?):\s+([0-9.]+)/);
      if (!match) {
        continue;
      }
      const label = match[1].trim().toLowerCase();
      const value = Number(match[2].replace(/\.$/, ""));
      if (label === "free") pages.free = value;
      if (label === "active") pages.active = value;
      if (label === "inactive") pages.inactive = value;
      if (label === "speculative") pages.speculative = value;
      if (label === "wired down") pages.wired = value;
      if (label === "occupied by compressor") pages.compressed = value;
    }

    // "File-backed pages:" and "Anonymous pages:" do not start with "Pages",
    // so the loop above never sees them.
    for (const line of stdout.split("\n")) {
      const match = line.match(/^(File-backed|Anonymous) pages:\s+([0-9.]+)/);
      if (!match) {
        continue;
      }
      const value = Number(match[2].replace(/\.$/, ""));
      if (match[1] === "File-backed") pages.fileBacked = value;
      if (match[1] === "Anonymous") pages.anonymous = value;
    }
  } catch (_error) {
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;
    return {
      totalBytes,
      usedBytes,
      availableBytes: freeBytes,
      usedPercent: round1((usedBytes / totalBytes) * 100),
      pressureLabel: usedBytes / totalBytes > 0.85 ? "high" : usedBytes / totalBytes > 0.7 ? "medium" : "normal",
      breakdown: null,
    };
  }

  const cachedFilesBytes = pages.fileBacked * pageSize;
  const appMemoryBytes = pages.anonymous * pageSize;
  const wiredBytes = pages.wired * pageSize;
  const compressedBytes = pages.compressed * pageSize;

  // An older macOS that stops printing the anonymous/file-backed lines would
  // leave both at zero and report a machine with no memory in use at all, which
  // is worse than the old over-count. Fall back to the queue arithmetic then.
  const haveQueueSplit = pages.fileBacked > 0 || pages.anonymous > 0;
  const usedBytes = haveQueueSplit
    ? wiredBytes + appMemoryBytes + compressedBytes
    : Math.max(0, totalBytes - (pages.free + pages.inactive + pages.speculative) * pageSize);
  const availableBytes = Math.max(0, totalBytes - usedBytes);
  const usedPercent = totalBytes > 0 ? round1((usedBytes / totalBytes) * 100) : 0;
  const measuredPressure = await readMemoryPressureLabel();

  return {
    totalBytes,
    usedBytes,
    availableBytes,
    usedPercent,
    cachedFilesBytes,
    pressureLabel: measuredPressure
      || (usedPercent > 85 ? "high" : usedPercent > 70 ? "medium" : "normal"),
    pressureSource: measuredPressure ? "kernel" : "ratio",
    breakdown: {
      activeBytes: pages.active * pageSize,
      inactiveBytes: pages.inactive * pageSize,
      wiredBytes,
      compressedBytes,
      speculativeBytes: pages.speculative * pageSize,
      freeBytes: pages.free * pageSize,
      cachedFilesBytes,
      appMemoryBytes,
    },
  };
}

async function getDiskStats() {
  const targets = [
    "/System/Volumes/Data",
    HOME,
    "/",
  ].filter(Boolean);

  for (const target of targets) {
    try {
      const { stdout } = await execFileAsync("df", ["-kP", target], { maxBuffer: 64 * 1024 });
      const lines = stdout.trim().split("\n");
      if (lines.length < 2) {
        continue;
      }
      const parts = lines[1].split(/\s+/);
      const totalKb = Number(parts[1]);
      const usedKb = Number(parts[2]);
      const availKb = Number(parts[3]);
      if (!totalKb) {
        continue;
      }
      const totalBytes = totalKb * 1024;
      const usedBytes = usedKb * 1024;
      const availableBytes = availKb * 1024;
      return {
        totalBytes,
        usedBytes,
        availableBytes,
        usedPercent: round1((usedBytes / totalBytes) * 100),
        mountPoint: parts.at(-1) || target,
      };
    } catch (_error) {
      continue;
    }
  }
  return null;
}

async function getProcessStats(statuses) {
  const result = {};
  const activeStatuses = (Array.isArray(statuses) ? statuses : []).filter(
    (status) => status?.running && status?.pids
  );

  if (activeStatuses.length === 0) {
    return result;
  }

  const pidMap = new Map();
  for (const status of activeStatuses) {
    result[status.slotId] = { backend: null, proxy: null };
    if (status.pids.backend) {
      pidMap.set(String(status.pids.backend), { slotId: status.slotId, role: "backend" });
    }
    if (status.pids.proxy) {
      pidMap.set(String(status.pids.proxy), { slotId: status.slotId, role: "proxy" });
    }
  }
  const pids = [...pidMap.keys()].filter(Boolean);
  if (pids.length === 0) {
    return result;
  }

  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", pids.join(","), "-o", "pid=,%cpu=,%mem=,rss=,etime=,command="],
      { maxBuffer: 256 * 1024 }
    );

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const match = trimmed.match(/^(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) {
        continue;
      }
      const [, pid, cpu, mem, rss, etime, command] = match;
      const entry = pidMap.get(pid);
      if (!entry) {
        continue;
      }
      result[entry.slotId][entry.role] = {
        pid: Number(pid),
        cpuPercent: Number(cpu),
        memPercent: Number(mem),
        rssBytes: Number(rss) * 1024,
        elapsed: etime,
        command,
      };
    }
  } catch (_error) {
    return result;
  }

  return result;
}

let listeningPortCache = { expiresAt: 0, value: null, promise: null };

// Reads every listening TCP port -> pid in one shot.
//
// This used to be `lsof -iTCP:<port>` per port, but lsof walks the open file table of
// every process on the machine, so a single process holding a lot of files makes each
// call take ~20s (a Docker VM importing a photo library got to ~87k open fds, which
// pushed /api/status to 50s and stalled the dashboard). netstat reports the same
// mapping in ~20ms because it only reads the socket table.
async function readListeningPortMap() {
  const { stdout } = await execFileAsync("netstat", ["-anv", "-p", "tcp"], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: PORT_PROBE_TIMEOUT_MS,
  });

  const ports = new Map();
  for (const line of stdout.split("\n")) {
    // tcp4  0  0  *.7075  *.*  LISTEN  0  0  131072  131072  node:74913  ...
    const fields = line.trim().split(/\s+/);
    if (fields.length < 11 || fields[5] !== "LISTEN") {
      continue;
    }

    const localAddress = fields[3];
    const owner = fields[10];
    const port = Number(localAddress.slice(localAddress.lastIndexOf(".") + 1));
    const pid = Number(owner.slice(owner.lastIndexOf(":") + 1));
    if (!port || !pid || !Number.isInteger(port) || !Number.isInteger(pid)) {
      continue;
    }

    // A port can be listed once per address family (tcp4/tcp6); first entry wins.
    if (!ports.has(port)) {
      ports.set(port, pid);
    }
  }

  return ports;
}

async function getListeningPortMap() {
  const now = Date.now();
  if (listeningPortCache.value && listeningPortCache.expiresAt > now) {
    return listeningPortCache.value;
  }
  if (listeningPortCache.promise) {
    return listeningPortCache.promise;
  }

  listeningPortCache.promise = readListeningPortMap()
    .then((value) => {
      listeningPortCache = {
        expiresAt: Date.now() + LISTENING_PORT_CACHE_TTL_MS,
        value,
        promise: null,
      };
      return value;
    })
    .catch(() => {
      // Probing failed or timed out: report "nothing listening" for this pass rather
      // than letting the caller hang, and retry on the next call.
      listeningPortCache = { expiresAt: 0, value: null, promise: null };
      return new Map();
    });

  return listeningPortCache.promise;
}

async function getListeningProcess(port) {
  try {
    const listeningPorts = await getListeningPortMap();
    const pid = listeningPorts.get(Number(port));
    if (!pid) {
      return null;
    }

    // netstat truncates the process name to 16 chars, so read the full command line.
    const { stdout: command } = await execFileAsync(
      "ps",
      ["-ww", "-p", String(pid), "-o", "command="],
      { maxBuffer: 64 * 1024, timeout: PORT_PROBE_TIMEOUT_MS }
    );

    return {
      pid,
      command: command.trim(),
    };
  } catch (_error) {
    return null;
  }
}

function detectRuntimeFromProcess(command) {
  const value = normalizeModelId(command);
  if (!value) {
    return null;
  }
  if (value.includes("mtplx") || value.includes("run-qwen36-mtplx-api.sh")) {
    return "mtplx";
  }
  if (value.includes("qwen_llama_beellama") || value.includes("beellama")) {
    return "beellama";
  }
  if (value.includes("qwen_llama_tq3") || value.includes("llama.cpp-tq3")) {
    return "gguf-tq3";
  }
  if (value.includes("rapid-mlx")) {
    return "mlx";
  }
  if (value.includes("qwen36-dflash-api.py") || value.includes("run-qwen36-dflash-api.sh") || value.includes("dflash")) {
    return "dflash";
  }
  if (value.includes("qwen36-mlx-api-proxy.py") || value.includes("vllm_mlx") || value.includes("--model-dir")) {
    return "mlx";
  }
  if (value.includes("llama-server") || value.includes("qwen_llama")) {
    return "gguf";
  }
  return null;
}

function detectLauncherFromProcess(command) {
  const value = normalizeModelId(command);
  if (!value) {
    return null;
  }
  if (value.includes("mtplx") || value.includes("run-qwen36-mtplx-api.sh")) {
    return "mtplx";
  }
  if (value.includes("rapid-mlx")) {
    return "rapid-mlx";
  }
  if (value.includes("qwen36-dflash-api.py") || value.includes("run-qwen36-dflash-api.sh") || value.includes("dflash")) {
    return "dflash";
  }
  if (value.includes("qwen36-mlx-api-proxy.py") || value.includes("vllm_mlx") || value.includes("--model-dir")) {
    return "mlx";
  }
  if (value.includes("llama-server") || value.includes("qwen_llama")) {
    return "gguf";
  }
  return null;
}

function detectRuntimeFromEndpointModel(model) {
  const owner = normalizeModelId(model?.owned_by);
  if (owner.includes("dflash")) {
    return "dflash";
  }
  if (owner.includes("mlx")) {
    return "mlx";
  }
  if (owner.includes("gguf") || owner.includes("llama")) {
    return "gguf";
  }
  return null;
}

function inferBackendPort(command, runtime, slot, launcher = "") {
  const match = String(command || "").match(/--backend-port\s+(\d+)/);
  if (match) {
    return Number(match[1]);
  }
  if (launcher === "gguf-tq3") {
    return slot.ggufTq3BackendPort;
  }
  if (launcher === "beellama") {
    return slot.beellamaBackendPort;
  }
  if (runtime === "dflash") {
    return slot.publicPort;
  }
  if (runtime === "mlx") {
    return slot.mlxBackendPort;
  }
  if (runtime === "mtplx") {
    return slot.mtplxBackendPort;
  }
  if (runtime === "gguf") {
    return slot.ggufBackendPort;
  }
  return null;
}

function inferParamsFromCommand(command, runtime) {
  const ctxMatch = String(command || "").match(/--(?:context-size|ctx-size)\s+(\d+)/);
  const parallelMatch = String(command || "").match(/--parallel\s+(\d+)/);
  const thinkingEnabled = runtime === "gguf" ? /--thinking\b/.test(String(command || "")) : false;
  const rawCtxSize = ctxMatch ? Number(ctxMatch[1]) : null;
  const parallel = parallelMatch ? Number(parallelMatch[1]) : null;
  const effectiveCtxSize =
    runtime === "gguf"
    && Number.isInteger(rawCtxSize)
    && rawCtxSize > 0
    && Number.isInteger(parallel)
    && parallel > 1
      ? Math.max(1, Math.floor(rawCtxSize / parallel))
      : rawCtxSize;

  return {
    ctxSize: effectiveCtxSize,
    parallel,
    thinking: thinkingEnabled,
    threads: null,
    threadsBatch: null,
    batchSize: runtime === "mlx" || runtime === "dflash" ? 1024 : null,
    ubatchSize: null,
    gpuLayers: null,
  };
}

function findModelByRuntimeId(models, runtimeId) {
  const target = normalizeModelId(runtimeId);
  if (!target) {
    return null;
  }

  return models.find((model) => modelMatchesRuntimeId(model, target)) || null;
}

function normalizeModelId(value) {
  return String(value || "").trim().toLowerCase();
}

function readJsonFromEndpoint(url, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 256 * 1024;
    const apiKey = String(options.apiKey || "api").trim() || "api";
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const request = http.get(url, {
      timeout: timeoutMs,
      headers: buildRuntimeAuthHeaders(apiKey),
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(null);
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > maxBytes) {
          request.destroy();
          finish(null);
        }
      });
      response.on("end", () => {
        try {
          finish(JSON.parse(body));
        } catch (_error) {
          finish(null);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy();
      finish(null);
    });
    request.on("error", () => finish(null));
  });
}

async function readModelsFromEndpoint(url, options = {}) {
  const payload = await readJsonFromEndpoint(url, { timeoutMs: 1500, maxBytes: 256 * 1024, ...options });
  return Array.isArray(payload?.data) ? payload.data : [];
}

// An MLX model directory says whether it is multimodal in its own config.json:
// a vision tower carries a vision_config (and the architecture is usually
// *VLForConditionalGeneration). Relying on .llm3-hf.json alone marked Mage-VL,
// which has no such sidecar, as text-only -- so the chat tab warned that
// attaching an image would not work on the one local model that handles images.
function mlxDirDeclaresVision(modelDir) {
  // Weights first: a config can declare a vision_config it has no tower for.
  // Every Qwen3.5/3.8 checkpoint here declares one because the architecture is
  // natively multimodal, so the config alone proves nothing; the tensor names
  // do. (Measured: those checkpoints really do ship 333-501 vision tensors, so
  // they are correctly flagged -- it is the general case this guards.)
  try {
    const index = JSON.parse(fsSync.readFileSync(path.join(modelDir, "model.safetensors.index.json"), "utf8"));
    const names = Object.keys(index?.weight_map || {});
    if (names.length) {
      return names.some((name) => /(^|\.)(vision_tower|visual|vision_model)\./.test(name));
    }
  } catch (_error) {
    // No index (single-file or unusual layout) -- fall through to the config.
  }
  try {
    const config = JSON.parse(fsSync.readFileSync(path.join(modelDir, "config.json"), "utf8"));
    if (config?.vision_config || config?.vision_tower) {
      return true;
    }
    const architectures = Array.isArray(config?.architectures) ? config.architectures.join(" ") : "";
    return /VL|Vision|Multimodal/i.test(architectures);
  } catch (_error) {
    return false;
  }
}

function getEndpointModelId(entry) {
  return String(entry?.id || entry?.name || "").trim();
}

function getModelRuntimeIdCandidates(model) {
  if (!model) {
    return [];
  }

  const aliases = Array.isArray(model.aliases)
    ? model.aliases
    : String(model.aliases || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  const pathValue = String(model.path || "").trim();
  const basenameValue = pathValue ? path.basename(pathValue) : "";
  const explicitRuntimeId = String(model.runtimeId || model.modelId || model.id || "").trim();
  const derivedRuntimeId = deriveRuntimeModelIdFromPath(model);
  return [
    explicitRuntimeId,
    derivedRuntimeId,
    model.key,
    model.label,
    pathValue,
    basenameValue,
    ...aliases,
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function modelMatchesRuntimeId(model, runtimeId) {
  const target = normalizeModelId(runtimeId);
  if (!target) {
    return false;
  }
  return getModelRuntimeIdCandidates(model).some((value) => normalizeModelId(value) === target);
}

function pickEndpointModelEntry(models, preferredModel = null) {
  if (!Array.isArray(models) || !models.length) {
    return null;
  }
  if (preferredModel) {
    const matched = models.find((entry) => modelMatchesRuntimeId(preferredModel, getEndpointModelId(entry)));
    if (matched) {
      return matched;
    }
  }
  return models.find((entry) => getEndpointModelId(entry)) || null;
}

async function fetchRuntimeModelId(slot, status = null, preferredModel = null) {
  const models = await readModelsFromEndpoint(`http://${API_PUBLIC_HOST}:${slot.publicPort}/v1/models`, {
    apiKey: getRuntimeApiKey(status?.model?.runtime),
  });
  const modelId = getEndpointModelId(pickEndpointModelEntry(models, preferredModel || status?.model || null));
  return modelId || null;
}

function chooseLaunchSyncModelId(liveRuntimeModelId, selectedModel, liveStatusModel) {
  const liveModelId = String(liveRuntimeModelId || "").trim();
  const preferredSelectedModelId = getPreferredRuntimeModelId(selectedModel);
  if (preferredSelectedModelId) {
    if (!liveModelId || modelMatchesRuntimeId(selectedModel, liveModelId)) {
      return liveModelId || preferredSelectedModelId;
    }
    return preferredSelectedModelId;
  }
  return liveModelId || getPreferredRuntimeModelId(liveStatusModel);
}

function deriveRuntimeModelIdFromPath(model) {
  const modelPath = String(model?.path || "").trim();
  if (!modelPath) {
    return null;
  }

  const baseName = path.basename(modelPath);
  if (!baseName) {
    return null;
  }

  if (baseName.toLowerCase().endsWith(".gguf")) {
    return baseName.replace(/\.gguf$/i, "") || null;
  }
  return baseName || null;
}

function getPreferredRuntimeModelId(model) {
  if (!model) {
    return null;
  }
  const explicitRuntimeId = String(model.runtimeId || model.modelId || model.id || "").trim();
  if (explicitRuntimeId) {
    return explicitRuntimeId;
  }
  const pathDerivedRuntimeId = deriveRuntimeModelIdFromPath(model);
  if (pathDerivedRuntimeId) {
    return pathDerivedRuntimeId;
  }
  if (Array.isArray(model.aliases) && model.aliases.length > 0) {
    return String(model.aliases[0] || "").trim() || String(model.key || "").trim() || null;
  }
  return String(model.key || model.label || "").trim() || null;
}

async function updateClaudeProxyEnv(target) {
  const values = {
    OPENAI_BASE_URL: target.runtimeBaseUrl,
    BIG_MODEL: target.modelId,
    MIDDLE_MODEL: target.modelId,
    SMALL_MODEL: target.modelId,
  };
  await fs.mkdir(path.dirname(CLAUDE_PROXY_ENV_PATH), { recursive: true });
  await upsertEnvFile(CLAUDE_PROXY_ENV_PATH, values);
}

async function updateClaudeSettings(target) {
  let settings = {};
  try {
    const raw = await fs.readFile(CLAUDE_SETTINGS_PATH, "utf8");
    settings = JSON.parse(raw);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const env = settings.env && typeof settings.env === "object" ? settings.env : {};
  const label = `${target.modelId} local`;
  const description = `Local OpenClaude proxy to ${target.runtimeBaseUrl} · ctx ${formatContextLength(target.contextLength)}`;

  env.ANTHROPIC_DEFAULT_SONNET_MODEL = target.modelId;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = label;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION = description;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = target.modelId;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = label;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION = description;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = target.modelId;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = label;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION = description;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION = target.modelId;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = label;
  env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = description;

  settings.env = env;
  await fs.mkdir(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  await fs.writeFile(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function restartClaudeProxy(target) {
  const domain = getClaudeProxyLaunchDomain();
  if (!domain) {
    return buildClaudeGuiSkipResult("Claude proxy restart needs a GUI launchd domain, but no GUI uid is available in this runtime.");
  }

  if (!(await canAccessClaudeProxyLaunchDomain())) {
    return buildClaudeGuiSkipResult(
      `Claude proxy launchctl domain ${domain} is unavailable. The proxy can only be restarted while a GUI login session for that user exists.`
    );
  }

  try {
    await execFileAsync(
      "launchctl",
      ["kickstart", "-k", `${domain}/${CLAUDE_PROXY_LAUNCH_LABEL}`],
      getExecOptions({ maxBuffer: 256 * 1024 })
    );
  } catch (error) {
    if (SERVICE_MODE === "launchd" && LAUNCHD_DOMAIN === "system" && isGuiLaunchDomainError(error)) {
      claudeGuiDomainAvailabilityPromise = Promise.resolve(false);
      return buildClaudeGuiSkipResult(
        `Claude proxy restart could not reach ${domain}. This launchd mode has no active GUI session for the proxy LaunchAgent.`
      );
    }
    throw error;
  }

  const deadline = Date.now() + 30000;
  let delay = 100;
  const maxDelay = 2000;
  
  while (Date.now() < deadline) {
    const rootPayload = await readJsonFromUrl(CLAUDE_PROXY_ROOT_URL);
    if (
      rootPayload?.status === "running" &&
      rootPayload?.config?.openai_base_url === target.runtimeBaseUrl &&
      rootPayload?.config?.big_model === target.modelId &&
      rootPayload?.config?.small_model === target.modelId
    ) {
      return rootPayload;
    }
    // Exponential backoff: 100ms -> 200ms -> 400ms -> 800ms -> 2000ms
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }

  throw new Error("OpenClaude proxy did not restart with the expected model configuration.");
}

async function upsertEnvFile(filePath, values) {
  let source = "";
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const lines = source.split(/\r?\n/);
  const remaining = new Map(Object.entries(values));
  const nextLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      return line;
    }

    const key = match[1];
    if (!remaining.has(key)) {
      return line;
    }

    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${quoteEnvValue(value)}`;
  });

  for (const [key, value] of remaining.entries()) {
    nextLines.push(`${key}=${quoteEnvValue(value)}`);
  }

  await fs.writeFile(filePath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

function quoteEnvValue(value) {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildHermesSyncRemoteScript(payload) {
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

  return [
    "set -euo pipefail",
    `PYTHON_BIN=${shellQuote(HERMES_SYNC_PYTHON)}`,
    `CONFIG_PATH=${shellQuote(HERMES_SYNC_CONFIG_PATH)}`,
    `CACHE_PATH=${shellQuote(HERMES_SYNC_CACHE_PATH)}`,
    `PAYLOAD_BASE64=${shellQuote(payloadBase64)}`,
    "\"$PYTHON_BIN\" - \"$CONFIG_PATH\" \"$CACHE_PATH\" \"$PAYLOAD_BASE64\" <<'PY'",
    "import base64",
    "import json",
    "import pathlib",
    "import sys",
    "import yaml",
    "",
    "config_path = pathlib.Path(sys.argv[1]).expanduser()",
    "cache_path = pathlib.Path(sys.argv[2]).expanduser()",
    "payload = json.loads(base64.b64decode(sys.argv[3]).decode('utf-8'))",
    "",
    "config = {}",
    "if config_path.exists():",
    "    config = yaml.safe_load(config_path.read_text(encoding='utf-8')) or {}",
    "",
    "model_cfg = config.setdefault('model', {})",
    "existing_base_url = str(model_cfg.get('base_url') or '').strip()",
    "existing_model = str(model_cfg.get('model') or model_cfg.get('default') or '').strip()",
    "effective_model = str(payload.get('model') or existing_model).strip()",
    "effective_base_url = str(payload.get('base_url') or existing_base_url).strip()",
    "model_cfg['provider'] = str(payload.get('provider') or model_cfg.get('provider') or 'custom')",
    "model_cfg['api_key'] = str(payload.get('api_key') or model_cfg.get('api_key') or 'api')",
    "model_cfg['model'] = effective_model",
    "model_cfg['default'] = effective_model",
    "model_cfg['context_length'] = int(payload['context_length'])",
    "if effective_base_url:",
    "    model_cfg['base_url'] = effective_base_url",
    "auxiliary_cfg = config.setdefault('auxiliary', {})",
    "vision_cfg = auxiliary_cfg.setdefault('vision', {})",
    "vision_cfg['provider'] = str(payload.get('provider') or vision_cfg.get('provider') or 'custom')",
    "vision_cfg['api_key'] = str(payload.get('vision_api_key') or payload.get('api_key') or vision_cfg.get('api_key') or 'api')",
    "vision_cfg['model'] = payload.get('vision_model') or payload['model']",
    "effective_vision_base_url = str(payload.get('vision_base_url') or effective_base_url).strip()",
    "if effective_vision_base_url:",
    "    vision_cfg['base_url'] = effective_vision_base_url",
    // Keep auxiliary compression context_length in sync with main model
    "comp_cfg = auxiliary_cfg.setdefault('compression', {})",
    "comp_cfg['context_length'] = int(payload['context_length'])",
    "auxiliary_cfg['compression'] = comp_cfg",
    "config['auxiliary'] = auxiliary_cfg",
    "config_path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding='utf-8')",
    "",
    "cache = {}",
    "if cache_path.exists():",
    "    cache = yaml.safe_load(cache_path.read_text(encoding='utf-8')) or {}",
    "",
    "cache_updated = False",
    "if effective_base_url:",
    "    context_lengths = cache.setdefault('context_lengths', {})",
    "    context_lengths[f\"{payload['model']}@{effective_base_url}\"] = int(payload['context_length'])",
    "    cache_path.write_text(yaml.safe_dump(cache, sort_keys=False, allow_unicode=True), encoding='utf-8')",
    "    cache_updated = True",
    "",
    "print('__HERMES_SYNC__' + json.dumps({",
    "    'ok': True,",
    "    'model': payload['model'],",
    "    'context_length': int(payload['context_length']),",
    "    'base_url': effective_base_url,",
    "    'vision_model': vision_cfg.get('model') or '',",
    "    'vision_base_url': vision_cfg.get('base_url') or '',",
    "    'cache_updated': cache_updated,",
    "}))",
    "PY",
    `SERVICE_NAME=${shellQuote(HERMES_SYNC_SERVICE)}`,
    // Trigger the restart without blocking the llm3 request on a slow
    // gateway shutdown. The config rewrite is already complete at this point.
    "systemctl --user restart --no-block \"$SERVICE_NAME\" >/dev/null 2>&1 || true",
    "SERVICE_STATE=$(systemctl --user is-active \"$SERVICE_NAME\" 2>/dev/null || true)",
    "printf '__HERMES_SERVICE__%s__END__\\n' \"$SERVICE_STATE\"",
  ].join("\n");
}

function buildHermesCompactionRemoteScript(payload) {
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

  return [
    "set -euo pipefail",
    `PYTHON_BIN=${shellQuote(HERMES_SYNC_PYTHON)}`,
    `CONFIG_PATH=${shellQuote(HERMES_SYNC_CONFIG_PATH)}`,
    `CACHE_PATH=${shellQuote(HERMES_SYNC_CACHE_PATH)}`,
    `PAYLOAD_BASE64=${shellQuote(payloadBase64)}`,
    "\"$PYTHON_BIN\" - \"$CONFIG_PATH\" \"$CACHE_PATH\" \"$PAYLOAD_BASE64\" <<'PY'",
    "import base64",
    "import json",
    "import pathlib",
    "import sys",
    "import yaml",
    "",
    "config_path = pathlib.Path(sys.argv[1]).expanduser()",
    "cache_path = pathlib.Path(sys.argv[2]).expanduser()",
    "payload = json.loads(base64.b64decode(sys.argv[3]).decode('utf-8'))",
    "",
    "config = {}",
    "if config_path.exists():",
    "    config = yaml.safe_load(config_path.read_text(encoding='utf-8')) or {}",
    "",
    "compression_cfg = config.setdefault('compression', {})",
    "compression_cfg['enabled'] = True",
    "if not isinstance(compression_cfg.get('threshold'), (int, float)):",
    "    compression_cfg['threshold'] = 0.50",
    "compression_cfg['target_ratio'] = 0.75",
    "auxiliary_cfg = config.setdefault('auxiliary', {})",
    "comp_cfg = auxiliary_cfg.setdefault('compression', {})",
    "comp_cfg['provider'] = 'auto'",
    "comp_cfg['api_key'] = str(payload.get('api_key') or comp_cfg.get('api_key') or 'api')",
    "comp_cfg['model'] = str(payload['model'])",
    "comp_cfg['base_url'] = str(payload['base_url'])",
    "comp_cfg.pop('context_length', None)",
    "config_path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding='utf-8')",
    "",
    "cache = {}",
    "if cache_path.exists():",
    "    cache = yaml.safe_load(cache_path.read_text(encoding='utf-8')) or {}",
    "context_lengths = cache.setdefault('context_lengths', {})",
    "context_lengths[f\"{payload['model']}@{payload['base_url']}\"] = int(payload['context_length'])",
    "cache_path.write_text(yaml.safe_dump(cache, sort_keys=False, allow_unicode=True), encoding='utf-8')",
    "",
    "print('__HERMES_SYNC__' + json.dumps({",
    "    'ok': True,",
    "    'model': payload['model'],",
    "    'context_length': int(payload['context_length']),",
    "    'base_url': payload['base_url'],",
    "    'cache_updated': True,",
    "}))",
    "PY",
    `SERVICE_NAME=${shellQuote(HERMES_SYNC_SERVICE)}`,
    "systemctl --user restart --no-block \"$SERVICE_NAME\" >/dev/null 2>&1 || true",
    "SERVICE_STATE=$(systemctl --user is-active \"$SERVICE_NAME\" 2>/dev/null || true)",
    "printf '__HERMES_SERVICE__%s__END__\\n' \"$SERVICE_STATE\"",
  ].join("\n");
}

function buildHermesCompactionResetRemoteScript(payload) {
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

  return [
    "set -euo pipefail",
    `PYTHON_BIN=${shellQuote(HERMES_SYNC_PYTHON)}`,
    `CONFIG_PATH=${shellQuote(HERMES_SYNC_CONFIG_PATH)}`,
    `CACHE_PATH=${shellQuote(HERMES_SYNC_CACHE_PATH)}`,
    `PAYLOAD_BASE64=${shellQuote(payloadBase64)}`,
    "\"$PYTHON_BIN\" - \"$CONFIG_PATH\" \"$CACHE_PATH\" \"$PAYLOAD_BASE64\" <<'PY'",
    "import base64",
    "import json",
    "import pathlib",
    "import sys",
    "import yaml",
    "",
    "config_path = pathlib.Path(sys.argv[1]).expanduser()",
    "cache_path = pathlib.Path(sys.argv[2]).expanduser()",
    "payload = json.loads(base64.b64decode(sys.argv[3]).decode('utf-8'))",
    "",
    "config = {}",
    "if config_path.exists():",
    "    config = yaml.safe_load(config_path.read_text(encoding='utf-8')) or {}",
    "",
    "auxiliary_cfg = config.setdefault('auxiliary', {})",
    "comp_cfg = auxiliary_cfg.setdefault('compression', {})",
    "current_model = str(comp_cfg.get('model') or '').strip()",
    "current_base_url = str(comp_cfg.get('base_url') or '').strip()",
    "target_model = str(payload.get('model') or '').strip()",
    "target_base_url = str(payload.get('base_url') or '').strip()",
    "matches = False",
    "if target_base_url and current_base_url:",
    "    matches = current_base_url == target_base_url",
    "elif target_model and current_model:",
    "    matches = current_model == target_model",
    "elif not target_base_url and not target_model:",
    "    matches = bool(current_model or current_base_url)",
    "",
    "cache_updated = False",
    "if matches:",
    "    removed_key = f\"{current_model}@{current_base_url}\" if current_model and current_base_url else ''",
    "    comp_cfg['provider'] = 'auto'",
    "    comp_cfg['api_key'] = ''",
    "    comp_cfg['model'] = ''",
    "    comp_cfg['base_url'] = ''",
    "    comp_cfg.pop('context_length', None)",
    "    config_path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding='utf-8')",
    "    cache = {}",
    "    if cache_path.exists():",
    "        cache = yaml.safe_load(cache_path.read_text(encoding='utf-8')) or {}",
    "    context_lengths = cache.setdefault('context_lengths', {})",
    "    if removed_key and removed_key in context_lengths:",
    "        del context_lengths[removed_key]",
    "        cache_path.write_text(yaml.safe_dump(cache, sort_keys=False, allow_unicode=True), encoding='utf-8')",
    "        cache_updated = True",
    "",
    "print('__HERMES_SYNC__' + json.dumps({",
    "    'ok': True,",
    "    'changed': matches,",
    "    'model': current_model if matches else '',",
    "    'base_url': current_base_url if matches else '',",
    "    'cache_updated': cache_updated,",
    "}))",
    "PY",
    `SERVICE_NAME=${shellQuote(HERMES_SYNC_SERVICE)}`,
    "systemctl --user restart --no-block \"$SERVICE_NAME\" >/dev/null 2>&1 || true",
    "SERVICE_STATE=$(systemctl --user is-active \"$SERVICE_NAME\" 2>/dev/null || true)",
    "printf '__HERMES_SERVICE__%s__END__\\n' \"$SERVICE_STATE\"",
  ].join("\n");
}

function buildHermesRestartRemoteScript() {
  return [
    "set -euo pipefail",
    `SERVICE_NAME=${shellQuote(HERMES_SYNC_SERVICE)}`,
    "systemctl --user restart \"$SERVICE_NAME\"",
    "SERVICE_STATE=$(systemctl --user is-active \"$SERVICE_NAME\")",
    "printf '__HERMES_SERVICE__%s__END__\\n' \"$SERVICE_STATE\"",
  ].join("\n");
}

function buildLibreChatSyncRemoteScript(target) {
  const payloadBase64 = Buffer.from(JSON.stringify(target), "utf8").toString("base64");
  const scriptBody = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "PAYLOAD_BASE64=${1:-}",
    "if [ -z \"$PAYLOAD_BASE64\" ]; then",
    "  echo 'payload missing' >&2",
    "  exit 1",
    "fi",
    `PYTHON_BIN=${shellQuote(HERMES_SYNC_PYTHON)}`,
    `CONFIG_PATH=${shellQuote(LIBRECHAT_SYNC_CONFIG_PATH)}`,
    `ENDPOINT_NAME=${shellQuote(LIBRECHAT_SYNC_ENDPOINT_NAME)}`,
    `CONTAINER_NAME=${shellQuote(LIBRECHAT_SYNC_CONTAINER)}`,
    "\"$PYTHON_BIN\" - \"$CONFIG_PATH\" \"$ENDPOINT_NAME\" \"$PAYLOAD_BASE64\" <<'PY'",
    "import base64",
    "import json",
    "import pathlib",
    "import sys",
    "import yaml",
    "",
    "config_path = pathlib.Path(sys.argv[1]).expanduser()",
    "endpoint_name = sys.argv[2]",
    "payload = json.loads(base64.b64decode(sys.argv[3]).decode('utf-8'))",
    "",
    "config = yaml.safe_load(config_path.read_text(encoding='utf-8')) if config_path.exists() else {}",
    "config = config or {}",
    "endpoints_cfg = config.setdefault('endpoints', {})",
    "custom_endpoints = endpoints_cfg.setdefault('custom', [])",
    "entry = next((item for item in custom_endpoints if str(item.get('name') or '').strip() == endpoint_name), None)",
    "if entry is None:",
    "    entry = {",
    "        'name': endpoint_name,",
    "        'apiKey': 'api',",
    "        'models': {",
    "            'default': [payload['modelId']],",
    "            'fetch': True,",
    "            'register': True,",
    "        },",
    "        'titleConvo': True,",
    "        'titleModel': 'current_model',",
    "        'summarize': False,",
    "        'summaryModel': 'current_model',",
    "        'modelDisplayLabel': endpoint_name,",
    "    }",
    "    custom_endpoints.append(entry)",
    "",
    "entry['apiKey'] = str(entry.get('apiKey') or 'api')",
    "entry['baseURL'] = payload['runtimeBaseUrl']",
    "models_cfg = entry.setdefault('models', {})",
    "models_cfg['default'] = [payload['modelId']]",
    "models_cfg['fetch'] = True",
    "models_cfg['register'] = True",
    "entry['titleConvo'] = True",
    "entry['titleModel'] = 'current_model'",
    "entry['summarize'] = False",
    "entry['summaryModel'] = 'current_model'",
    "entry['modelDisplayLabel'] = str(entry.get('modelDisplayLabel') or endpoint_name)",
    "# vision was hardcoded True here, so a text-only model was still advertised as",
    "# image-capable and LibreChat would happily attach images to it.",
    "entry['vision'] = bool(payload.get('hasVisionTarget'))",
    "if payload.get('hasVisionTarget'):",
    "    entry['vision_model'] = str(payload.get('visionModelId') or payload['modelId'])",
    "    entry['vision_base_url'] = str(payload.get('visionRuntimeBaseUrl') or payload['runtimeBaseUrl'])",
    "",
    "model_specs = config.setdefault('modelSpecs', {})",
    "model_specs.setdefault('prioritize', True)",
    "spec_list = model_specs.setdefault('list', [])",
    "managed_name = f\"llm3-{endpoint_name.lower().replace(' ', '-')}\"",
    "spec = next((item for item in spec_list if str(item.get('name') or '').strip() == managed_name), None)",
    "preset = {",
    "    'endpoint': endpoint_name,",
    "    'model': payload['modelId'],",
    "    'maxContextTokens': int(payload['contextLength']),",
    "}",
    "if spec is None:",
    "    spec = {",
    "        'name': managed_name,",
    "        'label': endpoint_name,",
    "        'description': f\"Managed by llm3 · ctx {int(payload['contextLength'])}\",",
    "        'group': endpoint_name,",
    "        'preset': preset,",
    "    }",
    "    spec_list.append(spec)",
    "else:",
    "    spec['label'] = str(spec.get('label') or endpoint_name)",
    "    spec['group'] = str(spec.get('group') or endpoint_name)",
    "    spec['description'] = f\"Managed by llm3 · ctx {int(payload['contextLength'])}\"",
    "    spec['preset'] = preset",
    "",
    "config_path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding='utf-8')",
    "print('__LIBRECHAT_SYNC__' + json.dumps({",
    "    'ok': True,",
    "    'model': payload['modelId'],",
    "    'base_url': payload['runtimeBaseUrl'],",
    "    'context_length': int(payload['contextLength']),",
    "    'vision': bool(payload.get('hasVisionTarget')),",
    "    'vision_model': str(payload.get('visionModelId') or '') if payload.get('hasVisionTarget') else '',",
    "    'vision_base_url': str(payload.get('visionRuntimeBaseUrl') or '') if payload.get('hasVisionTarget') else '',",
    "    'config_path': str(config_path),",
    "    'endpoint_name': endpoint_name,",
    "}))",
    "PY",
    "CONTAINER_STATE=$(docker restart \"$CONTAINER_NAME\" >/dev/null && docker inspect -f '{{.State.Status}}' \"$CONTAINER_NAME\")",
    "printf '__LIBRECHAT_CONTAINER__%s__END__\\n' \"$CONTAINER_STATE\"",
  ].join("\n");

  return [
    "set -euo pipefail",
    `SCRIPT_PATH=${shellQuote(LIBRECHAT_SYNC_SCRIPT_PATH)}`,
    "mkdir -p \"$(dirname \"$SCRIPT_PATH\")\"",
    `SCRIPT_BASE64=${shellQuote(Buffer.from(scriptBody, "utf8").toString("base64"))}`,
    "printf '%s' \"$SCRIPT_BASE64\" | base64 --decode > \"$SCRIPT_PATH\"",
    "chmod +x \"$SCRIPT_PATH\"",
    `PAYLOAD_BASE64=${shellQuote(payloadBase64)}`,
    "\"$SCRIPT_PATH\" \"$PAYLOAD_BASE64\"",
  ].join("\n");
}

function buildRemoteJsonAppSyncScript(target) {
  // The remote JSON app keeps separate `text` and `vision` entries. The vision fields used
  // not to be sent at all, so the vision entry was always rewritten to the launched
  // model -- pointing image extraction at a text-only model whenever the two differ.
  const payloadBase64 = Buffer.from(JSON.stringify({
    modelId: target.modelId,
    baseUrl: runtimeServerBaseUrl(target.runtimeBaseUrl),
    hasVisionTarget: Boolean(target?.hasVisionTarget),
    visionModelId: String(target?.visionModelId || ""),
    visionBaseUrl: target?.visionRuntimeBaseUrl
      ? runtimeServerBaseUrl(target.visionRuntimeBaseUrl)
      : "",
  }), "utf8").toString("base64");
  const pm2Apps = [REMOTE_JSON_APP_SYNC_PM2_APP, REMOTE_JSON_APP_SYNC_EXTRA_PM2_APP].filter(Boolean);

  return [
    "set -euo pipefail",
    `PYTHON_BIN=${shellQuote(HERMES_SYNC_PYTHON)}`,
    `CONFIG_PATH=${shellQuote(REMOTE_JSON_APP_SYNC_CONFIG_PATH)}`,
    `PAYLOAD_BASE64=${shellQuote(payloadBase64)}`,
    "\"$PYTHON_BIN\" - \"$CONFIG_PATH\" \"$PAYLOAD_BASE64\" <<'PY'",
    "import base64",
    "import json",
    "import pathlib",
    "import sys",
    "",
    "config_path = pathlib.Path(sys.argv[1]).expanduser()",
    "payload = json.loads(base64.b64decode(sys.argv[2]).decode('utf-8'))",
    "config = json.loads(config_path.read_text(encoding='utf-8')) if config_path.exists() else {}",
    "config = config or {}",
    "",
    "def route(key):",
    "    # The vision entry follows whichever slot actually serves images, which may",
    "    # not be the slot being launched. With no vision slot at all, leave the",
    "    # existing vision entry alone rather than repoint it at a text-only model.",
    "    if key != 'vision':",
    "        return payload['modelId'], payload['baseUrl']",
    "    if not payload.get('hasVisionTarget'):",
    "        return None, None",
    "    return (payload.get('visionModelId') or payload['modelId'],",
    "            payload.get('visionBaseUrl') or payload['baseUrl'])",
    "",
    "for key in ('text', 'vision'):",
    "    model_id, base_url = route(key)",
    "    if model_id is None:",
    "        continue",
    "    entry = config.setdefault(key, {})",
    "    entry['provider'] = str(entry.get('provider') or 'openai_compatible')",
    "    entry['base_url'] = base_url",
    "    entry['chat_completions_path'] = str(entry.get('chat_completions_path') or '/v1/chat/completions')",
    "    entry['model'] = model_id",
    "    entry['api_key'] = str(entry.get('api_key') or 'api')",
    "",
    "config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + '\\n', encoding='utf-8')",
    "print('__REMOTE_JSON_APP_SYNC__' + json.dumps({",
    "    'ok': True,",
    "    'model': payload['modelId'],",
    "    'base_url': payload['baseUrl'],",
    "    'config_path': str(config_path),",
    "}))",
    "PY",
    ...pm2Apps.flatMap((appName) => [
      `if pm2 describe ${shellQuote(appName)} >/dev/null 2>&1; then`,
      `  pm2 restart ${shellQuote(appName)} >/dev/null`,
      `  printf '__REMOTE_JSON_APP_PM2__%s__END__\\n' ${shellQuote(appName)}`,
      "fi",
    ]),
  ].join("\n");
}

async function restartHermesService() {
  if (!hasRemoteShellAuth(HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return {
      ok: false,
      error: buildRemoteShellAuthError("Hermes restart", "HERMES_SYNC_PASSWORD", "HERMES_SYNC_SSH_KEY", HERMES_SYNC_SSH_KEY),
    };
  }

  try {
    const output = await runRemoteShell(
      HERMES_SYNC_HOST,
      HERMES_SYNC_USER,
      {
        password: HERMES_SYNC_PASSWORD,
        sshKeyPath: HERMES_SYNC_SSH_KEY,
      },
      buildHermesRestartRemoteScript()
    );
    return {
      ok: true,
      service_state: extractServiceState(output) || null,
      output: String(output || "").trim(),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatExecError(error) || "Hermes restart failed.",
    };
  }
}

async function runRemoteShell(host, user, auth, script) {
  const password = String(auth?.password || "").trim();
  const sshKeyPath = resolveReadableRemoteSshKey(auth?.sshKeyPath || "");
  const remoteCommand = `bash -lc ${shellQuote(script)}`;
  const sshArgs = [
    "-tt",
    // Without this, a host that is off costs the full TCP timeout -- 75 s on
    // macOS -- and every other ssh call site in this file already sets 3-5 s.
    // A slot action fans these out across its synced applications, so the
    // dashboard sat disabled for minutes whenever the remote machine was down.
    "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    ...sshHostKeyArgs(),
  ];
  const destination = `${user}@${host}`;

  const cachedFailure = readUnreachableHostCache(host);
  if (cachedFailure) {
    throw cachedFailure();
  }

  if (sshKeyPath) {
    try {
      const { stdout, stderr } = await execFileAsync(
        "ssh",
        [...sshArgs, "-o", "BatchMode=yes", "-i", sshKeyPath, destination, remoteCommand],
        getExecOptions({ maxBuffer: ACTION_BUFFER, timeout: REMOTE_SHELL_TIMEOUT_MS }),
      );
      clearUnreachableHostCache(host);
      return [stdout, stderr].filter(Boolean).join("\n");
    } catch (error) {
      // error.message repeats the whole command line, script and all. Keep the
      // stderr diagnostic and drop the rest.
      const diagnostic = String(error?.stderr || error?.message || "");
      const unreachable = isRemoteUnreachableTranscript(diagnostic);
      // A password cannot log in to a host that is not answering, so retrying
      // the whole connection under `expect` only doubles the wait.
      if (!password || unreachable) {
        const failure = new Error(summarizeRemoteShellFailure(diagnostic, host));
        failure.remoteUnreachable = unreachable;
        if (unreachable) {
          rememberUnreachableHost(host, failure);
        }
        throw failure;
      }
    }
  }

  if (!password) {
    throw new Error("Remote SSH auth is not configured.");
  }

  const sshCommand = `ssh ${sshArgs.map((value) => shellQuote(value)).join(" ")} ${shellQuote(destination)} ${remoteCommand}`;
  // `expect` exits 0 whenever the pty closes, so ssh's own exit status is lost
  // and a dead host looks like a successful run whose stdout happens to be the
  // echoed script. Print the outcome as a marker instead. No `$?`: this string
  // is substituted by Tcl, which would mangle it.
  const statusReportingCommand =
    `{ ${sshCommand} ; } && printf '${REMOTE_SHELL_OK_MARKER}\\n' || printf '${REMOTE_SHELL_FAIL_MARKER}\\n'`;
  // The script goes on the command line, where `ps` can read it, so the
  // password travels in the environment and expect substitutes it at send time.
  const expectScript = [
    `set timeout ${Math.ceil(REMOTE_SHELL_TIMEOUT_MS / 1000)}`,
    `spawn sh -lc "${escapeTclDoubleQuoted(statusReportingCommand)}"`,
    'expect "password:"',
    'send -- "$env(LLM3_SSH_PASSWORD)\\r"',
    'expect eof',
  ].join("\n");

  const { stdout, stderr } = await execFileAsync("expect", ["-c", expectScript], getExecOptions({
    maxBuffer: ACTION_BUFFER,
    timeout: REMOTE_SHELL_TIMEOUT_MS + 5000,
    env: { LLM3_SSH_PASSWORD: password },
  }));
  const transcript = [stdout, stderr].filter(Boolean).join("\n");
  // Line-anchored, for the same reason extractMarkerPayload is: the pty echoes
  // the whole spawned command, and that command *contains* both markers as
  // printf arguments. Only a marker standing alone on its own line was printed.
  if (!hasMarkerLine(transcript, REMOTE_SHELL_OK_MARKER)) {
    const failure = new Error(summarizeRemoteShellFailure(transcript, host));
    failure.remoteTranscript = transcript;
    failure.remoteUnreachable = isRemoteUnreachableTranscript(transcript);
    if (failure.remoteUnreachable) {
      rememberUnreachableHost(host, failure);
    }
    throw failure;
  }
  clearUnreachableHostCache(host);
  return transcript;
}

// One slot action syncs several applications, and they can point at the same
// remote machine. Once that machine has answered "down", the rest of the fan-out
// must not each pay the connect timeout again. The window is short so a machine
// that comes back is picked up on the next action rather than staying "down".
const UNREACHABLE_HOST_TTL_MS = Number(process.env.LLM3_SSH_UNREACHABLE_TTL_MS || 30_000);
const unreachableHosts = new Map();

function rememberUnreachableHost(host, error) {
  unreachableHosts.set(String(host), { expiresAt: Date.now() + UNREACHABLE_HOST_TTL_MS, message: error.message });
}

function readUnreachableHostCache(host) {
  const entry = unreachableHosts.get(String(host));
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    unreachableHosts.delete(String(host));
    return null;
  }
  return () => {
    const failure = new Error(entry.message);
    failure.remoteUnreachable = true;
    return failure;
  };
}

function clearUnreachableHostCache(host) {
  unreachableHosts.delete(String(host));
}

const REMOTE_SHELL_OK_MARKER = "__LLM3_REMOTE_OK__";
const REMOTE_SHELL_FAIL_MARKER = "__LLM3_REMOTE_FAIL__";
const REMOTE_UNREACHABLE_PATTERN =
  /(connection refused|no route to host|host is down|operation timed out|connection timed out|network is unreachable|could not resolve hostname|name or service not known|connection closed by remote host|broken pipe)/i;

function hasMarkerLine(text, marker) {
  return String(text || "").split(/\r?\n/).some((line) => line.trim() === marker);
}

function isRemoteUnreachableTranscript(text) {
  return REMOTE_UNREACHABLE_PATTERN.test(String(text || ""));
}

// The transcript is the whole pty session, which starts with the echoed
// `spawn sh -lc "ssh ..."` line -- the entire remote script included. Report the
// diagnostic lines ssh printed, not the command that produced them.
function summarizeRemoteShellFailure(transcript, host) {
  const noise = /^(spawn |__LLM3_REMOTE_(?:OK|FAIL)__)/;
  const diagnostics = String(transcript || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !noise.test(line) && /(^ssh:|^Permission denied|denied|timed out|refused|unreachable|not known|closed by)/i.test(line))
    .slice(0, 4);
  if (diagnostics.length) {
    return diagnostics.join("\n");
  }
  return `Remote shell on ${host} failed and printed no diagnostic.`;
}

function expandHomePath(filePath) {
  const trimmed = String(filePath || "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "~") {
    return HOME;
  }
  if (trimmed.startsWith("~/")) {
    return path.join(HOME, trimmed.slice(2));
  }
  return trimmed;
}

function resolveReadableRemoteSshKey(filePath) {
  const expanded = expandHomePath(filePath);
  if (!expanded) {
    return "";
  }
  return fsSync.existsSync(expanded) ? expanded : "";
}

function hasRemoteShellAuth(password, sshKeyPath) {
  return Boolean(String(password || "").trim() || resolveReadableRemoteSshKey(sshKeyPath));
}

function isRemoteSyncEnabled(explicitFlag, password, sshKeyPath) {
  if (explicitFlag != null) {
    return String(explicitFlag) !== "false";
  }
  return hasRemoteShellAuth(password, sshKeyPath);
}

function buildRemoteShellAuthError(label, passwordEnvName, sshKeyEnvName, sshKeyPath = "") {
  const configuredPath = String(sshKeyPath || "").trim();
  const readablePath = resolveReadableRemoteSshKey(configuredPath);
  if (readablePath) {
    return `${label} auth could not fall back after SSH key auth. ${sshKeyEnvName} is readable at ${readablePath}; set ${passwordEnvName} or make sure ${HERMES_SYNC_PASSWORD_FILE} contains only the password if you need password auth.`;
  }
  if (configuredPath) {
    return `${label} auth is not configured. ${sshKeyEnvName} points to ${configuredPath}, but that private key is not readable. Set ${passwordEnvName}, make sure ${HERMES_SYNC_PASSWORD_FILE} contains only the password, or point ${sshKeyEnvName} at a readable private key.`;
  }
  return `${label} auth is not configured. Set ${passwordEnvName}, make sure ${HERMES_SYNC_PASSWORD_FILE} contains only the password, or point ${sshKeyEnvName} at a readable private key.`;
}

function readOptionalSecret(value, fallbackPath = "") {
  const inlineValue = String(value || "").trim();
  if (inlineValue) {
    return inlineValue;
  }
  const resolvedPath = String(fallbackPath || "").trim();
  if (!resolvedPath || !fsSync.existsSync(resolvedPath)) {
    return "";
  }
  try {
    return fsSync.readFileSync(resolvedPath, "utf8").trim();
  } catch (_error) {
    return "";
  }
}

function parseHermesSyncOutput(output) {
  const text = String(output || "");
  const parsed = parseMarkerSyncOutput(text, "__HERMES_SYNC__", "Hermes sync");
  if (!parsed.payload) {
    return parsed;
  }
  const serviceState = extractServiceState(text);
  return {
    ...parsed.payload,
    service_state: serviceState || null,
  };
}

function parseLibreChatSyncOutput(output) {
  const text = String(output || "");
  const parsed = parseMarkerSyncOutput(text, "__LIBRECHAT_SYNC__", "LibreChat sync");
  if (!parsed.payload) {
    return parsed;
  }
  return {
    ...parsed.payload,
    container_state: extractTaggedValue(text, "__LIBRECHAT_CONTAINER__", "__END__") || null,
  };
}

function parseRemoteJsonAppSyncOutput(output) {
  const text = String(output || "");
  const parsed = parseMarkerSyncOutput(text, "__REMOTE_JSON_APP_SYNC__", `${REMOTE_JSON_APP_LABEL} sync`);
  if (!parsed.payload) {
    return parsed;
  }
  const payload = parsed.payload;
  const restartedApps = [...text.matchAll(/__REMOTE_JSON_APP_PM2__(.*?)__END__/g)]
    .map((match) => String(match[1] || "").trim())
    .filter((value) => value && value !== "%s");
  return {
    ...payload,
    restarted_apps: restartedApps,
  };
}

function parseSqliteAppSyncOutput(output) {
  const text = String(output || "");
  const syncPayload = extractMarkerPayload(text, "__SQLITE_APP_SYNC__");
  if (!syncPayload) {
    return {
      ok: false,
      error: `${SQLITE_APP_LABEL} sync did not return a result.`,
      output: text.trim(),
    };
  }

  const payload = JSON.parse(syncPayload);
  const restartedApps = [...text.matchAll(/__SQLITE_APP_PM2__(.*?)__END__/g)]
    .map((match) => String(match[1] || "").trim())
    .filter((value) => value && value !== "%s");
  const missingApps = [...text.matchAll(/__SQLITE_APP_PM2_MISSING__(.*?)__END__/g)]
    .map((match) => String(match[1] || "").trim())
    .filter((value) => value && value !== "%s");

  return {
    ...payload,
    restarted_apps: restartedApps,
    missing_apps: missingApps,
  };
}

// The marker must open its own line. The remote script *contains* the marker as
// python source (`print('__HERMES_SYNC__' + json.dumps({`), and the expect
// fallback echoes that whole script back on the pty, so a plain lastIndexOf
// matched the source line and tried to JSON.parse `'\'' + json.dumps({`.
function extractMarkerPayload(text, marker) {
  const lines = String(text || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trimStart();
    if (line.startsWith(marker)) {
      return line.slice(marker.length).trim();
    }
  }
  return "";
}

// Every sync parser reads one marker line of JSON out of a remote shell
// transcript. A transcript is never trusted input: report a bad payload as a
// failed sync with the transcript attached, never as a raw SyntaxError.
function parseMarkerSyncOutput(output, marker, label) {
  const text = String(output || "");
  const syncPayload = extractMarkerPayload(text, marker);
  if (!syncPayload) {
    return { ok: false, error: `${label} did not return a result.`, output: text.trim() };
  }
  try {
    return { payload: JSON.parse(syncPayload) };
  } catch (_error) {
    return {
      ok: false,
      error: `${label} returned a result that is not JSON.`,
      output: text.trim(),
    };
  }
}

function extractServiceState(text) {
  const matches = [...String(text || "").matchAll(/__HERMES_SERVICE__(.*?)__END__/g)];
  return matches.length ? normalizeServiceState(matches.at(-1)[1]) : "";
}

function extractTaggedValue(text, startMarker, endMarker) {
  const pattern = new RegExp(`${escapeRegExp(startMarker)}(.*?)${escapeRegExp(endMarker)}`, "g");
  const matches = [...String(text || "").matchAll(pattern)];
  return matches.length ? String(matches.at(-1)[1] || "").trim() : "";
}

function escapeTclDoubleQuoted(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\$/g, "\\$")
    .replace(/\[/g, "\\[")
    .replace(/"/g, '\\"');
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

function sqliteQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeServiceState(value) {
  const text = String(value || "").trim().toLowerCase();
  const knownStates = ["active", "inactive", "failed", "activating", "deactivating", "reloading"];
  return knownStates.find((state) => text.startsWith(state)) || text;
}

function formatContextLength(value) {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count <= 0) {
    return "n/a";
  }
  return new Intl.NumberFormat().format(count);
}

async function readIntegrationTargetSlotIds() {
  const config = await readDashboardConfig();
  return { ...config.integrationTargets };
}

async function readIntegrationTargetSlotId(key) {
  const integrationTargets = await readIntegrationTargetSlotIds();
  return integrationTargets[key] || SLOT_DEFINITIONS[0]?.id || "slot1";
}

function runtimeServerBaseUrl(runtimeBaseUrl) {
  const trimmed = String(runtimeBaseUrl || "").trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

async function readSlotRuntimeBaseUrl(slotId) {
  const slot = getSlotDefinition(slotId);
  if (!slot) {
    throw new Error(`Unknown slot: ${slotId}`);
  }
  const config = await readDashboardConfig();
  return getSlotRuntimeBaseUrl(slot, config);
}

async function writeSlotRuntimeBaseUrl(slotId, runtimeBaseUrl) {
  const slot = getSlotDefinition(slotId);
  if (!slot) {
    throw new Error(`Unknown slot: ${slotId}`);
  }
  const trimmed = String(runtimeBaseUrl || "").trim();
  await updateDashboardConfig((config) => {
    if (!config.slotRuntimeBaseUrls) {
      config.slotRuntimeBaseUrls = {};
    }
    if (trimmed) {
      config.slotRuntimeBaseUrls[slot.id] = trimmed;
    } else {
      delete config.slotRuntimeBaseUrls[slot.id];
    }
    return config;
  });
}

function getSlotRuntimeBaseUrl(slot, config = null) {
  const override = config?.slotRuntimeBaseUrls?.[slot.id];
  return String(override || slot.localRuntimeBaseUrl).trim();
}

function normalizeVoiceTtsModelKey(modelOrKey) {
  const raw = typeof modelOrKey === "string" ? modelOrKey : modelOrKey?.key;
  return String(raw || "").trim().split("/").pop().toLowerCase();
}

function voiceModelSupportsTuning(modelOrKey) {
  const normalized = normalizeVoiceTtsModelKey(modelOrKey);
  return VOICE_TTS_TUNING_MODEL_KEYS.has(normalized);
}

function getVoiceTtsTuningDefaults(modelOrKey) {
  if (!voiceModelSupportsTuning(modelOrKey)) {
    return {};
  }
  return Object.fromEntries(
    VOICE_TTS_TUNING_FIELDS.map((entry) => [entry.field, entry.defaultValue])
  );
}

function normalizeVoiceTtsTuningParams(source = {}, modelOrKey = "") {
  if (!voiceModelSupportsTuning(modelOrKey)) {
    return {};
  }
  const defaults = getVoiceTtsTuningDefaults(modelOrKey);
  return Object.fromEntries(
    VOICE_TTS_TUNING_FIELDS.map((entry) => {
      const numeric = Number(source?.[entry.field]);
      const fallback = Number(defaults[entry.field]);
      const rawValue = Number.isFinite(numeric) ? numeric : fallback;
      const clamped = Math.max(entry.min, Math.min(entry.max, rawValue));
      return [entry.field, clamped];
    })
  );
}

function resolveVoiceRuntimeParams(slot, model, requestBody = {}, fallback = {}) {
  const defaultSampleRate = slot?.type === "stt" ? 16000 : 24000;
  const fallbackConfig = String(fallback?.modelKey || "").trim() === String(model?.key || "").trim()
    ? fallback
    : {};
  const requestedSampleRate = Number(requestBody?.sampleRate);
  const fallbackSampleRate = Number(fallbackConfig?.sampleRate);
  const params = {
    voiceName: String(requestBody?.voiceName ?? fallbackConfig?.voiceName ?? "").trim(),
    audioFormat: String(requestBody?.audioFormat ?? fallbackConfig?.audioFormat ?? "wav").trim() || "wav",
    sampleRate: Number.isInteger(requestedSampleRate) && requestedSampleRate > 0
      ? requestedSampleRate
      : (Number.isInteger(fallbackSampleRate) && fallbackSampleRate > 0 ? fallbackSampleRate : defaultSampleRate),
  };
  if (voiceModelSupportsTuning(model)) {
    params.tuning = normalizeVoiceTtsTuningParams({
      exaggeration: requestBody?.exaggeration ?? fallbackConfig?.exaggeration,
      cfgWeight: requestBody?.cfgWeight ?? fallbackConfig?.cfgWeight,
      temperature: requestBody?.temperature ?? fallbackConfig?.temperature,
      repetitionPenalty: requestBody?.repetitionPenalty ?? fallbackConfig?.repetitionPenalty,
      minP: requestBody?.minP ?? fallbackConfig?.minP,
      topP: requestBody?.topP ?? fallbackConfig?.topP,
      ttsChunkSize: requestBody?.ttsChunkSize ?? fallbackConfig?.ttsChunkSize,
    }, model);
  } else {
    params.tuning = {};
  }
  return params;
}

function appendVoiceTuningCliArgs(args, model, tuning = {}) {
  if (!voiceModelSupportsTuning(model)) {
    return args;
  }
  const normalized = normalizeVoiceTtsTuningParams(tuning, model);
  for (const entry of VOICE_TTS_TUNING_FIELDS) {
    if (entry.cliFlag && Number.isFinite(normalized[entry.field])) {
      args.push(entry.cliFlag, String(normalized[entry.field]));
    }
  }
  return args;
}

function buildVoiceTtsRuntimePayload(model, tuning = {}) {
  if (!voiceModelSupportsTuning(model)) {
    return {};
  }
  const normalized = normalizeVoiceTtsTuningParams(tuning, model);
  return {
    exaggeration: normalized.exaggeration,
    cfg_weight: normalized.cfgWeight,
    temperature: normalized.temperature,
    repetition_penalty: normalized.repetitionPenalty,
    min_p: normalized.minP,
    top_p: normalized.topP,
    seed: normalized.seed,
  };
}

function buildDefaultProfileSlotConfig(slotId) {
  return {
    slotId,
    enabled: false,
    modelKey: "",
    ctxSize: 255000,
    parallel: 1,
    thinking: false,
    reasoningBudget: null,
    enableDry: false,
    mtpDraftMax: null,
    ubatchSize: null,
    enableTinyGrammar: false,
    enableStructuredGbnf: false,
    temperature: LAUNCH_SAMPLING_DEFAULTS.temperature,
    topP: LAUNCH_SAMPLING_DEFAULTS.topP,
    topK: LAUNCH_SAMPLING_DEFAULTS.topK,
    minP: LAUNCH_SAMPLING_DEFAULTS.minP,
    presencePenalty: LAUNCH_SAMPLING_DEFAULTS.presencePenalty,
    repetitionPenalty: LAUNCH_SAMPLING_DEFAULTS.repetitionPenalty,
    runtimeBaseUrl: "",
    name: "",
    setHermes: false,
    setHermesM4: false,
    setCompaction: false,
    setCompactionM4: false,
    setRemoteJsonApp: false,
    setSqliteApp: false,
    setLibreChat: false,
    setClaudeCode: false,
    setVoiceApp: false,
    setPodcastG: false,
    setPodGAutoGen: false,
    setHermesPc: false,
    setOpenCodePc: false,
    setOmpPc: false,
    setPiPc: false,
    setOpenClaude: false,
    setChat: false,
  };
}

function buildDefaultProfileVoiceSlotConfig(slotId) {
  const slot = getVoiceSlotDefinition(slotId);
  const type = slot?.type === "stt" ? "stt" : "tts";
  return {
    slotId: slot?.id || slotId,
    type,
    enabled: false,
    modelKey: "",
    voiceSlotId: slot?.id || slotId,
    voiceName: "",
    audioFormat: "pcm16",
    sampleRate: type === "tts" ? 24000 : 16000,
    runtimeBaseUrl: "",
    setHermes: false,
    setHermesM4: false,
    ...(type === "tts" ? getVoiceTtsTuningDefaults("chatterbox-multilingual") : {}),
  };
}

function buildDefaultProfileSlots() {
  return Object.fromEntries(
    SLOT_DEFINITIONS.map((slot) => [slot.id, buildDefaultProfileSlotConfig(slot.id)])
  );
}

function buildDefaultProfileVoiceSlots() {
  return Object.fromEntries(
    VOICE_SLOT_DEFINITIONS.map((slot) => [slot.id, buildDefaultProfileVoiceSlotConfig(slot.id)])
  );
}

function normalizeProfileSlotConfig(slotId, value) {
  const fallback = buildDefaultProfileSlotConfig(slotId);
  const modelKey = String(value?.modelKey || "").trim();
  const ctxSize = Number(value?.ctxSize || fallback.ctxSize);
  const parallel = Number(value?.parallel || fallback.parallel);
  const enabled = Boolean(value?.enabled) && Boolean(modelKey);
  const launcher = String(value?.launcher || "").trim();
  const temperature = Number(value?.temperature);
  const topP = Number(value?.topP);
  const topK = Number(value?.topK);
  const minP = Number(value?.minP);
  const presencePenalty = Number(value?.presencePenalty);
  const repetitionPenalty = Number(value?.repetitionPenalty);
  const enableStructuredGbnf = Boolean(value?.enableStructuredGbnf);
  return {
    slotId,
    enabled,
    modelKey: enabled ? modelKey : "",
    ctxSize: Number.isInteger(ctxSize) && ctxSize > 0 ? ctxSize : fallback.ctxSize,
    parallel: Number.isInteger(parallel) && parallel > 0 ? parallel : fallback.parallel,
    thinking: Boolean(value?.thinking),
    reasoningBudget: Number.isInteger(Number.parseInt(String(value?.reasoningBudget ?? ""), 10))
      && Number.parseInt(String(value?.reasoningBudget ?? ""), 10) >= -1
      ? Number.parseInt(String(value?.reasoningBudget ?? ""), 10)
      : null,
    enableDry: Boolean(value?.enableDry),
    mtpDraftMax: Number.isInteger(Number.parseInt(String(value?.mtpDraftMax ?? ""), 10))
      && Number.parseInt(String(value?.mtpDraftMax ?? ""), 10) >= 1
      ? Number.parseInt(String(value?.mtpDraftMax ?? ""), 10)
      : null,
    ubatchSize: Number.isInteger(Number.parseInt(String(value?.ubatchSize ?? ""), 10))
      && Number.parseInt(String(value?.ubatchSize ?? ""), 10) >= 1
      ? Number.parseInt(String(value?.ubatchSize ?? ""), 10)
      : null,
    enableTinyGrammar: Boolean(value?.enableTinyGrammar) && !enableStructuredGbnf,
    enableStructuredGbnf,
    launcher,
    temperature: Number.isFinite(temperature) ? temperature : fallback.temperature,
    topP: Number.isFinite(topP) ? topP : fallback.topP,
    topK: Number.isInteger(topK) && topK >= 0 ? topK : fallback.topK,
    minP: Number.isFinite(minP) ? minP : fallback.minP,
    presencePenalty: Number.isFinite(presencePenalty) ? presencePenalty : fallback.presencePenalty,
    repetitionPenalty: Number.isFinite(repetitionPenalty) && repetitionPenalty > 0
      ? repetitionPenalty
      : fallback.repetitionPenalty,
    runtimeBaseUrl: String(value?.runtimeBaseUrl || "").trim(),
    name: normalizeSlotName(value?.name),
    setHermes: Boolean(value?.setHermes),
    setHermesM4: Boolean(value?.setHermesM4),
    setCompaction: Boolean(value?.setCompaction),
    setCompactionM4: Boolean(value?.setCompactionM4),
    setRemoteJsonApp: Boolean(value?.setRemoteJsonApp),
    setSqliteApp: Boolean(value?.setSqliteApp),
    setLibreChat: Boolean(value?.setLibreChat ?? value?.setChat),
    setClaudeCode: Boolean(value?.setClaudeCode ?? value?.setOpenClaude),
    setVoiceApp: Boolean(value?.setVoiceApp),
    setPodcastG: Boolean(value?.setPodcastG),
    setPodGAutoGen: Boolean(value?.setPodGAutoGen),
    setHermesPc: Boolean(value?.setHermesPc),
    setOpenCodePc: Boolean(value?.setOpenCodePc),
    setOmpPc: Boolean(value?.setOmpPc),
    setPiPc: Boolean(value?.setPiPc),
    setOpenClaude: Boolean(value?.setClaudeCode ?? value?.setOpenClaude),
    setChat: Boolean(value?.setLibreChat ?? value?.setChat),
  };
}

// A slot name is not part of the launch settings the profile editor round-trips,
// so a payload that omits `name` means "leave it alone", not "clear it". Saving
// a profile used to wipe every name the user had given the slots.
function carryForwardSlotNames(slots, existingProfile) {
  if (!existingProfile) {
    return slots;
  }
  const merged = { ...(slots || {}) };
  for (const slot of SLOT_DEFINITIONS) {
    const incoming = merged[slot.id];
    if (incoming && Object.prototype.hasOwnProperty.call(incoming, "name")) {
      continue;
    }
    const kept = normalizeSlotName(existingProfile.slots?.[slot.id]?.name);
    if (kept) {
      merged[slot.id] = { ...(incoming || {}), name: kept };
    }
  }
  return merged;
}

function normalizeProfileSlots(slots) {
  const normalized = buildDefaultProfileSlots();
  for (const slot of SLOT_DEFINITIONS) {
    normalized[slot.id] = normalizeProfileSlotConfig(slot.id, slots?.[slot.id]);
  }
  return normalized;
}

function normalizeProfileVoiceSlotConfig(slotId, value) {
  const fallback = buildDefaultProfileVoiceSlotConfig(slotId);
  const slot = getVoiceSlotDefinition(slotId) || getVoiceSlotDefinition(value?.voiceSlotId) || null;
  const modelKey = String(value?.modelKey || "").trim();
  const enabled = Boolean(value?.enabled) && Boolean(modelKey);
  const sampleRate = Number(value?.sampleRate || fallback.sampleRate);
  const tuning = slot?.type === "tts"
    ? normalizeVoiceTtsTuningParams({
      exaggeration: value?.exaggeration,
      cfgWeight: value?.cfgWeight,
      temperature: value?.temperature,
      repetitionPenalty: value?.repetitionPenalty,
      minP: value?.minP,
      topP: value?.topP,
      ttsChunkSize: value?.ttsChunkSize,
    }, modelKey || "chatterbox-multilingual")
    : {};
  return {
    slotId: slot?.id || fallback.slotId,
    type: slot?.type || fallback.type,
    enabled,
    modelKey: enabled ? modelKey : "",
    voiceSlotId: slot?.id || fallback.voiceSlotId,
    voiceName: String(value?.voiceName || "").trim(),
    audioFormat: String(value?.audioFormat || fallback.audioFormat).trim() || fallback.audioFormat,
    sampleRate: Number.isInteger(sampleRate) && sampleRate > 0 ? sampleRate : fallback.sampleRate,
    runtimeBaseUrl: String(value?.runtimeBaseUrl || "").trim(),
    setHermes: Boolean(value?.setHermes),
    setHermesM4: Boolean(value?.setHermesM4),
    ...tuning,
  };
}

function normalizeProfileVoiceSlots(slots) {
  const normalized = buildDefaultProfileVoiceSlots();
  for (const slot of VOICE_SLOT_DEFINITIONS) {
    normalized[slot.id] = normalizeProfileVoiceSlotConfig(slot.id, slots?.[slot.id]);
  }
  return normalized;
}

function normalizeDashboardProfiles(profiles) {
  const seenIds = new Set();
  const normalized = [];
  for (const rawProfile of Array.isArray(profiles) ? profiles : []) {
    const name = String(rawProfile?.name || "").trim();
    if (!name) {
      continue;
    }
    const id = String(rawProfile?.id || "").trim() || randomUUID();
    if (seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    normalized.push({
      id,
      name,
      color: normalizeDashboardHexColor(rawProfile?.color),
      slots: normalizeProfileSlots(rawProfile?.slots),
      voiceSlots: normalizeProfileVoiceSlots(rawProfile?.voiceSlots),
      updatedAt: String(rawProfile?.updatedAt || "").trim() || new Date().toISOString(),
    });
  }
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

// Slot names are free text the user types over the built-in "1st LLM" labels.
// Cap the length so one long name cannot break the slot strip layout.
const SLOT_NAME_MAX_LENGTH = 40;

function normalizeSlotName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, SLOT_NAME_MAX_LENGTH);
}

function normalizeSlotNames(value) {
  const normalized = {};
  for (const [slotId, name] of Object.entries(value || {})) {
    if (!getSlotDefinition(slotId)) {
      continue;
    }
    const trimmed = normalizeSlotName(name);
    if (trimmed) {
      normalized[slotId] = trimmed;
    }
  }
  return normalized;
}

// A name saved inside the applied profile wins over the global one, so switching
// profiles renames the slots with them. With no profile applied there is only
// the global map.
function resolveSlotName(slot, dashboardConfig) {
  const activeProfile = getDashboardProfile(dashboardConfig?.profiles, dashboardConfig?.activeProfileId);
  const profileName = normalizeSlotName(activeProfile?.slots?.[slot.id]?.name);
  if (profileName) {
    return profileName;
  }
  return normalizeSlotName(dashboardConfig?.slotNames?.[slot.id]) || slot.label;
}

function normalizeDashboardHexColor(value) {
  const match = String(value || "").trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toLowerCase()}` : "";
}

function getDashboardProfile(profiles, profileId) {
  const targetId = String(profileId || "").trim();
  if (!targetId) {
    return null;
  }
  return (Array.isArray(profiles) ? profiles : []).find((profile) => profile.id === targetId) || null;
}

async function readActiveProfileVoiceSlotConfig(slotId) {
  const dashboardConfig = await readDashboardConfig();
  const profiles = Array.isArray(dashboardConfig.profiles) ? dashboardConfig.profiles : [];
  const activeProfile = getDashboardProfile(
    profiles,
    dashboardConfig.activeProfileId || dashboardConfig.defaultProfileId || "",
  );
  return normalizeProfileVoiceSlotConfig(slotId, activeProfile?.voiceSlots?.[slotId]);
}

async function persistActiveProfileVoiceSelection(voiceSlot, voiceModel, params = {}) {
  const dashboardConfig = await readDashboardConfig();
  const profiles = Array.isArray(dashboardConfig.profiles) ? dashboardConfig.profiles : [];
  const activeProfile = getDashboardProfile(
    profiles,
    dashboardConfig.activeProfileId || dashboardConfig.defaultProfileId || "",
  );
  if (!activeProfile) {
    return dashboardConfig;
  }

  const nextVoiceSlots = normalizeProfileVoiceSlots({
    ...(activeProfile.voiceSlots || {}),
    [voiceSlot.id]: {
      ...(activeProfile.voiceSlots?.[voiceSlot.id] || {}),
      slotId: voiceSlot.id,
      type: voiceSlot.type,
      enabled: true,
      modelKey: voiceModel.key,
      voiceSlotId: voiceSlot.id,
      voiceName: String(params.voiceName || "").trim(),
      audioFormat: String(params.audioFormat || "pcm16").trim() || "pcm16",
      sampleRate: Number(params.sampleRate || 0) || (voiceSlot.type === "tts" ? 24000 : 16000),
      ...(voiceSlot.type === "tts" ? normalizeVoiceTtsTuningParams(params.tuning || params, voiceModel) : {}),
    },
  });

  const nextProfiles = profiles.map((profile) => (
    profile.id === activeProfile.id
      ? {
          ...profile,
          voiceSlots: nextVoiceSlots,
          updatedAt: new Date().toISOString(),
        }
      : profile
  ));

  await writeDashboardConfig({
    ...dashboardConfig,
    profiles: nextProfiles,
    activeProfileId: activeProfile.id,
  });
  return readDashboardConfig();
}

function buildRequestedApplicationTargetsFromProfileSlot(slotConfig) {
  return {
    hermes: Boolean(slotConfig?.setHermes),
    hermesm4: Boolean(slotConfig?.setHermesM4),
    compaction: Boolean(slotConfig?.setCompaction),
    compactionm4: Boolean(slotConfig?.setCompactionM4),
    remotejsonapp: Boolean(slotConfig?.setRemoteJsonApp),
    sqliteapp: Boolean(slotConfig?.setSqliteApp),
    librechat: Boolean(slotConfig?.setLibreChat ?? slotConfig?.setChat),
    claudecode: Boolean(slotConfig?.setClaudeCode ?? slotConfig?.setOpenClaude),
    voiceapp: Boolean(slotConfig?.setVoiceApp),
    podcastg: Boolean(slotConfig?.setPodcastG),
    podgag: Boolean(slotConfig?.setPodGAutoGen),
    hermespc: Boolean(slotConfig?.setHermesPc),
    opencodepc: Boolean(slotConfig?.setOpenCodePc),
    omppc: Boolean(slotConfig?.setOmpPc),
    pipc: Boolean(slotConfig?.setPiPc),
  };
}

async function readDashboardConfig() {
  const fallback = {
    applicationTargets: buildDefaultApplicationTargets(),
    integrationTargets: buildDefaultIntegrationTargets(),
    slotRuntimeBaseUrls: {},
    voiceRuntimeBaseUrls: {},
    profiles: [],
    defaultProfileId: "",
    activeProfileId: "",
    preferredLaunchers: {},
    chatTemplates: {},
    usedModelKeys: [],
    modelApplicationPreferences: {},
    slotApplicationPreferences: {},
    slotNames: {},
  };
  await fs.mkdir(SLOT_STATE_DIR, { recursive: true });
  try {
    const payload = JSON.parse(await fs.readFile(DASHBOARD_CONFIG_PATH, "utf8"));
    const slotRuntimeBaseUrls = {};
    for (const [currentSlotId, currentUrl] of Object.entries(payload?.slotRuntimeBaseUrls || {})) {
      if (!getSlotDefinition(currentSlotId)) {
        continue;
      }
      const trimmed = String(currentUrl || "").trim();
      if (trimmed) {
        slotRuntimeBaseUrls[currentSlotId] = trimmed;
      }
    }
    const applicationTargets = normalizeApplicationTargets(
      payload?.applicationTargets || integrationTargetsToApplicationTargets(
        payload?.integrationTargets || {
          hermes: payload?.syncTargetSlotId,
          openclaude: payload?.syncTargetSlotId,
          chat: payload?.syncTargetSlotId,
        }
      )
    );
    const integrationTargets = applicationTargetsToIntegrationTargets(applicationTargets);
    const voiceRuntimeBaseUrls = {};
    for (const [currentSlotId, currentUrl] of Object.entries(payload?.voiceRuntimeBaseUrls || {})) {
      if (!getVoiceSlotDefinition(currentSlotId)) {
        continue;
      }
      const trimmed = String(currentUrl || "").trim();
      if (trimmed) {
        voiceRuntimeBaseUrls[currentSlotId] = trimmed;
      }
    }
    const profiles = normalizeDashboardProfiles(payload?.profiles);
    const defaultProfileId = getDashboardProfile(profiles, payload?.defaultProfileId)?.id || "";
    const activeProfileId = getDashboardProfile(profiles, payload?.activeProfileId)?.id || "";
    const preferredLaunchers = normalizePreferredLaunchers(payload?.preferredLaunchers);
    const chatTemplates = normalizeChatTemplateSelections(payload?.chatTemplates);
    const usedModelKeys = normalizeUsedModelKeys(payload?.usedModelKeys);
    const modelApplicationPreferences = normalizeModelApplicationPreferences(payload?.modelApplicationPreferences);
    const slotApplicationPreferences = normalizeSlotApplicationPreferences(payload?.slotApplicationPreferences);
    const slotNames = normalizeSlotNames(payload?.slotNames);
    return { applicationTargets, integrationTargets, slotRuntimeBaseUrls, voiceRuntimeBaseUrls, profiles, defaultProfileId, activeProfileId, preferredLaunchers, chatTemplates, usedModelKeys, modelApplicationPreferences, slotApplicationPreferences, slotNames };
  } catch (_error) {
    try {
      const legacyPayload = JSON.parse(await fs.readFile(LEGACY_SYNC_TARGET_PATH, "utf8"));
      const slotId = String(legacyPayload?.slotId || "").trim();
      if (getSlotDefinition(slotId)) {
        fallback.applicationTargets = buildDefaultApplicationTargets(slotId);
        fallback.integrationTargets = buildDefaultIntegrationTargets(slotId);
      }
    } catch (_legacyError) {
      // Ignore missing legacy state.
    }
    return fallback;
  }
}

async function writeDashboardConfig(config) {
  await dashboardConfigQueue.run(() => writeDashboardConfigUnlocked(config));
}

async function writeDashboardConfigUnlocked(config) {
  const applicationTargets = normalizeApplicationTargets(
    config?.applicationTargets || integrationTargetsToApplicationTargets(config?.integrationTargets)
  );
  const integrationTargets = applicationTargetsToIntegrationTargets(applicationTargets);
  const profiles = normalizeDashboardProfiles(config?.profiles);
  const defaultProfileId = getDashboardProfile(profiles, config?.defaultProfileId)?.id || "";
  const activeProfileId = getDashboardProfile(profiles, config?.activeProfileId)?.id || "";
  const preferredLaunchers = normalizePreferredLaunchers(config?.preferredLaunchers);
  const chatTemplates = normalizeChatTemplateSelections(config?.chatTemplates);
  const usedModelKeys = normalizeUsedModelKeys(config?.usedModelKeys);
  const modelApplicationPreferences = normalizeModelApplicationPreferences(config?.modelApplicationPreferences);
  const slotApplicationPreferences = normalizeSlotApplicationPreferences(config?.slotApplicationPreferences);
  const payload = {
    applicationTargets,
    integrationTargets,
    slotRuntimeBaseUrls: Object.fromEntries(
      Object.entries(config?.slotRuntimeBaseUrls || {}).filter(([slotId, url]) => {
        return Boolean(getSlotDefinition(slotId) && String(url || "").trim());
      })
    ),
    voiceRuntimeBaseUrls: Object.fromEntries(
      Object.entries(config?.voiceRuntimeBaseUrls || {}).filter(([slotId, url]) => {
        return Boolean(getVoiceSlotDefinition(slotId) && String(url || "").trim());
      })
    ),
    profiles,
    defaultProfileId,
    activeProfileId,
    preferredLaunchers,
    chatTemplates,
    usedModelKeys,
    modelApplicationPreferences,
    slotApplicationPreferences,
    slotNames: normalizeSlotNames(config?.slotNames),
  };
  await fs.mkdir(SLOT_STATE_DIR, { recursive: true });
  await writeJsonAtomic(DASHBOARD_CONFIG_PATH, payload);
  await writeJsonAtomic(LEGACY_SYNC_TARGET_PATH, { slotId: payload.integrationTargets.openclaude });
  clearOverviewCache();
}

// Write to a sibling temp file and rename it into place, so a crash mid-write
// leaves the previous file intact instead of a truncated JSON document.
async function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

// One asynchronous critical section for dashboard-config.json. Every writer
// goes through it, and updateDashboardConfig() holds it across the
// read-modify-write, so two concurrent requests cannot lose each other's
// change.
const dashboardConfigQueue = {
  tail: Promise.resolve(),
  run(task) {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  },
};

// Read the config, apply `mutator`, and write the result under the lock. The
// mutator returns the next config, or null/undefined to leave it unchanged.
// Resolves with the config that is now on disk.
async function updateDashboardConfig(mutator) {
  return dashboardConfigQueue.run(async () => {
    const current = await readDashboardConfig();
    const next = await mutator(current);
    if (next === null || next === undefined) {
      return current;
    }
    await writeDashboardConfigUnlocked(next);
    return next;
  });
}

// Only "model-default" or a live catalog key survives a reload; a stale key
// from a removed catalog entry falls back to the preferred template.
function normalizeChatTemplateSelections(value) {
  const valid = new Set([CHAT_TEMPLATE_DEFAULT_KEY, ...CHAT_TEMPLATE_CATALOG.map((entry) => entry.key)]);
  return Object.fromEntries(
    Object.entries(value && typeof value === "object" ? value : {})
      .map(([modelKey, templateKey]) => [String(modelKey || "").trim(), String(templateKey || "").trim()])
      .filter(([modelKey, templateKey]) => modelKey && valid.has(templateKey))
  );
}

function normalizeUsedModelKeys(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))].sort();
}

function normalizePreferredLaunchers(value) {
  const normalized = {};
  for (const [modelKey, launcher] of Object.entries(value || {})) {
    const key = String(modelKey || "").trim();
    const selectedLauncher = String(launcher || "").trim();
    if (key && selectedLauncher) {
      normalized[key] = selectedLauncher;
    }
  }
  return normalized;
}

function normalizeApplicationFlagSet(value) {
  const normalized = {};
  for (const key of getLaunchableApplicationKeys()) {
    normalized[key] = Boolean(value?.[key]);
  }
  return normalized;
}

function normalizeModelApplicationPreferences(value) {
  const normalized = {};
  for (const [modelKey, flags] of Object.entries(value || {})) {
    const key = String(modelKey || "").trim();
    if (!key || !flags || typeof flags !== "object") {
      continue;
    }
    normalized[key] = normalizeApplicationFlagSet(flags);
  }
  return normalized;
}

function normalizeSlotApplicationPreferences(value) {
  const normalized = {};
  for (const [slotId, flags] of Object.entries(value || {})) {
    if (!getSlotDefinition(slotId) || !flags || typeof flags !== "object") {
      continue;
    }
    normalized[slotId] = normalizeApplicationFlagSet(flags);
  }
  return normalized;
}

// Inverse of buildRequestedApplicationTargetsFromProfileSlot: maps an appKey flag set
// back into the setX fields a profile slot config understands.
function applicationFlagSetToProfileSlotFields(flags) {
  return {
    setHermes: Boolean(flags?.hermes),
    setHermesM4: Boolean(flags?.hermesm4),
    setCompaction: Boolean(flags?.compaction),
    setRemoteJsonApp: Boolean(flags?.remotejsonapp),
    setSqliteApp: Boolean(flags?.sqliteapp),
    setLibreChat: Boolean(flags?.librechat),
    setClaudeCode: Boolean(flags?.claudecode),
    setVoiceApp: Boolean(flags?.voiceapp),
    setPodcastG: Boolean(flags?.podcastg),
    setPodGAutoGen: Boolean(flags?.podgag),
    setHermesPc: Boolean(flags?.hermespc),
    setOpenCodePc: Boolean(flags?.opencodepc),
    setOmpPc: Boolean(flags?.omppc),
    setPiPc: Boolean(flags?.pipc),
  };
}

function applyPreferredLaunchers(models, dashboardConfig) {
  const preferredLaunchers = dashboardConfig?.preferredLaunchers || {};
  return (Array.isArray(models) ? models : []).map((model) => ({
    ...model,
    preferredLauncher: preferredLaunchers[model.key] || "",
  }));
}

async function markModelUsed(model) {
  const key = String(model?.key || "").trim();
  if (!key) {
    return;
  }
  await updateDashboardConfig((dashboardConfig) => {
    if (dashboardConfig.usedModelKeys.includes(key)) {
      return null;
    }
    return {
      ...dashboardConfig,
      usedModelKeys: [...dashboardConfig.usedModelKeys, key],
    };
  });
}

function readJsonFromUrl(url) {
  return new Promise((resolve) => {
    let timeoutId;
    const request = http.get(url, { timeout: 3000 }, (response) => {
      clearTimeout(timeoutId);
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 256 * 1024) {
          request.destroy();
          resolve(null);
        }
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (_error) {
          resolve(null);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => {
      clearTimeout(timeoutId);
      resolve(null);
    });
    
    // Safety timeout in case socket timeout doesn't fire
    timeoutId = setTimeout(() => {
      request.destroy();
      resolve(null);
    }, 5000);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PM2_LOG_DIR = expandHomePath(process.env.LLM3_PM2_LOG_DIR || path.join(HOME, ".pm2", "logs"));
const PM2_APP_NAME = String(process.env.LLM3_PM2_APP_NAME || "llm3").trim();
const LLM3_LOG_TAIL_BYTES = 192 * 1024;
const LLM3_LOG_MAX_LINES = 4000;

function llm3LogSources() {
  return [
    { label: "llm3", path: SERVER_LOG_PATH },
    { label: "stderr", path: path.join(PM2_LOG_DIR, `${PM2_APP_NAME}-error.log`) },
    { label: "stdout", path: path.join(PM2_LOG_DIR, `${PM2_APP_NAME}-out.log`) },
  ];
}

// server.log writes `[ISO] ...`; pm2 prefixes each line with `ISO: `. Both parse,
// and a line with neither inherits the timestamp of the line above it so a stack
// trace stays attached to the error that produced it.
function parseLlm3LogLines(text, label) {
  const entries = [];
  let lastTime = 0;
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) {
      continue;
    }
    const bracket = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s?(.*)$/.exec(raw);
    const prefix = bracket ? null : /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?):\s?(.*)$/.exec(raw);
    const match = bracket || prefix;
    const stamp = match ? Date.parse(match[1]) : Number.NaN;
    if (Number.isFinite(stamp)) {
      lastTime = stamp;
      entries.push({ time: stamp, seq: entries.length, label, text: match[2] });
      continue;
    }
    entries.push({ time: lastTime, seq: entries.length, label, text: raw });
  }
  return entries;
}

async function readLlm3Log() {
  const sources = llm3LogSources();
  const chunks = await Promise.all(sources.map(async (source) => {
    // readLogTail reads the last maxBytes, so the first line is usually a
    // fragment. Drop it rather than emit half a message with no timestamp.
    const { content } = await readLogTail(source.path, LLM3_LOG_TAIL_BYTES).catch(() => ({ content: "" }));
    const newline = content.indexOf("\n");
    const text = content.length >= LLM3_LOG_TAIL_BYTES && newline !== -1 ? content.slice(newline + 1) : content;
    return parseLlm3LogLines(text, source.label);
  }));

  const merged = chunks.flat().sort((left, right) => (left.time - right.time) || (left.seq - right.seq));
  const tail = merged.slice(-LLM3_LOG_MAX_LINES);
  const content = tail
    .map((entry) => `[${new Date(entry.time || Date.now()).toISOString()}] ${entry.label === "llm3" ? "" : `${entry.label}: `}${entry.text}`)
    .join("\n");
  return { content, sources: sources.map((source) => source.path) };
}

async function readLogChunk(filePath, requestedOffset) {
  if (!filePath) {
    return {
      content: "",
      nextOffset: 0,
      reset: requestedOffset > 0,
    };
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    return {
      content: "",
      nextOffset: 0,
      reset: requestedOffset > 0,
    };
  }

  let offset = Number.isFinite(requestedOffset) ? Math.max(0, requestedOffset) : 0;
  let reset = false;

  if (offset > stat.size) {
    offset = 0;
    reset = true;
  }

  if (stat.size - offset > LOG_CHUNK_LIMIT) {
    offset = Math.max(0, stat.size - LOG_CHUNK_LIMIT);
    reset = true;
  }

  const length = Math.max(0, stat.size - offset);
  if (length === 0) {
    return {
      content: "",
      nextOffset: stat.size,
      reset,
    };
  }

  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    return {
      content: buffer.toString("utf8"),
      nextOffset: stat.size,
      reset,
    };
  } finally {
    await handle.close();
  }
}

async function readLogTail(filePath, maxBytes = DIAGNOSTIC_LOG_TAIL_LIMIT) {
  if (!filePath) {
    return {
      content: "",
      modifiedAt: null,
    };
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size <= 0) {
    return {
      content: "",
      modifiedAt: stat?.mtime || null,
    };
  }

  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return {
      content: buffer.toString("utf8"),
      modifiedAt: stat.mtime || null,
    };
  } finally {
    await handle.close();
  }
}

function formatDiagnosticTimestampLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
  const time = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
  return `${parts.join("-")} ${time}`;
}

function buildDiagnosticFallbackTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  return {
    iso,
    label: formatDiagnosticTimestampLabel(iso),
  };
}

function finalizeDiagnosticEntry(entry, source, fallbackTimestamp, index) {
  const fallback = fallbackTimestamp || buildDiagnosticFallbackTimestamp();
  const sortTimestamp = entry.sortTimestamp || fallback.iso;
  const timestampLabel = entry.timestampLabel || fallback.label;
  const details = Array.isArray(entry.detailsLines)
    ? entry.detailsLines.join("\n").trim()
    : String(entry.details || "").trim();
  return {
    id: `${source.key}-${sortTimestamp}-${index}`,
    source: source.label,
    severity: String(entry.severity || "info").toLowerCase(),
    timestamp: timestampLabel || fallback.label,
    sortTimestamp,
    summary: String(entry.summary || "").trim(),
    details,
  };
}

function parseTimestampedDiagnosticsEntries(content, source, fallbackTimestamp) {
  const entries = [];
  const lines = String(content || "").split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d{3})?)\s+([A-Z]+)\s+(.*)$/);
    if (match) {
      if (current) {
        entries.push(finalizeDiagnosticEntry(current, source, fallbackTimestamp, entries.length));
      }
      const parsedDate = new Date(match[1].replace(" ", "T").replace(",", "."));
      const iso = Number.isNaN(parsedDate.getTime())
        ? fallbackTimestamp?.iso || ""
        : parsedDate.toISOString();
      current = {
        severity: match[2],
        summary: match[3],
        timestampLabel: match[1],
        sortTimestamp: iso,
        detailsLines: [],
      };
      continue;
    }

    if (current) {
      current.detailsLines.push(line);
    }
  }

  if (current) {
    entries.push(finalizeDiagnosticEntry(current, source, fallbackTimestamp, entries.length));
  }

  return entries;
}

function parseLevelPrefixedDiagnosticsEntries(content, source, fallbackTimestamp) {
  const entries = [];
  const lines = String(content || "").split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    const match = line.match(/^(ERROR|WARNING|INFO|DEBUG):([^:]+):(.*)$/);
    if (match) {
      if (current) {
        entries.push(finalizeDiagnosticEntry(current, source, fallbackTimestamp, entries.length));
      }
      current = {
        severity: match[1],
        summary: `${match[2].trim()}: ${match[3].trim()}`,
        timestampLabel: fallbackTimestamp?.label || "",
        sortTimestamp: fallbackTimestamp?.iso || "",
        detailsLines: [],
      };
      continue;
    }

    if (current) {
      current.detailsLines.push(line);
    }
  }

  if (current) {
    entries.push(finalizeDiagnosticEntry(current, source, fallbackTimestamp, entries.length));
  }

  return entries;
}

function addDiagnosticSequenceOffset(sortTimestamp, offset = 0) {
  const time = new Date(sortTimestamp || "").getTime();
  if (!Number.isFinite(time)) {
    return String(sortTimestamp || "");
  }
  return new Date(time + Math.max(0, Number(offset) || 0)).toISOString();
}

function isRelevantHermesDiagnostic(entry) {
  const text = `${entry.summary}\n${entry.details}`.toLowerCase();
  return [
    "empty content",
    "session summarization failed",
    "failed to generate context summary",
    "request timed out",
    "apitimeouterror",
    "readtimeout",
  ].some((pattern) => text.includes(pattern));
}

function isRelevantMlxDiagnostic(entry) {
  const text = `${entry.summary}\n${entry.details}`.toLowerCase();
  return [
    "error in batch generation step",
    "generation_error_recovery",
    "valueerror: [concatenate]",
    "chat completion: 0 tokens",
    "aborted 2 running requests",
  ].some((pattern) => text.includes(pattern));
}

function parseHermesDiagnosticsEntries(content, source, fallbackTimestamp) {
  return parseTimestampedDiagnosticsEntries(content, source, fallbackTimestamp)
    .filter((entry) => isRelevantHermesDiagnostic(entry));
}

function parseMlxDiagnosticsEntries(content, source, fallbackTimestamp) {
  return parseLevelPrefixedDiagnosticsEntries(content, source, fallbackTimestamp)
    .filter((entry) => isRelevantMlxDiagnostic(entry));
}

function extractToolCallNames(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : [])
    .map((call) => String(call?.function?.name || "").trim())
    .filter(Boolean);
}

function buildCompactDiagnosticExcerpt(value, limit = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : text;
}

function parseMissingToolDiagnostic(content) {
  const match = String(content || "").match(/^Tool '([^']+)' does not exist\. Available tools:\s*(.*)$/s);
  if (!match) {
    return null;
  }
  const availableTools = match[2]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    toolName: match[1],
    availableTools,
  };
}

function parseTextualToolCall(content) {
  const text = String(content || "").trim();
  if (!text) {
    return null;
  }
  const callingToolMatch = text.match(/^\[Calling tool:\s*([A-Za-z0-9_.-]+)/);
  if (callingToolMatch) {
    return {
      toolName: callingToolMatch[1],
      pattern: "calling-tool",
      excerpt: buildCompactDiagnosticExcerpt(text, 320),
    };
  }
  if (/<tool_call\b/i.test(text)) {
    return {
      toolName: "unknown",
      pattern: "xml-tool-call",
      excerpt: buildCompactDiagnosticExcerpt(text, 320),
    };
  }
  return null;
}

function buildHermesSessionFallbackTimestamp(sessionPayload, stat, fileName) {
  const candidates = [
    sessionPayload?.updated_at,
    sessionPayload?.last_updated,
    sessionPayload?.ended_at,
    sessionPayload?.session_end,
    sessionPayload?.started_at,
    sessionPayload?.session_start,
    stat?.mtime,
  ];
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") {
      continue;
    }
    const date = candidate instanceof Date ? candidate : new Date(candidate);
    if (!Number.isNaN(date.getTime())) {
      return buildDiagnosticFallbackTimestamp(date);
    }
  }

  const nameMatch = String(fileName || "").match(/session_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (nameMatch) {
    const iso = `${nameMatch[1]}-${nameMatch[2]}-${nameMatch[3]}T${nameMatch[4]}:${nameMatch[5]}:${nameMatch[6]}`;
    const fallback = buildDiagnosticFallbackTimestamp(iso);
    if (fallback.label) {
      return fallback;
    }
  }

  return buildDiagnosticFallbackTimestamp();
}

function parseHermesSessionDiagnosticsEntries(sessionPayload, source, fallbackTimestamp, options = {}) {
  const messages = Array.isArray(sessionPayload?.messages) ? sessionPayload.messages : [];
  const sessionName = String(options.sessionName || "unknown-session").trim();
  const entries = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] || {};
    const sortTimestamp = addDiagnosticSequenceOffset(fallbackTimestamp?.iso, index);
    const content = String(message.content || "");

    if (message.role === "assistant") {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const toolNames = extractToolCallNames(toolCalls);
      const finishReason = String(message.finish_reason || "").trim() || "unknown";
      const hasRecoveredToolCalls = toolCalls.some((call) => {
        const id = String(call?.id || call?.call_id || "").trim();
        return id.startsWith("call_recovered_");
      });
      const textualToolCall = parseTextualToolCall(content);

      if (textualToolCall) {
        entries.push(finalizeDiagnosticEntry({
          severity: "error",
          summary: `Assistant emitted tool call as plain text: ${textualToolCall.toolName}`,
          timestampLabel: fallbackTimestamp?.label,
          sortTimestamp,
          detailsLines: [
            `session: ${sessionName}`,
            `finish_reason: ${finishReason}`,
            `content: ${textualToolCall.excerpt}`,
          ],
        }, source, fallbackTimestamp, entries.length));
      }

      if (toolCalls.length > 0 && (hasRecoveredToolCalls || finishReason !== "tool_calls")) {
        const toolLabel = toolNames.length ? toolNames.join(", ") : `${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}`;
        entries.push(finalizeDiagnosticEntry({
          severity: "warning",
          summary: `Hermes recovered tool call from assistant text: ${toolLabel}`,
          timestampLabel: fallbackTimestamp?.label,
          sortTimestamp,
          detailsLines: [
            `session: ${sessionName}`,
            `finish_reason: ${finishReason}`,
            hasRecoveredToolCalls ? "recovered_ids: yes" : "recovered_ids: no",
            content ? `assistant_text: ${buildCompactDiagnosticExcerpt(content, 240)}` : "",
          ].filter(Boolean),
        }, source, fallbackTimestamp, entries.length));
      }
      continue;
    }

    if (message.role === "tool") {
      const missingTool = parseMissingToolDiagnostic(content);
      if (missingTool) {
        const availablePreview = missingTool.availableTools.slice(0, 12).join(", ");
        const remainingCount = Math.max(0, missingTool.availableTools.length - 12);
        entries.push(finalizeDiagnosticEntry({
          severity: "error",
          summary: `Model requested unavailable tool: ${missingTool.toolName}`,
          timestampLabel: fallbackTimestamp?.label,
          sortTimestamp,
          detailsLines: [
            `session: ${sessionName}`,
            `available_tools: ${availablePreview}${remainingCount ? `, +${remainingCount} more` : ""}`,
          ],
        }, source, fallbackTimestamp, entries.length));
      }
    }
  }

  return entries;
}

function compactDiagnosticsEntries(entries) {
  const sorted = [...entries].sort((left, right) => String(right.sortTimestamp || "").localeCompare(String(left.sortTimestamp || "")));
  const grouped = new Map();

  for (const entry of sorted) {
    const firstDetailLine = String(entry.details || "").split("\n")[0] || "";
    const key = [entry.source, entry.severity, entry.summary, firstDetailLine].join("|");
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    grouped.set(key, {
      ...entry,
      occurrences: 1,
    });
  }

  return [...grouped.values()].sort((left, right) => String(right.sortTimestamp || "").localeCompare(String(left.sortTimestamp || "")));
}

async function readHermesSessionDiagnostics() {
  const directoryEntries = await fs.readdir(HERMES_SESSIONS_DIR, { withFileTypes: true }).catch(() => []);
  const sessionFiles = await Promise.all(
    directoryEntries
      .filter((entry) => entry.isFile() && /^session_.*\.json$/i.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(HERMES_SESSIONS_DIR, entry.name);
        const stat = await fs.stat(filePath).catch(() => null);
        return stat ? { filePath, fileName: entry.name, stat } : null;
      })
  );

  const recentFiles = sessionFiles
    .filter(Boolean)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
    .slice(0, DIAGNOSTIC_SESSION_FILE_LIMIT);

  const nestedEntries = await Promise.all(recentFiles.map(async (file) => {
    const raw = await fs.readFile(file.filePath, "utf8").catch(() => "");
    if (!raw) {
      return [];
    }
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (_error) {
      return [];
    }
    const fallbackTimestamp = buildHermesSessionFallbackTimestamp(payload, file.stat, file.fileName);
    return parseHermesSessionDiagnosticsEntries(
      payload,
      { key: `hermes-session-${path.basename(file.fileName, ".json")}`, label: "Hermes session" },
      fallbackTimestamp,
      { sessionName: file.fileName }
    );
  }));

  return nestedEntries.flat();
}

async function readDiagnosticsErrors() {
  const sources = [
    { key: "hermes-agent", label: "Hermes agent", filePath: HERMES_AGENT_LOG_PATH, parser: parseHermesDiagnosticsEntries },
    { key: "hermes-errors", label: "Hermes errors", filePath: HERMES_ERRORS_LOG_PATH, parser: parseHermesDiagnosticsEntries },
    { key: "hermes-gateway", label: "Hermes gateway", filePath: HERMES_GATEWAY_ERROR_LOG_PATH, parser: parseHermesDiagnosticsEntries },
    { key: "rapid-mlx", label: "rapid-mlx", filePath: path.join(HOME, "qwen36-mlx-api.log"), parser: parseMlxDiagnosticsEntries },
    { key: "rapid-mlx-direct", label: "rapid-mlx (direct)", filePath: path.join(HOME, "qwen36-rapid-mlx-api.log"), parser: parseMlxDiagnosticsEntries },
    { key: "mtplx", label: "MTPLX", filePath: path.join(HOME, "qwen36-mtplx-api.log"), parser: parseMlxDiagnosticsEntries },
    { key: "turboquant", label: "turboquant (GPT-OSS)", filePath: path.join(HOME, "qwen36-turboquant-api.log"), parser: parseMlxDiagnosticsEntries },
  ];

  const nestedEntries = await Promise.all(sources.map(async (source) => {
    const { content, modifiedAt } = await readLogTail(source.filePath);
    const fallbackTimestamp = buildDiagnosticFallbackTimestamp(modifiedAt || Date.now());
    return source.parser(content, source, fallbackTimestamp);
  }));

  const entries = compactDiagnosticsEntries([
    ...nestedEntries.flat(),
    ...(await readHermesSessionDiagnostics()),
  ])
    .sort((left, right) => String(right.sortTimestamp || "").localeCompare(String(left.sortTimestamp || "")))
    .slice(0, DIAGNOSTIC_ENTRY_LIMIT)
    .map(({ sortTimestamp, ...entry }) => entry);

  return {
    updatedAt: new Date().toISOString(),
    entries,
  };
}

function parseTrafficEntries(content) {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return {
          timestamp: null,
          method: "LOG",
          path: "",
          status: null,
          durationMs: null,
          request: line,
          response: "",
          parseError: true,
        };
      }
    });
}

function readCpuSnapshot() {
  return os.cpus().reduce(
    (accumulator, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      accumulator.total += total;
      accumulator.idle += cpu.times.idle;
      return accumulator;
    },
    { total: 0, idle: 0 }
  );
}

async function getPerformanceCoreCount() {
  try {
    const { stdout } = await execFileAsync("sysctl", ["-n", "hw.perflevel0.physicalcpu"]);
    return Number(stdout.trim());
  } catch (_error) {
    return os.cpus().length;
  }
}

function formatExecError(error) {
  return [error.stdout, error.stderr, error.message].filter(Boolean).join("\n").trim();
}

function appendServerLogLine(message) {
  const line = `[${new Date().toISOString()}] ${String(message || "").trim()}\n`;
  try {
    fsSync.mkdirSync(path.dirname(SERVER_LOG_PATH), { recursive: true });
    fsSync.appendFileSync(SERVER_LOG_PATH, line, "utf8");
  } catch (_error) {
    // Best effort only; do not break request handling for logging failures.
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function startServer() {
  // A background task that throws must not take the whole control plane
  // (and every slot's status view) down with it. Log and keep serving.
  process.on("unhandledRejection", (reason) => {
    console.error("[llm3] unhandled rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[llm3] uncaught exception:", error);
  });
  startPm2Discovery();
  return app.listen(PORT, HOST, () => {
    console.log(`llm3 listening on http://${HOST}:${PORT}`);
    console.log(describeAuthPosture({ token: DASHBOARD_AUTH_TOKEN, host: HOST }));
    void startDefaultProfileOnBoot();
  });
}

// ========== Voice Helper Functions ==========

const CHATTERBOX_VOICE_MANIFEST_FILENAME = ".llm3-chatterbox-voices.json";
const CHATTERBOX_VOICE_UPLOADS_DIRNAME = ".llm3-voices";
const MANAGED_CHATTERBOX_RUNTIMES = new Set(["chatterbox", "phonikud-chatterbox", "phonikud-upstream"]);
const F5_VOICE_MANIFEST_FILENAME = ".llm3-f5-voices.json";
const F5_VOICE_UPLOADS_DIRNAME = ".llm3-f5-voices";
const MANAGED_F5_RUNTIMES = new Set(["f5-tts"]);
const DEFAULT_F5_REF_TEXT = "שָׁלוֹם, אֲנִי כַּרְמִית. אֶפְשָׁר לְדַבֵּר אִיתִּי בְּעִבְרִית בְּרוּרָה וְטִבְעִית.";

function isManagedChatterboxRuntime(runtime = "") {
  return MANAGED_CHATTERBOX_RUNTIMES.has(String(runtime || "").trim().toLowerCase());
}

function isManagedF5Runtime(runtime = "") {
  return MANAGED_F5_RUNTIMES.has(String(runtime || "").trim().toLowerCase());
}

function normalizeManagedVoiceName(value = "", fallback = "voice") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return normalized || fallback;
}

function getChatterboxVoiceManifestPath(modelDir) {
  return path.join(modelDir, CHATTERBOX_VOICE_MANIFEST_FILENAME);
}

function getChatterboxVoiceUploadsDir(modelDir) {
  return path.join(modelDir, CHATTERBOX_VOICE_UPLOADS_DIRNAME);
}

function getF5VoiceManifestPath(modelDir) {
  return path.join(modelDir, F5_VOICE_MANIFEST_FILENAME);
}

function getF5VoiceUploadsDir(modelDir) {
  return path.join(modelDir, F5_VOICE_UPLOADS_DIRNAME);
}

function buildLegacyManagedChatterboxVoices(modelDir, runtime = "") {
  const normalizedRuntime = String(runtime || "").trim().toLowerCase();
  if (normalizedRuntime === "chatterbox") {
    const entries = [
      { name: "builtin", prompt_path: null, aliases: ["default"], builtin: true, deletable: false },
      {
        name: "he-carmit",
        prompt_path: process.env.CHATTERBOX_HEBREW_REF_AUDIO || path.join(HOME, "models", "voice", "voice-tts", "f5-tts-hebrew", "refs", "carmit-hebrew.wav"),
        aliases: ["hebrew", "carmit", "hebrew-carmit"],
        language: "he",
        deletable: false,
      },
      {
        name: "en-default",
        prompt_path: process.env.CHATTERBOX_ENGLISH_REF_AUDIO || path.join(HOME, "models", "voice", "voice-tts", "xtts-v2", "samples", "en_sample.wav"),
        aliases: ["english", "english-default"],
        language: "en",
        deletable: false,
      },
      {
        name: "ar-default",
        prompt_path: process.env.CHATTERBOX_ARABIC_REF_AUDIO || "",
        aliases: ["arabic", "arabic-default"],
        language: "ar",
        deletable: false,
      },
      {
        name: "ar-alt",
        prompt_path: process.env.CHATTERBOX_ARABIC_REF_AUDIO_2 || "",
        aliases: ["arabic-alt"],
        language: "ar",
        deletable: false,
      },
      {
        name: "butcher",
        prompt_path: path.join(modelDir, "butcher.wav"),
        aliases: ["butcher"],
        deletable: true,
      },
    ];
    return entries.filter((entry) => entry.prompt_path !== "");
  }
  return [
    { name: "female1", prompt_path: path.join(modelDir, "female1.wav"), aliases: ["default"], builtin: false, deletable: true },
    { name: "female2", prompt_path: path.join(modelDir, "female2.wav"), aliases: [], builtin: false, deletable: true },
    { name: "male1", prompt_path: path.join(modelDir, "male1.wav"), aliases: [], builtin: false, deletable: true },
    { name: "butcher", prompt_path: path.join(modelDir, "Butcher.wav"), aliases: [], builtin: false, deletable: true },
    { name: "london", prompt_path: path.join(modelDir, "London.wav"), aliases: [], builtin: false, deletable: true },
    // Personal reference voices (VOICE_EXTRA_PRESETS="name:file.wav,..."): the
    // same list the phonikud TTS servers read, kept out of the code.
    ...String(process.env.VOICE_EXTRA_PRESETS || "").split(",").map((item) => item.trim().split(":"))
      .filter(([name, file]) => name && file)
      .map(([name, file]) => ({ name: name.trim(), prompt_path: path.join(modelDir, file.trim()), aliases: [], builtin: false, deletable: true })),
    { name: "builtin", prompt_path: null, aliases: [], builtin: true, deletable: false },
  ];
}

function normalizeManagedChatterboxVoiceEntry(modelDir, entry, index) {
  const promptPath = entry?.prompt_path == null ? null : String(entry.prompt_path || "").trim();
  const name = normalizeManagedVoiceName(entry?.name, `voice-${index}`);
  const aliases = Array.isArray(entry?.aliases)
    ? entry.aliases.map((alias) => normalizeManagedVoiceName(alias)).filter((alias) => alias && alias !== name)
    : [];
  const builtin = Boolean(entry?.builtin) || promptPath == null;
  const resolvedPromptPath = promptPath == null
    ? null
    : (path.isAbsolute(promptPath) ? promptPath : path.join(modelDir, promptPath));
  const deletable = typeof entry?.deletable === "boolean"
    ? entry.deletable
    : Boolean(!builtin && resolvedPromptPath && resolvedPromptPath.startsWith(path.resolve(modelDir)));
  return {
    name,
    prompt_path: promptPath,
    aliases: [...new Set(aliases)],
    builtin,
    deletable,
    language: String(entry?.language || "").trim(),
  };
}

async function writeManagedChatterboxManifest(modelDir, manifest) {
  const targetPath = getChatterboxVoiceManifestPath(modelDir);
  const payload = {
    version: 1,
    default_voice: manifest.default_voice,
    voices: manifest.voices,
  };
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, targetPath);
}

async function readManagedChatterboxManifest(modelDir, runtime = "") {
  const manifestPath = getChatterboxVoiceManifestPath(modelDir);
  let payload = {};
  try {
    payload = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (_error) {
    payload = {};
  }
  const rawVoices = Array.isArray(payload?.voices) && payload.voices.length
    ? payload.voices
    : buildLegacyManagedChatterboxVoices(modelDir, runtime);
  const voices = [];
  const seen = new Set();
  for (let index = 0; index < rawVoices.length; index += 1) {
    const normalized = normalizeManagedChatterboxVoiceEntry(modelDir, rawVoices[index], index + 1);
    if (!normalized.name || seen.has(normalized.name)) continue;
    seen.add(normalized.name);
    voices.push(normalized);
  }
  if (!voices.length) {
    voices.push({
      name: "builtin",
      prompt_path: null,
      aliases: ["default"],
      builtin: true,
      deletable: false,
      language: "",
    });
  }
  let defaultVoice = normalizeManagedVoiceName(payload?.default_voice || voices[0]?.name || "builtin", voices[0]?.name || "builtin");
  if (!voices.some((entry) => entry.name === defaultVoice)) {
    defaultVoice = voices[0].name;
  }
  const manifest = { version: 1, default_voice: defaultVoice, voices };
  await writeManagedChatterboxManifest(modelDir, manifest);
  return manifest;
}

function resolveManagedChatterboxVoicePath(modelDir, promptPath) {
  if (promptPath == null) return "";
  const raw = String(promptPath || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.join(modelDir, raw);
}

async function listManagedChatterboxVoices(modelDir, runtime = "") {
  const manifest = await readManagedChatterboxManifest(modelDir, runtime);
  const voices = await Promise.all(manifest.voices.map(async (entry) => {
    const resolvedPromptPath = resolveManagedChatterboxVoicePath(modelDir, entry.prompt_path);
    let exists = true;
    if (resolvedPromptPath) {
      try {
        const stats = await fs.stat(resolvedPromptPath);
        exists = stats.isFile();
      } catch (_error) {
        exists = false;
      }
    }
    return {
      name: entry.name,
      aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
      builtin: Boolean(entry.builtin),
      deletable: Boolean(entry.deletable),
      language: String(entry.language || "").trim(),
      prompt_path: resolvedPromptPath,
      prompt_path_relative: resolvedPromptPath ? path.relative(modelDir, resolvedPromptPath) : "",
      exists,
    };
  }));
  return {
    defaultVoice: manifest.default_voice,
    voices,
  };
}

async function syncManagedChatterboxMetadata(modelDir, runtime = "") {
  const metadataPath = path.join(modelDir, ".llm3-voice.json");
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch (_error) {
    return null;
  }
  const catalog = await listManagedChatterboxVoices(modelDir, runtime);
  const nextVoices = catalog.voices.filter((entry) => entry.exists).map((entry) => entry.name);
  payload.voices = nextVoices;
  const tmpPath = `${metadataPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, metadataPath);
  return payload;
}

async function getManagedChatterboxModel(modelKey = "") {
  const models = await getVoiceModels();
  const model = models.find((entry) => entry.key === String(modelKey || "").trim());
  if (!model) {
    throw new Error(`Unknown TTS model: ${modelKey}`);
  }
  if (!isManagedChatterboxRuntime(model.runtime)) {
    throw new Error(`${model.label} does not support llm3-managed chatterbox voices.`);
  }
  return model;
}

function decodeBase64AudioPayload(value = "") {
  const raw = String(value || "").trim();
  const base64 = raw.includes(",") ? raw.split(",", 2)[1] : raw;
  return Buffer.from(base64, "base64");
}

function looksLikeWavBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 12
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WAVE";
}

// Every managed chatterbox runtime keeps its own voice library under its own
// model directory, and they all read the same reference-WAV format through
// src/chatterbox_voice_library.py. A voice uploaded to one of them used to be
// invisible to the others, so as soon as a request reached a sibling runtime it
// failed with "unknown chatterbox voice '<name>'" even though the voice had been
// added successfully. Write the clip into every compatible model instead.
async function getManagedChatterboxSiblings(model) {
  try {
    const models = await getVoiceModels();
    return models.filter((entry) => (
      entry
      && entry.key !== model.key
      && entry.path
      && isManagedChatterboxRuntime(entry.runtime)
    ));
  } catch (_error) {
    return [];
  }
}

async function writeManagedChatterboxVoiceInto(target, normalizedVoiceName, audioBuffer) {
  const manifest = await readManagedChatterboxManifest(target.path, target.runtime);
  if (manifest.voices.some((entry) => entry.name === normalizedVoiceName)) {
    return "exists";
  }
  const uploadsDir = getChatterboxVoiceUploadsDir(target.path);
  await fs.mkdir(uploadsDir, { recursive: true });
  const targetPath = path.join(uploadsDir, `${normalizedVoiceName}.wav`);
  await fs.writeFile(targetPath, audioBuffer);
  manifest.voices.push({
    name: normalizedVoiceName,
    prompt_path: path.relative(target.path, targetPath).split(path.sep).join("/"),
    aliases: [],
    builtin: false,
    deletable: true,
    language: "",
  });
  if (!manifest.default_voice) {
    manifest.default_voice = normalizedVoiceName;
  }
  await writeManagedChatterboxManifest(target.path, manifest);
  await syncManagedChatterboxMetadata(target.path, target.runtime);
  return "added";
}

async function saveManagedChatterboxVoice(model, voiceName, audioBuffer, sourceFileName = "") {
  const normalizedVoiceName = normalizeManagedVoiceName(voiceName || path.parse(String(sourceFileName || "voice")).name);
  const manifest = await readManagedChatterboxManifest(model.path, model.runtime);
  if (manifest.voices.some((entry) => entry.name === normalizedVoiceName)) {
    throw new Error(`Voice '${normalizedVoiceName}' already exists.`);
  }
  await writeManagedChatterboxVoiceInto(model, normalizedVoiceName, audioBuffer);

  // A sibling that already owns the name keeps whatever it has, and a sibling
  // that fails must not fail the upload the user actually asked for.
  const addedTo = [];
  const skipped = [];
  for (const sibling of await getManagedChatterboxSiblings(model)) {
    try {
      const outcome = await writeManagedChatterboxVoiceInto(sibling, normalizedVoiceName, audioBuffer);
      (outcome === "added" ? addedTo : skipped).push(sibling.key);
    } catch (error) {
      skipped.push(sibling.key);
      appendServerLogLine(`voice-upload could not mirror '${normalizedVoiceName}' into ${sibling.key}: ${formatExecError(error)}`);
    }
  }
  appendServerLogLine(
    `voice-upload '${normalizedVoiceName}' stored in ${model.key}`
    + (addedTo.length ? `; mirrored into ${addedTo.join(", ")}` : "")
    + (skipped.length ? `; skipped ${skipped.join(", ")}` : "")
  );

  const catalog = await listManagedChatterboxVoices(model.path, model.runtime);
  return { ...catalog, mirroredInto: addedTo, mirrorSkipped: skipped };
}

async function deleteManagedChatterboxVoice(model, voiceName) {
  const normalizedVoiceName = normalizeManagedVoiceName(voiceName);
  const manifest = await readManagedChatterboxManifest(model.path, model.runtime);
  const target = manifest.voices.find((entry) => entry.name === normalizedVoiceName);
  if (!target) {
    throw new Error(`Voice '${normalizedVoiceName}' does not exist.`);
  }
  if (!target.deletable) {
    throw new Error(`Voice '${normalizedVoiceName}' cannot be deleted from llm3.`);
  }
  const resolvedPromptPath = resolveManagedChatterboxVoicePath(model.path, target.prompt_path);
  if (resolvedPromptPath && resolvedPromptPath.startsWith(path.resolve(model.path))) {
    await fs.unlink(resolvedPromptPath).catch(() => {});
  }
  manifest.voices = manifest.voices.filter((entry) => entry.name !== normalizedVoiceName);
  if (!manifest.voices.length) {
    manifest.voices = [{
      name: "builtin",
      prompt_path: null,
      aliases: ["default"],
      builtin: true,
      deletable: false,
      language: "",
    }];
  }
  if (!manifest.voices.some((entry) => entry.name === manifest.default_voice)) {
    manifest.default_voice = manifest.voices[0].name;
  }
  await writeManagedChatterboxManifest(model.path, manifest);
  await syncManagedChatterboxMetadata(model.path, model.runtime);

  // Remove the copies the upload mirrored into the sibling runtimes, but only
  // the ones llm3 itself wrote (`.llm3-voices/<name>.wav`), so a same-named
  // voice a model already owned is never deleted from under the user.
  const mirroredUploadPath = `${CHATTERBOX_VOICE_UPLOADS_DIRNAME}/${normalizedVoiceName}.wav`;
  const removedFrom = [];
  for (const sibling of await getManagedChatterboxSiblings(model)) {
    try {
      const siblingManifest = await readManagedChatterboxManifest(sibling.path, sibling.runtime);
      const entry = siblingManifest.voices.find((item) => item.name === normalizedVoiceName);
      if (!entry || String(entry.prompt_path || "").replace(/\\/g, "/") !== mirroredUploadPath) {
        continue;
      }
      const siblingPromptPath = resolveManagedChatterboxVoicePath(sibling.path, entry.prompt_path);
      if (siblingPromptPath && siblingPromptPath.startsWith(path.resolve(sibling.path))) {
        await fs.unlink(siblingPromptPath).catch(() => {});
      }
      siblingManifest.voices = siblingManifest.voices.filter((item) => item.name !== normalizedVoiceName);
      if (!siblingManifest.voices.some((item) => item.name === siblingManifest.default_voice)) {
        siblingManifest.default_voice = siblingManifest.voices[0]?.name || "";
      }
      await writeManagedChatterboxManifest(sibling.path, siblingManifest);
      await syncManagedChatterboxMetadata(sibling.path, sibling.runtime);
      removedFrom.push(sibling.key);
    } catch (error) {
      appendServerLogLine(`voice-delete could not remove '${normalizedVoiceName}' from ${sibling.key}: ${formatExecError(error)}`);
    }
  }
  if (removedFrom.length) {
    appendServerLogLine(`voice-delete '${normalizedVoiceName}' also removed from ${removedFrom.join(", ")}`);
  }

  const catalog = await listManagedChatterboxVoices(model.path, model.runtime);
  return { ...catalog, removedFrom };
}

function buildLegacyManagedF5Voices(modelDir) {
  const defaultPromptPath = path.join(modelDir, "refs", "carmit-hebrew.wav");
  return [
    {
      name: "default",
      prompt_path: defaultPromptPath,
      aliases: ["builtin", "carmit", "hebrew-carmit"],
      builtin: true,
      deletable: false,
      language: "he",
      ref_text: DEFAULT_F5_REF_TEXT,
    },
  ];
}

function normalizeManagedF5VoiceEntry(modelDir, entry, index) {
  const promptPath = String(entry?.prompt_path || "").trim();
  const name = normalizeManagedVoiceName(entry?.name, `voice-${index}`);
  const aliases = Array.isArray(entry?.aliases)
    ? entry.aliases.map((alias) => normalizeManagedVoiceName(alias)).filter((alias) => alias && alias !== name)
    : [];
  const resolvedPromptPath = promptPath
    ? (path.isAbsolute(promptPath) ? promptPath : path.join(modelDir, promptPath))
    : "";
  const builtin = Boolean(entry?.builtin);
  const deletable = typeof entry?.deletable === "boolean"
    ? entry.deletable
    : Boolean(!builtin && resolvedPromptPath && resolvedPromptPath.startsWith(path.resolve(modelDir)));
  return {
    name,
    prompt_path: promptPath,
    aliases: [...new Set(aliases)],
    builtin,
    deletable,
    language: String(entry?.language || "").trim(),
    ref_text: String(entry?.ref_text || "").trim(),
  };
}

async function writeManagedF5Manifest(modelDir, manifest) {
  const targetPath = getF5VoiceManifestPath(modelDir);
  const payload = {
    version: 1,
    default_voice: manifest.default_voice,
    voices: manifest.voices,
  };
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, targetPath);
}

async function readManagedF5Manifest(modelDir) {
  const manifestPath = getF5VoiceManifestPath(modelDir);
  let payload = {};
  try {
    payload = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (_error) {
    payload = {};
  }
  const rawVoices = Array.isArray(payload?.voices) && payload.voices.length
    ? payload.voices
    : buildLegacyManagedF5Voices(modelDir);
  const voices = [];
  const seen = new Set();
  for (let index = 0; index < rawVoices.length; index += 1) {
    const normalized = normalizeManagedF5VoiceEntry(modelDir, rawVoices[index], index + 1);
    if (!normalized.name || !normalized.prompt_path || seen.has(normalized.name)) continue;
    seen.add(normalized.name);
    voices.push(normalized);
  }
  if (!voices.length) {
    voices.push(normalizeManagedF5VoiceEntry(modelDir, buildLegacyManagedF5Voices(modelDir)[0], 1));
  }
  let defaultVoice = normalizeManagedVoiceName(payload?.default_voice || voices[0]?.name || "default", voices[0]?.name || "default");
  if (!voices.some((entry) => entry.name === defaultVoice)) {
    defaultVoice = voices[0].name;
  }
  const manifest = { version: 1, default_voice: defaultVoice, voices };
  await writeManagedF5Manifest(modelDir, manifest);
  return manifest;
}

function resolveManagedF5VoicePath(modelDir, promptPath) {
  const raw = String(promptPath || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.join(modelDir, raw);
}

async function listManagedF5Voices(modelDir) {
  const manifest = await readManagedF5Manifest(modelDir);
  const voices = await Promise.all(manifest.voices.map(async (entry) => {
    const resolvedPromptPath = resolveManagedF5VoicePath(modelDir, entry.prompt_path);
    let exists = true;
    if (resolvedPromptPath) {
      try {
        const stats = await fs.stat(resolvedPromptPath);
        exists = stats.isFile();
      } catch (_error) {
        exists = false;
      }
    }
    return {
      name: entry.name,
      aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
      builtin: Boolean(entry.builtin),
      deletable: Boolean(entry.deletable),
      language: String(entry.language || "").trim(),
      prompt_path: resolvedPromptPath,
      prompt_path_relative: resolvedPromptPath ? path.relative(modelDir, resolvedPromptPath) : "",
      exists,
      ref_text: String(entry.ref_text || "").trim(),
    };
  }));
  return {
    defaultVoice: manifest.default_voice,
    voices,
  };
}

async function syncManagedF5Metadata(modelDir) {
  const metadataPath = path.join(modelDir, ".llm3-voice.json");
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch (_error) {
    return null;
  }
  const catalog = await listManagedF5Voices(modelDir);
  payload.voices = catalog.voices.filter((entry) => entry.exists).map((entry) => entry.name);
  const tmpPath = `${metadataPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, metadataPath);
  return payload;
}

async function getManagedF5Model(modelKey = "") {
  const models = await getVoiceModels();
  const model = models.find((entry) => entry.key === String(modelKey || "").trim());
  if (!model) {
    throw new Error(`Unknown TTS model: ${modelKey}`);
  }
  if (!isManagedF5Runtime(model.runtime)) {
    throw new Error(`${model.label} does not support llm3-managed F5 voices.`);
  }
  return model;
}

async function saveManagedF5Voice(model, voiceName, audioBuffer, refText, sourceFileName = "") {
  const normalizedVoiceName = normalizeManagedVoiceName(voiceName || path.parse(String(sourceFileName || "voice")).name);
  const normalizedRefText = String(refText || "").trim();
  if (!normalizedRefText) {
    throw new Error("referenceText is required.");
  }
  const manifest = await readManagedF5Manifest(model.path);
  if (manifest.voices.some((entry) => entry.name === normalizedVoiceName)) {
    throw new Error(`Voice '${normalizedVoiceName}' already exists.`);
  }
  const uploadsDir = getF5VoiceUploadsDir(model.path);
  await fs.mkdir(uploadsDir, { recursive: true });
  const targetFileName = `${normalizedVoiceName}.wav`;
  const targetPath = path.join(uploadsDir, targetFileName);
  await fs.writeFile(targetPath, audioBuffer);
  manifest.voices.push({
    name: normalizedVoiceName,
    prompt_path: path.relative(model.path, targetPath).split(path.sep).join("/"),
    aliases: [],
    builtin: false,
    deletable: true,
    language: "he",
    ref_text: normalizedRefText,
  });
  if (!manifest.default_voice) {
    manifest.default_voice = normalizedVoiceName;
  }
  await writeManagedF5Manifest(model.path, manifest);
  await syncManagedF5Metadata(model.path);
  return listManagedF5Voices(model.path);
}

async function deleteManagedF5Voice(model, voiceName) {
  const normalizedVoiceName = normalizeManagedVoiceName(voiceName);
  const manifest = await readManagedF5Manifest(model.path);
  const target = manifest.voices.find((entry) => entry.name === normalizedVoiceName);
  if (!target) {
    throw new Error(`Voice '${normalizedVoiceName}' does not exist.`);
  }
  if (!target.deletable) {
    throw new Error(`Voice '${normalizedVoiceName}' cannot be deleted from llm3.`);
  }
  const resolvedPromptPath = resolveManagedF5VoicePath(model.path, target.prompt_path);
  if (resolvedPromptPath && resolvedPromptPath.startsWith(path.resolve(model.path))) {
    await fs.unlink(resolvedPromptPath).catch(() => {});
  }
  manifest.voices = manifest.voices.filter((entry) => entry.name !== normalizedVoiceName);
  if (!manifest.voices.length) {
    manifest.voices = [normalizeManagedF5VoiceEntry(model.path, buildLegacyManagedF5Voices(model.path)[0], 1)];
  }
  if (!manifest.voices.some((entry) => entry.name === manifest.default_voice)) {
    manifest.default_voice = manifest.voices[0].name;
  }
  await writeManagedF5Manifest(model.path, manifest);
  await syncManagedF5Metadata(model.path);
  return listManagedF5Voices(model.path);
}

async function resolveManagedF5VoiceRequestPayload(modelOrKey, voiceName = "") {
  const model = typeof modelOrKey === "string"
    ? await getManagedF5Model(modelOrKey)
    : modelOrKey;
  const normalizedVoiceName = normalizeManagedVoiceName(voiceName || "default", "default");
  const catalog = await listManagedF5Voices(model.path);
  const selectedVoice = catalog.voices.find((entry) => entry.name === normalizedVoiceName)
    || catalog.voices.find((entry) => entry.name === catalog.defaultVoice)
    || catalog.voices[0];
  if (!selectedVoice || !selectedVoice.exists || !selectedVoice.prompt_path) {
    return {};
  }
  return {
    ref_audio: selectedVoice.prompt_path,
    ref_text: String(selectedVoice.ref_text || "").trim(),
  };
}

async function getVoiceModels() {
  const models = [];

  // Discover from voice models root — top-level dirs (voice-tts, voice-stt) contain
  // individual model subdirectories, each with its own .llm3-voice.json metadata.
  const repoEntries = await fs.readdir(VOICE_MODELS_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of repoEntries) {
    if (!entry.isDirectory()) continue;
    const categoryDir = path.join(VOICE_MODELS_ROOT, entry.name);
    // Each category dir (voice-tts, voice-stt) may contain model subdirs
    const modelEntries = await fs.readdir(categoryDir, { withFileTypes: true }).catch(() => []);
    for (const modelEntry of modelEntries) {
      if (modelEntry.name.startsWith(".")) continue;
      const modelDir = path.join(categoryDir, modelEntry.name);
      const modelStats = await fs.stat(modelDir).catch(() => null);
      if (!modelStats?.isDirectory()) continue;
      const metadata = await readVoiceModelMetadata(modelDir);
      if (!metadata) continue;
      // Build a composite key that reflects the nesting: e.g. "voice-tts/xtts-v2"
      const key = `${entry.name}/${modelEntry.name}`;
      models.push({
        key,
        label: metadata.label || modelEntry.name,
        path: modelDir,
        type: metadata.type || "tts",
        runtime: metadata.runtime || "",
        languages: metadata.languages || [],
        quality: metadata.quality || "medium",
        latency: metadata.latency || "medium",
        sizeBytes: metadata.sizeBytes || 0,
        sizeLabel: formatBytes(metadata.sizeBytes || 0),
        hfUrl: metadata.hfUrl || "",
        aliases: metadata.aliases || [entry.name, modelEntry.name],
        deletable: true,
        category: entry.name, // "voice-tts" or "voice-stt"
        voices: metadata.voices || [],
        sortOrder: Number.isFinite(metadata.sortOrder) ? metadata.sortOrder : 1000,
      });
    }
  }

  models.sort((left, right) => {
    if (left.type !== right.type) return left.type.localeCompare(right.type);
    const leftOrder = Number.isFinite(left.sortOrder) ? left.sortOrder : 1000;
    const rightOrder = Number.isFinite(right.sortOrder) ? right.sortOrder : 1000;
    const orderDiff = leftOrder - rightOrder;
    if (orderDiff !== 0) return orderDiff;
    return String(left.label || left.key).localeCompare(String(right.label || right.key));
  });

  return models;
}

async function readVoiceModelMetadata(repoDir) {
  try {
    const payload = JSON.parse(await fs.readFile(path.join(repoDir, ".llm3-voice.json"), "utf8"));
    const normalizedAliases = Array.isArray(payload?.aliases)
      ? payload.aliases.map((alias) => String(alias || "").trim().toLowerCase()).filter(Boolean)
      : [];
    const normalizedRuntime = String(payload?.runtime || "").trim();
    let voices = Array.isArray(payload?.voices) ? payload.voices.map(String).filter(Boolean) : [];
    const modelDirName = path.basename(repoDir).trim().toLowerCase();
    const isGenericChatterbox =
      normalizedRuntime === "chatterbox"
      && [modelDirName, ...normalizedAliases].some(
        (alias) => alias === "chatterbox" || alias === "chatterbox-multilingual" || alias === "resemble-chatterbox"
      );
    if (isGenericChatterbox || isManagedChatterboxRuntime(normalizedRuntime)) {
      const catalog = await listManagedChatterboxVoices(repoDir, normalizedRuntime);
      voices = catalog.voices.filter((entry) => entry.exists).map((entry) => entry.name);
    } else if (isManagedF5Runtime(normalizedRuntime)) {
      const catalog = await listManagedF5Voices(repoDir);
      voices = catalog.voices.filter((entry) => entry.exists).map((entry) => entry.name);
    }
    return {
      label: String(payload?.label || "").trim(),
      type: String(payload?.type || "tts").trim(),
      runtime: normalizedRuntime,
      languages: Array.isArray(payload?.languages) ? payload.languages : [],
      quality: String(payload?.quality || "medium").trim(),
      latency: String(payload?.latency || "medium").trim(),
      hfUrl: String(payload?.hfUrl || "").trim(),
      sizeBytes: Number(payload?.sizeBytes || 0),
      aliases: normalizedAliases,
      voices,
      sortOrder: Number(payload?.sortOrder ?? 1000),
    };
  } catch (_error) {
    return null;
  }
}

function createIdleVoiceStatus(slot) {
  return {
    slotId: slot.id,
    slotLabel: slot.label,
    slotIndex: slot.index,
    type: slot.type,
    running: false,
    logs: {
      active: getDefaultVoiceLogs(slot),
    },
  };
}

function getDefaultVoiceLogs(slot) {
  return {
    server: path.join(slot.stateDir, `${slot.type}-server.log`),
    traffic: path.join(slot.stateDir, "traffic.log"),
  };
}

async function getVoiceSlotStatuses(models = null) {
  return Promise.all(VOICE_SLOT_DEFINITIONS.map((slot) => getVoiceSlotStatus(slot, models)));
}

async function getVoiceSlotStatus(slot, models = null) {
  const launcher = slot.type === "tts" ? Voice_TTS_LAUNCHER : Voice_STT_LAUNCHER;
  try {
    const output = await runLauncher(launcher, ["--slot", slot.id, "--status-json"], { timeoutMs: STATUS_SCRIPT_TIMEOUT_MS });
    const payload = JSON.parse(output);
    if (!payload.running) {
      return createIdleVoiceStatus(slot);
    }
    return {
      ...payload,
      slotId: slot.id,
      slotLabel: slot.label,
      slotIndex: slot.index,
      type: slot.type,
      logs: {
        active: {
          server: payload.logs?.server || getDefaultVoiceLogs(slot).server,
          traffic: payload.logs?.traffic || getDefaultVoiceLogs(slot).traffic,
        },
      },
    };
  } catch (_error) {
    return createIdleVoiceStatus(slot);
  }
}

let voiceBenchmarkTaskPromise = null;

function normalizeVoiceBenchmarkModelKey(value) {
  return String(value || "").trim().toLowerCase().replace(/^voice-tts\//, "");
}

function resolveVoiceModelByAnyKey(models, rawKey) {
  const normalized = normalizeVoiceBenchmarkModelKey(rawKey);
  if (!normalized) {
    return null;
  }
  return models.find((model) => {
    const candidates = [
      model.key,
      model.key.split("/").pop(),
      ...(Array.isArray(model.aliases) ? model.aliases : []),
    ].map((entry) => normalizeVoiceBenchmarkModelKey(entry));
    return candidates.includes(normalized);
  }) || null;
}

function detectTextDirection(text) {
  const sample = String(text || "");
  if (/[\u0590-\u08FF]/.test(sample)) {
    return "rtl";
  }
  return "ltr";
}

const VOICE_BENCHMARK_LANGUAGE_LABELS = {
  he: "Hebrew",
  ar: "Arabic",
  hi: "Hindi",
  ja: "Japanese",
  zh: "Chinese",
};

const KOKORO_VOICE_LANGUAGE_TAGS = {
  a: "en-us",
  b: "en-gb",
  e: "es",
  f: "fr-fr",
  h: "hi",
  i: "it",
  j: "ja",
  p: "pt-br",
  z: "zh",
};

function detectVoiceBenchmarkTextLanguage(text) {
  const sample = String(text || "");
  if (/[\u0590-\u05FF]/.test(sample)) return "he";
  if (/[\u0600-\u06FF]/.test(sample)) return "ar";
  if (/[\u0900-\u097F]/.test(sample)) return "hi";
  if (/[\u3040-\u30FF]/.test(sample)) return "ja";
  if (/[\u4E00-\u9FFF]/.test(sample)) return "zh";
  return "";
}

function normalizeVoiceLanguageTag(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) {
    return "";
  }
  const [primary] = normalized.split("-");
  if (primary === "en") return "en";
  if (primary === "pt") return "pt";
  return primary;
}

function getVoiceBenchmarkLanguageLabel(languageCode) {
  return VOICE_BENCHMARK_LANGUAGE_LABELS[languageCode] || String(languageCode || "").trim();
}

function getVoiceModelSupportedLanguageCodes(model) {
  return [...new Set(
    (Array.isArray(model?.languages) ? model.languages : [])
      .map((entry) => normalizeVoiceLanguageTag(entry))
      .filter(Boolean)
  )];
}

function voiceModelSupportsTextLanguage(model, languageCode) {
  const normalizedLanguage = normalizeVoiceLanguageTag(languageCode);
  if (!normalizedLanguage) {
    return true;
  }
  const supported = getVoiceModelSupportedLanguageCodes(model);
  if (!supported.length) {
    return true;
  }
  return supported.includes(normalizedLanguage);
}

function getKokoroVoiceLanguageCode(voiceName) {
  const prefix = String(voiceName || "").trim().toLowerCase().split("_", 1)[0];
  return normalizeVoiceLanguageTag(KOKORO_VOICE_LANGUAGE_TAGS[prefix[0]] || "");
}

function slugifyVoiceBenchmarkValue(value, fallback = "item") {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || fallback;
}

function buildVoiceBenchmarkAudioUrl(runId, fileName) {
  if (!runId || !fileName) {
    return "";
  }
  return `/api/voice/benchmark/audio/${encodeURIComponent(runId)}/${encodeURIComponent(fileName)}`;
}

function decorateVoiceBenchmarkState(state) {
  if (!state || typeof state !== "object") {
    return {
      status: "idle",
      results: [],
      running: false,
      cancelRequested: false,
      completedCount: 0,
      totalCount: 0,
    };
  }
  const results = Array.isArray(state.results) ? state.results : [];
  return {
    ...state,
    results: results.map((result) => ({
      ...result,
      audioUrl: result.audioFileName ? buildVoiceBenchmarkAudioUrl(state.runId, result.audioFileName) : "",
    })),
    running: state.status === "running" || state.status === "restoring",
    cancelRequested: Boolean(state.cancelRequested),
    completedCount: Number(state.completedCount || 0),
    totalCount: Number(state.totalCount || 0),
  };
}

function normalizeVoiceBenchmarkSelectedTunings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([modelKey, tuning]) => {
        const normalizedKey = String(modelKey || "").trim();
        if (!normalizedKey || !tuning || typeof tuning !== "object" || Array.isArray(tuning) || !voiceModelSupportsTuning(normalizedKey)) {
          return null;
        }
        return [normalizedKey, normalizeVoiceTtsTuningParams(tuning, normalizedKey)];
      })
      .filter(Boolean)
  );
}

async function readVoiceBenchmarkState() {
  return readJsonIfExists(VOICE_BENCHMARK_STATE_PATH);
}

async function writeVoiceBenchmarkState(state) {
  const payload = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(VOICE_BENCHMARK_STATE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

async function updateVoiceBenchmarkState(mutator) {
  const current = (await readVoiceBenchmarkState()) || {};
  const next = await mutator(current);
  return writeVoiceBenchmarkState(next);
}

async function clearVoiceBenchmarkAudioArtifacts(results = [], runId = "") {
  for (const result of Array.isArray(results) ? results : []) {
    const fileName = String(result?.audioFileName || "").trim();
    if (!fileName || !runId) {
      continue;
    }
    const filePath = path.join(VOICE_BENCHMARK_RUNS_DIR, runId, fileName);
    await fs.unlink(filePath).catch(() => {});
  }
}

async function waitForVoiceBenchmarkHealth(slot, isCancelled, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  const runtimeUrl = `http://127.0.0.1:${slot.backendPort}/health`;
  while (Date.now() < deadline) {
    if (isCancelled()) {
      throw new Error("Benchmark cancelled.");
    }
    try {
      const upstream = await fetch(runtimeUrl, { method: "GET", signal: AbortSignal.timeout(VOICE_RUNTIME_PROBE_TIMEOUT_MS) });
      if (upstream.ok) {
        return;
      }
    } catch (_error) {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(`Timed out waiting for ${slot.id} health.`);
}

async function synthesizeVoiceBenchmarkAudio(slot, model, text, voiceName, audioFormat, sampleRate, tuning = {}) {
  const runtimeUrl = `http://127.0.0.1:${slot.backendPort}/tts`;
  let upstream;
  try {
    const managedVoicePayload = isManagedF5Runtime(model?.runtime)
      ? await resolveManagedF5VoiceRequestPayload(model, voiceName)
      : {};
    upstream = await fetch(runtimeUrl, {
      method: "POST",
      signal: AbortSignal.timeout(VOICE_RUNTIME_SYNTH_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice: voiceName,
        format: audioFormat,
        sample_rate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : undefined,
        ...managedVoicePayload,
        ...buildVoiceTtsRuntimePayload(model, tuning),
      }),
    });
  } catch (error) {
    throw new Error(error?.cause?.message || error?.message || "fetch failed");
  }
  if (!upstream.ok) {
    const contentType = upstream.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? JSON.stringify(await upstream.json().catch(() => ({})))
      : (await upstream.text().catch(() => ""));
    throw new Error(body || `${upstream.status} ${upstream.statusText}`);
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = await upstream.json();
    const audioBase64 = String(payload.audio_base64 || "");
    if (!audioBase64) {
      throw new Error("TTS response did not include audio.");
    }
    return {
      bytes: Buffer.from(audioBase64, "base64"),
      contentType: "audio/wav",
    };
  }

  return {
    bytes: Buffer.from(await upstream.arrayBuffer()),
    contentType: contentType.split(";")[0].trim() || "application/octet-stream",
  };
}

async function getAudioDurationSeconds(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], getExecOptions({ timeout: 15000, maxBuffer: 64 * 1024 }));
    const value = Number.parseFloat(String(stdout || "").trim());
    return Number.isFinite(value) ? value : 0;
  } catch (_error) {
    return 0;
  }
}

function getVoiceBenchmarkDefaultVoiceName(model, previousVoiceName = "", textLanguageCode = "") {
  if (Array.isArray(model?.voices) && model.voices.length) {
    if (previousVoiceName && model.voices.includes(previousVoiceName)) {
      if (String(model?.runtime || "").trim() !== "kokoro") {
        return previousVoiceName;
      }
      const previousLanguage = getKokoroVoiceLanguageCode(previousVoiceName);
      if (!textLanguageCode || !previousLanguage || previousLanguage === normalizeVoiceLanguageTag(textLanguageCode)) {
        return previousVoiceName;
      }
    }
    if (String(model?.runtime || "").trim() === "kokoro" && textLanguageCode) {
      const matchingVoice = model.voices.find((voiceName) => (
        getKokoroVoiceLanguageCode(voiceName) === normalizeVoiceLanguageTag(textLanguageCode)
      ));
      if (matchingVoice) {
        return String(matchingVoice || "").trim();
      }
    }
    return String(model.voices[0] || "").trim();
  }
  return String(previousVoiceName || "").trim();
}

function getVoiceBenchmarkVoiceName(model, selectedVoices = {}, previousVoiceName = "", textLanguageCode = "") {
  const explicitVoiceName = String(selectedVoices?.[model?.key] || "").trim();
  if (explicitVoiceName && Array.isArray(model?.voices) && model.voices.includes(explicitVoiceName)) {
    if (String(model?.runtime || "").trim() !== "kokoro") {
      return explicitVoiceName;
    }
    const explicitLanguage = getKokoroVoiceLanguageCode(explicitVoiceName);
    if (!textLanguageCode || !explicitLanguage || explicitLanguage === normalizeVoiceLanguageTag(textLanguageCode)) {
      return explicitVoiceName;
    }
  }
  return getVoiceBenchmarkDefaultVoiceName(model, previousVoiceName, textLanguageCode);
}

function getVoiceBenchmarkModelTuning(modelOrKey, selectedTunings = {}) {
  if (!voiceModelSupportsTuning(modelOrKey)) {
    return {};
  }
  const modelKey = typeof modelOrKey === "string"
    ? String(modelOrKey || "").trim()
    : String(modelOrKey?.key || "").trim();
  const explicitTuning = selectedTunings?.[modelKey];
  if (explicitTuning && typeof explicitTuning === "object" && !Array.isArray(explicitTuning)) {
    return normalizeVoiceTtsTuningParams(explicitTuning, modelOrKey);
  }
  return normalizeVoiceTtsTuningParams({}, modelOrKey);
}

function voiceBenchmarkRuntimeMatchesTarget(snapshot, modelOrKey, voiceName, tuning = {}) {
  if (!snapshot?.wasRunning) {
    return false;
  }
  const snapshotModelKey = normalizeVoiceBenchmarkModelKey(snapshot.modelKey);
  const targetModelKey = normalizeVoiceBenchmarkModelKey(typeof modelOrKey === "string" ? modelOrKey : modelOrKey?.key);
  if (!snapshotModelKey || !targetModelKey || snapshotModelKey !== targetModelKey) {
    return false;
  }
  // The voice rides on every /tts request, so a voice-only change never
  // needs a relaunch (saves the model load between two voices of one model).
  const normalizedSnapshotTuning = getVoiceBenchmarkModelTuning(modelOrKey, {
    [String(typeof modelOrKey === "string" ? modelOrKey : modelOrKey?.key || "").trim()]: snapshot.tuning || {},
  });
  const normalizedTargetTuning = getVoiceBenchmarkModelTuning(modelOrKey, {
    [String(typeof modelOrKey === "string" ? modelOrKey : modelOrKey?.key || "").trim()]: tuning || {},
  });
  return JSON.stringify(normalizedSnapshotTuning) === JSON.stringify(normalizedTargetTuning);
}

function getManagedVoiceSlotProcessName(slot) {
  const slotId = String(slot?.id || "").trim();
  return slotId ? `llm3-${slotId}` : "";
}

async function getPm2ProcessSnapshotByName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], getExecOptions({ timeout: 15000, maxBuffer: 4 * 1024 * 1024 }));
    const processes = JSON.parse(String(stdout || "[]"));
    return processes.find((entry) => String(entry?.name || "").trim() === trimmed) || null;
  } catch (_error) {
    return null;
  }
}

async function suspendManagedVoiceSlotForBenchmark(slot) {
  const processName = getManagedVoiceSlotProcessName(slot);
  const snapshot = await getPm2ProcessSnapshotByName(processName);
  const status = String(snapshot?.pm2_env?.status || "").trim().toLowerCase();
  if (!processName || !snapshot || !["online", "launching", "waiting restart"].includes(status)) {
    return { processName, resumeAfterBenchmark: false };
  }
  await execFileAsync("pm2", ["stop", processName], getExecOptions({ timeout: 30000, maxBuffer: 512 * 1024 }));
  return { processName, resumeAfterBenchmark: true };
}

async function resumeManagedVoiceSlotAfterBenchmark(control) {
  if (!control?.resumeAfterBenchmark || !control.processName) {
    return "";
  }
  await execFileAsync("pm2", ["start", control.processName], getExecOptions({ timeout: 30000, maxBuffer: 512 * 1024 }));
  return `Resumed managed slot process ${control.processName}.`;
}

async function restoreVoiceBenchmarkSlot(slot, snapshot, voiceModels) {
  if (!snapshot?.wasRunning) {
    const launcher = slot.type === "tts" ? Voice_TTS_LAUNCHER : Voice_STT_LAUNCHER;
    await safeStopVoice(launcher, slot);
    return "Restored TTS slot to idle.";
  }

  const snapshotModel = resolveVoiceModelByAnyKey(voiceModels, snapshot.modelKey);
  if (!snapshotModel) {
    throw new Error(`Unable to restore previous model '${snapshot.modelKey}'.`);
  }

  await startVoiceModel(slot, snapshotModel, {
    voiceName: snapshot.voiceName || "",
    audioFormat: snapshot.audioFormat || "wav",
    sampleRate: Number(snapshot.sampleRate) || 24000,
    tuning: snapshot.tuning || {},
  });
  await waitForVoiceBenchmarkHealth(slot, () => false, 180000);
  return `Restored ${snapshotModel.label || snapshotModel.key}.`;
}

// The launcher's state file names the model it started. Refuse to
// synthesise when the slot reports a different model than the row claims.
async function assertVoiceBenchmarkSlotServesModel(slot, model) {
  const status = await getVoiceSlotStatus(slot);
  const servedKey = String(status?.model?.key || "").trim();
  if (!status?.running || !servedKey) {
    throw new Error(`${slot.label} reports no running TTS server after launch.`);
  }
  const expected = normalizeVoiceBenchmarkModelKey(model.key);
  const aliases = new Set([servedKey, ...(Array.isArray(status.model?.aliases) ? status.model.aliases : [])]
    .map((value) => normalizeVoiceBenchmarkModelKey(value)));
  if (!aliases.has(expected)) {
    throw new Error(`${slot.label} is serving '${servedKey}' instead of '${model.key}'. The launch did not take over the slot.`);
  }
  return servedKey;
}

async function runVoiceBenchmarkJob(runState) {
  const voiceModels = await getVoiceModels();
  const slot = VOICE_SLOT_DEFINITIONS.find((entry) => entry.id === runState.slotId);
  if (!slot || slot.type !== "tts") {
    throw new Error(`Invalid TTS slot '${runState.slotId}'.`);
  }
  const textLanguageCode = detectVoiceBenchmarkTextLanguage(runState.text);
  const textLanguageLabel = getVoiceBenchmarkLanguageLabel(textLanguageCode);

  const slotStatus = await getVoiceSlotStatus(slot, voiceModels);
  const snapshot = {
    wasRunning: Boolean(slotStatus?.running && slotStatus?.model?.key),
    modelKey: slotStatus?.model?.key || "",
    voiceName: slotStatus?.params?.voiceName || slotStatus?.params?.voice || "",
    audioFormat: slotStatus?.params?.audioFormat || slotStatus?.params?.format || "wav",
    sampleRate: Number(slotStatus?.params?.sampleRate) || 24000,
    tuning: getVoiceBenchmarkModelTuning(slotStatus?.model || slotStatus?.model?.key || "", {
      [String(slotStatus?.model?.key || "").trim()]: slotStatus?.params || {},
    }),
  };

  await updateVoiceBenchmarkState((current) => ({
    ...current,
    status: "running",
    currentStage: "preparing",
    currentStageDetail: `Snapshotting the current ${slot.label} runtime before the benchmark starts.`,
    snapshot,
  }));

  const isCancelled = async () => {
    const current = await readVoiceBenchmarkState();
    return Boolean(current?.cancelRequested);
  };
  const managedSlotControl = await suspendManagedVoiceSlotForBenchmark(slot);
  let runtimeChanged = false;
  // What the slot is serving *now*. The snapshot only describes the state
  // before the loop; comparing every model against it let a row labelled
  // with one model be synthesised by whichever model launched before it.
  let activeRuntime = { ...snapshot };

  const runEntries = Array.isArray(runState.queue) && runState.queue.length
    ? runState.queue
    : runState.selectedModelKeys.map((modelKey) => ({ modelKey, voiceName: "" }));
  try {
    for (const [index, entry] of runEntries.entries()) {
      if (await isCancelled()) {
        break;
      }

      const modelKey = entry.modelKey;
      const model = resolveVoiceModelByAnyKey(voiceModels, modelKey);
      const displayLabel = model?.label || modelKey;
      const voiceName = String(entry.voiceName || "").trim()
        || getVoiceBenchmarkVoiceName(model, runState.selectedVoices, snapshot.voiceName, textLanguageCode);
      const tuning = getVoiceBenchmarkModelTuning(model || modelKey, runState.selectedTunings);
      const runtimeLabel = String(model?.runtime || "").replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
      const startedAt = new Date().toISOString();

      const baseResult = {
        modelKey: model?.key || modelKey,
        label: displayLabel,
        runtimeLabel,
        voiceName,
        tuning,
        sampleRate: Number(runState.sampleRate) || 24000,
        audioFormat: runState.audioFormat,
        status: "running",
        stage: "starting",
        stageDetail: `Starting ${displayLabel} in ${slot.label}.`,
        startedAt,
        elapsedMs: 0,
        audioDurationSeconds: 0,
        audioBytes: 0,
        audioFileName: "",
        error: "",
      };

      await updateVoiceBenchmarkState((current) => ({
        ...current,
        currentModelKey: baseResult.modelKey,
        currentModelLabel: displayLabel,
        currentStage: "starting-model",
        currentStageDetail: `(${index + 1}/${runEntries.length}) Launching ${displayLabel} (${voiceName || "default voice"}).`,
        results: [...(Array.isArray(current.results) ? current.results : []), baseResult],
      }));

      const started = Date.now();
      try {
        if (!model) {
          throw new Error("Model no longer exists in llm3.");
        }
        if (!voiceModelSupportsTextLanguage(model, textLanguageCode)) {
          const supportedLanguages = getVoiceModelSupportedLanguageCodes(model);
          const supportedLabel = supportedLanguages.length ? supportedLanguages.join(", ") : "unknown";
          throw new Error(`${displayLabel} does not list ${textLanguageLabel} support. Supported languages: ${supportedLabel}.`);
        }
        const reusingSnapshotRuntime = voiceBenchmarkRuntimeMatchesTarget(activeRuntime, model, voiceName, tuning);
        if (!reusingSnapshotRuntime) {
          runtimeChanged = true;
          activeRuntime = { wasRunning: false };
          await startVoiceModel(slot, model, {
            voiceName,
            audioFormat: runState.audioFormat,
            sampleRate: Number(runState.sampleRate) || 24000,
            tuning,
          });
          activeRuntime = {
            wasRunning: true,
            modelKey: model.key,
            voiceName,
            audioFormat: runState.audioFormat,
            sampleRate: Number(runState.sampleRate) || 24000,
            tuning,
          };
        }

        await updateVoiceBenchmarkState((current) => ({
          ...current,
          currentStage: "waiting-health",
          currentStageDetail: reusingSnapshotRuntime
            ? `Reusing the current ${displayLabel} runtime.`
            : `Waiting for ${displayLabel} to become healthy.`,
          results: (current.results || []).map((result, resultIndex) => (
            resultIndex === current.results.length - 1
              ? {
                  ...result,
                  stage: "waiting-health",
                  stageDetail: reusingSnapshotRuntime
                    ? "Reusing the current TTS runtime."
                    : "Waiting for the TTS server to become ready.",
                }
              : result
          )),
        }));

        await waitForVoiceBenchmarkHealth(slot, () => false, 180000);
        if (await isCancelled()) {
          break;
        }
        const servedModelKey = await assertVoiceBenchmarkSlotServesModel(slot, model);

        await updateVoiceBenchmarkState((current) => ({
          ...current,
          currentStage: "synthesizing",
          currentStageDetail: `Generating audio with ${displayLabel}.`,
          results: (current.results || []).map((result, resultIndex) => (
            resultIndex === current.results.length - 1
              ? { ...result, servedModelKey, stage: "synthesizing", stageDetail: "Synthesizing the benchmark text." }
              : result
          )),
        }));

        const audio = await synthesizeVoiceBenchmarkAudio(
          slot,
          model || modelKey,
          runState.text,
          voiceName,
          runState.audioFormat,
          Number(runState.sampleRate) || 24000,
          tuning
        );
        const ext = runState.audioFormat === "pcm16" ? "wav" : runState.audioFormat;
        const fileName = `${String(index + 1).padStart(2, "0")}-${slugifyVoiceBenchmarkValue(displayLabel, "tts")}.${ext}`;
        const runDir = path.join(VOICE_BENCHMARK_RUNS_DIR, runState.runId);
        await fs.mkdir(runDir, { recursive: true });
        const filePath = path.join(runDir, fileName);
        await fs.writeFile(filePath, audio.bytes);
        const durationSeconds = await getAudioDurationSeconds(filePath);
        const elapsedMs = Date.now() - started;

        await updateVoiceBenchmarkState((current) => ({
          ...current,
          completedCount: Number(current.completedCount || 0) + 1,
          currentStage: "result-ready",
          currentStageDetail: `${displayLabel} finished in ${(elapsedMs / 1000).toFixed(elapsedMs >= 10000 ? 1 : 2)}s.`,
          results: (current.results || []).map((result, resultIndex) => (
            resultIndex === current.results.length - 1
              ? {
                  ...result,
                  status: "ready",
                  stage: "complete",
                  stageDetail: "Audio generated successfully.",
                  finishedAt: new Date().toISOString(),
                  elapsedMs,
                  audioDurationSeconds: durationSeconds,
                  audioBytes: audio.bytes.length,
                  audioFileName: fileName,
                }
              : result
          )),
        }));
      } catch (error) {
        const elapsedMs = Date.now() - started;
        await updateVoiceBenchmarkState((current) => ({
          ...current,
          completedCount: Number(current.completedCount || 0) + 1,
          currentStage: "model-failed",
          currentStageDetail: `${displayLabel} failed: ${error.message || error}`,
          results: (current.results || []).map((result, resultIndex) => (
            resultIndex === current.results.length - 1
              ? {
                  ...result,
                  status: "failed",
                  stage: "failed",
                  stageDetail: error.message || "Voice benchmark failed.",
                  finishedAt: new Date().toISOString(),
                  elapsedMs,
                  error: error.message || "Voice benchmark failed.",
                }
              : result
          )),
        }));
      }
    }
  } finally {
    const currentState = (await readVoiceBenchmarkState()) || runState;
    const wasCancelled = Boolean(currentState.cancelRequested);
    let restoreNote = "";
    try {
      if (runtimeChanged) {
        await updateVoiceBenchmarkState((current) => ({
          ...current,
          status: "restoring",
          currentStage: "restoring",
          currentStageDetail: wasCancelled
            ? "Cancellation requested. Restoring the previous TTS runtime."
            : "Restoring the previous TTS runtime.",
        }));
        restoreNote = await restoreVoiceBenchmarkSlot(slot, currentState.snapshot || snapshot, voiceModels);
      } else {
        restoreNote = "Benchmark reused the active TTS runtime; no restore was needed.";
      }
      const resumeNote = await resumeManagedVoiceSlotAfterBenchmark(managedSlotControl);
      if (resumeNote) {
        restoreNote = restoreNote ? `${restoreNote} ${resumeNote}` : resumeNote;
      }
    } catch (error) {
      restoreNote = `Restore failed: ${error.message || error}`;
    }

    await updateVoiceBenchmarkState((current) => ({
      ...current,
      status: current.cancelRequested ? "cancelled" : "completed",
      finishedAt: new Date().toISOString(),
      currentModelKey: "",
      currentModelLabel: "",
      currentStage: current.cancelRequested ? "cancelled" : "completed",
      currentStageDetail: current.cancelRequested
        ? "Benchmark cancelled. Partial results were preserved."
        : "Benchmark finished. All available results are preserved below.",
      restorationNote: restoreNote,
    }));
    clearOverviewCache();
  }
}

async function startVoiceModel(slot, model, params) {
  const launcher = slot.type === "tts" ? Voice_TTS_LAUNCHER : Voice_STT_LAUNCHER;

  // model.key is the composite key (e.g., "voice-tts/xtts-v2").
  // Extract just the model name after the last slash for the launcher.
  const modelDirName = model.key.split("/").pop();
  const actualModelKey = modelDirName;

  const args = ["--slot", slot.id, "--model", actualModelKey, "--start"];
  if (params.voiceName) args.push("--voice", params.voiceName);
  if (params.audioFormat) args.push("--format", params.audioFormat);
  if (Number.isInteger(params.sampleRate) && params.sampleRate > 0) args.push("--sample-rate", String(params.sampleRate));
  appendVoiceTuningCliArgs(args, model, params.tuning || params);
  const output = await runLauncher(launcher, args);
  await waitForVoiceBenchmarkHealth(slot, () => false, 180000);
  return `${output}\n${slot.id} is healthy.`.trim();
}

async function setVoiceDefaults(slot, model, params) {
  const launcher = slot.type === "tts" ? Voice_TTS_LAUNCHER : Voice_STT_LAUNCHER;
  const modelDirName = model.key.split("/").pop();
  const args = ["--slot", slot.id, "--model", modelDirName, "--set-defaults"];
  if (params.voiceName) args.push("--voice", params.voiceName);
  if (params.audioFormat) args.push("--format", params.audioFormat);
  if (Number.isInteger(params.sampleRate) && params.sampleRate > 0) args.push("--sample-rate", String(params.sampleRate));
  appendVoiceTuningCliArgs(args, model, params.tuning || params);
  return runLauncher(launcher, args);
}

async function safeStopVoice(script, slot) {
  try {
    return await runLauncher(script, ["--slot", slot.id, "--stop"]);
  } catch (_error) {
    return "";
  }
}

async function restartVoiceModels() {
  // Stop all, then restart all from defaults
  const outputs = [];
  const failures = [];
  for (const vSlot of VOICE_SLOT_DEFINITIONS) {
    const launcher = vSlot.type === "tts" ? Voice_TTS_LAUNCHER : Voice_STT_LAUNCHER;
    outputs.push(await safeStopVoice(launcher, vSlot));
  }

  // Restart from defaults
  for (const vSlot of VOICE_SLOT_DEFINITIONS) {
    const launcher = vSlot.type === "tts" ? Voice_TTS_LAUNCHER : Voice_STT_LAUNCHER;
    const defaults = await readDefaultsFromScript(launcher, vSlot);
    if (!String(defaults?.model || "").trim()) {
      outputs.push(`Skipped ${vSlot.id}: no saved default model.`);
      continue;
    }
    try {
      const output = await runLauncher(launcher, ["--slot", vSlot.id, "--start"]);
      outputs.push(output);
      await waitForVoiceBenchmarkHealth(vSlot, () => false, 180000);
      outputs.push(`${vSlot.id} is healthy.`);
    } catch (error) {
      const message = `Failed to restart ${vSlot.id}: ${formatExecError(error)}`;
      failures.push(message);
      outputs.push(message);
    }
  }

  return {
    ok: failures.length === 0,
    error: failures.length > 0 ? failures.join("\n") : "",
    outputs: outputs.filter(Boolean).join("\n"),
  };
}

function getVoiceSlotRuntimeBaseUrl(slot, config = null) {
  const override = config?.voiceRuntimeBaseUrls?.[slot.id];
  return String(override || `http://${API_PUBLIC_HOST}:${slot.publicPort}`).trim();
}

async function readVoiceSlotRuntimeBaseUrl(slotId) {
  const vSlot = VOICE_SLOT_DEFINITIONS.find((s) => s.id === slotId);
  if (!vSlot) throw new Error(`Unknown voice slot: ${slotId}`);
  const config = await readDashboardConfig();
  return getVoiceSlotRuntimeBaseUrl(vSlot, config);
}

async function writeVoiceSlotRuntimeBaseUrl(slotId, runtimeBaseUrl) {
  const vSlot = VOICE_SLOT_DEFINITIONS.find((s) => s.id === slotId);
  if (!vSlot) throw new Error(`Unknown voice slot: ${slotId}`);
  const trimmed = String(runtimeBaseUrl || "").trim();
  await updateDashboardConfig((config) => {
    if (!config.voiceRuntimeBaseUrls) config.voiceRuntimeBaseUrls = {};
    if (trimmed) {
      config.voiceRuntimeBaseUrls[vSlot.id] = trimmed;
    } else {
      delete config.voiceRuntimeBaseUrls[vSlot.id];
    }
    return config;
  });
}

async function buildVoiceSyncTarget(slot, model, params = {}) {
  return {
    slotId: slot.id,
    modelId: model.key,
    voiceName: String(params.voiceName || "").trim(),
    audioFormat: String(params.audioFormat || "").trim(),
    sampleRate: Number(params.sampleRate || 0) || (slot.type === "tts" ? 24000 : 16000),
    tuning: normalizeVoiceTtsTuningParams(params.tuning || params, model),
    runtimeBaseUrl: await readVoiceSlotRuntimeBaseUrl(slot.id),
    type: slot.type,
  };
}

async function syncHermesTTSAfterLaunch(target) {
  if (!isRemoteSyncEnabled(process.env.HERMES_SYNC_ENABLED, HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!hasRemoteShellAuth(HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return { ok: false, error: buildRemoteShellAuthError("Hermes TTS sync", "HERMES_SYNC_PASSWORD", "HERMES_SYNC_SSH_KEY", HERMES_SYNC_SSH_KEY) };
  }

  const payload = {
    tts_model: target.modelId,
    tts_voice: target.voiceName,
    tts_tuning: normalizeVoiceTtsTuningParams(target.tuning || target, target.modelId),
    tts_base_url: HERMES_SYNC_BASE_URL || target.runtimeBaseUrl,
    vision_model: "",
    vision_base_url: "",
    model: "",
    context_length: 0,
  };

  try {
    const output = await runRemoteShell(
      HERMES_SYNC_HOST,
      HERMES_SYNC_USER,
      {
        password: HERMES_SYNC_PASSWORD,
        sshKeyPath: HERMES_SYNC_SSH_KEY,
      },
      buildHermesVoiceSyncRemoteScript(payload)
    );
    return parseHermesVoiceSyncOutput(output);
  } catch (error) {
    return { ok: false, error: formatExecError(error) || "Hermes TTS sync failed." };
  }
}

async function syncHermesSTTAfterLaunch(target) {
  if (!isRemoteSyncEnabled(process.env.HERMES_SYNC_ENABLED, HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!hasRemoteShellAuth(HERMES_SYNC_PASSWORD, HERMES_SYNC_SSH_KEY)) {
    return { ok: false, error: buildRemoteShellAuthError("Hermes STT sync", "HERMES_SYNC_PASSWORD", "HERMES_SYNC_SSH_KEY", HERMES_SYNC_SSH_KEY) };
  }

  const payload = {
    stt_model: target.modelId,
    stt_base_url: HERMES_SYNC_BASE_URL || target.runtimeBaseUrl,
    tts_model: "",
    tts_voice: "",
    tts_base_url: "",
    model: "",
    context_length: 0,
  };

  try {
    const output = await runRemoteShell(
      HERMES_SYNC_HOST,
      HERMES_SYNC_USER,
      {
        password: HERMES_SYNC_PASSWORD,
        sshKeyPath: HERMES_SYNC_SSH_KEY,
      },
      buildHermesVoiceSyncRemoteScript(payload)
    );
    return parseHermesVoiceSyncOutput(output);
  } catch (error) {
    return { ok: false, error: formatExecError(error) || "Hermes STT sync failed." };
  }
}

function buildHermesVoiceSyncRemoteScript(payload) {
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const voiceTtsClientPath = path.join(__dirname, "voice-tts-client.py");
  const voiceTtsClientBase64 = fsSync.existsSync(voiceTtsClientPath)
    ? Buffer.from(fsSync.readFileSync(voiceTtsClientPath)).toString("base64")
    : "";
  return [
    "set -euo pipefail",
    `PYTHON_BIN=${shellQuote(HERMES_SYNC_PYTHON)}`,
    `CONFIG_PATH=${shellQuote(HERMES_SYNC_CONFIG_PATH)}`,
    `CLIENT_PATH=${shellQuote(path.posix.join(HERMES_SYNC_HOME, "scripts", "llm3-tts-client.py"))}`,
    `PAYLOAD_BASE64=${shellQuote(payloadBase64)}`,
    `CLIENT_BASE64=${shellQuote(voiceTtsClientBase64)}`,
    "if [ -n \"$CLIENT_BASE64\" ]; then",
    "  mkdir -p \"$(dirname \"$CLIENT_PATH\")\"",
    "  \"$PYTHON_BIN\" - <<'PY' \"$CLIENT_PATH\" \"$CLIENT_BASE64\"",
    "import base64",
    "import pathlib",
    "import sys",
    "pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(sys.argv[2]))",
    "PY",
    "  chmod +x \"$CLIENT_PATH\"",
    "fi",
    `"$PYTHON_BIN" - "$CONFIG_PATH" "$PAYLOAD_BASE64" "$CLIENT_PATH" <<'PY'`,
    "import base64",
    "import json",
    "import pathlib",
    "import sys",
    "import yaml",
    "",
    "config_path = pathlib.Path(sys.argv[1]).expanduser()",
    "payload = json.loads(base64.b64decode(sys.argv[2]).decode('utf-8'))",
    "client_path = sys.argv[3]",
    "",
    "config = {}",
    "if config_path.exists():",
    "    config = yaml.safe_load(config_path.read_text(encoding='utf-8')) or {}",
    "",
    "# Update TTS config",
    "tts_cfg = payload.get('tts_model', '')",
    "if tts_cfg:",
    "    voice_cfg = config.setdefault('tts', {})",
    "    voice_cfg['enabled'] = True",
    "    voice_cfg['provider'] = 'llm3_voice'",
    "    llm3_cfg = voice_cfg.setdefault('llm3', {})",
    "    llm3_cfg['model'] = tts_cfg",
    "    llm3_cfg['voice'] = str(payload.get('tts_voice', '') or '')",
    "    base_url = str(payload.get('tts_base_url', '') or '').strip()",
    "    tuning = payload.get('tts_tuning') or {}",
    "    if base_url:",
    "        voice_cfg['base_url'] = base_url",
    "        llm3_cfg['base_url'] = base_url",
    "    if tuning:",
    "        if 'exaggeration' in tuning: llm3_cfg['exaggeration'] = tuning['exaggeration']",
    "        if 'cfgWeight' in tuning: llm3_cfg['cfg_weight'] = tuning['cfgWeight']",
    "        if 'temperature' in tuning: llm3_cfg['temperature'] = tuning['temperature']",
    "        if 'repetitionPenalty' in tuning: llm3_cfg['repetition_penalty'] = tuning['repetitionPenalty']",
    "        if 'minP' in tuning: llm3_cfg['min_p'] = tuning['minP']",
    "        if 'topP' in tuning: llm3_cfg['top_p'] = tuning['topP']",
    "    providers = voice_cfg.setdefault('providers', {})",
    "    cmd = f\"{sys.executable} {client_path} --base-url {base_url} --input {{input_path}} --output {{output_path}} --voice {llm3_cfg['voice']} --model {tts_cfg}\"",
    "    if tuning:",
    "        if 'exaggeration' in tuning: cmd += f\" --exaggeration {tuning['exaggeration']}\"",
    "        if 'cfgWeight' in tuning: cmd += f\" --cfg-weight {tuning['cfgWeight']}\"",
    "        if 'temperature' in tuning: cmd += f\" --temperature {tuning['temperature']}\"",
    "        if 'repetitionPenalty' in tuning: cmd += f\" --repetition-penalty {tuning['repetitionPenalty']}\"",
    "        if 'minP' in tuning: cmd += f\" --min-p {tuning['minP']}\"",
    "        if 'topP' in tuning: cmd += f\" --top-p {tuning['topP']}\"",
    "    providers['llm3_voice'] = {",
    "        'type': 'command',",
    "        'command': cmd,",
    "        'output_format': 'mp3',",
    "        'voice_compatible': True,",
    "        'timeout': 240,",
    "        'model': tts_cfg,",
    "        'voice': llm3_cfg['voice'],",
    "    }",
    "    if tuning:",
    "        if 'exaggeration' in tuning: providers['llm3_voice']['exaggeration'] = tuning['exaggeration']",
    "        if 'cfgWeight' in tuning: providers['llm3_voice']['cfg_weight'] = tuning['cfgWeight']",
    "        if 'temperature' in tuning: providers['llm3_voice']['temperature'] = tuning['temperature']",
    "        if 'repetitionPenalty' in tuning: providers['llm3_voice']['repetition_penalty'] = tuning['repetitionPenalty']",
    "        if 'minP' in tuning: providers['llm3_voice']['min_p'] = tuning['minP']",
    "        if 'topP' in tuning: providers['llm3_voice']['top_p'] = tuning['topP']",
    "",
    "# Update STT config",
    "stt_cfg = payload.get('stt_model', '')",
    "if stt_cfg:",
    "    stt_cfg_obj = config.setdefault('stt', {})",
    "    stt_cfg_obj['enabled'] = True",
    "    # Use 'openai' provider since the llm3 STT proxy exposes",
    "    # /audio/transcriptions (OpenAI-compatible endpoint).",
    "    stt_cfg_obj['provider'] = 'openai'",
    "    stt_cfg_obj.setdefault('openai', {})['model'] = stt_cfg",
    "    # hermes-agent requires stt.openai.api_key to use a custom base_url;",
    "    # a dummy value triggers the local path instead of cloud OpenAI.",
    "    stt_cfg_obj.setdefault('openai', {})['api_key'] = 'local-stt'",
    "    base_url = str(payload.get('stt_base_url', '') or '').strip()",
    "    if base_url:",
    "        stt_cfg_obj.setdefault('openai', {})['base_url'] = base_url",
    "",
    "config_path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding='utf-8')",
    "print('__VOICE_SYNC__' + json.dumps({",
    "    'ok': True,",
    "    'tts_model': tts_cfg,",
    "    'stt_model': stt_cfg,",
    "}))",
    "PY",
    `SERVICE_NAME=${shellQuote(HERMES_SYNC_SERVICE)}`,
    "SERVICE_STATE=$(systemctl --user restart \"$SERVICE_NAME\" && systemctl --user is-active \"$SERVICE_NAME\")",
    "printf '__HERMES_SERVICE__%s__END__\\n' \"$SERVICE_STATE\"",
  ].join("\n");
}

function parseHermesVoiceSyncOutput(output) {
  const text = String(output || "");
  const parsed = parseMarkerSyncOutput(text, "__VOICE_SYNC__", "Voice sync");
  if (!parsed.payload) {
    return parsed;
  }
  const serviceState = extractServiceState(text);
  return { ...parsed.payload, service_state: serviceState || null };
}

module.exports = {
  updateDashboardConfig,
  DSPARK_REASONING_EFFORTS,
  LAUNCH_SAMPLING_DEFAULTS,
  app,
  startServer,
  buildLauncherCommandTemplate,
  parseLauncherRequestBody,
  chooseLaunchContextLength,
  chooseSlotContextLength,
  applyLauncherMetadata,
  resolveDefaultsLauncher,
  detectLauncherFromProcess,
  buildLauncherExecEnv,
  normalizeOptionalHttpUrl,
  getFailedIntegrationSyncMessages,
  readThinkingClearOffset,
  writeThinkingClearOffset,
  buildHfCandidates,
  pruneForeignQuantFiles,
  normalizeDownloadCandidate,
  resolveHfDownloadCandidate,
  normalizeConversionCandidate,
  partitionMtpGgufPaths,
  selectConversionSourceFiles,
  normalizeConversionQuantization,
  repoSupportsVision,
  modelSupportsVision,
  // Exported for tests: these embed Python that rewrites remote configs, so the
  // vision routing inside them needs to be assertable without a live remote host.
  stripJsoncTrailingCommas,
  buildLibreChatSyncRemoteScript,
  buildRemoteJsonAppSyncScript,
  readDownloadedMetadata,
  detectMtplxModelSupport,
  parseHfSearchQuery,
  filterHfCandidates,
  sortHfCandidates,
  clearHfDownloadJobs,
  readHfDownloadJobs,
  removePartialArtifacts,
  computeSlotBenchmarkMetrics,
  buildSlotSyncTarget,
  getSlotDefinition,
  getSlotStatus,
  isVisionProjectorFile,
  isQwen38TwentySevenBModel,
  getChatTemplateOptionsForModel,
  resolveChatTemplateKey,
  normalizeChatTemplateParam,
  buildChatTemplateOptionsPayload,
  ensureChatTemplateFile,
  resolveChatTemplateForLaunch,
  buildGgufExtraArgs,
  applyHermesPcConfig,
  applyOmpPcConfig,
  applyOmpPcSettings,
  applyPiPcSettings,
  applyPiPcConfig,
  applyOpenCodePcConfig,
  requireGamingPcTarget,
  syncHermesPcAfterLaunch,
  syncOmpPcAfterLaunch,
  syncPiPcAfterLaunch,
  syncOpenCodePcAfterLaunch,
  syncHermesAfterLaunch,
  syncHermesCompactionAfterLaunch,
  syncHermesCompactionAfterStop,
  syncHermesM4CompactionAfterLaunch,
  syncHermesM4CompactionAfterStop,
  syncHermesM4AfterLaunch,
  syncPodcastGAfterLaunch,
  syncSqliteAppAfterLaunch,
  syncClaudeCodeAfterLaunch,
  syncLibreChatAfterLaunch,
  syncHermesTTSAfterLaunch,
  syncHermesSTTAfterLaunch,
  syncHermesM4VoiceAfterLaunch,
  chooseLaunchSyncModelId,
  getPreferredRuntimeModelId,
  detectVoiceBenchmarkTextLanguage,
  normalizeVoiceBenchmarkSelectedTunings,
  getVoiceBenchmarkDefaultVoiceName,
  getVoiceBenchmarkVoiceName,
  getVoiceBenchmarkModelTuning,
  voiceBenchmarkRuntimeMatchesTarget,
  voiceModelSupportsTextLanguage,
  parseHermesDiagnosticsEntries,
  parseHermesSessionDiagnosticsEntries,
  parseMlxDiagnosticsEntries,
  compactDiagnosticsEntries,
  readDashboardConfig,
  writeDashboardConfig,
  deleteDashboardProfile,
  getLauncherDefinition,
  getLauncherDefinitions,
  normalizeLaunchParamsForModel,
  normalizeProfileSlotConfig,
  extractMarkerPayload,
  parseHermesSyncOutput,
  isLauncherSelectable,
  normalizeSlotName,
  normalizeSlotNames,
  resolveSlotName,
  carryForwardSlotNames,
  parseLlm3LogLines,
  logFailedActionResponse,
};
