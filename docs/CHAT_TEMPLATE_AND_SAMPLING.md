# Chat templates & sampling: what actually reaches the model

Findings from 2026-07-31. Theme: llm3 was silently substituting something other than what the
model was packaged or configured with — the **chat template** (HF download path) and the
**sampling params** (public slot proxy) — and its logging destroyed the evidence needed to tell
any of this apart. All of it is invisible from the dashboard, and all of it was reported as "the
model is broken".

Investigation entry point was `empero-ai/Qwythos-27B-v1-GGUF` in slot1, reported as a template
problem. **The template was fine** (see "Ruled out").

**Status — read this before using anything below.** Findings 1, 2, 3 and 6 are fixed and verified.
Finding 4 (thinking off makes reasoning visible rather than hiding it) is diagnosed but
**unfixed**. Finding 5 — the "announces an action, then stops" agent stall, which is the symptom
that started all of this — is **still undiagnosed**; several confident explanations for it were
wrong and are listed under "Retracted claims" at the end so they are not re-derived. Trust the
retraction table over any narrative in an individual section.

---

## Finding 1 — The GGUF's own chat template was being overridden by the base repo's (FIXED)

llm3 launches `llama-server` with `--chat-template-file <model dir>/.llm3-chat-template.jinja`
whenever `.llm3-hf.json` carries `chatTemplateFile`. That flag **overrides the template baked
into the GGUF**, so whatever the HF tab materializes into that file is what the model runs.

`materializeChatTemplate()` in `src/hf-download-worker.js` always preferred the repo sources
built by `buildChatTemplateSpec()` (`src/server.js`), which fall back to the **base model repo**
via the `base_model:` tag. So a GGUF download resolved its template from the upstream
*transformers* repo — a different artifact that can sit at a newer revision than the quant, and
that loses any fix the quantizer applied on top of it. unsloth and similar publishers routinely
patch chat-template bugs at quant time; all of that was being discarded.

Measured across the models on disk at the time (embedded = `tokenizer.chat_template` inside the
GGUF, external = what llm3 actually passed):

| model dir | embedded | llm3 was passing | verdict |
|---|---|---|---|
| `unsloth__Qwen3.6-27B-MTP-GGUF` (slot2) | 8057ch | 7764ch from `Qwen/Qwen3.6-27B` | unsloth fixes discarded |
| `KyleHessling1__Qwopus3.6-27B-Fusion-GGUF` | 6993ch | 7764ch from `Qwen/Qwen3.6-27B` | wrong template |
| `DavidAU__…Fable-Fusion-711…NEO-MAX-MTP-GGUF` | 7764ch | 11802ch from `…-NM-DAU-MTP` | **wrong repo** — a sibling variant, not the model on disk |
| `empero-ai__Qwythos-27B-v1-GGUF` (slot1) | 7950ch | 7950ch, byte-identical | unaffected |

**Fix:** for `runtime: "gguf"`, `materializeChatTemplate()` now prefers the GGUF's embedded
`tokenizer.chat_template` and only falls back to the repo / base-repo `chat_template.jinja` when
the GGUF has none or it is unusable. Metadata provenance records
`chatTemplateSourcePath: "tokenizer.chat_template"`. This matches every other GGUF runtime
(llama.cpp, Ollama, LM Studio all use the embedded template by default).

The three stale files on disk were re-materialized from their GGUFs. Backups sit alongside each
as `.llm3-chat-template.jinja.bak-<ISO>` and `.llm3-hf.json.bak-<ISO>`. **Templates are read only
at launch**, so a rewrite is inert until the slot restarts.

---

## Finding 2 — The GGUF "template corruption fixer" misparsed GGUF and could brick a model file (REMOVED)

`validateAndFixSingleGgufTemplate()` ran on every direct GGUF download. GGUF metadata strings are
`[uint64 length][bytes]`. It read the length as **uint32** and started the string at `+4` instead
of `+8`:

```
                       ...  [uint32 type=8] [uint64 length      ] [ template bytes ]
correct  strStart = strLenPos + 8 ------------------------------->^
buggy    strStart = strLenPos + 4 --------------->^  (high half of the length: 4 x 0x00)
```

So it read four NUL bytes followed by `{` — and its "corruption detector" was looking for exactly
`templateBytes[0..3] == 0 && templateBytes[4] == '{'`. **It fired on every healthy GGUF whose
template starts with `{`**, i.e. essentially all of them. Confirmed against the Qwythos file.

It then attempted an **in-place repair**: write `strLen - 4` into the length field and rewrite the
bytes. That is unsound regardless of offsets — shrinking a GGUF metadata string in place while the
file still holds the original bytes shifts every subsequent KV entry and the tensor-data offset,
making the file unloadable. It stayed dormant only because it required
`len(downloaded template) == len(embedded) - 4` to coincide.

**Fix:** the function and its now-dead helper `downloadSourceTemplate()` were deleted, along with
the `validateAndFixGgufTemplates()` call site. Never patch a GGUF to correct a template — llm3
already overrides via `--chat-template-file`, so write the corrected template to
`.llm3-chat-template.jinja` instead. `extractEmbeddedGgufChatTemplate()` (which always parsed the
layout correctly) now strips a genuine leading-NUL prefix and returns `""` for payloads that
contain no Jinja delimiters, so a corrupt embedded template cleanly falls through to the repo copy.

New helper `findPrimaryGgufFile()` centralises "which GGUF holds the metadata": skips `mmproj*`
(no chat template) and `*.partial*`, and sorts so a sharded model resolves to shard `00001`.

---

## Finding 3 — `/responses` bypassed the slot's sampling (FIXED — but this was NOT the agent stall)

**This section originally claimed this was the root cause of the "announces an action, then
stops" stall. That claim was wrong and has been retracted — see Finding 5.** The bypass is a real
bug and the fix is correct; it simply is not what causes the stall.

**Cause:** agent clients (Hermes / Codex-style) use the OpenAI **Responses API** (`/responses`),
not `/v1/chat/completions`. The slot proxy gated its sampling injection on
`"/chat/completions" in self.path`, so **every `/responses` request skipped the sampling
configured in the llm3 UI** and ran on stock llama.cpp defaults (temp 0.8 / top_k 40 / top_p 0.95,
no penalties).

Measured on the live Qwythos-27B, 8 trials per config, identical agent-loop conversation
(system + task + prior assistant turn + `continue`, two tools offered):

| sampling | emitted a tool call | reasoning leaked into visible content |
|---|---|---|
| stock llama.cpp defaults (what `/responses` got) | 8/8 | 5/8 |
| slot1 configured: temp .7 / top_p .8 / top_k 20 / presence 1.5 | 8/8 | 0/8 |

Treat that right-hand column as weak: it is a small sample from one synthetic conversation, and a
later run with a Hermes-shaped prompt leaked 8/8 regardless of sampling. Sampling is not the lever
for the content leak either — see Finding 4.

**Fix:** both proxy copies now match on a path-suffix test instead of a substring:

```python
GENERATION_PATH_MARKERS = ("chat/completions", "completions", "responses")

def is_generation_path(path: str) -> bool:
    route = path.split("?", 1)[0].rstrip("/")
    return any(route.endswith(marker) for marker in GENERATION_PATH_MARKERS)
```

Applied in **both** copies (see AGENTS.md "Public-slot HTTP proxy" — they must stay in sync):

- `bin/qwen_llama` → `start_proxy()` inline heredoc — **this is the live proxy on 8036–8039**
- `src/slot-api-proxy.py` — the optiq-provider variant, same bug

It also fixes `proxy_log_request`, so `/responses` now appears in the proxy log and its `model`
field is recorded in `traffic.log`. `/props`, `/v1/models`, `/health`, `/embeddings`, `/tokenize`
and `/slots` are correctly excluded.

**A proxy change requires the slot to be restarted** — the running process holds the old inline
script.

---

## Finding 4 — Thinking off does not hide reasoning, it makes it visible

`--chat-template-kwargs {"enable_thinking":false}` makes the template pre-close
`<think>\n\n</think>` in the assistant turn. That does **not** stop a reasoning model from
reasoning — it only leaves the reasoning **untagged**, so llama.cpp has no `<think>` span to
extract into `reasoning_content` and the whole chain-of-thought is emitted as ordinary `content`.

Measured on slot1 (Qwythos-27B), 8 trials each, Hermes-shaped agent prompt:

| slot1 config | emitted a tool call | **visible reasoning in `content`** |
|---|---|---|
| thinking OFF (`enable_thinking:false`, as llm3 ships it) | 7/8 | **8/8** |
| think block left open | 6/8 | **0/8** |

Confirmed in production traffic: every `/chat/completions` response in the failing session had
**zero `reasoning_content` deltas** and content that reads as deliberation
("I need to translate the English source text into Hebrew. The skill I just loaded emphasizes…").

**No fix shipped.** Nothing at the llm3 layer can reliably strip this, because with the block
pre-closed no marker distinguishes reasoning from answer. The only mechanisms that hide it require
running with the think block open — i.e. reasoning genuinely enabled — which changes what the
"thinking off" toggle means and breaks the contract asserted by
`qwen_llama keeps thinking disabled unless it is explicitly requested` in `tests/qwen-llama.test.js`.
An attempt to change the launcher this way was reverted.

The proxy can strip `reasoning_content` when opted in with `QWEN_LLAMA_HIDE_REASONING=1`, but that
only helps when reasoning is tagged, so it is off by default and does nothing for thinking-off.

---

## Finding 5 — The agent stall is still UNDIAGNOSED

Symptom: in an agent loop the model announces what it is about to do and ends the turn.

> "I was fetching the full text of Chapter One so I can translate it. Let me just do it now."

> "Understood — I will translate it myself, directly. Let me first check what other reference
> files exist for this project…"

What has been **ruled out**: the chat template (Finding 1 — slot1 runs a byte-identical copy of
its embedded template), `/responses` sampling (Finding 3 — the fix is live and verified in the
running proxy, and the failing client uses `/chat/completions`, which always received sampling),
and the thinking toggle (above).

**Why it has not been diagnosed: the logs were unusable.** `MAX_CAPTURE` was 12000 chars, which
cut requests off inside `messages` — so the `tools` array and every injected sampling field were
invisible, and it produced a false "the client sends no tools" reading — and cut responses off
before `finish_reason` or any `tool_calls` delta. Every conclusion drawn from those bodies was
drawn from truncated JSON.

**Next step:** `MAX_CAPTURE` now defaults to 200000 (`QWEN_PROXY_MAX_CAPTURE`), and logs rotate
instead of being overwritten. Restart the slot, reproduce once, then read the complete request
(including `tools`) and the complete response (including `finish_reason` and whether any
`tool_calls` delta was emitted). Do not theorise further before that capture exists.

---

## Finding 6 — Logs were destroyed on every launch (FIXED)

`clear_runtime_files()` in `bin/qwen_llama` moved `llama-server.log` to a single `.prev.log` and
**truncated** `traffic.log` and `proxy.log` outright on every launch. A backend that gets
relaunched — exactly the "it keeps crashing" case — lost its evidence after two more launches, and
`traffic.log` retained no history at all.

Now `llama-server.log` and `proxy.log` rotate through `LOG_KEEP` generations (default 5) as
`.prev.log`, `.prev.2.log` … `.prev.N.log` — generation 1 keeps the historical `.prev.log` name so
existing habits and tooling still work. `traffic.log` rotates rather than truncates
(`TRAFFIC_KEEP`, default 2) and is trimmed to its last `TRAFFIC_MAX_MB` (default 64) first, since
it had reached 135 MB on a busy slot — which is presumably why it was being truncated.

Tunable: `QWEN_LLAMA_LOG_KEEP`, `QWEN_LLAMA_TRAFFIC_KEEP`, `QWEN_LLAMA_TRAFFIC_MAX_MB`.

---

## Ruled out (do not re-investigate)

- **The Qwythos-27B template itself is correct.** Byte-identical to the GGUF's embedded template.
  Verified working against llama-server: plain chat, tool calls (its non-standard
  `<tool_call><function=…><parameter=…>` syntax parses into proper `tool_calls`), vision via
  mmproj, thinking on and off, and `reasoning_content` / `content` separation.
- **`--reasoning off` is a valid flag.** It is `-rea, --reasoning [on|off|auto]`; a plain
  `grep '^--reasoning'` over `--help` misses it because of the short-form prefix.
- **The thinking toggle does not affect the stall.** Measured on slot1 with a Hermes-shaped
  prompt, 8 trials each: thinking off emitted a tool call 7/8, think block open 6/8 —
  indistinguishable. Inspecting the two "failures" in the open case, both were the probe's own
  `max_tokens=400` cutting off mid-thought, not a stall. Do not re-attribute the stall to this.
- **Slot1 has not been observed crashing.** A watcher caught an exit on 2026-07-31 at 11:21:54:
  the final log line is `operator(): cleaning up before exit...`, a clean shutdown. Zero macOS
  crash reports for `llama-server`, and no jetsam/OOM kill in `log show`. Reports of "it keeps
  crashing" have so far all resolved to clean stops.

---

## Operational notes for the next investigation

- **Read what is actually running, not the repo.** The live slot proxy is an inline script inside
  `bin/qwen_llama`, not `src/slot-api-proxy.py`, and it is not referenced from `src/server.js`.
  Dump it with `ps -ww -ax -o command= | grep QWEN_PROXY`.
- **`traffic.log` truncates request and response bodies at `MAX_CAPTURE`** (now 200000, was
  12000). Long agent requests are still cut mid-JSON and will not `json.loads`. **Always check
  whether a body is truncated before concluding a field is absent** — the 12000 cap produced a
  false "the client sends no tools" reading, when `tools` was merely past the cut. Raise
  `QWEN_PROXY_MAX_CAPTURE` when diagnosing.
- **A slot restart is required for any proxy or launcher change.** The running process holds the
  inline script it was started with. Verify a fix is actually live before trusting a negative
  result: `ps -ww -p <proxy pid> -o command= | grep -c is_generation_path`.
- **Editing the `bin/qwen_llama` heredoc:** macOS `/bin/bash` 3.2 counts quotes even inside
  `<<'PY'`, so an unbalanced apostrophe in a Python comment breaks `bash -n`. Write comments
  apostrophe-free and always run `bash -n bin/qwen_llama` afterwards.
- **Never use `lsof` for port→pid** in any hot path here — see the note in
  `SPEED_OPTIMIZATION_FINDINGS.md` lineage; use `netstat -anv -p tcp`.

## Verification

- 4 tests added to `tests/hf-download-worker.test.js` (embedded-preferred, repo fallback, NUL
  stripping / garbage rejection, shard & mmproj selection). Suite: 92 pass.
- `npm run check`, `bash -n bin/qwen_llama`, `python3 -m py_compile src/slot-api-proxy.py` clean.
- Proxy fix verified end-to-end by running the patched inline script on a spare port against the
  live backend and confirming `/responses` receives temp 0.7 / top_p 0.8 / top_k 20 / min_p 0 /
  presence_penalty 1.5.
- Log rotation and tail-trim unit-tested against a temp dir (5 launches at `LOG_KEEP=3` retains
  generations 3-5; traffic keeps 2; a 3 MB file trims to exactly 1 MB at a 1 MB cap).
- Reasoning-strip helpers unit-tested: `reasoning_content` removed from SSE deltas and
  non-streamed messages; `content`, `tool_calls`, `[DONE]`, comment lines and malformed lines pass
  through byte-identical, SSE framing preserved.
- Pre-existing unrelated flake: `syncHermesAfterLaunch uses SSH key auth when available` in
  `tests/server.test.js` fails intermittently on SSH arg ordering. It predates these changes.

## Retracted claims (kept deliberately, so they are not re-derived)

| Claim made during investigation | Status |
|---|---|
| The `/responses` sampling bypass caused the agent stall | **Wrong.** Fix verified live in the running proxy; stall persisted. The failing client uses `/chat/completions`, which always got sampling. |
| Thinking off causes the stall | **Wrong.** 7/8 vs 6/8 on slot1 — no effect. |
| The Hermes client sends no `tools` | **Wrong.** Artifact of the 12000-char body truncation; `tools` sits after a very large `messages`. |
| Slot1 keeps crashing | **Not observed.** Every captured exit was a clean `cleaning up before exit`, no crash report, no OOM kill. |
| Sampling is the lever for reasoning leaking into content | **Unsupported.** A later Hermes-shaped run leaked 8/8 regardless of sampling; the lever is the pre-closed think block (Finding 4). |
| The `Qwythos 27B` chat template is broken | **Wrong.** Byte-identical to the GGUF's embedded template; all paths verified working. |
