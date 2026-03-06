"""CLI entry for story generator pipeline."""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import logging
import os
from pathlib import Path

from .config import (
    DEFAULT_EVENT_LOG_BACKUP_COUNT,
    DEFAULT_EVENT_LOG_FILE,
    DEFAULT_EVENT_LOG_MAX_BYTES,
    DEFAULT_LOG_BACKUP_COUNT,
    DEFAULT_LOG_FILE,
    DEFAULT_LOG_MAX_BYTES,
    PipelineConfig,
    default_run_id,
    default_target_date,
    get_required_api_key,
)
from .exceptions import PipelineError
from .logging_setup import configure_logging, emit_event
from .workflow import run_pipeline

DEFAULT_BASE_URL = "https://aihubmix.com/v1"
DEFAULT_TEXT_MODEL = "qwen3-next-80b-a3b-instruct"
DEFAULT_IMAGE_MODEL = "doubao/doubao-seedream-4-5-251128"
DEFAULT_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


def get_env(primary: str, *fallbacks: str, default: str = "") -> str:
    candidates = (primary, *fallbacks)
    for key in candidates:
        value = os.environ.get(key)
        if value is not None and str(value).strip() != "":
            return str(value)
    return default


DEFAULT_OUTPUT_ROOT = get_env(
    "STORY_GENERATOR_OUTPUT_ROOT",
    "STORY_GENERATION_OUTPUT_ROOT",
    default="backend/data/generated/content/stories",
)
DEFAULT_INDEX_FILE = get_env(
    "STORY_GENERATOR_INDEX_FILE",
    "STORY_GENERATION_INDEX_FILE",
    default=f"{DEFAULT_OUTPUT_ROOT}/index.json",
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate puzzle story content from source text.")
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--text-model", default=DEFAULT_TEXT_MODEL)
    parser.add_argument("--image-model", default=DEFAULT_IMAGE_MODEL)

    parser.add_argument("--source-dir", default="materials/source/liaozhai")
    parser.add_argument("--story-file", default=None)
    parser.add_argument("--target-date", default=default_target_date().isoformat())
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--max-source-chars", type=int, default=12000)

    parser.add_argument("--output-root", default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--index-file", default=DEFAULT_INDEX_FILE)
    parser.add_argument("--summary-output-dir", default="scripts/story_generator/output")
    parser.add_argument("--summary-path", default=None)
    parser.add_argument("--story-id", default=None)

    parser.add_argument("--candidate-scenes", type=int, default=15)
    parser.add_argument("--min-scenes", type=int, default=10)
    parser.add_argument("--max-scenes", type=int, default=15)

    parser.add_argument("--image-size", default="2K")
    parser.add_argument("--watermark", action="store_true")
    parser.add_argument("--concurrency", type=int, default=3)

    parser.add_argument("--prompts-dir", default=str(DEFAULT_PROMPTS_DIR))
    parser.add_argument("--system-prompt-file", default="story_system_prompt.txt")
    parser.add_argument("--user-prompt-template-file", default="story_user_prompt_template.txt")
    parser.add_argument("--image-prompt-suffix-file", default="image_prompt_suffix.txt")

    parser.add_argument("--piece-link-sfx", default="/assets/attach.mp3")
    parser.add_argument("--default-bgm", default="")
    parser.add_argument("--content-version", type=int, default=1)

    parser.add_argument("--timeout-sec", type=float, default=120.0)
    parser.add_argument("--poll-seconds", type=float, default=2.5)
    parser.add_argument("--poll-attempts", type=int, default=40)

    parser.add_argument("--run-id", default=None)
    parser.add_argument(
        "--log-level",
        default=get_env("STORY_GENERATOR_LOG_LEVEL", "STORY_GENERATION_LOG_LEVEL", default="INFO"),
    )
    parser.add_argument(
        "--log-file",
        default=get_env("STORY_GENERATOR_LOG_FILE", "STORY_GENERATION_LOG_FILE", default=str(DEFAULT_LOG_FILE)),
    )
    parser.add_argument(
        "--log-max-bytes",
        type=int,
        default=int(
            get_env(
                "STORY_GENERATOR_LOG_MAX_BYTES",
                "STORY_GENERATION_LOG_MAX_BYTES",
                default=str(DEFAULT_LOG_MAX_BYTES),
            )
        ),
    )
    parser.add_argument(
        "--log-backup-count",
        type=int,
        default=int(
            get_env(
                "STORY_GENERATOR_LOG_BACKUP_COUNT",
                "STORY_GENERATION_LOG_BACKUP_COUNT",
                default=str(DEFAULT_LOG_BACKUP_COUNT),
            )
        ),
    )
    parser.add_argument(
        "--event-log-file",
        default=get_env(
            "STORY_GENERATOR_EVENT_LOG_FILE",
            "STORY_GENERATION_EVENT_LOG_FILE",
            default=str(DEFAULT_EVENT_LOG_FILE),
        ),
    )
    parser.add_argument(
        "--event-log-max-bytes",
        type=int,
        default=int(
            get_env(
                "STORY_GENERATOR_EVENT_LOG_MAX_BYTES",
                "STORY_GENERATION_EVENT_LOG_MAX_BYTES",
                default=str(DEFAULT_EVENT_LOG_MAX_BYTES),
            )
        ),
    )
    parser.add_argument(
        "--event-log-backup-count",
        type=int,
        default=int(
            get_env(
                "STORY_GENERATOR_EVENT_LOG_BACKUP_COUNT",
                "STORY_GENERATION_EVENT_LOG_BACKUP_COUNT",
                default=str(DEFAULT_EVENT_LOG_BACKUP_COUNT),
            )
        ),
    )

    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--review-mode", action="store_true")
    return parser


def config_from_args(args: argparse.Namespace) -> PipelineConfig:
    try:
        target_date = dt.date.fromisoformat(args.target_date)
    except ValueError as exc:
        raise PipelineError("--target-date must be YYYY-MM-DD") from exc

    if args.max_scenes < args.min_scenes:
        raise PipelineError("--max-scenes must be >= --min-scenes")
    if args.candidate_scenes < args.max_scenes:
        raise PipelineError("--candidate-scenes must be >= --max-scenes")

    return PipelineConfig(
        api_key=get_required_api_key(args.api_key),
        base_url=args.base_url,
        text_model=args.text_model,
        image_model=args.image_model,
        source_dir=Path(args.source_dir),
        story_file=Path(args.story_file) if args.story_file else None,
        target_date=target_date,
        seed=args.seed,
        max_source_chars=args.max_source_chars,
        output_root=Path(args.output_root),
        index_file=Path(args.index_file),
        summary_output_dir=Path(args.summary_output_dir),
        summary_path=Path(args.summary_path) if args.summary_path else None,
        story_id=args.story_id,
        candidate_scenes=args.candidate_scenes,
        min_scenes=args.min_scenes,
        max_scenes=args.max_scenes,
        image_size=args.image_size,
        watermark=bool(args.watermark),
        concurrency=max(1, int(args.concurrency)),
        prompts_dir=Path(args.prompts_dir),
        system_prompt_file=args.system_prompt_file,
        user_prompt_template_file=args.user_prompt_template_file,
        image_prompt_suffix_file=args.image_prompt_suffix_file,
        piece_link_sfx=args.piece_link_sfx,
        default_bgm=args.default_bgm,
        content_version=max(1, int(args.content_version)),
        timeout_sec=max(1.0, float(args.timeout_sec)),
        poll_seconds=max(0.1, float(args.poll_seconds)),
        poll_attempts=max(1, int(args.poll_attempts)),
        run_id=str(args.run_id).strip() if args.run_id else default_run_id(),
        log_level=str(args.log_level).strip() or "INFO",
        log_file=Path(args.log_file),
        log_max_bytes=max(1024, int(args.log_max_bytes)),
        log_backup_count=max(1, int(args.log_backup_count)),
        event_log_file=Path(args.event_log_file),
        event_log_max_bytes=max(1024, int(args.event_log_max_bytes)),
        event_log_backup_count=max(1, int(args.event_log_backup_count)),
        dry_run=bool(args.dry_run),
        review_mode=bool(args.review_mode),
    )


async def _async_main(config: PipelineConfig) -> int:
    logger = logging.getLogger("story_generator.main")
    summary = await run_pipeline(config)
    logger.info(
        "Done: run_id=%s story_id=%s generated=%s/%s dry_run=%s",
        config.run_id,
        summary["story_id"],
        summary["generated_scenes"],
        summary["total_scenes"],
        summary["dry_run"],
    )
    return 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        config = config_from_args(args)
    except PipelineError as exc:
        print(f"[ERROR] {exc}")
        return 1

    logging_runtime = configure_logging(config)
    logger = logging.getLogger("story_generator.main")
    try:
        logger.info(
            "Start story generator pipeline: run_id=%s target_date=%s dry_run=%s",
            config.run_id,
            config.target_date.isoformat(),
            config.dry_run,
        )
        emit_event(
            "pipeline.bootstrap",
            run_id=config.run_id,
            target_date=config.target_date.isoformat(),
            dry_run=config.dry_run,
            review_mode=config.review_mode,
            log_file=str(config.log_file),
            event_log_file=str(config.event_log_file),
        )
        return asyncio.run(_async_main(config))
    except PipelineError as exc:
        logger.error("Pipeline failed with business error: %s", exc)
        emit_event(
            "pipeline.failed",
            run_id=config.run_id,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        return 1
    except Exception as exc:  # noqa: BLE001
        logger.exception("Pipeline crashed with unexpected error")
        emit_event(
            "pipeline.failed",
            run_id=config.run_id,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        return 1
    finally:
        logging_runtime.close()


if __name__ == "__main__":
    raise SystemExit(main())
