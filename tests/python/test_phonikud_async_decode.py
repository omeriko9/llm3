"""The async-decode changes of src/phonikud_upstream_chatterbox_api_server.py.

Runs in the TTS venv (it needs torch and chatterbox), with the real model on the
device: the claims are about numerics and about the GPU pipeline, and a fake would
prove nothing. About a minute. Run:

    ~/venvs/phonikud-upstream-torch214/bin/python -m pytest tests/python/test_phonikud_async_decode.py -q
"""
import os
import sys
import time
from pathlib import Path

import pytest

os.environ.update({
    "PHONIKUD_UPSTREAM_T3_DTYPE": "float16", "PHONIKUD_UPSTREAM_DISABLE_WATERMARK": "true",
    "PHONIKUD_UPSTREAM_STAGE_MEMORY_LOG": "false", "PHONIKUD_UPSTREAM_PREFILL_BUCKET": "0",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
torch = pytest.importorskip("torch")
S = pytest.importorskip("phonikud_upstream_chatterbox_api_server")

TEXTS = [
    "ב-20 במרץ 1800, וולטה שלח מכתב ללונדון. המכתב הופנה לסר ג'וזף בנקס.",
    "הוא תיאר מבנה שהיה אז חדשני: ערימה של דיסקיות אבץ ונחושת.",
    "בשנת 1836, ג'ון פרדריק דניאל הציע פתרון לבעיית הקיטוב.",
]
PARAMS = {"cfg_weight": 0.5, "temperature": 0.8, "repetition_penalty": 2.0, "min_p": 0.05, "top_p": 1.0}


@pytest.fixture(scope="module")
def loaded():
    if not torch.backends.mps.is_available():
        pytest.skip("the claims are about the Metal pipeline")
    phon, model = S.ensure_models()
    conds = S.get_conditionals_for_voice(model, S.resolve_prompt_path(S.DEFAULT_VOICE), 0.5)
    embeds = [S._prepare_job_prefill_embeds(model, S.normalize_hebrew_text(phon, t), conds, 0.5) for t in TEXTS]
    return model, conds, embeds


def _decode(model, embeds, *, async_decode, sync_every, batch):
    S.ASYNC_DECODE, S.FAST_SAMPLING_SYNC_EVERY = async_decode, sync_every
    out = []
    for start in range(0, len(embeds), batch):
        S.seed_rng(1234)
        out += [tok.tolist() for tok, _ in S._batched_t3_decode(model.t3, embeds[start:start + batch], PARAMS)]
    return out


def test_the_position_row_is_the_upstream_value(loaded):
    model, _, _ = loaded
    for index in (1, 17, 300):
        ours = S._speech_position_embedding(model.t3, index)
        theirs = model.t3.speech_pos_emb.get_fixed_embedding(index)
        assert ours.shape == theirs.shape == (1, 1, theirs.size(-1))
        assert torch.equal(ours, theirs)


def test_async_decode_gives_the_same_tokens_and_is_faster(loaded):
    model, _, embeds = loaded
    for batch in (1, 3):
        _decode(model, embeds, async_decode=False, sync_every=8, batch=batch)   # warm: Metal compiles per shape
        _decode(model, embeds, async_decode=True, sync_every=32, batch=batch)
        torch.mps.synchronize(); t = time.perf_counter()
        old = _decode(model, embeds, async_decode=False, sync_every=8, batch=batch)
        torch.mps.synchronize(); t_old = time.perf_counter() - t; t = time.perf_counter()
        new = _decode(model, embeds, async_decode=True, sync_every=32, batch=batch)
        torch.mps.synchronize(); t_new = time.perf_counter() - t
        assert old == new, f"batch {batch}: the tokens changed"
        assert t_new < t_old * 0.85, f"batch {batch}: {t_old:.2f}s -> {t_new:.2f}s is not the measured gain"


def test_the_chunk_mask_is_upstreams_for_the_vocoder_case_and_defers_otherwise(loaded):
    masks = torch.tensor([[[True, True, False]]])
    xs = torch.zeros(1, 3, 4)
    ours = S._chunk_mask_without_sync(xs, masks, False, False, 0, 0, -1)
    theirs = S._upstream_add_optional_chunk_mask(xs, masks, False, False, 0, 0, -1)
    assert torch.equal(ours, theirs)
    # A static chunk size is not the vocoder's case: upstream builds a chunk mask.
    chunked = S._chunk_mask_without_sync(xs, masks, False, False, 0, 2, -1)
    assert chunked.shape == (1, 3, 3)
    assert torch.equal(chunked, S._upstream_add_optional_chunk_mask(xs, masks, False, False, 0, 2, -1))


def test_the_vocoder_waveform_is_identical_with_the_patch(loaded):
    model, conds, embeds = loaded
    from chatterbox.models.s3gen import decoder as D
    S.ASYNC_DECODE, S.FAST_SAMPLING_SYNC_EVERY = True, 32
    S.seed_rng(1234)
    (tokens, _), = S._batched_t3_decode(model.t3, embeds[:1], PARAMS)
    waves = {}
    for label, fn in (("upstream", S._upstream_add_optional_chunk_mask), ("patched", S._chunk_mask_without_sync)):
        D.add_optional_chunk_mask = fn
        S.seed_rng(7)
        waves[label] = S._vocode_speech_tokens(model, tokens, conds)
    D.add_optional_chunk_mask = S._chunk_mask_without_sync
    assert torch.equal(waves["upstream"], waves["patched"])


def test_the_vocoder_noise_no_longer_depends_on_the_decode(loaded):
    """Same tokens, different decode paths (check window 8 against 32): same waveform only with the vocoder seed."""
    model, conds, embeds = loaded
    waves = []
    for every in (8, 32):
        S.ASYNC_DECODE, S.FAST_SAMPLING_SYNC_EVERY = True, every
        S.seed_rng(1234)
        (tokens, _), = S._batched_t3_decode(model.t3, embeds[:1], PARAMS)
        S.seed_rng(S.VOCODER_SEED)  # what _process does before the vocoder
        waves.append((tokens.tolist(), S._vocode_speech_tokens(model, tokens, conds)))
    assert waves[0][0] == waves[1][0]
    assert torch.equal(waves[0][1], waves[1][1])
