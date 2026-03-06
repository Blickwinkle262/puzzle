"""Pipeline orchestration for story generator runs."""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable

from .config import PipelineConfig
from .exceptions import PipelineError
from .filter import filter_results
from .image_generator import generate_images_for_story
from .logging_setup import emit_event
from .models import ImageResult, SceneDraft, StoryDraft
from .prompts import load_prompt_bundle
from .publisher import publish_story, resolve_story_id
from .story_selector import select_story
from .story_to_json import story_to_draft

LOGGER = logging.getLogger("story_generator.workflow")


def _progress_payload(scene: SceneDraft, result: ImageResult, completed: int, total: int) -> dict[str, Any]:
    return {
        "scene_id": scene.scene_id,
        "scene_title": scene.title,
        "status": result.status,
        "reason": result.reason or "",
        "image_url": result.image_url or "",
        "local_path": str(result.local_path) if result.local_path else "",
        "completed": completed,
        "total": total,
        "progress": round((completed / total), 4) if total else 1.0,
    }


def _build_scene_candidates(
    *,
    scenes: list[SceneDraft],
    image_results: list[ImageResult],
) -> list[dict[str, Any]]:
    result_map = {item.scene_id: item for item in image_results}
    candidates: list[dict[str, Any]] = []

    for index, scene in enumerate(scenes, start=1):
        result = result_map.get(scene.scene_id)
        image_status = "pending"
        image_url = ""
        image_path = ""
        error_message = ""

        if result is not None:
            image_status = result.status if result.status in {"success", "failed", "skipped"} else "failed"
            image_url = result.image_url or ""
            image_path = str(result.local_path) if result.local_path else ""
            error_message = result.reason or ""

        candidates.append(
            {
                "scene_index": index,
                "scene_id": scene.scene_id,
                "title": scene.title,
                "description": scene.description,
                "story_text": scene.story_text,
                "image_prompt": scene.image_prompt,
                "mood": scene.mood,
                "characters": scene.characters,
                "grid_rows": int(scene.rows),
                "grid_cols": int(scene.cols),
                "time_limit_sec": int(scene.time_limit_sec),
                "image_status": image_status,
                "image_url": image_url,
                "image_path": image_path,
                "error_message": error_message,
                "selected": image_status == "success",
            }
        )

    return candidates


async def run_pipeline(
    config: PipelineConfig,
    *,
    select_story_fn: Callable[..., Any] = select_story,
    story_to_draft_fn: Callable[..., Any] = story_to_draft,
    generate_images_fn: Callable[..., Any] = generate_images_for_story,
) -> dict[str, Any]:
    started = time.perf_counter()
    date_str = config.target_date.isoformat()

    LOGGER.info("Pipeline run started: run_id=%s target_date=%s", config.run_id, date_str)
    emit_event(
        "pipeline.started",
        run_id=config.run_id,
        target_date=date_str,
        dry_run=config.dry_run,
        candidate_scenes=config.candidate_scenes,
        min_scenes=config.min_scenes,
        max_scenes=config.max_scenes,
    )

    source_story = select_story_fn(
        source_dir=config.source_dir,
        target_date=config.target_date,
        seed=config.seed,
        story_file=config.story_file,
    )
    emit_event(
        "story.selected",
        run_id=config.run_id,
        source_file=str(source_story.source_path),
        source_title=source_story.title,
        source_chars=len(source_story.text),
    )

    prompts = load_prompt_bundle(
        prompts_dir=config.prompts_dir,
        system_prompt_file=config.system_prompt_file,
        user_prompt_template_file=config.user_prompt_template_file,
        image_prompt_suffix_file=config.image_prompt_suffix_file,
    )
    emit_event("prompts.loaded", run_id=config.run_id, prompts_dir=str(config.prompts_dir))

    clipped_story = source_story
    if len(clipped_story.text) > config.max_source_chars:
        original_chars = len(clipped_story.text)
        clipped_story.text = clipped_story.text[: config.max_source_chars]
        emit_event(
            "story.clipped",
            run_id=config.run_id,
            original_chars=original_chars,
            clipped_chars=len(clipped_story.text),
        )

    draft: StoryDraft = await story_to_draft_fn(
        story=clipped_story,
        prompts=prompts,
        api_key=config.api_key,
        base_url=config.base_url,
        text_model=config.text_model,
        candidate_scenes=config.candidate_scenes,
        min_scenes=1 if config.review_mode else config.min_scenes,
        max_scenes=config.candidate_scenes,
    )
    emit_event(
        "draft.generated",
        run_id=config.run_id,
        story_title=draft.title,
        total_scenes=len(draft.scenes),
    )

    emit_event(
        "images.generation.started",
        run_id=config.run_id,
        total=len(draft.scenes),
        concurrency=config.concurrency,
        image_size=config.image_size,
    )

    def on_scene_done(scene: SceneDraft, result: ImageResult, completed: int, total: int) -> None:
        emit_event("images.scene.completed", run_id=config.run_id, **_progress_payload(scene, result, completed, total))

    image_results = await generate_images_fn(
        scenes=draft.scenes,
        date_str=date_str,
        images_dir=config.summary_output_dir / "images",
        api_key=config.api_key,
        base_url=config.base_url,
        image_model=config.image_model,
        image_size=config.image_size,
        watermark=config.watermark,
        concurrency=config.concurrency,
        timeout_sec=config.timeout_sec,
        poll_seconds=config.poll_seconds,
        poll_attempts=config.poll_attempts,
        on_scene_done=on_scene_done,
    )

    candidates = _build_scene_candidates(scenes=draft.scenes, image_results=image_results)
    success_candidates = [item for item in candidates if item["image_status"] == "success"]
    failed_candidates = [item for item in candidates if item["image_status"] != "success"]

    emit_event(
        "review.ready",
        run_id=config.run_id,
        total=len(candidates),
        success=len(success_candidates),
        failed=len(failed_candidates),
        review_mode=config.review_mode,
    )

    filtered_scenes, filtered_images, skipped = filter_results(draft.scenes, image_results)
    emit_event(
        "images.filtered",
        run_id=config.run_id,
        total=len(draft.scenes),
        successful=len(filtered_scenes),
        skipped=len(skipped),
    )

    if not config.review_mode and len(filtered_scenes) < config.min_scenes:
        emit_event(
            "pipeline.aborted",
            run_id=config.run_id,
            reason="insufficient_success",
            successful=len(filtered_scenes),
            min_required=config.min_scenes,
        )
        raise PipelineError(
            f"Only {len(filtered_scenes)} scenes succeeded (< {config.min_scenes}), publish aborted"
        )

    final_scenes = filtered_scenes[: config.max_scenes]
    final_images = filtered_images[: config.max_scenes]

    story_id = resolve_story_id(
        fixed_story_id=config.story_id,
        draft=draft,
        source_name=source_story.source_path.stem,
        target_date=config.target_date,
        output_root=config.output_root,
    )

    publish_result = {}
    if not config.dry_run and not config.review_mode:
        emit_event("publish.started", run_id=config.run_id, story_id=story_id, level_count=len(final_scenes))
        publish_result = publish_story(
            story_id=story_id,
            draft=draft,
            filtered_scenes=final_scenes,
            output_root=config.output_root,
            index_file=config.index_file,
            default_bgm=config.default_bgm,
            piece_link_sfx=config.piece_link_sfx,
            content_version=config.content_version,
        )
        publish_event_payload = dict(publish_result)
        published_story_id = str(publish_event_payload.pop("story_id", "") or "")
        if published_story_id and published_story_id != story_id:
            publish_event_payload["published_story_id"] = published_story_id
        emit_event("publish.completed", run_id=config.run_id, story_id=story_id, **publish_event_payload)
    else:
        emit_event(
            "publish.skipped",
            run_id=config.run_id,
            story_id=story_id,
            reason="review_mode" if config.review_mode else "dry_run",
        )

    summary = {
        "date": date_str,
        "run_id": config.run_id,
        "story_id": story_id,
        "title": draft.title,
        "source_file": str(source_story.source_path),
        "total_scenes": len(draft.scenes),
        "successful_scenes": len(filtered_scenes),
        "generated_scenes": len(final_scenes),
        "review_mode": config.review_mode,
        "skipped": skipped,
        "images": final_images,
        "candidates": candidates,
        "candidate_counts": {
            "total": len(candidates),
            "success": len(success_candidates),
            "failed": len(failed_candidates),
            "selected": len([item for item in candidates if item["selected"]]),
        },
        "dry_run": config.dry_run,
        "log_file": str(config.log_file),
        "event_log_file": str(config.event_log_file),
        "publish": publish_result,
    }

    summary_path = config.summary_output_dir / f"story_{date_str}.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    emit_event("summary.written", run_id=config.run_id, path=str(summary_path))

    duration_ms = int((time.perf_counter() - started) * 1000)
    emit_event(
        "pipeline.completed",
        run_id=config.run_id,
        story_id=story_id,
        duration_ms=duration_ms,
        generated_scenes=len(final_scenes),
        total_scenes=len(draft.scenes),
        dry_run=config.dry_run,
    )
    LOGGER.info(
        "Pipeline run completed: run_id=%s story_id=%s generated=%s/%s dry_run=%s duration_ms=%s",
        config.run_id,
        story_id,
        len(final_scenes),
        len(draft.scenes),
        config.dry_run,
        duration_ms,
    )

    return summary


def log(message: str) -> None:
    """Backward-compatible helper used by older callers."""

    LOGGER.info(message)
