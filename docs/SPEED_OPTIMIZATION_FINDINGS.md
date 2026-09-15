# Model/launcher speed optimization findings

## 2026-06-11 — benchmark math fixed, dead launchers retired

- **Why grammar tricks "looked slower":** the suite's decode tok/s divided by *total elapsed including TTFT*. Grammar-constrained runs finish in ~4–7s/260 tokens, so fixed startup cost dominated their average, while plain `think` streamed 2048 tokens for the full window. Fixed: decode tok/s now excludes TTFT, throughput window default 30s→60s, max_tokens 2048→6144, and new per-run fields `answerPhaseTokensPerSecond`, `firstAnswerSeconds`, `completed` land in benchmark.json. Old saved rows keep their old numbers until re-run.
- **Launchers retired from the matrix** (re-enable with `LLM3_ENABLE_EXPERIMENTAL_LAUNCHERS=1`, beellama with `LLM3_ENABLE_EXPERIMENTAL_BEELLAMA=1`): beellama (15–30% slower everywhere, fatal on Gemma 4 — previously auto-enabled just because its binary existed), mlx/rapid-mlx/mtplx (MTPLX 30–58 tok/s vs GGUF MTP 62–71; the 37GB samuelfaj bundle never loads under the plain mlx launcher), optiq (slowest Gemma path), dflash/turboquant (no models). Their stale result rows moved to `benchmarks/saved-results/retired-launchers-20260611/`.
- **Quality eval fixes:** MMLU subject lists were wrong (humanities full of STEM, nonexistent subjects) and sampling drained the whole limit from the first subject (mmlu_stem was 20 college-chemistry questions). Now canonical taxonomy + round-robin across subjects. Answer extraction no longer matches the "a" in "answer". GSM8K added to the suite. Quality runs once per model+launcher and is shared across thinking variants (4× less eval time), default limit 20→30.
- **Top-3 badges:** /api/models now ranks models by best benchmark overall (decode tok/s tiebreak) and the Models tab shows 🥇🥈🥉 badges.
- **HF tab:** split GGUFs (`-NNNNN-of-NNNNN`) download as one candidate with all shards; new "Attach companion file" form (POST /api/hf/companions) pulls an MTP draft / mmproj / chat template / other sidecar into an existing model dir and patches `.llm3-hf.json` (`mtpDraftFile` etc.) without overwriting it.
- The 37GB `samuelfaj__Qwen3.6-35B-A3B-8bit-MTPLX-Optimized-Speed` dir is now dead weight (no active launcher) — candidate for deletion.

# Findings (2026-06-10)

Goal: every model defaults to its fastest correct environment at maximum quality, thinking and non-thinking. Reference record: Qwen3.6-35BA3B-MTP (gguf, `--spec-type draft-mtp --spec-draft-n-max 2 --spec-draft-p-min 0.75`, flash-attn, q8_0 KV) = **79.311 tok/s** in the saved benchmarks.

All new measurements below were taken **under ambient production load** (podG TTS synthesizing + slot2 hermes jobs active), so absolute numbers are ~15–30% below idle; comparisons are A/B within the same window. Harness: streaming chat completion, temp 0, decode tok/s = completion_tokens ÷ time-after-first-token, 3 runs (`/tmp/llm3_bench.py` methodology, 700–900-token essay prompt unless noted).

## Finding 1 — Gemma's MTP draft default was mistuned (FIXED)

llm3 auto-attaches the Gemma 4 MTP draft GGUFs (`mtp-gemma-4-*.gguf`, 440–491MB) with `--spec-draft-n-max 4`. But Gemma draft acceptance is only **0.46–0.66** (vs ~0.94 for Qwen MTP), so 4-token draft runs waste verification work.

**gemma-4-26B-A4B-it-qat (MoE, 4B active), under load, medians:**

| Config | decode tok/s | acceptance |
|---|---|---|
| no speculation | 42.5 | — |
| n-max 4 (old default) | 48.8 | 0.46 |
| **n-max 2 (new default)** | **55.5** | 0.65 |
| n-max 2, p-min 0.85 | 54.4 | 0.82 |
| n-max 3, p-min 0.85 | 50.8 | 0.74 |

**gemma-4-31B-it-qat (dense), under load, medians:**

| Config | decode tok/s | acceptance |
|---|---|---|
| no speculation | 13.9 | — |
| **n-max 2 (new default)** | 14.2 | 0.66 |
| n-max 3 | 12.1 | 0.55 |
| n-max 4 (old default) | **9.9 (−29%!)** | 0.48 |

Fix applied in `bin/qwen_llama` (gemma n-max default 4 → 2; `QWEN_LLAMA_MTP_DRAFT_N_MAX` env still overrides). This was a big part of "gemma never comes close": the dense 31B's saved 19.33 tok/s benchmark was likely dragged down by the harmful n-max 4 attachment, and the best gemma (26B-A4B MoE) had never been benchmarked at all.

## Finding 2 — The fastest Gemma was sitting unbenchmarked

**gemma-4-26B-A4B-it-qat** (MoE, 4B active — same architecture trick as Qwen's 35B-A3B) reaches **~55 tok/s under load** with the fixed draft config; idle estimate ~65–70 tok/s. That is the Gemma to use by default for speed; it was absent from benchmarks/SUMMARY.md (only dense 12B/41.3 and 31B/19.3 were tested).

## Finding 3 — Structured GBNF kills Qwen's rumination (10× wall-clock on code)

Qwen3.6-35BA3B-MTP, two_sum coding prompt, max_tokens 3072, via the real launcher path:

| Config | completion tokens | wall time | decode tok/s |
|---|---|---|---|
| thinking, free-form | 3072 (hit cap, never finished thinking) | 64.6s | 47.5 |
| **thinking + Structured GBNF** | 264 | **6.4s** | 81.8 |
| thinking + Tiny Grammar | 335 | 7.1s | 68.9 |
| no thinking | 128 | 3.4s | 41.6 |

Structured GBNF (`enableStructuredGbnf`) caps thinking to exactly three lines (GOAL/APPROACH/EDGE in `<analysis>`) then forces the answer. Decode speed *rises* to ~82 tok/s because MTP acceptance soars on constrained output. This is the recommended default for **coding/agentic Qwen profiles**: bounded thinking ≈ most of the quality at a tenth of the latency.

**Hard constraint: both grammar files force ASCII-only output. Never enable Tiny Grammar / Structured GBNF on slots serving podG or any non-English generation (Hebrew output becomes impossible).** Free-form thinking remains the right choice for the podG slot (long-form Hebrew quality) and for genuinely hard reasoning.

## Finding 4 — beellama × Gemma 4 is fatally broken (GATED)

Both saved gemma×beellama runs crash in warmup (`ggml_compute_forward_scale` abort, 300s timeout). `getLaunchersForModel` in `src/server.js` now excludes beellama for Gemma 4 models until the fork is fixed.

## Finding 5 — OptIQ Gemma4-MTPLX bundle is the slowest Gemma path here

`Youssofal__Gemma4-MTPLX-Optimized-Quality` via the optiq launcher (slot1, same ambient load): **8.7–9.0 tok/s decode** across 3 runs (700-token essay). That is ~40% slower than the dense gemma-4-31B-qat on plain gguf (13.9) and ~60% slower than gguf with the fixed draft (14.3). The bundle's "2.24× vs vanilla MTP" claim is relative to an MLX baseline that itself loses badly to llama.cpp/Metal on this machine, and the 31GB safetensors weights are much heavier than the 16GB QAT Q4 GGUF. Conclusion: do not prefer optiq for speed; treat it as a quality-comparison curiosity only.

## Recommended defaults per model (max quality at best speed)

| Model | Launcher | Config | Why |
|---|---|---|---|
| Qwen3.6-35BA3B-MTP | gguf | draft-mtp n-max 2 (as today); thinking ON for hard reasoning / Hebrew; **+ Structured GBNF for coding/agentic profiles** | record decode + rumination control |
| gemma-4-26B-A4B-it-qat | gguf | draft n-max 2 (new default), thinking per task | fastest Gemma, ~55 tok/s under load |
| gemma-4-31B-it-qat | gguf | draft n-max 2 (or `QWEN_LLAMA_MTP_DRAFT_N_MAX=0`-style no-draft; difference is noise) | n-max 4 was −29% |
| gemma-4-12B-it-qat | gguf | no draft exists on disk; plain gguf | 41.3 tok/s saved |
| any Gemma 4 | ~~beellama~~ | gated out | fatal warmup crash |
| Gemma4-MTPLX bundle | optiq (only option) | not speed-relevant | 8.8 tok/s — slowest Gemma path |

## 4-way thinking-variant benchmark (official suite, slot1, ctx 128000, ambient podG load)

| Model | Variant | tok/s | answer tok/s | MMLU | verdict |
|---|---|---:|---:|---:|---|
| Qwen3.6 35BA3B MTP | no-think | 37.8 | 37.8 | 0.683 | baseline |
| Qwen3.6 35BA3B MTP | think | 15.2 | **0.0** | 0.683 | thinking never finished in the window |
| Qwen3.6 35BA3B MTP | **think+Structured GBNF** | **42.6** | **42.6** | 0.683 | **faster than no-think** — bounded analysis raises MTP acceptance |
| Qwen3.6 35BA3B MTP | think+Tiny Grammar | 39.5 | 20.4 | 0.683 | good, GBNF better |
| gemma-4-26B-A4B QAT | no-think | **60.3** | 60.3 | 0.683 | fastest Gemma; fixed draft default (n-max 2) in effect |
| gemma-4-26B-A4B QAT | think | 60.5 | 18.0 | 0.667 | decode fine, answers starve |
| gemma-4-31B QAT | no-think | 16.0 | 16.0 | 0.700 | dense tax |
| gemma-4-31B QAT | think | 11.8 | 0.0 | 0.700 | avoid |

Bottom line: for coding/agentic work, **think+Structured GBNF is strictly dominant** on the Qwen MTP (speed of no-think, structure of thinking, same MMLU). Free-form thinking should be reserved for tasks where the answer window is unbounded (long-form generation) — and there, cap it with the new Thinking-budget knob. (Variant rows live in benchmarks/results/*__{variant}/ and the SUMMARY.md Variant column.)

## Dormant launcher inventory (2026-06-10 evening sweep)

| Runtime | State on disk | Verdict |
|---|---|---|
| beellama (vendor, CPU+Metal builds May 16) | built, auto-enabled | Unreachable for the models that matter: MTP GGUFs route gguf-only, Gemma 4 gated (fatal crash). Only worth reviving with a DFlash draft GGUF paired to a dense Qwen 27B. |
| gguf-tq3 (vendor, built Jun 5) | built | Dead end on Apple Silicon: fork is CPU-only here (53 tok/s claim is CUDA), and the only TQ3 model dir holds just an mmproj stub. |
| dflash (dflash-mlx 0.1.0) | installed | Model root ~/models/dflash does not exist; bf16 bundles couldn't beat the MoE MTP GGUF anyway. |
| turboquant (0.3.0) | installed | Hardcoded to gpt-oss-20b-tq3 under missing ~/models/turboquant. Irrelevant to Qwen/Gemma. |
| mlx / rapid-mlx / mtplx (rapid-mlx 0.6.51, mtplx 0.3.7) | installed, freshest stack | **TESTED AND BEATEN.** Downloaded `samuelfaj/Qwen3.6-35B-A3B-8bit-MTPLX-Optimized-Speed` (37GB, now on disk); mtplx 0.3.7 refuses its older contract ("needs-grafting") — `--unsafe-force-unverified --yes` bypasses. Same-conditions head-to-head (700-token essay, thinking, idle): **MTPLX 30–58 tok/s vs GGUF MTP 62–71 tok/s.** The 2.24× claim does not materialize for this MoE on this machine; plus 37GB safetensors loads OOM-killed production once (no mmap sharing). Verdict: stay on gguf. |
| ~/llama.cpp-latest (runtime-mtp), ~/llama.cpp-mtp-old-do-not-use | built clones | Superseded by ~/llama.cpp-upstream (Jun 8, has merged Gemma4 MTP). Safe to delete for disk. |
| vllm-mlx (in rapid-mlx venv) | installed, unregistered | No llm3 launcher references it; candidate for a future paged-attention MLX launcher. |

Stub dirs that surface unservable entries (weights deleted, only mmproj left): unsloth__Qwen3.6-35B-A3B-MTP-GGUF, unsloth__Qwen3.6-27B-MTP-GGUF, ironbcc__gemma-4-26B-A4B-it-MTP-GGUF, YTan2000__Qwen3.6-35B-A3B-TQ3_4S — re-download weights or delete the dirs.

## New settings-modal tricks (added 2026-06-10)

- **Thinking budget** (`reasoningBudget`, gguf-family): llama-server `--reasoning-budget` (-1 unlimited / 0 off / N cap). The cure for rumination loops; 1024 measured 4.8× faster podG translation units.
- **Anti-repetition DRY** (`enableDry`, gguf-family): `--dry-multiplier 0.8` — suppresses repetition loops with far less quality damage than repetitionPenalty 2.0 (which the UI used as its reset default).
- **MTP draft depth** (`mtpDraftMax`, MTP-capable models): `--mtp-draft-max` → `--spec-draft-n-max`. 2 is the measured sweet spot at 0.46–0.94 acceptance.
- All three persist via slot defaults.json, profiles, and `/api/start`, and ride the existing modal → server → launcher chain.
- Flag-scan candidates deliberately NOT added yet: `--cache-reuse` (needs `--swa-full` interplay on Gemma), `--n-cpu-moe`/`--override-tensor exps=CPU` (MoE expert placement for big-context squeeze), adaptive-p sampler, beellama's `--reasoning-loop-guard`.

## Follow-ups worth trying (not done today)

- Download an MLX-format Qwen3.6-35B (e.g. mxfp4 MLX) to compare rapid-mlx vs gguf for the flagship — no MLX-format Qwen exists on disk today.
- The `ironbcc gemma-4-26B-A4B-it-MTP Q8_0` repo (metadata-only stub) might carry an MTP-aware main GGUF; a native-MTP 26B-A4B could lift acceptance above the sidecar draft's 0.65.
- Re-run the official perf-dashboard suite for gemma-4-26B-A4B-qat (now with n-max 2) on an idle machine to get a saved, comparable SUMMARY.md row.

## Method notes / caveats

- Ambient load (TTS + slot2 inference) suppresses absolutes and adds ±10% variance on MoE runs; dense-31B runs were remarkably stable (±1%).
- The saved benchmark suite's throughput stage can finish in <2s (e.g. 116 tokens for the record run) — short windows make close calls (79.311 vs 79.302) meaningless. Prefer ≥700-token windows for comparisons.
- The built-in slot benchmark fired at 7ms after `/api/start` returns got a 400 (model not warm yet); warm the slot first.
- QAT in llm3 is a model-file property (no runtime flags); the QAT gemmas are what we benchmarked, and `-qat` stems are stripped when resolving MTP draft pairs.
