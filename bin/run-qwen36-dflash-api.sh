#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
source "$SCRIPT_DIR/lib/launcher-common.zsh"
LLM3_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DFLASH_SERVER_SCRIPT="$LLM3_ROOT/src/qwen36-dflash-api.py"

VENV="${LLM3_VENV_ROOT:-$HOME/.venvs}/rapid-mlx"
MODELS_DIR="${LLM3_MODELS_DIR:-$HOME/models}"
DFLASH_ROOT="${MODELS_DIR}/dflash"
SLOT="${QWEN36_DFLASH_SLOT:-slot1}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/qwen36_dflash"
STATE_DIR="${QWEN36_DFLASH_STATE_DIR:-}"
STATE_FILE=""
DEFAULTS_FILE=""
DEFAULT_MODEL="Qwen3.6-27B-bf16-DFlash"
MODEL_ARG="${DEFAULT_MODEL}"
HOST="${QWEN36_DFLASH_HOST:-0.0.0.0}"
PORT="${QWEN36_DFLASH_PORT:-}"
LOG_FILE="${QWEN36_DFLASH_LOG_FILE:-}"
PID_FILE="${QWEN36_DFLASH_PID_FILE:-}"
DEFAULT_CONTEXT_SIZE="${QWEN36_DFLASH_CONTEXT_SIZE:-131072}"
DEFAULT_PARALLEL="${QWEN36_DFLASH_PARALLEL:-1}"
DEFAULT_TEMPERATURE="${QWEN36_DFLASH_TEMPERATURE:-0.6}"
DEFAULT_TOP_P="${QWEN36_DFLASH_TOP_P:-0.95}"
DEFAULT_TOP_K="${QWEN36_DFLASH_TOP_K:-20}"
DEFAULT_MIN_P="${QWEN36_DFLASH_MIN_P:-0.0}"
DEFAULT_PRESENCE_PENALTY="${QWEN36_DFLASH_PRESENCE_PENALTY:-0.0}"
DEFAULT_REPETITION_PENALTY="${QWEN36_DFLASH_REPETITION_PENALTY:-1.0}"
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
MODEL_KEY=""
MODEL_LABEL=""
MODEL_DIR=""
MODEL_FAMILY=""
MODEL_HF_URL=""
MODEL_SIZE_LABEL=""
MODEL_RUNTIME="dflash"
MODEL_ID=""
TARGET_MODEL_DIR=""
DRAFT_MODEL_DIR=""

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
      LOG_FILE="$HOME/qwen36-dflash-api.log"
    else
      LOG_FILE="${STATE_DIR}/qwen36-dflash-api.log"
    fi
  fi
  if [[ -z "${PID_FILE}" ]]; then
    if [[ "${SLOT}" == "slot1" ]]; then
      PID_FILE="$HOME/qwen36-dflash-api.pid"
    else
      PID_FILE="${STATE_DIR}/qwen36-dflash-api.pid"
    fi
  fi

  STATE_FILE="${STATE_DIR}/current.json"
  DEFAULTS_FILE="${STATE_DIR}/defaults.json"
  mkdir -p "${STATE_DIR}"
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

resolve_model_info() {
  python3 - <<'PY' "${DFLASH_ROOT}" "$1"
import json
import sys
from pathlib import Path

root = Path(sys.argv[1]).expanduser()
requested = sys.argv[2]


def format_bytes(value: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    amount = float(value)
    index = 0
    while amount >= 1024 and index < len(units) - 1:
        amount /= 1024
        index += 1
    if index == 0:
        return f"{int(amount)} B"
    if amount >= 100:
        return f"{amount:.0f} {units[index]}"
    if amount >= 10:
        return f"{amount:.1f} {units[index]}"
    return f"{amount:.2f} {units[index]}"


def load_manifest(path: Path):
    manifest_path = path / "manifest.json"
    if not manifest_path.is_file():
        return None
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    target_dir = path / data.get("targetDir", "target")
    draft_dir = path / data.get("draftDir", "draft")
    if not target_dir.is_dir() or not draft_dir.is_dir():
        return None
    size_bytes = sum(
        file_path.stat().st_size
        for file_path in path.rglob("*")
        if file_path.is_file()
    )
    target_repo = str(data.get("targetRepo", "")).strip()
    hf_url = f"https://huggingface.co/{target_repo}" if target_repo else ""
    return {
        "key": str(data.get("key") or path.name),
        "label": str(data.get("label") or path.name),
        "path": str(path),
        "hfUrl": hf_url,
        "sizeBytes": size_bytes,
        "sizeLabel": format_bytes(size_bytes),
        "family": str(data.get("family") or "DFlash"),
        "runtime": "dflash",
        "modelId": str(data.get("modelId") or data.get("key") or path.name),
        "targetModelDir": str(target_dir),
        "draftModelDir": str(draft_dir),
    }


if Path(requested).expanduser().is_dir():
    info = load_manifest(Path(requested).expanduser())
    if info is None:
        raise SystemExit(1)
else:
    info = None
    for manifest in sorted(root.glob("*/manifest.json")):
        candidate = load_manifest(manifest.parent)
        if candidate and candidate["key"] == requested:
            info = candidate
            break
    if info is None:
        raise SystemExit(1)

print("\t".join(
    [
        info["key"],
        info["label"],
        info["path"],
        info["hfUrl"],
        info["sizeLabel"],
        info["family"],
        info["runtime"],
        info["modelId"],
        info["targetModelDir"],
        info["draftModelDir"],
    ]
))
PY
}

model_info() {
  local row=""
  row="$(resolve_model_info "$1")" || {
    echo "Unknown DFlash model: $1" >&2
    exit 1
  }
  IFS=$'\t' read -r MODEL_KEY MODEL_LABEL MODEL_DIR MODEL_HF_URL MODEL_SIZE_LABEL MODEL_FAMILY MODEL_RUNTIME MODEL_ID TARGET_MODEL_DIR DRAFT_MODEL_DIR <<<"${row}"
}

list_models_json() {
  python3 - <<'PY' "${DFLASH_ROOT}"
import json
import sys
from pathlib import Path

root = Path(sys.argv[1]).expanduser()


def format_bytes(value: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    amount = float(value)
    index = 0
    while amount >= 1024 and index < len(units) - 1:
        amount /= 1024
        index += 1
    if index == 0:
        return f"{int(amount)} B"
    if amount >= 100:
        return f"{amount:.0f} {units[index]}"
    if amount >= 10:
        return f"{amount:.1f} {units[index]}"
    return f"{amount:.2f} {units[index]}"


rows = []
for manifest in sorted(root.glob("*/manifest.json")):
    try:
        bundle_dir = manifest.parent
        data = json.loads(manifest.read_text(encoding="utf-8"))
        target_dir = bundle_dir / data.get("targetDir", "target")
        draft_dir = bundle_dir / data.get("draftDir", "draft")
        if not target_dir.is_dir() or not draft_dir.is_dir():
            continue
        size_bytes = sum(
            file_path.stat().st_size
            for file_path in bundle_dir.rglob("*")
            if file_path.is_file()
        )
        target_repo = str(data.get("targetRepo", "")).strip()
        hf_url = f"https://huggingface.co/{target_repo}" if target_repo else ""
        rows.append(
            {
                "key": str(data.get("key") or bundle_dir.name),
                "label": str(data.get("label") or bundle_dir.name),
                "path": str(bundle_dir),
                "hfUrl": hf_url,
                "sizeBytes": size_bytes,
                "sizeLabel": format_bytes(size_bytes),
                "family": str(data.get("family") or "DFlash"),
                "runtime": "dflash",
                "modelId": str(data.get("modelId") or data.get("key") or bundle_dir.name),
                "targetModelDir": str(target_dir),
                "draftModelDir": str(draft_dir),
            }
        )
    except Exception:
        continue

print(json.dumps(rows, indent=2))
PY
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
    --skip-stop)
      SKIP_STOP="1"
      shift
      ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--model KEY|BUNDLE_DIR] [--context-size SIZE] [--parallel N] [--foreground]
       $0 --list-json
       $0 --defaults-json
       $0 --status-json
       $0 --set-defaults --context-size SIZE --parallel N
       $0 --stop
EOF
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

if ! [[ "${PARALLEL}" =~ ^[1-9][0-9]*$ ]]; then
  echo "--parallel must be a positive integer" >&2
  exit 1
fi

status_json() {
  python3 - <<'PY' "${STATE_FILE}" "${PID_FILE}" "${LOG_FILE}"
import json
import os
import sys
from pathlib import Path

state_path = Path(sys.argv[1])
pid_path = Path(sys.argv[2])
log_file = sys.argv[3]


def pid_alive(value: int) -> bool:
    try:
        os.kill(value, 0)
    except Exception:
        return False
    return True


def read_last_crash(log_path: str):
    path = Path(log_path)
    if not path.is_file():
        return None

    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None

    if not text.strip():
        return None

    tail = text[-65536:]
    lower = tail.lower()
    if "iogpucommandbuffercallbackerroroutofmemory" in lower or "insufficient memory" in lower:
        return {
            "reason": "Metal GPU out of memory",
            "detail": "This DFlash target exceeded available Apple GPU memory. Stop another large model or use the MXFP4 DFlash bundle.",
        }

    lines = [line.strip() for line in tail.splitlines() if line.strip()]
    if not lines:
        return None

    for line in reversed(lines):
        lowered = line.lower()
        if "traceback" in lowered:
            continue
        if "error" in lowered or "exception" in lowered or "failed" in lowered:
            return {"reason": line}
    return None


if not state_path.exists():
    print(
        json.dumps(
            {
                "running": False,
                "logs": {"server": log_file, "traffic": "", "proxy": log_file},
                "lastCrash": read_last_crash(log_file),
            },
            indent=2,
        )
    )
    raise SystemExit(0)

data = json.loads(state_path.read_text())
pid = data.get("pids", {}).get("proxy")
running = bool(pid and pid_alive(pid))
data["running"] = running

if not running:
    for path in (pid_path, state_path):
        try:
            Path(path).unlink()
        except FileNotFoundError:
            pass
    print(
        json.dumps(
            {
                "running": False,
                "logs": {"server": log_file, "traffic": "", "proxy": log_file},
                "lastCrash": read_last_crash(log_file),
            },
            indent=2,
        )
    )
else:
    print(json.dumps(data, indent=2))
PY
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
    sleep 2
    kill -9 "${pids[@]}" 2>/dev/null || true
  fi

  rm -f "${PID_FILE}" "${STATE_FILE}"
}

write_state_file() {
  local proxy_pid="$1"
  cat >"${STATE_FILE}" <<EOF
{
  "running": true,
  "slot": "${SLOT}",
  "model": {
    "key": "${MODEL_KEY}",
    "modelId": "${MODEL_ID}",
    "runtimeId": "${MODEL_ID}",
    "label": "${MODEL_LABEL}",
    "family": "${MODEL_FAMILY}",
    "path": "${MODEL_DIR}",
    "hfUrl": "${MODEL_HF_URL}",
    "sizeLabel": "${MODEL_SIZE_LABEL}",
    "runtime": "${MODEL_RUNTIME}"
  },
  "params": {
    "ctxSize": ${MAX_CONTEXT_SIZE},
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
    "backendHost": "${HOST}",
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

# Only a start needs the runtime; status, defaults, and stop must work on a
# machine (or in a test) that has no venv.
if [[ "${RUN_MODE}" == "start" ]]; then
  if [[ ! -x "${VENV}/bin/python" ]]; then
    echo "Missing Python runtime in ${VENV}" >&2
    exit 1
  fi
  if [[ ! -f "$DFLASH_SERVER_SCRIPT" ]]; then
    echo "Missing server script $DFLASH_SERVER_SCRIPT" >&2
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

MAX_CONTEXT_SIZE="$(parse_context_size "${CONTEXT_SIZE}")"
model_info "${MODEL_ARG}"

if [[ "${SKIP_STOP}" != "1" ]]; then
  stop_previous_instance
fi

if [[ "${MODE}" == "daemon" ]]; then
  daemon_pid="$(
    spawn_detached "${LOG_FILE}" "$0" --foreground --skip-stop --slot "${SLOT}" --host "${HOST}" --port "${PORT}" --state-dir "${STATE_DIR}" --log-file "${LOG_FILE}" --pid-file "${PID_FILE}" --model "${MODEL_ARG}" --context-size "${CONTEXT_SIZE}" --parallel "${PARALLEL}"
  )"
  echo "${daemon_pid}" > "${PID_FILE}"

  if ! wait_for_http "http://127.0.0.1:${PORT}/v1/models" 180; then
    echo "Timed out waiting for Qwen3.6 DFlash API on ${HOST}:${PORT}" >&2
    exit 1
  fi

  write_state_file "${daemon_pid}"
  echo "Started Qwen3.6 DFlash API on ${HOST}:${PORT}"
  echo "PID: $(cat "${PID_FILE}")"
  echo "Log: ${LOG_FILE}"
  echo "Bundle: ${MODEL_DIR}"
  echo "Context size: ${MAX_CONTEXT_SIZE} tokens"
  echo "Parallel: ${PARALLEL}"
  exit 0
fi

exec "${VENV}/bin/python" "$DFLASH_SERVER_SCRIPT" \
  --model-id "${MODEL_ID}" \
  --target-model "${TARGET_MODEL_DIR}" \
  --draft-model "${DRAFT_MODEL_DIR}" \
  --host "${HOST}" \
  --port "${PORT}" \
  --context-size "${MAX_CONTEXT_SIZE}" \
  --parallel "${PARALLEL}" \
  --verify-mode parallel-replay \
  --verify-chunk-size 4
