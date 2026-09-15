# TTS & STT Feature Plan for llm3

## 1. Overview

Add local Text-to-Speech (TTS) and Speech-to-Text (STT) model management to the llm3 control plane. A new **Voice** tab will appear in the UI alongside Models, Huggingface Models, Status, System, Logs, and Applications. Each voice model gets its own launchable slot with full lifecycle controls, status display, log viewing, and integration sync to Hermes Agent.

### Design Philosophy

- **Parallel with existing slot model**: TTS/STT models use the same launch/stop/defaults/log paradigm as LLM slots
- **Dedicated voice slots**: Voice models run on separate ports (not competing with LLM slots for GPU/MLX resources)
- **Hermes sync**: Launching or restarting a voice model auto-updates Hermes config with TTS/STT endpoints and restarts Hermes
- **Native UI integration**: The Voice tab feels like a natural extension — same card layout, same modal patterns, same status/log panels

---

## 2. Architecture Decisions

### 2.1 Slot Model for Voice

LLM models use slots 1–4 on ports 8036–8039. Voice models use **2 independent voice ports** — one for TTS, one for STT. At any given moment only 1 TTS model and 1 STT model are active, so we only need 2 ports. Model switching happens in-process (hot-swap) without restarting the server.

| Type | Port Range | Bind |
|------|-----------|------|
| LLM Slots 1–4 | Public: 8036–8039, Backend: 18036–18039 / 18136–18139 and sibling runtime-specific port bases | Existing |
| Voice TTS | Public: 8040, Backend: 18040 | New |
| Voice STT | Public: 8042, Backend: 18042 | New |

Voice models are **not** placed in LLM slots because:
- Different runtime stacks (PyTorch/ONNX vs llama.cpp/MLX)
- Different resource profiles (TTS is inference-only, STT is model + audio pipeline)
- Independent lifecycle (you may want voice running while all LLMs are stopped)

### 2.2 Port Assignment

```
Voice Slot    Public Port    Backend Port    Purpose
voice-tts     8040           18040           TTS (hot-swap between XTTS and Piper)
voice-stt     8042           18042           STT (hot-swap between Phonikud and Whisper)
```

**Hot-swap model switching:** The TTS server stays running on port 8040. When the user picks a different TTS model from the dropdown, the server unloads the current model weights and loads the new ones in-process (no port change, no restart). Same for STT on port 8042. This is possible because both TTS models and both STT models share the same API surface (`/tts/synthesize` / `/stt/transcribe`).

### 2.3 Runtime Stacks

Each voice service runs as a single persistent HTTP server per type (TTS / STT). The llm3 server manages these as launcher scripts, analogous to `qwen_llama` and `run-qwen36-mlx-api.sh`.

**Voice state directory**: `~/.local/state/llm3/voice/`

```
voice/
├── voice-tts/
│   ├── current.json              # currently active model
│   ├── defaults.json             # default model, voice, format, sample rate
│   ├── tts-server.pid
│   ├── tts-server.log
│   ├── models/
│   │   ├── xtts-v2/              # Coqui XTTS v2 weights
│   │   └── piper-he/             # Piper Hebrew voice
│   └── voices/                   # available TTS voices (speaker IDs, voice names)
└── voice-stt/
    ├── current.json              # currently active model
    ├── defaults.json             # default model
    ├── stt-server.pid
    ├── stt-server.log
    └── models/
        ├── phonikud-large/       # Phonikud Hebrew STT
        └── whisper-large-v3/     # OpenAI Whisper v3
```

### 2.4 Model Selection

**STT (2 models — hot-swap on same port):**
1. **Phonikud** — Hebrew-optimized Whisper fine-tune. Best Hebrew accuracy. Downloads from HuggingFace. Runs on CPU/GPU via PyTorch.
2. **Whisper-large-v3** (openai/whisper) — General-purpose top-tier STT. Good Hebrew support among 99 languages.

**TTS (2 models — hot-swap on same port):**
1. **Coqui XTTS-v2** — Top-tier multi-speaker, multi-language TTS. Excellent Hebrew quality. Runs via Coqui TTS library. **Supports voice/speaker selection** (multiple speaker embeddings).
2. **Piper TTS** — Fast, lightweight, ONNX-based. Hebrew voices available (`hebrew_male`, `hebrew_female`). Ideal for low-latency use.

### 2.5 TTS Voice Selection

The TTS tab includes a **Voice selector** dropdown that lists all available voices for the currently active TTS model:

- **XTTS-v2 voices:** Speaker ID embeddings (user can record/upload a reference audio to clone a voice, or use built-in default speakers)
- **Piper voices:** `hebrew_male`, `hebrew_female`, plus any additional Piper Hebrew voices downloaded

Voice selection is part of the per-slot defaults — switching a voice does not restart the server, just changes the active voice config.

### 2.6 Voice API Protocol

Each voice service exposes a minimal API surface:

```
GET  /v1/models              — returns voice model info
GET  /v1/health              — health check
GET  /tts/voices             — list available voices for current model
POST /tts/synthesize         — TTS: JSON body {text, voice, format, sample_rate} → audio WAV/MP3
GET  /tts/synthesize?text=...&voice=...  — TTS: same, query params
POST /stt/transcribe         — STT: multipart audio upload → text JSON
```

This mirrors the LLM OpenAI-compatible pattern so downstream consumers are familiar.

---

## 3. Hermes Integration

### 3.1 Current Hermes TTS/STT Config

Hermes Agent needs TTS/STT endpoints in its config.yaml. The plan adds these config keys:

```yaml
tts:
  provider: coqui_xtts        # or piper
  base_url: http://127.0.0.1:8040
  model: xtts-v2

stt:
  provider: phonikud          # or whisper-v3
  base_url: http://127.0.0.1:8042
  model: phonikud-large
```

### 3.2 Sync Flow

When a voice model is launched (or restarted from the Voice tab):

1. llm3 server reads the voice model's runtime URL from `dashboard-config.json`
2. llm3 SSHes to `the remote machine` (same as existing Hermes sync)
3. llm3 rewrites `~/.hermes/config.yaml` with the new TTS/STT values
4. llm3 restarts `hermes-gateway.service`
5. Response includes `tts_sync` and `stt_sync` status objects

### 3.3 Hermes Restart Endpoint

New endpoint: `POST /api/voice/restart`

- Stops all voice models
- Restarts them with current defaults
- Syncs TTS/STT config to Hermes Agent
- Returns full overview

This is analogous to `POST /api/hermes/restart` but for voice models.

---

## 4. UI/UX Design

### 4.1 New Voice Tab

Add a **Voice** nav item in the sidebar between Applications and the footer:

```html
<button class="nav-item" data-section="voice">
  <svg><!-- wave/speaker icon --></svg>
  <span>Voice</span>
</button>
```

### 4.2 Voice Tab Layout

The Voice tab uses the **same card layout** as the Models tab but with voice-specific fields:

```
┌─────────────────────────────────────────────────────┐
│ Voice                                          [⚙] │
├─────────────────────────────────────────────────────┤
│ [All (4)]  [TTS (2)]  [STT (2)]  [XTTS] [Piper] [Phonikud] [Whisper] │
│                                                             │
│ ┌──────────────────┐  ┌──────────────────┐              │
│ │ 🎙️  XTTS-v2      │  │ 🎙️  Piper HE     │              │
│ │ Text-to-Speech   │  │ Text-to-Speech   │              │
│ │ Coqui            │  │ Coqui/ONNX       │              │
│ │                  │  │                  │              │
│ │ Size: 2.4 GB     │  │ Size: 85 MB      │              │
│ │ Language: Multi  │  │ Language: HE     │              │
│ │ Quality: High    │  │ Quality: Fast    │              │
│ │                  │  │                  │              │
│ │ [Launch] [Stop]  │  │ [Launch] [Stop]  │              │
│ └──────────────────┘  └──────────────────┘              │
│                                                             │
│ ┌──────────────────┐  ┌──────────────────┐              │
│ │ 🎧  Phonikud     │  │ 🎧  Whisper v3   │              │
│ │ Speech-to-Text   │  │ Speech-to-Text   │              │
│ │ Hebrew-Optimized │  │ OpenAI           │              │
│ │                  │  │                  │              │
│ │ Size: 3.1 GB     │  │ Size: 3.1 GB     │              │
│ │ Language: HE+EN  │  │ Language: 99     │              │
│ │ Accuracy: High   │  │ Accuracy: High   │              │
│ │                  │  │                  │              │
│ │ [Launch] [Stop]  │  │ [Launch] [Stop]  │              │
│ └──────────────────┘  └──────────────────┘              │
└─────────────────────────────────────────────────────┘
```

### 4.3 Launch Modal (Voice)

When clicking **Launch** on a voice card, the modal adapts for voice-specific options:

- **Slot selector**: Voice slot (Voice TTS, Voice STT)
- **Runtime URL**: Configurable (default: `http://127.0.0.1:8040` etc.)
- **Model summary**: Name, size, language support, quality tier
- **Voice selection** (TTS only): Which voice to use (speaker ID for XTTS, voice name for Piper)
- **Audio format**: WAV / MP3 / OGG
- **Sample rate**: 22050 / 24000 / 44100
- **Hermes checkbox**: "Set Hermes TTS" / "Set Hermes STT"
- **Launch button**: Changes label based on slot

### 4.4 Status Display

The Status section shows voice slots alongside LLM slots:

```
┌─ Voice Runtime ─────────────────────────────────────┐
│ [●] Voice TTS — XTTS-v2     http://127.0.0.1:8040  │
│     Running 42s · RSS 2.1 GB · CPU 12%             │
│     [Stop] [Set Hermes]                              │
│                                                     │
│ [●] Voice STT — Phonikud    http://127.0.0.1:8042  │
│     Running 120s · RSS 3.8 GB · CPU 8%              │
│     [Stop] [Set Hermes]                              │
└─────────────────────────────────────────────────────┘
```

### 4.5 Voice Logs Tab

The existing Logs section gets a **Voice** log kind tab alongside Traffic/Server/Proxy:

```
[Slot: Voice TTS ▼]  [Traffic] [Server] [Voice]
```

The Voice log kind shows TTS/STT service logs (synthesis requests, transcription results, errors).

### 4.6 Voice Restart Button

Top bar gets a **Restart Voice** button next to Restart Hermes and Stop All:

```
[🔄 Refresh] [🔄 Restart Voice] [🔄 Restart Hermes] [⏹ Stop All]
```

"Restart Voice" stops all voice models, restarts them, and syncs to Hermes.

### 4.7 Applications Tab — Voice Row

Add a **Voice** row to the Applications section:

```
┌───────────────────────────────────────────────┐
│ Hermes Agent      → 1st LLM    [Save]        │
│ Hermes M4         → 1st LLM    [Save]        │
│ Claude Code       → 1st LLM    [Save]        │
│ LibreChat         → 1st LLM    [Save]        │
│ Remote JSON app   → 1st LLM    [Save]        │
│ Voice (TTS)       → Voice TTS  [Save]        │
│ Voice (STT)       → Voice STT  [Save]        │
└───────────────────────────────────────────────┘
```

---

## 5. Backend Implementation

### 5.1 Server.js Changes

**New constants:**
```javascript
const VOICE_STATE_DIR = path.join(SLOT_STATE_DIR, "voice");
const VOICE_SLOT_COUNT = 2; // tts, stt
const VOICE_TTS_PUBLIC_PORT_BASE = 8040;
const VOICE_TTS_BACKEND_PORT_BASE = 18040;
const VOICE_STT_PUBLIC_PORT_BASE = 8042;
const VOICE_STT_BACKEND_PORT_BASE = 18042;
const VOICE_SLOT_TYPES = ["tts", "stt"];
const VOICE_SLOT_LABELS = ["Voice TTS", "Voice STT"];
```

**New slot definitions:**
```javascript
const VOICE_SLOT_DEFINITIONS = Array.from(
  { length: VOICE_SLOT_COUNT },
  (_, index) => ({
    id: `voice-${VOICE_SLOT_TYPES[index]}-${index + 1}`,
    index: index + 1,
    label: VOICE_SLOT_LABELS[index],
    type: VOICE_SLOT_TYPES[index], // "tts" or "stt"
    publicPort: VOICE_PUBLIC_PORT_BASE + index,
    backendPort: VOICE_BACKEND_PORT_BASE + index,
    stateDir: path.join(VOICE_STATE_DIR, `voice-${VOICE_SLOT_TYPES[index]}-${index + 1}`),
  })
);
```

**New API endpoints:**
- `GET /api/voice/models` — list available voice models
- `GET /api/voice/status` — status of all voice slots
- `POST /api/voice/start` — launch a voice model in a slot
- `POST /api/voice/stop` — stop a voice model in a slot
- `POST /api/voice/defaults` — set voice model defaults
- `POST /api/voice/restart` — restart all voice models + sync Hermes
- `POST /api/voice/slot-config` — set voice slot runtime URL
- `GET /api/voice/logs/:slotId/:kind` — voice model logs

**New sync function:**
```javascript
async function syncVoiceAfterLaunch(target) {
  // SSH to remote, update config.yaml with tts/stt fields
  // restart hermes-gateway.service
}
```

### 5.2 Voice Launcher Scripts

Create two launcher scripts analogous to the LLM launchers:

**`./bin/voice-tts.sh`** — TTS model launcher
- Supports XTTS-v2 and Piper backends
- Slot-aware state management
- `--list-json`, `--status-json`, `--defaults-json`, `--set-defaults`, `--start`, `--stop`
- Exposes HTTP server on the assigned port

**`./bin/voice-stt.sh`** — STT model launcher
- Supports Phonikud and Whisper-v3 backends
- Slot-aware state management
- Same CLI interface as TTS launcher
- Handles audio upload (multipart) and transcription

### 5.3 Voice Model Registry

Voice models are discovered from `~/models/voice/`:

```
~/models/voice/
├── xtts-v2/           # Coqui XTTS v2 weights
├── piper-he/           # Piper Hebrew voice
├── phonikud-large/     # Phonikud Hebrew STT
└── whisper-large-v3/   # OpenAI Whisper v3
```

Each model directory contains a `.llm3-voice.json` metadata file:
```json
{
  "label": "XTTS-v2",
  "runtime": "coqui",
  "type": "tts",
  "languages": ["en", "he", "es", "fr", "de", "it", "pt", "ru", "zh", "ja"],
  "quality": "high",
  "latency": "medium",
  "hfUrl": "https://huggingface.co/coqui/XTTS-v2",
  "sizeBytes": 2400000000,
  "aliases": ["xtts", "xtts-v2", "coqui-xtts"]
}
```

### 5.4 Dashboard Config Extension

Extend `dashboard-config.json` with voice targets:

```json
{
  "applicationTargets": {
    "hermes": "slot1",
    "claudecode": "slot1",
    "librechat": "slot1",
    "remotejsonapp": "slot1",
    "hermesm4": "slot1",
    "voicetts": "voice-tts-1",
    "voicestt": "voice-stt-1"
  },
  "integrationTargets": {
    "hermes": "slot1",
    "openclaude": "slot1",
    "chat": "slot1"
  },
  "slotRuntimeBaseUrls": {
    "slot1": "...",
    "voice-tts-1": "http://127.0.0.1:8040",
    "voice-stt-1": "http://127.0.0.1:8042"
  }
}
```

---

## 6. Model Download Pipeline

### 6.1 HuggingFace Integration

Extend the existing HuggingFace search/download UI to include voice models:

- Add a **"Voice Models"** filter chip in the HF search
- Pre-populated voice model candidates:
  - `coqui/XTTS-v2` (TTS)
  - `rhasspy/piper-voices` → `he/hebrew_male` (TTS)
  - `phonikud` equivalent HF repo (STT)
  - `openai/whisper` → `large-v3` (STT)

### 6.2 Download Workflow

1. User searches HF for voice models (or uses pre-populated list)
2. Downloads to `~/models/voice/<model-name>/`
3. Creates `.llm3-voice.json` metadata
4. Model appears in Voice tab cards
5. User can launch from the card

### 6.3 Phonikud Setup

Phonikud is a Hebrew-optimized Whisper variant. Download steps:
1. Clone the Phonikud repo or download weights from HuggingFace
2. Place in `~/models/voice/phonikud-large/`
3. Install dependencies (PyTorch, transformers) in a dedicated venv or the existing `qwen36-mlx` venv
4. Create the STT launcher wrapper

---

## 7. Implementation Phases

### Phase 1: Infrastructure (server-side)
- [ ] Add voice slot definitions to server.js
- [ ] Create voice state directory structure
- [ ] Add voice API endpoints (models, status, start, stop, defaults, restart, logs)
- [ ] Extend dashboard config with voice targets
- [ ] Add `syncVoiceAfterLaunch()` function
- [ ] Add `restartVoiceModels()` function
- [ ] Extend `/api/overview` to include voice data

### Phase 2: Launcher Scripts
- [ ] Create `./bin/voice-tts.sh` launcher (XTTS-v2 + Piper)
- [ ] Create `./bin/voice-stt.sh` launcher (Phonikud + Whisper-v3)
- [ ] Implement CLI interface (--list-json, --status-json, --start, --stop, etc.)
- [ ] Implement HTTP API servers for each backend
- [ ] Add audio upload handling for STT endpoints
- [ ] Add TTS synthesis endpoints returning audio

### Phase 3: Model Downloads
- [ ] Add voice model metadata format (`.llm3-voice.json`)
- [ ] Extend HF search to surface voice models
- [ ] Create download pipeline for voice models
- [ ] Download and configure Phonikud STT
- [ ] Download and configure Whisper-large-v3 STT
- [ ] Download and configure XTTS-v2 TTS
- [ ] Download and configure Piper TTS (Hebrew voice)
- [ ] Install required dependencies (ffmpeg, coqui-tts, etc.)

### Phase 4: Frontend UI
- [ ] Add Voice nav item to index.html sidebar
- [ ] Add Voice section to index.html
- [ ] Implement voice model card rendering (app.js)
- [ ] Implement voice filter chips (All/TTS/STT/by-model)
- [ ] Implement voice launch modal with voice-specific fields
- [ ] Add voice status rendering to Status section
- [ ] Add voice log kind tab to Logs section
- [ ] Add Restart Voice button to top bar
- [ ] Add Voice rows to Applications section
- [ ] Add voice model search/filter to Models section

### Phase 5: Hermes Integration
- [ ] Update `buildHermesSyncRemoteScript()` to include TTS/STT config
- [ ] Test end-to-end: launch voice → sync to remote → restart Hermes
- [ ] Verify Hermes uses the new TTS/STT endpoints

### Phase 6: Testing & Polish
- [ ] Test each voice model launch/stop lifecycle
- [ ] Test TTS synthesis endpoint (text → audio)
- [ ] Test STT transcription endpoint (audio → text)
- [ ] Test Hermes sync with voice models
- [ ] Test concurrent voice + LLM operation
- [ ] Performance profiling (memory, CPU, latency)
- [ ] Error handling and recovery
- [ ] Log quality and observability

---

## 8. Resource Considerations

### 8.1 Hardware (M4 Max, 128GB RAM)

| Model | RAM Usage | GPU/Metal | Latency |
|-------|-----------|-----------|---------|
| XTTS-v2 | ~2.4 GB weights + ~2 GB runtime | Metal ✅ | ~2-5s synthesis |
| Piper HE | ~85 MB weights + ~200 MB runtime | Metal ✅ | ~100ms synthesis |
| Phonikud | ~3 GB weights + ~2 GB runtime | Metal ✅ | ~2-4s transcribe |
| Whisper v3 | ~3 GB weights + ~2 GB runtime | Metal ✅ | ~2-4s transcribe |

Total peak: ~15 GB — well within 128 GB capacity. No contention with LLM models.

### 8.2 Dependencies

- **ffmpeg** — audio format conversion (brew install ffmpeg)
- **PyTorch** — for Phonikud/Whisper (already in qwen36-mlx venv)
- **Coqui-TTS** — for XTTS-v2 (new venv or install in existing)
- **Piper** — ONNX runtime (pip install piper-tts)
- **soundfile / pydub** — audio I/O

### 8.3 Port Conflicts

Ports 8040 / 8042 and 18040 / 18042 are reserved. Verify no other services use these ports.

---

## 9. Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Phonikud not readily available on HF | Use Hebrew-optimized Whisper checkpoint from alternative source; fallback to whisper-large-v3 with Hebrew prompt engineering |
| Coqui-TTS dependency conflicts | Use isolated venv for voice models; pin versions |
| Metal inference for PyTorch models | Verify PyTorch Metal backend works on M4 Max; fallback to CPU if needed |
| Audio upload size limits | Set reasonable limits (25MB max for STT); stream processing |
| Hermes config drift | Use the same atomic write + restart pattern as existing LLM sync |

---

## 10. File Changes Summary

### New Files
- `./bin/voice-tts.sh` — TTS launcher script
- `./bin/voice-stt.sh` — STT launcher script
- `~/websites/llm3/public/voice.js` — voice-specific frontend module (optional split)
- `~/models/voice/.llm3-voice.json` — voice model registry

### Modified Files
- `~/websites/llm3/public/index.html` — Voice nav item, Voice section, Restart Voice button, Voice app row
- `~/websites/llm3/public/app.js` — Voice rendering, modal, state, events
- `~/websites/llm3/public/styles.css` — Voice card styles, tab styles
- `~/websites/llm3/src/server.js` — Voice slots, endpoints, sync, overview
- `~/.hermes/config.yaml` — TTS/STT config fields (synced from llm3)
- `~/LLM_STACK_ARCHITECTURE.md` — Document the new voice layer

### New Directories
- `~/.local/state/llm3/voice/` — Voice model state
- `~/models/voice/` — Voice model weights
