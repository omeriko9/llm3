#!/bin/zsh
# mlx-vlm launcher — the only host on this box that can serve a qwen4_exp target.
#
# Why this exists at all. mlx-dspark drives an mlx-vlm model through
# `lm.logits_from_hidden(...)` (mlx_dspark/target.py, the `is_vlm` branch), and
# that hook is defined by exactly two mlx-vlm families: gemma4 and
# minimax_m3_vl. Qwen3.8-Flash-Next (`model_type: qwen4_exp`) inherits from
# Qwen3_5LanguageModel, which only defines `speculative_logits_from_hidden`, so
# every mlx-dspark mode -- including baseline -- dies with
#   AttributeError: 'LanguageModel' object has no attribute 'logits_from_hidden'
# Checked against mlx-vlm 0.6.15, 0.6.17 and git main, and mlx-dspark 0.15.1 and
# 0.17.2: none of them close that gap, so this is not a version to wait out.
# mlx-vlm's own OpenAI-compatible server has no such requirement.
#
# Measured on this box (M4 Max, sh0wie/Qwen3.8-Flash-Next-REAP-288-MLX-4bit,
# 68GB of 4-bit weights, 200 tokens, warm):
#   24.4 tok/s code · 27.7 tok/s prose · 27.9 tok/s code   (load 12s)
# No speculative decoding is involved in those numbers: that copy carries no MTP
# head (config declares mtp_num_hidden_layers 1, the weight index has 0 mtp
# tensors -- REAP pruning dropped it). Pass --draft-model/--draft-kind for a
# target that does ship one.
#
# The server speaks /v1 directly, so like mlx-dspark there is no proxy layer and
# it binds the slot's public port itself.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
source "$SCRIPT_DIR/lib/launcher-common.zsh"

# mlx-vlm lives in the mlx-dspark venv -- it is mlx-dspark's own dependency, so
# the two are guaranteed compatible there and there is nothing to keep in sync.
# Point MLX_VLM_VENV at a dedicated env if you ever need to upgrade mlx-vlm for
# this launcher without moving it under mlx-dspark.
VENV="${MLX_VLM_VENV:-$HOME/.venvs/mlx-dspark}"
PY_BIN="${VENV}/bin/python"
MODELS_DIR="${LLM3_MODELS_DIR:-$HOME/models}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/mlx_vlm"

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
DRAFT_MODEL="${MLX_VLM_DRAFT_MODEL:-}"
DRAFT_KIND="${MLX_VLM_DRAFT_KIND:-}"
REASONING_EFFORT=""
ACTION=""
FOREGROUND=0
SKIP_STOP=0

DEFAULT_CONTEXT_SIZE=32768
DEFAULT_PARALLEL=1
# mlx_vlm.server takes no --default-temperature/--top-p/--top-k: sampling is
# per-request only. These are still accepted and recorded, so llm3's slot card
# and the saved profile keep reporting the same fields as every other launcher,
# but they are NOT passed to the server. Set them on the request instead.
DEFAULT_TEMPERATURE=0.6
DEFAULT_TOP_P=0.95
DEFAULT_TOP_K=20
DEFAULT_MIN_P=0
DEFAULT_PRESENCE_PENALTY=0
DEFAULT_REPETITION_PENALTY=1
# "" = no drafter (plain decoding). A drafter needs BOTH a repo and a kind;
# "mtp" reuses the target's own multi-token-prediction head, so for that kind
# the drafter repo is the target itself.
DEFAULT_DRAFT_MODEL=""
DEFAULT_DRAFT_KIND=""
# "" = leave the model's chat template alone. "off" maps to no thinking; any
# level turns thinking on (mlx_vlm.server has --enable-thinking, a boolean, not
# graded efforts, so the levels collapse to on).
DEFAULT_REASONING_EFFORT=""

configure_slot() {
  local index=""
  index="$(slot_index "${SLOT}")"
  [[ -n "${STATE_DIR}" ]] || STATE_DIR="${STATE_ROOT}/${SLOT}"
  # Same public port per slot as every other launcher: one runtime owns a slot
  # at a time, so they deliberately share 8036+n and llm3's slot plumbing needs
  # no per-launcher knowledge.
  [[ -n "${PORT}" ]] || PORT="$((8036 + index - 1))"
  [[ -n "${LOG_FILE}" ]] || LOG_FILE="${STATE_DIR}/mlx-vlm-api.log"
  [[ -n "${PID_FILE}" ]] || PID_FILE="${STATE_DIR}/mlx-vlm-api.pid"
  STATE_FILE="${STATE_DIR}/current.json"
  DEFAULTS_FILE="${STATE_DIR}/defaults.json"
  mkdir -p "${STATE_DIR}"
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
effort = data.get("reasoningEffort")
if isinstance(effort, str) and effort in ("", "off", "low", "medium", "high", "xhigh"):
    print(f"DEFAULT_REASONING_EFFORT={effort}")
kind = data.get("draftKind")
if isinstance(kind, str) and kind in ("", "dflash", "eagle3", "mtp"):
    print(f"DEFAULT_DRAFT_KIND={kind}")
repo = data.get("draftModel")
if isinstance(repo, str) and "'" not in repo:
    print(f"DEFAULT_DRAFT_MODEL='{repo}'")
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
  "reasoningEffort": "${REASONING_EFFORT:-$DEFAULT_REASONING_EFFORT}",
  "draftModel": "${DRAFT_MODEL:-$DEFAULT_DRAFT_MODEL}",
  "draftKind": "${DRAFT_KIND:-$DEFAULT_DRAFT_KIND}"
}
EOF
  echo "Saved mlx-vlm defaults for ${SLOT}"
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
  "reasoningEffort": "${DEFAULT_REASONING_EFFORT}",
  "draftModel": "${DEFAULT_DRAFT_MODEL}",
  "draftKind": "${DEFAULT_DRAFT_KIND}"
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
  # mlx_vlm.server keys /v1 requests by the --model string it was given, which
  # for a local target is the absolute directory. Report that as the runtime id
  # so llm3's chat and the applications that sync to a slot send a model name
  # the server will actually match.
  local runtime_model_id="${MODEL_DIR}"
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
    "runtime": "mlx-vlm"
  },
  "params": {
    "ctxSize": ${CONTEXT_SIZE},
    "parallel": ${PARALLEL},
    "thinking": ${THINKING_BOOL},
    "temperature": ${TEMPERATURE},
    "topP": ${TOP_P},
    "topK": ${TOP_K},
    "minP": ${MIN_P},
    "presencePenalty": ${PRESENCE_PENALTY},
    "repetitionPenalty": ${REPETITION_PENALTY},
    "reasoningEffort": "${REASONING_EFFORT}",
    "draftModel": "${DRAFT_MODEL}",
    "draftKind": "${DRAFT_KIND}",
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
    --reasoning-effort) REASONING_EFFORT="$2"; shift 2 ;;
    --draft-model) DRAFT_MODEL="$2"; shift 2 ;;
    --draft-kind) DRAFT_KIND="$2"; shift 2 ;;
    --mode) shift 2 ;;   # accepted and ignored: mlx-vlm has no mode registry
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
  stop) stop_instance; echo "Stopped mlx-vlm on ${SLOT}"; exit 0 ;;
esac

[[ "${ACTION}" == "start" ]] || { echo "Nothing to do; pass --start, --stop, --status-json, --defaults-json or --set-defaults" >&2; exit 1; }
[[ -x "${PY_BIN}" ]] || { echo "mlx-vlm venv python is not at ${PY_BIN}" >&2; exit 1; }
"${PY_BIN}" -c "import mlx_vlm" 2>/dev/null || { echo "mlx-vlm is not installed in ${VENV}" >&2; exit 1; }
[[ -n "${MODEL_ARG}" ]] || { echo "--model is required to start" >&2; exit 1; }

MODEL_DIR="$(resolve_model_dir "${MODEL_ARG}")"
MODEL_LABEL="$(model_metadata "${MODEL_DIR}" label)"
MODEL_FAMILY="$(model_metadata "${MODEL_DIR}" family)"
MODEL_HF_URL="$(model_metadata "${MODEL_DIR}" hfUrl)"
MODEL_SIZE_LABEL="$(model_metadata "${MODEL_DIR}" size)"
CONTEXT_SIZE="${CONTEXT_SIZE:-$DEFAULT_CONTEXT_SIZE}"
PARALLEL="${PARALLEL:-$DEFAULT_PARALLEL}"
TEMPERATURE="${TEMPERATURE:-$DEFAULT_TEMPERATURE}"
TOP_P="${TOP_P:-$DEFAULT_TOP_P}"
TOP_K="${TOP_K:-$DEFAULT_TOP_K}"
MIN_P="${MIN_P:-$DEFAULT_MIN_P}"
PRESENCE_PENALTY="${PRESENCE_PENALTY:-$DEFAULT_PRESENCE_PENALTY}"
REPETITION_PENALTY="${REPETITION_PENALTY:-$DEFAULT_REPETITION_PENALTY}"
REASONING_EFFORT="${REASONING_EFFORT:-$DEFAULT_REASONING_EFFORT}"
DRAFT_MODEL="${DRAFT_MODEL:-$DEFAULT_DRAFT_MODEL}"
DRAFT_KIND="${DRAFT_KIND:-$DEFAULT_DRAFT_KIND}"

if [[ -n "${REASONING_EFFORT}" && "${REASONING_EFFORT}" != "off" ]]; then
  THINKING_BOOL=true
else
  THINKING_BOOL=false
fi

# A drafter needs both halves. Naming one without the other is a silent no-op in
# mlx_vlm.server, which is exactly the kind of "speculation is on, right?" that
# costs an afternoon -- so refuse it here instead.
if [[ -n "${DRAFT_KIND}" && -z "${DRAFT_MODEL}" && "${DRAFT_KIND}" != "mtp" ]]; then
  echo "--draft-kind ${DRAFT_KIND} also needs --draft-model <repo>" >&2
  exit 1
fi
if [[ -n "${DRAFT_MODEL}" && -z "${DRAFT_KIND}" ]]; then
  echo "--draft-model also needs --draft-kind {dflash,eagle3,mtp}" >&2
  exit 1
fi
# "mtp" reuses the target's own draft head, so the drafter repo is the target.
if [[ "${DRAFT_KIND}" == "mtp" && -z "${DRAFT_MODEL}" ]]; then
  DRAFT_MODEL="${MODEL_DIR}"
fi

if (( ! SKIP_STOP )); then
  stop_instance
fi

if (( FOREGROUND )); then
  local -a think_args draft_args
  think_args=()
  if [[ "${THINKING_BOOL}" == "true" ]]; then
    think_args=(--enable-thinking)
  fi
  draft_args=()
  if [[ -n "${DRAFT_KIND}" ]]; then
    draft_args=(--draft-model "${DRAFT_MODEL}" --draft-kind "${DRAFT_KIND}")
  fi

  # --max-kv-size is mlx-vlm's context bound; there is no --context-window here.
  # --max-num-seqs is its continuous-batching width, i.e. llm3's "parallel".
  exec "${PY_BIN}" -m mlx_vlm.server \
    --model "${MODEL_DIR}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --max-kv-size "${CONTEXT_SIZE}" \
    --max-num-seqs "${PARALLEL}" \
    "${think_args[@]}" \
    "${draft_args[@]}" \
    --log-level INFO
fi

server_pid="$(
  spawn_detached "${LOG_FILE}" "$0" --foreground --skip-stop --slot "${SLOT}" --model "${MODEL_DIR}" \
    --host "${HOST}" --port "${PORT}" --state-dir "${STATE_DIR}" --log-file "${LOG_FILE}" --pid-file "${PID_FILE}" \
    --context-size "${CONTEXT_SIZE}" --parallel "${PARALLEL}" \
    --reasoning-effort "${REASONING_EFFORT}" \
    --draft-model "${DRAFT_MODEL}" --draft-kind "${DRAFT_KIND}" \
    --temperature "${TEMPERATURE}" --top-p "${TOP_P}" --top-k "${TOP_K}" --min-p "${MIN_P}" \
    --presence-penalty "${PRESENCE_PENALTY}" --repetition-penalty "${REPETITION_PENALTY}" --start
)"

echo "${server_pid}" > "${PID_FILE}"

# 68GB of 4-bit weights loaded in 12s warm here, but a cold page-in off the SSD
# is the case that matters; the other MLX launchers allow 180-300s.
if ! wait_for_http "http://127.0.0.1:${PORT}/v1/models" 300; then
  echo "Timed out waiting for mlx-vlm on ${HOST}:${PORT} (see ${LOG_FILE})" >&2
  exit 1
fi

write_state_file "${server_pid}"
echo "Started mlx-vlm on ${HOST}:${PORT}"
echo "PID: ${server_pid}"
echo "Log: ${LOG_FILE}"
echo "Model: ${MODEL_DIR}"
echo "Context size: ${CONTEXT_SIZE} tokens"
if [[ -n "${DRAFT_KIND}" ]]; then
  echo "Drafter: ${DRAFT_KIND} (${DRAFT_MODEL})"
fi
