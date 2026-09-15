#!/bin/zsh
# mlx-dspark launcher — DSpark/DFlash speculative decoding on MLX.
#
# Measured on this box (M4 Max, mlx-community/Qwen3.8-27B-8bit, 200 tokens warm):
#   plain mlx        16.0 tok/s
#   rapid-mlx        15.5 tok/s
#   mlx-dspark       44.0 code / 45.1 math / 25.2 chat  (accept 3.8/round)
# For reference the llama.cpp Q4_K_XL path on the same model family runs 21.4
# tok/s, so this is the first MLX launcher here that beats GGUF/Metal — which is
# why it is not behind LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS like the rest.
#
# The server is OpenAI-compatible and speaks the same /v1 surface as the other
# launchers, so no proxy layer is needed: mlx-dspark serves the public port
# directly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
source "$SCRIPT_DIR/lib/launcher-common.zsh"

VENV="${MLX_DSPARK_VENV:-$HOME/.venvs/mlx-dspark}"
BIN="${VENV}/bin/mlx-dspark"
MODELS_DIR="${LLM3_MODELS_DIR:-$HOME/models}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/mlx_dspark"

SLOT="slot1"
STATE_DIR=""
PORT=""
HOST="0.0.0.0"
LOG_FILE=""
PID_FILE=""
MODEL_ARG=""
CONTEXT_SIZE=""
PARALLEL=""
TEMPERATURE=""
TOP_P=""
TOP_K=""
MIN_P=""
PRESENCE_PENALTY=""
REPETITION_PENALTY=""
MODE="${MLX_DSPARK_MODE:-}"
REASONING_EFFORT=""
ACTION=""
FOREGROUND=0
SKIP_STOP=0

DEFAULT_CONTEXT_SIZE=32768
DEFAULT_PARALLEL=1
DEFAULT_TEMPERATURE=0.7
DEFAULT_TOP_P=0.8
DEFAULT_TOP_K=20
DEFAULT_MIN_P=0
DEFAULT_PRESENCE_PENALTY=0
DEFAULT_REPETITION_PENALTY=1
# auto = the mode mlx-dspark's registry stamped as measured-best for the target
# (DFlash 2 on Qwen3.8-27B), falling back to dspark -> dflash -> lookup for
# unknown repos. Was hardcoded to dspark, which pinned Qwen3.8-27B-8bit to the
# slower DSpark head (24 vs 37 tok/s measured 2026-08-22).
DEFAULT_MODE=auto
# "" = leave the model's chat template alone (Qwen3.8's own template defaults to
# xhigh). "off" maps to --no-thinking; low/medium/high/xhigh map to
# --reasoning-effort. Exposed because an agent turn at xhigh can think for a long
# time before emitting any content.
DEFAULT_REASONING_EFFORT=""

configure_slot() {
  local index=""
  index="$(slot_index "${SLOT}")"
  [[ -n "${STATE_DIR}" ]] || STATE_DIR="${STATE_ROOT}/${SLOT}"
  [[ -n "${PORT}" ]] || PORT="$((8036 + index - 1))"
  [[ -n "${LOG_FILE}" ]] || LOG_FILE="${STATE_DIR}/mlx-dspark-api.log"
  [[ -n "${PID_FILE}" ]] || PID_FILE="${STATE_DIR}/mlx-dspark-api.pid"
  STATE_FILE="${STATE_DIR}/current.json"
  DEFAULTS_FILE="${STATE_DIR}/defaults.json"
  mkdir -p "${STATE_DIR}"
}

# Ask mlx-dspark which mode it would actually serve this target with. "auto" is
# resolved against its registry (Qwen3.8-27B-8bit is stamped dflash = DFlash 2), so
# the launcher can make mode-dependent decisions (see --max-draft below) and report
# the real mode to llm3 instead of the literal string the user asked for.
resolve_effective_mode() {
  local target="$1" requested="${2:-auto}"
  if [[ -z "${target}" ]]; then
    printf '%s\n' "${requested}"
    return 0
  fi
  "${VENV}/bin/python" - "${target}" "${requested}" 2>/dev/null <<'PY' || printf '%s\n' "${requested}"
import sys
try:
    from mlx_dspark.load import resolve_mode
    print(resolve_mode(sys.argv[1], mode=sys.argv[2])[0])
except Exception:
    print(sys.argv[2])
PY
}

load_defaults() {
  [[ -f "${DEFAULTS_FILE}" ]] || return 0
  local parsed=""
  parsed="$(/usr/bin/python3 - "${DEFAULTS_FILE}" <<'PY'
import json, sys
try:
    data = json.loads(open(sys.argv[1]).read())
except Exception:
    raise SystemExit(0)
keys = (
    ("contextSize", "DEFAULT_CONTEXT_SIZE"), ("parallel", "DEFAULT_PARALLEL"),
    ("temperature", "DEFAULT_TEMPERATURE"), ("topP", "DEFAULT_TOP_P"),
    ("topK", "DEFAULT_TOP_K"), ("minP", "DEFAULT_MIN_P"),
    ("presencePenalty", "DEFAULT_PRESENCE_PENALTY"),
    ("repetitionPenalty", "DEFAULT_REPETITION_PENALTY"),
)
for key, var in keys:
    value = data.get(key)
    if isinstance(value, (int, float)):
        print(f"{var}={value}")
mode = data.get("mode")
if isinstance(mode, str) and mode in ("auto", "dspark", "dflash", "lookup", "baseline"):
    print(f"DEFAULT_MODE={mode}")
effort = data.get("reasoningEffort")
if isinstance(effort, str) and effort in ("", "off", "low", "medium", "high", "xhigh"):
    print(f"DEFAULT_REASONING_EFFORT={effort}")
PY
)"
  [[ -n "${parsed}" ]] && eval "${parsed}"
  return 0
}

save_defaults() {
  cat >"${DEFAULTS_FILE}" <<EOF
{
  "contextSize": ${CONTEXT_SIZE:-$DEFAULT_CONTEXT_SIZE},
  "parallel": ${PARALLEL:-$DEFAULT_PARALLEL},
  "temperature": ${TEMPERATURE:-$DEFAULT_TEMPERATURE},
  "topP": ${TOP_P:-$DEFAULT_TOP_P},
  "topK": ${TOP_K:-$DEFAULT_TOP_K},
  "minP": ${MIN_P:-$DEFAULT_MIN_P},
  "presencePenalty": ${PRESENCE_PENALTY:-$DEFAULT_PRESENCE_PENALTY},
  "repetitionPenalty": ${REPETITION_PENALTY:-$DEFAULT_REPETITION_PENALTY},
  "mode": "${MODE:-$DEFAULT_MODE}",
  "reasoningEffort": "${REASONING_EFFORT:-$DEFAULT_REASONING_EFFORT}"
}
EOF
  echo "Saved mlx-dspark defaults for ${SLOT}"
}

defaults_json() {
  cat <<EOF
{
  "contextSize": ${DEFAULT_CONTEXT_SIZE},
  "contextSizeLabel": "$((DEFAULT_CONTEXT_SIZE / 1024))K",
  "parallel": ${DEFAULT_PARALLEL},
  "temperature": ${DEFAULT_TEMPERATURE},
  "topP": ${DEFAULT_TOP_P},
  "topK": ${DEFAULT_TOP_K},
  "minP": ${DEFAULT_MIN_P},
  "presencePenalty": ${DEFAULT_PRESENCE_PENALTY},
  "repetitionPenalty": ${DEFAULT_REPETITION_PENALTY},
  "mode": "${DEFAULT_MODE}",
  "modeResolved": "$(resolve_effective_mode "${MODEL_ARG:-}" "${DEFAULT_MODE}")",
  "reasoningEffort": "${DEFAULT_REASONING_EFFORT}"
}
EOF
}

# A model key from llm3 is the model directory itself; a bare name is resolved
# against ~/models/hf the way the other MLX launchers resolve theirs.
resolve_model_dir() {
  local raw="$1"
  if [[ -d "${raw}" ]]; then
    printf '%s\n' "${raw:A}"
    return 0
  fi
  local candidate="${MODELS_DIR}/hf/${raw}"
  if [[ -d "${candidate}" ]]; then
    printf '%s\n' "${candidate:A}"
    return 0
  fi
  echo "Unknown model: ${raw}" >&2
  exit 1
}

model_metadata() {
  local dir="$1" field="$2"
  /usr/bin/python3 - "${dir}" "${field}" <<'PY'
import json, sys
from pathlib import Path
directory, field = Path(sys.argv[1]), sys.argv[2]
meta = {}
path = directory / ".llm3-hf.json"
if path.exists():
    try:
        meta = json.loads(path.read_text())
    except Exception:
        meta = {}
if field == "label":
    print(meta.get("label") or directory.name)
elif field == "size":
    total = sum(f.stat().st_size for f in directory.rglob("*") if f.is_file())
    print(f"{total / 1e9:.1f} GB")
else:
    print(meta.get(field) or "")
PY
}

status_json() {
  /usr/bin/python3 - "${STATE_FILE}" "${PID_FILE}" "${LOG_FILE}" <<'PY'
import json, os, sys
from pathlib import Path
state_path, pid_path, log_file = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]

def alive(pid):
    try:
        os.kill(pid, 0)
    except Exception:
        return False
    return True

if not state_path.exists():
    print(json.dumps({"running": False, "logs": {"server": log_file}}, indent=2))
    raise SystemExit(0)
data = json.loads(state_path.read_text())
pid = (data.get("pids") or {}).get("server")
if pid and alive(pid):
    data["running"] = True
    print(json.dumps(data, indent=2))
else:
    for path in (pid_path, state_path):
        try:
            Path(path).unlink()
        except FileNotFoundError:
            pass
    print(json.dumps({"running": False, "logs": {"server": log_file}}, indent=2))
PY
}

write_state_file() {
  local server_pid="$1"
  local runtime_model_id="${MODEL_DIR:t}"
  cat >"${STATE_FILE}" <<EOF
{
  "running": true,
  "slot": "${SLOT}",
  "model": {
    "key": "${MODEL_DIR}",
    "modelId": "${runtime_model_id}",
    "runtimeId": "${runtime_model_id}",
    "label": "${MODEL_LABEL}",
    "family": "${MODEL_FAMILY}",
    "path": "${MODEL_DIR}",
    "hfUrl": "${MODEL_HF_URL}",
    "sizeLabel": "${MODEL_SIZE_LABEL}",
    "runtime": "mlx-dspark"
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
    "mode": "${MODE}",
    "modeResolved": "${EFFECTIVE_MODE}",
    "reasoningEffort": "${REASONING_EFFORT}",
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
    "backendPort": ${PORT}
  },
  "logs": {
    "server": "${LOG_FILE}",
    "traffic": "",
    "proxy": "${LOG_FILE}"
  },
  "pids": {
    "server": ${server_pid}
  }
}
EOF
}

stop_instance() {
  local pid=""
  [[ -f "${PID_FILE}" ]] && pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}" 2>/dev/null || true
    local deadline=$((SECONDS + 20))
    while (( SECONDS < deadline )); do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "${pid}" 2>/dev/null && kill -9 "${pid}" 2>/dev/null || true
  fi
  # Anything still holding the slot port (a crashed predecessor) has to go, or
  # the next start silently binds nothing. netstat, never lsof: lsof walks every
  # descriptor on the box and stalls on a hung network mount.
  local holder=""
  holder="$(netstat -anv -p tcp 2>/dev/null | awk -v port="${PORT}" '$6=="LISTEN" && $4 ~ ("\\."port"$") {print $11}' | sed 's/.*://' | head -1 || true)"
  if [[ -n "${holder}" && "${holder}" != "0" ]] && kill -0 "${holder}" 2>/dev/null; then
    kill "${holder}" 2>/dev/null || true
    sleep 1
    kill -0 "${holder}" 2>/dev/null && kill -9 "${holder}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}" "${STATE_FILE}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot) SLOT="$2"; shift 2 ;;
    --model) MODEL_ARG="$2"; shift 2 ;;
    --context-size) CONTEXT_SIZE="$2"; shift 2 ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    --temperature) TEMPERATURE="$2"; shift 2 ;;
    --top-p) TOP_P="$2"; shift 2 ;;
    --top-k) TOP_K="$2"; shift 2 ;;
    --min-p) MIN_P="$2"; shift 2 ;;
    --presence-penalty) PRESENCE_PENALTY="$2"; shift 2 ;;
    --repetition-penalty) REPETITION_PENALTY="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --reasoning-effort) REASONING_EFFORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --pid-file) PID_FILE="$2"; shift 2 ;;
    --start) ACTION="start"; shift ;;
    --stop) ACTION="stop"; shift ;;
    --status-json) ACTION="status"; shift ;;
    --defaults-json) ACTION="defaults"; shift ;;
    --set-defaults) ACTION="set-defaults"; shift ;;
    --foreground) FOREGROUND=1; shift ;;
    --skip-stop) SKIP_STOP=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--slot slotN] [--model KEY|DIR] [--start|--stop|--status-json|--defaults-json|--set-defaults]"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

configure_slot
load_defaults

case "${ACTION}" in
  status) status_json; exit 0 ;;
  defaults) defaults_json; exit 0 ;;
  set-defaults) save_defaults; exit 0 ;;
  stop) stop_instance; echo "Stopped mlx-dspark on ${SLOT}"; exit 0 ;;
esac

[[ "${ACTION}" == "start" ]] || { echo "Nothing to do; pass --start, --stop, --status-json, --defaults-json or --set-defaults" >&2; exit 1; }
[[ -x "${BIN}" ]] || { echo "mlx-dspark is not installed at ${BIN}" >&2; exit 1; }
[[ -n "${MODEL_ARG}" ]] || { echo "--model is required to start" >&2; exit 1; }

MODEL_DIR="$(resolve_model_dir "${MODEL_ARG}")"
MODEL_LABEL="$(model_metadata "${MODEL_DIR}" label)"
MODEL_FAMILY="$(model_metadata "${MODEL_DIR}" family)"
MODEL_HF_URL="$(model_metadata "${MODEL_DIR}" hfUrl)"
MODEL_SIZE_LABEL="$(model_metadata "${MODEL_DIR}" size)"
CONTEXT_SIZE="${CONTEXT_SIZE:-$DEFAULT_CONTEXT_SIZE}"
MODE="${MODE:-$DEFAULT_MODE}"
REASONING_EFFORT="${REASONING_EFFORT:-$DEFAULT_REASONING_EFFORT}"
EFFECTIVE_MODE="$(resolve_effective_mode "${MODEL_DIR:-}" "${MODE}")"
PARALLEL="${PARALLEL:-$DEFAULT_PARALLEL}"
TEMPERATURE="${TEMPERATURE:-$DEFAULT_TEMPERATURE}"
TOP_P="${TOP_P:-$DEFAULT_TOP_P}"
TOP_K="${TOP_K:-$DEFAULT_TOP_K}"
MIN_P="${MIN_P:-$DEFAULT_MIN_P}"
PRESENCE_PENALTY="${PRESENCE_PENALTY:-$DEFAULT_PRESENCE_PENALTY}"
REPETITION_PENALTY="${REPETITION_PENALTY:-$DEFAULT_REPETITION_PENALTY}"

if (( ! SKIP_STOP )); then
  stop_instance
fi

if (( FOREGROUND )); then
  # --max-draft auto lets it calibrate the verify cap for this machine+model
  # instead of taking the conservative dspark default of 2.
  # llm3's "parallel" is mlx-dspark's --max-batch: continuous batching of up to
  # N concurrently-queued requests through one batched target forward. Note the
  # trade — batching and speculation are substitutes, not complements: at B=4
  # the upstream measurements put batched dspark at ~0.97x of batched baseline,
  # so parallel>1 buys aggregate throughput and gives back the per-stream
  # speculative win.
  # --max-draft auto calibrates a (batch, width) verify grid, and that path
  # crashes on hybrid targets in mlx-dspark 0.10.0 (BatchCache.empty reads
  # c.keys on an ArraysCache -> AttributeError), taking the whole start with it.
  # Only ask for auto when there is no batch dimension to calibrate.
  #
  # DFlash's own default cap is the FULL BLOCK, and that is its peak — forcing a cap
  # costs real speed. Measured here 2026-08-22 (mlx-community/Qwen3.8-27B-8bit + DFlash 2,
  # 5 distinct prompts x 400 tokens, medians): default 37.4 tok/s, --max-draft 16 35.5,
  # --max-draft 12 33.8, --max-draft auto 33.1. So only the dspark path gets a cap.
  # (--max-batch is inert under dflash anyway: server.py:1741 only batches dspark/baseline.)
  # "off" = --no-thinking; a level = --reasoning-effort; "" = leave the template alone.
  local -a think_args
  think_args=()
  if [[ "${REASONING_EFFORT}" == "off" ]]; then
    think_args=(--no-thinking)
  elif [[ -n "${REASONING_EFFORT}" ]]; then
    think_args=(--reasoning-effort "${REASONING_EFFORT}")
  fi

  local -a draft_args
  draft_args=()
  if [[ "${EFFECTIVE_MODE}" != "dflash" ]]; then
    if [[ "${PARALLEL}" -gt 1 ]]; then
      draft_args=(--max-draft 4)
    else
      draft_args=(--max-draft auto)
    fi
  fi

  exec "${BIN}" serve \
    --model "${MODEL_DIR}" \
    --mode "${MODE}" \
    --max-batch "${PARALLEL}" \
    "${draft_args[@]}" \
    "${think_args[@]}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --context-window "${CONTEXT_SIZE}" \
    --default-temperature "${TEMPERATURE}" \
    --default-top-p "${TOP_P}" \
    --default-top-k "${TOP_K}"
fi

server_pid="$(
  spawn_detached "${LOG_FILE}" "$0" --foreground --skip-stop --slot "${SLOT}" --model "${MODEL_DIR}" \
    --host "${HOST}" --port "${PORT}" --state-dir "${STATE_DIR}" --log-file "${LOG_FILE}" --pid-file "${PID_FILE}" \
    --context-size "${CONTEXT_SIZE}" --parallel "${PARALLEL}" --mode "${MODE}" \
    --reasoning-effort "${REASONING_EFFORT}" \
    --temperature "${TEMPERATURE}" --top-p "${TOP_P}" --top-k "${TOP_K}" --min-p "${MIN_P}" \
    --presence-penalty "${PRESENCE_PENALTY}" --repetition-penalty "${REPETITION_PENALTY}" --start
)"

echo "${server_pid}" > "${PID_FILE}"

# A 27B 8-bit target plus its drafter is ~31GB of weights to page in; the other
# launchers allow 180s for far less.
if ! wait_for_http "http://127.0.0.1:${PORT}/v1/models" 300; then
  echo "Timed out waiting for mlx-dspark on ${HOST}:${PORT} (see ${LOG_FILE})" >&2
  exit 1
fi

write_state_file "${server_pid}"
echo "Started mlx-dspark (${MODE}) on ${HOST}:${PORT}"
echo "PID: ${server_pid}"
echo "Log: ${LOG_FILE}"
echo "Model: ${MODEL_DIR}"
echo "Context size: ${CONTEXT_SIZE} tokens"
