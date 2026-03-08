"""Queue worker for story generator jobs.

This worker polls backend SQLite `generation_jobs`, claims queued jobs,
runs the existing story generator pipeline CLI, and writes status updates back.
On success it also syncs chapter-generation linkage into book_ingest SQLite.
"""

from __future__ import annotations

import argparse
import logging
import signal
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from scripts.story_generator_pipeline.worker.api_client import (
        claim_next_job_via_api,
        claim_next_retry_image_task_via_api,
        complete_job_via_api,
        complete_retry_image_task_via_api,
        normalize_backend_url,
    )
    from scripts.story_generator_pipeline.worker.books_sync import extract_story_id, read_json_file, sync_books_generation_link
    from scripts.story_generator_pipeline.worker.pipeline_runner import run_job
    from scripts.story_generator_pipeline.worker.queue_db import claim_next_job, complete_job, connect_db
    from scripts.story_generator_pipeline.worker.retry_service import run_retry_image_task
    from scripts.story_generator_pipeline.worker.config import parse_args
    from scripts.story_generator_pipeline.worker.types import GenerationJob, RetryImageTask, StopSignal
except ImportError:  # pragma: no cover - fallback for direct script execution
    from worker.api_client import (
        claim_next_job_via_api,
        claim_next_retry_image_task_via_api,
        complete_job_via_api,
        complete_retry_image_task_via_api,
        normalize_backend_url,
    )
    from worker.books_sync import extract_story_id, read_json_file, sync_books_generation_link
    from worker.pipeline_runner import run_job
    from worker.queue_db import claim_next_job, complete_job, connect_db
    from worker.retry_service import run_retry_image_task
    from worker.config import parse_args
    from worker.types import GenerationJob, RetryImageTask, StopSignal

ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_IMAGE_BASE_URL = "https://aihubmix.com/v1"
DEFAULT_IMAGE_MODEL = "doubao/doubao-seedream-4-5-251128"
LOGGER = logging.getLogger("story_generator.queue_worker")


@dataclass
class WorkerRuntimeContext:
    use_api_mode: bool
    backend_url: str
    worker_token: str
    http_timeout: float
    books_db_path: Path
    poll_seconds: float
    max_jobs: int
    python_bin: str
    skip_books_sync: bool
    conn: sqlite3.Connection | None = None


@dataclass(frozen=True)
class WorkerLoopPolicy:
    poll_seconds: float
    max_jobs: int
    once: bool

    def reached_max_jobs(self, processed: int) -> bool:
        return self.max_jobs > 0 and processed >= self.max_jobs

    def should_exit_when_idle(self) -> bool:
        return self.once

    def should_exit_after_task(self) -> bool:
        return self.once

    def sleep_before_next_poll(self) -> None:
        time.sleep(self.poll_seconds)


def setup_logging(level_name: str) -> None:
    logging.basicConfig(
        level=getattr(logging, str(level_name).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )


def is_truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        return normalized in {"1", "true", "yes", "on"}
    return False


def _claim_next_task(
    ctx: WorkerRuntimeContext,
) -> tuple[GenerationJob | None, RetryImageTask | None]:
    if ctx.use_api_mode:
        job = claim_next_job_via_api(
            backend_url=ctx.backend_url,
            worker_token=ctx.worker_token,
            timeout=ctx.http_timeout,
        )
        if job is not None:
            return job, None
        retry_task = claim_next_retry_image_task_via_api(
            backend_url=ctx.backend_url,
            worker_token=ctx.worker_token,
            timeout=ctx.http_timeout,
        )
        return None, retry_task

    assert ctx.conn is not None
    return claim_next_job(ctx.conn), None


def _complete_retry_task(
    ctx: WorkerRuntimeContext,
    *,
    retry_id: int,
    status: str,
    image_url: str,
    image_path: str,
    error_message: str,
) -> None:
    complete_retry_image_task_via_api(
        backend_url=ctx.backend_url,
        worker_token=ctx.worker_token,
        timeout=ctx.http_timeout,
        retry_id=retry_id,
        status=status,
        image_url=image_url,
        image_path=image_path,
        error_message=error_message,
    )


def _handle_retry_task(
    ctx: WorkerRuntimeContext,
    *,
    retry_task: RetryImageTask,
) -> None:
    LOGGER.info(
        "Claimed retry task retry_id=%s run_id=%s scene_index=%s",
        retry_task.retry_id,
        retry_task.run_id,
        retry_task.scene_index,
    )

    try:
        succeeded, image_url, image_path, error_message = run_retry_image_task(
            retry_task,
            root_dir=ROOT_DIR,
            default_image_base_url=DEFAULT_IMAGE_BASE_URL,
            default_image_model=DEFAULT_IMAGE_MODEL,
        )
        if succeeded:
            _complete_retry_task(
                ctx,
                retry_id=retry_task.retry_id,
                status="succeeded",
                image_url=image_url,
                image_path=image_path,
                error_message="",
            )
            LOGGER.info(
                "Retry task succeeded: retry_id=%s run_id=%s scene_index=%s",
                retry_task.retry_id,
                retry_task.run_id,
                retry_task.scene_index,
            )
            return

        _complete_retry_task(
            ctx,
            retry_id=retry_task.retry_id,
            status="failed",
            image_url=image_url,
            image_path=image_path,
            error_message=error_message,
        )
        LOGGER.warning(
            "Retry task failed: retry_id=%s run_id=%s scene_index=%s error=%s",
            retry_task.retry_id,
            retry_task.run_id,
            retry_task.scene_index,
            error_message,
        )
    except Exception as error:  # noqa: BLE001
        try:
            _complete_retry_task(
                ctx,
                retry_id=retry_task.retry_id,
                status="failed",
                image_url="",
                image_path="",
                error_message=str(error),
            )
        except Exception as complete_error:  # noqa: BLE001
            LOGGER.warning(
                "Mark retry task failed error: retry_id=%s err=%s",
                retry_task.retry_id,
                complete_error,
            )

        LOGGER.exception(
            "Unexpected retry task error: retry_id=%s run_id=%s scene_index=%s",
            retry_task.retry_id,
            retry_task.run_id,
            retry_task.scene_index,
        )


def _complete_job_status(
    ctx: WorkerRuntimeContext,
    *,
    job: GenerationJob,
    status: str,
    exit_code: int | None,
    error_message: str,
    story_id: str,
    review_status: str,
) -> None:
    if ctx.use_api_mode:
        complete_job_via_api(
            backend_url=ctx.backend_url,
            worker_token=ctx.worker_token,
            timeout=ctx.http_timeout,
            run_id=job.run_id,
            status=status,
            exit_code=exit_code,
            error_message=error_message,
            story_id=story_id,
            review_status=review_status,
        )
        return

    assert ctx.conn is not None
    complete_job(
        ctx.conn,
        job_id=job.id,
        status=status,
        exit_code=exit_code,
        error_message=error_message,
        review_status=review_status,
    )


def _handle_generation_job(
    ctx: WorkerRuntimeContext,
    *,
    job: GenerationJob,
) -> None:
    LOGGER.info("Claimed job run_id=%s requested_by=%s", job.run_id, job.requested_by)

    try:
        exit_code, error_message = run_job(job, python_bin=ctx.python_bin, root_dir=ROOT_DIR, logger=LOGGER)
        summary = read_json_file(job.summary_path)
        completed_story_id = extract_story_id(job, summary)
        next_review_status = "pending_review" if (not job.dry_run and is_truthy(job.payload.get("review_mode"))) else ""
        if exit_code == 0:
            _complete_job_status(
                ctx,
                job=job,
                status="succeeded",
                exit_code=0,
                error_message="",
                story_id=completed_story_id,
                review_status=next_review_status,
            )

            if not ctx.skip_books_sync:
                try:
                    sync_books_generation_link(job, ctx.books_db_path, logger=LOGGER)
                except Exception as sync_error:  # noqa: BLE001
                    LOGGER.warning("Books sync failed for run_id=%s: %s", job.run_id, sync_error)
            LOGGER.info("Job succeeded: run_id=%s", job.run_id)
            return

        _complete_job_status(
            ctx,
            job=job,
            status="failed",
            exit_code=exit_code,
            error_message=error_message,
            story_id=completed_story_id,
            review_status="",
        )
        LOGGER.error("Job failed: run_id=%s exit_code=%s", job.run_id, exit_code)
    except Exception as error:  # noqa: BLE001
        try:
            _complete_job_status(
                ctx,
                job=job,
                status="failed",
                exit_code=None,
                error_message=str(error),
                story_id="",
                review_status="",
            )
        except Exception as complete_error:  # noqa: BLE001
            LOGGER.warning("Mark job failed error: run_id=%s err=%s", job.run_id, complete_error)

        LOGGER.exception("Unexpected worker error for run_id=%s", job.run_id)


def run_worker(args: argparse.Namespace) -> int:
    stop_signal = StopSignal()

    def _handle_signal(_signum: int, _frame: Any) -> None:
        stop_signal.stop()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    db_path = Path(args.db).expanduser().resolve()
    backend_url = normalize_backend_url(args.backend_url)
    use_api_mode = bool(backend_url)
    ctx = WorkerRuntimeContext(
        use_api_mode=use_api_mode,
        backend_url=backend_url,
        worker_token=str(args.worker_token or "").strip(),
        http_timeout=max(1.0, float(args.http_timeout)),
        books_db_path=Path(args.books_db).expanduser().resolve(),
        poll_seconds=max(0.2, float(args.poll_seconds)),
        max_jobs=max(0, int(args.max_jobs)),
        python_bin=str(args.python_bin),
        skip_books_sync=bool(args.skip_books_sync),
    )
    policy = WorkerLoopPolicy(
        poll_seconds=ctx.poll_seconds,
        max_jobs=ctx.max_jobs,
        once=bool(args.once),
    )
    processed = 0

    if ctx.use_api_mode and not ctx.worker_token:
        LOGGER.error("API mode requires --worker-token or STORY_GENERATOR_WORKER_TOKEN")
        return 2

    LOGGER.info(
        "Queue worker started: mode=%s backend=%s db=%s books_db=%s poll_seconds=%.2f",
        "api" if ctx.use_api_mode else "sqlite",
        ctx.backend_url or "",
        db_path if not ctx.use_api_mode else "",
        ctx.books_db_path,
        ctx.poll_seconds,
    )

    if not ctx.use_api_mode:
        ctx.conn = connect_db(db_path)

    try:
        while not stop_signal.stopped:
            if policy.reached_max_jobs(processed):
                LOGGER.info("Reached max-jobs=%s, exiting", ctx.max_jobs)
                break

            try:
                job, retry_task = _claim_next_task(ctx)
            except sqlite3.OperationalError as error:
                if ctx.conn is not None and ctx.conn.in_transaction:
                    ctx.conn.rollback()
                LOGGER.warning("Queue poll failed: %s", error)
                policy.sleep_before_next_poll()
                continue
            except Exception as error:  # noqa: BLE001
                LOGGER.warning("Queue poll failed: %s", error)
                policy.sleep_before_next_poll()
                continue

            if job is None and retry_task is None:
                if policy.should_exit_when_idle():
                    LOGGER.info("No queued task found, exiting due to --once")
                    break
                policy.sleep_before_next_poll()
                continue

            if retry_task is not None:
                processed += 1
                _handle_retry_task(ctx, retry_task=retry_task)

                if policy.should_exit_after_task():
                    break
                continue

            processed += 1
            _handle_generation_job(ctx, job=job)

            if policy.should_exit_after_task():
                break
    finally:
        if ctx.conn is not None:
            ctx.conn.close()

    LOGGER.info("Queue worker stopped")
    return 0


def main() -> int:
    args = parse_args()
    setup_logging(args.log_level)
    return run_worker(args)


if __name__ == "__main__":
    raise SystemExit(main())
