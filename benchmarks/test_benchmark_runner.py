#!/usr/bin/env python3
"""Pure-function contract for benchmark_runner.

Run with: python3 -m unittest discover -s benchmarks -p 'test_*.py'
"""
from __future__ import annotations

import unittest

import benchmark_runner as br
from quality_eval import extract_math_answer, math_answers_equal, strip_think_blocks


def sample(*, tokens: int, total: float, ttft: float = 0.5, answer_tokens: int | None = None) -> br.StreamResult:
    return br.StreamResult(
        text="x" * tokens,
        reasoning_text="",
        answer_text="x" * (answer_tokens if answer_tokens is not None else tokens),
        ttft_seconds=ttft,
        total_seconds=total,
        usage={"completion_tokens": tokens},
        token_count_method="usage",
        tokens_generated=tokens,
        reasoning_tokens_generated=0,
        answer_tokens_generated=answer_tokens if answer_tokens is not None else tokens,
        finish_reason="stop",
        raw_events=[],
        first_answer_seconds=ttft,
    )


class DecodeRateTest(unittest.TestCase):
    def test_decode_rate_excludes_ttft(self):
        metrics = br.stream_result_to_benchmark_metrics(sample(tokens=100, total=10.5, ttft=0.5), status="pass")
        self.assertEqual(metrics["tokensPerSecond"], 10.0)
        self.assertEqual(metrics["totalTokensGenerated"], 100)
        self.assertTrue(metrics["completed"])

    def test_zero_window_does_not_divide_by_zero(self):
        metrics = br.stream_result_to_benchmark_metrics(sample(tokens=0, total=0.0, ttft=0.0), status="partial")
        self.assertEqual(metrics["tokensPerSecond"], 0.0)
        self.assertEqual(metrics["answerTokensPerSecond"], 0.0)


class ThroughputAggregationTest(unittest.TestCase):
    def test_median_index_picks_upper_median(self):
        self.assertEqual(br.median_index([5.0]), 0)
        self.assertEqual(br.median_index([30.0, 10.0, 20.0]), 2)  # 20 is the median
        self.assertEqual(br.median_index([10.0, 20.0]), 1)

    def test_headline_is_the_median_sample_and_spread_is_reported(self):
        samples = [
            sample(tokens=300, total=10.5),  # 30 tok/s
            sample(tokens=100, total=10.5),  # 10 tok/s
            sample(tokens=200, total=10.5),  # 20 tok/s
        ]
        metrics = br.aggregate_throughput_samples(samples, status="pass", elapsed_cap=60)
        self.assertEqual(metrics["tokensPerSecond"], 20.0)
        self.assertEqual(metrics["tokensPerSecondMedian"], 20.0)
        self.assertEqual(metrics["tokensPerSecondMin"], 10.0)
        self.assertEqual(metrics["tokensPerSecondMax"], 30.0)
        self.assertEqual(metrics["tokensPerSecondSpreadPct"], 100.0)
        self.assertEqual(metrics["repeats"], 3)
        self.assertEqual(metrics["sampleIndex"], 2)
        self.assertEqual([s["tokensPerSecond"] for s in metrics["samples"]], [30.0, 10.0, 20.0])
        self.assertEqual(metrics["status"], "pass")

    def test_single_sample_keeps_the_old_shape(self):
        metrics = br.aggregate_throughput_samples([sample(tokens=100, total=10.5)], status="partial", error_code="throughput-stall")
        self.assertEqual(metrics["repeats"], 1)
        self.assertEqual(metrics["tokensPerSecondSpreadPct"], 0.0)
        self.assertEqual(metrics["status"], "partial")

    def test_no_samples_is_an_error(self):
        with self.assertRaises(ValueError):
            br.aggregate_throughput_samples([], status="pass")


class ProvenanceTest(unittest.TestCase):
    def test_schema_version_and_sampling_profile(self):
        self.assertEqual(br.SCHEMA_VERSION, 2)
        for stage in ("basic", "agentic", "throughput", "promptProcessing"):
            self.assertEqual(br.SAMPLING_PROFILE[stage]["seed"], br.BENCHMARK_SEED, stage)
        self.assertEqual(br.SAMPLING_PROFILE["agentic"]["temperature"], 0.0)

    def test_legend_follows_the_weights(self):
        legend = br.overall_legend()
        self.assertIn("MMLU-Pro 30%", legend)
        self.assertIn("MATH-500 25%", legend)
        self.assertIn("HumanEval 25%", legend)
        self.assertIn("Scenes 2.5%", legend)
        self.assertNotIn("DeepEval 25%", legend)

    def test_prompt_processing_prompt_is_long_and_deterministic(self):
        first = br.build_prompt_processing_prompt()
        self.assertEqual(first, br.build_prompt_processing_prompt())
        self.assertGreaterEqual(len(first), br.PROMPT_PROCESSING_TARGET_CHARS)
        self.assertTrue(first.endswith("Reply with the single word OK."))

    def test_host_provenance_carries_no_hostname(self):
        self.assertNotIn("hostname", br.HOST_PROVENANCE)
        self.assertIn("cpuCount", br.HOST_PROVENANCE)


class DecodeProbeTest(unittest.TestCase):
    def test_profile_asks_every_model_for_the_same_token_count(self):
        profile = br.SAMPLING_PROFILE["decodeProbe"]
        self.assertEqual(profile["max_tokens"], br.DECODE_PROBE_TOKENS)
        self.assertIs(profile["ignore_eos"], True)
        self.assertIs(profile["cache_prompt"], False)
        self.assertEqual(profile["temperature"], 0.0)
        self.assertEqual(profile["seed"], br.BENCHMARK_SEED)

    def test_probe_prompt_is_short_so_prefill_does_not_dominate(self):
        self.assertLess(len(br.DECODE_PROBE_PROMPT), 200)

    def test_warmup_default_is_one_discarded_generation(self):
        self.assertEqual(br.DEFAULT_THROUGHPUT_WARMUP, 1)


class SlotPortMapTest(unittest.TestCase):
    """Every launcher discovery can assign must have a backend port.

    A run died at model 13 of 15 with `ValueError: Unknown runtime
    'mlx-dspark'`: discovery had produced that launcher for a long time, but
    Slot.backend_port never learned the name, so the run aborted while writing
    one informational metadata field. No MLX row had ever been recorded as a
    result. These tests read the launcher names out of the discovery code, so a
    launcher added there without a port mapping fails here instead of hours
    into a run.
    """

    def slot(self):
        return br.Slot("slot3", 8038, 18038, 18638, 18738, 18138, 18238, 18338)

    def discoverable_launchers(self):
        import re
        from pathlib import Path
        source = Path(br.__file__).read_text(encoding="utf-8")
        names = set(re.findall(r'launcher="([a-z0-9-]+)"', source))
        # The four the MLX branch maps by name, which are assigned through a
        # variable rather than a literal.
        names |= {"mlx", "rapid-mlx", "mtplx", "mlx-dspark"}
        return names

    def test_every_discoverable_launcher_has_a_backend_port(self):
        slot = self.slot()
        for launcher in sorted(self.discoverable_launchers()):
            with self.subTest(launcher=launcher):
                self.assertIsInstance(slot.backend_port(launcher), int)

    def test_direct_serving_launchers_use_the_public_port(self):
        slot = self.slot()
        for launcher in ("mlx-dspark", "mlx-vlm"):
            self.assertEqual(slot.backend_port(launcher), slot.public_port, launcher)

    def test_an_unknown_launcher_still_raises(self):
        with self.assertRaises(ValueError):
            self.slot().backend_port("not-a-launcher")

    def test_metadata_survives_an_unmapped_launcher(self):
        # One informational field must never abort a multi-model run.
        spec = br.ModelSpec.__new__(br.ModelSpec)
        object.__setattr__(spec, "launcher", "future-launcher")
        self.assertIsNone(spec.backend_port_or_none(self.slot()))


class MathScoringTest(unittest.TestCase):
    def test_boxed_and_plain_answers_compare_equal(self):
        self.assertTrue(math_answers_equal("\\frac{1}{2}", "1/2") or math_answers_equal("0.5", "0.5"))
        self.assertTrue(math_answers_equal("42", "42"))
        self.assertFalse(math_answers_equal("42", "43"))

    def test_extract_math_answer_prefers_boxed(self):
        self.assertEqual(extract_math_answer("Working... so \\boxed{17}."), "17")

    def test_think_blocks_are_stripped_before_scoring(self):
        text = "<think>the answer might be 3</think>The answer is 4."
        self.assertNotIn("might be 3", strip_think_blocks(text))


if __name__ == "__main__":
    unittest.main()
