#!/usr/bin/env python3
"""Host memory sampling and thinking effort in the runner.

Run with: python3 -m unittest discover -s benchmarks -p 'test_*.py'
"""
from __future__ import annotations

import unittest

import benchmark_runner as br
import host_memory as hm

VM_STAT = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               100000.
Pages active:                             400000.
Pages inactive:                           300000.
Pages speculative:                         20000.
Pages wired down:                         500000.
File-backed pages:                        600000.
Anonymous pages:                          120000.
Pages occupied by compressor:              10000.
"""

GB = 1024 ** 3


def model(launcher: str, runtime: str = "gguf") -> br.ModelSpec:
    return br.ModelSpec(runtime=runtime, launcher=launcher, key="k", label="Qwen3.8 Test", family="qwen", path="/m", launch_ref="/m")


def slot() -> br.Slot:
    return br.Slot("slot3", 8038, 18038, 18138, 18238, 18338, 18438, 18538)


class HostMemoryTest(unittest.TestCase):
    def test_same_formula_as_the_memory_gauge(self):
        self.assertEqual(hm.host_used_bytes_from_vm_stat(VM_STAT, 128 * GB), (500000 + 120000 + 10000) * 16384)

    def test_summary_separates_baseline_peak_and_average(self):
        summary = hm.summarize_samples([50 * GB, 30 * GB, 60 * GB], [52 * GB, 56 * GB], other_slots=["slot1"], total_bytes=128 * GB)
        self.assertEqual(summary["baselineBytes"], 30 * GB)
        self.assertEqual(summary["peakBytes"], 60 * GB)
        self.assertEqual(summary["avgBytes"], 54 * GB)
        self.assertEqual(summary["footprintPeakBytes"], 30 * GB)
        self.assertEqual(summary["footprintAvgBytes"], 24 * GB)
        self.assertEqual(summary["otherSlots"], ["slot1"])
        self.assertIsNone(hm.summarize_samples([], []))

    def test_paused_sampler_records_nothing(self):
        values = iter([10, 20, 30, 40])
        sampler = hm.HostMemorySampler("slot9", interval_seconds=60, read=lambda: next(values))
        sampler.start()
        sampler.pause()
        sampler._sample()
        sampler.resume()
        sampler.ready()
        summary = sampler.stop()
        self.assertEqual(summary["baselineBytes"], 10)
        self.assertEqual(summary["workSamples"], 1)
        self.assertEqual(summary["peakBytes"], 20)


class ThinkingEffortTest(unittest.TestCase):
    def test_gguf_think_launch_gets_the_effort_budget(self):
        cmd = model("gguf").launch_command(slot(), 8192, 1, thinking=True, reasoning_effort="low")
        self.assertIn("--thinking", cmd)
        self.assertEqual(cmd[cmd.index("--reasoning-budget") + 1], "2048")

    def test_no_think_launch_ignores_the_effort(self):
        cmd = model("gguf").launch_command(slot(), 8192, 1, thinking=False, reasoning_effort="high")
        self.assertNotIn("--reasoning-budget", cmd)

    def test_mlx_dspark_is_switched_by_reasoning_effort(self):
        spec = model("mlx-dspark", runtime="mlx")
        self.assertTrue(spec.supports_thinking_toggle())
        self.assertEqual(spec.thinking_variants(), ["no-think", "think"])
        off = spec.launch_command(slot(), 8192, 1, thinking=False)
        self.assertEqual(off[off.index("--reasoning-effort") + 1], "off")
        high = spec.launch_command(slot(), 8192, 1, thinking=True, reasoning_effort="high")
        self.assertEqual(high[high.index("--reasoning-effort") + 1], "xhigh")
        default = spec.launch_command(slot(), 8192, 1, thinking=True)
        self.assertNotIn("--reasoning-effort", default, "no level keeps the template default")

    def test_toggleable_only_drops_models_without_a_thinking_switch(self):
        args = br.parse_args(["--variant", "think", "--toggleable-only", "--reasoning-effort", "medium"])
        config = br.build_config(args)
        self.assertEqual(config.reasoning_effort, "medium")
        kept = br.resolve_models([model("gguf"), model("dflash", runtime="dflash")], config)
        self.assertEqual([spec.launcher for spec in kept], ["gguf"])
        self.assertEqual(kept[0].variant, "think")


class ServerModelListTest(unittest.TestCase):
    """llm3's /api/models decides which models and launchers are benchmarked."""

    def test_server_list_replaces_the_disk_scan(self):
        disk = [
            br.ModelSpec(runtime="gguf", launcher="gguf", key="/m/a.gguf", label="A-disk-label", family="qwen", path="/m/a.gguf", launch_ref="/m/a.gguf"),
            # A sidecar the scan mistook for a model; the server does not list it.
            br.ModelSpec(runtime="gguf", launcher="gguf", key="/m/ple.gguf", label="PLE sidecar", family="", path="/m/ple.gguf", launch_ref="/m/ple.gguf"),
            br.ModelSpec(runtime="gguf", launcher="gguf", key="/m/pack.gguf", label="Pack (pack)", family="", path="/m/pack.gguf", launch_ref="/m/pack.gguf"),
        ]
        server = [
            {"key": "/m/a.gguf", "path": "/m/a.gguf", "label": "A server", "runtime": "gguf", "benchmarkLaunchers": ["gguf"], "benchmarkExcluded": False},
            {"key": "/m/pack.gguf", "path": "/m/pack.gguf", "label": "DS4 pack", "runtime": "gguf", "benchmarkLaunchers": ["ds4"], "benchmarkExcluded": False},
            {"key": "/m/sushi", "path": "/m/sushi", "label": "Sushi", "runtime": "mlx", "benchmarkLaunchers": ["sushi"], "benchmarkExcluded": False},
            {"key": "/m/vl", "path": "/m/vl", "label": "VL", "runtime": "mlx", "launchers": ["mlx-vlm"], "benchmarkLaunchers": [], "benchmarkExcluded": True},
            {"key": "/m/dead", "path": "/m/dead", "label": "Dead", "runtime": "mlx", "launchers": [], "benchmarkLaunchers": [], "benchmarkExcluded": True, "unsupported": True},
        ]
        models = {m.key: m for m in br.models_from_server(server, disk)}
        self.assertEqual(set(models), {"/m/a.gguf", "/m/pack.gguf", "/m/sushi", "/m/vl"})
        # Excluded from measured metrics, but it loads, so it runs the scenes.
        self.assertEqual(models["/m/vl"].launcher, "mlx-vlm")
        self.assertFalse(models["/m/vl"].measurable)
        self.assertEqual(models["/m/a.gguf"].label, "A-disk-label", "same launcher keeps the label stored results use")
        self.assertTrue(models["/m/a.gguf"].measurable)
        self.assertEqual(models["/m/pack.gguf"].launcher, "ds4", "the server's launcher, not llama.cpp")
        self.assertEqual(models["/m/pack.gguf"].label, "DS4 pack")
        self.assertFalse(models["/m/pack.gguf"].measurable)
        self.assertIn("ds4", models["/m/pack.gguf"].unmeasurable_reason)
        self.assertFalse(models["/m/sushi"].measurable)
        self.assertTrue(all(m.result_dir_name for m in models.values()))

    def test_missing_list_means_disk_scan(self):
        self.assertIsNone(br.load_server_models(None))
        self.assertIsNone(br.load_server_models("/nonexistent/server-models.json"))


if __name__ == "__main__":
    unittest.main()
