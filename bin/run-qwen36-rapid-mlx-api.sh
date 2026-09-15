#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
source "$SCRIPT_DIR/lib/launcher-common.zsh"

VENV="${LLM3_VENV_ROOT:-$HOME/.venvs}/rapid-mlx"
MODELS_DIR="${LLM3_MODELS_DIR:-$HOME/models}"
SLOT="${QWEN36_RAPID_MLX_SLOT:-slot1}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/qwen36_rapid_mlx"
STATE_DIR="${QWEN36_RAPID_MLX_STATE_DIR:-}"
STATE_FILE=""
DEFAULTS_FILE=""

DEFAULT_MODEL="Qwen3.6-35B-A3B-mxfp4"
MODEL_ARG="${DEFAULT_MODEL}"
MODEL_DIR=""
EFFECTIVE_MODEL_DIR=""
MODEL_LABEL=""
MODEL_RUNTIME_ID=""

HOST="${QWEN36_RAPID_MLX_HOST:-0.0.0.0}"
PORT="${QWEN36_RAPID_MLX_PORT:-}"
LOG_FILE="${QWEN36_RAPID_MLX_LOG_FILE:-}"
PID_FILE="${QWEN36_RAPID_MLX_PID_FILE:-}"

DEFAULT_CONTEXT_SIZE="${QWEN36_RAPID_MLX_CONTEXT_SIZE:-256K}"
DEFAULT_PARALLEL="${QWEN36_RAPID_MLX_PARALLEL:-1}"
DEFAULT_TEMPERATURE="${QWEN36_RAPID_MLX_TEMPERATURE:-0.6}"
DEFAULT_TOP_P="${QWEN36_RAPID_MLX_TOP_P:-0.95}"
DEFAULT_TOP_K="${QWEN36_RAPID_MLX_TOP_K:-20}"
DEFAULT_MIN_P="${QWEN36_RAPID_MLX_MIN_P:-0.0}"
DEFAULT_PRESENCE_PENALTY="${QWEN36_RAPID_MLX_PRESENCE_PENALTY:-0.0}"
DEFAULT_REPETITION_PENALTY="${QWEN36_RAPID_MLX_REPETITION_PENALTY:-1.0}"

MODE="daemon"
RUN_MODE="start"
CONTEXT_SIZE=""
PARALLEL=""
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

Notes:
  - Rapid-MLX reuses the standard llm3 public slot ports (8036+).
  - Models are launched directly with rapid-mlx on the selected slot port.
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

  if [[ -z "${LOG_FILE}" ]]; then
    if [[ "${SLOT}" == "slot1" ]]; then
      LOG_FILE="$HOME/qwen36-rapid-mlx-api.log"
    else
      LOG_FILE="${STATE_DIR}/qwen36-rapid-mlx-api.log"
    fi
  fi

  if [[ -z "${PID_FILE}" ]]; then
    if [[ "${SLOT}" == "slot1" ]]; then
      PID_FILE="$HOME/qwen36-rapid-mlx-api.pid"
    else
      PID_FILE="${STATE_DIR}/qwen36-rapid-mlx-api.pid"
    fi
  fi

  STATE_FILE="${STATE_DIR}/current.json"
  DEFAULTS_FILE="${STATE_DIR}/defaults.json"

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

resolve_model_info() {
  MODEL_DIR="$(resolve_model_dir "${MODEL_ARG}")"
  if [[ -z "${MODEL_DIR}" ]]; then
    echo "Error: Model '${MODEL_ARG}' not found." >&2
    exit 1
  fi

  MODEL_RUNTIME_ID="${MODEL_DIR:t}"
  MODEL_LABEL="${MODEL_RUNTIME_ID}"
}

materialize_template_overlay() {
  local model_dir="$1"
  /usr/bin/python3 - "${model_dir}" "${STATE_DIR}" <<'PY'
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

model_dir = Path(sys.argv[1]).resolve()
state_dir = Path(sys.argv[2]).resolve()

def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None

def template_from(path):
    if not path or not path.exists():
        return ""
    if path.name == "tokenizer_config.json":
        data = read_json(path)
        return str((data or {}).get("chat_template") or "")
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""

metadata = read_json(model_dir / ".llm3-hf.json") or {}
metadata_template = str(metadata.get("chatTemplateFile") or "").strip()
candidates = []
if metadata_template:
    template_path = Path(metadata_template)
    candidates.append(template_path if template_path.is_absolute() else model_dir / template_path)
candidates.extend([
    model_dir / "chat_template.jinja",
    model_dir / ".llm3-chat-template.jinja",
    model_dir / "tokenizer_config.json",
])

template = ""
template_source = None
for candidate in candidates:
    template = template_from(candidate)
    if template.strip():
        template_source = candidate
        break

if not template.strip():
    print(model_dir)
    raise SystemExit(0)

overlay_root = state_dir / "template_overlays"
digest = hashlib.sha256(f"{model_dir}:{template_source}:{template}".encode("utf-8")).hexdigest()[:16]
overlay_dir = overlay_root / f"{model_dir.name}-{digest}"
overlay_dir.mkdir(parents=True, exist_ok=True)

for entry in model_dir.iterdir():
    target = overlay_dir / entry.name
    if target.exists() or target.is_symlink():
        continue
    try:
        target.symlink_to(entry, target_is_directory=entry.is_dir())
    except OSError:
        if entry.is_dir():
            shutil.copytree(entry, target, dirs_exist_ok=True)
        else:
            shutil.copy2(entry, target)

tokenizer_config = read_json(model_dir / "tokenizer_config.json") or {}
tokenizer_config["chat_template"] = template
(overlay_dir / "tokenizer_config.json").write_text(
    json.dumps(tokenizer_config, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
(overlay_dir / "chat_template.jinja").write_text(template, encoding="utf-8")
print(overlay_dir)
PY
}

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

stop_previous_instance() {
  local pids=()
  local pid=""

  if [[ -f "${PID_FILE}" ]]; then
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      pids+=("${pid}")
    fi
  fi

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && pids+=("${pid}")
  done < <(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)

  if (( ${#pids[@]} > 0 )); then
    pids=("${(@u)pids}")
    kill "${pids[@]}" 2>/dev/null || true
    local deadline=$(( SECONDS + 20 ))
    while (( SECONDS < deadline )); do
      local alive=()
      for pid in "${pids[@]}"; do
        if kill -0 "${pid}" 2>/dev/null; then
          alive+=("${pid}")
        fi
      done
      (( ${#alive[@]} == 0 )) && break
      sleep 1
    done
    kill -9 "${pids[@]}" 2>/dev/null || true
  fi

  local port_deadline=$(( SECONDS + 20 ))
  while (( SECONDS < port_deadline )); do
    if ! lsof -tiTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    while IFS= read -r pid; do
      [[ -n "${pid}" ]] && kill -9 "${pid}" 2>/dev/null || true
    done < <(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)
    sleep 1
  done

  rm -f "${PID_FILE}" "${STATE_FILE}"
}

write_state_file() {
  local proxy_pid="$1"
  local context_tokens="$2"
  cat >"${STATE_FILE}" <<EOF
{
  "running": true,
  "slot": "${SLOT}",
  "model": {
    "key": "${MODEL_ARG}",
    "modelId": "${MODEL_RUNTIME_ID}",
    "runtimeId": "${MODEL_RUNTIME_ID}",
    "label": "${MODEL_LABEL}",
    "family": "MLX",
    "path": "${MODEL_DIR}",
    "runtime": "mlx"
  },
  "params": {
    "ctxSize": ${context_tokens},
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
    "backendPort": ${PORT}
  },
  "logs": {
    "server": "${LOG_FILE}",
    "traffic": "",
    "proxy": "${LOG_FILE}"
  },
  "pids": {
    "proxy": ${proxy_pid},
    "backend": null
  },
  "startedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
}

status_json() {
  /usr/bin/python3 - <<'PY' "${STATE_FILE}" "${PID_FILE}" "${LOG_FILE}"
import json
import os
import sys
from pathlib import Path

state_path = Path(sys.argv[1])
pid_path = Path(sys.argv[2])
log_file = sys.argv[3]

def pid_alive(value):
    try:
        os.kill(value, 0)
    except Exception:
        return False
    return True

if not state_path.exists():
    print(json.dumps({"running": False, "logs": {"server": log_file, "traffic": "", "proxy": log_file}}, indent=2))
    raise SystemExit(0)

data = json.loads(state_path.read_text())
proxy_pid = data.get("pids", {}).get("proxy")
running = bool(proxy_pid and pid_alive(int(proxy_pid)))
data["running"] = running

if not running:
    for path in (pid_path, state_path):
        try:
            Path(path).unlink()
        except FileNotFoundError:
            pass
    print(json.dumps({"running": False, "logs": {"server": log_file, "traffic": "", "proxy": log_file}}, indent=2))
else:
    print(json.dumps(data, indent=2))
PY
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
      echo "[]"
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

if ! [[ "${PARALLEL}" =~ ^[1-9][0-9]*$ ]]; then
  echo "--parallel must be a positive integer" >&2
  exit 1
fi

if [[ ! -x "${VENV}/bin/rapid-mlx" ]]; then
  echo "Missing rapid-mlx binary in ${VENV}" >&2
  exit 1
fi

resolve_model_info
CONTEXT_TOKENS="$(parse_context_size "${CONTEXT_SIZE}")"
EFFECTIVE_MODEL_DIR="$(materialize_template_overlay "${MODEL_DIR}")"

if [[ "${SKIP_STOP}" != "1" ]]; then
  stop_previous_instance
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Rapid-MLX: ${MODEL_ARG} slot=${SLOT} port=${PORT} context=${CONTEXT_TOKENS} parallel=${PARALLEL}" >> "${LOG_FILE}"
if [[ "${EFFECTIVE_MODEL_DIR}" != "${MODEL_DIR}" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Rapid-MLX using chat template overlay: ${EFFECTIVE_MODEL_DIR}" >> "${LOG_FILE}"
fi

if [[ "${MODE}" == "daemon" ]]; then
  daemon_pid="$(
    spawn_detached "${LOG_FILE}" "${VENV}/bin/rapid-mlx" "serve" "${EFFECTIVE_MODEL_DIR}" \
      "--served-model-name" "${MODEL_RUNTIME_ID}" \
      "--host" "${HOST}" \
      "--port" "${PORT}" \
      "--max-num-seqs" "${PARALLEL}" \
      "--prefill-step-size" "1024" \
      "--enable-auto-tool-choice" \
      "--tool-call-parser" "qwen3_coder_xml" \
      "--no-thinking" \
      "--api-key" "api" \
      "--log-level" "INFO"
  )"
  echo "${daemon_pid}" > "${PID_FILE}"

  if ! wait_for_http "http://127.0.0.1:${PORT}/v1/models" 180 -H "Authorization: Bearer api" -H "X-API-Key: api"; then
    echo "Rapid-MLX failed to become ready on port ${PORT}" >&2
    if kill -0 "${daemon_pid}" 2>/dev/null; then
      kill "${daemon_pid}" 2>/dev/null || true
      sleep 2
      kill -9 "${daemon_pid}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}" "${STATE_FILE}"
    exit 1
  fi

  write_state_file "${daemon_pid}" "${CONTEXT_TOKENS}"
  echo "Rapid-MLX started (PID: ${daemon_pid})"
  exit 0
fi

exec "${VENV}/bin/rapid-mlx" serve "${EFFECTIVE_MODEL_DIR}" \
  --served-model-name "${MODEL_RUNTIME_ID}" \
  --host "${HOST}" \
  --port "${PORT}" \
  --max-num-seqs "${PARALLEL}" \
  --prefill-step-size 1024 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder_xml \
  --no-thinking \
  --api-key api \
  --log-level INFO
