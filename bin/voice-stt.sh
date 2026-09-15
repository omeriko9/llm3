#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM3_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"

SLOT="${VOICE_STT_SLOT:-slot1}"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/llm3/voice"
STATE_DIR=""
STATE_FILE=""
DEFAULTS_FILE=""
PID_FILE=""
SERVER_PID_FILE=""
SERVER_LOG_FILE=""
TRAFFIC_LOG_FILE=""

HOST="${VOICE_STT_HOST:-0.0.0.0}"
PORT="${VOICE_STT_PORT:-}"
BACKEND_HOST="${VOICE_STT_BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${VOICE_STT_BACKEND_PORT:-}"
VOICE_STT_VENV="${VOICE_STT_VENV:-$HOME/venvs/voice-models}"
VOICE_STT_SERVER_SCRIPT="${VOICE_STT_SERVER_SCRIPT:-$LLM3_ROOT_DEFAULT/src/voice-stt-server.py}"

usage() {
  cat <<'EOF'
Usage:
  ./bin/voice-stt.sh [--slot slotN] <model> [voice_name]
  ./bin/voice-stt.sh [--slot slotN] <model> --start
  ./bin/voice-stt.sh [--slot slotN] <model> --set-defaults [--voice NAME] [--format FMT] [--sample-rate N]
  ./bin/voice-stt.sh [--slot slotN] --start [--voice NAME] [--format FMT] [--sample-rate N]
  ./bin/voice-stt.sh [--slot slotN] --defaults-json
  ./bin/voice-stt.sh [--slot slotN] --status-json
  ./bin/voice-stt.sh [--slot slotN] --stop

Models:
  whisper-v3        OpenAI Whisper v3 (local, high quality)
  whisper-v3-tiny   Whisper v3 tiny (fast, lower accuracy)
  whisper-v3-base   Whisper v3 base (balanced)
  whisper-v3-large  Whisper v3 large (best accuracy)
  faster-whisper    Faster Whisper (CTranslate2, GPU-accelerated)
  whispercpp        whisper.cpp (CPU-only, ultra-lightweight)

Environment overrides:
  VOICE_STT_PORT            public API port (default: slot-based)
  VOICE_STT_BACKEND_PORT    backend port (default: slot-based)
  VOICE_STT_VOICE           default voice/model variant
  VOICE_STT_FORMAT          default audio format (pcm16/wav/flac)
  VOICE_STT_SAMPLE_RATE     default sample rate (default: 16000)
  VOICE_STT_GPU_LAYERS      GPU layers (default: 999)
  VOICE_STT_MODEL_DIR       custom model directory override
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
    slot1|voice-stt-1)
      STATE_DIR="$STATE_ROOT/voice-stt-1"
      legacy_state_dir="$STATE_ROOT"
      ;;
    slot2|voice-stt-2)
      STATE_DIR="$STATE_ROOT/voice-stt-2"
      legacy_state_dir="$STATE_ROOT/slot2"
      ;;
    *)
      if [ -z "$STATE_DIR" ]; then
        STATE_DIR="$STATE_ROOT/$SLOT"
      fi
      ;;
  esac

  if [ -z "$PORT" ]; then
    PORT=$((8042 + index - 1))
  fi
  if [ -z "$BACKEND_PORT" ]; then
    BACKEND_PORT=$((18042 + index - 1))
  fi

  STATE_FILE="$STATE_DIR/current.json"
  DEFAULTS_FILE="$STATE_DIR/defaults.json"
  PID_FILE="$STATE_DIR/stt-proxy.pid"
  SERVER_PID_FILE="$STATE_DIR/stt-server.pid"
  SERVER_LOG_FILE="$STATE_DIR/server.log"
  TRAFFIC_LOG_FILE="$STATE_DIR/traffic.log"

  mkdir -p "$STATE_DIR"

  if [ -n "$legacy_state_dir" ] && [ "$legacy_state_dir" != "$STATE_DIR" ] && [ -d "$legacy_state_dir" ]; then
    for legacy_name in \
      current.json \
      defaults.json \
      stt-proxy.pid \
      stt-server.pid \
      server.log \
      traffic.log \
      stt_proxy.py
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
PY
  )
}

defaults_json() {
  cat <<EOF
{
  "model": "${DEFAULT_MODEL:-}",
  "voice": "${DEFAULT_VOICE:-}",
  "format": "${DEFAULT_FORMAT:-pcm16}",
  "sampleRate": ${DEFAULT_SAMPLE_RATE:-16000}
}
EOF
}

save_defaults() {
  cat >"$DEFAULTS_FILE" <<EOF
{
  "model": "$MODEL_KEY",
  "voice": "$VOICE_NAME",
  "format": "$AUDIO_FORMAT",
  "sampleRate": $SAMPLE_RATE
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

kill_known_listener() {
  local port="$1"
  local pid=""
  local port_cmd=""

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  pid="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  if [ -z "$pid" ]; then
    return 0
  fi

  port_cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  case "$port_cmd" in
    *BaseHTTPRequestHandler*|*ThreadingHTTPServer*|*uvicorn*|*fastapi*|*whisper*|*faster*|*whispercpp*|*voice-stt-server.py*|*stt_proxy.py*)
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
      echo "Stopping previous STT proxy PID $old_pid..."
      kill_pid "$old_pid"
    fi
  fi

  if [ -f "$SERVER_PID_FILE" ]; then
    old_pid="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "Stopping previous STT server PID $old_pid..."
      kill_pid "$old_pid"
    fi
  fi

  kill_known_listener "$PORT"
  kill_known_listener "$BACKEND_PORT"
  rm -f "$PID_FILE" "$SERVER_PID_FILE" "$STATE_FILE"
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
  "type": "stt",
  "model": {
    "key": "$MODEL_KEY",
    "label": "$MODEL_LABEL",
    "path": "$MODEL_PATH",
    "aliases": $aliases_json
  },
  "params": {
    "voice": "$VOICE_NAME",
    "format": "$AUDIO_FORMAT",
    "sampleRate": $SAMPLE_RATE
  },
  "network": {
    "publicHost": "$HOST",
    "publicPort": $PORT,
    "backendHost": "$BACKEND_HOST",
    "backendPort": $BACKEND_PORT
  },
  "logs": {
    "server": "$SERVER_LOG_FILE",
    "traffic": "$TRAFFIC_LOG_FILE"
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
  local model_dir="${VOICE_STT_MODEL_DIR:-}"

  MODEL_KEY="$key"
  MODEL_ALIAS=""
  MODEL_PATH=""

  case "$key" in
    whisper-v3|whisper-v3-small|whisper-v3-tiny|whisper-v3-base|whisper-v3-large|whisper-large-v3-turbo)
      local variant
      variant=$(echo "$key" | sed 's/whisper-v3-//' | sed 's/whisper-large-v3-turbo/large-v3-turbo/')
      MODEL_LABEL="Whisper v3 $variant"
      MODEL_PATH="${model_dir:-$(resolve_model_path "$HOME/models/voice/voice-stt/$key" "$HOME/models/voice-stt/$key")}"
      MODEL_ALIAS="$key"
      ;;
    faster-whisper)
      MODEL_LABEL="Faster Whisper"
      MODEL_PATH="${model_dir:-$(resolve_model_path "$HOME/models/voice/voice-stt/faster-whisper" "$HOME/models/voice-stt/faster-whisper")}"
      MODEL_ALIAS="faster-whisper,faster"
      ;;
    ivrit-whisper-turbo-ct2|ivrit-whisper|ivrit)
      # ivrit.ai Hebrew Whisper (CTranslate2 / faster-whisper); defaults to Hebrew.
      MODEL_LABEL="ivrit.ai Whisper (Hebrew)"
      MODEL_PATH="${model_dir:-$(resolve_model_path "$HOME/models/voice/voice-stt/ivrit-whisper-turbo-ct2" "$HOME/models/voice-stt/ivrit-whisper-turbo-ct2")}"
      MODEL_ALIAS="ivrit-whisper-turbo-ct2,ivrit-whisper,ivrit"
      ;;
    whispercpp)
      MODEL_LABEL="whisper.cpp"
      MODEL_PATH="${model_dir:-$(resolve_model_path "$HOME/models/voice/voice-stt/whispercpp" "$HOME/models/voice-stt/whispercpp" "$HOME/models/voice-stt/whisper.cpp")}"
      MODEL_ALIAS="whispercpp,whisper.cpp"
      ;;
    *)
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

is_positive_int() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    0) return 1 ;;
    *) return 0 ;;
  esac
}

clear_runtime_files() {
  :>"$SERVER_LOG_FILE"
  :>"$TRAFFIC_LOG_FILE"
}

# ========== Argument Parsing ==========

MODE=""
MODEL_KEY=""
VOICE_NAME="${VOICE_STT_VOICE:-}"
AUDIO_FORMAT="${VOICE_STT_FORMAT:-pcm16}"
SAMPLE_RATE="${VOICE_STT_SAMPLE_RATE:-16000}"

# Defaults
DEFAULT_MODEL=""
DEFAULT_VOICE=""
DEFAULT_FORMAT="pcm16"
DEFAULT_SAMPLE_RATE="16000"

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

if [ -z "$MODEL_KEY" ] && [ -n "$DEFAULT_MODEL" ]; then
  MODEL_KEY="$DEFAULT_MODEL"
fi
if [ -z "$VOICE_NAME" ] && [ -n "$DEFAULT_VOICE" ]; then
  VOICE_NAME="$DEFAULT_VOICE"
fi
if [ -z "$AUDIO_FORMAT" ] && [ -n "$DEFAULT_FORMAT" ]; then
  AUDIO_FORMAT="$DEFAULT_FORMAT"
fi
if [ "$SAMPLE_RATE" -eq 16000 ] && [ -n "$DEFAULT_SAMPLE_RATE" ]; then
  SAMPLE_RATE="$DEFAULT_SAMPLE_RATE"
fi

if [ "$MODE" = "defaults-json" ]; then
  defaults_json
  exit 0
fi

if [ "$MODE" = "status-json" ]; then
  status_json
  exit 0
fi

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

[ -n "$MODEL_KEY" ] || { echo "No model specified." >&2; usage; }

model_info "$MODEL_KEY"

if [ -z "$VOICE_NAME" ] && [ -n "$DEFAULT_VOICE" ]; then
  VOICE_NAME="$DEFAULT_VOICE"
fi

# ========== STT Launch ==========

echo "Starting STT: slot=$SLOT model=$MODEL_KEY voice=$VOICE_NAME format=$AUDIO_FORMAT sample_rate=$SAMPLE_RATE port=$PORT"
echo "Model path: $MODEL_PATH"

stop_previous_server
clear_runtime_files

STT_CMD=""
STT_ARGS=""
case "$MODEL_KEY" in
  whisper-v3-tiny|whisper-v3-base|whisper-v3-small|whisper-v3-large|whisper-v3|whisper-large-v3-turbo|faster-whisper)
    STT_CMD="$VOICE_STT_VENV/bin/python"
    STT_ARGS="$VOICE_STT_SERVER_SCRIPT --model-key $MODEL_KEY --model-path $MODEL_PATH --host $BACKEND_HOST --port $BACKEND_PORT"
    ;;
  ivrit-whisper-turbo-ct2|ivrit-whisper|ivrit)
    STT_CMD="$VOICE_STT_VENV/bin/python"
    STT_ARGS="$VOICE_STT_SERVER_SCRIPT --model-key $MODEL_KEY --model-path $MODEL_PATH --host $BACKEND_HOST --port $BACKEND_PORT --default-language ${VOICE_STT_DEFAULT_LANGUAGE:-he}"
    ;;
  whispercpp)
    STT_CMD="python3"
    STT_ARGS="-m whispercpp_server --model_dir $MODEL_PATH --port $BACKEND_HOST:$BACKEND_PORT"
    ;;
  *)
    echo "Unsupported model: $MODEL_KEY" >&2
    exit 1
    ;;
esac

eval "exec $STT_CMD $STT_ARGS" >"$SERVER_LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >"$SERVER_PID_FILE"

# Wait for server to be ready
READY=0
for i in $(seq 1 30); do
  if curl -sf "http://$BACKEND_HOST:$BACKEND_PORT/health" >/dev/null 2>&1 || \
     curl -sf "http://$BACKEND_HOST:$BACKEND_PORT/" >/dev/null 2>&1; then
    echo "STT server ready on port $BACKEND_PORT (PID $SERVER_PID)"
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "STT server failed to become ready on port $BACKEND_PORT" >&2
  stop_previous_server
  exit 1
fi

# Start proxy
cat >"$STATE_DIR/stt_proxy.py" <<PYEOF
import http.server
import urllib.request
import urllib.error
import json

host = "$HOST"
port = $PORT
backend_host = "$BACKEND_HOST"
backend_port = $BACKEND_PORT
log_file = "$SERVER_LOG_FILE"

class STTProxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(f"{self.client_address[0]} - - {self.log_date_time_string()} {format % args}\\n")

    def do_GET(self):
        if self.path == "/health" or self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "service": "stt-proxy"}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b""

        try:
            url = f"http://{backend_host}:{backend_port}{self.path}"
            req = urllib.request.Request(url, data=body, method="POST")
            req.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))
            response = urllib.request.urlopen(req, timeout=120)
            data = response.read()

            self.send_response(response.status)
            for key in ("Content-Type", "Content-Length"):
                if response.headers.get(key):
                    self.send_header(key, response.headers.get(key))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

server = http.server.ThreadingHTTPServer((host, port), STTProxy)
print(f"STT proxy listening on http://{host}:{port}", flush=True)
server.serve_forever()
PYEOF

python3 "$STATE_DIR/stt_proxy.py" >>"$TRAFFIC_LOG_FILE" 2>&1 &
PROXY_PID=$!
echo "$PROXY_PID" >"$PID_FILE"

echo "STT proxy listening on http://$HOST:$PORT"
echo "Server PID: $SERVER_PID, Proxy PID: $PROXY_PID"

write_state_file "$PROXY_PID" "$SERVER_PID"

if [ -n "${VOICE_STT_FOREGROUND:-}" ]; then
  wait "$PROXY_PID"
fi
