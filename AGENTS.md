# llm3 — agent notes

PLEASE COMMIT TO GIT AND REFRESH PM2

> **PRIVATE DATA NEVER GOES INTO A COMMIT — NOT IN THE CODE, NOT IN THE MESSAGE.**
> This repository is public. A commit message is published with the history and
> cannot be taken back after a push. Do not write LAN addresses, host:port pairs,
> private URLs, usernames, email addresses, home paths, hostnames, or the owner's
> site and app names in a commit message or in a tracked file. Name the setting
> (`LLM3_HOME_STATUS_URL`), never its value. Before **every** commit, not only
> before a push: run `node --test tests/no-personal-data.test.js` and read the
> commit message for private data. If private data gets into a commit anyway,
> stop and tell the owner at once — do not fix it quietly and do not leave it
> for the owner to find.

> A benchmark run survives `pm2 restart llm3`: the runner starts detached and the
> session is persisted in `benchmarks/.session/session.json`, which the restarted
> server re-adopts. The scene queue behind a run is persisted too. Still check
> `/api/perf-dashboard/status` (or the Benchmarks tab's run strip) before a restart,
> because a restart mid-scene aborts that scene.

## Documentation map (read these first)

`llm3` is a dashboard + control plane for up to 4 local model slots, run under PM2
(`pm2 restart llm3 --update-env`; dashboard on port `7075`).

- [LLM3_SLOT_MECHANISM.md](docs/LLM3_SLOT_MECHANISM.md) — **architecture**: UI (`public/app.js`)
  → `src/server.js` → per-runtime launcher scripts in `bin/`; slot↔port model (public
  `8036+(N-1)`, GGUF backend `18036+(N-1)`, other backends offset per table); state layers
  under `~/.local/state/<runtime>/...` (`defaults.json`, `current.json`); launcher control
  contract (`--status-json/--defaults-json/--set-defaults/--stop/--list-json`).
- [OPTIQ_PROVIDER.md](docs/OPTIQ_PROVIDER.md) — the public "optiq" OpenAI-compatible provider and
  its `src/slot-api-proxy.py` front door.
- [SPEED_OPTIMIZATION_FINDINGS.md](docs/SPEED_OPTIMIZATION_FINDINGS.md) — benchmarked perf findings.
- [CHAT_TEMPLATE_AND_SAMPLING.md](docs/CHAT_TEMPLATE_AND_SAMPLING.md) — **what actually reaches the
  model**: GGUF embedded chat template vs the base-repo copy (HF download path), `/responses`
  agent traffic bypassing the slot's configured sampling, why "thinking off" makes reasoning
  *visible* instead of hiding it, and slot log retention. Read before debugging a "the model is
  broken" report — it carries a **retracted-claims table** of explanations that turned out wrong,
  and the "announces an action, then stops" agent stall is recorded there as still undiagnosed.
- [TTS_STT_FEATURE.md](docs/TTS_STT_FEATURE.md) — voice (TTS/STT) feature notes.
- [UI_FIXES.md](docs/UI_FIXES.md) — UI fix log.
- [benchmarks/SUMMARY.md](benchmarks/SUMMARY.md) — latest benchmark results.
- [docs/IMPROVEMENT_PASS_2026-09.md](docs/IMPROVEMENT_PASS_2026-09.md) — the September 2026
  review pass: what changed, what was verified, and the ranked list of what is still open.

## Decision calls and the mlx-dspark shim (read before an mlx-dspark update)

`POST /v1/decide` on every slot port returns one probability for each permitted answer
and generates no text ("local Jev"). podG depends on this contract. Full reference:
[docs/DECIDE_ENDPOINT.md](docs/DECIDE_ENDPOINT.md).

- It needs the logprobs of the first output token. `llama-server` has them. mlx-dspark
  drops them silently in the **dflash** mode (verified on 0.15.1 and 0.19.0).
- The answer is `src/mlx-dspark-shim.py`, **not** an edit in `site-packages`.
  `bin/run-mlx-dspark-api.sh` starts the server through it. It replaces three names in
  memory after a check of the package, and it changes nothing when the check fails
  (`incompatible`) or when upstream gains the function (`native`). The server starts in
  every state; `/v1/decide` then falls back to `method: "greedy"`.
- `LLM3_DSPARK_SHIM=0` in `.env` sets it to off.
- After any mlx-dspark update: read the `[llm3-shim]` line in the slot log, then run
  `curl 'http://127.0.0.1:8036/llm3/capabilities?probe=1'`. `"decide": "logprobs"` is the
  only proof that counts. The doc has the procedure for `native` (delete the shim) and
  for `incompatible` (the four names to find again).
- `tests/slot-decide.test.js` and `tests/mlx-dspark-shim.test.js` are the contract tests.

## Launcher helpers

The nine zsh launchers (`bin/run-*.sh`) source `bin/lib/launcher-common.zsh` for the helpers
they all need: `slot_index`, `parse_context_size`, `context_label`, `format_bytes`,
`wait_for_http URL [TIMEOUT] [curl args...]`, `spawn_detached LOG_FILE CMD...`, and the
eight-key `load_defaults`. Put a new shared helper there, not in one launcher. The bash
scripts (`bin/qwen_llama`, `bin/voice-*.sh`) keep their own copies because bash 3.2 and zsh
differ (`BASH_REMATCH` vs `match`, `${1:u}`, arrays). `tests/launcher-contract.test.js` runs
every launcher's `--status-json` / `--defaults-json` / `--list-json` under a temp HOME; run it
after any launcher change.

## Public-slot HTTP proxy (important, non-obvious)

Each GGUF slot's public port is fronted by a small Python `http.server` reverse proxy, **not**
by `llama-server` directly. There is ONE copy: **`src/slot-api-proxy.py`**. Both launchers run
it as a file:

1. **`bin/qwen_llama` → `start_proxy()`** runs `python3 -u src/slot-api-proxy.py` and configures
   it through `QWEN_PROXY_*` environment variables (argparse defaults read them). **This is the
   live proxy on the public slot ports (8036–8039).**
2. **`bin/run-optiq-api.sh`** runs the same file with flags and adds `--advertised-model-id` /
   `--backend-model-id` (model-id remapping for `/v1/models` and generation requests) and
   `--context-size` (answers `/props` locally). With those flags absent the proxy passes
   `/v1/models` and `/props` straight through.

`tests/slot-api-proxy.test.js` is the contract test: it runs the proxy against a stub backend
with undici as the client, in both configuration modes. Run it after any proxy change.

The proxy forwards `/v1/*` to the backend `llama-server` and injects sampling defaults. It MUST
emit RFC-compliant HTTP or strict clients (Node `undici`/`fetch`, used by the `pi` coding agent)
reject it with `400 (no body)` while `curl` tolerates it:

- exactly one `Server` header (skip the upstream `Server`/`Date`; `send_response` adds them);
- never forward empty-valued or hop-by-hop headers; set `Access-Control-Allow-Origin: *` explicitly;
- stream SSE with `Transfer-Encoding: chunked` (flush per chunk); send a single correct
  `Content-Length` for non-streamed responses — never both, never HTTP/1.0 close-delimited;
- when forwarding the **request**, strip the inbound `Content-Length` *case-insensitively*
  before setting your own — undici sends lowercase `content-length`, and a case-duplicate key
  forwards two conflicting `Content-Length` lines, which makes `llama-server` 400 instantly.

To apply a proxy fix without reloading the model: kill the slot's proxy PID
(`~/.local/state/qwen_llama/slotN/llama-proxy.pid`), relaunch `src/slot-api-proxy.py` with the
same `QWEN_PROXY_*` env (the backend on `18036+(N-1)` stays warm), then update `llama-proxy.pid`
and `current.json`'s `pids.proxy`. `qwen_llama` has no proxy-only restart mode; a normal start
reloads the model.

When adding a new model, use this checklist so it is fully supported in llm3:

- Identify the exact model repo, files, required runtime or fork, and recommended launch flags from the model card or upstream docs.
- Download model files under the normal llm3 model roots, preferably `~/models/hf/<owner>__<repo>/`, including companion files such as `mmproj*.gguf`, tokenizer files, templates, or sidecars.
- Add or verify `.llm3-hf.json` metadata with `repoId`, `hfUrl`, `label`, `family`, `runtime`, `quantization`, aliases, vision flag, and any chat template metadata needed for discovery.
- If the model needs a non-default runtime, put that runtime under the llm3 folder, add a dedicated launcher script in `bin/`, keep its state/logs separate, and wire it into `src/server.js` for start, stop, status, defaults, slot logs, and overview defaults.
- Make the UI expose the launcher choice end to end: launch modal selector, saved model defaults, preferred launcher persistence, profile slot selector, profile save, and profile apply.
- Encode model-to-launcher compatibility explicitly. Do not expose a launcher in model settings, profiles, or benchmarks unless that exact model/launcher combination is expected to load correctly and be performance-relevant on the local hardware.
- For launcher-specific forks, verify whether GPU/Metal/CUDA offload actually works locally; if it falls back to CPU or crashes, keep it out of the default launcher matrix until fixed or gate it behind an explicit experimental flag.
- Match upstream performance claims to the same hardware/backend before marking a model as performance-supported. If a model card or post shows CUDA/RTX numbers, do not present that as Apple/Metal support without a local accelerated smoke test.
- Smoke test the upstream recommended acceleration flags directly with the launcher binary, not only through llm3. Capture whether the backend is CPU, Metal, CUDA, or another accelerator before enabling benchmark rows.
- Ensure launcher-specific defaults are used when the launcher changes and when the model modal or profile editor is reopened.
- When adding a launcher variant, verify it is saved with model settings, included in saved profiles, restored on profile apply, and represented in `/api/models`/`/api/overview` launchers and `preferredLauncher`.
- Update the benchmark runner so every compatible model is evaluated against every compatible launcher; the benchmark table must include launcher identity while keeping row colors grouped by model label.
- Confirm `/api/models` or `/api/overview` shows the model with the expected runtime, aliases, path, size, vision support, launcher list, and preferred launcher when saved.
- Smoke test the launcher with the actual model using `/v1/models` and `/v1/chat/completions`; include a small-context test when the model is large.
- If GPU/Metal/CUDA behavior differs from upstream recommendations, encode conservative local defaults in the launcher and document the reason in the final response.
- Run `npm run check`; run focused tests when relevant. If full tests fail for unrelated existing reasons, capture the exact failure.
- Commit only the intended repo changes. Do not commit downloaded model weights or cloned/build vendor trees unless explicitly intended; add local vendor/model paths to `.gitignore` when needed.
- Refresh PM2 with `pm2 restart llm3 --update-env` and `pm2 save`, then verify the live service can see the model and launcher choice.

## One repository, one remote

This repo is public on GitHub and there is **no separate private mirror**. The
old two-origin split (a private LAN remote plus a scrubbed public export) is
gone, along with `export-public.sh` and `public-overlay/`.

```bash
git add -A && git commit -m "..." && git push
```

That is the whole workflow. It works because the source carries no personal
data in the first place, rather than because a scrub step removes it on the way
out.

### The rule that keeps it that way

**Nothing machine-specific goes in a tracked file.** Every LAN address, SSH
identity, host label, and model directory is read from the environment with a
neutral default:

```js
const HERMES_SYNC_HOST = process.env.HERMES_SYNC_HOST || "127.0.0.1";
```

Real values live in `.env` at the repo root, which is git-ignored and loaded at
startup by `src/local-env.js`. A real environment variable always beats `.env`,
so pm2 and launchd can still override anything. `.env.example` documents every
key; add new keys to both.

`tests/no-personal-data.test.js` enforces this: it scans every tracked file for
personal markers, credentials, and committed build artifacts, and fails the
suite if any appear. Run it before every commit, and `npm test` before pushing.

**Commit messages are covered by the same rule.** The test scans files, not
messages, so the message is the author's job: describe what changed and which
setting controls it, never the machine value that the setting holds. A value
the owner gives for their own machine goes into `.env`, with an empty or
neutral default in the code and a line in `.env.example`.
`scripts/pre-push-guard.sh` (linked as `.git/hooks/pre-push`) also scans the
added lines and the messages of every outgoing commit, but it is the last
guard, not the check to rely on.

**Private LAN addresses are refused at commit time.** `tests/no-lan-addresses.test.js`
fails if the private /16 LAN prefix appears anywhere in a staged or tracked file —
code, comments and docs included (code that must recognise the range compares
octets; see `isPrivateLan16Host`). Two hooks enforce it before a commit exists:

```bash
ln -sf ../../scripts/pre-commit-guard.sh .git/hooks/pre-commit   # staged files: LAN prefix + personal data
ln -sf ../../scripts/commit-msg-guard.sh .git/hooks/commit-msg   # the commit message
ln -sf ../../scripts/pre-push-guard.sh   .git/hooks/pre-push     # outgoing history
```

Hooks are not versioned: link all three in every new clone. Never bypass them
with `--no-verify`.

### Where the old history went

The pre-publication history (233 commits, including `node_modules`, benchmark
results, LAN config, and a live API key) is archived at
`~/llm3-archive/llm3-history-20260902.git`. It has **no remotes on purpose** and
must never be pushed. To read something out of it:

```bash
git -C ~/llm3-archive/llm3-history-20260902.git show <branch>:<path>
```
