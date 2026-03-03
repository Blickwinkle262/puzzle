from __future__ import annotations

import datetime as dt
import tempfile
import unittest
from pathlib import Path

from scripts.story_generator_pipeline.story_selector import select_story


class StoryGeneratorSelectorTests(unittest.TestCase):
    def test_select_story_is_deterministic_for_same_date(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.txt").write_text("A", encoding="utf-8")
            (root / "b.txt").write_text("B", encoding="utf-8")
            (root / "c.txt").write_text("C", encoding="utf-8")

            date_value = dt.date(2026, 2, 27)
            first = select_story(source_dir=root, target_date=date_value)
            second = select_story(source_dir=root, target_date=date_value)

            self.assertEqual(first.source_path, second.source_path)
            self.assertEqual(first.text, second.text)

    def test_select_story_supports_fixed_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixed = root / "fixed.txt"
            fixed.write_text("hello", encoding="utf-8")

            selected = select_story(
                source_dir=root,
                target_date=dt.date(2026, 2, 27),
                story_file=fixed,
            )
            self.assertEqual(selected.title, "fixed")
            self.assertEqual(selected.text, "hello")


if __name__ == "__main__":
    unittest.main()
