#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
source "$SCRIPT_DIR/lib/launcher-common.zsh"
LLM3_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MLX_PROXY_SCRIPT="$LLM3_ROOT/src/qwen36-mlx-api-proxy.py"

VENV="${LLM3_VENV_ROOT:-$HOME/.venvs}/rapid-mlx"
MODELS_DIR="${LLM3_MODELS_DIR:-$HOME/models}"
SLOT="${QWEN36_MLX_SLOT:-slot1}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/qwen36_mlx"
STATE_DIR="${QWEN36_MLX_STATE_DIR:-}"
STATE_FILE=""
DEFAULTS_FILE=""
DEFAULT_MODEL="Qwen3.6-35B-A3B-mxfp4"
MODEL_ARG="${DEFAULT_MODEL}"
MODEL_DIR_OVERRIDE=""
HOST="${QWEN36_MLX_HOST:-0.0.0.0}"
PORT="${QWEN36_MLX_PORT:-}"
BACKEND_PORT="${QWEN36_MLX_BACKEND_PORT:-}"
LOG_FILE="${QWEN36_MLX_LOG_FILE:-}"
PID_FILE="${QWEN36_MLX_PID_FILE:-}"
BACKEND_PID_FILE=""
DEFAULT_CONTEXT_SIZE="${QWEN36_MLX_CONTEXT_SIZE:-256K}"
DEFAULT_PARALLEL="${QWEN36_MLX_PARALLEL:-1}"
DEFAULT_TEMPERATURE="${QWEN36_MLX_TEMPERATURE:-0.6}"
DEFAULT_TOP_P="${QWEN36_MLX_TOP_P:-0.95}"
DEFAULT_TOP_K="${QWEN36_MLX_TOP_K:-20}"
DEFAULT_MIN_P="${QWEN36_MLX_MIN_P:-0.0}"
DEFAULT_PRESENCE_PENALTY="${QWEN36_MLX_PRESENCE_PENALTY:-0.0}"
DEFAULT_REPETITION_PENALTY="${QWEN36_MLX_REPETITION_PENALTY:-1.0}"
MODE="daemon"
CONTEXT_SIZE=""
PARALLEL=""
TEMPERATURE=""
TOP_P=""
TOP_K=""
MIN_P=""
PRESENCE_PENALTY=""
REPETITION_PENALTY=""
SKIP_STOP="0"
RUN_MODE="start"

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
    BACKEND_PORT="$((18136 + index - 1))"
  fi
  if [[ -z "${LOG_FILE}" ]]; then
    if [[ "${SLOT}" == "slot1" ]]; then
      LOG_FILE="$HOME/qwen36-mlx-api.log"
    else
      LOG_FILE="${STATE_DIR}/qwen36-mlx-api.log"
    fi
  fi
  if [[ -z "${PID_FILE}" ]]; then
    if [[ "${SLOT}" == "slot1" ]]; then
      PID_FILE="$HOME/qwen36-mlx-api.pid"
    else
      PID_FILE="${STATE_DIR}/qwen36-mlx-api.pid"
    fi
  fi

  STATE_FILE="${STATE_DIR}/current.json"
  DEFAULTS_FILE="${STATE_DIR}/defaults.json"
  BACKEND_PID_FILE="${STATE_DIR}/backend.pid"

  mkdir -p "${STATE_DIR}"
}

load_defaults
CONTEXT_SIZE="${DEFAULT_CONTEXT_SIZE}"
PARALLEL="${DEFAULT_PARALLEL}"
TEMPERATURE="${DEFAULT_TEMPERATURE}"
TOP_P="${DEFAULT_TOP_P}"
TOP_K="${DEFAULT_TOP_K}"
MIN_P="${DEFAULT_MIN_P}"
PRESENCE_PENALTY="${DEFAULT_PRESENCE_PENALTY}"
REPETITION_PENALTY="${DEFAULT_REPETITION_PENALTY}"

defaults_json() {
  local parsed_context=""
  parsed_context="$(parse_context_size "${DEFAULT_CONTEXT_SIZE}")"
  cat <<EOF
{
  "contextSize": ${parsed_context},
  "contextSizeLabel": "$(context_label "${parsed_context}")",
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
  local parsed_context=""
  parsed_context="$(parse_context_size "${CONTEXT_SIZE}")"
  cat >"${DEFAULTS_FILE}" <<EOF
{
  "contextSize": ${parsed_context},
  "contextSizeLabel": "$(context_label "${parsed_context}")",
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

dynamic_model_info() {
  local input_path="$1"
  local metadata=""
  local meta_label=""
  local meta_family=""
  local meta_hf_url=""
  local meta_aliases=""
  local basename_name=""
  local size_bytes=""

  MODEL_DIR="$(resolve_model_dir "${input_path}")"
  if [[ ! -d "${MODEL_DIR}" ]]; then
    echo "Missing model directory ${MODEL_DIR}" >&2
    exit 1
  fi

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

  MODEL_NAME="${MODEL_DIR}"
  MODEL_LABEL="${meta_label:-${basename_name}}"
  MODEL_FAMILY="${meta_family:-Downloaded MLX}"
  MODEL_HF_URL="${meta_hf_url:-}"
  MODEL_SIZE_LABEL="$(format_bytes "${size_bytes:-0}")"
  MODEL_RUNTIME="mlx"
}

model_info() {
  if [[ "$1" == /* ]] || [[ -d "$(resolve_model_dir "$1")" && "$1" == *"/"* ]]; then
    dynamic_model_info "$1"
    return 0
  fi

  case "$1" in
    Qwen3.6-35B-A3B-mxfp4)
      MODEL_NAME="Qwen3.6-35B-A3B-mxfp4"
      MODEL_DIR="$(resolve_model_dir "${MODEL_NAME}")"
      MODEL_LABEL="Qwen 3.6 MXFP4"
      MODEL_FAMILY="Qwen 3.6 MLX"
      MODEL_HF_URL="https://huggingface.co/OsaurusAI/Qwen3.6-35B-A3B-mxfp4"
      MODEL_SIZE_LABEL="18.02 GiB"
      MODEL_RUNTIME="mlx"
      ;;
    Qwen3.6-35B-A3B-5bit)
      MODEL_NAME="Qwen3.6-35B-A3B-5bit"
      MODEL_DIR="$(resolve_model_dir "${MODEL_NAME}")"
      MODEL_LABEL="Qwen 3.6 5bit"
      MODEL_FAMILY="Qwen 3.6 MLX"
      MODEL_HF_URL="https://huggingface.co/NexVeridian/Qwen3.6-35B-A3B-5bit"
      MODEL_SIZE_LABEL="22.22 GiB"
      MODEL_RUNTIME="mlx"
      ;;
    Qwen3.6-35B-A3B-6bit)
      MODEL_NAME="Qwen3.6-35B-A3B-6bit"
      MODEL_DIR="$(resolve_model_dir "${MODEL_NAME}")"
      MODEL_LABEL="Qwen 3.6 6bit"
      MODEL_FAMILY="Qwen 3.6 MLX"
      MODEL_HF_URL="https://huggingface.co/NexVeridian/Qwen3.6-35B-A3B-6bit"
      MODEL_SIZE_LABEL="26.25 GiB"
      MODEL_RUNTIME="mlx"
      ;;
    Qwen3.6-35B-A3B-8bit)
      MODEL_NAME="Qwen3.6-35B-A3B-8bit"
      MODEL_DIR="$(resolve_model_dir "${MODEL_NAME}")"
      MODEL_LABEL="Qwen 3.6 8bit"
      MODEL_FAMILY="Qwen 3.6 MLX"
      MODEL_HF_URL="https://huggingface.co/NexVeridian/Qwen3.6-35B-A3B-8bit"
      MODEL_SIZE_LABEL="34.32 GiB"
      MODEL_RUNTIME="mlx"
      ;;
    Qwen3.6-35B-A3B-float16)
      MODEL_NAME="Qwen3.6-35B-A3B-float16"
      MODEL_DIR="$(resolve_model_dir "${MODEL_NAME}")"
      MODEL_LABEL="Qwen 3.6 float16"
      MODEL_FAMILY="Qwen 3.6 MLX"
      MODEL_HF_URL="https://huggingface.co/Qwen/Qwen3.6-35B-A3B"
      MODEL_SIZE_LABEL="64.60 GiB"
      MODEL_RUNTIME="mlx"
      ;;
    Huihui-Qwen36-35B-A3B-Opus-4bit)
      MODEL_NAME="Huihui-Qwen36-35B-A3B-Opus-4bit"
      MODEL_DIR="$(resolve_model_dir "huihui-qwen36-35b-a3b-claude-46-opus-abliterated-mlx-4bit")"
      MODEL_LABEL="Huihui Qwen3.6 4bit"
      MODEL_FAMILY="Huihui MLX"
      MODEL_HF_URL="https://huggingface.co/huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.6-Opus-abliterated"
      MODEL_SIZE_LABEL="18.00 GiB"
      MODEL_RUNTIME="mlx"
      ;;
    Huihui-Qwen36-35B-A3B-Opus-6bit)
      MODEL_NAME="Huihui-Qwen36-35B-A3B-Opus-6bit"
      MODEL_DIR="$(resolve_model_dir "huihui-qwen36-35b-a3b-claude-46-opus-abliterated-mlx-6bit")"
      MODEL_LABEL="Huihui Qwen3.6 6bit"
      MODEL_FAMILY="Huihui MLX"
      MODEL_HF_URL="https://huggingface.co/huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.6-Opus-abliterated"
      MODEL_SIZE_LABEL="26.00 GiB"
      MODEL_RUNTIME="mlx"
      ;;
    Huihui-Qwen36-35B-A3B-Opus-float16)
      MODEL_NAME="Huihui-Qwen36-35B-A3B-Opus-float16"
      MODEL_DIR="$(resolve_model_dir "huihui-qwen36-35b-a3b-claude-46-opus-abliterated")"
      MODEL_LABEL="Huihui Qwen3.6 float16"
      MODEL_FAMILY="Huihui MLX"
      MODEL_HF_URL="https://huggingface.co/huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.6-Opus-abliterated"
      MODEL_SIZE_LABEL="67.00 GiB"
      MODEL_RUNTIME="mlx"
      ;;
    Qwopus-GLM-18B-MLX-4bit)
      MODEL_NAME="Qwopus-GLM-18B-MLX-4bit"
      MODEL_DIR="$(resolve_model_dir "Qwopus-GLM-18B-Healed-MLX-4bit")"
      MODEL_LABEL="Qwopus GLM 18B 4bit"
      MODEL_FAMILY="Qwopus MLX"
      MODEL_HF_URL="https://huggingface.co/KyleHessling1/Qwopus-GLM-18B-Healed-MLX-4bit"
      MODEL_SIZE_LABEL="8.30 GiB"
      MODEL_RUNTIME="mlx"
      ;;
    *)
      echo "Unknown MLX model: $1" >&2
      exit 1
      ;;
  esac

  if [[ -n "${MODEL_DIR_OVERRIDE}" ]]; then
    MODEL_DIR="${MODEL_DIR_OVERRIDE}"
  fi

  if [[ ! -d "${MODEL_DIR}" ]]; then
    echo "Missing model directory ${MODEL_DIR}" >&2
    exit 1
  fi
}

print_model_row() {
  model_info "$1"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${MODEL_NAME}" \
    "${MODEL_LABEL}" \
    "${MODEL_DIR}" \
    "${MODEL_HF_URL}" \
    "${MODEL_SIZE_LABEL}" \
    "${MODEL_FAMILY}" \
    "${MODEL_RUNTIME}"
}

print_model_row_if_available() {
  (
    print_model_row "$1" 2>/dev/null
  ) || true
}

list_models_json() {
  {
    print_model_row_if_available Qwen3.6-35B-A3B-mxfp4
    print_model_row_if_available Qwen3.6-35B-A3B-5bit
    print_model_row_if_available Qwen3.6-35B-A3B-6bit
    print_model_row_if_available Qwen3.6-35B-A3B-8bit
    print_model_row_if_available Qwen3.6-35B-A3B-float16
    print_model_row_if_available Qwopus-GLM-18B-MLX-4bit
    print_model_row_if_available Huihui-Qwen36-35B-A3B-Opus-4bit
    print_model_row_if_available Huihui-Qwen36-35B-A3B-Opus-6bit
    print_model_row_if_available Huihui-Qwen36-35B-A3B-Opus-float16
  } | python3 -c '
import json
import sys

rows = []
for raw in sys.stdin:
    raw = raw.rstrip("\n")
    if not raw:
        continue
    key, label, path, hf_url, size_label, family, runtime = raw.split("\t")
    rows.append(
        {
            "key": key,
            "label": label,
            "path": path,
            "hfUrl": hf_url,
            "sizeLabel": size_label,
            "family": family,
            "runtime": runtime,
        }
    )
print(json.dumps(rows, indent=2))
'
}

resolve_model_dir() {
  local value="$1"
  if [[ "${value}" == /* ]]; then
    echo "${value}"
  else
    echo "${MODELS_DIR}/${value}"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --foreground)
      MODE="foreground"
      shift
      ;;
    --slot)
      [[ $# -ge 2 ]] || { echo "--slot requires a value" >&2; exit 1; }
      SLOT="$2"
      shift 2
      ;;
    --context-size)
      [[ $# -ge 2 ]] || { echo "--context-size requires a value" >&2; exit 1; }
      CONTEXT_SIZE="$2"
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || { echo "--model requires a value" >&2; exit 1; }
      MODEL_ARG="$2"
      shift 2
      ;;
    --parallel)
      [[ $# -ge 2 ]] || { echo "--parallel requires a value" >&2; exit 1; }
      PARALLEL="$2"
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
    --list-json)
      list_models_json
      exit 0
      ;;
    --defaults-json)
      RUN_MODE="defaults-json"
      shift
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
      LOG_FILE="$2"
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
    --status-json)
      RUN_MODE="status-json"
      shift
      ;;
    --set-defaults|--set-default)
      RUN_MODE="set-defaults"
      shift
      ;;
    --stop)
      RUN_MODE="stop"
      shift
      ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--model NAME|PATH] [--context-size SIZE] [--parallel N] [--foreground]
       $0 --list-json
       $0 --defaults-json
       $0 --status-json
       $0 --set-defaults --context-size SIZE --parallel N
       $0 --stop

Defaults:
  daemon on ${HOST}:${PORT}
  model ${DEFAULT_MODEL}
  context ${DEFAULT_CONTEXT_SIZE}
  parallel ${DEFAULT_PARALLEL}
  kills previous instance

Examples:
  1. $0
  2. $0 --model Qwen3.6-35B-A3B-5bit
  3. $0 --model Qwen3.6-35B-A3B-6bit --parallel 2
  4. $0 --model Qwen3.6-35B-A3B-8bit --context-size 256K --parallel 2
  5. $0 --model Qwen3.6-35B-A3B-float16 --context-size 256K --parallel 3
  6. $0 --model "$HOME/models/Qwen3.6-35B-A3B-float16" --foreground
EOF
      exit 0
      ;;
    --skip-stop)
      SKIP_STOP="1"
      shift
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
[[ -n "${TEMPERATURE}" ]] || TEMPERATURE="${DEFAULT_TEMPERATURE}"
[[ -n "${TOP_P}" ]] || TOP_P="${DEFAULT_TOP_P}"
[[ -n "${TOP_K}" ]] || TOP_K="${DEFAULT_TOP_K}"
[[ -n "${MIN_P}" ]] || MIN_P="${DEFAULT_MIN_P}"
[[ -n "${PRESENCE_PENALTY}" ]] || PRESENCE_PENALTY="${DEFAULT_PRESENCE_PENALTY}"
[[ -n "${REPETITION_PENALTY}" ]] || REPETITION_PENALTY="${DEFAULT_REPETITION_PENALTY}"

if ! [[ "${PARALLEL}" =~ ^[1-9][0-9]*$ ]]; then
  echo "--parallel must be a positive integer" >&2
  exit 1
fi

status_json() {
  python3 - <<'PY' "${STATE_FILE}" "${PID_FILE}" "${BACKEND_PID_FILE}" "${LOG_FILE}"
import json
import os
import sys
from pathlib import Path

state_path = Path(sys.argv[1])
proxy_pid_path = Path(sys.argv[2])
backend_pid_path = Path(sys.argv[3])
log_file = sys.argv[4]


def pid_alive(value):
    try:
        os.kill(value, 0)
    except Exception:
        return False
    return True


if not state_path.exists():
    print(json.dumps({"running": False, "logs": {"server": log_file}}, indent=2))
    raise SystemExit(0)

data = json.loads(state_path.read_text())
proxy_pid = data.get("pids", {}).get("proxy")
backend_pid = data.get("pids", {}).get("backend")
running = bool(proxy_pid and pid_alive(proxy_pid))
if backend_pid:
    running = running and pid_alive(backend_pid)

data["running"] = running

if not running:
    for path in (proxy_pid_path, backend_pid_path, state_path):
        try:
            Path(path).unlink()
        except FileNotFoundError:
            pass
    print(json.dumps({"running": False, "logs": {"server": log_file}}, indent=2))
else:
    print(json.dumps(data, indent=2))
PY
}

stop_previous_instance() {
  local pids=()
  local pid

  if [[ -f "${PID_FILE}" ]]; then
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
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

  rm -f "${PID_FILE}"
  rm -f "${BACKEND_PID_FILE}"
  rm -f "${STATE_FILE}"
}

find_backend_pid() {
  local proxy_pid="$1"
  local pid=""
  local count=0

  while (( count < 60 )); do
    pid="$(pgrep -P "${proxy_pid}" | head -n 1 || true)"
    if [[ -n "${pid}" ]]; then
      printf '%s\n' "${pid}"
      return 0
    fi
    sleep 1
    count=$(( count + 1 ))
  done

  return 1
}

write_state_file() {
  local proxy_pid="$1"
  local backend_pid="$2"
  local runtime_model_id="${MODEL_NAME:t}"

  cat >"${STATE_FILE}" <<EOF
{
  "running": true,
  "slot": "${SLOT}",
  "model": {
    "key": "${MODEL_NAME}",
    "modelId": "${runtime_model_id}",
    "runtimeId": "${runtime_model_id}",
    "label": "${MODEL_LABEL}",
    "family": "${MODEL_FAMILY}",
    "path": "${MODEL_DIR}",
    "hfUrl": "${MODEL_HF_URL}",
    "sizeLabel": "${MODEL_SIZE_LABEL}",
    "runtime": "${MODEL_RUNTIME}"
  },
  "params": {
    "ctxSize": ${MAX_KV_SIZE},
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
    "batchSize": 1024,
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
    "server": "${LOG_FILE}",
    "traffic": "",
    "proxy": "${LOG_FILE}"
  },
  "pids": {
    "proxy": ${proxy_pid},
    "backend": ${backend_pid}
  },
  "startedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
}

# Only a start needs the runtime; status, defaults, and stop must work on a
# machine (or in a test) that has no venv.
if [[ "${RUN_MODE}" == "start" ]]; then
  if [[ ! -x "${VENV}/bin/python" ]]; then
    echo "Missing Python runtime in ${VENV}" >&2
    exit 1
  fi
  if [[ ! -f "$MLX_PROXY_SCRIPT" ]]; then
    echo "Missing proxy script $MLX_PROXY_SCRIPT" >&2
    exit 1
  fi
fi

if [[ "${RUN_MODE}" == "status-json" ]]; then
  status_json
  exit 0
fi

if [[ "${RUN_MODE}" == "defaults-json" ]]; then
  defaults_json
  exit 0
fi

if [[ "${RUN_MODE}" == "set-defaults" ]]; then
  save_defaults
  defaults_json
  exit 0
fi

if [[ "${RUN_MODE}" == "stop" ]]; then
  stop_previous_instance
  echo "Stopped."
  exit 0
fi

MAX_KV_SIZE="$(parse_context_size "${CONTEXT_SIZE}")"
model_info "${MODEL_ARG}"

if [[ "${SKIP_STOP}" != "1" ]]; then
  stop_previous_instance
fi

if [[ "${MODE}" == "daemon" ]]; then
  daemon_pid="$(
    spawn_detached "${LOG_FILE}" "$0" --foreground --skip-stop --slot "${SLOT}" --host "${HOST}" --port "${PORT}" --backend-port "${BACKEND_PORT}" --state-dir "${STATE_DIR}" --log-file "${LOG_FILE}" --pid-file "${PID_FILE}" --model "${MODEL_ARG}" --context-size "${CONTEXT_SIZE}" --parallel "${PARALLEL}" --temperature "${TEMPERATURE}" --top-p "${TOP_P}" --top-k "${TOP_K}" --min-p "${MIN_P}" --presence-penalty "${PRESENCE_PENALTY}" --repetition-penalty "${REPETITION_PENALTY}"
  )"
  echo "${daemon_pid}" > "${PID_FILE}"
  backend_pid="$(find_backend_pid "${daemon_pid}" || true)"
  [[ -n "${backend_pid}" ]] && echo "${backend_pid}" > "${BACKEND_PID_FILE}"

  if ! wait_for_http "http://127.0.0.1:${PORT}/v1/models" 180; then
    echo "Timed out waiting for Qwen3.6 MLX API on ${HOST}:${PORT}" >&2
    exit 1
  fi

  if [[ -z "${backend_pid}" ]]; then
    backend_pid="$(find_backend_pid "${daemon_pid}" || true)"
    [[ -n "${backend_pid}" ]] && echo "${backend_pid}" > "${BACKEND_PID_FILE}"
  fi

  write_state_file "${daemon_pid}" "${backend_pid:-0}"
  echo "Started Qwen3.6 MLX API on ${HOST}:${PORT}"
  echo "PID: $(cat "${PID_FILE}")"
  echo "Log: ${LOG_FILE}"
  echo "Model: ${MODEL_DIR}"
  echo "Context size: ${MAX_KV_SIZE} tokens"
  echo "Parallel: ${PARALLEL}"
  exit 0
fi

exec "${VENV}/bin/python" "$MLX_PROXY_SCRIPT" \
  --model-dir "${MODEL_DIR}" \
  --model-name "${MODEL_ARG:t}" \
  --host "${HOST}" \
  --port "${PORT}" \
  --backend-port "${BACKEND_PORT}" \
  --parallel "${PARALLEL}" \
  --prefill-step-size 1024 \
  --context-size "${MAX_KV_SIZE}" \
  --default-temperature "${TEMPERATURE}" \
  --default-top-p "${TOP_P}" \
  --default-top-k "${TOP_K}" \
  --default-min-p "${MIN_P}" \
  --default-presence-penalty "${PRESENCE_PENALTY}" \
  --default-repetition-penalty "${REPETITION_PENALTY}"
