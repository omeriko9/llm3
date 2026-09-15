#!/usr/bin/env python3
"""The prompt cache must size itself, and must never make the machine tighter.

llama.cpp's --cache-ram defaults to 8192 MiB per server with nothing scaling it
by how many servers run, so two loaded slots quietly commit up to 16 GiB on top
of weights, KV and compute buffers. Slot 2's log on 2026-09-10 shows it hitting
that cap and evicting entries of 1.6-4.8 GiB.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import llm3_cache_budget as budget

MIB = budget.MIB
GIB = budget.GIB
TOTAL = 128 * GIB


def plan(available_gib, weights_gib, measured_gib=None):
    return budget.plan_cache_ram_mib(
        total_bytes=TOTAL,
        available_bytes=int(available_gib * GIB),
        weights_bytes=int(weights_gib * GIB),
        measured_footprint_bytes=int(measured_gib * GIB) if measured_gib else None,
    )


class ItNeverMakesThingsWorse(unittest.TestCase):
    def test_it_never_plans_above_the_llama_cpp_default(self):
        """The whole change must only ever be able to reduce pressure."""
        for available in (40, 80, 120, 100000):
            mib, _ = plan(available, weights_gib=1)
            self.assertLessEqual(
                mib, budget.CACHE_RAM_CEILING_MIB,
                f"planned {mib} MiB with {available} GiB free, above llama.cpp's own default",
            )

    def test_an_empty_machine_still_only_gets_the_default(self):
        mib, _ = plan(available_gib=120, weights_gib=17.4)
        self.assertEqual(mib, budget.CACHE_RAM_CEILING_MIB)


class ItShrinksWhenTheMachineIsTight(unittest.TestCase):
    def test_a_second_slot_sees_what_the_first_one_took(self):
        """No slot knows about any other; live availability carries the news."""
        first, _ = plan(available_gib=120, weights_gib=17.4)
        second, _ = plan(available_gib=45, weights_gib=25.4)
        self.assertEqual(first, budget.CACHE_RAM_CEILING_MIB)
        self.assertLess(second, first, "the slot starting second must plan a smaller cache")

    def test_no_room_disables_the_cache_rather_than_over_committing(self):
        mib, why = plan(available_gib=20, weights_gib=25.4)
        self.assertEqual(mib, 0, "a machine with no room must not be handed a prompt cache")
        self.assertLess(why["spare_bytes"], 0)

    def test_a_cache_too_small_to_hold_one_prompt_is_disabled(self):
        """Between zero and the floor there is nothing worth spending memory on."""
        found_floor_case = False
        for available in range(30, 60):
            mib, _ = plan(available, weights_gib=17.4)
            self.assertTrue(
                mib == 0 or mib >= budget.CACHE_RAM_FLOOR_MIB,
                f"{available} GiB free planned {mib} MiB, between nothing and useful",
            )
            if mib == 0:
                found_floor_case = True
        self.assertTrue(found_floor_case, "the tight end of the range should include disabled cases")

    def test_headroom_is_always_left_for_the_rest_of_the_machine(self):
        _, why = plan(available_gib=120, weights_gib=1)
        self.assertGreaterEqual(why["headroom_bytes"], budget.MIN_HEADROOM_BYTES)


class ItLearnsInsteadOfGuessing(unittest.TestCase):
    def test_an_unmeasured_model_is_assumed_expensive(self):
        """A wrong first guess must cost cache, never an out-of-memory."""
        _, why = plan(available_gib=100, weights_gib=17.4)
        self.assertEqual(why["predicted_from"], "weights x 2 (never measured)")
        self.assertAlmostEqual(why["predicted_footprint_bytes"] / GIB, 34.8, places=1)

    def test_a_measurement_replaces_the_guess(self):
        _, why = plan(available_gib=100, weights_gib=17.4, measured_gib=33.0)
        self.assertEqual(why["predicted_from"], "measurement")
        self.assertAlmostEqual(why["predicted_footprint_bytes"] / GIB, 33.0, places=1)

    def test_a_cheaper_measured_model_earns_a_bigger_cache(self):
        # Chosen where the ceiling is not already binding for both, or the
        # comparison proves nothing.
        pessimistic, _ = plan(available_gib=48, weights_gib=17.4)
        measured, _ = plan(available_gib=48, weights_gib=17.4, measured_gib=20.0)
        self.assertGreater(measured, pessimistic)
        self.assertGreater(pessimistic, 0, "the pessimistic case must not be the disabled case here")


class ItRefusesAnImplausibleMeasurement(unittest.TestCase):
    def test_a_delta_that_is_not_this_model_is_rejected(self):
        weights = int(17.4 * GIB)
        self.assertTrue(budget.plausible_footprint(int(33 * GIB), weights))
        self.assertTrue(budget.plausible_footprint(int(20 * GIB), weights))
        self.assertFalse(budget.plausible_footprint(int(2 * GIB), weights), "far below the weights")
        self.assertFalse(budget.plausible_footprint(int(90 * GIB), weights), "someone else's allocation")
        self.assertFalse(budget.plausible_footprint(-int(5 * GIB), weights), "memory was freed, not taken")
        self.assertFalse(budget.plausible_footprint(int(5 * GIB), 0), "no weights to compare against")


class TheStoreIsKeyedTightly(unittest.TestCase):
    def test_context_and_cache_types_are_part_of_the_key(self):
        base = dict(model_file="/m.gguf", ctx=131072, cache_type_k="q8_0", cache_type_v="q8_0")
        same = budget.footprint_key(**base)
        self.assertEqual(same, budget.footprint_key(**base))
        self.assertNotEqual(same, budget.footprint_key(**{**base, "ctx": 65536}),
                            "KV scales with context, so context must split the key")
        self.assertNotEqual(same, budget.footprint_key(**{**base, "cache_type_k": "f16"}),
                            "cache type changes KV size, so it must split the key")

    def test_a_round_trip_survives_and_a_corrupt_store_does_not_throw(self):
        with tempfile.TemporaryDirectory() as root:
            budget.write_store(root, {"k": {"footprint_bytes": 123}})
            self.assertEqual(budget.read_store(root)["k"]["footprint_bytes"], 123)
            budget.store_path(root).write_text("{ not json", encoding="utf-8")
            self.assertEqual(budget.read_store(root), {}, "a bad store must read as empty, not raise")

    def test_a_missing_store_reads_as_empty(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(budget.read_store(root), {})


class ItReadsTheMachine(unittest.TestCase):
    def test_the_snapshot_counts_wired_because_model_buffers_live_there(self):
        snapshot = budget.memory_snapshot()
        for key in ("committed_bytes", "available_bytes", "wired_bytes"):
            self.assertIn(key, snapshot)
            self.assertGreaterEqual(snapshot[key], 0)
        self.assertGreater(snapshot["committed_bytes"], 0)

    def test_weights_include_the_vision_projector(self):
        with tempfile.TemporaryDirectory() as root:
            model = Path(root) / "m.gguf"; model.write_bytes(b"x" * 2048)
            mmproj = Path(root) / "mmproj.gguf"; mmproj.write_bytes(b"x" * 1024)
            self.assertEqual(budget.weights_bytes_for(str(model), str(mmproj)), 3072)
            self.assertEqual(budget.weights_bytes_for(str(model), ""), 2048)
            self.assertEqual(budget.weights_bytes_for("/does/not/exist"), 0,
                             "a missing file must not raise during a launch")


if __name__ == "__main__":
    unittest.main()
