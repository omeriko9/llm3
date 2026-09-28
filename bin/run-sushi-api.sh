#!/bin/zsh
# sushi launcher — beamivalice/sushi, a native MLX engine (a detached fork of
# mlx-serve) for Qwen3.8-Flash-Next "Sushi" packs.
#
# Why this exists. A Sushi pack is not an ordinary MLX checkpoint: the routed
# experts are EXL3 tensors (one safetensors file per layer and projection), the
# rest is affine, and the PLE n-gram table is a separate ngram_table.bin that the
# engine reads from the SSD and never makes resident. mlx-vlm and mlx-dspark see
# `model_type: qwen4_exp` and a config.json, but they cannot decode EXL3 and do
# not know the table, so the pack runs on sushi only.
#
# The table has two published formats, named by config.json's "ngram_table":
#   bits 16 (bf16, 102 GB, the Sushi-4bpw repo)
#   bits 4 group 32 (32 GB, the Sushi-2.6bpw / Sushi-3bpw repos)
# Either table works with either pack. The engine keeps a table in the page cache
# only while it is under half of RAM, so on 128 GB the 4-bit table stays warm and
# the bf16 one is read from the SSD on every token.
#
# The engine is a prebuilt release binary (sushi-bin-macos-arm64.tar.gz), not a
# build tree: building it needs full Xcode for the Metal toolchain. SUSHI_HOME is
# the unpacked release directory.
#
# The server speaks /v1, and like mlx-vlm it runs on a backend port behind
# src/slot-api-proxy.py (with --no-sampling-defaults), so llm3's Logs -> Thinking
# and Traffic tabs get their lines.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
source "$SCRIPT_DIR/lib/launcher-common.zsh"

SUSHI_HOME="${SUSHI_HOME:-$HOME/sushi/sushi-macos-arm64}"
BIN="${SUSHI_HOME}/sushi"
MODELS_DIR="${LLM3_MODELS_DIR:-$HOME/models}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/sushi"

SLOT="slot1"
STATE_DIR=""
PORT=""
BACKEND_PORT=""
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
MTP=""
MTP_DRAFT=""
KV_QUANT=""
PREFILL_CHUNK=""
REASONING_EFFORT=""
REASONING_EFFORT_GIVEN=0
ACTION=""
FOREGROUND=0
SKIP_STOP=0

# The README's 128 GB launch uses 500K. 256K keeps 4 GiB of KV next to the
# 63.7 GiB of Sushi-4bpw weights and leaves room for the 4-bit table in the page
# cache and for another slot; raise it per slot when you need the length.
DEFAULT_CONTEXT_SIZE=262144
# sushi has no batching width flag here; one request decodes at a time.
DEFAULT_PARALLEL=1
# Serve-mode defaults for requests that omit them (--temp/--top-p/--top-k).
# Qwen3.8's recommended sampling; the README launches at --temp 1.
DEFAULT_TEMPERATURE=1
DEFAULT_TOP_P=0.95
DEFAULT_TOP_K=20
DEFAULT_MIN_P=0
DEFAULT_PRESENCE_PENALTY=0
DEFAULT_REPETITION_PENALTY=1
# The model's own MTP head. "on" forces it (--mtp, needed for an SSD-streamed
# pack); "off" passes --no-mtp.
DEFAULT_MTP=on
# 0 = sushi's adaptive depth controller (up to 6 on chips before M5).
DEFAULT_MTP_DRAFT=0
# 8-bit KV is the README default; 4 gives 1.8x the context at a small KLD cost.
DEFAULT_KV_QUANT=8
# The README's 96 GB+ launch caps prefill at 2048 tokens per step for memory.
DEFAULT_PREFILL_CHUNK=2048
# Thinking is a per-request field on this server; recorded for the slot card.
DEFAULT_REASONING_EFFORT=""

configure_slot() {
  local index=""
  index="$(slot_index "${SLOT}")"
  [[ -n "${STATE_DIR}" ]] || STATE_DIR="${STATE_ROOT}/${SLOT}"
  [[ -n "${PORT}" ]] || PORT="$((8036 + index - 1))"
  # llm3's MLX backend port base (MLX_BACKEND_PORT_BASE in src/server.js). One
  # runtime owns a slot at a time, so the MLX-family launchers share it.
  [[ -n "${BACKEND_PORT}" ]] || BACKEND_PORT="$((18136 + index - 1))"
  [[ -n "${LOG_FILE}" ]] || LOG_FILE="${STATE_DIR}/sushi-api.log"
  PROXY_LOG_FILE="${STATE_DIR}/proxy.log"
  TRAFFIC_LOG_FILE="${STATE_DIR}/traffic.log"
  [[ -n "${PID_FILE}" ]] || PID_FILE="${STATE_DIR}/sushi-api.pid"
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
for key, var in (
    ("contextSize", "DEFAULT_CONTEXT_SIZE"), ("parallel", "DEFAULT_PARALLEL"),
    ("temperature", "DEFAULT_TEMPERATURE"), ("topP", "DEFAULT_TOP_P"),
    ("topK", "DEFAULT_TOP_K"), ("minP", "DEFAULT_MIN_P"),
    ("presencePenalty", "DEFAULT_PRESENCE_PENALTY"),
    ("repetitionPenalty", "DEFAULT_REPETITION_PENALTY"),
    ("mtpDraft", "DEFAULT_MTP_DRAFT"), ("prefillChunk", "DEFAULT_PREFILL_CHUNK"),
):
    value = data.get(key)
    if isinstance(value, (int, float)):
        print(f"{var}={value}")
mtp = data.get("mtp")
if isinstance(mtp, str) and mtp in ("on", "off"):
    print(f"DEFAULT_MTP={mtp}")
kv = data.get("kvQuant")
if isinstance(kv, str) and kv in ("off", "4", "8"):
    print(f"DEFAULT_KV_QUANT={kv}")
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
  "mtp": "${MTP:-$DEFAULT_MTP}",
  "mtpDraft": ${MTP_DRAFT:-$DEFAULT_MTP_DRAFT},
  "kvQuant": "${KV_QUANT:-$DEFAULT_KV_QUANT}",
  "prefillChunk": ${PREFILL_CHUNK:-$DEFAULT_PREFILL_CHUNK},
  "reasoningEffort": "$( (( REASONING_EFFORT_GIVEN )) && printf '%s' "${REASONING_EFFORT}" || printf '%s' "${DEFAULT_REASONING_EFFORT}" )"
}
EOF
  echo "Saved sushi defaults for ${SLOT}"
}

defaults_json() {
  cat <<EOF
{
  "contextSize": ${DEFAULT_CONTEXT_SIZE},
  "contextSizeLabel": "$(context_label "${DEFAULT_CONTEXT_SIZE}")",
  "parallel": ${DEFAULT_PARALLEL},
  "temperature": ${DEFAULT_TEMPERATURE},
  "topP": ${DEFAULT_TOP_P},
  "topK": ${DEFAULT_TOP_K},
  "minP": ${DEFAULT_MIN_P},
  "presencePenalty": ${DEFAULT_PRESENCE_PENALTY},
  "repetitionPenalty": ${DEFAULT_REPETITION_PENALTY},
  "mtp": "${DEFAULT_MTP}",
  "mtpDraft": ${DEFAULT_MTP_DRAFT},
  "kvQuant": "${DEFAULT_KV_QUANT}",
  "prefillChunk": ${DEFAULT_PREFILL_CHUNK},
  "reasoningEffort": "${DEFAULT_REASONING_EFFORT}"
}
EOF
}

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
    # Follow symlinks: the 4-bit-table variant links the weights of another pack.
    total = sum(f.stat().st_size for f in directory.iterdir() if f.is_file() and f.suffix in (".safetensors", ".bin"))
    print(f"{total / 1e9:.1f} GB")
else:
    print(meta.get(field) or "")
PY
}

status_json() {
  /usr/bin/python3 - "${STATE_FILE}" "${PID_FILE}" "${LOG_FILE}" "${PROXY_LOG_FILE}" "${TRAFFIC_LOG_FILE}" <<'PY'
import json, os, sys
from pathlib import Path
state_path, pid_path, log_file = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
idle_logs = {"server": log_file, "proxy": sys.argv[4], "traffic": sys.argv[5]}

def alive(pid):
    try:
        os.kill(pid, 0)
    except Exception:
        return False
    return True

if not state_path.exists():
    print(json.dumps({"running": False, "logs": idle_logs}, indent=2))
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
    print(json.dumps({"running": False, "logs": idle_logs}, indent=2))
PY
}

write_state_file() {
  local server_pid="$1"
  # Report the id the server itself lists, so llm3's chat and the applications
  # that sync to a slot send a model name it matches.
  local runtime_model_id=""
  runtime_model_id="$(curl -fsS -m 5 "http://127.0.0.1:${BACKEND_PORT}/v1/models" 2>/dev/null \
    | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("data") or [{}])[0].get("id",""))' 2>/dev/null || true)"
  [[ -n "${runtime_model_id}" ]] || runtime_model_id="${MODEL_DIR:t}"
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
    "runtime": "sushi"
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
    "mtp": "${MTP}",
    "mtpDraft": ${MTP_DRAFT},
    "kvQuant": "${KV_QUANT}",
    "prefillChunk": ${PREFILL_CHUNK},
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
    "backendPort": ${BACKEND_PORT}
  },
  "logs": {
    "server": "${LOG_FILE}",
    "traffic": "${TRAFFIC_LOG_FILE}",
    "proxy": "${PROXY_LOG_FILE}"
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
    local deadline=$((SECONDS + 30))
    while (( SECONDS < deadline )); do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "${pid}" 2>/dev/null && kill -9 "${pid}" 2>/dev/null || true
  fi
  kill_port_listener "${PORT}"
  kill_port_listener "${BACKEND_PORT}"
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
    --mtp) MTP="$2"; shift 2 ;;
    --mtp-draft) MTP_DRAFT="$2"; shift 2 ;;
    --kv-quant) KV_QUANT="$2"; shift 2 ;;
    --prefill-chunk) PREFILL_CHUNK="$2"; shift 2 ;;
    --reasoning-effort) REASONING_EFFORT="$2"; REASONING_EFFORT_GIVEN=1; shift 2 ;;
    --mode) shift 2 ;;   # accepted and ignored: sushi has no mode registry
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
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
      echo "Usage: $0 [--slot slotN] [--model DIR] [--mtp on|off] [--mtp-draft N] [--kv-quant off|4|8] [--start|--stop|--status-json|--defaults-json|--set-defaults]"
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
  stop) stop_instance; echo "Stopped sushi on ${SLOT}"; exit 0 ;;
esac

[[ "${ACTION}" == "start" ]] || { echo "Nothing to do; pass --start, --stop, --status-json, --defaults-json or --set-defaults" >&2; exit 1; }
[[ -x "${BIN}" ]] || { echo "sushi is not installed at ${BIN}. Unpack the sushi-bin-macos-arm64 release there or set SUSHI_HOME." >&2; exit 1; }
[[ -n "${MODEL_ARG}" ]] || { echo "--model is required to start" >&2; exit 1; }

MODEL_DIR="$(resolve_model_dir "${MODEL_ARG}")"
[[ -f "${MODEL_DIR}/ngram_table.bin" ]] || { echo "No ngram_table.bin in ${MODEL_DIR}; a Sushi pack cannot load without its n-gram table." >&2; exit 1; }
MODEL_LABEL="$(model_metadata "${MODEL_DIR}" label)"
MODEL_FAMILY="$(model_metadata "${MODEL_DIR}" family)"
MODEL_HF_URL="$(model_metadata "${MODEL_DIR}" hfUrl)"
MODEL_SIZE_LABEL="$(model_metadata "${MODEL_DIR}" size)"
CONTEXT_SIZE="$(parse_context_size "${CONTEXT_SIZE:-$DEFAULT_CONTEXT_SIZE}")"
PARALLEL="${PARALLEL:-$DEFAULT_PARALLEL}"
TEMPERATURE="${TEMPERATURE:-$DEFAULT_TEMPERATURE}"
TOP_P="${TOP_P:-$DEFAULT_TOP_P}"
TOP_K="${TOP_K:-$DEFAULT_TOP_K}"
MIN_P="${MIN_P:-$DEFAULT_MIN_P}"
PRESENCE_PENALTY="${PRESENCE_PENALTY:-$DEFAULT_PRESENCE_PENALTY}"
REPETITION_PENALTY="${REPETITION_PENALTY:-$DEFAULT_REPETITION_PENALTY}"
MTP="${MTP:-$DEFAULT_MTP}"
MTP_DRAFT="${MTP_DRAFT:-$DEFAULT_MTP_DRAFT}"
KV_QUANT="${KV_QUANT:-$DEFAULT_KV_QUANT}"
PREFILL_CHUNK="${PREFILL_CHUNK:-$DEFAULT_PREFILL_CHUNK}"
(( REASONING_EFFORT_GIVEN )) || REASONING_EFFORT="${DEFAULT_REASONING_EFFORT}"

if [[ "${MTP}" != "on" && "${MTP}" != "off" ]]; then
  echo "--mtp takes on or off, not ${MTP}" >&2
  exit 1
fi
if [[ -n "${REASONING_EFFORT}" && "${REASONING_EFFORT}" != "off" ]]; then
  THINKING_BOOL=true
else
  THINKING_BOOL=false
fi

if (( ! SKIP_STOP )); then
  stop_instance
fi

if (( FOREGROUND )); then
  typeset -a extra_args
  extra_args=()
  if [[ "${MTP}" == "on" ]]; then
    extra_args+=(--mtp --mtp-head-kv-quant)
    if (( MTP_DRAFT > 0 )); then
      extra_args+=(--mtp-depth "${MTP_DRAFT}")
    fi
  else
    extra_args+=(--no-mtp)
  fi
  if [[ -n "${PREFILL_CHUNK}" && "${PREFILL_CHUNK}" != "0" ]]; then
    extra_args+=(--prefill-chunk "${PREFILL_CHUNK}")
  fi

  # --max-tokens is only the default for a request that omits the field. One
  # hot prefix entry keeps the RAM tier to one conversation, as the README
  # recommends for a single client; the SSD tier lives under ~/.sushi/kv-cache.
  serve_behind_slot_proxy "${BACKEND_PORT}" "${HOST}" "${PORT}" "${PROXY_LOG_FILE}" "${TRAFFIC_LOG_FILE}" -- \
    "${BIN}" serve \
    --model "${MODEL_DIR}" \
    --host 127.0.0.1 \
    --port "${BACKEND_PORT}" \
    --ctx-size "${CONTEXT_SIZE}" \
    --kv-quant "${KV_QUANT}" \
    --max-tokens 64000 \
    --temp "${TEMPERATURE}" \
    --top-p "${TOP_P}" \
    --top-k "${TOP_K}" \
    --prefix-cache-entries 1 \
    --prefix-cache-mem 2GB \
    --prefix-cache-disk 20GB \
    "${extra_args[@]}"
fi

server_pid="$(
  spawn_detached "${LOG_FILE}" "$0" --foreground --skip-stop --slot "${SLOT}" --model "${MODEL_DIR}" \
    --host "${HOST}" --port "${PORT}" --backend-port "${BACKEND_PORT}" --state-dir "${STATE_DIR}" --log-file "${LOG_FILE}" --pid-file "${PID_FILE}" \
    --context-size "${CONTEXT_SIZE}" --parallel "${PARALLEL}" \
    --mtp "${MTP}" --mtp-draft "${MTP_DRAFT}" --kv-quant "${KV_QUANT}" --prefill-chunk "${PREFILL_CHUNK}" \
    --reasoning-effort "${REASONING_EFFORT}" \
    --temperature "${TEMPERATURE}" --top-p "${TOP_P}" --top-k "${TOP_K}" --min-p "${MIN_P}" \
    --presence-penalty "${PRESENCE_PENALTY}" --repetition-penalty "${REPETITION_PENALTY}" --start
)"

echo "${server_pid}" > "${PID_FILE}"

# 64 GiB of weights from a cold page cache is the case that matters. The public
# port answers only once the backend is up (300s inside) and the proxy has
# started, hence a little more.
if ! wait_for_http "http://127.0.0.1:${PORT}/v1/models" 330; then
  echo "Timed out waiting for sushi on ${HOST}:${PORT} (see ${LOG_FILE})" >&2
  exit 1
fi

write_state_file "${server_pid}"
echo "Started sushi on ${HOST}:${PORT}"
echo "PID: ${server_pid}"
echo "Log: ${LOG_FILE}"
echo "Proxy log: ${PROXY_LOG_FILE} (backend 127.0.0.1:${BACKEND_PORT})"
echo "Model: ${MODEL_DIR}"
echo "Context size: ${CONTEXT_SIZE} tokens"
echo "MTP: ${MTP}$( [[ "${MTP}" == "on" ]] && echo " (depth ${MTP_DRAFT:-adaptive})" ) · KV ${KV_QUANT}-bit"
