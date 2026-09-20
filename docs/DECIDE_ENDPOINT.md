# The decide endpoint and the mlx-dspark shim

`POST /v1/decide` is a decision call ("local Jev"). The model selects one answer
from a list that the caller gives. It writes no text. The response has one
probability for each answer.

**If you are here because you want to update `mlx-dspark`, go to
[Before and after an mlx-dspark update](#before-and-after-an-mlx-dspark-update).**

## Files

| File | Function |
| --- | --- |
| `src/slot_decide.py` | The logic: prompt, labels, rotations, probabilities. No I/O. |
| `src/slot-api-proxy.py` | The routes `POST /v1/decide` and `GET /llm3/capabilities`. |
| `src/mlx-dspark-shim.py` | First-token logprobs for the dflash mode of mlx-dspark. |
| `bin/run-mlx-dspark-api.sh` | Starts mlx-dspark through the shim. |
| `tests/slot-decide.test.js` | Contract tests for the routes, with a stub backend. |
| `tests/mlx-dspark-shim.test.js` | The four shim states, with a false `mlx_dspark` package. |

## How a decision call works

1. Each answer gets a one-letter label: `A`, `B`, `C`, and so on (maximum 26).
2. The prompt lists `label = meaning` and ends with `Label:`.
3. The proxy sends one chat completion to the backend of the slot:
   `max_tokens: 1`, `temperature: 0`, `logprobs: true`, `top_logprobs: 20`,
   and the thinking mode off for this request only.
4. The backend returns the log-probabilities of the first output token.
5. The proxy reads the values of the labels, ignores all other tokens, and
   normalizes. `"A"` and `" A"` are added together.

A log-probability ("logprob") is the natural logarithm of the probability that
the model gives to a token at one position. `exp(logprob)` is the probability.

The thinking switch goes out in two forms because the backends read different
keys: `enable_thinking` (mlx-dspark) and `chat_template_kwargs.enable_thinking`
(llama-server). A slot does not have to be loaded in a non-thinking mode.

## Contract

Request:

```json
{
  "context": "Title: ...\nSnippet: ...",
  "question": "Is this source useful for an episode about X?",
  "choices": {"yes": "yes", "no": "no"},
  "rotations": 2
}
```

- `question` is required. `context` is optional.
- `choices` is an object `name -> meaning`, or a list of names. 2 to 26 entries.
- `rotations` (default 1) does the call again with a different label order and
  calculates the average. It decreases the position preference of the model.
- `top_logprobs` (default 20, maximum 100) is optional.

Response:

```json
{
  "method": "logprobs",
  "choice": "no",
  "margin": 0.997,
  "probabilities": {"yes": 0.0015, "no": 0.9985},
  "log_odds": {"yes": -6.52, "no": 6.52},
  "coverage": 0.979,
  "floored": [],
  "rotations": 2
}
```

| Field | Meaning |
| --- | --- |
| `method` | `logprobs` or `greedy` (see below) |
| `margin` | Probability of the first answer minus the second |
| `log_odds` | `ln(p / (1 - p))`. Use it as the sort key of a ranking: it keeps an order where the probabilities are all near 1.0 |
| `coverage` | The part of the full vocabulary probability that the labels got. Near 1.0 is correct. A low value shows a prompt problem or a thinking mode that is on |
| `floored` | Answers whose label was not in the top list. They get the lowest listed probability (an upper limit), not zero |

Errors: `400` for a request that the caller must correct, `502` when the backend
fails.

**A probability is not an accuracy.** It is the part that an answer got among
the listed answers. The list must be complete: add an `other` answer when it is
possibly not. Measure thresholds with labeled examples.

### The `greedy` method

When the backend returns no logprobs, the first token is the decision:

```json
{"method": "greedy", "choice": "no", "probabilities": null, "log_odds": null,
 "margin": null, "coverage": null, "votes": {"yes": 0, "no": 2}, "rotations": 2}
```

A caller that needs only the choice continues to operate. A caller that needs a
ranking must check `method`. This is the reason the contract is safe to depend
on: a backend change can decrease the quality, but it cannot break the call.

### `GET /llm3/capabilities`

```json
{"decide": "logprobs", "decideCheckedAt": 1789911774286, "decideCalls": 3, "maxChoices": 26}
```

`decide` is `unknown` until the first decision call. `?probe=1` sends one small
decision call when the value is `unknown`. The dashboard server does this one
time after each slot start. The value is also in `/llm3/activity`, so
`/api/slots/activity` carries it, and Diagnostics -> Chat shows it as `decide`.

The value comes from a real response, not from a launcher table.

## Backends

| Launcher | Logprobs | Note |
| --- | --- | --- |
| `gguf` (llama-server) | Standard function | No change was necessary |
| `mlx-dspark`, mode `dspark` or `baseline` | Standard function | |
| `mlx-dspark`, mode `dflash` | **Only through the shim** | See below |
| Other launchers | Not examined | They get `greedy` if they return no logprobs |

Measured 2026-09-20 on the M4 Max:

| Slot | Model | `coverage` | Time for one call |
| --- | --- | --- | --- |
| 2, `gguf` | Gemma4 31B QAT Q4_K_M | 0.999 | 0.66 s (89 prompt tokens) |
| 1, `mlx-dspark` dflash + shim | Qwen3.8 27B MLX 8-bit | 0.96 to 0.98 | about 0.4 s |

## The mlx-dspark shim

### The problem

mlx-dspark accepts `logprobs` / `top_logprobs` and its README lists them. But in
`mlx_dspark/generate.py` only `greedy_generate` and `speculative_generate` have
a `logprobs` parameter. `dflash_generate` has none, and `server.py` passes none
in the dflash branch of `Engine._generate_impl_inner`. The response then has no
`logprobs` key and no error. Verified on 0.15.1 and on 0.19.0.

DFlash is the fast mode for Qwen3.8 on this hardware (41 tok/s on 0.19.0), so a
different mode is not an acceptable answer. The logits are there: all generators
select the first token with `_pick(logits[0, -1], ...)` from the prefill logits.

### The decision: a shim, not a patch

We do not edit files in `site-packages`. An edit there disappears with each
package update and nothing tells you. `src/mlx-dspark-shim.py` is a file of this
repository. The launcher runs it in place of the `mlx-dspark` console script. It
replaces three names **in memory** and then calls the same `mlx_dspark.cli.main()`:

| Name | Replacement |
| --- | --- |
| `server.Engine._generate_impl_inner` | Records the `logprobs` value of the request |
| `generate._pick` | On its first call in a dflash request that asked for logprobs, sends the same logits row to the package function `_logprobs_for_block` |
| `server.dflash_generate` | Puts that one entry into `GenResult.logprobs` |

The server then writes the usual OpenAI `logprobs` block itself. All generation
runs on the one generation thread of the server, so there is no lock.

Limit: in the dflash mode only the **first** token has logprobs. A request with
`max_tokens > 1` gets one entry. A decision call reads only that one.

### The four states

The shim does a check of every name and signature before it changes anything.
The server starts in all four states.

| State | Cause | Effect on `/v1/decide` |
| --- | --- | --- |
| `active` | All names are where the shim expects them | `logprobs` |
| `native` | `dflash_generate` has a `logprobs` parameter | `logprobs` from upstream, if upstream also passes it. The shim changes nothing |
| `incompatible` | A name or a signature moved | `greedy` |
| `disabled` | `LLM3_DSPARK_SHIM=0` | `greedy` in the dflash mode |

Where to read the state:

- The slot log `~/.local/state/mlx_dspark/<slot>/mlx-dspark-api.log`, one line:
  `[llm3-shim] active: first-token logprobs for the dflash mode (mlx-dspark 0.19.0, shim v1)`
- `~/.local/state/mlx_dspark/<slot>/dspark-shim.json`
- The true result: `curl 'http://127.0.0.1:8036/llm3/capabilities?probe=1'`

### The switch

Put `LLM3_DSPARK_SHIM=0` in `.env`, then `pm2 restart llm3 --update-env`, then
start the slot again. The shim file still runs, changes nothing, and calls the
CLI. Use this first when an MLX slot shows a problem after a package update: it
tells you in one restart if the shim is the cause.

## Before and after an mlx-dspark update

The update command (the venv has no `pip`, it is a `uv` venv):

```bash
uv pip freeze --python ~/.venvs/mlx-dspark/bin/python > ~/.local/state/mlx_dspark/venv-freeze-before.txt
uv pip install --python ~/.venvs/mlx-dspark/bin/python "mlx-dspark==<version>"
```

Then, with no slot restart necessary, run the check of the shim against the new
package:

```bash
cd ~/websites/llm3 && ~/.venvs/mlx-dspark/bin/python - <<'EOF'
import importlib.util
spec = importlib.util.spec_from_file_location("shim", "src/mlx-dspark-shim.py")
shim = importlib.util.module_from_spec(spec); spec.loader.exec_module(shim)
shim.prepare()
EOF
```

Read the `[llm3-shim]` line and use this table:

| Line | What it means | What to do |
| --- | --- | --- |
| `active` | No collision | Start the slot. Do the probe. Done |
| `native` | **Upstream added logprobs to dflash** | See "When upstream supports it" |
| `incompatible: <reason>` | Upstream moved a name | See "When the shim is incompatible" |

After the slot start, always do the probe. `"decide": "logprobs"` is the only
proof that counts.

### When upstream supports it (`native`)

This is the good end of the shim. It stands down by itself, so nothing collides.

1. Start the slot and do the probe.
2. If the probe says `logprobs`: upstream is complete. Delete the shim:
   - In `bin/run-mlx-dspark-api.sh`, put `"${BIN}" serve \` back in place of the
     `"${VENV}/bin/python" "${SCRIPT_DIR:h}/src/mlx-dspark-shim.py" serve \` line,
     and delete the comment block and the `LLM3_DSPARK_SHIM_STATUS_FILE` export
     above it.
   - Delete `src/mlx-dspark-shim.py` and `tests/mlx-dspark-shim.test.js`.
   - Delete the shim sections of this document and of `AGENTS.md`.
3. If the probe says `greedy`: upstream added the parameter to the generator but
   `server.py` does not pass it in the dflash branch. Look at the call
   `res = dflash_generate(` in `Engine._generate_impl_inner`. Until upstream
   passes `logprobs=logprobs` there, the shim needs a new version that adds the
   argument in its `dflash_generate` wrapper. Increase `SHIM_VERSION`.

Possible collision to know about: upstream can return logprobs for **all**
tokens of a dflash request. That is a superset of the shim result, so
`/v1/decide` needs no change.

### When the shim is incompatible

The slot operates. Only `/v1/decide` is degraded to `greedy`, and podG continues
with choices and no ranking. There is no urgency.

1. Read the reason. It names the item that moved.
2. Open the new `generate.py` and `server.py` in
   `~/.venvs/mlx-dspark/lib/python3.12/site-packages/mlx_dspark/`.
3. Find these four things again and adapt `inspect_package()` and `install()`:
   - the function that selects the first token from the prefill logits
     (`_pick` in 0.19.0, called as `pending = _pick(logits[0, -1], ...)`);
   - the function that makes logprob entries (`_logprobs_for_block`);
   - the `logprobs` field of `GenResult`;
   - the engine method that receives the `logprobs` value of a request and
     calls `dflash_generate` (`Engine._generate_impl_inner`).
4. Increase `SHIM_VERSION`, update the false package in
   `tests/mlx-dspark-shim.test.js` if the shapes changed, run
   `node --test tests/mlx-dspark-shim.test.js`.
5. Start the slot and do the probe.

To go back to the previous package version:

```bash
uv pip install --python ~/.venvs/mlx-dspark/bin/python "mlx-dspark==0.19.0"
```

## History

| Date | Event |
| --- | --- |
| 2026-09-20 | `/v1/decide` and shim v1 written. mlx-dspark updated 0.15.1 -> 0.19.0 (only that package changed; the list before the update is in `~/.local/state/mlx_dspark/venv-freeze-0.15.1.txt`). Shim `active` on both versions. |
