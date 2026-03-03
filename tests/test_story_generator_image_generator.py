from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from scripts.story_generator_pipeline import image_generator
from scripts.story_generator_pipeline.models import ImageResult, SceneDraft


class _DummySession:
    async def __aenter__(self) -> "_DummySession":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None


class _DummySessionFactory:
    def __call__(self) -> _DummySession:
        return _DummySession()


class StoryGeneratorImageGeneratorTests(unittest.IsolatedAsyncioTestCase):
    async def test_generate_images_respects_semaphore_limit(self) -> None:
        scenes = [
            SceneDraft(scene_id=i + 1, title=f"s{i+1}", description="", story_text="", image_prompt="p")
            for i in range(6)
        ]

        active = 0
        peak = 0

        original = image_generator.generate_single_image

        async def fake_generate_single_image(**kwargs):  # type: ignore[no-untyped-def]
            nonlocal active, peak
            semaphore: asyncio.Semaphore = kwargs["semaphore"]
            scene: SceneDraft = kwargs["scene"]
            async with semaphore:
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.02)
                active -= 1
                return ImageResult(
                    scene_id=scene.scene_id,
                    status="success",
                    reason=None,
                    image_url="http://x/y.png",
                    local_path=Path(f"scene_{scene.scene_id:02d}.png"),
                )

        image_generator.generate_single_image = fake_generate_single_image  # type: ignore[assignment]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                results = await image_generator.generate_images_for_story(
                    scenes=scenes,
                    date_str="2026-02-27",
                    images_dir=Path(tmp),
                    api_key="k",
                    base_url="https://example.com/v1",
                    image_model="foo",
                    image_size="2K",
                    watermark=False,
                    concurrency=2,
                    timeout_sec=3,
                    poll_seconds=0.1,
                    poll_attempts=2,
                    session_factory=_DummySessionFactory(),
                )
        finally:
            image_generator.generate_single_image = original  # type: ignore[assignment]

        self.assertEqual(len(results), 6)
        self.assertLessEqual(peak, 2)

    async def test_generate_images_handles_gather_exceptions(self) -> None:
        scenes = [
            SceneDraft(scene_id=1, title="a", description="", story_text="", image_prompt="p"),
            SceneDraft(scene_id=2, title="b", description="", story_text="", image_prompt="p"),
        ]

        original = image_generator.generate_single_image

        async def fake_generate_single_image(**kwargs):  # type: ignore[no-untyped-def]
            scene: SceneDraft = kwargs["scene"]
            if scene.scene_id == 1:
                raise RuntimeError("boom")
            return ImageResult(
                scene_id=scene.scene_id,
                status="success",
                reason=None,
                image_url="http://x/y.png",
                local_path=Path(f"scene_{scene.scene_id:02d}.png"),
            )

        image_generator.generate_single_image = fake_generate_single_image  # type: ignore[assignment]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                results = await image_generator.generate_images_for_story(
                    scenes=scenes,
                    date_str="2026-02-27",
                    images_dir=Path(tmp),
                    api_key="k",
                    base_url="https://example.com/v1",
                    image_model="foo",
                    image_size="2K",
                    watermark=False,
                    concurrency=2,
                    timeout_sec=3,
                    poll_seconds=0.1,
                    poll_attempts=2,
                    session_factory=_DummySessionFactory(),
                )
        finally:
            image_generator.generate_single_image = original  # type: ignore[assignment]

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0].status, "failed")
        self.assertTrue((results[0].reason or "").startswith("gather_exception:"))
        self.assertEqual(results[1].status, "success")


if __name__ == "__main__":
    unittest.main()
