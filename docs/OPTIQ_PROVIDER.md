# OptIQ Provider

`llm3` now supports Gemma MTPLX pair bundles through an `optiq` launcher.

## What It Is

The OptIQ provider is an Apple Silicon MLX runtime path for pair-bundle speculative decoding models that ship as:

- `mtplx_pair.json`
- `target/`
- `assistant/`

The current supported local bundle is:

- `Youssofal/Gemma4-MTPLX-Optimized-Quality`

## Runtime Pieces

- Launcher: [bin/run-optiq-api.sh](bin/run-optiq-api.sh)
- Proxy: [src/slot-api-proxy.py](src/slot-api-proxy.py)
- Integration: [src/server.js](src/server.js)
- Runtime venv: `~/.venvs/mlx-optiq`
- Runtime state: `~/.local/state/optiq_api/`

## How `llm3` Detects Models

`run-optiq-api.sh --list-json` scans local model directories for pair bundles that contain:

- `mtplx_pair.json`
- `target/config.json`
- `assistant/config.json`

Each detected model is exposed to `llm3` with:

- `runtime: "mlx"`
- `launcher: "optiq"`
- `sizeBytes`
- `sizeLabel`
- `hfUrl`
- `aliases`

## How Serving Works

Each slot uses two ports:

- Public slot API: normal `llm3` slot port (`8036 + slotIndex - 1`)
- Hidden OptIQ backend: `18836 + slotIndex - 1`

The launcher starts:

1. `optiq serve` on the hidden backend port with:
   - `--model <bundle>/target`
   - `--drafter <bundle>/assistant`
2. `slot-api-proxy.py` on the normal public slot port

The proxy does three important things:

- normalizes OpenAI-compatible sampling defaults
- extracts visible reasoning when the model emits `reasoning_content`, `reasoning`, or `<think>...</think>`
- rewrites `/v1/models` so the slot advertises the bundle runtime ID instead of unrelated backend model IDs

## PodG / Hermes Sync

When the `podG` checkbox is enabled in `llm3`, the target profile is:

- `~/.hermes-podg/config.yaml`

The flow is:

1. `llm3` launches the selected slot model
2. `llm3` syncs the live slot endpoint and model ID into `~/.hermes-podg/config.yaml`
3. `podG` copies that profile into a temporary per-run Hermes home

Important detail:

- OptIQ backends may expose extra model IDs from the MLX environment
- `llm3` now prefers the configured pair-bundle runtime ID for sync, and the proxy advertises only that model ID on `/v1/models`

## Logs

Per-slot OptIQ logs live under:

- `~/.local/state/optiq_api/<slot>/proxy.log`
- `~/.local/state/optiq_api/<slot>/traffic.log`
- `~/.local/state/optiq_api/<slot>/optiq-server.log`

The launcher truncates `proxy.log` and `traffic.log` at startup so old failures do not pollute new sessions.

## Known Limits

- Thinking visibility depends on the model actually emitting reasoning tokens or `<think>` blocks
- The OptIQ runtime does not guarantee that every prompt produces exposed reasoning text
- Large Gemma bundles are close to the Metal memory limit on this machine, so the launcher uses conservative cache and prefill settings

## Current Tuning

The launcher currently uses:

- `--decode-concurrency 1`
- `--prompt-concurrency 1`
- `--prefill-step-size 256`
- `--prompt-cache-bytes 536870912`

These settings were chosen to keep the 31B quality bundle stable on Apple Silicon instead of chasing peak throughput.
