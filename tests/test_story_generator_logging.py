from __future__ import annotations

import datetime as dt
import json
import logging
import tempfile
import unittest
from pathlib import Path

from scripts.story_generator_pipeline.config import PipelineConfig
from scripts.story_generator_pipeline.logging_setup import configure_logging, emit_event


class StoryGeneratorLoggingTests(unittest.TestCase):
    def _build_config(self, root: Path) -> PipelineConfig:
        return PipelineConfig(
            api_key="k",
            base_url="https://example.com/v1",
            text_model="text-model",
            image_model="image-model",
            source_dir=root,
            story_file=None,
            target_date=dt.date(2026, 3, 3),
            seed=None,
            max_source_chars=3000,
            output_root=root / "stories",
            index_file=root / "stories" / "index.json",
            summary_output_dir=root / "output",
            story_id=None,
            candidate_scenes=12,
            min_scenes=10,
            max_scenes=12,
            image_size="2K",
            watermark=False,
            concurrency=2,
            prompts_dir=root / "prompts",
            system_prompt_file="story_system_prompt.txt",
            user_prompt_template_file="story_user_prompt_template.txt",
            image_prompt_suffix_file="image_prompt_suffix.txt",
            piece_link_sfx="/assets/attach.mp3",
            default_bgm="",
            content_version=1,
            timeout_sec=30,
            poll_seconds=0.2,
            poll_attempts=10,
            run_id="run_test_logging",
            log_level="INFO",
            log_file=root / "logs" / "story_generator.log",
            log_max_bytes=1024 * 1024,
            log_backup_count=2,
            event_log_file=root / "logs" / "events.jsonl",
            event_log_max_bytes=1024 * 1024,
            event_log_backup_count=2,
            dry_run=True,
        )

    def test_configure_logging_writes_text_and_jsonl_events(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = self._build_config(root)

            runtime = configure_logging(config)
            try:
                logger = logging.getLogger("story_generator.test")
                logger.info("hello from test logger")

                emit_event(
                    "images.scene.completed",
                    run_id=config.run_id,
                    scene_id=2,
                    status="success",
                    completed=2,
                    total=10,
                    progress=0.2,
                )
            finally:
                runtime.close()

            text_log = config.log_file.read_text(encoding="utf-8")
            self.assertIn("hello from test logger", text_log)

            lines = config.event_log_file.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 1)
            event = json.loads(lines[0])
            self.assertEqual(event["event"], "images.scene.completed")
            self.assertEqual(event["run_id"], config.run_id)
            self.assertEqual(event["completed"], 2)
            self.assertEqual(event["total"], 10)


if __name__ == "__main__":
    unittest.main()
