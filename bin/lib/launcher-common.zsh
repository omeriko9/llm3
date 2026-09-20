# Shared helpers for the zsh launchers in bin/ (run-*.sh).
#
# Source it right after `set -euo pipefail`:
#
#   SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
#   source "$SCRIPT_DIR/lib/launcher-common.zsh"
#
# Everything here is zsh: `match` (not BASH_REMATCH), `${1:u}`, `(( ))`.
# bin/qwen_llama and bin/voice-*.sh are bash 3.2 scripts and keep their own
# copies of these helpers.

# Interpreter for the small JSON/process helpers below. Always the system
# python: a launcher's venv may not exist yet (status and defaults are read
# before anything is installed), and the helpers use the standard library only.
LLM3_HELPER_PYTHON="${LLM3_HELPER_PYTHON:-/usr/bin/python3}"
if [[ ! -x "${LLM3_HELPER_PYTHON}" ]]; then
  LLM3_HELPER_PYTHON="python3"
fi

# slotN -> N. Exits with a usage error for anything else.
slot_index() {
  local raw="$1"
  if [[ "${raw}" =~ ^slot([1-9][0-9]*)$ ]]; then
    printf '%s\n' "${match[1]}"
    return 0
  fi
  echo "Invalid slot: ${raw}. Use slot1, slot2, slot3, ..." >&2
  exit 1
}

# "262144" | "256K" | "1M" -> token count. Exits with an error otherwise.
parse_context_size() {
  local raw="${1:u}"
  if [[ "${raw}" =~ ^[0-9]+$ ]]; then
    echo "${raw}"
    return 0
  fi

  if [[ "${raw}" =~ ^([0-9]+)K$ ]]; then
    echo $(( ${match[1]} * 1024 ))
    return 0
  fi

  if [[ "${raw}" =~ ^([0-9]+)M$ ]]; then
    echo $(( ${match[1]} * 1024 * 1024 ))
    return 0
  fi

  echo "Invalid context size: ${1}. Use a raw token count or suffix K/M, e.g. 262144 or 256K." >&2
  exit 1
}

# Token count -> short label ("256K", "1M", "4096").
context_label() {
  local value="$1"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "${value}"
    return 0
  fi

  if (( value >= 1048576 && value % 1048576 == 0 )); then
    echo "$(( value / 1048576 ))M"
    return 0
  fi

  if (( value >= 1024 && value % 1024 == 0 )); then
    echo "$(( value / 1024 ))K"
    return 0
  fi

  echo "${value}"
}

# Byte count -> "12.34 GB".
format_bytes() {
  "${LLM3_HELPER_PYTHON}" - <<'PY' "$1"
import sys

value = int(float(sys.argv[1] or 0))
units = ["B", "KB", "MB", "GB", "TB"]
amount = float(value)
index = 0
while amount >= 1024 and index < len(units) - 1:
    amount /= 1024
    index += 1
print(f"{amount:.2f} {units[index]}" if index else f"{int(amount)} B")
PY
}

# wait_for_http URL [TIMEOUT_SECONDS=180] [extra curl args...]
# Polls once per second until curl gets a 2xx/3xx, e.g.
#   wait_for_http "http://127.0.0.1:${PORT}/v1/models" 180 -H "X-API-Key: ${API_KEY}"
wait_for_http() {
  local url="$1"
  local timeout="${2:-180}"
  shift 2 2>/dev/null || shift $#
  local count=0

  while (( count < timeout )); do
    if curl -fsS -m 5 "$@" "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    count=$(( count + 1 ))
  done

  return 1
}

# serve_behind_slot_proxy BACKEND_PORT PUBLIC_HOST PUBLIC_PORT PROXY_LOG TRAFFIC_LOG -- COMMAND [ARGS...]
# For a launcher's --foreground process. Starts COMMAND (a server that must bind
# 127.0.0.1:BACKEND_PORT) in the background, waits for its /v1/models, then puts
# src/slot-api-proxy.py on the slot's public port in front of it.
#
# The proxy is what writes the "[thinking]" / "[answer]" stream lines that llm3's
# Logs -> Thinking tab reads, and the request/response pairs of the Traffic tab.
# A server that bound the public port itself (mlx-dspark, mlx-vlm) left both tabs
# empty. --no-sampling-defaults keeps the proxy from adding sampling keys the
# client did not send, so the backend decodes exactly as it did without a proxy.
#
# COMMAND keeps this process's stdout (the launcher's server log); the proxy
# writes to PROXY_LOG, so server output never lands inside a thinking block.
# Never returns: when either process exits, or this process gets INT/TERM, both
# are stopped and the function exits (non-zero unless stopped by a signal).
serve_behind_slot_proxy() {
  local backend_port="$1" public_host="$2" public_port="$3" proxy_log="$4" traffic_log="$5"
  shift 5
  [[ "${1:-}" == "--" ]] && shift
  # SCRIPT_DIR is the launcher's bin/ (set before this file is sourced); $0 in a
  # zsh function is the function name, so it cannot locate the repo.
  local proxy_script="${SCRIPT_DIR:h}/src/slot-api-proxy.py"
  if [[ ! -f "${proxy_script}" ]]; then
    echo "Missing proxy script ${proxy_script}" >&2
    exit 1
  fi

  typeset -g _SLOT_PAIR_BACKEND_PID="" _SLOT_PAIR_PROXY_PID=""
  # Not an EXIT trap: in zsh an EXIT trap set inside a function fires when the
  # function returns, not when the script exits. Every exit path below calls the
  # cleanup itself; signals go through INT/TERM.
  _slot_pair_stop() {
    local pid="" waited=0
    for pid in "${_SLOT_PAIR_PROXY_PID}" "${_SLOT_PAIR_BACKEND_PID}"; do
      [[ -n "${pid}" ]] && kill "${pid}" 2>/dev/null || true
    done
    # An MLX server can take seconds to release its weights; wait for it, so a
    # relaunch right after a stop does not load a second copy next to the first.
    while (( waited < 30 )); do
      kill -0 "${_SLOT_PAIR_BACKEND_PID:-0}" 2>/dev/null || kill -0 "${_SLOT_PAIR_PROXY_PID:-0}" 2>/dev/null || break
      sleep 0.5
      waited=$(( waited + 1 ))
    done
    for pid in "${_SLOT_PAIR_PROXY_PID}" "${_SLOT_PAIR_BACKEND_PID}"; do
      [[ -n "${pid}" ]] && kill -9 "${pid}" 2>/dev/null || true
    done
  }
  trap '_slot_pair_stop; exit 143' INT TERM

  "$@" &
  _SLOT_PAIR_BACKEND_PID=$!
  local count=0
  until curl -fsS -m 5 "http://127.0.0.1:${backend_port}/v1/models" >/dev/null 2>&1; do
    if ! kill -0 "${_SLOT_PAIR_BACKEND_PID}" 2>/dev/null; then
      echo "Backend exited before it served 127.0.0.1:${backend_port}" >&2
      _slot_pair_stop
      exit 1
    fi
    if (( count >= 300 )); then
      echo "Backend did not serve 127.0.0.1:${backend_port} within 300s" >&2
      _slot_pair_stop
      exit 1
    fi
    sleep 1
    count=$(( count + 1 ))
  done

  "${LLM3_HELPER_PYTHON}" -u "${proxy_script}" \
    --host "${public_host}" \
    --port "${public_port}" \
    --backend-host 127.0.0.1 \
    --backend-port "${backend_port}" \
    --traffic-log "${traffic_log}" \
    --no-sampling-defaults \
    >>"${proxy_log}" 2>&1 &
  _SLOT_PAIR_PROXY_PID=$!
  echo "Proxy ${public_host}:${public_port} -> 127.0.0.1:${backend_port} (log ${proxy_log})"

  while kill -0 "${_SLOT_PAIR_BACKEND_PID}" 2>/dev/null && kill -0 "${_SLOT_PAIR_PROXY_PID}" 2>/dev/null; do
    sleep 1
  done
  if kill -0 "${_SLOT_PAIR_BACKEND_PID}" 2>/dev/null; then
    echo "Slot proxy on ${public_port} exited; stopping the backend" >&2
  else
    echo "Backend on ${backend_port} exited; stopping the slot proxy" >&2
  fi
  _slot_pair_stop
  exit 1
}

# kill_port_listener PORT
# Stops whatever listens on PORT. netstat, never lsof: lsof walks every
# descriptor on the box and stalls on a hung network mount.
kill_port_listener() {
  local port="$1" holder=""
  [[ -n "${port}" ]] || return 0
  holder="$(netstat -anv -p tcp 2>/dev/null | awk -v port="${port}" '$6=="LISTEN" && $4 ~ ("\\."port"$") {print $11}' | sed 's/.*://' | head -1 || true)"
  if [[ -n "${holder}" && "${holder}" != "0" ]] && kill -0 "${holder}" 2>/dev/null; then
    kill "${holder}" 2>/dev/null || true
    sleep 1
    kill -0 "${holder}" 2>/dev/null && kill -9 "${holder}" 2>/dev/null || true
  fi
  return 0
}

# spawn_detached LOG_FILE COMMAND [ARGS...]
# Starts COMMAND in its own session with stdout+stderr appended to LOG_FILE and
# prints its pid. The child survives the launcher (and a pm2 restart of the
# dashboard) because it is no longer in the launcher's process group.
spawn_detached() {
  local log_file="$1"
  shift

  "${LLM3_HELPER_PYTHON}" - "$log_file" "$@" <<'PY'
import subprocess
import sys

log_file = sys.argv[1]
args = sys.argv[2:]

with open("/dev/null", "rb") as stdin, open(log_file, "ab", buffering=0) as log:
    proc = subprocess.Popen(
        args,
        stdin=stdin,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    print(proc.pid)
PY
}

# Reads the eight sampling keys from $DEFAULTS_FILE into DEFAULT_* variables.
# Accepts both "contextSize" and the older "ctxSize" spelling. Missing file or
# missing keys leave the variables untouched.
load_defaults() {
  [[ -f "${DEFAULTS_FILE}" ]] || return 0

  while IFS=$'\t' read -r key value; do
    [[ -n "${value}" ]] || continue
    case "${key}" in
      context_size) DEFAULT_CONTEXT_SIZE="${value}" ;;
      parallel) DEFAULT_PARALLEL="${value}" ;;
      temperature) DEFAULT_TEMPERATURE="${value}" ;;
      top_p) DEFAULT_TOP_P="${value}" ;;
      top_k) DEFAULT_TOP_K="${value}" ;;
      min_p) DEFAULT_MIN_P="${value}" ;;
      presence_penalty) DEFAULT_PRESENCE_PENALTY="${value}" ;;
      repetition_penalty) DEFAULT_REPETITION_PENALTY="${value}" ;;
    esac
  done < <(
    "${LLM3_HELPER_PYTHON}" - <<'PY' "${DEFAULTS_FILE}"
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    raise SystemExit(0)
if not isinstance(data, dict):
    raise SystemExit(0)

context = data.get("contextSize", data.get("ctxSize", ""))
print(f"context_size\t{context if context is not None else ''}")
for key, name in (
    ("parallel", "parallel"),
    ("temperature", "temperature"),
    ("topP", "top_p"),
    ("topK", "top_k"),
    ("minP", "min_p"),
    ("presencePenalty", "presence_penalty"),
    ("repetitionPenalty", "repetition_penalty"),
):
    value = data.get(key, "")
    print(f"{name}\t{value if value is not None else ''}")
PY
  )
}
