"""Use Qwen model to convert a Liaozhai story into storyboard JSON."""

from __future__ import annotations

import json
import re
from typing import Any

from .exceptions import PipelineError
from .models import PromptBundle, SceneDraft, SourceStory, StoryDraft
from .prompts import render_user_prompt


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?", "", stripped, flags=re.IGNORECASE).strip()
        stripped = re.sub(r"```$", "", stripped).strip()
    return stripped


def _parse_json_payload(raw: str) -> Any:
    clean = _strip_code_fence(raw)
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}|\[.*\]", clean, flags=re.DOTALL)
        if not match:
            raise PipelineError("Qwen response is not valid JSON")
        return json.loads(match.group(0))


def _strip_ar_9_16(text: str) -> str:
    return re.sub(r"\s*--ar\s*9:16\b", "", text, flags=re.IGNORECASE).strip(" ,")


def _ensure_ar_9_16(prompt: str) -> str:
    cleaned = _strip_ar_9_16(prompt.strip())
    if not cleaned:
        return "--ar 9:16"
    return f"{cleaned} --ar 9:16".strip()


def _merge_prompt_suffix(prompt: str, suffix: str) -> str:
    base = str(prompt or "").strip()
    extra = str(suffix or "").strip()

    if extra:
        if base:
            if extra.lower() not in base.lower():
                base = f"{base}, {extra}".strip()
        else:
            base = extra

    return _ensure_ar_9_16(base)


def _clamp_int(value: Any, minimum: int, maximum: int, fallback: int) -> int:
    try:
        integer = int(value)
    except (TypeError, ValueError):
        integer = fallback
    return max(minimum, min(maximum, integer))


def _normalize_scene(item: dict[str, Any], index: int) -> SceneDraft:
    default_rows = min(12, max(4, 6 + index // 2))
    default_cols = min(12, max(4, 4 + index // 3))

    grid = item.get("grid") if isinstance(item.get("grid"), dict) else {}
    rows = _clamp_int(grid.get("rows"), 4, 12, default_rows)
    cols = _clamp_int(grid.get("cols"), 4, 12, default_cols)

    title = str(item.get("title") or f"分镜 {index}").strip()
    description = str(item.get("description") or item.get("scene_description") or "").strip()
    story_text = str(item.get("story_text") or description or title).strip()
    prompt = _ensure_ar_9_16(str(item.get("image_prompt") or description or title).strip())

    mood = str(item.get("mood") or "").strip()
    characters_raw = item.get("characters") if isinstance(item.get("characters"), list) else []
    characters = [str(name).strip() for name in characters_raw if str(name).strip()]

    time_limit_sec = _clamp_int(item.get("time_limit_sec"), 120, 900, max(180, rows * cols * 8))
    scene_id = _clamp_int(item.get("scene_id"), 1, 999, index)

    return SceneDraft(
        scene_id=scene_id,
        title=title,
        description=description,
        story_text=story_text,
        image_prompt=prompt,
        mood=mood,
        characters=characters,
        rows=rows,
        cols=cols,
        time_limit_sec=time_limit_sec,
    )


def parse_story_draft_payload(
    payload: Any,
    *,
    source_story: SourceStory,
    min_scenes: int,
    max_scenes: int,
) -> StoryDraft:
    if isinstance(payload, list):
        scenes_raw = payload
        title = source_story.title
        subtitle = ""
        description = f"{source_story.title} 的分幕拼图故事。"
        overview_title = "故事梗概"
        overview_paragraphs = [source_story.text[:120]] if source_story.text else []
    elif isinstance(payload, dict):
        scenes_raw = payload.get("scenes") if isinstance(payload.get("scenes"), list) else []
        title = str(payload.get("story_title") or source_story.title).strip()
        subtitle = str(payload.get("story_subtitle") or "").strip()
        description = str(payload.get("description") or f"{title} 的分幕拼图故事。").strip()
        overview_title = str(payload.get("overview_title") or "故事梗概").strip()

        paragraphs_raw = payload.get("overview_paragraphs")
        if isinstance(paragraphs_raw, list):
            overview_paragraphs = [str(item).strip() for item in paragraphs_raw if str(item).strip()]
        else:
            overview_paragraphs = []
    else:
        raise PipelineError("Qwen output must be JSON object or array")

    scenes = [_normalize_scene(item, index + 1) for index, item in enumerate(scenes_raw) if isinstance(item, dict)]

    if len(scenes) < min_scenes:
        raise PipelineError(f"Too few scenes from Qwen: {len(scenes)} < {min_scenes}")

    if len(scenes) > max_scenes:
        scenes = scenes[:max_scenes]

    # Re-index scene_id to keep downstream deterministic.
    for index, scene in enumerate(scenes, start=1):
        scene.scene_id = index

    return StoryDraft(
        title=title,
        subtitle=subtitle,
        description=description,
        overview_title=overview_title,
        overview_paragraphs=overview_paragraphs,
        scenes=scenes,
    )


async def story_to_draft(
    *,
    story: SourceStory,
    prompts: PromptBundle,
    api_key: str,
    base_url: str,
    text_model: str,
    candidate_scenes: int,
    min_scenes: int,
    max_scenes: int,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    client: Any = None,
) -> StoryDraft:
    user_prompt = render_user_prompt(
        prompts.user_prompt_template,
        story=story,
        candidate_scenes=candidate_scenes,
    )

    if client is None:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:  # pragma: no cover - dependency error path
            raise PipelineError("openai package is required for story_to_draft; install dependencies in the worker python env (e.g. uv sync or pip install openai)") from exc

        client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    response = await client.chat.completions.create(
        model=text_model,
        messages=[
            {"role": "system", "content": prompts.system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=temperature,
        max_tokens=max_tokens,
    )

    raw = response.choices[0].message.content.strip()
    payload = _parse_json_payload(raw)
    draft = parse_story_draft_payload(
        payload,
        source_story=story,
        min_scenes=min_scenes,
        max_scenes=max_scenes,
    )

    prompt_suffix = str(prompts.image_prompt_suffix or "").strip()
    for scene in draft.scenes:
        scene.image_prompt = _merge_prompt_suffix(scene.image_prompt, prompt_suffix)

    return draft
