# The phonikud-upstream chatterbox runtime: where the time goes (2026-09-22)

`src/phonikud_upstream_chatterbox_api_server.py`, slot `voice-tts-1`, Hebrew TTS for podG.
Measured on the M4 Max with torch 2.14 and transformers 5.2, on real podG chunks
(episode 93cc23b4, about 60 characters and 150 speech tokens each).

## The shape of one chunk (before this change)

| Stage | Time | Share |
|---|---|---|
| Phonikud diacritics (ONNX, CPU) | 0.047 s | 2% |
| T3 decode, ~150 steps | 1.78 s | 67% |
| Flow vocoder, 10 Euler steps with CFG | 0.68 s | 26% |
| HiFT vocoder and the flow encoder | 0.13 s | 5% |

The T3 backbone is small (30 layers, hidden 1024, 16 heads). One decode step is 5.4 ms of
GPU work, but the server's loop took 10–12 ms a step. The difference is the CPU waiting for
the GPU: on Metal every host-device copy makes the CPU wait until all queued kernels are
done, and the loop had such a copy at every token.

## What made the CPU wait, and the fix

Found with a loop of 150 steps and one sync at the end, adding the parts of the server's
step one at a time (`tests/python/test_phonikud_async_decode.py` holds the proof):

| Step variant | ms a step |
|---|---|
| bare backbone | 5.4 |
| + upstream `get_fixed_embedding(i + 1)` (a `torch.tensor(int, device=mps)` at every token) | 9.9 |
| + a 2-D attention mask for the step (the mask helper reads it back) | 9.95 |
| + the whole sampling stack: penalty, min_p, top_p, Gumbel draw | 5.3 (no cost) |
| + the EOS check every 8 tokens (a device-to-host copy, ~40 ms each) | 9.6 |

`PHONIKUD_UPSTREAM_ASYNC_DECODE=true` (the default) reads the position row from the table
that is already on the device, hands the step a slice of a mask built once (or no mask,
when no row is padded), and checks for EOS every 32 tokens
(`PHONIKUD_UPSTREAM_FAST_SAMPLING_SYNC_EVERY`; 8 was the old value). Same values in, same
tokens out: 18 of 18 real chunks identical, at batch 1 and at batch 3.

The vocoder had the same defect: `add_optional_chunk_mask` runs
`(chunk_masks.sum(-1) == 0).sum().item()` to warn about an all-false row, 14 times in each
of the 10 flow steps, and returns the input mask itself in the vocoder's case. That
`.item()` was 80 percent of the vocoder's CPU time. The runtime replaces the helper in
memory for that case only (any other case goes upstream); the waveform is identical
(12 of 12 takes, max sample difference 0).

## Result on the live server, same 60 chunks

| | Old | New |
|---|---|---|
| 1 request at a time | 2.85 s a chunk, 1.98x real time | 2.10 s, 2.68x |
| 3 requests at a time (the batcher) | 1.80 s a chunk, 3.17x | 1.26 s, 4.49x |
| Takes with noise (podG's detector) | 2 of 60 | 2 of 60 |

A 23-minute episode (229 chunks) needs about 8 minutes of TTS in place of 11 at one request
at a time. The batcher (`PHONIKUD_UPSTREAM_BATCH_MAX_REQUESTS=3`, already set on the slot)
is used only when the client sends requests at the same time; podG sends one at a time
(`tts_parallelism=1` in its saved settings), so podG does not get the second row yet.

## The vocoder seed

The flow starts from random noise. Upstream seeds once before the decode, so that noise
depended on how many draws the decode made first (steps past EOS, the batch, the check
window): the same tokens gave a different waveform after any change to the decode loop,
and the old server itself gave a different waveform at batch 1 and at batch 3.
`PHONIKUD_UPSTREAM_VOCODER_SEED=1234` (the default) seeds again right before the vocoder,
so the same tokens give the same waveform whatever the decode did. `-1` = upstream.

Note that batched decode still gives OTHER tokens than single decode (the draw of a job
comes from another point of the random stream, and the left padding changes fp16
numerics). That was true before this change too. It is another take, not a worse one.

## What was measured and rejected

- `torch.compile` of the backbone with a static cache: 4.6 ms a step after a 48 ms first
  step, but the static cache changes fp16 numerics (see the 2026-09-16 notes in the file)
  and the gain over the async eager loop is small. Not used.
- fp16 flow estimator: 46 ms a call against 49. Not worth a numerics change.
- `torch.compile` of the flow estimator: no gain. The estimator is bound by GPU compute
  (the time scales with the length and the batch), so nothing cheap is left there.
- The HiFT sine source builds its harmonics on the CPU, but that is 1.2 ms a take.

## How to test

    ~/venvs/phonikud-upstream-torch214/bin/python -m pytest tests/python/test_phonikud_async_decode.py -q -W ignore

`npm test` runs the same through `tests/phonikud-async-decode.test.js`, and skips it when
the venv is absent. The venv has no pip; add packages with `uv pip install --python ...`.
