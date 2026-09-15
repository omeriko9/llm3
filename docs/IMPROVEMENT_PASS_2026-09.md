# Improvement pass, September 2026

A bird's-eye review of llm3, followed by a systematic pass through its findings, and then
a second pass over the Benchmarks tab alone. This file records every change, how it was
verified, and what is still open, so a later session can continue from the list instead of
reviewing the repository again.

**Scope of the pass:** 28 commits on `main` starting at `4818b52`. Tests went from 198 to
263 Node tests plus 28 Python tests, and the suite runs in about 11 s instead of 22 s. The
Benchmarks tab was reviewed and reworked in a second pass, recorded in Part 2.

**How the review was done:** five parallel read-only reviews of `src/server.js`, the
frontend in `public/`, the launchers in `bin/`, the Python voice and proxy servers, and
repository hygiene; then three more of the Benchmarks tab UI, its backend, and its
methodology. Every finding below is one a review produced with file and line evidence.

---

# Part 1 — Repository-wide pass

## 1.1 A fresh clone did not run, and the dashboard was unauthenticated

| Finding | Fix | Commit |
| --- | --- | --- |
| `src/server.js` required `js-yaml`, which `package.json` did not list. It resolved only through a copy outside the repository, so a fresh clone failed at start. | Declared as a dependency. | `f38903f` |
| `public/index.html` loads KaTeX, markdown-it, and markdown-it-texmath from `/vendor/`, but `public/vendor/` is git-ignored and nothing produced it. A fresh clone rendered the dashboard with no markdown and no maths. | The three libraries are devDependencies; `scripts/sync-vendor.js` copies the browser bundles on `postinstall` (also `npm run vendor`). | `fc05814` |
| The control API binds `0.0.0.0` by default with no authentication. Any client on the network could start, stop, and delete models, and restart pm2 apps. | Optional `LLM3_AUTH_TOKEN` in `src/dashboard-auth.js`. A non-loopback client must send it as `Authorization: Bearer`, `X-LLM3-Token`, or a cookie set once by opening `/?token=<value>`. Loopback always passes. `/api/pm2/control` keeps its own allowlist and stays exempt. With no token on a non-loopback bind the server logs one warning at boot rather than failing. | `bb74c4a` |
| `/api/voice/benchmark/audio/:runId/:fileName` reduced `fileName` to a basename but joined `runId` as given. Express decodes params, so `..%2F` read files outside the runs directory. | Both params reduce to one segment and the joined path must stay under the runs root. Two voice preview routes swapped a string-prefix check for `isPathWithin`. | `bb55b6a` |
| Website names, categories, and every `href` in the Websites card view, table view, and the Hugging Face links went into `innerHTML` unescaped. A name saved through the dashboard could inject markup or a `javascript:` link. | `esc()` on all text, and a new `safeHref()` that admits only http(s), root-relative, and fragment URLs. `tests/frontend-helpers.test.js` covers both. | `bc323dc` |
| Every ssh and scp call passed `StrictHostKeyChecking=no`; three also discarded `known_hosts`. The remote password sat inside an `expect` script on the command line, where `ps` could read it. | One `sshHostKeyArgs()` helper applies `LLM3_SSH_HOST_KEY_POLICY` (default `accept-new`). The password travels in the environment. Remote pm2 arguments go through `shellQuote`. | `f2e05d5` |
| `.env.example` documented 14 of about 130 keys the Node side reads. `ecosystem.config.cjs` pinned `/opt/homebrew/bin/node` and re-derived defaults `src/server.js` already applies. | The template documents every key, grouped by integration, optional ones commented out. The publication guard checks every prefixed key against it. `src/local-env.js` skips an empty value, so a blank placeholder cannot switch an `*_ENABLED` flag on. The pm2 config is 30 lines. | `4b6f2c9` |

## 1.2 Duplicated code

| Finding | Fix | Commit |
| --- | --- | --- |
| The public-slot HTTP proxy existed twice: a 512-line bash heredoc inside `bin/qwen_llama` and the standalone `src/slot-api-proxy.py`. They had drifted 355 lines apart, and each had features the other lacked (reasoning stripping and a 200k capture limit on one side; model-id remapping, a `/props` shim, and a backend key on the other). | `src/slot-api-proxy.py` carries both feature sets. Its argparse defaults read the `QWEN_PROXY_*` environment, so `qwen_llama` keeps its contract and simply runs the file. Removing the heredoc also removed the bash 3.2 apostrophe hazard the agent notes warned about. `tests/slot-api-proxy.test.js` drives both modes against a stub backend with undici as the client. | `9b90546` |
| The eight zsh launchers each carried their own `slot_index`, `parse_context_size`, `context_label`, `format_bytes`, `wait_for_http`, `load_defaults`, and an inline Python `Popen` daemonizer. The copies had drifted into four `wait_for_http` variants and three `parse_context_size` variants. | `bin/lib/launcher-common.zsh` holds one version of each; every zsh launcher sources it. `wait_for_http` takes extra curl arguments so the two launchers needing auth headers pass them at the call site. Net: -771 lines in the launchers, +180 in the library. | `1b7c626` |
| Nothing verified the launcher control contract (`--slot slotN --status-json`, `--defaults-json`, `--list-json`) across the 13 scripts, although the dashboard calls every one of them the same way and polls before any runtime is installed. | `tests/launcher-contract.test.js` runs each launcher under a temporary HOME with no models and no venv. | `a3905a7` |
| kokoro, omnivoice, vibevoice, and the STT server ran Flask in threaded mode with no lock around the model (two concurrent requests crash on MPS), a lazy-load race, a `/health` that answered `ok` before any model existed, and no request size limit. | `src/llm3_voice_common.py` provides `ModelLoader` (load once under a lock, background preload from `main()`, `503 loading` until ready, `500` on a load error), `INFERENCE_LOCK`, a `MAX_CONTENT_LENGTH` cap, and a text length check. Its self-test runs from `tests/voice-common.test.js` on the system Python. | `4fcdc48` |
| 68 routes repeated the same 409 guard and try/catch shape. | A `requireIdle` middleware on the nine mutex routes, plus a JSON error handler closing the chain. | `2118710` |

### Bugs the new launcher test found

The contract test was written to lock in existing behaviour and immediately failed on three
real defects, all fixed in `a3905a7`:

1. `run-gpt-oss-turboquant-api.sh`, `run-qwen36-dflash-api.sh`, and `run-qwen36-mlx-api.sh`
   refused **every** mode when the Python venv was missing, including status and defaults,
   which the dashboard polls before anything is installed. The gate now applies to a start only.
2. `run-gpt-oss-turboquant-api.sh` is a zsh script that read `BASH_REMATCH` in
   `parse_context_size`, so `--defaults-json` and any `K`/`M` context suffix failed with
   "parameter not set". It uses zsh's `match` array now.
3. `voice-tts.sh` required a model before it answered `--status-json`, so on a machine with
   no saved default the dashboard's status probe got a usage error instead of `running: false`.

## 1.3 Control-plane server

| Finding | Fix | Commit |
| --- | --- | --- |
| 17 writers of `dashboard-config.json` each did a plain read-modify-write with a non-atomic `fs.writeFile`. Two concurrent requests lost one update, and a crash mid-write left a truncated file. | One promise-chained critical section, temp-file-plus-rename, and `updateDashboardConfig(mutator)` holding the lock across the whole update (12 sites converted). A test fires 25 concurrent updates and asserts all survive. | `2118710` |
| `app.get("/api/overview")` was registered twice; Express served the first, so the second was unreachable. | Removed. | `2118710` |
| No `unhandledRejection` or `uncaughtException` handler: a background task that threw took the whole control plane down. pm2 discovery ran at `require` time, so it fired inside tests. | Both handlers log and keep serving. Discovery starts from `startServer()`. | `2118710` |
| Eleven `fetch` calls to Hugging Face and voice runtimes had no timeout. | `AbortSignal.timeout` (60 s general, 10 s probe, 10 min synthesis). | `2118710` |
| A rejected async route handler produced Express's HTML stack trace, and an unknown `/api` path produced its HTML 404, while the dashboard expects JSON. | A JSON error handler and a JSON `/api` 404. | `2118710`, `3e9e5ef` |

## 1.4 Dashboard frontend

| Finding | Fix | Commit |
| --- | --- | --- |
| Nine polling intervals ran forever, including in a background tab, at four requests per tick. | One `POLLERS` table with a `document.hidden` guard and a catch-up refresh when the tab returns. | `3e9e5ef` |
| `renderLogs` rebuilt the entire traffic list through `innerHTML` every 2.5 s. | It compares the rendered HTML first and skips the DOM work when no entry arrived. | `3e9e5ef` |
| Eleven inline `onclick` strings in the Websites and pm2 markup forced their handlers to be globals, which blocks any move to ES modules. | `data-website-action` attributes with one delegated listener per container. | `3e9e5ef` |
| The launch modal's context-size preset chips had two delegated handlers, but both read `data-preset` while the chip carries `data-modal-preset`. Only the inline `onclick` actually worked. | Both handlers read the right attribute; the inline handler is gone. | `3e9e5ef` |

## 1.5 Tooling, tests, documentation

| Finding | Fix | Commit |
| --- | --- | --- |
| `npm test` took 22 s because `bin/qwen_llama` polls with `sleep 1` and two test files drive the real launcher. | `QWEN_LLAMA_POLL_SECONDS` (default 1; tests pass 0.05). The suite runs in 11 s. | `bc4fbcb` |
| 14 functions were unreferenced. | Removed: 7 in `src/server.js`, 6 in `public/app.js`, 1 in `public/benchmarks-tab.js`. | `bc4fbcb` |
| `npm run check` covered 4 of 29 JS files. No linter, no CI, no Node version pin. | `scripts/check-syntax.js` over every JS file, `oxlint` as `npm run lint` (its first run found a duplicate `parseLauncherRequestBody` export key), `engines`, `.nvmrc`, `.editorconfig`, and `.github/workflows/ci.yml` running check, lint, and test on macOS. | `4a9abea` |
| Seven documents were git-ignored, `AGENTS.md` among them, so a clone had no architecture notes. | Six moved into `docs/` and are tracked; `AGENTS.md` is tracked at the root. They carried no personal data, and the publication guard now scans them. | `4a9abea` |

---

# Part 2 — Benchmarks tab pass

## 2.1 Backend and run lifecycle

| Finding | Fix | Commit |
| --- | --- | --- |
| The runner was an attached child with piped stdio, so `pm2 restart llm3` killed a run hours in. This was the standing warning at the top of `AGENTS.md`. | The runner starts detached in its own session, output in `benchmarks/.session/runner.log`, session (pid, args, models, queued scenes) persisted to `session.json`. `getBenchmarkStatus()` re-adopts a live run when the in-memory session is gone and reports `adopted: true`; a dead pid becomes `lastRun`. The log tail is read from the file, so the run strip shows runner output across a restart. | `939c85f` |
| Two `POST /start` in the same window both spawned a runner, because the guard awaits `ps` and model discovery before the session is assigned. | A synchronous `startInFlight` flag. | `939c85f` |
| Every status poll ran `ps -axo` over all processes and re-parsed every `benchmark.json` (8.2 MB today), growing with each row. | `ps` runs only when this process owns no live run; result files are cached by mtime and size. | `939c85f` |
| A `SIGKILL` (or power loss) left a row that read `running` forever, because the state is derived from missing stages. | A row with missing stages and no live runner reads `interrupted`, and the tab shows a badge with an explanation. | `939c85f`, `895ba01` |
| The `ps` scan matched any `benchmark_runner.py` anywhere on the machine, so a runner belonging to another checkout (or to a test) was reported as this dashboard's run and blocked starting one. Found when a real run on the machine made the new session tests fail. | A candidate's working directory must match this instance's benchmark root; when the directory cannot be resolved the process is kept, so a real external run is never missed. A regression test starts a runner in a second benchmark root and asserts it is not adopted. | `944e55e` |

## 2.2 Measurement methodology

| Finding | Fix | Commit |
| --- | --- | --- |
| Every speed number was a single request with no repetition and no variance, although the project's own findings document measured ±10 % run-to-run noise. | `--throughput-repeats` (default 3, threaded through the dashboard). `tokensPerSecond` is now the **median** sample; every sample plus the min, max, and spread percentage are stored beside it. Repeats send `cache_prompt: false` so they measure decode, not a cached prefix. A failure after at least one sample still yields a partial row with its samples. | `15b79be` |
| Prompt-processing speed was never measured; only decode and TTFT on a two-token prompt. | A probe after the throughput stage: a fixed ~8,000-character passage with a one-token answer on a cold cache, timed as a round trip, giving prompt tokens per second from the response's `usage`. Best effort, recorded on the throughput field, never fatal to the row. | `15b79be`, `35d03e3` |
| No request carried a seed, and the agentic step ran at temperature 0.3, so its tool-call verdict changed between runs of the same model. | A fixed seed on every request; the agentic step runs at temperature 0. The full sampling profile is recorded in `launchConfig.sampling`. | `15b79be` |
| Rows recorded the runner's own hash but no schema version, no hardware, no engine build, and no machine load, so two results were not comparable after a hardware or backend change. | `schemaVersion: 2`, a `host` block (chip, memory, OS version, CPU count, deliberately no hostname), `environment.loadAverage` captured when the model starts, and `engine` from the backend's `/props` when it answers. | `15b79be` |
| The `SUMMARY.md` legend described weights ("MMLU 30 %, DeepEval 25 %, GSM8K 20 %…") replaced months earlier by MMLU-Pro 30 %, MATH-500 25 %, HumanEval 25 %. | The legend is generated from `QUALITY_OVERALL_WEIGHTS`, so it cannot drift again. | `15b79be` |
| The decode rate came from a prompt a no-think model answers in about 90 tokens, mixing decode speed with answer length and giving windows of a few seconds. | A fixed-length decode probe asks every model for exactly 512 tokens with `ignore_eos` on a short prompt and times the generation window. Verified on a 9B GGUF model: 512 tokens, `finishReason: length`, a 7.3 s window at 70.3 tok/s, against a scenario measurement over 3 s whose two samples differed by 23.7 %. | `7939bc0` |
| The first generation after a model load pays for cold caches and lazy allocation, and that cost landed on sample one. | A warm-up generation runs first and is discarded (`--throughput-warmup`, default 1). | `7939bc0` |
| `buildRunnerArgs` fell back to 60 questions per quality metric while the runner, the run-time estimator, and the launcher UI all assumed 200, so a launch that did not name a limit ran a quarter of the questions the estimate covered, at roughly twice the interval. | One `DEFAULT_QUALITY_LIMIT` feeds all three. A test reads the runner's own default out of the Python source and asserts they agree. | `7939bc0` |
| Scene runs inherited whatever sampling the active profile held for the slot, so a model measured under one profile was scored against a model measured under another, and a re-run could differ from itself. | Scene sampling is pinned and recorded on the result. Not at temperature 0: greedy decoding walked Qwen3.8-9B into a repetition loop that emitted `OCEAN_819: '#00ffff', ...` for 37 kB and never closed the document, which a smoke run caught. A benchmark needs every model on the *same* settings, not the lowest, so the profile is ordinary sampling with a light repetition penalty, overridable with `LLM3_SCENE_TEMPERATURE`. | `168ee9c` |
| A dashboard restart during the scene phase dropped the scene in flight. | The in-flight scene is persisted alongside the queue and goes back to the front on adoption; an ended session with scenes still queued resumes them. A cancelled queue stays cancelled. | `168ee9c` |
| `benchmarks/PLAN.md` diverged from the runner on context size, throughput settings, and the whole quality suite. | A status banner at the top lists each divergence and names the code as the source of truth. | `35d03e3` |

## 2.3 Repository and tests

| Finding | Fix | Commit |
| --- | --- | --- |
| The entire `benchmarks/` directory was git-ignored, including `benchmark_runner.py`, which the Benchmarks tab spawns. The tab was therefore dead in any fresh clone. | The harness is tracked: `benchmarks/*.py`, `PLAN.md`, `requirements.txt`, and the translation passages. Results, saved results, voxel results, `SUMMARY.md`, and `.session` stay ignored, and the publication guard forbids exactly those paths instead of the whole directory. | `15b79be` |
| The 26 route tests covered the scoring math only. Nothing tested the run lifecycle, and no Python test ran from `npm test`. | `tests/perf-dashboard-session.test.js` drives a fake runner through start, double start, cancel, module reload with re-adoption, concurrent starts, and the interrupted classification. `benchmarks/test_benchmark_runner.py` covers the decode-window math, median selection, aggregation shape, provenance, the generated legend, and the maths scoring helpers. `npm test` now runs `npm run test:py` as well. | `939c85f`, `15b79be` |

## 2.4 Tab UI

| Finding | Fix | Commit |
| --- | --- | --- |
| The panel tabs, the six detail panels, and the scene gallery were rebuilt through `innerHTML` on every poll (2 s during a run), so every gallery iframe reloaded and restarted its animation each tick. | A `setHtmlIfChanged()` writer keyed on the host element; the gallery rebuilds its tiles only when the tile list changes. The table's signature moved out of a DOM data attribute, where it had doubled the whole markup string into the DOM. | `895ba01` |
| Switching slots had no request token, so a slow `/results` response for the previous slot could land on top of the new one, and the old rows sat under the new label meanwhile. | A sequence number on `refresh()`; a slot change clears the rows immediately. | `895ba01` |
| Idle polling re-ran model discovery every 10 s, because `/results` performs it. | The poller fetches `/results` only while a run is active, when a run has just ended, or when the slot changed. User actions still refresh everything. | `895ba01` |
| The tooltip and detail renderers called `.toFixed()` and `.map()` on fields a partial payload may not carry, and printed `NaN` for a missing score. | Every number goes through the existing `num()` guard, arrays default, and a score with no confidence interval shows `±?` with an explanation. | `895ba01` |
| The row context menu, which holds the view switch, both filters, compare-only, and row deletion, was reachable only by right-click or long-press. | It takes focus on open, supports Arrow keys, Home, and End, and returns focus where it came from. | `895ba01` |
| Errors used `window.alert` although the host page has a toast. | A `notify()` helper prefers the host's `toast()`. | `895ba01` |
| Three helpers (`sceneCell`, an older `statusBadge`, an older `sortArrow`) were shadowed by later definitions, and the dead `sortArrow` still held the older sort logic. | Removed. | `895ba01` |
| The new spread, prompt-processing rate, and host metadata had no way to reach the screen. | Rows carry `decodeRepeats`, `decodeSpreadPct`, `decodeMin`/`Max`, `promptTps`, `promptTokens`, `tokenCountMethod`, and `schemaVersion`; the payload carries the newest row's host. The speed cells show the decode median with its spread and the prompt-processing rate on hover, mark an estimated token count, and the toolbar prints the chip, memory, and OS version. | `35d03e3` |
| The layout switch, both filters, and compare-only lived only on the right-click context menu, which a touch screen never reaches; the CSS for a chip row had been written but never used. | A visible filter bar, with the active state carrying a border and weight rather than colour alone, and a Clear filters chip. The context menu still sets the same state. | `0b0a175` |
| The search matched the model name only, so a launcher or a quantization could not be filtered at all. | Every word is matched against the model, launcher, runtime, variant, size, and status together, so "mlx q8" narrows to a quantization on a runtime. | `0b0a175` |
| Four rules in `benchmarks-tab.css` were dead. | Removed; that stylesheet audits clean. | `a102ac6` |

---

## 2.5 Verification tooling this pass added

Nothing executed the frontend and nothing checked CSS, so both were verified by reading.

| Tool | What it does |
| --- | --- |
| `npm run render-check` (`scripts/render-check.js`) | Loads the live dashboard in headless Chrome, asserts the markers each part of the render chain emits, and reports page script errors. Skips cleanly when Chrome or the dashboard is absent. |
| `npm run css-audit` (`scripts/css-audit.js`) | Reports class selectors no source mentions. Strips comments and string literals first, honours template-literal prefixes such as `bm-tier-${x}`, and knows the classes KaTeX writes at run time, so it does not report `.w3`, `.org`, or `.katex-display` as dead. |
| `python3 benchmarks/check_use_before_assign.py` | Now walks one scope at a time instead of using `ast.walk`, which descended into comprehension scopes and reported every comprehension in the file: 20 false positives, which is why it gated nothing. 15 self-test cases, zero findings across the repository, still catches the bug it was written for. It runs in `npm run lint`. |

# New files

| File | Purpose |
| --- | --- |
| `src/dashboard-auth.js` | The optional access-token middleware. |
| `src/llm3_voice_common.py` | `ModelLoader`, inference lock, and size caps shared by the voice servers. |
| `bin/lib/launcher-common.zsh` | The helpers shared by the eight zsh launchers. |
| `scripts/sync-vendor.js` | Copies the browser bundles into `public/vendor` on install. |
| `scripts/check-syntax.js` | `node --check` over every JavaScript file. |
| `benchmarks/test_benchmark_runner.py` | Pure-function tests for the runner. |
| `tests/dashboard-auth.test.js` | Token, cookie, redirect, and exemption behaviour. |
| `tests/frontend-helpers.test.js` | `esc()` and `safeHref()` lifted out of `public/app.js`. |
| `tests/launcher-contract.test.js` | The control contract of all 13 launchers. |
| `tests/slot-api-proxy.test.js` | The proxy in both configuration modes. |
| `tests/voice-common.test.js` | Runs the Python self-test and checks each server imports the guards. |
| `tests/perf-dashboard-session.test.js` | The benchmark run lifecycle against a fake runner. |
| `.github/workflows/ci.yml`, `.nvmrc`, `.editorconfig` | The toolchain. |
| `docs/*.md` | The six architecture and investigation notes, previously git-ignored. |

# Verification record

Everything below was run on the live machine, not only in tests.

- **A real model start through the dashboard.** A 4-bit MLX model on slot 4 via the
  `mlx-dspark` launcher went through the refactored launcher, the shared daemonizer, and the
  proxy, and returned a chat completion. The slot was stopped afterwards and left clean.
- **Two real benchmark runs.** A 9B GGUF model on slot 4 into a scratch results directory.
  All five stages ran, the row carried schema 2 metadata (chip, load average, engine build
  `b1638-3173a5647`), the throughput stage produced two samples with a 0.8 % spread, the
  seeded agentic step passed, and the prompt-processing probe measured 1,674 tokens in 2.4 s.
  The first run exposed a real defect in the probe (a streamed one-token request tripped a
  stream-read error), which was fixed and re-verified.
- **Live endpoints after each pm2 restart:** `/api/overview` 200, the vendor assets 200, a
  malformed body answering JSON, an unknown `/api` path answering a JSON 404, and the
  results payload carrying the new `perf` fields.
- **Every `pm2 restart llm3`** was preceded by a check of `/api/perf-dashboard/status`.
- **Test count:** 198 Node tests before; 257 Node plus 25 Python after, all passing.

---

# What is still open

Ranked by value, with the evidence behind each and a rough size. Nothing here is started.

## Large

**1. Split `src/server.js`.** 17,378 lines, 73 routes, 581 top-level functions, and at least
nine domains in one file. All routes end by line 5,400; the remaining 12,000 lines are
helpers. Proposed boundaries, each exporting `register(app, deps)`: `config/env.js`,
`websites/`, `slots/`, `hf/`, `sync/{hermes,gaming-pc,librechat,apps}.js`, `voice/`,
`profiles.js`, `dashboard-config.js`, `chat-proxy.js`, `benchmarks.js`, and
`lib/{exec,json-store,http-errors}.js`. Related: 77 `sync*AfterLaunch` / `AfterStop` sites
repeat one guard triple (enabled, has-auth, build-error); a `withRemoteTarget(target, fn)`
wrapper removes most of that block.

**2. A real TTS base module.** The pass shared the lock, the size cap, and the health state,
but the five voice servers still duplicate the HTTP layer: `pick_device` in 5 files,
`transcode_audio` and `has_hebrew_diacritics` in 4 each, `adjust_wav_speed` in 2 (byte
identical between the two Chatterbox servers). One Flask app factory with engine adapters
exposing `load()`, `voices()`, and `synthesize()` would collapse them.

**3. One launcher implementation (decision needed).** The shell library removed the small
duplicates, but `status_json`, `write_state_file`, `configure_slot`, `save_defaults`, and
`defaults_json` still exist in 11 copies each, differing by 2 to 22 lines, and
`bin/qwen_llama` alone embeds eight Python programs in heredocs. One Python package with a
`Runtime` adapter per backend would keep the same CLI flags and let the state model, JSON
codec, health poller, and log rotation be tested. This is a multi-day rewrite and needs a
decision before anyone starts it.

**4. ES-module split of `public/app.js`.** 13,017 lines in one classic script. The blocker is
gone: no inline `onclick` handlers remain, so the render functions no longer have to be
globals. The path is a cut along the existing section comments into `api.js`, `state.js`,
`render/*.js`, `poll.js`, and `wire.js`, with `<script type="module">`.

## Medium

**5. `bin/qwen_llama` robustness.** No `trap` on the proxy-failure path, so a failed
`start_proxy` leaves the backend alive on `18036+N` with no state file to find it by. No lock
against two concurrent starts of one slot. `$HOME/models` is hardcoded in nine places instead
of honouring `LLM3_MODELS_DIR`.

**6. Remaining synchronous filesystem calls on the request path.** 28 `fsSync.*Sync` calls in
`src/server.js`, including a `readdirSync` over the model directories and an `execFileSync`
with a 30-second timeout on the first call.

**7. Frontend error handling.** 36 `catch (_error)` sites in `public/app.js` swallow errors
silently, including the Hugging Face downloads poller, the Hermes status poller, and the chat
send path. One `reportError(scope, error)` that logs, records the scope's error state, and
toasts for user actions would make failures visible.

**8. A floor on publishing an Overall score.** A metric with too small a sample is already
excluded from the composite, and the tooltip prints `n` and the interval, but the headline
score itself is shown whatever the sample size. Refusing to publish an Overall below a floor
(or marking it) would stop a thin run reading as a confident one.

## Small

**9. The scene column is render health, not smartness.** It scores five signals: a file was
produced, it contains the expected tags, no runtime error was reported, no external scripts,
and size, element, and colour counts. There is no judge and no screenshot comparison. The
catalogue blurb says so ("Measures effort and correctness, not beauty"), and the sampling is
now pinned and recorded, but the column label still reads like a quality score.

**10. Thermal and memory-pressure capture.** Each row now records the load average when the
model started; `powermetrics`-style thermal state and memory pressure would explain a slow
row that load alone does not, and `SUMMARY.md` still has no hardware line.

**11. 20 unused CSS classes in `public/styles.css`** (the main dashboard, not the Benchmarks
tab). `npm run css-audit` lists them: `launch-layout`, `slot-panel*`, `sidebar-overlay`,
`info-card`, `selected-info*`, and others. The benchmarks stylesheet audits clean.

**12. A restart during a scene still loses that scene's progress.** The scene is retried from
the start on adoption rather than resumed mid-generation, which is the best that can be done
without the backend supporting resumption.

---

# Part 3 — Slot naming, the profiles menu, and the compaction 502

A follow-up pass on eight items raised from the dashboard, 2026-09-09.

## 3.1 A dead remote host blocked every launch into slot 4

Loading Gemma4 26B into slot 4 failed with `Unexpected token ''', "'\'' + json.dumps({"
is not valid JSON` and a 502, before `llama-server` was ever spawned. Four separate defects
stacked up:

| Layer | Defect | Fix |
| --- | --- | --- |
| `extractMarkerPayload` | `lastIndexOf(marker)`. The remote python script *contains* `print('__HERMES_SYNC__' + json.dumps({` as source, and the `expect` fallback echoes the whole script back on the pty, so the scan matched the source line and `JSON.parse`d `'\'' + json.dumps({`. | The marker must open its own line. |
| the four `parse*SyncOutput` functions | A bare `JSON.parse` on untrusted transcript text, so a malformed payload surfaced as a raw `SyntaxError` instead of a failed sync. | One `parseMarkerSyncOutput` helper returns `{ok:false, error, output}` with the transcript attached. |
| `runRemoteShell` | `expect` exits 0 whenever the pty closes, so ssh's own exit status was lost and an unreachable host looked like a successful run whose stdout happened to be the echoed script. | The spawned command prints `__LLM3_REMOTE_OK__` / `__LLM3_REMOTE_FAIL__` (no `$?`, which Tcl would mangle), checked line-anchored for the same echo reason. A failure throws with the ssh diagnostic only, not the command line, tagged `remoteUnreachable`. |
| `stopAllRuntimes` | Stopping the compaction slot resets Hermes compaction routing, and any failure there threw a 502 that aborted the *start*. Slot 4 is the compaction target, so with the remote Hermes host down, nothing could ever be loaded into it. | An unreachable remote returns `{ok:true, skipped:true, reason}` — a remote that cannot be reached is not routing anything at that slot. Every other failure stays a failure, and now carries the transcript as `error.stdout` so the launch-result modal grows an Error section instead of showing a bare one-liner. |

`tests/remote-sync-markers.test.js` locks in the parsing. Verified end to end: slot 4 loads
Gemma4 26B A4B Q8_K_P and answers `/v1/chat/completions`.

## 3.2 The other seven items

| Item | Change |
| --- | --- |
| **llm3's own log as a fifth Logs subtab** | `/api/logs/:slotId/llm3` serves `SERVER_LOG_PATH`. It is one file for the whole dashboard, so the slot row dims while that kind is selected, the status line says `llm3 server` with no slot prefix, and Download names the file `llm3-server-log.txt`. `formatLogTimestampsLocal` now also converts the bracketed, millisecond form llm3 writes. |
| **The cramped slot name** | Two causes. The hidden tok/s pill kept the placeholder text `0.0 tok/s` — ~70px of invisible box that pushed `SLOT3` into `S...`; the empty pill now collapses horizontally while the row's `min-height` keeps the card steady. The memory badge dropped its percentage (now in the tooltip), and the title lost `text-transform: uppercase`, since it is user-typed text now. Measured in Chrome: no slot title truncates. |
| **A shortcut from the slot card to its logs** | Double-click the model name (or `Idle`) on an LLM slot card: it selects that slot in the Logs tab and switches to it, moving off the `llm3` kind first because that one is not per slot. |
| **A caret on the Profiles subtab** | Lists every profile with its colour, `Active`/`Default` badges, a Start button, and a `Save current layout…` footer. Clicking a name selects it and opens the Profiles pane. |
| **Right-click on the Profiles subtab** | A confirmation modal showing what each slot holds right now, a dropdown of `New profile…` plus one `Overwrite <name>` per profile, and a name field for the new case. It defaults to a new profile, never to overwriting, because a right-click can be a mis-click. The draft is built with the profile editor's own `buildProfileSlotDraft`, so a layout saved here is what the editor would have produced. |
| **Slot names** | Press and hold a slot title to rename it. `POST /api/slots/name` saves into the applied profile when there is one and into `dashboardConfig.slotNames` when there is not, so switching profiles switches the names. The overview sends `name` (effective), `defaultName`, and `savedSlotName`; the frontend folds `name` into `slot.label` on ingest so the ~40 existing render sites pick it up unchanged. |
| **Stale launchers in the Launchers modal** | `mlx`, `rapid-mlx`, `mtplx`, `optiq` and `beellama` lost the launcher matrix to the 2026-06 benchmarks and only return behind `LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS` / `LLM3_ENABLE_EXPERIMENTAL_BEELLAMA`. `listLaunchers` now applies the same gate `getLaunchersForModel` does, so the modal lists the five that a model can actually be started with: `gguf`, `gguf-tq3`, `mlx-dspark`, `mlx-vlm`, `ds4`. Setting either flag brings the rest back. |

## 3.3 The dashboard sat disabled for minutes on a slot action

Follow-up to 3.1. Making the compaction reset non-fatal exposed how long it took:
the launch then continued into its application syncs and paid the same wait a
second time, so the UI stayed disabled through both.

`runRemoteShell` was **the only ssh call site in `src/server.js` with no
`ConnectTimeout`** — the others all set 3-5 s. Against a machine that is switched
off, connect ran out the macOS TCP timeout at 75 s, and because a key failure
fell through to the `expect` password path, one call cost ~150 s. A slot action
fans that out across every application routed at the slot, and `stopAllRuntimes`
runs it for the compaction slot on both a slot-4 stop and any Stop All.

Three changes:

- `ConnectTimeout` (`LLM3_SSH_CONNECT_TIMEOUT`, default 5 s) plus a whole-call
  ceiling (`LLM3_REMOTE_SHELL_TIMEOUT_MS`, default 45 s) on both the ssh and the
  `expect` invocation, and `expect`'s own `set timeout` follows the latter.
- No password fallback when the host is unreachable. A password cannot log in to
  a machine that is not answering; retrying under `expect` only doubled the wait.
  An auth failure still falls through as before.
- A 30 s unreachable-host cache (`LLM3_SSH_UNREACHABLE_TTL_MS`), so the several
  syncs in one action do not each pay the connect timeout. Any success clears it,
  so a machine that comes back is picked up on the next action.

Measured on `syncHermesCompactionAfterStop` against the down host: **~150 s → 5.0 s
on the first call and 0.0 s on the next two.**

## 3.4 Saving a profile cleared the slot names

A slot name lives inside the profile (3.2), but it is not one of the launch
settings the profile editor round-trips, so the save payload never mentioned it —
and `normalizeProfileSlotConfig` read "no name" as `name: ""`. Saving a profile,
including "save current layout", wiped every name the user had given the slots.

Fixed on both ends:

- `carryForwardSlotNames` in `/api/profiles/save`: a slot config that omits `name`
  keeps whatever the stored profile already had. An explicit `name: ""` still
  clears it, so the rename route can empty a name.
- `buildProfileSlotDraft` carries `name`, so the editor round-trips it. With no
  source — building from the live slots — it takes the name the slot is showing,
  via `customSlotName`, which returns "" when the effective name is just the
  built-in label. Without that, saving would freeze "1st LLM" into the profile as
  an explicit name and later changes to the built-in labels could never reach it.

Verified in the browser: overwriting the active profile and creating a new one
from the current layout both keep `PodG-AU` on slot 4 and leave the unnamed slots
empty.

## 3.5 Compaction became an ordinary role; the llm3 log became useful

Two reports, 2026-09-09.

**Compaction predated the routing roles and kept its own machinery.** A top-bar
button launched one hardcoded model at one hardcoded context size into slot 4;
`getDefaultApplicationTargetSlotId` pinned the role to slot 4 on both sides; and
the role claimed two machines at once (`machine: "m4"` plus
`alsoOnMachines: ["inuc"]`). The button reported "not available" because the
model it matched on by name is long gone.

It is two ordinary roles now — `compaction` on the remote machine and
`compactionm4` on the local one — each writing only its own Hermes and each
routable to any slot. Gone with the special case: both top-bar buttons and their
CSS, `COMPACTION_SLOT_ID`, `COMPACTION_MODEL_MATCH_TOKENS`,
`COMPACTION_CONTEXT_SIZE`, `runCompactionToggle` and its five helpers, and the
slot-4 defaults.

The stop-time reset survives, because compaction's consumer keeps calling the
endpoint on its own schedule and would otherwise fail silently against a stopped
slot. It now runs for whichever slot holds each role and reports a failure into
the stop output rather than throwing the 502 of 3.1.

**Machine labels were written twice.** `src/server.js` read `LLM3_LOCAL_LABEL` /
`LLM3_REMOTE_LABEL`; `public/app.js` carried its own literals, so the launch
modal said "Remote" whatever the configuration. The overview serves the machine
list now and the frontend prefers it, keeping the literal only as a
first-paint fallback.

**The launch modal's Routing card carries a Slot name field**, since that card is
where you decide what a slot is for. It commits on blur or Enter, independently
of the launch, and says whether the name goes into the applied profile or the
global map.

**The llm3 log showed the wrong thing.** It served `server.log` alone, and that
file only ever recorded what was *attempted*: a failed launch answered over HTTP
and left nothing on disk, so the tab showed a `start-model` line followed by
silence. Two changes:

- One `res.json` wrapper logs every non-GET request that answers 400 or worse,
  with the response's `error`, `stdout`, `stderr` and `sync_errors`. A hook
  rather than a call per catch, because most rejections never reach a catch —
  they are validation returns (`Unknown model`, `ctxSize must be…`, a 409 from
  `requireIdle`) that answer from inside the `try`.
- The `llm3` kind merges `server.log` with the process stdout and stderr (pm2's
  `<app>-out.log` / `<app>-error.log`, via `LLM3_PM2_LOG_DIR` /
  `LLM3_PM2_APP_NAME`), which is where stack traces actually land. Lines are
  merged on their timestamps, and a line without one — a stack trace's
  continuation — inherits the timestamp above it so it stays attached to its
  error. Note the two formats differ in zone: `server.log` stamps UTC with a
  trailing `Z`, pm2 writes a bare local date-time, and `Date.parse` reads a bare
  one as local, which is what makes the streams line up.

Being a three-file merge rather than an incremental chunk, that kind is fetched
only while it is the selected tab.
