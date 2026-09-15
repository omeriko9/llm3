#!/bin/bash

set -euo pipefail

PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export PATH

USER_HOME="$HOME"
PM2_HOME="${PM2_HOME:-$USER_HOME/.pm2}"
export PM2_HOME

LOCK_DIR="$PM2_HOME/resurrect.lock"
DUMP_FILE="$PM2_HOME/dump.pm2"

mkdir -p "$PM2_HOME"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[pm2-safe-resurrect] another resurrect is already in progress; skipping"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ ! -s "$DUMP_FILE" ]]; then
  echo "[pm2-safe-resurrect] no dump file at $DUMP_FILE; skipping"
  exit 0
fi

pm2_list_count() {
  pm2 jlist 2>/dev/null | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(input);
    console.log(Array.isArray(parsed) ? parsed.length : 0);
  } catch {
    process.exit(1);
  }
});
' 2>/dev/null
}

if current_count="$(pm2_list_count)"; then
  if [[ "${current_count:-0}" =~ ^[0-9]+$ ]] && [[ "$current_count" -gt 0 ]]; then
    echo "[pm2-safe-resurrect] PM2 already has $current_count process entries; skipping resurrect"
    exit 0
  fi
fi

echo "[pm2-safe-resurrect] restoring PM2 from $DUMP_FILE"
pm2 resurrect
