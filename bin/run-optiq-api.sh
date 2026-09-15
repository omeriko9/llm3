#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
source "$SCRIPT_DIR/lib/launcher-common.zsh"
LLM3_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SLOT_PROXY_SCRIPT="$LLM3_ROOT/src/slot-api-proxy.py"

VENV="${LLM3_VENV_ROOT:-$HOME/.venvs}/mlx-optiq"
MODELS_DIR="${LLM3_MODELS_DIR:-$HOME/models}"
SLOT="${OPTIQ_SLOT:-slot1}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/optiq_api"
STATE_DIR="${OPTIQ_STATE_DIR:-}"
STATE_FILE=""
DEFAULTS_FILE=""
PID_FILE="${OPTIQ_PID_FILE:-}"
BACKEND_PID_FILE=""
PUBLIC_LOG_FILE="${OPTIQ_LOG_FILE:-}"
SERVER_LOG_FILE="${OPTIQ_SERVER_LOG_FILE:-}"
TRAFFIC_LOG_FILE="${OPTIQ_TRAFFIC_LOG_FILE:-}"
MODEL_ARG=""
MODEL_DIR=""
MODEL_LABEL=""
MODEL_RUNTIME_ID=""
MODEL_FAMILY=""
MODEL_HF_URL=""
MODEL_SIZE_LABEL=""
TARGET_MODEL_DIR=""
DRAFTER_MODEL_DIR=""

HOST="${OPTIQ_HOST:-0.0.0.0}"
PORT="${OPTIQ_PORT:-}"
BACKEND_PORT="${OPTIQ_BACKEND_PORT:-}"

DEFAULT_CONTEXT_SIZE="${OPTIQ_CONTEXT_SIZE:-32768}"
DEFAULT_PARALLEL="${OPTIQ_PARALLEL:-1}"
DEFAULT_PROMPT_CACHE_BYTES="${OPTIQ_PROMPT_CACHE_BYTES:-536870912}"
DEFAULT_PREFILL_STEP_SIZE="${OPTIQ_PREFILL_STEP_SIZE:-256}"
DEFAULT_TEMPERATURE="${OPTIQ_TEMPERATURE:-0.7}"
DEFAULT_TOP_P="${OPTIQ_TOP_P:-0.95}"
DEFAULT_TOP_K="${OPTIQ_TOP_K:-40}"
DEFAULT_MIN_P="${OPTIQ_MIN_P:-0.0}"
DEFAULT_PRESENCE_PENALTY="${OPTIQ_PRESENCE_PENALTY:-0.0}"
DEFAULT_REPETITION_PENALTY="${OPTIQ_REPETITION_PENALTY:-1.0}"

MODE="daemon"
RUN_MODE="start"
CONTEXT_SIZE=""
PARALLEL=""
PROMPT_CACHE_BYTES=""
PREFILL_STEP_SIZE=""
TEMPERATURE=""
TOP_P=""
TOP_K=""
MIN_P=""
PRESENCE_PENALTY=""
REPETITION_PENALTY=""
SKIP_STOP="0"

usage() {
  cat <<EOF
Usage: $0 [--slot slotN] --model NAME|PATH [--context-size SIZE] [--parallel N]
       $0 [--slot slotN] --defaults-json
       $0 [--slot slotN] --set-defaults --context-size SIZE --parallel N
       $0 [--slot slotN] --status-json
       $0 [--slot slotN] --stop
       $0 --list-json

Notes:
  - OptIQ serves Gemma pair bundles that contain:
      mtplx_pair.json
      target/
      assistant/
  - The public llm3 slot API is exposed on the normal slot port (8036+N),
    while the OptIQ backend itself listens on a hidden backend port (18836+N).
EOF
}

configure_slot() {
  local index=""
  index="$(slot_index "${SLOT}")"

  if [[ -z "${STATE_DIR}" ]]; then
    if [[ "${SLOT}" == "slot1" ]]; then
      STATE_DIR="${STATE_ROOT}"
    else
      STATE_DIR="${STATE_ROOT}/${SLOT}"
    fi
  fi

  if [[ -z "${PORT}" ]]; then
    PORT="$((8036 + index - 1))"
  fi
  if [[ -z "${BACKEND_PORT}" ]]; then
    BACKEND_PORT="$((18836 + index - 1))"
  fi

  if [[ -z "${PUBLIC_LOG_FILE}" ]]; then
    PUBLIC_LOG_FILE="${STATE_DIR}/proxy.log"
  fi
  if [[ -z "${SERVER_LOG_FILE}" ]]; then
    SERVER_LOG_FILE="${STATE_DIR}/optiq-server.log"
  fi
  if [[ -z "${TRAFFIC_LOG_FILE}" ]]; then
    TRAFFIC_LOG_FILE="${STATE_DIR}/traffic.log"
  fi
  if [[ -z "${PID_FILE}" ]]; then
    PID_FILE="${STATE_DIR}/proxy.pid"
  fi

  STATE_FILE="${STATE_DIR}/current.json"
  DEFAULTS_FILE="${STATE_DIR}/defaults.json"
  BACKEND_PID_FILE="${STATE_DIR}/backend.pid"
  mkdir -p "${STATE_DIR}"
}

resolve_model_dir() {
  local name="$1"
  if [[ -d "${name}" ]]; then
    echo "${name}"
    return 0
  fi
  if [[ -d "${MODELS_DIR}/hf/${name}" ]]; then
    echo "${MODELS_DIR}/hf/${name}"
    return 0
  fi
  if [[ -d "${MODELS_DIR}/${name}" ]]; then
    echo "${MODELS_DIR}/${name}"
    return 0
  fi
  echo ""
}

is_pair_bundle_dir() {
  local dir="$1"
  [[ -d "${dir}" ]] || return 1
  [[ -f "${dir}/mtplx_pair.json" ]] || return 1
  [[ -d "${dir}/target" ]] || return 1
  [[ -d "${dir}/assistant" ]] || return 1
  [[ -f "${dir}/target/config.json" ]] || return 1
  [[ -f "${dir}/assistant/config.json" ]] || return 1
  return 0
}

load_dynamic_hf_metadata() {
  /usr/bin/python3 - <<'PY' "$1" "${MODELS_DIR}/hf"
import json
import sys
from pathlib import Path

target = Path(sys.argv[1]).resolve()
root = Path(sys.argv[2]).resolve()
current = target

while True:
    metadata_path = current / ".llm3-hf.json"
    if metadata_path.exists():
        try:
            data = json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        aliases = data.get("aliases") or []
        if not isinstance(aliases, list):
            aliases = []
        print(f"label\t{data.get('label') or ''}")
        print(f"family\t{data.get('family') or ''}")
        print(f"hf_url\t{data.get('hfUrl') or ''}")
        print("aliases\t" + ",".join(str(value).strip() for value in aliases if str(value).strip()))
        raise SystemExit(0)
    if current == root or current.parent == current or root not in current.parents:
        break
    current = current.parent

print("label\t")
print("family\t")
print("hf_url\t")
print("aliases\t")
PY
}

resolve_model_info() {
  local metadata=""
  local meta_label=""
  local meta_family=""
  local meta_hf_url=""
  local meta_aliases=""
  local basename_name=""
  local size_bytes=""

  MODEL_DIR="$(resolve_model_dir "${MODEL_ARG}")"
  if [[ -z "${MODEL_DIR}" ]]; then
    echo "Error: Model '${MODEL_ARG}' not found in ${MODELS_DIR} or ${MODELS_DIR}/hf/" >&2
    exit 1
  fi
  if ! is_pair_bundle_dir "${MODEL_DIR}"; then
    echo "Error: '${MODEL_DIR}' is not an OptIQ pair bundle (missing mtplx_pair.json + target/assistant)." >&2
    exit 1
  fi

  TARGET_MODEL_DIR="${MODEL_DIR}/target"
  DRAFTER_MODEL_DIR="${MODEL_DIR}/assistant"
  MODEL_RUNTIME_ID="${MODEL_DIR:t}"
  basename_name="${MODEL_DIR:t}"
  size_bytes="$(find "${MODEL_DIR}" -type f -not -name '.llm3-hf.json' -exec stat -f '%z' {} + 2>/dev/null | awk '{sum += $1} END {print sum + 0}')"

  metadata="$(load_dynamic_hf_metadata "${MODEL_DIR}")"
  while IFS=$'\t' read -r key value; do
    case "${key}" in
      label) meta_label="${value}" ;;
      family) meta_family="${value}" ;;
      hf_url) meta_hf_url="${value}" ;;
      aliases) meta_aliases="${value}" ;;
    esac
  done <<EOF
$metadata
EOF

  MODEL_LABEL="${meta_label:-${basename_name}}"
  MODEL_FAMILY="${meta_family:-Gemma 4}"
  MODEL_HF_URL="${meta_hf_url:-}"
  MODEL_SIZE_LABEL="$(format_bytes "${size_bytes:-0}")"
}

defaults_json() {
  cat <<EOF
{
  "contextSize": ${DEFAULT_CONTEXT_SIZE},
  "parallel": ${DEFAULT_PARALLEL},
  "temperature": ${DEFAULT_TEMPERATURE},
  "topP": ${DEFAULT_TOP_P},
  "topK": ${DEFAULT_TOP_K},
  "minP": ${DEFAULT_MIN_P},
  "presencePenalty": ${DEFAULT_PRESENCE_PENALTY},
  "repetitionPenalty": ${DEFAULT_REPETITION_PENALTY}
}
EOF
}

save_defaults() {
  cat >"${DEFAULTS_FILE}" <<EOF
{
  "contextSize": ${CONTEXT_SIZE},
  "parallel": ${PARALLEL},
  "temperature": ${TEMPERATURE},
  "topP": ${TOP_P},
  "topK": ${TOP_K},
  "minP": ${MIN_P},
  "presencePenalty": ${PRESENCE_PENALTY},
  "repetitionPenalty": ${REPETITION_PENALTY}
}
EOF
}

stop_previous_instance() {
  local pids=()
  local pid=""

  if [[ -f "${PID_FILE}" ]]; then
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      pids+=("${pid}")
    fi
  fi

  if [[ -f "${BACKEND_PID_FILE}" ]]; then
    pid="$(cat "${BACKEND_PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      pids+=("${pid}")
    fi
  fi

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && pids+=("${pid}")
  done < <(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && pids+=("${pid}")
  done < <(lsof -tiTCP:"${BACKEND_PORT}" -sTCP:LISTEN 2>/dev/null || true)

  if (( ${#pids[@]} > 0 )); then
    pids=("${(@u)pids}")
    kill "${pids[@]}" 2>/dev/null || true
    sleep 2
    kill -9 "${pids[@]}" 2>/dev/null || true
  fi

  rm -f "${PID_FILE}" "${BACKEND_PID_FILE}" "${STATE_FILE}"
}

write_state_file() {
  local proxy_pid="$1"
  local backend_pid="$2"
  cat >"${STATE_FILE}" <<EOF
{
  "running": true,
  "slot": "${SLOT}",
  "model": {
    "key": "${MODEL_DIR}",
    "modelId": "${MODEL_RUNTIME_ID}",
    "runtimeId": "${MODEL_RUNTIME_ID}",
    "label": "${MODEL_LABEL}",
    "family": "${MODEL_FAMILY}",
    "path": "${MODEL_DIR}",
    "hfUrl": "${MODEL_HF_URL}",
    "sizeLabel": "${MODEL_SIZE_LABEL}",
    "runtime": "mlx",
    "launcher": "optiq"
  },
  "params": {
    "ctxSize": ${CONTEXT_SIZE},
    "parallel": ${PARALLEL},
    "thinking": false,
    "temperature": ${TEMPERATURE},
    "topP": ${TOP_P},
    "topK": ${TOP_K},
    "minP": ${MIN_P},
    "presencePenalty": ${PRESENCE_PENALTY},
    "repetitionPenalty": ${REPETITION_PENALTY},
    "threads": null,
    "threadsBatch": null,
    "batchSize": null,
    "ubatchSize": null,
    "gpuLayers": null
  },
  "network": {
    "publicHost": "${HOST}",
    "publicPort": ${PORT},
    "backendHost": "127.0.0.1",
    "backendPort": ${BACKEND_PORT}
  },
  "logs": {
    "server": "${SERVER_LOG_FILE}",
    "traffic": "${TRAFFIC_LOG_FILE}",
    "proxy": "${PUBLIC_LOG_FILE}"
  },
  "pids": {
    "proxy": ${proxy_pid},
    "backend": ${backend_pid}
  },
  "startedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
}

status_json() {
  /usr/bin/python3 - <<'PY' "${STATE_FILE}" "${PID_FILE}" "${BACKEND_PID_FILE}" "${SERVER_LOG_FILE}" "${TRAFFIC_LOG_FILE}" "${PUBLIC_LOG_FILE}"
import json
import os
import sys
from pathlib import Path

state_path = Path(sys.argv[1])
proxy_pid_path = Path(sys.argv[2])
backend_pid_path = Path(sys.argv[3])
server_log = sys.argv[4]
traffic_log = sys.argv[5]
proxy_log = sys.argv[6]

def pid_alive(value):
    try:
        os.kill(value, 0)
    except Exception:
        return False
    return True

if not state_path.exists():
    print(json.dumps({"running": False, "logs": {"server": server_log, "traffic": traffic_log, "proxy": proxy_log}}, indent=2))
    raise SystemExit(0)

data = json.loads(state_path.read_text())
proxy_pid = data.get("pids", {}).get("proxy")
backend_pid = data.get("pids", {}).get("backend")
running = bool(proxy_pid and pid_alive(int(proxy_pid)))
if backend_pid:
    running = running and pid_alive(int(backend_pid))

data["running"] = running

if not running:
    for path in (proxy_pid_path, backend_pid_path, state_path):
        try:
            Path(path).unlink()
        except FileNotFoundError:
            pass
    print(json.dumps({"running": False, "logs": {"server": server_log, "traffic": traffic_log, "proxy": proxy_log}}, indent=2))
else:
    print(json.dumps(data, indent=2))
PY
}

list_json() {
  /usr/bin/python3 - "${MODELS_DIR}" <<'PY'
import json
import os
import sys
from pathlib import Path

models_root = Path(sys.argv[1]).expanduser()

def prettify(name):
    return " ".join(str(name).replace("-", " ").replace("_", " ").split()).strip()

def is_pair_bundle(path: Path) -> bool:
    return (
        path.is_dir()
        and (path / "mtplx_pair.json").is_file()
        and (path / "target").is_dir()
        and (path / "assistant").is_dir()
        and (path / "target" / "config.json").is_file()
        and (path / "assistant" / "config.json").is_file()
    )

def read_metadata(path: Path) -> dict:
    metadata_path = path / ".llm3-hf.json"
    if not metadata_path.is_file():
        return {}
    try:
        return json.loads(metadata_path.read_text(encoding="utf-8"))
    except Exception:
        return {}

def compute_size_bytes(path: Path) -> int:
    total = 0
    for child in path.rglob("*"):
        if child.is_file() and child.name != ".llm3-hf.json":
            try:
                total += child.stat().st_size
            except OSError:
                pass
    return total

def format_bytes(value: int) -> str:
    amount = float(value)
    units = ["B", "KB", "MB", "GB", "TB"]
    index = 0
    while amount >= 1024 and index < len(units) - 1:
        amount /= 1024
        index += 1
    return f"{amount:.2f} {units[index]}" if index else f"{int(amount)} B"

results = []
seen = set()
search_roots = [models_root / "hf", models_root]

for root in search_roots:
    if not root.is_dir():
        continue
    for entry in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if not is_pair_bundle(entry):
            continue
        resolved = str(entry.resolve())
        if resolved in seen:
            continue
        seen.add(resolved)
        metadata = read_metadata(entry)
        size_bytes = compute_size_bytes(entry)
        aliases = metadata.get("aliases") or []
        if not isinstance(aliases, list):
            aliases = []
        if entry.name not in aliases:
            aliases = [entry.name, *aliases]
        results.append({
            "key": resolved,
            "label": metadata.get("label") or prettify(entry.name),
            "path": resolved,
            "runtime": "mlx",
            "launcher": "optiq",
            "family": metadata.get("family") or "Gemma 4",
            "hfUrl": metadata.get("hfUrl") or "",
            "sizeBytes": size_bytes,
            "sizeLabel": format_bytes(size_bytes),
            "aliases": aliases,
        })

print(json.dumps(results, indent=2))
PY
}

start_backend() {
  : > "${SERVER_LOG_FILE}"
  "${VENV}/bin/optiq" serve \
    --model "${TARGET_MODEL_DIR}" \
    --drafter "${DRAFTER_MODEL_DIR}" \
    --host "127.0.0.1" \
    --port "${BACKEND_PORT}" \
    --no-auth \
    --responses \
    --anthropic \
    --decode-concurrency "${PARALLEL}" \
    --prompt-concurrency "1" \
    --prefill-step-size "${PREFILL_STEP_SIZE}" \
    --prompt-cache-bytes "${PROMPT_CACHE_BYTES}" \
    --temp "${TEMPERATURE}" \
    --top-p "${TOP_P}" \
    --top-k "${TOP_K}" \
    --min-p "${MIN_P}" >> "${SERVER_LOG_FILE}" 2>&1 &
  echo $! > "${BACKEND_PID_FILE}"
}

cleanup_backend() {
  local pid=""
  if [[ -f "${BACKEND_PID_FILE}" ]]; then
    pid="$(cat "${BACKEND_PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
      sleep 2
      kill -9 "${pid}" 2>/dev/null || true
    fi
  fi
}

run_proxy_forever() {
  trap 'cleanup_backend' EXIT INT TERM
  start_backend
  if ! wait_for_http "http://127.0.0.1:${BACKEND_PORT}/v1/models" 300; then
    echo "OptIQ backend failed to become ready on port ${BACKEND_PORT}" >&2
    exit 1
  fi
  "${VENV}/bin/python" "${SLOT_PROXY_SCRIPT}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --backend-host "127.0.0.1" \
    --backend-port "${BACKEND_PORT}" \
    --traffic-log "${TRAFFIC_LOG_FILE}" \
    --advertised-model-id "${MODEL_RUNTIME_ID}" \
    --advertised-model-label "${MODEL_LABEL}" \
    --backend-model-id "${TARGET_MODEL_DIR}" \
    --context-size "${CONTEXT_SIZE}" \
    --default-temperature "${TEMPERATURE}" \
    --default-top-p "${TOP_P}" \
    --default-top-k "${TOP_K}" \
    --default-min-p "${MIN_P}" \
    --default-presence-penalty "${PRESENCE_PENALTY}" \
    --default-repetition-penalty "${REPETITION_PENALTY}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      [[ $# -ge 2 ]] || { echo "--model requires a value" >&2; exit 1; }
      MODEL_ARG="$2"
      shift 2
      ;;
    --slot)
      [[ $# -ge 2 ]] || { echo "--slot requires a value" >&2; exit 1; }
      SLOT="$2"
      shift 2
      ;;
    --host)
      [[ $# -ge 2 ]] || { echo "--host requires a value" >&2; exit 1; }
      HOST="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || { echo "--port requires a value" >&2; exit 1; }
      PORT="$2"
      shift 2
      ;;
    --backend-port)
      [[ $# -ge 2 ]] || { echo "--backend-port requires a value" >&2; exit 1; }
      BACKEND_PORT="$2"
      shift 2
      ;;
    --log-file)
      [[ $# -ge 2 ]] || { echo "--log-file requires a value" >&2; exit 1; }
      PUBLIC_LOG_FILE="$2"
      shift 2
      ;;
    --server-log-file)
      [[ $# -ge 2 ]] || { echo "--server-log-file requires a value" >&2; exit 1; }
      SERVER_LOG_FILE="$2"
      shift 2
      ;;
    --traffic-log-file)
      [[ $# -ge 2 ]] || { echo "--traffic-log-file requires a value" >&2; exit 1; }
      TRAFFIC_LOG_FILE="$2"
      shift 2
      ;;
    --pid-file)
      [[ $# -ge 2 ]] || { echo "--pid-file requires a value" >&2; exit 1; }
      PID_FILE="$2"
      shift 2
      ;;
    --state-dir)
      [[ $# -ge 2 ]] || { echo "--state-dir requires a value" >&2; exit 1; }
      STATE_DIR="$2"
      shift 2
      ;;
    --context-size)
      [[ $# -ge 2 ]] || { echo "--context-size requires a value" >&2; exit 1; }
      CONTEXT_SIZE="$2"
      shift 2
      ;;
    --parallel)
      [[ $# -ge 2 ]] || { echo "--parallel requires a value" >&2; exit 1; }
      PARALLEL="$2"
      shift 2
      ;;
    --prompt-cache-bytes)
      [[ $# -ge 2 ]] || { echo "--prompt-cache-bytes requires a value" >&2; exit 1; }
      PROMPT_CACHE_BYTES="$2"
      shift 2
      ;;
    --prefill-step-size)
      [[ $# -ge 2 ]] || { echo "--prefill-step-size requires a value" >&2; exit 1; }
      PREFILL_STEP_SIZE="$2"
      shift 2
      ;;
    --temperature)
      [[ $# -ge 2 ]] || { echo "--temperature requires a value" >&2; exit 1; }
      TEMPERATURE="$2"
      shift 2
      ;;
    --top-p)
      [[ $# -ge 2 ]] || { echo "--top-p requires a value" >&2; exit 1; }
      TOP_P="$2"
      shift 2
      ;;
    --top-k)
      [[ $# -ge 2 ]] || { echo "--top-k requires a value" >&2; exit 1; }
      TOP_K="$2"
      shift 2
      ;;
    --min-p)
      [[ $# -ge 2 ]] || { echo "--min-p requires a value" >&2; exit 1; }
      MIN_P="$2"
      shift 2
      ;;
    --presence-penalty)
      [[ $# -ge 2 ]] || { echo "--presence-penalty requires a value" >&2; exit 1; }
      PRESENCE_PENALTY="$2"
      shift 2
      ;;
    --repetition-penalty)
      [[ $# -ge 2 ]] || { echo "--repetition-penalty requires a value" >&2; exit 1; }
      REPETITION_PENALTY="$2"
      shift 2
      ;;
    --foreground)
      MODE="foreground"
      shift
      ;;
    --skip-stop)
      SKIP_STOP="1"
      shift
      ;;
    --defaults-json)
      RUN_MODE="defaults-json"
      shift
      ;;
    --set-defaults|--set-default)
      RUN_MODE="set-defaults"
      shift
      ;;
    --status-json)
      RUN_MODE="status-json"
      shift
      ;;
    --stop)
      RUN_MODE="stop"
      shift
      ;;
    --list-json)
      configure_slot
      list_json
      exit 0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

configure_slot
load_defaults
[[ -n "${CONTEXT_SIZE}" ]] || CONTEXT_SIZE="${DEFAULT_CONTEXT_SIZE}"
[[ -n "${PARALLEL}" ]] || PARALLEL="${DEFAULT_PARALLEL}"
[[ -n "${PROMPT_CACHE_BYTES}" ]] || PROMPT_CACHE_BYTES="${DEFAULT_PROMPT_CACHE_BYTES}"
[[ -n "${PREFILL_STEP_SIZE}" ]] || PREFILL_STEP_SIZE="${DEFAULT_PREFILL_STEP_SIZE}"
[[ -n "${TEMPERATURE}" ]] || TEMPERATURE="${DEFAULT_TEMPERATURE}"
[[ -n "${TOP_P}" ]] || TOP_P="${DEFAULT_TOP_P}"
[[ -n "${TOP_K}" ]] || TOP_K="${DEFAULT_TOP_K}"
[[ -n "${MIN_P}" ]] || MIN_P="${DEFAULT_MIN_P}"
[[ -n "${PRESENCE_PENALTY}" ]] || PRESENCE_PENALTY="${DEFAULT_PRESENCE_PENALTY}"
[[ -n "${REPETITION_PENALTY}" ]] || REPETITION_PENALTY="${DEFAULT_REPETITION_PENALTY}"

if [[ "${RUN_MODE}" == "defaults-json" ]]; then
  defaults_json
  exit 0
fi

if [[ "${RUN_MODE}" == "set-defaults" ]]; then
  save_defaults
  defaults_json
  exit 0
fi

if [[ "${RUN_MODE}" == "status-json" ]]; then
  status_json
  exit 0
fi

if [[ "${RUN_MODE}" == "stop" ]]; then
  stop_previous_instance
  echo "Stopped."
  exit 0
fi

[[ -n "${MODEL_ARG}" ]] || { usage; exit 1; }
[[ -x "${VENV}/bin/optiq" ]] || { echo "Missing optiq binary in ${VENV}" >&2; exit 1; }
[[ -f "${SLOT_PROXY_SCRIPT}" ]] || { echo "Missing proxy script ${SLOT_PROXY_SCRIPT}" >&2; exit 1; }

resolve_model_info

if [[ "${SKIP_STOP}" != "1" ]]; then
  stop_previous_instance
fi

: > "${PUBLIC_LOG_FILE}"
: > "${TRAFFIC_LOG_FILE}"

if [[ "${MODE}" == "daemon" ]]; then
  daemon_pid="$(
    spawn_detached "${PUBLIC_LOG_FILE}" "$0" --foreground --skip-stop --slot "${SLOT}" --host "${HOST}" --port "${PORT}" --backend-port "${BACKEND_PORT}" --state-dir "${STATE_DIR}" --log-file "${PUBLIC_LOG_FILE}" --server-log-file "${SERVER_LOG_FILE}" --traffic-log-file "${TRAFFIC_LOG_FILE}" --pid-file "${PID_FILE}" --model "${MODEL_ARG}" --context-size "${CONTEXT_SIZE}" --parallel "${PARALLEL}" --prompt-cache-bytes "${PROMPT_CACHE_BYTES}" --prefill-step-size "${PREFILL_STEP_SIZE}" --temperature "${TEMPERATURE}" --top-p "${TOP_P}" --top-k "${TOP_K}" --min-p "${MIN_P}" --presence-penalty "${PRESENCE_PENALTY}" --repetition-penalty "${REPETITION_PENALTY}"
  )"
  echo "${daemon_pid}" > "${PID_FILE}"

  if ! wait_for_http "http://127.0.0.1:${PORT}/v1/models" 300; then
    echo "OptIQ proxy failed to become ready on port ${PORT}" >&2
    exit 1
  fi

  backend_pid_value=""
  if [[ -f "${BACKEND_PID_FILE}" ]]; then
    backend_pid_value="$(cat "${BACKEND_PID_FILE}" 2>/dev/null || true)"
  fi
  [[ -n "${backend_pid_value}" ]] || backend_pid_value="0"
  write_state_file "${daemon_pid}" "${backend_pid_value}"
  echo "OptIQ started (PID: ${daemon_pid})"
  exit 0
fi

run_proxy_forever
