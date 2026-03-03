from __future__ import annotations

import unittest
from pathlib import Path

from scripts.story_generator_pipeline.filter import filter_results
from scripts.story_generator_pipeline.models import ImageResult, SceneDraft


class StoryGeneratorFilterTests(unittest.TestCase):
    def test_filter_results_keeps_only_success(self) -> None:
        scenes = [
            SceneDraft(scene_id=1, title="A", description="", story_text="", image_prompt="p1"),
            SceneDraft(scene_id=2, title="B", description="", story_text="", image_prompt="p2"),
        ]
        results = [
            ImageResult(scene_id=1, status="success", reason=None, image_url="u1", local_path=Path("a.png")),
            ImageResult(scene_id=2, status="failed", reason="content_filter", image_url=None, local_path=None),
        ]

        kept, images, skipped = filter_results(scenes, results)
        self.assertEqual(len(kept), 1)
        self.assertEqual(images, ["a.png"])
        self.assertEqual(len(skipped), 1)
        self.assertEqual(skipped[0]["scene_id"], 2)


if __name__ == "__main__":
    unittest.main()
