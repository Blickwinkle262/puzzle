"""Configuration models and helpers for story generator pipeline."""

from __future__ import annotations

import datetime as dt
import os
from dataclasses import dataclass
from pathlib import Path

from .exceptions import PipelineError

DEFAULT_LOG_DIR = Path("scripts/story_generator/output/logs")
DEFAULT_LOG_FILE = DEFAULT_LOG_DIR / "story_generator_pipeline.log"
DEFAULT_EVENT_LOG_FILE = DEFAULT_LOG_DIR / "events.jsonl"
DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_LOG_BACKUP_COUNT = 5
DEFAULT_EVENT_LOG_MAX_BYTES = 20 * 1024 * 1024
DEFAULT_EVENT_LOG_BACKUP_COUNT = 10


@dataclass
class PipelineConfig:
    api_key: str
    base_url: str
    text_model: str
    image_model: str

    source_dir: Path
    story_file: Path | None
    target_date: dt.date
    seed: int | None
    max_source_chars: int

    output_root: Path
    index_file: Path
    summary_output_dir: Path
    story_id: str | None

    candidate_scenes: int
    min_scenes: int
    max_scenes: int

    image_size: str
    watermark: bool
    concurrency: int

    prompts_dir: Path
    system_prompt_file: str
    user_prompt_template_file: str
    image_prompt_suffix_file: str

    piece_link_sfx: str
    default_bgm: str
    content_version: int

    timeout_sec: float
    poll_seconds: float
    poll_attempts: int

    run_id: str
    log_level: str
    log_file: Path
    log_max_bytes: int
    log_backup_count: int
    event_log_file: Path
    event_log_max_bytes: int
    event_log_backup_count: int

    dry_run: bool
    review_mode: bool


def get_required_api_key(value: str | None = None) -> str:
    key = (value or os.environ.get("AIHUBMIX_API_KEY", "")).strip()
    if not key:
        raise PipelineError("Missing AIHUBMIX_API_KEY")
    return key


def default_target_date() -> dt.date:
    return dt.date.today()


def default_run_id(now: dt.datetime | None = None) -> str:
    current = now or dt.datetime.now(dt.timezone.utc)
    return current.strftime("run_%Y%m%dT%H%M%S_%fZ")
