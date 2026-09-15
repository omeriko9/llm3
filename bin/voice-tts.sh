#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM3_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"

SLOT="${VOICE_TTS_SLOT:-slot1}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/llm3/voice"
STATE_DIR=""
STATE_FILE=""
DEFAULTS_FILE=""
PID_FILE=""
SERVER_PID_FILE=""
SERVER_LOG_FILE=""
TRAFFIC_LOG_FILE=""
SERVER_EXIT_MARKER_FILE=""

HOST="${VOICE_TTS_HOST:-0.0.0.0}"
PORT="${VOICE_TTS_PORT:-}"
BACKEND_HOST="${VOICE_TTS_BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${VOICE_TTS_BACKEND_PORT:-}"
PUBLIC_PORT_OVERRIDE="${VOICE_TTS_PORT:-}"
BACKEND_PORT_OVERRIDE="${VOICE_TTS_BACKEND_PORT:-}"
EXTRA_TTS_PYTHON="${VOICE_TTS_EXTRA_PYTHON:-$HOME/venvs/voice-tts-extra/bin/python}"
# Dedicated Python 3.12 venv for Chatterbox Multilingual (chatterbox-tts 0.1.7 / v3).
# Falls back to the shared voice-models venv (also serves xtts/f5/STT) if absent.
CHATTERBOX_PYTHON="${VOICE_TTS_CHATTERBOX_PYTHON:-$HOME/venvs/voice-models-chatterbox/bin/python}"
if [ ! -x "$CHATTERBOX_PYTHON" ]; then
  CHATTERBOX_PYTHON="$HOME/venvs/voice-models/bin/python"
fi
PHONIKUD_CHATTERBOX_PYTHON="${VOICE_TTS_PHONIKUD_CHATTERBOX_PYTHON:-$HOME/venvs/phonikud-chatterbox/bin/python}"
PHONIKUD_UPSTREAM_CHATTERBOX_PYTHON="${VOICE_TTS_PHONIKUD_UPSTREAM_CHATTERBOX_PYTHON:-$HOME/venvs/phonikud-upstream/bin/python}"
LLM3_ROOT="${VOICE_TTS_LLM3_ROOT:-$LLM3_ROOT_DEFAULT}"

usage() {
  cat <<'EOF'
Usage:
  ./bin/voice-tts.sh [--slot slotN] <model> [voice_name]
  ./bin/voice-tts.sh [--slot slotN] <model> --start
  ./bin/voice-tts.sh [--slot slotN] <model> --set-defaults [--voice NAME] [--format FMT] [--sample-rate N] [--tts-chunk-size N] [--exaggeration N] [--cfg-weight N] [--temperature N] [--repetition-penalty N] [--min-p N] [--top-p N] [--seed N]
  ./bin/voice-tts.sh [--slot slotN] --start [--voice NAME] [--format FMT] [--sample-rate N] [--tts-chunk-size N] [--exaggeration N] [--cfg-weight N] [--temperature N] [--repetition-penalty N] [--min-p N] [--top-p N] [--seed N]
  ./bin/voice-tts.sh [--slot slotN] --defaults-json
  ./bin/voice-tts.sh [--slot slotN] --status-json
  ./bin/voice-tts.sh [--slot slotN] --stop

Models:
  f5-tts-hebrew   F5-TTS Hebrew v2 (fine-tuned Hebrew voice, local)
  chatterbox-multilingual
                  Chatterbox Multilingual TTS (23 langs, Hebrew/English, local)
  chatterbox      Alias for chatterbox-multilingual
  omnivoice       OmniVoice (multilingual zero-shot / voice design)
  kokoro          Kokoro 82M (fast voice-pack TTS)
  phonikud-upstream
                  Upstream Chatterbox Multilingual + Phonikud Hebrew TTS
  vibevoice       Microsoft VibeVoice-1.5B (long-form, multi-speaker, diffusion TTS)

Environment overrides:
  VOICE_TTS_PORT            public API port (default: slot-based)
  VOICE_TTS_BACKEND_PORT    backend port (default: slot-based)
  VOICE_TTS_VOICE           default voice name
  VOICE_TTS_FORMAT          default audio format (pcm16/flac/wav/mp3)
  VOICE_TTS_SAMPLE_RATE     default sample rate (default: 24000)
  VOICE_TTS_CHUNK_SIZE      default podcast TTS chunk size (default: 500)
  VOICE_TTS_GPU_LAYERS      GPU layers (default: 999)
  VOICE_TTS_MODEL_DIR       custom model directory override
  CHATTERBOX_DEFAULT_VOICE  default named voice preset for chatterbox-multilingual
  CHATTERBOX_HEBREW_REF_AUDIO
                            Hebrew prompt clip for chatterbox-multilingual (default: Carmit)
  CHATTERBOX_ENGLISH_REF_AUDIO
                            English prompt clip for chatterbox-multilingual
  CHATTERBOX_ARABIC_REF_AUDIO
                            Primary Arabic prompt clip for chatterbox-multilingual
  CHATTERBOX_ARABIC_REF_AUDIO_2
                            Secondary Arabic prompt clip for chatterbox-multilingual
  VOICE_TTS_CHATTERBOX_EXAGGERATION
                            default Chatterbox exaggeration
  VOICE_TTS_CHATTERBOX_CFG_WEIGHT
                            default Chatterbox cfg weight
  VOICE_TTS_CHATTERBOX_TEMPERATURE
                            default Chatterbox temperature
  VOICE_TTS_CHATTERBOX_REPETITION_PENALTY
                            default Chatterbox repetition penalty
  VOICE_TTS_CHATTERBOX_MIN_P
                            default Chatterbox min-p
  VOICE_TTS_CHATTERBOX_TOP_P
                            default Chatterbox top-p
  VOICE_TTS_PHONIKUD_EXAGGERATION
                            default Phonikud-Chatterbox exaggeration
  VOICE_TTS_PHONIKUD_CFG_WEIGHT
                            default Phonikud-Chatterbox cfg weight
  VOICE_TTS_PHONIKUD_TEMPERATURE
                            default Phonikud-Chatterbox temperature
  VOICE_TTS_PHONIKUD_REPETITION_PENALTY
                            default Phonikud-Chatterbox repetition penalty
  VOICE_TTS_PHONIKUD_MIN_P
                            default Phonikud-Chatterbox min-p
  VOICE_TTS_PHONIKUD_TOP_P
                            default Phonikud-Chatterbox top-p
EOF
  exit 1
}

slot_index() {
  case "$1" in
    slot[1-9]|slot[1-9][0-9]*)
      printf '%s\n' "${1#slot}"
      ;;
    voice-tts-1|voice-tts-2|voice-stt-1|voice-stt-2)
      case "$1" in
        voice-tts-1) printf '1\n' ;;
        voice-tts-2) printf '2\n' ;;
        voice-stt-1) printf '1\n' ;;
        voice-stt-2) printf '2\n' ;;
      esac
      ;;
    *)
      echo "Invalid slot: $1. Use slot1, slot2, voice-tts-1, voice-tts-2, voice-stt-1, voice-stt-2" >&2
      exit 1
      ;;
  esac
}

configure_slot() {
  local index=""
  index="$(slot_index "$SLOT")"
  local legacy_state_dir=""

  # Voice slots have explicit state dirs
  case "$SLOT" in
    slot1|voice-tts-1)
      STATE_DIR="$STATE_ROOT/voice-tts-1"
      legacy_state_dir="$STATE_ROOT"
      ;;
    slot2|voice-tts-2)
      STATE_DIR="$STATE_ROOT/voice-tts-2"
      legacy_state_dir="$STATE_ROOT/slot2"
      ;;
    *)
      if [ -z "$STATE_DIR" ]; then
        STATE_DIR="$STATE_ROOT/$SLOT"
      fi
      ;;
  esac

  if [ -n "$PUBLIC_PORT_OVERRIDE" ]; then
    PORT="$PUBLIC_PORT_OVERRIDE"
  else
    PORT=$((8040 + index - 1))
  fi
  if [ -n "$BACKEND_PORT_OVERRIDE" ]; then
    BACKEND_PORT="$BACKEND_PORT_OVERRIDE"
  else
    BACKEND_PORT=$((18040 + index - 1))
  fi

  STATE_FILE="$STATE_DIR/current.json"
  DEFAULTS_FILE="$STATE_DIR/defaults.json"
  PID_FILE="$STATE_DIR/tts-proxy.pid"
  SERVER_PID_FILE="$STATE_DIR/tts-server.pid"
  SERVER_LOG_FILE="$STATE_DIR/server.log"
  TRAFFIC_LOG_FILE="$STATE_DIR/traffic.log"
  SERVER_EXIT_MARKER_FILE="$STATE_DIR/server_exit.json"

  mkdir -p "$STATE_DIR"

  if [ -n "$legacy_state_dir" ] && [ "$legacy_state_dir" != "$STATE_DIR" ] && [ -d "$legacy_state_dir" ]; then
    for legacy_name in \
      current.json \
      defaults.json \
      tts-proxy.pid \
      tts-server.pid \
      server.log \
      traffic.log \
      tts_proxy.py
    do
      if [ -e "$legacy_state_dir/$legacy_name" ] && [ ! -e "$STATE_DIR/$legacy_name" ]; then
        mv "$legacy_state_dir/$legacy_name" "$STATE_DIR/$legacy_name"
      fi
    done
  fi
}

resolve_model_path() {
  local candidate=""
  for candidate in "$@"; do
    if [ -e "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf '%s\n' "$1"
}

load_defaults() {
  [ -f "$DEFAULTS_FILE" ] || return 0

  while IFS=$'\t' read -r key value; do
    case "$key" in
      model) DEFAULT_MODEL="$value" ;;
      voice) DEFAULT_VOICE="$value" ;;
      format) DEFAULT_FORMAT="$value" ;;
      sampleRate) DEFAULT_SAMPLE_RATE="$value" ;;
      ttsChunkSize) DEFAULT_TTS_CHUNK_SIZE="$value" ;;
      exaggeration) DEFAULT_EXAGGERATION="$value" ;;
      cfgWeight) DEFAULT_CFG_WEIGHT="$value" ;;
      temperature) DEFAULT_TEMPERATURE="$value" ;;
      repetitionPenalty) DEFAULT_REPETITION_PENALTY="$value" ;;
      minP) DEFAULT_MIN_P="$value" ;;
      topP) DEFAULT_TOP_P="$value" ;;
      seed) DEFAULT_SEED="$value" ;;
    esac
  done < <(
    python3 - <<'PY' "$DEFAULTS_FILE"
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

print(f"model\t{data.get('model', '')}")
print(f"voice\t{data.get('voice', '')}")
print(f"format\t{data.get('format', '')}")
print(f"sampleRate\t{data.get('sampleRate', '')}")
print(f"ttsChunkSize\t{data.get('ttsChunkSize', '')}")
print(f"exaggeration\t{data.get('exaggeration', '')}")
print(f"cfgWeight\t{data.get('cfgWeight', '')}")
print(f"temperature\t{data.get('temperature', '')}")
print(f"repetitionPenalty\t{data.get('repetitionPenalty', '')}")
print(f"minP\t{data.get('minP', '')}")
print(f"topP\t{data.get('topP', '')}")
print(f"seed\t{data.get('seed', '')}")
PY
  )
}

defaults_json() {
  cat <<EOF
{
  "model": "${DEFAULT_MODEL:-}",
  "voice": "${DEFAULT_VOICE:-}",
  "format": "${DEFAULT_FORMAT:-pcm16}",
  "sampleRate": ${DEFAULT_SAMPLE_RATE:-24000},
  "ttsChunkSize": ${DEFAULT_TTS_CHUNK_SIZE:-500},
  "exaggeration": ${DEFAULT_EXAGGERATION:-0.5},
  "cfgWeight": ${DEFAULT_CFG_WEIGHT:-0.5},
  "temperature": ${DEFAULT_TEMPERATURE:-0.8},
  "repetitionPenalty": ${DEFAULT_REPETITION_PENALTY:-2.0},
  "minP": ${DEFAULT_MIN_P:-0.05},
  "topP": ${DEFAULT_TOP_P:-1.0},
  "seed": ${DEFAULT_SEED:-1234}
}
EOF
}

save_defaults() {
  cat >"$DEFAULTS_FILE" <<EOF
{
  "model": "$MODEL_KEY",
  "voice": "$VOICE_NAME",
  "format": "$AUDIO_FORMAT",
  "sampleRate": $SAMPLE_RATE,
  "ttsChunkSize": $TTS_CHUNK_SIZE,
  "exaggeration": $EXAGGERATION,
  "cfgWeight": $CFG_WEIGHT,
  "temperature": $TEMPERATURE,
  "repetitionPenalty": $REPETITION_PENALTY,
  "minP": $MIN_P,
  "topP": $TOP_P,
  "seed": $SEED
}
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

kill_pid() {
  local pid="$1"
  local i

  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done

  kill -9 "$pid" 2>/dev/null || true
}

listener_pid_for_port() {
  # netstat is instant on this machine; lsof can stall for minutes.
  local port="$1"
  # No early "exit" in awk: it would SIGPIPE netstat and, with pipefail,
  # kill the whole launcher with status 141.
  netstat -anv -p tcp 2>/dev/null | awk -v port="$port" '
    !found && $6 == "LISTEN" && ($4 ~ ("[.:]" port "$")) { n = split($11, parts, ":"); print parts[n]; found = 1 }
  '
}

port_is_free() {
  local port="$1"
  python3 - "$port" <<'PY'
import socket, sys
port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(0.5)
try:
    s.connect(("127.0.0.1", port))
except OSError:
    sys.exit(0)
finally:
    s.close()
sys.exit(1)
PY
}

wait_port_free() {
  local port="$1"
  local timeout="${2:-30}"
  local i
  for i in $(seq 1 "$timeout"); do
    if port_is_free "$port"; then
      return 0
    fi
    sleep 1
  done
  echo "Port $port is still in use after ${timeout}s" >&2
  return 1
}

kill_known_listener() {
  local port="$1"
  local pid=""
  local port_cmd=""

  pid="$(listener_pid_for_port "$port")"
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    return 0
  fi

  port_cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  case "$port_cmd" in
    *BaseHTTPRequestHandler*|*ThreadingHTTPServer*|*uvicorn*|*fastapi*|*xtts*|*phonikud*|*chatterbox*|*f5_hebrew_server*|*kokoro_api_server.py*|*omnivoice_api_server.py*|*vibevoice_api_server.py*|*tts_proxy.py*)
      kill_pid "$pid"
      ;;
    '')
      ;;
    *)
      echo "Port $port is already in use by PID $pid: $port_cmd" >&2
      exit 1
      ;;
  esac
}

stop_previous_server() {
  local old_pid=""

  if [ -f "$PID_FILE" ]; then
    old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "Stopping previous TTS proxy PID $old_pid..."
      kill_pid "$old_pid"
    fi
  fi

  if [ -f "$SERVER_PID_FILE" ]; then
    old_pid="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "Stopping previous TTS server PID $old_pid..."
      kill_pid "$old_pid"
    fi
  fi

  kill_known_listener "$PORT"
  kill_known_listener "$BACKEND_PORT"
  rm -f "$PID_FILE" "$SERVER_PID_FILE" "$STATE_FILE"
  # A new server that binds while the old one is still closing dies with
  # "Address already in use" while the old one keeps answering /health.
  wait_port_free "$PORT" || exit 1
  wait_port_free "$BACKEND_PORT" || exit 1
}

write_state_file() {
  local proxy_pid="$1"
  local server_pid="$2"
  local aliases_json=""

  aliases_json="$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1].split(",")))' "$MODEL_ALIAS")"

  cat >"$STATE_FILE" <<EOF
{
  "running": true,
  "slot": "$SLOT",
  "type": "tts",
  "model": {
    "key": "$MODEL_KEY",
    "label": "$MODEL_LABEL",
    "path": "$MODEL_PATH",
    "aliases": $aliases_json
  },
  "params": {
    "voice": "$VOICE_NAME",
    "voiceName": "$VOICE_NAME",
    "format": "$AUDIO_FORMAT",
    "audioFormat": "$AUDIO_FORMAT",
    "sampleRate": $SAMPLE_RATE,
    "ttsChunkSize": $TTS_CHUNK_SIZE,
    "exaggeration": $EXAGGERATION,
    "cfgWeight": $CFG_WEIGHT,
    "temperature": $TEMPERATURE,
    "repetitionPenalty": $REPETITION_PENALTY,
    "minP": $MIN_P,
    "topP": $TOP_P,
    "seed": $SEED
  },
  "network": {
    "publicHost": "$HOST",
    "publicPort": $PORT,
    "backendHost": "$BACKEND_HOST",
    "backendPort": $BACKEND_PORT
  },
  "logs": {
    "server": "$SERVER_LOG_FILE",
    "traffic": "$TRAFFIC_LOG_FILE",
    "serverExitMarker": "$SERVER_EXIT_MARKER_FILE"
  },
  "pids": {
    "proxy": $proxy_pid,
    "server": $server_pid
  },
  "startedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
}

status_json() {
  python3 - <<'PY' "$STATE_FILE" "$PID_FILE" "$SERVER_PID_FILE"
import json
import os
import sys
from pathlib import Path

state_path = Path(sys.argv[1])
proxy_pid_path = Path(sys.argv[2])
server_pid_path = Path(sys.argv[3])

def pid_alive(value):
    try:
        os.kill(value, 0)
    except Exception:
        return False
    return True

if not state_path.exists():
    print(json.dumps({"running": False}, indent=2))
    raise SystemExit(0)

data = json.loads(state_path.read_text())
proxy_pid = data.get("pids", {}).get("proxy")
server_pid = data.get("pids", {}).get("server")
running = bool(proxy_pid and server_pid and pid_alive(proxy_pid) and pid_alive(server_pid))
data["running"] = running

if not running:
    for path in (proxy_pid_path, server_pid_path, state_path):
        if path.exists():
            path.unlink(missing_ok=True)
    print(json.dumps({"running": False}, indent=2))
    raise SystemExit(0)

print(json.dumps(data, indent=2))
PY
}

model_info() {
  local key="$1"
  local model_dir="${VOICE_TTS_MODEL_DIR:-}"

  MODEL_KEY="$key"
  MODEL_ALIAS=""
  MODEL_PATH=""

  case "$key" in
    xtts-v2|xtts)
      MODEL_LABEL="XTTS v2"
      MODEL_PATH="${model_dir:-$(resolve_model_path "$HOME/models/voice/voice-tts/xtts-v2" "$HOME/models/voice-tts/xtts-v2")}"
      MODEL_ALIAS="xtts-v2,coqui-xtts-v2,xtts"
      ;;
    chatterbox|chatterbox-resemble|chatterbox-multilingual)
      MODEL_LABEL="Chatterbox Multilingual TTS"
      MODEL_PATH="${model_dir:-$(resolve_model_path "$HOME/models/voice/voice-tts/chatterbox-multilingual" "$HOME/models/voice/voice-tts/chatterbox-resemble")}"
      MODEL_ALIAS="chatterbox-tts,chatterbox,chatterbox-multilingual,multilingual-tts"
      ;;
    phonikud-upstream)
      MODEL_LABEL="Phonikud Upstream Chatterbox"
      MODEL_PATH="${model_dir:-$(resolve_model_path "$HOME/models/voice/voice-tts/phonikud-upstream")}"
      MODEL_ALIAS="phonikud-upstream,phonikud-upstream-chatterbox,chatterbox-hebrew-upstream"
      ;;
    f5-tts-hebrew)
      MODEL_LABEL="F5-TTS Hebrew v2"
      MODEL_PATH="${model_dir:-$(resolve_model_path "$HOME/models/voice/voice-tts/f5-tts-hebrew")}"
      MODEL_ALIAS="f5-tts-hebrew,f5tts-heb,hebrew-f5"
      ;;
    omnivoice)
      MODEL_LABEL="OmniVoice"
      MODEL_PATH="${model_dir:-$(resolve_model_path "$HOME/models/voice/voice-tts/omnivoice" "$HOME/models/voice-tts/omnivoice")}"
      MODEL_ALIAS="omnivoice,omni-voice,k2-omnivoice"
      ;;
    kokoro)
      MODEL_LABEL="Kokoro 82M"
      MODEL_PATH="${model_dir:-$(resolve_model_path "$HOME/models/voice/voice-tts/kokoro" "$HOME/models/voice-tts/kokoro")}"
      MODEL_ALIAS="kokoro,kokoro-82m,hexgrad-kokoro"
      ;;
    vibevoice|vibevoice-1.5b)
      MODEL_LABEL="VibeVoice-1.5B"
      MODEL_PATH="${model_dir:-$(resolve_model_path "$HOME/models/voice/voice-tts/vibevoice-1.5b" "$HOME/.cache/huggingface/hub/models--microsoft--VibeVoice-1.5B/snapshots/c00898d257e6b46004e3e2866a47534085fb685a")}"
      MODEL_ALIAS="vibevoice,vibevoice-1.5b,microsoft-vibevoice"
      ;;
    *)
      # Check if it's a directory path
      if [ -d "$key" ]; then
        MODEL_LABEL="$(basename "$key")"
        MODEL_PATH="$key"
        MODEL_ALIAS="$(basename "$key")"
      elif [ -f "$key" ]; then
        MODEL_LABEL="$(basename "$key")"
        MODEL_PATH="$key"
        MODEL_ALIAS="$(basename "$key")"
      else
        echo "Unknown model: $key" >&2
        usage
      fi
      ;;
  esac
}

format_bytes() {
  python3 - <<'PY' "$1"
import sys

value = int(float(sys.argv[1] or 0))
units = ["B", "KB", "MB", "GB", "TB"]
amount = float(value)
index = 0
while amount >= 1024 and index < len(units) - 1:
    amount /= 1024
    index += 1
print(f"{amount:.2f} {units[index]}" if index else f"{int(amount)} B")
PY
}

is_positive_int() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    0) return 1 ;;
    *) return 0 ;;
  esac
}

clear_runtime_files() {
  # Keep the previous run's log so crash evidence (SIGABRT from Metal/MPS
  # errors leaves no Python traceback anywhere else) survives a restart.
  if [ -s "$SERVER_LOG_FILE" ]; then
    mv -f "$SERVER_LOG_FILE" "${SERVER_LOG_FILE%.log}.prev.log" 2>/dev/null || :
  fi
  :>"$SERVER_LOG_FILE"
  :>"$TRAFFIC_LOG_FILE"
}

apply_tuning_defaults_for_model() {
  local default_exaggeration="${DEFAULT_EXAGGERATION:-}"
  local default_cfg_weight="${DEFAULT_CFG_WEIGHT:-}"
  local default_temperature="${DEFAULT_TEMPERATURE:-}"
  local default_repetition_penalty="${DEFAULT_REPETITION_PENALTY:-}"
  local default_min_p="${DEFAULT_MIN_P:-}"
  local default_top_p="${DEFAULT_TOP_P:-}"
  [ -n "$TTS_CHUNK_SIZE" ] || TTS_CHUNK_SIZE="${DEFAULT_TTS_CHUNK_SIZE:-${VOICE_TTS_CHUNK_SIZE:-500}}"
  [ -n "$SEED" ] || SEED="${DEFAULT_SEED:-1234}"

  case "$MODEL_KEY" in
    chatterbox|chatterbox-resemble|chatterbox-multilingual)
      [ -n "$EXAGGERATION" ] || EXAGGERATION="${default_exaggeration:-${VOICE_TTS_CHATTERBOX_EXAGGERATION:-0.5}}"
      [ -n "$CFG_WEIGHT" ] || CFG_WEIGHT="${default_cfg_weight:-${VOICE_TTS_CHATTERBOX_CFG_WEIGHT:-0.5}}"
      [ -n "$TEMPERATURE" ] || TEMPERATURE="${default_temperature:-${VOICE_TTS_CHATTERBOX_TEMPERATURE:-0.8}}"
      [ -n "$REPETITION_PENALTY" ] || REPETITION_PENALTY="${default_repetition_penalty:-${VOICE_TTS_CHATTERBOX_REPETITION_PENALTY:-2.0}}"
      [ -n "$MIN_P" ] || MIN_P="${default_min_p:-${VOICE_TTS_CHATTERBOX_MIN_P:-0.05}}"
      [ -n "$TOP_P" ] || TOP_P="${default_top_p:-${VOICE_TTS_CHATTERBOX_TOP_P:-1.0}}"
      ;;
    phonikud-chatterbox|phonikud-upstream)
      [ -n "$EXAGGERATION" ] || EXAGGERATION="${default_exaggeration:-${VOICE_TTS_PHONIKUD_EXAGGERATION:-0.5}}"
      [ -n "$CFG_WEIGHT" ] || CFG_WEIGHT="${default_cfg_weight:-${VOICE_TTS_PHONIKUD_CFG_WEIGHT:-0.5}}"
      [ -n "$TEMPERATURE" ] || TEMPERATURE="${default_temperature:-${VOICE_TTS_PHONIKUD_TEMPERATURE:-0.8}}"
      [ -n "$REPETITION_PENALTY" ] || REPETITION_PENALTY="${default_repetition_penalty:-${VOICE_TTS_PHONIKUD_REPETITION_PENALTY:-2.0}}"
      [ -n "$MIN_P" ] || MIN_P="${default_min_p:-${VOICE_TTS_PHONIKUD_MIN_P:-0.05}}"
      [ -n "$TOP_P" ] || TOP_P="${default_top_p:-${VOICE_TTS_PHONIKUD_TOP_P:-1.0}}"
      ;;
    *)
      [ -n "$EXAGGERATION" ] || EXAGGERATION="${default_exaggeration:-0.5}"
      [ -n "$CFG_WEIGHT" ] || CFG_WEIGHT="${default_cfg_weight:-0.5}"
      [ -n "$TEMPERATURE" ] || TEMPERATURE="${default_temperature:-0.8}"
      [ -n "$REPETITION_PENALTY" ] || REPETITION_PENALTY="${default_repetition_penalty:-2.0}"
      [ -n "$MIN_P" ] || MIN_P="${default_min_p:-0.05}"
      [ -n "$TOP_P" ] || TOP_P="${default_top_p:-1.0}"
      ;;
  esac
}

# ========== Argument Parsing ==========

MODE=""
MODEL_KEY=""
VOICE_NAME="${VOICE_TTS_VOICE:-}"
AUDIO_FORMAT="${VOICE_TTS_FORMAT:-pcm16}"
SAMPLE_RATE="${VOICE_TTS_SAMPLE_RATE:-24000}"
TTS_CHUNK_SIZE="${VOICE_TTS_CHUNK_SIZE:-}"
EXAGGERATION="${VOICE_TTS_EXAGGERATION:-}"
CFG_WEIGHT="${VOICE_TTS_CFG_WEIGHT:-}"
TEMPERATURE="${VOICE_TTS_TEMPERATURE:-}"
REPETITION_PENALTY="${VOICE_TTS_REPETITION_PENALTY:-}"
MIN_P="${VOICE_TTS_MIN_P:-}"
TOP_P="${VOICE_TTS_TOP_P:-}"
SEED="${VOICE_TTS_SEED:-}"

# Defaults
DEFAULT_MODEL=""
DEFAULT_VOICE=""
DEFAULT_FORMAT="pcm16"
DEFAULT_SAMPLE_RATE="24000"
DEFAULT_TTS_CHUNK_SIZE=""
DEFAULT_EXAGGERATION=""
DEFAULT_CFG_WEIGHT=""
DEFAULT_TEMPERATURE=""
DEFAULT_REPETITION_PENALTY=""
DEFAULT_MIN_P=""
DEFAULT_TOP_P=""
DEFAULT_SEED=""

configure_slot
load_defaults

while [ $# -gt 0 ]; do
  case "$1" in
    --start)
      MODE="start"
      shift
      ;;
    --set-defaults|--set-default)
      MODE="set-defaults"
      shift
      ;;
    --defaults-json)
      MODE="defaults-json"
      shift
      ;;
    --status-json)
      MODE="status-json"
      shift
      ;;
    --slot)
      shift
      [ "$#" -gt 0 ] || usage
      SLOT="$1"
      configure_slot
      DEFAULT_MODEL=""
      DEFAULT_VOICE=""
      DEFAULT_FORMAT=""
      DEFAULT_SAMPLE_RATE=""
      DEFAULT_TTS_CHUNK_SIZE=""
      DEFAULT_EXAGGERATION=""
      DEFAULT_CFG_WEIGHT=""
      DEFAULT_TEMPERATURE=""
      DEFAULT_REPETITION_PENALTY=""
      DEFAULT_MIN_P=""
      DEFAULT_TOP_P=""
      DEFAULT_SEED=""
      load_defaults
      shift
      ;;
    --stop)
      MODE="stop"
      shift
      ;;
    --voice)
      shift
      [ "$#" -gt 0 ] || usage
      VOICE_NAME="$1"
      shift
      ;;
    --format)
      shift
      [ "$#" -gt 0 ] || usage
      AUDIO_FORMAT="$1"
      shift
      ;;
    --sample-rate)
      shift
      [ "$#" -gt 0 ] || usage
      SAMPLE_RATE="$1"
      shift
      ;;
    --tts-chunk-size)
      shift
      [ "$#" -gt 0 ] || usage
      TTS_CHUNK_SIZE="$1"
      shift
      ;;
    --exaggeration)
      shift
      [ "$#" -gt 0 ] || usage
      EXAGGERATION="$1"
      shift
      ;;
    --cfg-weight)
      shift
      [ "$#" -gt 0 ] || usage
      CFG_WEIGHT="$1"
      shift
      ;;
    --temperature)
      shift
      [ "$#" -gt 0 ] || usage
      TEMPERATURE="$1"
      shift
      ;;
    --repetition-penalty)
      shift
      [ "$#" -gt 0 ] || usage
      REPETITION_PENALTY="$1"
      shift
      ;;
    --min-p)
      shift
      [ "$#" -gt 0 ] || usage
      MIN_P="$1"
      shift
      ;;
    --top-p)
      shift
      [ "$#" -gt 0 ] || usage
      TOP_P="$1"
      shift
      ;;
    --seed)
      shift
      [ "$#" -gt 0 ] || usage
      SEED="$1"
      shift
      ;;
    --model)
      shift
      [ "$#" -gt 0 ] || usage
      MODEL_KEY="$1"
      shift
      ;;
    --gpu-layers)
      shift
      # Reserved for future GPU config
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      ;;
    *)
      if [ -z "$MODEL_KEY" ]; then
        MODEL_KEY="$1"
      else
        VOICE_NAME="$1"
      fi
      shift
      ;;
  esac
done

# Load defaults if no model specified and defaults exist
if [ -z "$MODEL_KEY" ] && [ -n "$DEFAULT_MODEL" ]; then
  MODEL_KEY="$DEFAULT_MODEL"
fi
if [ -z "$VOICE_NAME" ] && [ -n "$DEFAULT_VOICE" ]; then
  VOICE_NAME="$DEFAULT_VOICE"
fi
if [ -z "$AUDIO_FORMAT" ] && [ -n "$DEFAULT_FORMAT" ]; then
  AUDIO_FORMAT="$DEFAULT_FORMAT"
fi
if [ "$SAMPLE_RATE" -eq 24000 ] && [ -n "$DEFAULT_SAMPLE_RATE" ] && [ -n "$DEFAULT_SAMPLE_RATE" ]; then
  SAMPLE_RATE="$DEFAULT_SAMPLE_RATE"
fi

if [ "$MODE" = "defaults-json" ]; then
  defaults_json
  exit 0
fi

# Status depends only on the slot's state files, so it must not require a
# model: a fresh machine has no saved default yet.
if [ "$MODE" = "status-json" ]; then
  status_json
  exit 0
fi

[ -n "$MODEL_KEY" ] || { echo "No model specified." >&2; usage; }
model_info "$MODEL_KEY"
apply_tuning_defaults_for_model

if [ "$MODE" = "set-defaults" ]; then
  save_defaults
  defaults_json
  exit 0
fi

if [ "$MODE" = "stop" ]; then
  stop_previous_server
  echo "Stopped."
  exit 0
fi

if [ "$MODE" != "start" ]; then
  usage
fi

# Set voice name from defaults if not provided
if [ -z "$VOICE_NAME" ] && [ -n "$DEFAULT_VOICE" ]; then
  VOICE_NAME="$DEFAULT_VOICE"
fi

# ========== TTS Launch ==========

echo "Starting TTS: slot=$SLOT model=$MODEL_KEY voice=$VOICE_NAME format=$AUDIO_FORMAT sample_rate=$SAMPLE_RATE tts_chunk_size=$TTS_CHUNK_SIZE exaggeration=$EXAGGERATION cfg_weight=$CFG_WEIGHT temperature=$TEMPERATURE repetition_penalty=$REPETITION_PENALTY min_p=$MIN_P top_p=$TOP_P seed=$SEED port=$PORT"
echo "Model path: $MODEL_PATH"

stop_previous_server
clear_runtime_files

# Build model-specific launch command
TTS_CMD=""
TTS_ARGS=""
case "$MODEL_KEY" in
  xtts-v2|xtts)
    # XTTS v2 via custom API server (coqui-tts 0.25.3 compat)
    TTS_CMD="$HOME/venvs/voice-models/bin/python"
    TTS_ARGS="$HOME/venvs/voice-models/bin/xtts_api_server --model_dir $MODEL_PATH --port $BACKEND_PORT --host $BACKEND_HOST"
    if [ -n "$VOICE_NAME" ]; then
      TTS_ARGS="$TTS_ARGS --voice $VOICE_NAME"
    fi
    ;;
  chatterbox|chatterbox-resemble|chatterbox-multilingual)
    # Chatterbox Multilingual TTS (ResembleAI)
    CHATTERBOX_ENV_ARGS="CHATTERBOX_DEFAULT_EXAGGERATION=$EXAGGERATION CHATTERBOX_DEFAULT_CFG_WEIGHT=$CFG_WEIGHT CHATTERBOX_DEFAULT_TEMPERATURE=$TEMPERATURE CHATTERBOX_DEFAULT_REPETITION_PENALTY=$REPETITION_PENALTY CHATTERBOX_DEFAULT_MIN_P=$MIN_P CHATTERBOX_DEFAULT_TOP_P=$TOP_P CHATTERBOX_DEFAULT_SEED=$SEED"
    if [ -n "$VOICE_NAME" ]; then
      CHATTERBOX_ENV_ARGS="$CHATTERBOX_ENV_ARGS CHATTERBOX_DEFAULT_VOICE=$VOICE_NAME"
    fi
    if [ -n "${CHATTERBOX_DEVICE:-}" ]; then
      CHATTERBOX_ENV_ARGS="$CHATTERBOX_ENV_ARGS CHATTERBOX_DEVICE=$CHATTERBOX_DEVICE"
    fi
    TTS_CMD="env"
    TTS_ARGS="$CHATTERBOX_ENV_ARGS $CHATTERBOX_PYTHON $LLM3_ROOT/src/chatterbox_api_server.py --model_dir $MODEL_PATH --port $BACKEND_PORT --host $BACKEND_HOST"
    ;;
  phonikud-upstream)
    # Upstream Chatterbox Multilingual + Phonikud ONNX for Hebrew
    PHONIKUD_UPSTREAM_ARGS="$LLM3_ROOT/src/phonikud_upstream_chatterbox_api_server.py --port $BACKEND_PORT --host $BACKEND_HOST --model-root $MODEL_PATH"
    if [ -n "$VOICE_NAME" ]; then
      PHONIKUD_UPSTREAM_ARGS="$PHONIKUD_UPSTREAM_ARGS --voice $VOICE_NAME"
    fi
    PHONIKUD_UPSTREAM_ENV_ARGS="PHONIKUD_UPSTREAM_DEFAULT_EXAGGERATION=$EXAGGERATION PHONIKUD_UPSTREAM_DEFAULT_CFG_WEIGHT=$CFG_WEIGHT PHONIKUD_UPSTREAM_DEFAULT_TEMPERATURE=$TEMPERATURE PHONIKUD_UPSTREAM_DEFAULT_REPETITION_PENALTY=$REPETITION_PENALTY PHONIKUD_UPSTREAM_DEFAULT_MIN_P=$MIN_P PHONIKUD_UPSTREAM_DEFAULT_TOP_P=$TOP_P PHONIKUD_UPSTREAM_DEFAULT_SEED=$SEED"
    # Speed options (measured 2026-06-11): micro-batched decode is ~1.8-2x
    # throughput with podG's concurrent chunk requests; fp16 T3 + fewer GC
    # passes + no Perth watermark shave the rest. All overridable via env.
    PHONIKUD_UPSTREAM_ENV_ARGS="$PHONIKUD_UPSTREAM_ENV_ARGS PHONIKUD_UPSTREAM_T3_DTYPE=${PHONIKUD_UPSTREAM_T3_DTYPE:-float16} PHONIKUD_UPSTREAM_BATCH_MAX_REQUESTS=${PHONIKUD_UPSTREAM_BATCH_MAX_REQUESTS:-3} PHONIKUD_UPSTREAM_BATCH_WINDOW_MS=${PHONIKUD_UPSTREAM_BATCH_WINDOW_MS:-250} PHONIKUD_UPSTREAM_DISABLE_WATERMARK=${PHONIKUD_UPSTREAM_DISABLE_WATERMARK:-true} PHONIKUD_UPSTREAM_GC_EVERY_N_REQUESTS=${PHONIKUD_UPSTREAM_GC_EVERY_N_REQUESTS:-8}"
    if [ -n "${PHONIKUD_UPSTREAM_DEVICE:-}" ]; then
      PHONIKUD_UPSTREAM_ENV_ARGS="$PHONIKUD_UPSTREAM_ENV_ARGS PHONIKUD_UPSTREAM_DEVICE=$PHONIKUD_UPSTREAM_DEVICE"
    elif [ -n "${CHATTERBOX_DEVICE:-}" ]; then
      PHONIKUD_UPSTREAM_ENV_ARGS="$PHONIKUD_UPSTREAM_ENV_ARGS CHATTERBOX_DEVICE=$CHATTERBOX_DEVICE"
    fi
    TTS_CMD="env"
    TTS_ARGS="$PHONIKUD_UPSTREAM_ENV_ARGS $PHONIKUD_UPSTREAM_CHATTERBOX_PYTHON $PHONIKUD_UPSTREAM_ARGS"
    ;;
  f5-tts-hebrew)
    # F5-TTS Hebrew v2 (fine-tuned, custom vocab)
    TTS_CMD="$HOME/venvs/voice-models/bin/python"
    TTS_ARGS="$HOME/venvs/voice-models/bin/f5_hebrew_server $BACKEND_PORT $BACKEND_HOST"
    ;;
  omnivoice)
    TTS_CMD="$EXTRA_TTS_PYTHON"
    TTS_ARGS="$LLM3_ROOT/src/omnivoice_api_server.py --port $BACKEND_PORT --host $BACKEND_HOST"
    if [ -n "$VOICE_NAME" ]; then
      TTS_ARGS="$TTS_ARGS --voice $VOICE_NAME"
    fi
    ;;
  kokoro)
    TTS_CMD="$EXTRA_TTS_PYTHON"
    TTS_ARGS="$LLM3_ROOT/src/kokoro_api_server.py --port $BACKEND_PORT --host $BACKEND_HOST"
    if [ -n "$VOICE_NAME" ]; then
      TTS_ARGS="$TTS_ARGS --voice $VOICE_NAME"
    fi
    ;;
  vibevoice|vibevoice-1.5b)
    # Microsoft VibeVoice-1.5B (next-token diffusion TTS, MPS-compatible)
    TTS_CMD="bash"
    TTS_ARGS="$LLM3_ROOT/src/vibevoice_wrapper.sh --port $BACKEND_PORT --host $BACKEND_HOST"
    if [ -n "$VOICE_NAME" ]; then
      TTS_ARGS="$TTS_ARGS --voice $VOICE_NAME"
    fi
    ;;
  *)
    echo "Unsupported model: $MODEL_KEY" >&2
    exit 1
    ;;
esac

echo "Launching: $TTS_CMD $TTS_ARGS"
rm -f "$SERVER_EXIT_MARKER_FILE"

# Start server in background, detached from this launcher shell. Append so a
# spawn path that skips clear_runtime_files cannot wipe crash evidence.
nohup env PHONIKUD_UPSTREAM_EXIT_MARKER_FILE="$SERVER_EXIT_MARKER_FILE" sh -c 'exec "$0" "$@"' "$TTS_CMD" $TTS_ARGS >>"$SERVER_LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >"$SERVER_PID_FILE"

# Wait for server to be ready. Big models (VibeVoice, OmniVoice) need more
# than 30s to load; a dead process must fail at once instead of waiting.
READY_TIMEOUT="${VOICE_TTS_READY_TIMEOUT:-180}"
READY=0
for i in $(seq 1 "$READY_TIMEOUT"); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "TTS server process $SERVER_PID exited before it became ready" >&2
    break
  fi
  if curl -sf "http://$BACKEND_HOST:$BACKEND_PORT/health" >/dev/null 2>&1 || \
     curl -sf "http://$BACKEND_HOST:$BACKEND_PORT/" >/dev/null 2>&1; then
    echo "TTS server ready on port $BACKEND_PORT (PID $SERVER_PID)"
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "TTS server failed to become ready on port $BACKEND_PORT" >&2
  if [ -s "$SERVER_LOG_FILE" ]; then
    echo "--- server log tail ---" >&2
    tail -n 40 "$SERVER_LOG_FILE" >&2 || true
  fi
  stop_previous_server
  exit 1
fi

# Start proxy (simple HTTP wrapper for external access)
cat >"$STATE_DIR/tts_proxy.py" <<PYEOF
import http.server
import urllib.request
import urllib.error
import json
import sys
import os
import socket
from pathlib import Path

host = "$HOST"
port = $PORT
backend_host = "$BACKEND_HOST"
backend_port = $BACKEND_PORT
log_file = "$SERVER_LOG_FILE"
backend_timeout = int(os.getenv("VOICE_TTS_PROXY_TIMEOUT", "600"))
backend_health_timeout = float(os.getenv("VOICE_TTS_PROXY_HEALTH_TIMEOUT", "5"))
model_key = "$MODEL_KEY"
model_path = Path("$MODEL_PATH").expanduser()
f5_manifest_path = model_path / ".llm3-f5-voices.json"
exit_marker_file = Path("$SERVER_EXIT_MARKER_FILE")

def _normalize_voice_name(value, fallback="voice"):
    normalized = "".join(ch.lower() if ch.isalnum() or ch in "-_" else "-" for ch in str(value or "").strip())
    normalized = normalized.strip("-_")
    return normalized or fallback

def _resolve_f5_voice_payload(body):
    if model_key != "f5-tts-hebrew":
        return body
    try:
        voice_name = _normalize_voice_name(body.get("voice") or body.get("voiceName") or "default", "default")
    except Exception:
        voice_name = "default"
    if body.get("ref_audio"):
        return body
    try:
        payload = json.loads(f5_manifest_path.read_text(encoding="utf-8"))
    except Exception:
        payload = {}
    voices = payload.get("voices") if isinstance(payload.get("voices"), list) else []
    default_voice = _normalize_voice_name(payload.get("default_voice") or "default", "default")
    selected = None
    for entry in voices:
        if not isinstance(entry, dict):
            continue
        if _normalize_voice_name(entry.get("name"), "") == voice_name:
            selected = entry
            break
    if selected is None:
        for entry in voices:
            if not isinstance(entry, dict):
                continue
            if _normalize_voice_name(entry.get("name"), "") == default_voice:
                selected = entry
                break
    if selected is None and voices:
        selected = voices[0]
    if not isinstance(selected, dict):
        return body
    prompt_path = str(selected.get("prompt_path") or "").strip()
    if not prompt_path:
        return body
    resolved_prompt = Path(prompt_path)
    if not resolved_prompt.is_absolute():
        resolved_prompt = (model_path / resolved_prompt).resolve()
    body["ref_audio"] = str(resolved_prompt)
    body["ref_text"] = str(selected.get("ref_text") or "").strip()
    return body

def _read_exit_marker():
    try:
        payload = json.loads(exit_marker_file.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None

def _fetch_backend_health():
    url = f"http://{backend_host}:{backend_port}/health"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=backend_health_timeout) as response:
            data = response.read()
            payload = json.loads(data.decode("utf-8")) if data else {}
            if not isinstance(payload, dict):
                payload = {"raw": payload}
            return response.status, payload
    except urllib.error.HTTPError as exc:
        try:
            data = exc.read()
            payload = json.loads(data.decode("utf-8")) if data else {}
        except Exception:
            payload = {"error": str(exc)}
        if not isinstance(payload, dict):
            payload = {"raw": payload}
        return exc.code, payload
    except Exception as exc:
        payload = {
            "status": "down",
            "error": str(exc),
            "backend_host": backend_host,
            "backend_port": backend_port,
        }
        marker = _read_exit_marker()
        if marker:
            payload["recent_exit"] = marker
        return 503, payload

class TTSProxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(f"{self.client_address[0]} - - {self.log_date_time_string()} {format % args}\n")

    def do_GET(self):
        if self.path == "/health" or self.path == "/" or self.path == "/backend-health":
            status, payload = _fetch_backend_health()
            if not isinstance(payload, dict):
                payload = {"status": "unknown"}
            payload.setdefault("service", "tts-proxy")
            payload["proxy_model_key"] = model_key
            payload["proxy_backend_host"] = backend_host
            payload["proxy_backend_port"] = backend_port
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b""

        try:
            content_type = self.headers.get("Content-Type", "application/json")
            if self.path == "/tts" and "application/json" in content_type.lower():
                payload = json.loads(body.decode("utf-8")) if body else {}
                payload = _resolve_f5_voice_payload(payload if isinstance(payload, dict) else {})
                body = json.dumps(payload).encode("utf-8")
            url = f"http://{backend_host}:{backend_port}{self.path}"
            req = urllib.request.Request(url, data=body, method="POST")
            req.add_header("Content-Type", content_type)
            response = urllib.request.urlopen(req, timeout=backend_timeout)
            data = response.read()

            self.send_response(response.status)
            for key in ("Content-Type", "Content-Length", "X-Chatterbox-EOS", "X-Chatterbox-Tokens", "X-Chatterbox-Max-Tokens"):
                if response.headers.get(key):
                    self.send_header(key, response.headers.get(key))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.log_message('proxy error for %s: %s', self.path, repr(e))
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

server = http.server.ThreadingHTTPServer((host, port), TTSProxy)
print(f"TTS proxy listening on http://{host}:{port}", flush=True)
server.serve_forever()
PYEOF

nohup python3 "$STATE_DIR/tts_proxy.py" >>"$TRAFFIC_LOG_FILE" 2>&1 &
PROXY_PID=$!
echo "$PROXY_PID" >"$PID_FILE"

echo "TTS proxy listening on http://$HOST:$PORT"
echo "Server PID: $SERVER_PID, Proxy PID: $PROXY_PID"

# Write state file
write_state_file "$PROXY_PID" "$SERVER_PID"

# Keep running (for background mode)
if [ -n "${VOICE_TTS_FOREGROUND:-}" ]; then
  wait "$PROXY_PID"
fi
