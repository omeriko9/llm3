#!/bin/bash
# Wrapper to launch VibeVoice API server with the correct venv.
# This script is called by voice-tts.sh for the vibevoice model.

VIBE_VENV="$HOME/VibeVoice-tts/.venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM3_SRC="$SCRIPT_DIR"

exec "$VIBE_VENV/bin/python" "$LLM3_SRC/vibevoice_api_server.py" "$@"
