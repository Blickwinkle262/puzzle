"""Atomic CLI commands for scene-first generation workflow.

Commands consume JSON from stdin and write JSON to stdout.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any

from .config import get_required_api_key
from .exceptions import PipelineError
from .image_generator import generate_images_for_story
from .models import SceneDraft
from .prompts import load_prompt_bundle
from .story_selector import select_story
from .story_to_json import story_to_draft


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Atomic story generator commands")
    parser.add_argument("command", choices=["generate-text", "generate-image", "generate-images"])
    return parser.parse_args()


def _read_request_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PipelineError(f"stdin JSON parse failed: {exc}") from exc

    if not isinstance(parsed, dict):
        raise PipelineError("stdin payload must be an object")

    return parsed


def _normalize_scene(scene: dict[str, Any], index: int) -> SceneDraft:
    scene_index = int(scene.get("scene_index") or index)
    scene_id = int(scene.get("scene_id") or scene_index)
    title = str(scene.get("title") or f"关卡 {scene_index}").strip()
    description = str(scene.get("description") or "").strip()
    story_text = str(scene.get("story_text") or description or title).strip()
    image_prompt = str(scene.get("image_prompt") or description or title).strip()
    mood = str(scene.get("mood") or "").strip()

    characters_raw = scene.get("characters") if isinstance(scene.get("characters"), list) else []
    characters = [str(item).strip() for item in characters_raw if str(item).strip()]

    try:
        rows = int(scene.get("grid_rows") or 6)
    except (TypeError, ValueError):
        rows = 6
    rows = max(2, min(20, rows))

    try:
        cols = int(scene.get("grid_cols") or 4)
    except (TypeError, ValueError):
        cols = 4
    cols = max(2, min(20, cols))

    try:
        time_limit_sec = int(scene.get("time_limit_sec") or 180)
    except (TypeError, ValueError):
        time_limit_sec = 180
    time_limit_sec = max(30, min(3600, time_limit_sec))

    return SceneDraft(
        scene_id=scene_id,
        title=title,
        description=description,
        story_text=story_text,
        image_prompt=image_prompt,
        mood=mood,
        characters=characters,
        rows=rows,
        cols=cols,
        time_limit_sec=time_limit_sec,
    )


async def run_generate_text(payload: dict[str, Any]) -> dict[str, Any]:
    story_file = str(payload.get("story_file") or "").strip()
    if not story_file:
        raise PipelineError("story_file is required")

    source_dir = Path(str(payload.get("source_dir") or Path(story_file).resolve().parent))
    target_date_text = str(payload.get("target_date") or dt.date.today().isoformat()).strip()
    try:
        target_date = dt.date.fromisoformat(target_date_text)
    except ValueError as exc:
        raise PipelineError("target_date must be YYYY-MM-DD") from exc

    max_source_chars = int(payload.get("max_source_chars") or 12000)
    max_source_chars = max(1000, min(80000, max_source_chars))

    candidate_scenes = int(payload.get("candidate_scenes") or payload.get("scene_count") or 12)
    min_scenes = int(payload.get("min_scenes") or max(6, candidate_scenes - 2))
    max_scenes = int(payload.get("max_scenes") or candidate_scenes)
    candidate_scenes = max(6, min(60, candidate_scenes))
    min_scenes = max(1, min(candidate_scenes, min_scenes))
    max_scenes = max(min_scenes, min(60, max_scenes))

    prompts_dir = Path(str(payload.get("prompts_dir") or Path(__file__).resolve().parent / "prompts"))
    system_prompt_file = str(payload.get("system_prompt_file") or "story_system_prompt.txt")
    user_prompt_template_file = str(payload.get("user_prompt_template_file") or "story_user_prompt_template.txt")
    image_prompt_suffix_file = str(payload.get("image_prompt_suffix_file") or "image_prompt_suffix.txt")

    api_key = get_required_api_key(str(payload.get("api_key") or "").strip() or None)
    base_url = str(payload.get("base_url") or "https://aihubmix.com/v1").strip()
    text_model = str(payload.get("text_model") or "gpt-4o-mini").strip()

    source_story = select_story(
        source_dir=source_dir,
        target_date=target_date,
        seed=None,
        story_file=Path(story_file),
    )
    if len(source_story.text) > max_source_chars:
        source_story.text = source_story.text[:max_source_chars]

    prompts = load_prompt_bundle(
        prompts_dir=prompts_dir,
        system_prompt_file=system_prompt_file,
        user_prompt_template_file=user_prompt_template_file,
        image_prompt_suffix_file=image_prompt_suffix_file,
    )

    draft = await story_to_draft(
        story=source_story,
        prompts=prompts,
        api_key=api_key,
        base_url=base_url,
        text_model=text_model,
        candidate_scenes=candidate_scenes,
        min_scenes=min_scenes,
        max_scenes=max_scenes,
    )

    scenes = []
    for index, scene in enumerate(draft.scenes, start=1):
        scenes.append(
            {
                "scene_index": index,
                "scene_id": int(scene.scene_id),
                "title": scene.title,
                "description": scene.description,
                "story_text": scene.story_text,
                "image_prompt": scene.image_prompt,
                "mood": scene.mood,
                "characters": scene.characters,
                "grid_rows": int(scene.rows),
                "grid_cols": int(scene.cols),
                "time_limit_sec": int(scene.time_limit_sec),
                "text_status": "ready",
                "image_status": "pending",
            }
        )

    return {
        "title": draft.title,
        "description": draft.description,
        "story_overview_title": draft.overview_title,
        "story_overview_paragraphs": draft.overview_paragraphs,
        "source_file": str(source_story.source_path),
        "total_scenes": len(scenes),
        "scenes": scenes,
    }


async def run_generate_images(payload: dict[str, Any], *, batch: bool) -> dict[str, Any]:
    scenes_raw = payload.get("scenes") if isinstance(payload.get("scenes"), list) else []
    if not scenes_raw:
        raise PipelineError("scenes is required")

    normalized_scenes = [_normalize_scene(item, index + 1) for index, item in enumerate(scenes_raw)]
    if not batch:
        normalized_scenes = normalized_scenes[:1]

    target_date_text = str(payload.get("target_date") or dt.date.today().isoformat()).strip()
    try:
        target_date = dt.date.fromisoformat(target_date_text)
    except ValueError as exc:
        raise PipelineError("target_date must be YYYY-MM-DD") from exc

    images_dir = Path(str(payload.get("images_dir") or ".")).resolve()
    images_dir.mkdir(parents=True, exist_ok=True)

    api_key = get_required_api_key(str(payload.get("api_key") or "").strip() or None)
    base_url = str(payload.get("base_url") or "https://aihubmix.com/v1").strip()
    image_model = str(payload.get("image_model") or "doubao/doubao-seedream-4-5-251128").strip()
    image_size = str(payload.get("image_size") or "2K").strip()
    watermark = bool(payload.get("watermark"))
    concurrency = int(payload.get("concurrency") or (3 if batch else 1))
    timeout_sec = float(payload.get("timeout_sec") or 120.0)
    poll_seconds = float(payload.get("poll_seconds") or 2.5)
    poll_attempts = int(payload.get("poll_attempts") or 40)

    results = await generate_images_for_story(
        scenes=normalized_scenes,
        date_str=target_date.isoformat(),
        images_dir=images_dir,
        api_key=api_key,
        base_url=base_url,
        image_model=image_model,
        image_size=image_size,
        watermark=watermark,
        concurrency=max(1, concurrency),
        timeout_sec=max(5.0, timeout_sec),
        poll_seconds=max(0.2, poll_seconds),
        poll_attempts=max(1, poll_attempts),
    )

    by_scene_id = {item.scene_id: item for item in results}
    payloads: list[dict[str, Any]] = []
    for index, scene in enumerate(normalized_scenes, start=1):
        result = by_scene_id.get(scene.scene_id)
        if result is None:
            payloads.append(
                {
                    "scene_index": index,
                    "scene_id": int(scene.scene_id),
                    "status": "failed",
                    "error_message": "missing_result",
                    "image_url": "",
                    "image_path": "",
                }
            )
            continue

        payloads.append(
            {
                "scene_index": index,
                "scene_id": int(scene.scene_id),
                "status": str(result.status),
                "error_message": str(result.reason or ""),
                "image_url": str(result.image_url or ""),
                "image_path": str(result.local_path.resolve()) if result.local_path else "",
            }
        )

    return {
        "results": payloads,
        "count": len(payloads),
    }


async def run_command(args: argparse.Namespace, payload: dict[str, Any]) -> dict[str, Any]:
    if args.command == "generate-text":
        return await run_generate_text(payload)

    if args.command == "generate-image":
        if isinstance(payload.get("scene"), dict):
            scene_payload = dict(payload)
            scene_payload["scenes"] = [payload["scene"]]
            payload = scene_payload
        return await run_generate_images(payload, batch=False)

    if args.command == "generate-images":
        return await run_generate_images(payload, batch=True)

    raise PipelineError(f"unsupported command: {args.command}")


def main() -> int:
    args = parse_args()
    try:
        payload = _read_request_payload()
        result = asyncio.run(run_command(args, payload))
        sys.stdout.write(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        sys.stdout.write("\n")
        return 0
    except PipelineError as exc:
        sys.stderr.write(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.stderr.write("\n")
        return 1
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(json.dumps({"ok": False, "error": f"unexpected:{type(exc).__name__}:{exc}"}, ensure_ascii=False))
        sys.stderr.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
