from __future__ import annotations

import unittest
from pathlib import Path

from scripts.story_generator_pipeline.models import SourceStory
from scripts.story_generator_pipeline.story_to_json import _parse_json_payload, parse_story_draft_payload


class StoryToJsonTests(unittest.TestCase):
    def test_parse_json_payload_with_markdown_fence(self) -> None:
        raw = """```json\n[{\"scene_id\":1,\"title\":\"a\",\"description\":\"d\",\"image_prompt\":\"x\"}]\n```"""
        payload = _parse_json_payload(raw)
        self.assertIsInstance(payload, list)
        self.assertEqual(payload[0]["title"], "a")

    def test_parse_story_payload_enforces_ar_suffix_and_scene_range(self) -> None:
        source = SourceStory(title="聂小倩", text="故事", source_path=Path("x.txt"))
        payload = {
            "story_title": "聊斋·聂小倩",
            "overview_paragraphs": ["a", "b"],
            "scenes": [
                {
                    "scene_id": 3,
                    "title": "古寺初见",
                    "description": "夜色深沉",
                    "image_prompt": "moonlit old temple",
                    "grid": {"rows": 6, "cols": 4},
                }
                for _ in range(16)
            ],
        }

        draft = parse_story_draft_payload(payload, source_story=source, min_scenes=10, max_scenes=15)
        self.assertEqual(len(draft.scenes), 15)
        self.assertTrue(all("--ar 9:16" in scene.image_prompt for scene in draft.scenes))
        self.assertEqual(draft.scenes[0].scene_id, 1)
        self.assertEqual(draft.scenes[-1].scene_id, 15)


if __name__ == "__main__":
    unittest.main()
