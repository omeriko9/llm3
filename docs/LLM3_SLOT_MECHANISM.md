# llm3 slot and launcher mechanism

`llm3` is a dashboard plus control plane for up to 4 local model slots. The UI does not launch models directly. It sends launch/defaults requests to the Node server, and the server delegates slot lifecycle to runtime-specific launcher scripts in the home directory.

## End-to-end flow

1. `public/app.js` renders the slot cards, launch modal, defaults save flow, Hugging Face search tab, and profile management.
2. Launching or saving defaults calls `POST /api/start` or `POST /api/defaults`.
3. `src/server.js` parses the request, normalizes slot/model/runtime parameters, and chooses the correct launcher command for the selected runtime.
4. The selected launcher script:
   - resolves the slot-specific state directory and ports
   - loads persisted defaults from `defaults.json`
   - starts or stops the actual backend process
   - writes live runtime state to `current.json`
   - exposes `--status-json`, `--defaults-json`, `--set-defaults`, `--stop`, and usually `--list-json`
5. The UI refreshes status through `/api/status`, which is assembled from launcher status output and `llm3` dashboard config.

## Slot count and process bootstrap

`./bin/start_llm3.sh` is the outer bootstrap script for the dashboard service itself. It resolves environment in this order:

1. current shell environment
2. PM2 dump (`~/.pm2/dump.pm2`)
3. launchd plist
4. hardcoded defaults

The active installation is running under PM2, with `cwd=<repo root>`, `PORT=7075`, and `LLM3_SLOT_COUNT=4`.

Inside `src/server.js`, slot definitions are generated from `LLM3_SLOT_COUNT`, so the server treats slots 1-4 as data, not hardcoded one-off routes.

## Port model

`llm3` uses fixed slot-oriented port ranges:

| Purpose | Base |
| --- | --- |
| Public slot API | `8036` |
| GGUF backend | `18036` |
| MLX backend | `18136` |
| DFlash backend | `18236` |
| Rapid-MLX backend | `18336` |
| TurboQuant backend | `18436` |
| MTPLX backend | `18536` |

For slot `N`, the actual port is `base + (N - 1)`.

## State layers

There are three separate persistence layers, and they should not be confused:

1. `~/.local/state/llm3/dashboard-config.json`
   - dashboard settings
   - saved applications
   - profiles
   - runtime base-url overrides
2. `~/.local/state/<runtime>/.../defaults.json`
   - launcher defaults for that runtime and slot
   - used when the launch modal asks for defaults or the user saves new defaults
3. `~/.local/state/<runtime>/.../current.json`
   - live state for the currently running slot process
   - includes model identity, params, network ports, log files, and PIDs

This separation matters because a profile can say what should be launched, while a launcher still owns the concrete runtime defaults and the currently running process state.

## Launcher contract

The home-directory launchers follow the same control contract:

- `--list-json`
- `--defaults-json`
- `--set-defaults`
- `--status-json`
- `--stop`

That common contract is what lets `src/server.js` treat different runtimes uniformly even though the actual backends are completely different.

## Runtime launchers

### GGUF: `./bin/qwen_llama`

- launches `llama-server`
- owns the richest launcher logic
- already includes a built-in Python reverse proxy on the public slot port
- persists defaults/current state under `~/.local/state/qwen_llama/...`
- can inject request defaults before forwarding to the backend
- records `ctxSize` in launcher state as the requested per-parallel context value
- expands the backend `llama-server --ctx-size` to `ctxSize * parallel` when `parallel > 1`, and exposes that resolved value as `backendCtxSize`
- no longer applies launcher-policy rewrites like context clamping, forced `parallel=1`, or auto-enabling thinking
- fails explicitly when Tiny Grammar is requested for unsupported models instead of silently disabling it

### MLX: `./bin/run-qwen36-mlx-api.sh`

- launches `qwen36-mlx-api-proxy.py`
- that Python process fronts the MLX backend and exposes an OpenAI-compatible API
- persists defaults/current state under `~/.local/state/qwen36_mlx/...`
- now carries the shared sampling defaults through launcher defaults and request normalization

### Rapid-MLX: `./bin/run-qwen36-rapid-mlx-api.sh`

- launches `rapid-mlx serve`
- persists slot defaults/current state under `~/.local/state/qwen36_rapid_mlx/...`
- exposes the same launcher control surface, but backend startup is more direct than GGUF/MLX

### MTPLX: `./bin/run-qwen36-mtplx-api.sh`

- launches `mtplx quickstart`
- validates that the model actually contains runnable MTP weights before starting
- persists state under `~/.local/state/qwen36_mtplx/...`

### TurboQuant: `./bin/run-gpt-oss-turboquant-api.sh`

- launches `turboquant-serve`
- uses a separate backend port internally
- persists state under `~/.local/state/qwen36_turboquant/...`

### DFlash: `./bin/run-qwen36-dflash-api.sh`

- launches `qwen36-dflash-api.py`
- resolves target/draft bundle metadata from DFlash manifests
- persists state under `~/.local/state/qwen36_dflash/...`

### ds4 (DwarfStar): `./bin/run-ds4-api.sh`

- launches `ds4-server` from the `~/ds4-metal` build tree (a checkout of
  `ivanfioravanti/ds4-metal`, branch `qwen3.8-flash-next`)
- serves Qwen3.8-Flash-Next only, and NOT from an ordinary GGUF: ds4 loads one
  pack GGUF written by its own converter plus a mandatory external
  `*-PLE-*.gguf` n-gram table that stays SSD-backed instead of resident. The
  launcher finds the PLE next to the model, then in `~/ds4-metal/gguf`.
- `--chdir` into the build tree is required: ds4 compiles its Metal kernels at
  runtime from the `.metal` sources next to the binary
- binds the public slot port directly; the API is OpenAI-compatible
  (`/v1/chat/completions`, `/v1/responses`, `/v1/completions`, `/v1/messages`)
- persists state under `~/.local/state/ds4/...`
- MTP speculation is ON by default at draft depth 2. `--parallel > 1` becomes
  `ds4-server --batched-session`, and a batched session decodes WITHOUT MTP, so
  concurrency costs speed here; the launcher warns when both are asked for.
- thinking, temperature, top-p, top-k and min-p are per-request fields in ds4,
  not launch flags. The launcher records them for the slot card but does not
  pass them, and `supportsThinking` is false for this launcher so the UI does
  not offer a control that would do nothing.
- measured on the M4 Max (128 GB), IQ2 pack, 250-400 token completions:
  42 tok/s plain, 50-58 tok/s with MTP; prefill ~675-690 tok/s flat from 4K to
  32K, and decode flat across the same range

## Defaults resolution in the UI and server

- The launch modal reads defaults through `/api/defaults`.
- `src/server.js` resolves which launcher should answer defaults for a model/runtime combination.
- Profiles are stored in `dashboard-config.json`, not in launcher defaults.
- Applying a profile eventually becomes a normal launcher start request again.

One important detail in the current design: the frontend defaults lookup is keyed by runtime, and the backend explicitly collapses `rapid-mlx` to the base runtime when resolving defaults. That means some launcher defaults are intentionally shared by runtime family rather than by every launcher variant.

## Sampling parameters added to slot launch settings

The launch/settings flow now carries these sampling defaults:

- `temperature = 0.6`
- `top_p = 0.95`
- `top_k = 20`
- `min_p = 0.0`
- `presence_penalty = 0.0`
- `repetition_penalty = 1.0`

The UI exposes them in the settings modal, includes a reset-to-default button, and uses thinking-aware presence-penalty jumps:

- thinking on -> `presence_penalty = 0.0`
- thinking off -> `presence_penalty = 1.5`

These values are now wired through:

- frontend form state
- request payloads
- backend parsing/validation
- launcher defaults and current state
- GGUF and MLX request-shaping proxies

## Hugging Face tab highlighting

The Hugging Face search tab now adds stronger visual emphasis for recommended quantizations:

- **INT4** over **NVFP4**
- **AWQ**
- **AutoRound**

That highlighting is purely presentational. It does not alter launcher selection or model compatibility logic.

## Live system notes observed during investigation

- active project: the repository root
- active dashboard port: `7075`
- active slot count: `4`
- observed running slots:
  - `slot1`: GGUF on public `8036`, backend `18036`
  - `slot4`: GGUF on public `8039`, backend `18039`
  - `slot2` and `slot3`: idle during inspection

## Practical mental model

Think of `llm3` as three stacked layers:

1. **Dashboard/UI layer**: slot cards, settings modal, HF browsing, profiles
2. **Server orchestration layer**: request parsing, slot routing, launcher dispatch
3. **Launcher/runtime layer**: per-runtime scripts, processes, ports, logs, defaults, current state

If something looks wrong in the UI, check `public/app.js`. If a request shape or slot orchestration looks wrong, check `src/server.js`. If a model launches with the wrong port/defaults/runtime behavior, check the relevant home-directory launcher and its state under `~/.local/state/...`.
