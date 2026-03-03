"""Seedream image generation with async concurrency control."""

from __future__ import annotations

import asyncio
import inspect
import logging
import re
from pathlib import Path
from typing import Any, Callable

from .exceptions import PipelineError
from .models import ImageResult, SceneDraft

LOGGER = logging.getLogger("story_generator.image_generator")

CONTENT_FILTER_KEYWORDS = (
    "content_filter",
    "safety",
    "审核",
    "violation",
    "inappropriate",
    "sensitive",
    "blocked",
    "moderation",
)


def _safe_slug(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", text).strip("_").lower()
    return slug or "scene"


def _extract_image_url(data: Any) -> str:
    if isinstance(data, str):
        value = data.strip()
        if value.startswith("http://") or value.startswith("https://"):
            return value
        return ""

    if isinstance(data, list):
        for item in data:
            found = _extract_image_url(item)
            if found:
                return found
        return ""

    if isinstance(data, dict):
        for key in ("output", "url", "image", "images", "data", "result"):
            if key in data:
                found = _extract_image_url(data[key])
                if found:
                    return found
        for item in data.values():
            found = _extract_image_url(item)
            if found:
                return found

    return ""


def _as_content_filter_reason(message: str) -> str:
    lowered = message.lower()
    return "content_filter" if any(word in lowered for word in CONTENT_FILTER_KEYWORDS) else "api_error"


def _infer_suffix(url: str) -> str:
    lowered = url.lower()
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        if lowered.endswith(ext):
            return ext
    return ".png"


async def _poll_prediction(
    *,
    session: Any,
    poll_url: str,
    headers: dict[str, str],
    timeout_sec: float,
    poll_seconds: float,
    poll_attempts: int,
) -> dict[str, Any]:
    for _ in range(poll_attempts):
        await asyncio.sleep(poll_seconds)
        async with session.get(poll_url, headers=headers, timeout=timeout_sec) as response:
            data = await response.json(content_type=None)

        status = str(data.get("status") or "").lower()
        if status in {"failed", "canceled", "cancelled", "error"}:
            raise PipelineError(f"prediction failed with status={status}")

        if _extract_image_url(data):
            return data

    raise PipelineError("prediction polling timed out")


async def generate_single_image(
    *,
    session: Any,
    scene: SceneDraft,
    output_dir: Path,
    semaphore: asyncio.Semaphore,
    api_url: str,
    headers: dict[str, str],
    image_size: str,
    watermark: bool,
    timeout_sec: float,
    poll_seconds: float,
    poll_attempts: int,
) -> ImageResult:
    async with semaphore:
        payload = {
            "input": {
                "prompt": scene.image_prompt,
                "size": image_size,
                "sequential_image_generation": "disabled",
                "stream": False,
                "response_format": "url",
                "watermark": bool(watermark),
            }
        }

        try:
            async with session.post(api_url, headers=headers, json=payload, timeout=timeout_sec) as response:
                data = await response.json(content_type=None)
                if response.status >= 400:
                    reason = _as_content_filter_reason(str(data))
                    return ImageResult(
                        scene_id=scene.scene_id,
                        status="failed",
                        reason=reason,
                        image_url=None,
                        local_path=None,
                    )

            image_url = _extract_image_url(data)
            if not image_url:
                urls_obj = data.get("urls") if isinstance(data.get("urls"), dict) else {}
                poll_url = urls_obj.get("get") if isinstance(urls_obj.get("get"), str) else ""
                prediction_id = data.get("id") if isinstance(data.get("id"), str) else ""
                if not poll_url and prediction_id:
                    poll_url = f"{api_url.rstrip('/')}/{prediction_id}"

                if not poll_url:
                    return ImageResult(
                        scene_id=scene.scene_id,
                        status="failed",
                        reason="no_url",
                        image_url=None,
                        local_path=None,
                    )

                polled = await _poll_prediction(
                    session=session,
                    poll_url=poll_url,
                    headers=headers,
                    timeout_sec=timeout_sec,
                    poll_seconds=poll_seconds,
                    poll_attempts=poll_attempts,
                )
                image_url = _extract_image_url(polled)

            if not image_url:
                return ImageResult(
                    scene_id=scene.scene_id,
                    status="failed",
                    reason="no_url",
                    image_url=None,
                    local_path=None,
                )

            file_name = f"scene_{scene.scene_id:02d}_{_safe_slug(scene.title)}{_infer_suffix(image_url)}"
            local_path = output_dir / file_name

            async with session.get(image_url, timeout=timeout_sec) as image_response:
                if image_response.status >= 400:
                    return ImageResult(
                        scene_id=scene.scene_id,
                        status="failed",
                        reason="download_failed",
                        image_url=image_url,
                        local_path=None,
                    )
                content = await image_response.read()

            if not content:
                return ImageResult(
                    scene_id=scene.scene_id,
                    status="failed",
                    reason="download_empty",
                    image_url=image_url,
                    local_path=None,
                )

            local_path.write_bytes(content)
            return ImageResult(
                scene_id=scene.scene_id,
                status="success",
                reason=None,
                image_url=image_url,
                local_path=local_path,
            )
        except asyncio.TimeoutError:
            return ImageResult(
                scene_id=scene.scene_id,
                status="failed",
                reason="timeout",
                image_url=None,
                local_path=None,
            )
        except Exception as exc:  # noqa: BLE001
            return ImageResult(
                scene_id=scene.scene_id,
                status="failed",
                reason=f"exception:{str(exc)[:120]}",
                image_url=None,
                local_path=None,
            )


async def generate_images_for_story(
    *,
    scenes: list[SceneDraft],
    date_str: str,
    images_dir: Path,
    api_key: str,
    base_url: str,
    image_model: str,
    image_size: str,
    watermark: bool,
    concurrency: int,
    timeout_sec: float,
    poll_seconds: float,
    poll_attempts: int,
    on_scene_done: Callable[[SceneDraft, ImageResult, int, int], Any] | None = None,
    session_factory: Any = None,
) -> list[ImageResult]:
    story_dir = images_dir / date_str
    story_dir.mkdir(parents=True, exist_ok=True)

    semaphore = asyncio.Semaphore(max(1, concurrency))
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    api_url = f"{base_url.rstrip('/')}/models/{image_model}/predictions"

    if session_factory is None:
        try:
            import aiohttp
        except ImportError as exc:  # pragma: no cover
            raise PipelineError("aiohttp package is required for image generation") from exc

        def _default_session_factory() -> Any:
            timeout = aiohttp.ClientTimeout(total=timeout_sec)
            return aiohttp.ClientSession(timeout=timeout)

        session_factory = _default_session_factory

    async with session_factory() as session:

        async def _run_scene(scene: SceneDraft) -> tuple[SceneDraft, ImageResult]:
            try:
                result = await generate_single_image(
                    session=session,
                    scene=scene,
                    output_dir=story_dir,
                    semaphore=semaphore,
                    api_url=api_url,
                    headers=headers,
                    image_size=image_size,
                    watermark=watermark,
                    timeout_sec=timeout_sec,
                    poll_seconds=poll_seconds,
                    poll_attempts=poll_attempts,
                )
                return scene, result
            except BaseException as exc:  # noqa: BLE001
                return scene, ImageResult(
                    scene_id=scene.scene_id,
                    status="failed",
                    reason=f"gather_exception:{type(exc).__name__}",
                    image_url=None,
                    local_path=None,
                )

        total = len(scenes)
        completed = 0
        by_scene_id: dict[int, ImageResult] = {}
        tasks = [asyncio.create_task(_run_scene(scene)) for scene in scenes]

        for task in asyncio.as_completed(tasks):
            scene, result = await task
            completed += 1
            by_scene_id[scene.scene_id] = result

            if on_scene_done is None:
                continue

            try:
                callback_result = on_scene_done(scene, result, completed, total)
                if inspect.isawaitable(callback_result):
                    await callback_result
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("on_scene_done callback failed for scene_id=%s: %s", scene.scene_id, exc)

        normalized: list[ImageResult] = []
        for scene in scenes:
            result = by_scene_id.get(
                scene.scene_id,
                ImageResult(
                    scene_id=scene.scene_id,
                    status="failed",
                    reason="missing_result",
                    image_url=None,
                    local_path=None,
                ),
            )
            normalized.append(result)

        return normalized
