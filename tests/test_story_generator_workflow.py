from __future__ import annotations

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.story_generator_pipeline.config import PipelineConfig
from scripts.story_generator_pipeline.models import ImageResult, SceneDraft, SourceStory, StoryDraft
from scripts.story_generator_pipeline.workflow import run_pipeline


class StoryGeneratorWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_pipeline_writes_summary_in_dry_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            prompts_dir = root / "prompts"
            prompts_dir.mkdir(parents=True)
            (prompts_dir / "story_system_prompt.txt").write_text("system", encoding="utf-8")
            (prompts_dir / "story_user_prompt_template.txt").write_text(
                "name={{SOURCE_NAME}} count={{CANDIDATE_SCENES}} text={{SOURCE_TEXT}}",
                encoding="utf-8",
            )
            (prompts_dir / "image_prompt_suffix.txt").write_text("--ar 9:16", encoding="utf-8")

            source_file = root / "source.txt"
            source_file.write_text("story body", encoding="utf-8")

            config = PipelineConfig(
                api_key="k",
                base_url="https://example.com/v1",
                text_model="text-model",
                image_model="image-model",
                source_dir=root,
                story_file=source_file,
                target_date=dt.date(2026, 2, 27),
                seed=None,
                max_source_chars=2000,
                output_root=root / "stories",
                index_file=root / "stories" / "index.json",
                summary_output_dir=root / "output",
                story_id="demo-story",
                candidate_scenes=12,
                min_scenes=2,
                max_scenes=3,
                image_size="2K",
                watermark=False,
                concurrency=2,
                prompts_dir=prompts_dir,
                system_prompt_file="story_system_prompt.txt",
                user_prompt_template_file="story_user_prompt_template.txt",
                image_prompt_suffix_file="image_prompt_suffix.txt",
                piece_link_sfx="/assets/attach.mp3",
                default_bgm="",
                content_version=1,
                timeout_sec=30,
                poll_seconds=0.1,
                poll_attempts=3,
                run_id="run_test_001",
                log_level="INFO",
                log_file=root / "logs" / "pipeline.log",
                log_max_bytes=1024 * 1024,
                log_backup_count=3,
                event_log_file=root / "logs" / "events.jsonl",
                event_log_max_bytes=1024 * 1024,
                event_log_backup_count=5,
                dry_run=True,
            )

            def fake_select_story(**kwargs):  # type: ignore[no-untyped-def]
                return SourceStory(title="测试故事", text="正文", source_path=source_file)

            async def fake_story_to_draft(**kwargs):  # type: ignore[no-untyped-def]
                return StoryDraft(
                    title="测试故事",
                    subtitle="副标题",
                    description="描述",
                    overview_title="梗概",
                    overview_paragraphs=["段落1"],
                    scenes=[
                        SceneDraft(scene_id=1, title="一", description="d1", story_text="s1", image_prompt="p1 --ar 9:16"),
                        SceneDraft(scene_id=2, title="二", description="d2", story_text="s2", image_prompt="p2 --ar 9:16"),
                        SceneDraft(scene_id=3, title="三", description="d3", story_text="s3", image_prompt="p3 --ar 9:16"),
                    ],
                )

            async def fake_generate_images(**kwargs):  # type: ignore[no-untyped-def]
                return [
                    ImageResult(scene_id=1, status="success", reason=None, image_url="u1", local_path=root / "img1.png"),
                    ImageResult(scene_id=2, status="failed", reason="content_filter", image_url=None, local_path=None),
                    ImageResult(scene_id=3, status="success", reason=None, image_url="u3", local_path=root / "img3.png"),
                ]

            summary = await run_pipeline(
                config,
                select_story_fn=fake_select_story,
                story_to_draft_fn=fake_story_to_draft,
                generate_images_fn=fake_generate_images,
            )

            self.assertEqual(summary["generated_scenes"], 2)
            self.assertTrue(summary["dry_run"])

            summary_path = root / "output" / "story_2026-02-27.json"
            self.assertTrue(summary_path.exists())
            payload = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["generated_scenes"], 2)
            self.assertEqual(payload["story_id"], "demo-story")
            self.assertEqual(payload["run_id"], "run_test_001")

    async def test_run_pipeline_publish_result_with_story_id_does_not_crash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            prompts_dir = root / "prompts"
            prompts_dir.mkdir(parents=True)
            (prompts_dir / "story_system_prompt.txt").write_text("system", encoding="utf-8")
            (prompts_dir / "story_user_prompt_template.txt").write_text(
                "name={{SOURCE_NAME}} count={{CANDIDATE_SCENES}} text={{SOURCE_TEXT}}",
                encoding="utf-8",
            )
            (prompts_dir / "image_prompt_suffix.txt").write_text("--ar 9:16", encoding="utf-8")

            source_file = root / "source.txt"
            source_file.write_text("story body", encoding="utf-8")

            config = PipelineConfig(
                api_key="k",
                base_url="https://example.com/v1",
                text_model="text-model",
                image_model="image-model",
                source_dir=root,
                story_file=source_file,
                target_date=dt.date(2026, 2, 27),
                seed=None,
                max_source_chars=2000,
                output_root=root / "stories",
                index_file=root / "stories" / "index.json",
                summary_output_dir=root / "output",
                story_id="demo-story",
                candidate_scenes=12,
                min_scenes=2,
                max_scenes=3,
                image_size="2K",
                watermark=False,
                concurrency=2,
                prompts_dir=prompts_dir,
                system_prompt_file="story_system_prompt.txt",
                user_prompt_template_file="story_user_prompt_template.txt",
                image_prompt_suffix_file="image_prompt_suffix.txt",
                piece_link_sfx="/assets/attach.mp3",
                default_bgm="",
                content_version=1,
                timeout_sec=30,
                poll_seconds=0.1,
                poll_attempts=3,
                run_id="run_test_publish",
                log_level="INFO",
                log_file=root / "logs" / "pipeline.log",
                log_max_bytes=1024 * 1024,
                log_backup_count=3,
                event_log_file=root / "logs" / "events.jsonl",
                event_log_max_bytes=1024 * 1024,
                event_log_backup_count=5,
                dry_run=False,
            )

            def fake_select_story(**kwargs):  # type: ignore[no-untyped-def]
                return SourceStory(title="测试故事", text="正文", source_path=source_file)

            async def fake_story_to_draft(**kwargs):  # type: ignore[no-untyped-def]
                return StoryDraft(
                    title="测试故事",
                    subtitle="副标题",
                    description="描述",
                    overview_title="梗概",
                    overview_paragraphs=["段落1"],
                    scenes=[
                        SceneDraft(scene_id=1, title="一", description="d1", story_text="s1", image_prompt="p1 --ar 9:16"),
                        SceneDraft(scene_id=2, title="二", description="d2", story_text="s2", image_prompt="p2 --ar 9:16"),
                    ],
                )

            async def fake_generate_images(**kwargs):  # type: ignore[no-untyped-def]
                return [
                    ImageResult(scene_id=1, status="success", reason=None, image_url="u1", local_path=root / "img1.png"),
                    ImageResult(scene_id=2, status="success", reason=None, image_url="u2", local_path=root / "img2.png"),
                ]

            with patch(
                "scripts.story_generator_pipeline.workflow.publish_story",
                return_value={"story_id": "demo-story", "story_path": "x/story.json"},
            ):
                summary = await run_pipeline(
                    config,
                    select_story_fn=fake_select_story,
                    story_to_draft_fn=fake_story_to_draft,
                    generate_images_fn=fake_generate_images,
                )

            self.assertEqual(summary["story_id"], "demo-story")
            self.assertFalse(summary["dry_run"])


if __name__ == "__main__":
    unittest.main()
