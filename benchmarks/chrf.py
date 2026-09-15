#!/usr/bin/env python3
"""chrF (Popovic 2015) character n-gram F-score, dependency-free.

Used to give the Hebrew-translation benchmark column a sortable number. The
number is a similarity score against a fixed reference translation, NOT a
correctness measure -- translation quality is judged by reading the two texts
side by side in the UI. chrF is used because it is the standard automatic
metric for morphologically rich target languages like Hebrew, where word-level
metrics (BLEU) break down on the construct state and heavy affixation.

Matches sacrebleu's chrF defaults: character n-grams of order 1..6, beta=2
(recall weighted 2x precision), whitespace removed before extraction.
"""
from __future__ import annotations

from collections import Counter

DEFAULT_MAX_ORDER = 6
DEFAULT_BETA = 2.0


def _char_ngrams(text: str, order: int) -> Counter:
    # Whitespace is stripped first, as in the reference implementation, so that
    # differing line wrapping or spacing does not affect the score.
    condensed = "".join(text.split())
    if len(condensed) < order:
        return Counter()
    return Counter(condensed[i : i + order] for i in range(len(condensed) - order + 1))


def chrf_score(
    hypothesis: str,
    reference: str,
    *,
    max_order: int = DEFAULT_MAX_ORDER,
    beta: float = DEFAULT_BETA,
) -> float:
    """Return chrF in 0..1. Empty hypothesis or reference scores 0.0."""
    hypothesis = str(hypothesis or "")
    reference = str(reference or "")
    if not hypothesis.strip() or not reference.strip():
        return 0.0

    precisions: list[float] = []
    recalls: list[float] = []
    for order in range(1, max_order + 1):
        hyp_ngrams = _char_ngrams(hypothesis, order)
        ref_ngrams = _char_ngrams(reference, order)
        hyp_total = sum(hyp_ngrams.values())
        ref_total = sum(ref_ngrams.values())
        if hyp_total == 0 or ref_total == 0:
            # Order longer than one of the texts contributes nothing rather
            # than dragging the average to zero.
            continue
        overlap = sum((hyp_ngrams & ref_ngrams).values())
        precisions.append(overlap / hyp_total)
        recalls.append(overlap / ref_total)

    if not precisions or not recalls:
        return 0.0

    avg_precision = sum(precisions) / len(precisions)
    avg_recall = sum(recalls) / len(recalls)
    if avg_precision <= 0.0 and avg_recall <= 0.0:
        return 0.0

    beta_sq = beta * beta
    denominator = beta_sq * avg_precision + avg_recall
    if denominator <= 0.0:
        return 0.0
    return (1.0 + beta_sq) * avg_precision * avg_recall / denominator


def hebrew_ratio(text: str) -> float:
    """Fraction of letters that are Hebrew. Used to catch a model that ignored
    the instruction and answered in English, which can otherwise score
    non-trivially on shared punctuation, digits and Latin proper nouns."""
    letters = [c for c in str(text or "") if c.isalpha()]
    if not letters:
        return 0.0
    hebrew = sum(1 for c in letters if "֐" <= c <= "׿")
    return hebrew / len(letters)


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 3:
        print("usage: chrf.py <hypothesis-file> <reference-file>", file=sys.stderr)
        raise SystemExit(2)
    hyp = open(sys.argv[1], encoding="utf-8").read()
    ref = open(sys.argv[2], encoding="utf-8").read()
    print(round(chrf_score(hyp, ref), 4))
