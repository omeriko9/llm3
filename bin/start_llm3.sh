#!/bin/bash
set -euo pipefail

METHOD="${1:-}"
if [[ "$METHOD" != "pm2" && "$METHOD" != "launchd" ]]; then
  echo "Usage: $0 pm2|launchd" >&2
  exit 1
fi

USER_NAME="$(id -un)"
USER_ID="$(id -u)"
USER_HOME="$HOME"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM3_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="/opt/homebrew/bin/node"
PM2_BIN="/opt/homebrew/bin/pm2"
PM2_AGENT_LABEL="com.llm3.pm2"
PM2_AGENT_PLIST="$USER_HOME/Library/LaunchAgents/$PM2_AGENT_LABEL.plist"
PM2_SAFE_RESURRECT="$LLM3_DIR/bin/pm2_resurrect_safe.sh"
LAUNCHD_LABEL="com.llm3.server"
LAUNCHD_PLIST="/Library/LaunchDaemons/$LAUNCHD_LABEL.plist"
LOG_DIR="$USER_HOME/Library/Logs/llm3"
STDOUT_LOG="$LOG_DIR/launchd.out.log"
STDERR_LOG="$LOG_DIR/launchd.err.log"
TMP_PLIST="/tmp/$LAUNCHD_LABEL.plist"
XDG_STATE_HOME_VALUE="${XDG_STATE_HOME:-$USER_HOME/.local/state}"
XDG_CACHE_HOME_VALUE="${XDG_CACHE_HOME:-$USER_HOME/.local/cache}"
XDG_CONFIG_HOME_VALUE="${XDG_CONFIG_HOME:-$USER_HOME/.config}"
LLM3_STATE_DIR_VALUE="${LLM3_STATE_DIR:-$XDG_STATE_HOME_VALUE/llm3}"
TMPDIR_VALUE="${LLM3_TMPDIR:-/tmp}"
LANG_VALUE="${LANG:-en_US.UTF-8}"
LC_ALL_VALUE="${LC_ALL:-$LANG_VALUE}"
SHELL_VALUE="${SHELL:-/bin/zsh}"

mkdir -p \
  "$LOG_DIR" \
  "$USER_HOME/Library/LaunchAgents" \
  "$XDG_STATE_HOME_VALUE" \
  "$XDG_CACHE_HOME_VALUE" \
  "$XDG_CONFIG_HOME_VALUE" \
  "$LLM3_STATE_DIR_VALUE"

dump_value() {
  local key="$1"
  python3 - "$key" <<'PY'
import json
import os
import sys

key = sys.argv[1]
path = os.path.expanduser("~/.pm2/dump.pm2")
try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    sys.exit(0)

for item in data if isinstance(data, list) else []:
    if item.get("name") != "llm3":
        continue
    for container in (item, item.get("env") or {}, item.get("pm2_env") or {}):
        value = container.get(key)
        if value not in (None, ""):
            print(value)
            sys.exit(0)
    sys.exit(0)
PY
}

launchd_value() {
  local key="$1"
  [[ -f "$LAUNCHD_PLIST" ]] || return 0
  /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$key" "$LAUNCHD_PLIST" 2>/dev/null || true
}

sanitize_optional_http_url() {
  local value="${1:-}"
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  [[ -n "$value" ]] || return 0
  case "$value" in
    http://*|https://*)
      printf '%s' "$value"
      ;;
    *)
      return 0
      ;;
  esac
}

resolve_env() {
  PORT_VALUE="${PORT:-$(dump_value PORT)}"
  PORT_VALUE="${PORT_VALUE:-$(launchd_value PORT)}"
  HOST_VALUE="${HOST:-$(dump_value HOST)}"
  HOST_VALUE="${HOST_VALUE:-$(launchd_value HOST)}"
  SLOT_COUNT_VALUE="${LLM3_SLOT_COUNT:-$(dump_value LLM3_SLOT_COUNT)}"
  SLOT_COUNT_VALUE="${SLOT_COUNT_VALUE:-$(launchd_value LLM3_SLOT_COUNT)}"
  HERMES_SYNC_HOST_VALUE="${HERMES_SYNC_HOST:-$(dump_value HERMES_SYNC_HOST)}"
  HERMES_SYNC_HOST_VALUE="${HERMES_SYNC_HOST_VALUE:-$(launchd_value HERMES_SYNC_HOST)}"
  HERMES_SYNC_USER_VALUE="${HERMES_SYNC_USER:-$(dump_value HERMES_SYNC_USER)}"
  HERMES_SYNC_USER_VALUE="${HERMES_SYNC_USER_VALUE:-$(launchd_value HERMES_SYNC_USER)}"
  HERMES_SYNC_HOME_VALUE="${HERMES_SYNC_HOME:-$(dump_value HERMES_SYNC_HOME)}"
  HERMES_SYNC_HOME_VALUE="${HERMES_SYNC_HOME_VALUE:-$(launchd_value HERMES_SYNC_HOME)}"
  HERMES_SYNC_SSH_KEY_VALUE="${HERMES_SYNC_SSH_KEY:-$(dump_value HERMES_SYNC_SSH_KEY)}"
  HERMES_SYNC_SSH_KEY_VALUE="${HERMES_SYNC_SSH_KEY_VALUE:-$(launchd_value HERMES_SYNC_SSH_KEY)}"
  HERMES_SYNC_PYTHON_VALUE="${HERMES_SYNC_PYTHON:-$(dump_value HERMES_SYNC_PYTHON)}"
  HERMES_SYNC_PYTHON_VALUE="${HERMES_SYNC_PYTHON_VALUE:-$(launchd_value HERMES_SYNC_PYTHON)}"
  HERMES_SYNC_CONFIG_PATH_VALUE="${HERMES_SYNC_CONFIG_PATH:-$(dump_value HERMES_SYNC_CONFIG_PATH)}"
  HERMES_SYNC_CONFIG_PATH_VALUE="${HERMES_SYNC_CONFIG_PATH_VALUE:-$(launchd_value HERMES_SYNC_CONFIG_PATH)}"
  HERMES_SYNC_CACHE_PATH_VALUE="${HERMES_SYNC_CACHE_PATH:-$(dump_value HERMES_SYNC_CACHE_PATH)}"
  HERMES_SYNC_CACHE_PATH_VALUE="${HERMES_SYNC_CACHE_PATH_VALUE:-$(launchd_value HERMES_SYNC_CACHE_PATH)}"
  HERMES_SYNC_SERVICE_VALUE="${HERMES_SYNC_SERVICE:-$(dump_value HERMES_SYNC_SERVICE)}"
  HERMES_SYNC_SERVICE_VALUE="${HERMES_SYNC_SERVICE_VALUE:-$(launchd_value HERMES_SYNC_SERVICE)}"
  HERMES_SYNC_BASE_URL_VALUE="${HERMES_SYNC_BASE_URL:-$(dump_value HERMES_SYNC_BASE_URL)}"
  HERMES_SYNC_BASE_URL_VALUE="${HERMES_SYNC_BASE_URL_VALUE:-$(launchd_value HERMES_SYNC_BASE_URL)}"
  HERMES_SYNC_BASE_URL_VALUE="$(sanitize_optional_http_url "$HERMES_SYNC_BASE_URL_VALUE")"
  HERMES_SYNC_PASSWORD_FILE_VALUE="${HERMES_SYNC_PASSWORD_FILE:-$(dump_value HERMES_SYNC_PASSWORD_FILE)}"
  HERMES_SYNC_PASSWORD_FILE_VALUE="${HERMES_SYNC_PASSWORD_FILE_VALUE:-$(launchd_value HERMES_SYNC_PASSWORD_FILE)}"
  HERMES_SYNC_PASSWORD_VALUE="${HERMES_SYNC_PASSWORD:-$(dump_value HERMES_SYNC_PASSWORD)}"
  HERMES_SYNC_PASSWORD_VALUE="${HERMES_SYNC_PASSWORD_VALUE:-$(launchd_value HERMES_SYNC_PASSWORD)}"
  HERMES_SYNC_ENABLED_VALUE="${HERMES_SYNC_ENABLED:-$(dump_value HERMES_SYNC_ENABLED)}"
  HERMES_SYNC_ENABLED_VALUE="${HERMES_SYNC_ENABLED_VALUE:-$(launchd_value HERMES_SYNC_ENABLED)}"

  PORT_VALUE="${PORT_VALUE:-7075}"
  HOST_VALUE="${HOST_VALUE:-0.0.0.0}"
  SLOT_COUNT_VALUE="${SLOT_COUNT_VALUE:-4}"
  HERMES_SYNC_HOST_VALUE="${HERMES_SYNC_HOST_VALUE:-127.0.0.1}"
  HERMES_SYNC_USER_VALUE="${HERMES_SYNC_USER_VALUE:-user}"
  HERMES_SYNC_HOME_VALUE="${HERMES_SYNC_HOME_VALUE:-/home/user/.hermes}"
  HERMES_SYNC_SSH_KEY_VALUE="${HERMES_SYNC_SSH_KEY_VALUE:-$USER_HOME/keys/nginx_server_key.pem}"
  HERMES_SYNC_PYTHON_VALUE="${HERMES_SYNC_PYTHON_VALUE:-/home/user/.hermes/hermes-agent/venv/bin/python}"
  HERMES_SYNC_CONFIG_PATH_VALUE="${HERMES_SYNC_CONFIG_PATH_VALUE:-/home/user/.hermes/config.yaml}"
  HERMES_SYNC_CACHE_PATH_VALUE="${HERMES_SYNC_CACHE_PATH_VALUE:-/home/user/.hermes/context_length_cache.yaml}"
  HERMES_SYNC_SERVICE_VALUE="${HERMES_SYNC_SERVICE_VALUE:-hermes-gateway.service}"
  HERMES_SYNC_BASE_URL_VALUE="${HERMES_SYNC_BASE_URL_VALUE:-}"
  HERMES_SYNC_PASSWORD_FILE_VALUE="${HERMES_SYNC_PASSWORD_FILE_VALUE:-$USER_HOME/pass.txt}"
  if [[ -z "${HERMES_SYNC_PASSWORD_VALUE:-}" && -r "$HERMES_SYNC_PASSWORD_FILE_VALUE" ]]; then
    HERMES_SYNC_PASSWORD_VALUE="$(<"$HERMES_SYNC_PASSWORD_FILE_VALUE")"
  fi
  if [[ -z "${HERMES_SYNC_ENABLED_VALUE:-}" ]]; then
    if [[ -n "$HERMES_SYNC_PASSWORD_VALUE" || -r "$HERMES_SYNC_SSH_KEY_VALUE" ]]; then
      HERMES_SYNC_ENABLED_VALUE="true"
    else
      HERMES_SYNC_ENABLED_VALUE="false"
    fi
  fi
}

export_resolved_env() {
  export PORT="$PORT_VALUE"
  export HOST="$HOST_VALUE"
  export LLM3_SLOT_COUNT="$SLOT_COUNT_VALUE"
  export HERMES_SYNC_HOST="$HERMES_SYNC_HOST_VALUE"
  export HERMES_SYNC_USER="$HERMES_SYNC_USER_VALUE"
  export HERMES_SYNC_HOME="$HERMES_SYNC_HOME_VALUE"
  export HERMES_SYNC_SSH_KEY="$HERMES_SYNC_SSH_KEY_VALUE"
  export HERMES_SYNC_PYTHON="$HERMES_SYNC_PYTHON_VALUE"
  export HERMES_SYNC_CONFIG_PATH="$HERMES_SYNC_CONFIG_PATH_VALUE"
  export HERMES_SYNC_CACHE_PATH="$HERMES_SYNC_CACHE_PATH_VALUE"
  export HERMES_SYNC_SERVICE="$HERMES_SYNC_SERVICE_VALUE"
  export HERMES_SYNC_BASE_URL="$HERMES_SYNC_BASE_URL_VALUE"
  export HERMES_SYNC_PASSWORD_FILE="$HERMES_SYNC_PASSWORD_FILE_VALUE"
  export HERMES_SYNC_ENABLED="$HERMES_SYNC_ENABLED_VALUE"
  if [[ -n "$HERMES_SYNC_PASSWORD_VALUE" ]]; then
    export HERMES_SYNC_PASSWORD="$HERMES_SYNC_PASSWORD_VALUE"
  fi
}

ensure_pm2_launchagent() {
  cat >"$PM2_AGENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$PM2_AGENT_LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>$PM2_SAFE_RESURRECT</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$USER_HOME/.pm2/launchagent.log</string>
    <key>StandardErrorPath</key>
    <string>$USER_HOME/.pm2/launchagent.error.log</string>
    <key>WorkingDirectory</key>
    <string>$USER_HOME</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PM2_HOME</key>
      <string>$USER_HOME/.pm2</string>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
  </dict>
</plist>
EOF

  launchctl bootout "gui/$USER_ID/$PM2_AGENT_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$USER_ID" "$PM2_AGENT_PLIST" >/dev/null 2>&1 || true
  launchctl enable "gui/$USER_ID/$PM2_AGENT_LABEL" >/dev/null 2>&1 || true
}

stop_pm2_llm3() {
  "$PM2_BIN" delete llm3 >/dev/null 2>&1 || true
  "$PM2_BIN" save >/dev/null 2>&1 || true
}

stop_launchd_llm3() {
  sudo launchctl bootout "system/$LAUNCHD_LABEL" >/dev/null 2>&1 || true
}

kill_stray_llm3() {
  local pids
  pids="$(pgrep -f "$LLM3_DIR/src/server.js" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" && "$pid" != "$$" ]] || continue
      kill "$pid" >/dev/null 2>&1 || true
    done <<<"$pids"
  fi
  pids="$(lsof -tiTCP:"$PORT_VALUE" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      kill "$pid" >/dev/null 2>&1 || true
    done <<<"$pids"
  fi
}

write_launchd_plist() {
  if ! sudo -n true >/dev/null 2>&1; then
    echo "launchd mode requires passwordless sudo for /Library/LaunchDaemons management." >&2
    exit 1
  fi

  cat >"$TMP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LAUNCHD_LABEL</string>
    <key>UserName</key>
    <string>$USER_NAME</string>
    <key>GroupName</key>
    <string>staff</string>
    <key>WorkingDirectory</key>
    <string>$LLM3_DIR</string>
    <key>ProgramArguments</key>
    <array>
      <string>$NODE_BIN</string>
      <string>$LLM3_DIR/src/server.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>HOME</key>
      <string>$USER_HOME</string>
      <key>USER</key>
      <string>$USER_NAME</string>
      <key>LOGNAME</key>
      <string>$USER_NAME</string>
      <key>SHELL</key>
      <string>$SHELL_VALUE</string>
      <key>LANG</key>
      <string>$LANG_VALUE</string>
      <key>LC_ALL</key>
      <string>$LC_ALL_VALUE</string>
      <key>TMPDIR</key>
      <string>$TMPDIR_VALUE</string>
      <key>XDG_STATE_HOME</key>
      <string>$XDG_STATE_HOME_VALUE</string>
      <key>XDG_CACHE_HOME</key>
      <string>$XDG_CACHE_HOME_VALUE</string>
      <key>XDG_CONFIG_HOME</key>
      <string>$XDG_CONFIG_HOME_VALUE</string>
      <key>LLM3_STATE_DIR</key>
      <string>$LLM3_STATE_DIR_VALUE</string>
      <key>LLM3_SERVICE_MODE</key>
      <string>launchd</string>
      <key>LLM3_LAUNCHD_DOMAIN</key>
      <string>system</string>
      <key>LLM3_GUI_UID</key>
      <string>$USER_ID</string>
      <key>PORT</key>
      <string>$PORT_VALUE</string>
      <key>HOST</key>
      <string>$HOST_VALUE</string>
      <key>LLM3_SLOT_COUNT</key>
      <string>$SLOT_COUNT_VALUE</string>
      <key>HERMES_SYNC_HOST</key>
      <string>$HERMES_SYNC_HOST_VALUE</string>
      <key>HERMES_SYNC_USER</key>
      <string>$HERMES_SYNC_USER_VALUE</string>
      <key>HERMES_SYNC_HOME</key>
      <string>$HERMES_SYNC_HOME_VALUE</string>
      <key>HERMES_SYNC_SSH_KEY</key>
      <string>$HERMES_SYNC_SSH_KEY_VALUE</string>
      <key>HERMES_SYNC_PYTHON</key>
      <string>$HERMES_SYNC_PYTHON_VALUE</string>
      <key>HERMES_SYNC_CONFIG_PATH</key>
      <string>$HERMES_SYNC_CONFIG_PATH_VALUE</string>
      <key>HERMES_SYNC_CACHE_PATH</key>
      <string>$HERMES_SYNC_CACHE_PATH_VALUE</string>
      <key>HERMES_SYNC_SERVICE</key>
      <string>$HERMES_SYNC_SERVICE_VALUE</string>
      <key>HERMES_SYNC_BASE_URL</key>
      <string>$HERMES_SYNC_BASE_URL_VALUE</string>
      <key>HERMES_SYNC_PASSWORD_FILE</key>
      <string>$HERMES_SYNC_PASSWORD_FILE_VALUE</string>
      <key>HERMES_SYNC_ENABLED</key>
      <string>$HERMES_SYNC_ENABLED_VALUE</string>
EOF

  cat >>"$TMP_PLIST" <<EOF
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$STDOUT_LOG</string>
    <key>StandardErrorPath</key>
    <string>$STDERR_LOG</string>
  </dict>
</plist>
EOF

  sudo install -o root -g wheel -m 644 "$TMP_PLIST" "$LAUNCHD_PLIST"
  rm -f "$TMP_PLIST"
}

start_with_pm2() {
  ensure_pm2_launchagent
  "$PM2_BIN" start "$LLM3_DIR/ecosystem.config.cjs" --only llm3 --update-env >/dev/null
  "$PM2_BIN" save >/dev/null
}

start_with_launchd() {
  write_launchd_plist
  sudo launchctl bootstrap system "$LAUNCHD_PLIST" >/dev/null 2>&1
  sudo launchctl enable "system/$LAUNCHD_LABEL" >/dev/null 2>&1
  sudo launchctl kickstart -k "system/$LAUNCHD_LABEL"
}

remove_launchd_registration() {
  stop_launchd_llm3
  sudo rm -f "$LAUNCHD_PLIST"
}

show_status() {
  echo "Method: $METHOD"
  if [[ "$METHOD" == "pm2" ]]; then
    "$PM2_BIN" status llm3
  else
    sudo launchctl print "system/$LAUNCHD_LABEL" | sed -n '1,120p'
  fi
  echo "---"
  local attempt
  for attempt in {1..15}; do
    if curl -sf --max-time 2 "http://127.0.0.1:$PORT_VALUE/" >/dev/null; then
      echo "llm3 is responding on port $PORT_VALUE"
      return
    fi
    sleep 1
  done
  echo "llm3 did not become healthy on port $PORT_VALUE in time." >&2
  return 1
}

resolve_env
export_resolved_env
stop_pm2_llm3
stop_launchd_llm3
kill_stray_llm3
sleep 1

if [[ "$METHOD" == "pm2" ]]; then
  remove_launchd_registration
  start_with_pm2
else
  start_with_launchd
fi

sleep 2
show_status
