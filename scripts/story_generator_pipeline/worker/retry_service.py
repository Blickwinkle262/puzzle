"""Retry image generation service for queue worker."""

from __future__ import annotations

import asyncio
import datetime as dt
import re
from pathlib import Path

from .config import get_env
from .types import RetryImageTask

try:
    from scripts.story_generator_pipeline.config import get_required_api_key
    from scripts.story_generator_pipeline.image_generator import generate_images_for_story
    from scripts.story_generator_pipeline.models import SceneDraft
except ImportError:  # pragma: no cover - fallback for direct script execution
    from config import get_required_api_key
    from image_generator import generate_images_for_story
    from models import SceneDraft


def build_story_asset_url(local_path: Path, output_root: Path) -> str:
    try:
        normalized_output_root = output_root.resolve()
        normalized_local_path = local_path.resolve()
        relative = normalized_local_path.relative_to(normalized_output_root)
    except (OSError, ValueError):
        return ""

    return f"/content/stories/{relative.as_posix()}"


def run_retry_image_task(
    task: RetryImageTask,
    *,
    root_dir: Path,
    default_image_base_url: str,
    default_image_model: str,
) -> tuple[bool, str, str, str]:
    if not task.image_prompt:
        return False, "", "", "image_prompt is empty"

    api_key = get_required_api_key()
    base_url = get_env("AIHUBMIX_BASE_URL", "AIHUBMIX_OPENAI_BASE_URL", "OPENAI_BASE_URL", default=default_image_base_url)
    image_model = get_env("AIHUBMIX_IMAGE_MODEL", "STORY_GENERATOR_IMAGE_MODEL", default=default_image_model)

    output_root = Path(task.output_root).expanduser().resolve() if task.output_root else (root_dir / "backend" / "data" / "generated" / "content" / "stories")
    output_root.mkdir(parents=True, exist_ok=True)

    safe_run_id = re.sub(r"[^a-zA-Z0-9._-]+", "-", task.run_id).strip("-") or "retry"
    date_segment = task.target_date or dt.date.today().isoformat()
    date_segment = re.sub(r"[^0-9-]", "", date_segment) or dt.date.today().isoformat()
    retry_dir = f".review_candidates/{safe_run_id}/{date_segment}"

    scene = SceneDraft(
        scene_id=max(1, int(task.scene_id or task.scene_index or 1)),
        title=task.title or f"scene_{task.scene_index}",
        description=task.description,
        story_text=task.story_text,
        image_prompt=task.image_prompt,
        mood=task.mood,
        characters=task.characters,
        rows=max(2, int(task.grid_rows or 6)),
        cols=max(2, int(task.grid_cols or 4)),
        time_limit_sec=max(30, int(task.time_limit_sec or 180)),
    )

    results = asyncio.run(
        generate_images_for_story(
            scenes=[scene],
            date_str=retry_dir,
            images_dir=output_root,
            api_key=api_key,
            base_url=base_url,
            image_model=image_model,
            image_size=task.image_size,
            watermark=task.watermark,
            concurrency=1,
            timeout_sec=max(10.0, float(task.timeout_sec)),
            poll_seconds=max(0.2, float(task.poll_seconds)),
            poll_attempts=max(1, int(task.poll_attempts)),
        )
    )

    if not results:
        return False, "", "", "no image result"

    result = results[0]
    if result.status != "success" or result.local_path is None:
        return False, str(result.image_url or ""), "", str(result.reason or "retry image generation failed")

    local_path = result.local_path.resolve()
    image_url = build_story_asset_url(local_path, output_root)
    return True, image_url, str(local_path), ""
