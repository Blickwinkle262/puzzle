"""Filter failed image generation results and enrich successful scenes."""

from __future__ import annotations

from typing import Any

from .models import ImageResult, SceneDraft


def filter_results(
    scenes: list[SceneDraft],
    results: list[ImageResult],
) -> tuple[list[dict[str, Any]], list[str], list[dict[str, Any]]]:
    result_map = {item.scene_id: item for item in results}

    filtered_scenes: list[dict[str, Any]] = []
    filtered_images: list[str] = []
    skipped: list[dict[str, Any]] = []

    for scene in scenes:
        result = result_map.get(scene.scene_id)
        if result and result.status == "success" and result.local_path is not None:
            payload = {
                "scene_id": scene.scene_id,
                "title": scene.title,
                "description": scene.description,
                "story_text": scene.story_text,
                "image_prompt": scene.image_prompt,
                "mood": scene.mood,
                "characters": scene.characters,
                "rows": scene.rows,
                "cols": scene.cols,
                "time_limit_sec": scene.time_limit_sec,
                "image_url": result.image_url,
                "local_path": str(result.local_path),
                "generation_status": "success",
            }
            filtered_scenes.append(payload)
            filtered_images.append(str(result.local_path))
            continue

        skipped.append(
            {
                "scene_id": scene.scene_id,
                "title": scene.title,
                "reason": result.reason if result else "missing_result",
            }
        )

    return filtered_scenes, filtered_images, skipped
