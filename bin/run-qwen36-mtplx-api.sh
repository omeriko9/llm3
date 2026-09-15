#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
source "$SCRIPT_DIR/lib/launcher-common.zsh"

VENV="${LLM3_VENV_ROOT:-$HOME/.venvs}/rapid-mlx"
MODELS_DIR="${LLM3_MODELS_DIR:-$HOME/models}"
SLOT="${QWEN36_MTPLX_SLOT:-slot1}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/qwen36_mtplx"
STATE_DIR="${QWEN36_MTPLX_STATE_DIR:-}"
STATE_FILE=""
DEFAULTS_FILE=""
DEFAULT_MODEL="Qwen3.6-27B-MTPLX-Optimized-Speed"
MODEL_ARG="${DEFAULT_MODEL}"
MODEL_DIR=""
MODEL_LABEL=""
MODEL_RUNTIME_ID=""

HOST="${QWEN36_MTPLX_HOST:-0.0.0.0}"
PORT="${QWEN36_MTPLX_PORT:-}"
LOG_FILE="${QWEN36_MTPLX_LOG_FILE:-}"
PID_FILE="${QWEN36_MTPLX_PID_FILE:-}"
API_KEY="${QWEN36_MTPLX_API_KEY:-${LLM3_LOCAL_API_KEY:-llm3-local-api-key}}"

DEFAULT_CONTEXT_SIZE="${QWEN36_MTPLX_CONTEXT_SIZE:-131072}"
DEFAULT_PARALLEL="${QWEN36_MTPLX_PARALLEL:-1}"
DEFAULT_TEMPERATURE="${QWEN36_MTPLX_TEMPERATURE:-0.6}"
DEFAULT_TOP_P="${QWEN36_MTPLX_TOP_P:-0.95}"
DEFAULT_TOP_K="${QWEN36_MTPLX_TOP_K:-20}"
DEFAULT_MIN_P="${QWEN36_MTPLX_MIN_P:-0.0}"
DEFAULT_PRESENCE_PENALTY="${QWEN36_MTPLX_PRESENCE_PENALTY:-0.0}"
DEFAULT_REPETITION_PENALTY="${QWEN36_MTPLX_REPETITION_PENALTY:-1.0}"

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
EFFECTIVE_CONTEXT_TOKENS=""
MTPLX_UNSAFE_FORCE_UNVERIFIED="0"

usage() {
  cat <<EOF
Usage: $0 [--slot slotN] --model NAME|PATH [--context-size SIZE] [--parallel N]
       $0 [--slot slotN] --defaults-json
       $0 [--slot slotN] --set-defaults --context-size SIZE --parallel N
       $0 [--slot slotN] --status-json
       $0 [--slot slotN] --stop

Notes:
  - MTPLX uses native MTP speculative decoding on Apple Silicon via the MTPLX
    fork of MLX (custom Metal kernels, 2.24x speedup over vanilla MTP).
  - Models are launched directly with mtplx quickstart on the selected slot port.
  - Only MLX-format models with native MTP heads are compatible.
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
    PORT="$((18536 + index - 1))"
  fi

  if [[ -z "${LOG_FILE}" ]]; then
    if [[ "${SLOT}" == "slot1" ]]; then
      LOG_FILE="$HOME/qwen36-mtplx-api.log"
    else
      LOG_FILE="${STATE_DIR}/qwen36-mtplx-api.log"
    fi
  fi

  if [[ -z "${PID_FILE}" ]]; then
    if [[ "${SLOT}" == "slot1" ]]; then
      PID_FILE="$HOME/qwen36-mtplx-api.pid"
    else
      PID_FILE="${STATE_DIR}/qwen36-mtplx-api.pid"
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
  # Try HuggingFace model ID format (user/repo or repo name)
  if [[ -d "${MODELS_DIR}/hf/${name}" ]]; then
    echo "${MODELS_DIR}/hf/${name}"
    return 0
  fi
  echo ""
}

resolve_model_info() {
  MODEL_DIR="$(resolve_model_dir "${MODEL_ARG}")"
  if [[ -z "${MODEL_DIR}" ]]; then
    echo "Error: Model '${MODEL_ARG}' not found in ${MODELS_DIR} or ${MODELS_DIR}/hf/" >&2
    exit 1
  fi

  MODEL_RUNTIME_ID="${MODEL_DIR:t}"
  MODEL_LABEL="${MODEL_RUNTIME_ID}"
}

inspect_model_compatibility_fields() {
  local model_dir="$1"
  local inspect_json=""
  inspect_json="$("${VENV}/bin/mtplx" inspect --json --no-strict-exit-code --model "${model_dir}")"
  MTPLX_INSPECT_JSON="${inspect_json}" /usr/bin/python3 - <<'PY'
import json
import os
import sys

payload = json.loads(os.environ["MTPLX_INSPECT_JSON"])
compat = payload.get("compatibility") or {}

def emit(key, value):
    text = "" if value is None else str(value).replace("\n", " ").strip()
    print(f"{key}\t{text}")

emit("can_run", "1" if compat.get("can_run") else "0")
emit("recognized", "1" if compat.get("recognized") or payload.get("architecture_recognized") else "0")
emit("support_level", compat.get("support_level") or payload.get("support_level") or "")
emit("runtime_compatibility", compat.get("runtime_compatibility") or payload.get("runtime_compatibility") or "")
emit("message", compat.get("message") or payload.get("support_notes") or "")
mtp = payload.get("mtp") or {}
missing_expected = mtp.get("missing_expected_keys")
contract_path = compat.get("runtime_contract_path") or payload.get("runtime_contract_path")
repair_gate_complete_sidecar = (
    bool(contract_path)
    and bool(mtp.get("exists"))
    and compat.get("runtime_compatibility") == "needs-grafting"
    and compat.get("support_level") == "native-backend-needs-contract-repair"
    and isinstance(missing_expected, list)
    and len(missing_expected) == 0
)
emit("repair_gate_complete_sidecar", "1" if repair_gate_complete_sidecar else "0")
PY
}

require_runnable_mtplx_model() {
  local can_run=""
  local message=""
  local repair_gate_complete_sidecar=""
  local runtime_compatibility=""
  local support_level=""

  while IFS=$'\t' read -r key value; do
    case "${key}" in
      can_run) can_run="${value}" ;;
      message) message="${value}" ;;
      repair_gate_complete_sidecar) repair_gate_complete_sidecar="${value}" ;;
      runtime_compatibility) runtime_compatibility="${value}" ;;
      support_level) support_level="${value}" ;;
    esac
  done < <(inspect_model_compatibility_fields "${MODEL_DIR}")

  if [[ "${can_run}" == "1" ]]; then
    return 0
  fi

  if [[ "${repair_gate_complete_sidecar}" == "1" && -f "${MODEL_DIR}/mtplx_runtime.json" && -f "${MODEL_DIR}/mtp.safetensors" ]]; then
    MTPLX_UNSAFE_FORCE_UNVERIFIED="1"
    return 0
  fi

  if [[ -z "${message}" ]]; then
    message="This MLX model does not include runnable MTP weights for MTPLX."
  fi
  echo "MTPLX cannot run '${MODEL_ARG}' (${runtime_compatibility:-unsupported}${support_level:+, ${support_level}}): ${message}" >&2
  exit 1
}

resolve_effective_context_tokens() {
  local model_dir="$1"
  local fallback="$2"
  /usr/bin/python3 - "${model_dir}" "${fallback}" <<'PY'
import json
import sys
from pathlib import Path

model_dir = Path(sys.argv[1])
fallback = int(sys.argv[2])

def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)

config_path = model_dir / "config.json"
try:
    config = json.loads(config_path.read_text(encoding="utf-8"))
except Exception:
    print(fallback)
    raise SystemExit(0)

for node in walk(config):
    raw = node.get("max_position_embeddings")
    try:
        value = int(raw)
    except Exception:
        continue
    if value > 0:
        print(value)
        raise SystemExit(0)

print(fallback)
PY
}

list_json() {
  /usr/bin/python3 - "${MODELS_DIR}" "${VENV}/bin/mtplx" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

models_root = Path(sys.argv[1]).expanduser()
mtplx_bin = Path(sys.argv[2]).expanduser()

def is_model_dir(path):
    if not path.is_dir():
        return False
    if not (path / "config.json").is_file():
        return False
    return any(candidate.is_file() for candidate in path.iterdir() if candidate.suffix in {".safetensors", ".bin", ".npz", ".npy"})

def prettify(name):
    return " ".join(str(name).replace("-", " ").replace("_", " ").split()).strip()

seen = set()
results = []
search_roots = [models_root / "hf", models_root]

for root in search_roots:
    if not root.is_dir():
        continue
    for entry in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if not is_model_dir(entry):
            continue
        resolved = str(entry.resolve())
        if resolved in seen:
            continue
        seen.add(resolved)
        try:
            completed = subprocess.run(
                [str(mtplx_bin), "inspect", "--json", "--no-strict-exit-code", "--model", resolved],
                check=True,
                capture_output=True,
                text=True,
            )
            payload = json.loads(completed.stdout)
        except Exception:
            continue
        compat = payload.get("compatibility") or {}
        if not compat.get("can_run"):
            continue
        results.append({
            "key": resolved,
            "label": prettify(entry.name),
            "path": resolved,
            "runtime": "mtplx",
            "launcher": "mtplx",
            "launchers": ["mlx", "rapid-mlx", "mtplx"],
            "mtplxSupport": {
                "recognized": bool(compat.get("recognized") or payload.get("architecture_recognized")),
                "canRun": True,
                "runtimeCompatibility": str(compat.get("runtime_compatibility") or payload.get("runtime_compatibility") or "").strip(),
                "supportLevel": str(compat.get("support_level") or payload.get("support_level") or "").strip(),
                "message": str(compat.get("message") or payload.get("support_notes") or "").strip(),
            },
        })

print(json.dumps(results, indent=2))
PY
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
    sleep 2
    kill -9 "${pids[@]}" 2>/dev/null || true
  fi

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
    "family": "MTPLX",
    "path": "${MODEL_DIR}",
    "runtime": "mtplx"
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

if [[ ! -x "${VENV}/bin/mtplx" ]]; then
  echo "Missing mtplx binary in ${VENV}" >&2
  exit 1
fi

resolve_model_info
CONTEXT_TOKENS="$(parse_context_size "${CONTEXT_SIZE}")"
require_runnable_mtplx_model
EFFECTIVE_CONTEXT_TOKENS="$(resolve_effective_context_tokens "${MODEL_DIR}" "${CONTEXT_TOKENS}")"
EFFECTIVE_MODEL_DIR="$(materialize_template_overlay "${MODEL_DIR}")"

if [[ "${SKIP_STOP}" != "1" ]]; then
  stop_previous_instance
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting MTPLX: ${MODEL_ARG} slot=${SLOT} port=${PORT} requested_context=${CONTEXT_TOKENS} effective_context=${EFFECTIVE_CONTEXT_TOKENS} parallel=${PARALLEL}" >> "${LOG_FILE}"
if [[ "${EFFECTIVE_MODEL_DIR}" != "${MODEL_DIR}" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] MTPLX using chat template overlay: ${EFFECTIVE_MODEL_DIR}" >> "${LOG_FILE}"
fi

mtplx_quickstart_extra_args=()
if [[ "${MTPLX_UNSAFE_FORCE_UNVERIFIED}" == "1" ]]; then
  mtplx_quickstart_extra_args+=(--unsafe-force-unverified)
fi

if [[ "${MODE}" == "daemon" ]]; then
  daemon_pid="$(
    spawn_detached "${LOG_FILE}" "${VENV}/bin/mtplx" "quickstart" "--model" "${EFFECTIVE_MODEL_DIR}" \
      "--port" "${PORT}" \
      "--host" "${HOST}" \
      "--api-key" "${API_KEY}" \
      "--yes" \
      "${mtplx_quickstart_extra_args[@]}" \
      "--no-stats-footer" \
      "--depth" "3" \
      "--profile" "sustained"
  )"
  echo "${daemon_pid}" > "${PID_FILE}"

  # Give the server time to start listening (MTPLX needs 5-10s to load model)
  sleep 5
  if ! wait_for_http "http://127.0.0.1:${PORT}/v1/models" 180 -H "X-API-Key: ${API_KEY}"; then
    echo "MTPLX failed to become ready on port ${PORT}" >&2
    if kill -0 "${daemon_pid}" 2>/dev/null; then
      kill "${daemon_pid}" 2>/dev/null || true
      sleep 2
      kill -9 "${daemon_pid}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}" "${STATE_FILE}"
    exit 1
  fi

  write_state_file "${daemon_pid}" "${EFFECTIVE_CONTEXT_TOKENS}"
  echo "MTPLX started (PID: ${daemon_pid})"
  exit 0
fi

exec "${VENV}/bin/mtplx" quickstart "${EFFECTIVE_MODEL_DIR}" \
  "--port" "${PORT}" \
  "--host" "${HOST}" \
  "--api-key" "${API_KEY}" \
  "--yes" \
  "--no-stats-footer" \
  "--depth" "3" \
  "--profile" "sustained"
