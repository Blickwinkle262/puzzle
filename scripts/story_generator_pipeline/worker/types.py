"""Shared types for story generator queue worker."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class GenerationJob:
    id: int
    run_id: str
    requested_by: str
    target_date: str
    story_file: str
    dry_run: bool
    payload: dict[str, Any]
    log_file: str
    event_log_file: str
    summary_path: str


@dataclass
class RetryImageTask:
    retry_id: int
    run_id: str
    scene_index: int
    scene_id: int
    title: str
    description: str
    story_text: str
    image_prompt: str
    mood: str
    characters: list[str]
    grid_rows: int
    grid_cols: int
    time_limit_sec: int
    target_date: str
    image_size: str
    timeout_sec: float
    poll_seconds: float
    poll_attempts: int
    watermark: bool
    output_root: str


class StopSignal:
    def __init__(self) -> None:
        self._stopped = False

    @property
    def stopped(self) -> bool:
        return self._stopped

    def stop(self) -> None:
        self._stopped = True

