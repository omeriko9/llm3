#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
source "$SCRIPT_DIR/lib/launcher-common.zsh"

# Launcher script for GPT-OSS TurboQuant models (turboquant-mlx-full)
# Model key: gpt-oss-20b-tq3
# Runtime: turboquant (MLX + TurboQuant quantization)
# Backend: turboquant-serve (OpenAI-compatible, wraps mlx_lm.server with TurboQuant loader)

VENV="${LLM3_VENV_ROOT:-$HOME/.venvs}/rapid-mlx"
MODELS_DIR="${LLM3_MODELS_DIR:-$HOME/models}"
SLOT="slot1"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/qwen36_turboquant"
STATE_DIR=""
STATE_FILE=""
DEFAULTS_FILE=""
DEFAULT_MODEL="gpt-oss-20b-tq3"
MODEL_ARG="${DEFAULT_MODEL}"
HOST="0.0.0.0"
PORT=""
BACKEND_PORT=""
LOG_FILE=""
PID_FILE=""
BACKEND_PID_FILE=""
DEFAULT_CONTEXT_SIZE="256K"
DEFAULT_PARALLEL="1"
DEFAULT_TEMPERATURE="0.6"
DEFAULT_TOP_P="0.95"
DEFAULT_TOP_K="20"
DEFAULT_MIN_P="0.0"
DEFAULT_PRESENCE_PENALTY="0.0"
DEFAULT_REPETITION_PENALTY="1.0"
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

# Known model definitions
declare -A MODEL_PATHS
MODEL_PATHS["gpt-oss-20b-tq3"]="${LLM3_MODELS_DIR:-$HOME/models}/turboquant/manjunathshiva__gpt-oss-20b-tq3"

declare -A MODEL_LABELS
MODEL_LABELS["gpt-oss-20b-tq3"]="GPT-OSS-20B-TurboQuant-3bit"

declare -A MODEL_FAMILIES
MODEL_FAMILIES["gpt-oss-20b-tq3"]="gpt-oss"

declare -A MODEL_HF_URLS
MODEL_HF_URLS["gpt-oss-20b-tq3"]="https://huggingface.co/manjunathshiva/gpt-oss-20b-tq3"

declare -A MODEL_SIZES
MODEL_SIZES["gpt-oss-20b-tq3"]="9943664674"

declare -A MODEL_SIZES_LABEL
MODEL_SIZES_LABEL["gpt-oss-20b-tq3"]="9.9 GB"

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
    BACKEND_PORT="$((18436 + index - 1))"
  fi
  if [[ -z "${LOG_FILE}" ]]; then
    if [[ "${SLOT}" == "slot1" ]]; then
      LOG_FILE="$HOME/qwen36-turboquant-api.log"
    else
      LOG_FILE="${STATE_DIR}/qwen36-turboquant-api.log"
    fi
  fi
  if [[ -z "${PID_FILE}" ]]; then
    if [[ "${SLOT}" == "slot1" ]]; then
      PID_FILE="${STATE_ROOT}/qwen36-turboquant-api.pid"
    else
      PID_FILE="${STATE_DIR}/qwen36-turboquant-api.pid"
    fi
  fi
  STATE_FILE="${STATE_DIR}/current.json"
  DEFAULTS_FILE="${STATE_DIR}/defaults.json"
  BACKEND_PID_FILE="${STATE_DIR}/qwen36-turboquant-backend.pid"
}

get_model_path() {
  local model_key="$1"
  echo "${MODEL_PATHS[$model_key]:-}"
}

get_model_label() {
  local model_key="$1"
  echo "${MODEL_LABELS[$model_key]:-$model_key}"
}

get_model_family() {
  local model_key="$1"
  echo "${MODEL_FAMILIES[$model_key]:-unknown}"
}

get_model_hf_url() {
  local model_key="$1"
  echo "${MODEL_HF_URLS[$model_key]:-}"
}

get_model_size() {
  local model_key="$1"
  echo "${MODEL_SIZES[$model_key]:-0}"
}

get_model_size_label() {
  local model_key="$1"
  echo "${MODEL_SIZES_LABEL[$model_key]:-unknown}"
}

model_exists() {
  local model_key="$1"
  local model_path
  model_path="$(get_model_path "$model_key")"
  [[ -n "$model_path" && -d "$model_path" ]]
}

emit_list_json() {
  local first=1
  local model_key=""
  printf '['
  for model_key in ${(k)MODEL_PATHS}; do
    if ! model_exists "$model_key"; then
      continue
    fi
    if [[ $first -eq 0 ]]; then
      printf ','
    fi
    first=0
    printf '{"key":"%s","label":"%s","path":"%s","hfUrl":"%s","runtime":"turboquant","sizeBytes":%s,"sizeLabel":"%s","family":"%s","quantization":"3-bit TurboQuant"}' \
      "$model_key" \
      "$(get_model_label "$model_key")" \
      "$(get_model_path "$model_key")" \
      "$(get_model_hf_url "$model_key")" \
      "$(get_model_size "$model_key")" \
      "$(get_model_size_label "$model_key")" \
      "$(get_model_family "$model_key")"
  done
  printf ']\n'
}

model_info() {
  local model_key="$1"
  MODEL_DIR="$(get_model_path "$model_key")"
  MODEL_NAME="$(get_model_label "$model_key")"
  MODEL_LABEL="$(get_model_label "$model_key")"
  MODEL_FAMILY="$(get_model_family "$model_key")"
  MODEL_HF_URL="$(get_model_hf_url "$model_key")"
  MODEL_SIZE="$(get_model_size "$model_key")"
  MODEL_SIZE_LABEL="$(get_model_size_label "$model_key")"
}

find_backend_pid() {
  local daemon_pid="$1"
  local pids
  pids=$(pgrep -P "$daemon_pid" -f "turboquant-serve" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | head -1
  fi
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
    "runtime": "turboquant"
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

# Simple argument parsing using zsh parameter expansion
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --slot)
        SLOT="$2"
        shift 2
        ;;
      --model)
        MODEL_ARG="$2"
        shift 2
        ;;
      --context-size)
        CONTEXT_SIZE="$2"
        shift 2
        ;;
      --parallel)
        PARALLEL="$2"
        shift 2
        ;;
      --temperature)
        TEMPERATURE="$2"
        shift 2
        ;;
      --top-p)
        TOP_P="$2"
        shift 2
        ;;
      --top-k)
        TOP_K="$2"
        shift 2
        ;;
      --min-p)
        MIN_P="$2"
        shift 2
        ;;
      --presence-penalty)
        PRESENCE_PENALTY="$2"
        shift 2
        ;;
      --repetition-penalty)
        REPETITION_PENALTY="$2"
        shift 2
        ;;
      --stop)
        RUN_MODE="stop"
        shift
        ;;
      --status)
        RUN_MODE="status"
        shift
        ;;
      --status-json)
        RUN_MODE="status-json"
        shift
        ;;
      --list-json)
        RUN_MODE="list-json"
        shift
        ;;
      --set-defaults)
        RUN_MODE="set-defaults"
        shift
        ;;
      --defaults-json)
        RUN_MODE="defaults-json"
        shift
        ;;
      --foreground)
        MODE="foreground"
        shift
        ;;
      --skip-stop)
        SKIP_STOP="1"
        shift
        ;;
      --host)
        HOST="$2"
        shift 2
        ;;
      --port)
        PORT="$2"
        shift 2
        ;;
      --backend-port)
        BACKEND_PORT="$2"
        shift 2
        ;;
      --state-dir)
        STATE_DIR="$2"
        shift 2
        ;;
      --log-file)
        LOG_FILE="$2"
        shift 2
        ;;
      --pid-file)
        PID_FILE="$2"
        shift 2
        ;;
      *)
        if [[ -z "${MODEL_ARG}" ]] || [[ "${MODEL_ARG}" == "${DEFAULT_MODEL}" ]]; then
          MODEL_ARG="$1"
        fi
        shift
        ;;
    esac
  done
}

status_json() {
  if [[ -f "${STATE_FILE}" ]]; then
    cat "${STATE_FILE}"
  else
    echo '{"running": false, "slot": "'"${SLOT}"'"}'
  fi
}

defaults_json() {
  local parsed_context=""
  parsed_context="$(parse_context_size "${DEFAULT_CONTEXT_SIZE}")"
  cat <<EOF
{
  "ctxSize": ${parsed_context},
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
  mkdir -p "${STATE_DIR}"
  cat >"${DEFAULTS_FILE}" <<EOF
{
  "ctxSize": ${MAX_KV_SIZE},
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
  if [[ -f "${PID_FILE}" ]]; then
    local old_pid
    old_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      kill "$old_pid" 2>/dev/null || true
      sleep 2
      kill -9 "$old_pid" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
  fi

  if [[ -f "${BACKEND_PID_FILE}" ]]; then
    local backend_pid
    backend_pid="$(cat "${BACKEND_PID_FILE}" 2>/dev/null || true)"
    if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
      kill "$backend_pid" 2>/dev/null || true
      sleep 1
      kill -9 "$backend_pid" 2>/dev/null || true
    fi
    rm -f "${BACKEND_PID_FILE}"
  fi
}

parse_args "$@"
configure_slot
load_defaults

# Only a start needs the runtime; status, defaults, and stop must work on a
# machine (or in a test) that has no venv.
if [[ "${RUN_MODE}" == "start" && ! -x "${VENV}/bin/python" ]]; then
  echo "Missing Python runtime in ${VENV}" >&2
  exit 1
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
  CONTEXT_SIZE="${CONTEXT_SIZE:-$DEFAULT_CONTEXT_SIZE}"
  MAX_KV_SIZE="$(parse_context_size "${CONTEXT_SIZE}")"
  PARALLEL="${PARALLEL:-$DEFAULT_PARALLEL}"
  TEMPERATURE="${TEMPERATURE:-$DEFAULT_TEMPERATURE}"
  TOP_P="${TOP_P:-$DEFAULT_TOP_P}"
  TOP_K="${TOP_K:-$DEFAULT_TOP_K}"
  MIN_P="${MIN_P:-$DEFAULT_MIN_P}"
  PRESENCE_PENALTY="${PRESENCE_PENALTY:-$DEFAULT_PRESENCE_PENALTY}"
  REPETITION_PENALTY="${REPETITION_PENALTY:-$DEFAULT_REPETITION_PENALTY}"
  save_defaults
  defaults_json
  exit 0
fi

if [[ "${RUN_MODE}" == "stop" ]]; then
  stop_previous_instance
  echo "Stopped."
  exit 0
fi

if [[ "${RUN_MODE}" == "list-json" ]]; then
  emit_list_json
  exit 0
fi

if [[ "${RUN_MODE}" == "status" ]]; then
  status_json
  exit 0
fi

CONTEXT_SIZE="${CONTEXT_SIZE:-$DEFAULT_CONTEXT_SIZE}"
MAX_KV_SIZE="$(parse_context_size "${CONTEXT_SIZE}")"
PARALLEL="${PARALLEL:-$DEFAULT_PARALLEL}"
TEMPERATURE="${TEMPERATURE:-$DEFAULT_TEMPERATURE}"
TOP_P="${TOP_P:-$DEFAULT_TOP_P}"
TOP_K="${TOP_K:-$DEFAULT_TOP_K}"
MIN_P="${MIN_P:-$DEFAULT_MIN_P}"
PRESENCE_PENALTY="${PRESENCE_PENALTY:-$DEFAULT_PRESENCE_PENALTY}"
REPETITION_PENALTY="${REPETITION_PENALTY:-$DEFAULT_REPETITION_PENALTY}"
model_info "${MODEL_ARG}"

if [[ -z "${MODEL_DIR}" ]] || [[ ! -d "${MODEL_DIR}" ]]; then
  echo "Model not installed: ${MODEL_ARG}" >&2
  exit 1
fi

if [[ "${SKIP_STOP}" != "1" ]]; then
  stop_previous_instance
fi

if [[ "${MODE}" == "daemon" ]]; then
  daemon_pid="$(
    spawn_detached "${LOG_FILE}" "$0" --foreground --skip-stop --slot "${SLOT}" --host "${HOST}" --port "${PORT}" --backend-port "${BACKEND_PORT}" --state-dir "${STATE_DIR}" --log-file "${LOG_FILE}" --pid-file "${PID_FILE}" --model "${MODEL_ARG}" --context-size "${CONTEXT_SIZE}" --parallel "${PARALLEL}"
  )"
  echo "${daemon_pid}" > "${PID_FILE}"
  backend_pid="$(find_backend_pid "${daemon_pid}" || true)"
  [[ -n "${backend_pid}" ]] && echo "${backend_pid}" > "${BACKEND_PID_FILE}"

  if ! wait_for_http "http://127.0.0.1:${BACKEND_PORT}/v1/models" 180; then
    echo "Timed out waiting for GPT-OSS TurboQuant API on 127.0.0.1:${BACKEND_PORT}" >&2
    exit 1
  fi

  if [[ -z "${backend_pid}" ]]; then
    backend_pid="$(find_backend_pid "${daemon_pid}" || true)"
    [[ -n "${backend_pid}" ]] && echo "${backend_pid}" > "${BACKEND_PID_FILE}"
  fi

  write_state_file "${daemon_pid}" "${backend_pid:-0}"
  echo "Started GPT-OSS TurboQuant API on ${HOST}:${PORT}"
  echo "PID: $(cat "${PID_FILE}")"
  echo "Log: ${LOG_FILE}"
  echo "Model: ${MODEL_DIR}"
  echo "Context size: ${MAX_KV_SIZE} tokens"
  echo "Parallel: ${PARALLEL}"
  exit 0
fi

# Foreground mode: start turboquant-serve directly
exec "${VENV}/bin/turboquant-serve" \
  --model "${MODEL_DIR}" \
  --host "${HOST}" \
  --port "${BACKEND_PORT}" \
  --decode-concurrency "${PARALLEL}" \
  --log-level INFO
