#!/bin/zsh
# ds4 launcher — DwarfStar (antirez/ds4) native Metal engine, ivanfioravanti's
# qwen3.8-flash-next branch.
#
# Why this exists. Qwen3.8-Flash-Next (arch qwen4exp) has three hosts on this
# box and each one leaves speed on the table:
#   * llama.cpp  — the unsloth GGUF loads, but there is no MTP head for it here.
#   * mlx-vlm    — 24.4-27.9 tok/s on the REAP-288 4-bit copy, no speculation
#                  (that copy carries no MTP weights at all).
#   * ds4        — 42-57 tok/s on the full 512-expert model.
# ds4 is not a GGUF runner. It reads ONE pack GGUF written by its own converter
# plus a mandatory external PLE sidecar, and it rejects an ordinary GGUF or an
# unsloth quant. Do not point it at ~/models/hf/unsloth__Qwen3.8-Flash-Next-GGUF.
#
# Measured on this box (M4 Max 40-core, 128 GB, ivanfioravanti/Qwen3.8-Flash-Next-DS4-IQ2,
# 250 greedy tokens, --nothink, four distinct prose/technical prompts):
#   plain decode          42.1 - 43.4 tok/s
#   --mtp --mtp-draft 2   52.3 - 57.2 tok/s
# The run-to-run band is about +-3 tok/s, which is WIDER than every Metal tuning
# knob measured here (DS4_QWEN4_LAYERS_PER_COMMAND_BUFFER 4/8/16 and
# DS4_QWEN4_SILU_WIDE all landed inside it), so the stock kernel defaults stay.
# --mtp-margin 1/2/3/5/8 was also flat. Only --mtp itself is a real win.
#
# NOTE the model card says Q2+MTP nets BELOW plain decode. That was measured on
# an M3 Ultra. It is false on this M4 Max, where MTP is worth about +25 percent,
# so MTP is on by default here.
#
# CAUTION: --parallel > 1 maps to ds4-server --batched-session, and ds4 serves a
# batched session with ordinary target decoding, NOT MTP. Two slots therefore
# cost more than half the speed each. Keep parallel at 1 unless you need
# concurrency more than throughput.
#
# ds4-server is OpenAI-compatible on /v1 (chat/completions, responses,
# completions, and Anthropic-style messages), so like mlx-dspark and mlx-vlm it
# binds the slot's public port directly and needs no proxy layer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
source "$SCRIPT_DIR/lib/launcher-common.zsh"

# The build tree. ds4-server needs --chdir into it at runtime because the Metal
# kernels are compiled from the .metal sources next to the binary, not embedded.
DS4_HOME="${DS4_HOME:-$HOME/ds4-metal}"
BIN="${DS4_HOME}/ds4-server"
MODELS_DIR="${LLM3_MODELS_DIR:-$HOME/models}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/ds4"

SLOT="slot1"
STATE_DIR=""
PORT=""
HOST="0.0.0.0"
LOG_FILE=""
PID_FILE=""
MODEL_ARG=""
PLE_ARG=""
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
PREFILL_CHUNK=""
REASONING_EFFORT=""
ACTION=""
FOREGROUND=0
SKIP_STOP=0

# 32K costs 50.2 GiB of the 128 GB with the 41.7 GiB pack resident, so this is a
# conservative default, not a memory limit.
DEFAULT_CONTEXT_SIZE=32768
DEFAULT_PARALLEL=1
# ds4-server takes no default-sampling flags: temperature, top-p, top-k and min-p
# are per-request only (its own defaults are temp 1, top-p 1, min-p 0.05). These
# are accepted and recorded so llm3's slot card and saved profile keep the same
# fields as every other launcher, but they are NOT passed to the server. Set them
# on the request instead. Same arrangement as bin/run-mlx-vlm-api.sh.
DEFAULT_TEMPERATURE=0.7
DEFAULT_TOP_P=0.8
DEFAULT_TOP_K=20
DEFAULT_MIN_P=0
DEFAULT_PRESENCE_PENALTY=0
DEFAULT_REPETITION_PENALTY=1
# "on" = --mtp (the model-embedded MTP head; this pack ships one). "off" = plain
# target decode.
DEFAULT_MTP=on
# Sweep on this box at ctx 8192 (250 tokens each): 54.7 / 57.2 / 53.6 / 54.3 /
# 53.5 tok/s at depths 1-5. Depth 2 led, but by less than the run-to-run band.
DEFAULT_MTP_DRAFT=2
# "" = let ds4 choose (auto: 8192 for a long uncached suffix, 2048 on a
# prefix-cache resume). An explicit value is STRICT in ds4 and fails with a
# memory or geometry error instead of falling back, so do not pin one casually.
DEFAULT_PREFILL_CHUNK=""
# ds4-server has no graded reasoning-effort flag; thinking is a per-request
# field. Recorded for the slot card only.
DEFAULT_REASONING_EFFORT=""

configure_slot() {
  local index=""
  index="$(slot_index "${SLOT}")"
  [[ -n "${STATE_DIR}" ]] || STATE_DIR="${STATE_ROOT}/${SLOT}"
  # Same public port per slot as every other launcher: one runtime owns a slot
  # at a time, so they share 8036+n and llm3's slot plumbing needs no
  # per-launcher knowledge.
  [[ -n "${PORT}" ]] || PORT="$((8036 + index - 1))"
  [[ -n "${LOG_FILE}" ]] || LOG_FILE="${STATE_DIR}/ds4-api.log"
  [[ -n "${PID_FILE}" ]] || PID_FILE="${STATE_DIR}/ds4-api.pid"
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
    ("mtpDraft", "DEFAULT_MTP_DRAFT"),
):
    value = data.get(key)
    if isinstance(value, (int, float)):
        print(f"{var}={value}")
mtp = data.get("mtp")
if isinstance(mtp, str) and mtp in ("on", "off"):
    print(f"DEFAULT_MTP={mtp}")
chunk = data.get("prefillChunk")
if isinstance(chunk, (int, float)) and int(chunk) > 0:
    print(f"DEFAULT_PREFILL_CHUNK={int(chunk)}")
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
  "prefillChunk": ${PREFILL_CHUNK:-${DEFAULT_PREFILL_CHUNK:-0}},
  "reasoningEffort": "${REASONING_EFFORT:-$DEFAULT_REASONING_EFFORT}"
}
EOF
  echo "Saved ds4 defaults for ${SLOT}"
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
  "prefillChunk": ${DEFAULT_PREFILL_CHUNK:-0},
  "reasoningEffort": "${DEFAULT_REASONING_EFFORT}"
}
EOF
}

# llm3 hands a GGUF model its file path; a directory or a bare repo name under
# ~/models/hf is also accepted. The PLE sidecar is never the model, so a
# directory resolves to the one pack GGUF that is not a *-PLE-*.gguf.
resolve_model_file() {
  local raw="$1" dir=""
  if [[ -f "${raw}" ]]; then
    printf '%s\n' "${raw:A}"
    return 0
  fi
  if [[ -d "${raw}" ]]; then
    dir="${raw:A}"
  elif [[ -d "${MODELS_DIR}/hf/${raw}" ]]; then
    dir="${MODELS_DIR}/hf/${raw}"
    dir="${dir:A}"
  else
    echo "Unknown model: ${raw}" >&2
    exit 1
  fi
  local -a candidates
  candidates=(${dir}/*.gguf(N))
  local file=""
  for file in "${candidates[@]}"; do
    [[ "${file:t}" == *-PLE-*.gguf ]] && continue
    printf '%s\n' "${file}"
    return 0
  done
  echo "No ds4 pack GGUF in ${dir}" >&2
  exit 1
}

# The PLE n-gram table is MANDATORY for this architecture and is a separate
# 29.8 GiB file that ds4 keeps SSD-backed rather than resident. It ships in the
# DS4-Q4 repo and is shared by the Q4 and IQ2 packs, so look next to the model
# first and fall back to the ds4 build tree's own gguf/ directory.
resolve_ple_file() {
  if [[ -n "${PLE_ARG}" ]]; then
    [[ -f "${PLE_ARG}" ]] || { echo "PLE sidecar not found: ${PLE_ARG}" >&2; exit 1; }
    printf '%s\n' "${PLE_ARG:A}"
    return 0
  fi
  local -a found
  found=(${MODEL_FILE:h}/*-PLE-*.gguf(N) ${DS4_HOME}/gguf/*-PLE-*.gguf(N))
  if (( ${#found} )); then
    printf '%s\n' "${found[1]:A}"
    return 0
  fi
  echo "No PLE sidecar found next to ${MODEL_FILE} or in ${DS4_HOME}/gguf." >&2
  echo "Qwen3.8-Flash-Next cannot load without it; run ./download_model.sh qwen38-q2 in ${DS4_HOME}." >&2
  exit 1
}

model_metadata() {
  local file="$1" field="$2"
  /usr/bin/python3 - "${file}" "${field}" <<'PY'
import json, sys
from pathlib import Path
path, field = Path(sys.argv[1]), sys.argv[2]
directory = path.parent
meta = {}
meta_path = directory / ".llm3-hf.json"
if meta_path.exists():
    try:
        meta = json.loads(meta_path.read_text())
    except Exception:
        meta = {}
if field == "label":
    print(meta.get("label") or path.stem)
elif field == "size":
    # The pack is the base GGUF plus its PLE sidecar; report both.
    total = sum(f.stat().st_size for f in directory.glob("*.gguf"))
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
  # ds4-server matches /v1 requests against compatibility aliases, not against
  # the GGUF path, and it serves the loaded pack whatever name a client sends.
  # Report the alias so llm3's chat and the applications that sync to a slot
  # send something the server recognises verbatim.
  local runtime_model_id="qwen3.8-flash-next"
  cat >"${STATE_FILE}" <<EOF
{
  "running": true,
  "slot": "${SLOT}",
  "model": {
    "key": "${MODEL_FILE}",
    "modelId": "${runtime_model_id}",
    "runtimeId": "${runtime_model_id}",
    "label": "${MODEL_LABEL}",
    "family": "${MODEL_FAMILY}",
    "path": "${MODEL_FILE}",
    "hfUrl": "${MODEL_HF_URL}",
    "sizeLabel": "${MODEL_SIZE_LABEL}",
    "runtime": "ds4"
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
    "prefillChunk": ${PREFILL_CHUNK:-0},
    "ple": "${PLE_FILE}",
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
    --ple) PLE_ARG="$2"; shift 2 ;;
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
    --prefill-chunk) PREFILL_CHUNK="$2"; shift 2 ;;
    --reasoning-effort) REASONING_EFFORT="$2"; shift 2 ;;
    --mode) shift 2 ;;   # accepted and ignored: ds4 has no mode registry
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
      echo "Usage: $0 [--slot slotN] [--model FILE|DIR] [--ple FILE] [--mtp on|off] [--mtp-draft N] [--start|--stop|--status-json|--defaults-json|--set-defaults]"
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
  stop) stop_instance; echo "Stopped ds4 on ${SLOT}"; exit 0 ;;
esac

[[ "${ACTION}" == "start" ]] || { echo "Nothing to do; pass --start, --stop, --status-json, --defaults-json or --set-defaults" >&2; exit 1; }
[[ -x "${BIN}" ]] || { echo "ds4-server is not built at ${BIN}. Run 'make' in ${DS4_HOME}." >&2; exit 1; }
[[ -n "${MODEL_ARG}" ]] || { echo "--model is required to start" >&2; exit 1; }

MODEL_FILE="$(resolve_model_file "${MODEL_ARG}")"
PLE_FILE="$(resolve_ple_file)"
MODEL_LABEL="$(model_metadata "${MODEL_FILE}" label)"
MODEL_FAMILY="$(model_metadata "${MODEL_FILE}" family)"
MODEL_HF_URL="$(model_metadata "${MODEL_FILE}" hfUrl)"
MODEL_SIZE_LABEL="$(model_metadata "${MODEL_FILE}" size)"
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
PREFILL_CHUNK="${PREFILL_CHUNK:-$DEFAULT_PREFILL_CHUNK}"
REASONING_EFFORT="${REASONING_EFFORT:-$DEFAULT_REASONING_EFFORT}"

if [[ "${MTP}" != "on" && "${MTP}" != "off" ]]; then
  echo "--mtp takes on or off, not ${MTP}" >&2
  exit 1
fi
if [[ -n "${REASONING_EFFORT}" && "${REASONING_EFFORT}" != "off" ]]; then
  THINKING_BOOL=true
else
  THINKING_BOOL=false
fi

# Batched sessions and MTP are mutually exclusive INSIDE ds4: a batched session
# decodes with the ordinary target pass. Silently losing 25 percent of the decode
# rate to a parallel setting nobody meant to raise is exactly the kind of thing
# that costs an afternoon, so say it out loud.
if (( PARALLEL > 1 )) && [[ "${MTP}" == "on" ]]; then
  echo "Note: --parallel ${PARALLEL} enables ds4 --batched-session, which decodes without MTP." >&2
  echo "      Speculation is effectively off for every slot. Use --parallel 1 to keep it." >&2
fi

if (( ! SKIP_STOP )); then
  stop_instance
fi

if (( FOREGROUND )); then
  typeset -a extra_args
  extra_args=()
  if [[ "${MTP}" == "on" ]]; then
    extra_args+=(--mtp --mtp-draft "${MTP_DRAFT}")
  fi
  if [[ -n "${PREFILL_CHUNK}" && "${PREFILL_CHUNK}" != "0" ]]; then
    extra_args+=(--prefill-chunk "${PREFILL_CHUNK}")
  fi
  if (( PARALLEL > 1 )); then
    extra_args+=(--batched-session "${PARALLEL}")
  fi

  # --chdir is not cosmetic: ds4 compiles its Metal kernels at runtime from the
  # .metal sources in the build tree, so a server started from anywhere else
  # fails to build the library.
  exec "${BIN}" \
    --chdir "${DS4_HOME}" \
    --metal \
    --model "${MODEL_FILE}" \
    --ple "${PLE_FILE}" \
    --ctx "${CONTEXT_SIZE}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --cors \
    "${extra_args[@]}"
fi

server_pid="$(
  spawn_detached "${LOG_FILE}" "$0" --foreground --skip-stop --slot "${SLOT}" \
    --model "${MODEL_FILE}" --ple "${PLE_FILE}" \
    --host "${HOST}" --port "${PORT}" --state-dir "${STATE_DIR}" --log-file "${LOG_FILE}" --pid-file "${PID_FILE}" \
    --context-size "${CONTEXT_SIZE}" --parallel "${PARALLEL}" \
    --mtp "${MTP}" --mtp-draft "${MTP_DRAFT}" --prefill-chunk "${PREFILL_CHUNK:-0}" \
    --reasoning-effort "${REASONING_EFFORT}" \
    --temperature "${TEMPERATURE}" --top-p "${TOP_P}" --top-k "${TOP_K}" --min-p "${MIN_P}" \
    --presence-penalty "${PRESENCE_PENALTY}" --repetition-penalty "${REPETITION_PENALTY}" --start
)"

echo "${server_pid}" > "${PID_FILE}"

# Cold start here is dominated by making 41.7 GiB of pack resident: about 15 s
# from a cold page cache, well under 1 s warm. The other launchers allow
# 180-300 s and there is no reason to be tighter.
if ! wait_for_http "http://127.0.0.1:${PORT}/v1/models" 300; then
  echo "Timed out waiting for ds4 on ${HOST}:${PORT} (see ${LOG_FILE})" >&2
  exit 1
fi

write_state_file "${server_pid}"
echo "Started ds4 on ${HOST}:${PORT}"
echo "PID: ${server_pid}"
echo "Log: ${LOG_FILE}"
echo "Model: ${MODEL_FILE}"
echo "PLE: ${PLE_FILE}"
echo "Context size: ${CONTEXT_SIZE} tokens"
echo "MTP: ${MTP}$( [[ "${MTP}" == "on" ]] && echo " (draft ${MTP_DRAFT})" )"
