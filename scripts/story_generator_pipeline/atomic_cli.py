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
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

from .config import DEFAULT_BASE_URL, DEFAULT_IMAGE_MODEL, DEFAULT_TEXT_MODEL, get_required_api_key
from .exceptions import PipelineError
from .image_generator import generate_images_for_story
from .models import SceneDraft
from .prompts import load_prompt_bundle
from .story_selector import select_story
from .story_to_json import story_to_draft


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Atomic story generator commands")
    parser.add_argument("command", choices=["generate-text", "generate-image", "generate-images", "check-connection"])
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
    base_url = str(payload.get("base_url") or DEFAULT_BASE_URL).strip()
    text_model = str(payload.get("text_model") or DEFAULT_TEXT_MODEL).strip()

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
    base_url = str(payload.get("base_url") or DEFAULT_BASE_URL).strip()
    image_model = str(payload.get("image_model") or DEFAULT_IMAGE_MODEL).strip()
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


async def run_check_connection(payload: dict[str, Any]) -> dict[str, Any]:
    api_key = get_required_api_key(str(payload.get("api_key") or "").strip() or None)
    base_url = str(payload.get("base_url") or DEFAULT_BASE_URL).strip()
    text_model = str(payload.get("text_model") or DEFAULT_TEXT_MODEL).strip()
    summary_model = str(payload.get("summary_model") or text_model).strip()
    image_model = str(payload.get("image_model") or DEFAULT_IMAGE_MODEL).strip()

    try:
        from openai import AsyncOpenAI
    except ImportError as exc:  # pragma: no cover - dependency error path
        raise PipelineError("openai package is required for check-connection") from exc

    normalized_base_url = str(base_url or "").strip().rstrip("/")

    def build_base_url_candidates(value: str) -> list[str]:
        current = str(value or "").strip().rstrip("/")
        if not current:
            return []

        candidates = [current]
        parsed = urlsplit(current)
        path = str(parsed.path or "").rstrip("/")
        if not path.endswith("/v1"):
            next_path = f"{path}/v1" if path else "/v1"
            next_url = urlunsplit((parsed.scheme, parsed.netloc, next_path, parsed.query, parsed.fragment)).rstrip("/")
            if next_url and next_url not in candidates:
                candidates.append(next_url)
        return candidates

    def should_retry_with_v1(error: Exception) -> bool:
        status_code = getattr(error, "status_code", None)
        if status_code is None:
            response_obj = getattr(error, "response", None)
            status_code = getattr(response_obj, "status_code", None)
        if isinstance(status_code, int):
            return status_code in (301, 302, 307, 308, 404, 405)

        message = str(error or "").lower()
        return "404" in message or "not found" in message

    def extract_model_ids(raw: Any) -> list[str]:
        rows: Any = None
        if isinstance(raw, dict):
            rows = raw.get("data")
            if not isinstance(rows, list):
                rows = raw.get("models")
        elif isinstance(raw, list):
            rows = raw
        else:
            rows = getattr(raw, "data", None)
            if not isinstance(rows, list):
                rows = getattr(raw, "models", None)

        if not isinstance(rows, list):
            return []

        ids: list[str] = []
        seen: set[str] = set()
        for item in rows:
            if isinstance(item, dict):
                model_id = str(item.get("id") or item.get("model") or item.get("name") or "").strip()
            else:
                model_id = str(getattr(item, "id", "") or getattr(item, "model", "") or "").strip()
            if model_id and model_id not in seen:
                seen.add(model_id)
                ids.append(model_id)
        return ids

    async def fetch_models_via_http(base_url_candidate: str) -> list[str]:
        endpoint = f"{base_url_candidate.rstrip('/')}/models"

        def _request() -> Any:
            request = Request(
                endpoint,
                method="GET",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Accept": "application/json",
                },
            )
            with urlopen(request, timeout=25) as response_obj:
                body = response_obj.read()
                charset = response_obj.headers.get_content_charset() or "utf-8"
                payload_text = body.decode(charset, errors="replace")
                return json.loads(payload_text)

        raw_payload = await asyncio.to_thread(_request)
        return extract_model_ids(raw_payload)

    model_ids: list[str] = []
    models_loaded = False
    resolved_base_url = normalized_base_url
    last_error: Exception | None = None

    candidates = build_base_url_candidates(normalized_base_url) or [normalized_base_url]
    for index, candidate in enumerate(candidates):
        client = AsyncOpenAI(api_key=api_key, base_url=candidate)
        try:
            response = await client.models.list()
            model_ids = extract_model_ids(response)
            if not model_ids:
                try:
                    model_ids = await fetch_models_via_http(candidate)
                except Exception:
                    pass
            resolved_base_url = candidate
            models_loaded = True
            break
        except Exception as sdk_error:
            last_error = sdk_error
            try:
                model_ids = await fetch_models_via_http(candidate)
                resolved_base_url = candidate
                models_loaded = True
                break
            except Exception as http_error:
                last_error = http_error
                can_retry = index == 0 and len(candidates) > 1 and should_retry_with_v1(sdk_error)
                if can_retry:
                    continue
                if index < len(candidates) - 1:
                    continue
                raise

    if not models_loaded:
        details = f": {last_error}" if last_error else ""
        raise PipelineError(f"models list failed{details}")

    text_model_exists = bool(text_model and text_model in model_ids)
    summary_model_exists = bool(summary_model and summary_model in model_ids)
    image_model_exists = bool(image_model and image_model in model_ids)

    return {
        "base_url": resolved_base_url,
        "text_model": text_model,
        "summary_model": summary_model,
        "image_model": image_model,
        "text_model_exists": text_model_exists,
        "summary_model_exists": summary_model_exists,
        "image_model_exists": image_model_exists,
        "models_count": len(model_ids),
        "models": model_ids,
        "models_preview": model_ids[:40],
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

    if args.command == "check-connection":
        return await run_check_connection(payload)

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
