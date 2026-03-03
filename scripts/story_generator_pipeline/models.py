"""Data models for story generator pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class SourceStory:
    title: str
    text: str
    source_path: Path


@dataclass
class SceneDraft:
    scene_id: int
    title: str
    description: str
    story_text: str
    image_prompt: str
    mood: str = ""
    characters: list[str] = field(default_factory=list)
    rows: int = 6
    cols: int = 4
    time_limit_sec: int = 180


@dataclass
class StoryDraft:
    title: str
    subtitle: str
    description: str
    overview_title: str
    overview_paragraphs: list[str]
    scenes: list[SceneDraft]


@dataclass
class PromptBundle:
    system_prompt: str
    user_prompt_template: str
    image_prompt_suffix: str


@dataclass
class ImageResult:
    scene_id: int
    status: str
    reason: str | None
    image_url: str | None
    local_path: Path | None
