#!/usr/bin/env python3
"""Answer-parsing contract for quality_eval.

Run with: python3 -m unittest discover -s benchmarks -p 'test_*.py'

Every case here is a bug that scored a real model wrong at least once.
"""
from __future__ import annotations

import unittest

from quality_eval import (
    EXTENDED_LETTER_CHOICES,
    LETTER_CHOICES,
    build_multiple_choice_prompt,
    extract_letter,
    extract_number,
)


class ExtractLetterTest(unittest.TestCase):
    def test_bare_letter_answers(self):
        for text, expected in [("B", "B"), ("(C)", "C"), ("D.", "D"), ("  **A**  ", "A")]:
            self.assertEqual(extract_letter(text), expected, text)

    def test_explicit_phrasing(self):
        self.assertEqual(extract_letter("The answer is C."), "C")
        self.assertEqual(extract_letter("Answer: D"), "D")
        self.assertEqual(extract_letter("correct option B"), "B")

    def test_english_article_is_not_an_answer(self):
        # Uppercasing the text first made the article "a" match [ABCD], so any
        # prose reply containing "a" scored as A — right 25% of the time by luck.
        self.assertIsNone(extract_letter("He picks up a towel and dries off."))
        self.assertIsNone(extract_letter("A common approach is to compare them."))

    def test_pronoun_i_is_not_an_mmlu_pro_answer(self):
        # "I" is a valid MMLU-Pro option letter AND the English pronoun.
        self.assertIsNone(
            extract_letter("I think the third option is right", letters=EXTENDED_LETTER_CHOICES)
        )
        self.assertEqual(extract_letter("I", letters=EXTENDED_LETTER_CHOICES), "I")
        self.assertEqual(extract_letter("(I)", letters=EXTENDED_LETTER_CHOICES), "I")

    def test_extended_letters_beyond_d(self):
        for text, expected in [("J.", "J"), ("Answer: H", "H"), ("(F)", "F")]:
            self.assertEqual(extract_letter(text, letters=EXTENDED_LETTER_CHOICES), expected, text)
        # The four-option tasks must not accept a ten-option letter.
        self.assertIsNone(extract_letter("H", letters=LETTER_CHOICES))

    def test_think_blocks_are_stripped(self):
        self.assertEqual(extract_letter("<think>maybe A, maybe C</think>\nC"), "C")


class ExtractNumberTest(unittest.TestCase):
    def test_explicit_answer_line(self):
        self.assertEqual(extract_number("working...\nAnswer: 70000"), "70000")
        self.assertEqual(extract_number("Answer: $1,250.50"), "1250.50")

    def test_last_number_fallback(self):
        self.assertEqual(extract_number("So the total is 42"), "42")

    def test_truncated_reply_has_no_answer(self):
        # A reply cut off at max_tokens has no final answer in it. Taking the
        # last number scored "the repairs increased the value by 150%..." as
        # 150, turning a token-budget problem into a wrong answer.
        self.assertIsNone(
            extract_number("the repairs increased the value by 150%. This usually imp", truncated=True)
        )
        self.assertEqual(extract_number("Answer: 70000 (truncated after)", truncated=True), "70000")


class PromptBuilderTest(unittest.TestCase):
    def test_four_option_prompt(self):
        prompt = build_multiple_choice_prompt("Q?", ["one", "two", "three", "four"])
        self.assertIn("A. one", prompt)
        self.assertIn("D. four", prompt)
        self.assertIn("A, B, C, or D", prompt)

    def test_ten_option_prompt_names_its_own_range(self):
        options = [f"opt{index}" for index in range(10)]
        prompt = build_multiple_choice_prompt("Q?", options, letters=EXTENDED_LETTER_CHOICES)
        self.assertIn("J. opt9", prompt)
        self.assertIn("or J.", prompt)

    def test_short_option_list_does_not_offer_missing_letters(self):
        prompt = build_multiple_choice_prompt("Q?", ["a", "b", "c"], letters=EXTENDED_LETTER_CHOICES)
        self.assertIn("C. c", prompt)
        self.assertNotIn("D.", prompt)
        self.assertIn("or C.", prompt)


if __name__ == "__main__":
    unittest.main()
