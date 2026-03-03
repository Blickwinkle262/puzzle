"""Publish generated story assets and update story index."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any

from .exceptions import PipelineError
from .models import StoryDraft


def _clean_id(value: str) -> str:
    cleaned = value.strip().lower()
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", cleaned)
    cleaned = re.sub(r"-+", "-", cleaned).strip("-")
    return cleaned or "story"


def _make_slug(text: str) -> str:
    lowered = text.strip().lower()
    return _clean_id(lowered)


def resolve_story_id(
    *,
    fixed_story_id: str | None,
    draft: StoryDraft,
    source_name: str,
    target_date: dt.date,
    output_root: Path,
) -> str:
    if fixed_story_id:
        return _clean_id(fixed_story_id)

    date_stamp = target_date.strftime("%Y%m%d")
    base = _make_slug(draft.title) or _make_slug(source_name) or "liaozhai"
    digest = hashlib.sha1(f"{draft.title}|{source_name}|{date_stamp}".encode("utf-8")).hexdigest()[:6]
    candidate = _clean_id(f"{base}-{date_stamp}-{digest}")

    if not (output_root / candidate).exists():
        return candidate

    suffix = 1
    while (output_root / f"{candidate}-{suffix}").exists():
        suffix += 1
    return f"{candidate}-{suffix}"


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def build_story_manifest(
    *,
    story_id: str,
    draft: StoryDraft,
    filtered_scenes: list[dict[str, Any]],
    cover_name: str,
    default_bgm: str,
    piece_link_sfx: str,
    content_version: int,
) -> dict[str, Any]:
    title = draft.title
    if draft.subtitle:
        title = f"{title}：{draft.subtitle}"

    levels: list[dict[str, Any]] = []
    for index, scene in enumerate(filtered_scenes, start=1):
        local_path = Path(scene["local_path"])
        level = {
            "id": f"{story_id}_{index:02d}",
            "title": scene["title"],
            "description": scene.get("description") or scene["title"],
            "story_text": scene.get("story_text") or scene.get("description") or scene["title"],
            "grid": {
                "rows": int(scene.get("rows") or 6),
                "cols": int(scene.get("cols") or 4),
            },
            "source_image": f"images/{local_path.name}",
            "content_version": max(1, int(content_version)),
            "time_limit_sec": int(scene.get("time_limit_sec") or 180),
            "shuffle": {
                "seed": 1000 + index,
                "mode": "grid_shuffle",
            },
            "mobile": {
                "preferred_orientation": "portrait",
                "orientation_hint": "本关建议竖屏体验",
            },
        }
        if piece_link_sfx:
            level["audio"] = {"piece_link": piece_link_sfx}
        levels.append(level)

    payload: dict[str, Any] = {
        "id": story_id,
        "title": title,
        "description": draft.description,
        "cover": cover_name,
        "story_overview_title": draft.overview_title,
        "story_overview_paragraphs": draft.overview_paragraphs,
        "levels": levels,
    }
    if default_bgm:
        payload["default_bgm"] = default_bgm

    return payload


def update_story_index(
    *,
    index_path: Path,
    story_id: str,
    title: str,
    description: str,
    cover_url: str,
    manifest_url: str,
) -> None:
    if index_path.exists():
        payload = json.loads(index_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            payload = {}
    else:
        payload = {}

    stories = payload.get("stories")
    if not isinstance(stories, list):
        stories = []

    stories = [item for item in stories if isinstance(item, dict) and str(item.get("id")) != story_id]

    max_order = 0
    for item in stories:
        if isinstance(item.get("order"), int):
            max_order = max(max_order, int(item["order"]))

    stories.append(
        {
            "id": story_id,
            "title": title,
            "description": description,
            "cover": cover_url,
            "manifest": manifest_url,
            "order": max_order + 1,
        }
    )

    payload["version"] = int(payload.get("version") or 1)
    payload["stories"] = sorted(
        stories,
        key=lambda item: (int(item.get("order", 10**9)), str(item.get("id", ""))),
    )
    _write_json(index_path, payload)


def publish_story(
    *,
    story_id: str,
    draft: StoryDraft,
    filtered_scenes: list[dict[str, Any]],
    output_root: Path,
    index_file: Path,
    default_bgm: str,
    piece_link_sfx: str,
    content_version: int,
) -> dict[str, Any]:
    if not filtered_scenes:
        raise PipelineError("No successful scenes to publish")

    staging_dir = output_root / f".staging_{story_id}"
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    (staging_dir / "images").mkdir(parents=True, exist_ok=True)

    for item in filtered_scenes:
        source = Path(item["local_path"])
        if not source.exists():
            raise PipelineError(f"Missing generated image: {source}")
        target = staging_dir / "images" / source.name
        shutil.copyfile(source, target)
        item["local_path"] = str(target)

    first_name = Path(filtered_scenes[0]["local_path"]).name
    cover_suffix = Path(first_name).suffix or ".png"
    cover_name = f"cover{cover_suffix}"
    shutil.copyfile(staging_dir / "images" / first_name, staging_dir / cover_name)

    manifest = build_story_manifest(
        story_id=story_id,
        draft=draft,
        filtered_scenes=filtered_scenes,
        cover_name=cover_name,
        default_bgm=default_bgm,
        piece_link_sfx=piece_link_sfx,
        content_version=content_version,
    )
    _write_json(staging_dir / "story.json", manifest)

    final_dir = output_root / story_id
    if final_dir.exists():
        shutil.rmtree(final_dir)
    staging_dir.rename(final_dir)

    update_story_index(
        index_path=index_file,
        story_id=story_id,
        title=manifest["title"],
        description=manifest["description"],
        cover_url=f"/content/stories/{story_id}/{cover_name}",
        manifest_url=f"/content/stories/{story_id}/story.json",
    )

    return {
        "story_id": story_id,
        "story_dir": str(final_dir),
        "manifest": str(final_dir / "story.json"),
        "level_count": len(manifest["levels"]),
    }
