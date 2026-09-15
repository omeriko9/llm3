# llm3

A local-first **dashboard and control plane for running multiple local LLM slots** on a
workstation. It launches, monitors, and hot-swaps up to four model backends
(llama.cpp / GGUF, MLX, and voice TTS/STT servers), exposes them behind stable
per-slot ports and an OpenAI-compatible proxy, and gives you a web UI to manage models,
per-model app preferences, benchmarks, and a small homelab link dashboard.

> **Status:** personal project, published as-is. It orchestrates **external backends
> that are not bundled** (llama.cpp, MLX, model weights, voice models). Expect to install
> those and point the launchers at your own model directory before it does anything useful.

## What it does

- **Slot manager** — up to 4 concurrent model slots, each with a stable public port and a
  backend port, launched via per-runtime scripts in `bin/`.
- **OpenAI-compatible front door** — a small proxy (`src/slot-api-proxy.py`) so any client
  can talk to whichever model is loaded in a slot.
- **Web dashboard** (`public/`) — load/stop models, edit per-model defaults, watch logs and
  live metrics, run benchmarks, and keep a catalog of local service links.
- **Voice** — optional TTS/STT server integration.
- **Benchmarks** — a runner + quality-eval harness (results are machine-specific and not
  committed).

## Requirements

You provide the surrounding pieces:

- **Node.js 18+** and **PM2** (`pm2 start ecosystem.config.cjs`).
- **Model backends** on your `PATH` / in your model dir: `llama-server` (llama.cpp) for GGUF,
  and/or an MLX Python environment for MLX runtimes.
- **Model weights** (GGUF / safetensors) under your models directory.
- *(optional)* Python voice environments for the TTS/STT servers in `src/`.
- **better-sqlite3** compiles natively on `npm install` (needs a C++ toolchain).

## Setup

```bash
git clone <this-repo> llm3 && cd llm3
npm install

# Run directly…
npm start                     # dashboard on http://127.0.0.1:7075

# …or under PM2
pm2 start ecosystem.config.cjs
pm2 logs llm3 --lines 100
```

### Point it at your machine

Everything machine-specific — model directory, LAN addresses, SSH identity, host
labels — is read from the environment. Copy the template and edit it:

```bash
cp .env.example .env      # .env is git-ignored; nothing in it is ever committed
```

`src/local-env.js` loads that file at startup. A real environment variable always
wins over `.env`, so pm2 and launchd can still override any key. The defaults
committed to this repo are deliberately neutral (`127.0.0.1`, `$HOME/models`), so
a fresh clone runs locally and touches no remote host until you tell it to.

## Ports (default layout)

| Purpose | Port |
| --- | --- |
| Dashboard / control API | `7075` |
| Slot _N_ public endpoint | `8036 + (N-1)` |
| Slot _N_ GGUF backend | `18036 + (N-1)` |

Other backends (MLX, voice) use their own offsets — see the launcher scripts in `bin/`.

## State

Per-runtime state lives under `~/.local/state/<runtime>/` (`defaults.json`, `current.json`).
The link dashboard and per-model preferences are stored in a local SQLite DB (git-ignored).

## Configuration

All settings come from the environment or `.env`. See `.env.example` for the
machine-specific keys; the most useful ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7075` | Dashboard port |
| `HOST` | `0.0.0.0` | Bind address |
| `LLM3_AUTH_TOKEN` | *(empty)* | When set, non-loopback clients must present this token (bearer header, `X-LLM3-Token`, or `/?token=…` once for a cookie). The server logs a warning at boot if it binds a non-loopback address with no token. |
| `LLM3_SLOT_COUNT` | `4` | Number of model slots |
| `LLM3_MODELS_DIR` | `$HOME/models` | Where the launchers look for weights |
| `LLM3_LOCAL_LABEL` / `LLM3_REMOTE_LABEL` | `Local` / `Remote` | Machine names in the dashboard |
| `LLM3_REMOTE_HOST` | `127.0.0.1` | Optional second machine whose pm2 apps are listed |
| `LLM3_REMOTE_SSH_KEY` | `$HOME/.ssh/id_ed25519` | Key used to reach that machine |
| `LLM3_SSH_HOST_KEY_POLICY` | `accept-new` | `StrictHostKeyChecking` value for every ssh/scp the dashboard runs (`accept-new`, `yes`, or `no`) |
| `HERMES_SYNC_HOST` | `127.0.0.1` | Optional remote host for config sync |
| `GAMING_PC_HOME` | `C:\\Users\\User` | Windows profile for the optional agent-config sync |

### Keeping the repo publishable

`tests/no-personal-data.test.js` scans every tracked file for personal
identifiers, absolute home paths, credentials, and committed build artifacts. It
runs as part of `npm test`. If you add a machine-specific value, put it in `.env`
and give the code a neutral default rather than relaxing the test.

## Tests

```bash
npm test        # node:test suite
npm run check   # syntax gate over every JS file
npm run lint    # oxlint (zero config)
```

The same three commands run in CI (`.github/workflows/ci.yml`) on every push.
Architecture notes live in [`docs/`](./docs) and the agent notes in
[`AGENTS.md`](./AGENTS.md). The most recent maintenance pass, with what changed and
what is still open, is in
[`docs/IMPROVEMENT_PASS_2026-09.md`](./docs/IMPROVEMENT_PASS_2026-09.md).

## License

[MIT](./LICENSE) © 2026 omeriko9.
