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

DEFAULT_BASE_URL_FALLBACK = "https://aihubmix.com/v1"
DEFAULT_TEXT_MODEL_FALLBACK = "qwen3-next-80b-a3b-instruct"
DEFAULT_IMAGE_MODEL_FALLBACK = "doubao/doubao-seedream-4-5-251128"


def _get_env(primary: str, *fallbacks: str, default: str = "") -> str:
    keys = (primary, *fallbacks)
    for key in keys:
        value = os.environ.get(key)
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return default


def resolve_default_base_url() -> str:
    return _get_env(
        "STORY_GENERATOR_BASE_URL",
        "STORY_GENERATION_BASE_URL",
        "AIHUBMIX_BASE_URL",
        "AIHUBMIX_OPENAI_BASE_URL",
        "OPENAI_BASE_URL",
        default=DEFAULT_BASE_URL_FALLBACK,
    )


def resolve_default_text_model() -> str:
    return _get_env(
        "STORY_GENERATOR_TEXT_MODEL",
        "STORY_GENERATION_TEXT_MODEL",
        "AIHUBMIX_TEXT_MODEL",
        default=DEFAULT_TEXT_MODEL_FALLBACK,
    )


def resolve_default_image_model() -> str:
    return _get_env(
        "STORY_GENERATOR_IMAGE_MODEL",
        "STORY_GENERATION_IMAGE_MODEL",
        "AIHUBMIX_IMAGE_MODEL",
        default=DEFAULT_IMAGE_MODEL_FALLBACK,
    )


DEFAULT_BASE_URL = resolve_default_base_url()
DEFAULT_TEXT_MODEL = resolve_default_text_model()
DEFAULT_IMAGE_MODEL = resolve_default_image_model()


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

    dry_run: bool = False
    review_mode: bool = False
    summary_path: Path | None = None


def get_required_api_key(value: str | None = None) -> str:
    key = str(value or "").strip() or _get_env(
        "AIHUBMIX_API_KEY",
        "STORY_GENERATOR_API_KEY",
        "STORY_GENERATION_API_KEY",
        "OPENAI_API_KEY",
        default="",
    )
    if not key:
        raise PipelineError("Missing API key (AIHUBMIX_API_KEY/STORY_GENERATOR_API_KEY)")
    return key


def default_target_date() -> dt.date:
    return dt.date.today()


def default_run_id(now: dt.datetime | None = None) -> str:
    current = now or dt.datetime.now(dt.timezone.utc)
    return current.strftime("run_%Y%m%dT%H%M%S_%fZ")
