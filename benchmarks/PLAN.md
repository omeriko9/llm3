> **Status (September 2026): historical design document.** The runner has moved on from
> several points below: default context is 128000 (not 8192), the throughput stage runs at
> temperature 0 with a 60 s window and repeats the request (median reported), the quality
> suite is MMLU-Pro + MATH-500 + HumanEval + DeepEval IFEval (HellaSwag and ARC were
> removed), and scene, translation, and thinking-variant stages exist. `benchmark_runner.py`
> and `src/perf-dashboard-routes.js` are the source of truth; `benchmark.json` rows carry
> `schemaVersion` 2.

# llm3 Model Benchmarking Plan

## Part 1: Model Inventory & Execution Architecture

### 1.1 Overview

llm3 manages **multiple launcher/runtime combinations** with per-slot state, fixed port ranges, and shared dashboard orchestration. The web dashboard (`~/websites/llm3/src/server.js`) currently routes launches across **4 LLM slots** and supports GGUF, GGUF-TQ3, beellama, MLX, Rapid-MLX, MTPLX, DFlash, and TurboQuant runtimes.

### 1.2 Runtime Families

| Family | Launchers | Backend | Port Range | Notes |
|--------|-----------|---------|------------|-------|
| **GGUF** | `./bin/qwen_llama`, `./bin/qwen_llama_tq3`, `./bin/qwen_llama_beellama` | `llama-server`, TQ3 llama.cpp, beellama | 8036–8039 (public), 18036–18039 / 18636–18639 / 18736–18739 (backend) | Thinking is explicit via `--thinking` / `--no-thinking`; `qwen_llama` stores requested per-parallel context and expands backend ctx by `parallel` |
| **MLX** | `./bin/run-qwen36-mlx-api.sh`, `./bin/run-qwen36-rapid-mlx-api.sh`, `./bin/run-qwen36-mtplx-api.sh` | `qwen36-mlx-api-proxy.py`, `rapid-mlx`, `mtplx` | 8036–8039 (public), 18136–18139 / 18336–18339 / 18536–18539 (backend) | MLX-family launchers share the same slot ids while using separate backend port bases |
| **Speculative / Alt** | `./bin/run-qwen36-dflash-api.sh`, `./bin/run-gpt-oss-turboquant-api.sh` | `qwen36-dflash-api.py`, `turboquant-serve` | 8036–8039 (public), 18236–18239 / 18436–18439 (backend) | Used for speculative or alternative inference stacks |

### 1.3 GGUF Models (llama.cpp)

GGUF models are launched via `llama-server` with Metal GPU offload. The launcher resolves built-in keys or dynamically discovers models from `~/models/hf/`.

#### Built-in GGUF Models

| Key | Label | File Path | Size | HF Source |
|-----|-------|-----------|------|-----------|
| `qwen-bf16` | Qwen 3.6 BF16 | `~/models/qwen36-bf16/BF16/Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf` (+00002) | 64.6 GB | unsloth/Qwen3.6-35B-A3B-GGUF |
| `qwen-q8` | Qwen 3.6 Q8_0 | `~/models/qwen36-q8/Qwen3.6-35B-A3B-Q8_0.gguf` | 35.8 GB | unsloth/Qwen3.6-35B-A3B-GGUF |
| `qwen-q6` | Qwen 3.6 UD-Q6_K_XL | `~/models/qwen36-q6/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` | 29.2 GB | unsloth/Qwen3.6-35B-A3B-GGUF |
| `qwen-mxfp4` | Qwen 3.6 MXFP4_MOE | `~/models/qwen36-mxfp4/Qwen3.6-35B-A3B-MXFP4_MOE.gguf` | 18.9 GB | noctrex/Qwen3.6-35B-A3B-MXFP4_MOE-GGUF |
| `gemma4-31b` | Gemma 4 31B Q8_0 | `~/models/gemma4-31b-q8/gemma-4-31B-it-Q8_0.gguf` (+mmproj) | 32.6 GB | unsloth/gemma-4-31B-it-GGUF |

#### Dynamically Discovered GGUF Models (from `~/models/hf/`)

These are discovered by scanning `.llm3-hf.json` metadata files in `~/models/hf/<user>__<model>/`:

| Model | Family | Quantization | HF Repo |
|-------|--------|-------------|---------|
| HauhauCS Qwen3.6-27B Uncensored | Qwen 3.6 | Q2_K_P | HauhauCS/Qwen3.6-27B-Uncensored-HauhauCS-Aggressive |
| unsloth Qwen3.6-27B-UD-IQ2_M | Qwen 3.6 | UD-IQ2_M | unsloth/Qwen3.6-27B-GGUF |
| bartowski Gemma 4 26B | Gemma | Q8_0 | bartowski/google_gemma-4-26B-A4B-it-GGUF |
| kai-os Carnice V2 27B | Downloaded model | Q8_0 | kai-os/Carnice-V2-27b-GGUF |
| hesamation Qwen3.6 35B Opus-distilled | Qwen 3.6 | Q8_0 | hesamation/Qwen3.6-35B-A3B-Claude-4.6-Opus-Reasoning-Distilled-GGUF |
| mradermacher TinyLlama 1.1B | Llama | IQ1_S | mradermacher/TinyLlama-1.1B-32k-i1-GGUF |

#### GGUF Launch Details

```bash
llama-server \
  --model <path-to-gguf> \
  --alias <model-aliases> \
  --host 127.0.0.1 \
  --port <backend-port> \
  --ctx-size <ctx * parallel> \
  --parallel <parallel> \
  --threads <perf-cores> \
  --threads-batch <threads> \
  --n-gpu-layers 999 \
  --flash-attn on \
  --batch-size 2048 \
  --ubatch-size 512 \
  --cache-type-k <resolved-cache-type-k> \
  --cache-type-v <resolved-cache-type-v> \
  --metrics \
  --jinja \
  --chat-template-kwargs '{"enable_thinking":false}' \
  --mmproj <mmproj> --mmproj-offload  # if available
```

A Python proxy is spawned in front of `llama-server` for traffic logging. Health-checked via `curl http://127.0.0.1:<backend-port>/v1/models`.

`qwen_llama` now treats the configured `ctxSize` as the requested **per-parallel** context value, expands the backend `--ctx-size` by `parallel`, and no longer applies hidden launcher-policy rewrites like context clamping, forced `parallel=1`, or auto-enabling thinking.

### 1.4 MLX Models

MLX models are launched via `qwen36-mlx-api-proxy.py` which wraps the `mlx-community` inference stack.

#### MLX Models

| Key | Label | Size | Family | HF Source |
|-----|-------|------|--------|-----------|
| `Qwen3.6-35B-A3B-mxfp4` | Qwen 3.6 MXFP4 | 18.0 GB | Qwen 3.6 MLX | OsaurusAI/Qwen3.6-35B-A3B-mxfp4 |
| `Qwen3.6-35B-A3B-5bit` | Qwen 3.6 5bit | 22.2 GB | Qwen 3.6 MLX | NexVeridian/Qwen3.6-35B-A3B-5bit |
| `Qwen3.6-35B-A3B-6bit` | Qwen 3.6 6bit | 26.3 GB | Qwen 3.6 MLX | NexVeridian/Qwen3.6-35B-A3B-6bit |
| `Qwen3.6-35B-A3B-8bit` | Qwen 3.6 8bit | 34.3 GB | Qwen 3.6 MLX | NexVeridian/Qwen3.6-35B-A3B-8bit |
| `Qwen3.6-35B-A3B-float16` | Qwen 3.6 float16 | 64.6 GB | Qwen 3.6 MLX | Qwen/Qwen3.6-35B-A3B |
| `Huihui-Qwen36-35B-A3B-Opus-4bit` | Huihui Qwen3.6 4bit | 18.0 GB | Huihui MLX | huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.6-Opus-abliterated |
| `Huihui-Qwen36-35B-A3B-Opus-6bit` | Huihui Qwen3.6 6bit | 26.0 GB | Huihui MLX | huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.6-Opus-abliterated |
| `Huihui-Qwen36-35B-A3B-Opus-float16` | Huihui Qwen3.6 float16 | 67.0 GB | Huihui MLX | huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.6-Opus-abliterated |
| `Qwopus-GLM-18B-MLX-4bit` | Qwopus GLM 18B 4bit | 8.3 GB | Qwopus MLX | KyleHessling1/Qwopus-GLM-18B-Healed-MLX-4bit |

#### MLX Launch Details

```bash
exec "${VENV}/bin/python" ~/qwen36-mlx-api-proxy.py \
  --model-dir <model-directory> \
  --model-name <basename> \
  --host 0.0.0.0 \
  --port <public-port> \
  --backend-port <backend-port> \
  --parallel <parallel> \
  --prefill-step-size 1024 \
  --context-size <max-kv-size>
```

Models are resolved from `~/models/<model-name>/` directories containing safetensors files.

### 1.5 DFlash Models (Speculative Decoding)

DFlash uses **speculative decoding** with a fast draft model proposing tokens and a larger target model verifying them. Each bundle lives under `~/models/dflash/<bundle>/` with `manifest.json`, `target/`, and `draft/` directories.

#### DFlash Models

| Key | Target Model | Draft Model | Family |
|-----|-------------|-------------|--------|
| `Qwen3.6-27B-AEON-Ultimate-Uncensored-DFlash` | AEON-7/Qwen3.6-27B-AEON-Uncensored | z-lab/Qwen3.5-27B-DFlash | Qwen 3.6 DFlash |
| `Qwen3.6-27B-MXFP4-DFlash` | mlx-community/Qwen3.6-27B-MXFP4 | z-lab/Qwen3.5-27B-DFlash | Qwen 3.6 DFlash |

#### DFlash Launch Details

```bash
exec "${VENV}/bin/python" ~/qwen36-dflash-api.py \
  --model-id <model-id> \
  --target-model <target-dir> \
  --draft-model <draft-dir> \
  --host 0.0.0.0 \
  --port <public-port> \
  --context-size <max-context> \
  --parallel <parallel> \
  --verify-mode parallel-replay \
  --verify-chunk-size 4
```

Uses the `dflash_mlx` library with `parallel-replay` token verification.

### 1.6 Slot Architecture

The llm3 web app manages **4 LLM slots**, each with its own public port, backend ports, and state directory:

| Slot | Public Port | GGUF Backend | MLX Backend | DFlash Backend | State Dir |
|------|-------------|-------------|-------------|----------------|-----------|
| `slot1` | 8036 | 18036 | 18136 | 18236 | `~/.local/state/qwen_llama` / `qwen36_mlx` / `qwen36_dflash` |
| `slot2` | 8037 | 18037 | 18137 | 18237 | `~/.local/state/qwen_llama/slot2` / ... / ... |
| `slot3` | 8038 | 18038 | 18138 | 18238 | `~/.local/state/qwen_llama/slot3` / ... / ... |
| `slot4` | 8039 | 18039 | 18139 | 18239 | `~/.local/state/qwen_llama/slot4` / ... / ... |

Additional per-slot backend port bases also exist for Rapid-MLX (`18336+`), TurboQuant (`18436+`), MTPLX (`18536+`), GGUF-TQ3 (`18636+`), and beellama (`18736+`).

Each slot can independently run any supported LLM runtime family.

### 1.7 Integration Targets

When a model is started, the dashboard can sync the endpoint configuration to:
- **Hermes Agent** — updates `~/.hermes/config.yaml`
- **Claude Code** — updates `~/.claude/settings.json` proxy config
- **LibreChat** — syncs to the remote LibreChat instance
- **Hermes M4** — updates local `~/.hermes/config.yaml`

---

## Part 2: Benchmarking Plan

### 2.1 Overview

Benchmark every model in the llm3 inventory across four test dimensions. Each model is started on a dedicated slot, tested, then stopped before moving to the next model. All models share the same benchmarking parameters to ensure comparability.

### 2.2 Benchmark Parameters

| Parameter | Value |
|-----------|-------|
| Context size | 8192 tokens (conservative for comparability) |
| Parallel | 1 |
| Temperature | 0.7 |
| Max tokens per response | 4096 |
| Global timeout | **5 minutes** (300 seconds) — any stage that exceeds this is killed |
| Slot assignment | Sequential, one active model benchmark at a time |
| Pre-test cleanup | Kill any existing process on the target port before starting |
| Token counting precedence | `usage` field > streamed usage stats > local estimate, and mark estimates explicitly |

#### Normalization Rules

- Run benchmarks with no other model active; do not overlap load, inference, or shutdown across models
- Use the same prompt text, request shape, and timeout rules for every model in a given test step
- Record whether a metric is **measured**, **estimated**, or **not-applicable** so summary tables do not mix incomparable values

### 2.3 Execution Workflow (Per Model)

For each model, the following steps are executed in order:

#### Step 0: Preparation

1. Determine the model's runtime family (GGUF / MLX / DFlash)
2. Select the next available slot (starting from slot1, wrapping around)
3. Kill any existing process on the slot's public and backend ports
4. Create the result subfolder: `./benchmarks/results/<model-label>/`
5. Record the start timestamp

#### Step 1: Load Time

1. Launch the model on the chosen slot using the appropriate launcher
2. **Measure time from launch command invocation to first successful `/v1/models` health check**
3. Record: `load_time_seconds`
4. If the model fails to load within **5 minutes**, record `error: "load-timeout"`, stop the model, and skip remaining tests

#### Step 2: Basic Response Test ("hi")

1. Send a chat completion request to `<public-port>/v1/chat/completions` with:
   - Prompt: `"hi"`
   - `temperature: 0.7`, `max_tokens: 256`, `stream: true`
2. **Measure time from request send to first streamed token** (TTFT — time to first token)
3. **Measure total response time** (request to last byte)
4. Record:
   - `ttft_seconds`
   - `total_response_seconds`
   - `response_text` (truncated to 500 chars)
   - `tokens_generated` (from usage field or char/4 estimate)
   - `token_count_method` (`usage` / `stream` / `estimate`)
5. If no response within **5 minutes**, record `error: "basic-response-timeout"`, stop model, skip remaining tests

#### Step 3: Token-Per-Second Throughput Test (30 seconds)

1. Send a prompt that elicits a long response:
   - Prompt: `"Write a detailed technical explanation of how transformer attention mechanisms work, covering self-attention, multi-head attention, positional encoding, and the forward pass. Be thorough and include mathematical notation where relevant. Continue until you have covered all major aspects."`
   - `temperature: 0.5`, `max_tokens: 4096`, `stream: true`
2. Stream the response for up to **30 seconds**
3. Record:
   - `total_tokens_generated` (count tokens from stream)
   - `elapsed_seconds` (actual test duration, capped at 30)
   - `tokens_per_second` = `total_tokens_generated / elapsed_seconds`
   - `total_response_time_seconds`
   - `token_count_method` (`usage` / `stream` / `estimate`)
4. If no first token arrives within **30 seconds**, record `error: "throughput-start-timeout"` and stop the step
5. If generation starts but no new token arrives for **10 seconds** before the 30-second window ends, record `error: "throughput-stall"` and stop the step

#### Step 4: Agentic / Tool-Calling Test

  1. Expose the same OpenAI-compatible tool schema to every runtime that supports tools:
     - `multiply(a: number, b: number) -> number`
     - `prime_factorize(n: number) -> number[]`
  2. Send a request that requires the model to use tools and make multiple calls:
     - Prompt: `"I need you to do the following multi-step task: First, calculate the result of 42 * 137. Then, take that result and explain what prime factors it has. Finally, write a short paragraph connecting those factors to a real-world example. Use your available tools to compute the math accurately — do not guess."`
     - `temperature: 0.3`, `max_tokens: 2048`, `stream: false`
  3. Evaluate:
     - Did the runtime actually advertise tool support for this request?
     - If tools were available, did the model attempt tool calls? (check for `tool_calls` in response)
     - Did it complete all three steps?
     - Did it hang or stall at any point?
     - Was the math correct? (42 × 137 = 5754; prime factors are 2, 3, 7, 137)
  4. Record:
     - `agentic_result` (pass/fail/partial)
     - `agentic_notes` (free-form description of behavior)
     - `tool_calls_made` (count)
     - `tool_support` (`supported` / `unsupported` / `unknown`)
     - `agentic_error` (if any: "stalled", "refused", "incorrect", "no-tool-calls", etc.)
  5. Scoring rules:
     - `pass`: all three subtasks completed and math/factors are correct
     - `partial`: coherent attempt, but one subtask is missing or incorrect
     - `fail`: incorrect result, refusal, or unusable output
     - `not-applicable`: runtime cannot accept a tools payload; still record whether the text-only answer was complete/correct in `agentic_notes`
  6. If the model doesn't respond within **5 minutes**, record `error: "agentic-timeout"`, stop model

  #### Step 5: Quality Benchmark

  1. Run a custom MMLU quality evaluator (`quality_eval.py`) against the model's OpenAI-compatible endpoint:
     - MMLU subsets: `mmlu_stem`, `mmlu_social_sciences`, `mmlu_humanities` (default 20 examples each)
     - Questions loaded from the `cais/mmlu` HuggingFace dataset
     - Each question is sent as a chat completion request with temperature=0
     - Model answers are compared against the correct letter (A-D)
   2. Compute `avgMmlu` (average of the 3 subset scores) and `overallAverage` (same as avgMmlu since only MMLU)
   3. Write results to `quality.log` and the scores into `benchmark.json` under `benchmarks.quality`
   4. Timeout: `global_timeout` (default 300s)
   5. If the evaluator fails, record `error: "quality-error"` and continue

  #### Step 6: Cleanup

  1. Stop the model on the slot (send stop command to launcher)
  2. Wait for the process to exit (up to 30 seconds)
  3. Force-kill if still running
  4. Record the stop timestamp

### 2.4 Result Directory Structure

```
./benchmarks/
├── PLAN.md                          # This file
├── SUMMARY.md                       # Generated summary (created at the end)
└── results/
    └── <model-label>/               # One folder per model
        ├── metadata.json            # Model info: key, label, runtime, family, size, hf-url
        ├── benchmark.json           # All benchmark metrics (see schema below)
        ├── load_time.log            # Raw launch command + stderr/stdout
        ├── basic_response.log       # Request/response details
        ├── throughput.log           # Stream output + timing
        ├── agentic.log              # Request/response + tool call details
        ├── quality.log              # lm_eval output + quality scores
        └── stop.log                 # Stop command output
```

#### `benchmark.json` Schema

```json
{
  "modelKey": "qwen-q8",
  "modelLabel": "Qwen 3.6 Q8_0",
  "runtime": "gguf",
  "family": "Qwen 3.6",
  "sizeLabel": "35.82 GiB",
  "hfUrl": "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF",
  "slotUsed": "slot1",
  "publicPort": 8036,
  "backendPort": 18036,
  "benchmarks": {
    "loadTime": {
      "seconds": 12.4,
      "status": "pass"
    },
    "basicResponse": {
      "ttftSeconds": 0.8,
      "totalResponseSeconds": 2.1,
      "tokensGenerated": 15,
      "tokenCountMethod": "usage",
      "responseText": "Hello! How can I help you today?",
      "status": "pass"
    },
    "throughput": {
      "totalTokensGenerated": 892,
      "elapsedSeconds": 30.0,
      "tokensPerSecond": 29.73,
      "totalResponseSeconds": 29.8,
      "tokenCountMethod": "stream",
      "status": "pass"
    },
    "agentic": {
      "result": "pass",
      "toolCallsMade": 2,
      "toolSupport": "supported",
      "mathCorrect": true,
      "expectedValue": 5754,
      "notes": "Model used calculator tool twice, computed 42*137=5754 correctly, then factored and connected to real-world example.",
      "status": "pass"
    }
  },
  "errors": [],
  "timestamps": {
    "started": "2026-04-26T12:00:00Z",
    "loadComplete": "2026-04-26T12:00:12Z",
    "basicResponseComplete": "2026-04-26T12:00:14Z",
    "throughputComplete": "2026-04-26T12:00:44Z",
    "agenticComplete": "2026-04-26T12:00:50Z",
    "stopped": "2026-04-26T12:00:52Z"
  },
  "overallStatus": "pass"
}
```

`overallStatus` should be derived, not handwritten:
- `pass`: load succeeded and no benchmark step failed
- `partial`: load succeeded but one or more non-critical steps are `partial` / `not-applicable`
- `fail`: load failed or any critical step failed

### 2.5 Error Handling

| Error Type | Condition | Action |
|------------|-----------|--------|
| `load-timeout` | Model fails to respond on `/v1/models` within 300s | Kill process, record error, skip remaining tests |
| `basic-response-timeout` | No response to "hi" within 300s | Kill process, record error, skip remaining tests |
| `throughput-stall` | Generation starts, then no token arrives for >10s during the 30s throughput window | Stop throughput test, record error, continue to agentic |
| `throughput-start-timeout` | No first token arrives within 30s for the throughput request | Stop throughput test, record error, continue to agentic |
| `agentic-timeout` | No response to agentic prompt within 300s | Kill process, record error |
| `tool-not-supported` | Runtime cannot accept or expose OpenAI-compatible tools for this request | Record as `agentic_result: "not-applicable"`, note in `agentic_notes` |
| `generic-error` | Any other failure (launch crash, API error, etc.) | Record error message, kill process, record in `errors` array |

### 2.6 Model Execution Order

Models are tested in the following order, grouped by runtime family for launcher efficiency:

**GGUF models first** (shared `llama-server` binary, warm cache):
1. qwen-bf16
2. qwen-q8
3. qwen-q6
4. qwen-mxfp4
5. gemma4-31b
6. HauhauCS Qwen3.6-27B (Q2_K_P)
7. unsloth Qwen3.6-27B (UD-IQ2_M)
8. bartowski Gemma 4 26B (Q8_0)
9. kai-os Carnice V2 27B (Q8_0)
10. hesamation Qwen3.6 35B (Q8_0)
11. mradermacher TinyLlama 1.1B (IQ1_S)

**MLX models next** (shared MLX environment):
12. Qwen3.6-35B-A3B-mxfp4
13. Qwen3.6-35B-A3B-5bit
14. Qwen3.6-35B-A3B-6bit
15. Qwen3.6-35B-A3B-8bit
16. Qwen3.6-35B-A3B-float16
17. Huihui-Qwen36-35B-A3B-Opus-4bit
18. Huihui-Qwen36-35B-A3B-Opus-6bit
19. Huihui-Qwen36-35B-A3B-Opus-float16
20. Qwopus-GLM-18B-MLX-4bit

**DFlash models last** (speculative decoding, separate runtime):
21. Qwen3.6-27B-AEON-Ultimate-Uncensored-DFlash
22. Qwen3.6-27B-MXFP4-DFlash

**Total: 22 models**

### 2.7 Slot Rotation

Since there are only 4 slots but 22 models, slots are reused:
- Model 1 → slot1, Model 2 → slot2, Model 3 → slot3, Model 4 → slot4
- Model 5 → slot1 (after Model 1 is fully stopped), etc.
- Slot index for model N: `slot((N-1) % 4 + 1)`

Only one model benchmark should be active at a time. Slot rotation is purely a deterministic assignment rule for ports and state directories.

### 2.8 SUMMARY.md Generation

After all models complete, generate `SUMMARY.md` containing:

1. **Executive Summary** — total models tested, pass/fail counts, overall health
2. **Performance Comparison Table** — side-by-side comparison of:
   - Load time (seconds)
   - TTFT (seconds)
   - Tokens per second
   - Overall status
  3. **By Runtime Family** — aggregate stats for GGUF, MLX, and DFlash separately
  4. **By Model Size** — correlation between model size and performance
  5. **Quality Benchmarks** — MMLU and HellaSwag scores by model
  6. **Error Log** — all models that encountered errors, with error details
  7. **Agentic Test Results** — which models passed the tool-calling test
  8. **Recommendations** — best models for different use cases (speed, quality, agentic)

### 2.9 Prerequisites & Notes

- **Apple Silicon Mac required** — all runtimes (llama.cpp Metal, MLX, dflash_mlx) target Apple Silicon
- **Sufficient RAM** — the largest models (BF16, float16 at ~64GB) require a Mac with 64GB+ RAM
- **No other heavy workloads** during benchmarking to avoid noise
- **Network** — agentic test does not require external network; tool-calling is simulated via local tool definitions if the model supports them, or the test is marked "not-applicable" for runtimes without tool support
- **Model stop between tests** — each model must be fully stopped before the next one starts to avoid port conflicts

### 2.10 Tool Support Considerations

| Runtime | Tool Calling Support | Agentic Test Expectation |
|---------|---------------------|-------------------------|
| GGUF (llama.cpp) | Depends on whether the serving layer exposes OpenAI-compatible tool/function calling; `--mmproj` is unrelated and only for multimodal projector support | Run the agentic test with tools if supported; otherwise record `not-applicable` and still score text correctness in notes |
| MLX | Depends on the proxy implementation, not just the base model weights | Run the same tool payload; if rejected or ignored by the API layer, record `not-applicable` |
| DFlash | Depends on the API wrapper's support for tools; speculative decoding itself does not imply tool support | Run the same tool payload; if unsupported, record `not-applicable` |

If a model's runtime does not support tool calling, the agentic test should still be run — the model should recognize the request and respond with a coherent text answer. The test evaluates **completeness** (all three steps addressed) and **correctness** (math), even without tool use.
