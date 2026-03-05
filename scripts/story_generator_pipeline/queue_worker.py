"""Queue worker for story generator jobs.

This worker polls backend SQLite `generation_jobs`, claims queued jobs,
runs the existing story generator pipeline CLI, and writes status updates back.
On success it also syncs chapter-generation linkage into book_ingest SQLite.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import ipaddress
import json
import logging
import os
import re
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from scripts.story_generator_pipeline.config import get_required_api_key
    from scripts.story_generator_pipeline.image_generator import generate_images_for_story
    from scripts.story_generator_pipeline.models import SceneDraft
except ImportError:  # pragma: no cover - fallback for direct script execution
    from config import get_required_api_key
    from image_generator import generate_images_for_story
    from models import SceneDraft

ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = ROOT_DIR / "backend" / "data" / "puzzle.sqlite"
DEFAULT_BOOKS_DB_PATH = ROOT_DIR / "scripts" / "book_ingest" / "data" / "books.sqlite"
DEFAULT_IMAGE_BASE_URL = "https://aihubmix.com/v1"
DEFAULT_IMAGE_MODEL = "doubao/doubao-seedream-4-5-251128"
LOGGER = logging.getLogger("story_generator.queue_worker")


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


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def get_env(primary: str, *fallbacks: str, default: str = "") -> str:
    keys = (primary, *fallbacks)
    for key in keys:
        value = os.environ.get(key)
        if value is not None and str(value).strip() != "":
            return str(value)
    return default


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run queue worker for story generator jobs.")
    parser.add_argument(
        "--db",
        default=get_env(
            "STORY_GENERATOR_QUEUE_DB_PATH",
            "STORY_GENERATION_QUEUE_DB_PATH",
            default=str(DEFAULT_DB_PATH),
        ),
        help="Path to backend SQLite database (legacy fallback mode).",
    )
    parser.add_argument(
        "--backend-url",
        default=get_env("STORY_GENERATOR_BACKEND_URL", "STORY_GENERATION_BACKEND_URL", default=""),
        help="Backend base URL for internal queue APIs (recommended).",
    )
    parser.add_argument(
        "--worker-token",
        default=get_env("STORY_GENERATOR_WORKER_TOKEN", "STORY_GENERATION_WORKER_TOKEN", default=""),
        help="Shared secret token for backend internal worker APIs.",
    )
    parser.add_argument(
        "--http-timeout",
        type=float,
        default=float(
            get_env(
                "STORY_GENERATOR_QUEUE_HTTP_TIMEOUT",
                "STORY_GENERATION_QUEUE_HTTP_TIMEOUT",
                default="15.0",
            )
        ),
        help="HTTP timeout seconds for backend internal queue APIs.",
    )
    parser.add_argument(
        "--books-db",
        default=os.environ.get("BOOK_INGEST_DB_PATH", str(DEFAULT_BOOKS_DB_PATH)),
        help="Path to book_ingest SQLite database.",
    )
    parser.add_argument(
        "--skip-books-sync",
        action="store_true",
        help="Skip syncing chapter-generation linkage to books.sqlite.",
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=float(
            get_env(
                "STORY_GENERATOR_QUEUE_POLL_SECONDS",
                "STORY_GENERATION_QUEUE_POLL_SECONDS",
                default="2.0",
            )
        ),
        help="Polling interval when queue is empty.",
    )
    parser.add_argument(
        "--max-jobs",
        type=int,
        default=int(
            get_env(
                "STORY_GENERATOR_QUEUE_MAX_JOBS",
                "STORY_GENERATION_QUEUE_MAX_JOBS",
                default="0",
            )
        ),
        help="Process at most N jobs then exit (0 means unlimited).",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Process at most one job and exit.",
    )
    parser.add_argument(
        "--python-bin",
        default=get_env(
            "STORY_GENERATOR_QUEUE_PYTHON",
            "STORY_GENERATION_QUEUE_PYTHON",
            default=sys.executable,
        ),
        help="Python executable used to run the pipeline script.",
    )
    parser.add_argument(
        "--log-level",
        default=get_env(
            "STORY_GENERATOR_QUEUE_LOG_LEVEL",
            "STORY_GENERATION_QUEUE_LOG_LEVEL",
            default="INFO",
        ),
        help="Worker log level.",
    )
    return parser.parse_args()


def setup_logging(level_name: str) -> None:
    logging.basicConfig(
        level=getattr(logging, str(level_name).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )


def connect_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def safe_parse_json_object(value: str | None) -> dict[str, Any]:
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def read_json_file(path_value: str) -> dict[str, Any]:
    if not path_value:
        return {}
    try:
        content = Path(path_value).read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def parse_positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def infer_chapter_id_from_path(path_value: str) -> int | None:
    if not path_value:
        return None
    match = re.search(r"(?:^|[_-])chapter[_-]?(\d+)(?:\D|$)", path_value)
    if not match:
        return None
    return parse_positive_int(match.group(1))


def extract_chapter_id(job: GenerationJob, summary: dict[str, Any]) -> int | None:
    payload = job.payload
    chapter_id = parse_positive_int(payload.get("chapter_id"))
    if chapter_id:
        return chapter_id

    chapter_id = infer_chapter_id_from_path(str(payload.get("story_file") or ""))
    if chapter_id:
        return chapter_id

    chapter_id = infer_chapter_id_from_path(job.story_file)
    if chapter_id:
        return chapter_id

    source_file = str(summary.get("source_file") or "")
    return infer_chapter_id_from_path(source_file)


def extract_story_id(job: GenerationJob, summary: dict[str, Any]) -> str:
    candidate = str(summary.get("story_id") or "").strip()
    if candidate:
        return candidate
    return str(job.payload.get("story_id") or "").strip()


def normalize_backend_url(value: str | None) -> str:
    text = str(value or "").strip()
    return text.rstrip("/")


def read_json_response(raw_text: str) -> dict[str, Any]:
    if not raw_text.strip():
        return {}
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def should_bypass_proxy_for_backend(url: str) -> bool:
    try:
        host = (urllib.parse.urlparse(url).hostname or "").strip().lower()
    except Exception:  # noqa: BLE001
        return False

    if not host:
        return False

    if host in {"localhost", "backend", "node-app", "story-worker"}:
        return True

    try:
        ip_addr = ipaddress.ip_address(host)
    except ValueError:
        return host.endswith(".local")

    return bool(ip_addr.is_loopback or ip_addr.is_private or ip_addr.is_link_local)


def post_json(url: str, payload: dict[str, Any], *, worker_token: str, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url=url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Worker-Token": worker_token,
        },
        method="POST",
    )

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if should_bypass_proxy_for_backend(url) else None

    try:
        if opener is not None:
            response_ctx = opener.open(request, timeout=timeout)
        else:
            response_ctx = urllib.request.urlopen(request, timeout=timeout)

        with response_ctx as response:
            body = response.read().decode("utf-8", errors="replace")
            parsed = read_json_response(body)
            if parsed:
                return parsed
            return {}
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        parsed = read_json_response(body)
        message = str(parsed.get("message") or "").strip() or body.strip() or f"HTTP {error.code}"
        raise RuntimeError(f"HTTP {error.code}: {message}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Network error: {error}") from error


def build_generation_job_from_api(raw_job: dict[str, Any]) -> GenerationJob:
    payload = raw_job.get("payload")
    payload_dict = payload if isinstance(payload, dict) else {}

    return GenerationJob(
        id=parse_positive_int(raw_job.get("id")) or 0,
        run_id=str(raw_job.get("run_id") or ""),
        requested_by=str(raw_job.get("requested_by") or ""),
        target_date=str(raw_job.get("target_date") or ""),
        story_file=str(raw_job.get("story_file") or ""),
        dry_run=bool(raw_job.get("dry_run")),
        payload=payload_dict,
        log_file=str(raw_job.get("log_file") or ""),
        event_log_file=str(raw_job.get("event_log_file") or ""),
        summary_path=str(raw_job.get("summary_path") or ""),
    )


def parse_positive_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def parse_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def build_retry_image_task_from_api(raw_task: dict[str, Any]) -> RetryImageTask:
    return RetryImageTask(
        retry_id=parse_positive_int(raw_task.get("retry_id")) or 0,
        run_id=str(raw_task.get("run_id") or ""),
        scene_index=parse_positive_int(raw_task.get("scene_index")) or 0,
        scene_id=parse_positive_int(raw_task.get("scene_id")) or parse_positive_int(raw_task.get("scene_index")) or 1,
        title=str(raw_task.get("title") or "").strip(),
        description=str(raw_task.get("description") or "").strip(),
        story_text=str(raw_task.get("story_text") or "").strip(),
        image_prompt=str(raw_task.get("image_prompt") or "").strip(),
        mood=str(raw_task.get("mood") or "").strip(),
        characters=parse_string_list(raw_task.get("characters")),
        grid_rows=parse_positive_int(raw_task.get("grid_rows")) or 6,
        grid_cols=parse_positive_int(raw_task.get("grid_cols")) or 4,
        time_limit_sec=parse_positive_int(raw_task.get("time_limit_sec")) or 180,
        target_date=str(raw_task.get("target_date") or "").strip(),
        image_size=str(raw_task.get("image_size") or "2K").strip() or "2K",
        timeout_sec=parse_positive_float(raw_task.get("timeout_sec")) or 120.0,
        poll_seconds=parse_positive_float(raw_task.get("poll_seconds")) or 2.5,
        poll_attempts=parse_positive_int(raw_task.get("poll_attempts")) or 40,
        watermark=bool(raw_task.get("watermark")),
        output_root=str(raw_task.get("output_root") or "").strip(),
    )


def claim_next_retry_image_task_via_api(*, backend_url: str, worker_token: str, timeout: float) -> RetryImageTask | None:
    response = post_json(
        f"{backend_url}/api/internal/generation-candidate-retries/claim",
        {},
        worker_token=worker_token,
        timeout=timeout,
    )
    raw_task = response.get("task")
    if not isinstance(raw_task, dict) or not raw_task:
        return None
    return build_retry_image_task_from_api(raw_task)


def complete_retry_image_task_via_api(
    *,
    backend_url: str,
    worker_token: str,
    timeout: float,
    retry_id: int,
    status: str,
    image_url: str = "",
    image_path: str = "",
    error_message: str = "",
) -> None:
    encoded_retry_id = urllib.parse.quote(str(retry_id).strip(), safe="")
    post_json(
        f"{backend_url}/api/internal/generation-candidate-retries/{encoded_retry_id}/complete",
        {
            "status": status,
            "image_url": image_url,
            "image_path": image_path,
            "error_message": error_message,
        },
        worker_token=worker_token,
        timeout=timeout,
    )


def build_story_asset_url(local_path: Path, output_root: Path) -> str:
    try:
        normalized_output_root = output_root.resolve()
        normalized_local_path = local_path.resolve()
        relative = normalized_local_path.relative_to(normalized_output_root)
    except (OSError, ValueError):
        return ""

    return f"/content/stories/{relative.as_posix()}"


def run_retry_image_task(task: RetryImageTask) -> tuple[bool, str, str, str]:
    if not task.image_prompt:
        return False, "", "", "image_prompt is empty"

    api_key = get_required_api_key()
    base_url = get_env("AIHUBMIX_BASE_URL", "AIHUBMIX_OPENAI_BASE_URL", "OPENAI_BASE_URL", default=DEFAULT_IMAGE_BASE_URL)
    image_model = get_env("AIHUBMIX_IMAGE_MODEL", "STORY_GENERATOR_IMAGE_MODEL", default=DEFAULT_IMAGE_MODEL)

    output_root = Path(task.output_root).expanduser().resolve() if task.output_root else (ROOT_DIR / "backend" / "data" / "generated" / "content" / "stories")
    output_root.mkdir(parents=True, exist_ok=True)

    safe_run_id = re.sub(r"[^a-zA-Z0-9._-]+", "-", task.run_id).strip("-") or "retry"
    date_segment = task.target_date or dt.date.today().isoformat()
    date_segment = re.sub(r"[^0-9-]", "", date_segment) or dt.date.today().isoformat()
    retry_dir = f".review_candidates/{safe_run_id}/{date_segment}"

    scene = SceneDraft(
        scene_id=max(1, int(task.scene_id or task.scene_index or 1)),
        title=task.title or f"scene_{task.scene_index}",
        description=task.description,
        story_text=task.story_text,
        image_prompt=task.image_prompt,
        mood=task.mood,
        characters=task.characters,
        rows=max(2, int(task.grid_rows or 6)),
        cols=max(2, int(task.grid_cols or 4)),
        time_limit_sec=max(30, int(task.time_limit_sec or 180)),
    )

    results = asyncio.run(
        generate_images_for_story(
            scenes=[scene],
            date_str=retry_dir,
            images_dir=output_root,
            api_key=api_key,
            base_url=base_url,
            image_model=image_model,
            image_size=task.image_size,
            watermark=task.watermark,
            concurrency=1,
            timeout_sec=max(10.0, float(task.timeout_sec)),
            poll_seconds=max(0.2, float(task.poll_seconds)),
            poll_attempts=max(1, int(task.poll_attempts)),
        )
    )

    if not results:
        return False, "", "", "no image result"

    result = results[0]
    if result.status != "success" or result.local_path is None:
        return False, str(result.image_url or ""), "", str(result.reason or "retry image generation failed")

    local_path = result.local_path.resolve()
    image_url = build_story_asset_url(local_path, output_root)
    return True, image_url, str(local_path), ""


def claim_next_job_via_api(*, backend_url: str, worker_token: str, timeout: float) -> GenerationJob | None:
    response = post_json(
        f"{backend_url}/api/internal/generation-jobs/claim",
        {},
        worker_token=worker_token,
        timeout=timeout,
    )
    raw_job = response.get("job")
    if not isinstance(raw_job, dict) or not raw_job:
        return None
    return build_generation_job_from_api(raw_job)


def complete_job_via_api(
    *,
    backend_url: str,
    worker_token: str,
    timeout: float,
    run_id: str,
    status: str,
    exit_code: int | None,
    error_message: str,
    story_id: str = "",
) -> None:
    encoded_run_id = urllib.parse.quote(str(run_id).strip(), safe="")
    post_json(
        f"{backend_url}/api/internal/generation-jobs/{encoded_run_id}/complete",
        {
            "status": status,
            "exit_code": exit_code,
            "error_message": error_message,
            "story_id": story_id,
        },
        worker_token=worker_token,
        timeout=timeout,
    )


def claim_next_job(conn: sqlite3.Connection) -> GenerationJob | None:
    now = now_iso()
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            """
            SELECT id, run_id, requested_by, target_date, story_file, dry_run,
                   payload_json, log_file, event_log_file, summary_path
            FROM generation_jobs
            WHERE status = 'queued'
            ORDER BY created_at ASC, id ASC
            LIMIT 1
            """,
        ).fetchone()
        if row is None:
            conn.execute("COMMIT")
            return None

        updated = conn.execute(
            """
            UPDATE generation_jobs
            SET status = 'running',
                started_at = COALESCE(started_at, ?),
                error_message = '',
                exit_code = NULL,
                updated_at = ?
            WHERE id = ? AND status = 'queued'
            """,
            (now, now, row["id"]),
        )
        if updated.rowcount != 1:
            conn.execute("ROLLBACK")
            return None

        conn.execute("COMMIT")
        return GenerationJob(
            id=int(row["id"]),
            run_id=str(row["run_id"]),
            requested_by=str(row["requested_by"] or ""),
            target_date=str(row["target_date"]),
            story_file=str(row["story_file"] or ""),
            dry_run=bool(row["dry_run"]),
            payload=safe_parse_json_object(row["payload_json"]),
            log_file=str(row["log_file"] or ""),
            event_log_file=str(row["event_log_file"] or ""),
            summary_path=str(row["summary_path"] or ""),
        )
    except Exception:
        conn.execute("ROLLBACK")
        raise


def complete_job(conn: sqlite3.Connection, *, job_id: int, status: str, exit_code: int | None, error_message: str) -> None:
    now = now_iso()
    conn.execute(
        """
        UPDATE generation_jobs
        SET status = ?,
            exit_code = ?,
            error_message = ?,
            ended_at = COALESCE(ended_at, ?),
            updated_at = ?
        WHERE id = ?
        """,
        (status, exit_code, error_message, now, now, job_id),
    )
    conn.commit()


def append_optional_arg(command: list[str], flag: str, value: Any) -> None:
    if value is None:
        return
    text = str(value).strip()
    if not text:
        return
    command.extend([flag, text])


def append_optional_number(command: list[str], flag: str, value: Any) -> None:
    if value is None:
        return
    if isinstance(value, bool):
        return
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return
    if parsed <= 0:
        return
    if parsed.is_integer():
        command.extend([flag, str(int(parsed))])
    else:
        command.extend([flag, str(parsed)])


def build_pipeline_command(job: GenerationJob, python_bin: str) -> list[str]:
    payload = job.payload
    command = [python_bin, "-m", "scripts.story_generator_pipeline.generate_story"]

    append_optional_arg(command, "--run-id", payload.get("run_id") or job.run_id)
    append_optional_arg(command, "--target-date", payload.get("target_date") or job.target_date)
    append_optional_arg(command, "--story-file", payload.get("story_file") or job.story_file)

    append_optional_arg(command, "--output-root", payload.get("output_root"))
    append_optional_arg(command, "--index-file", payload.get("index_file"))
    append_optional_arg(command, "--summary-output-dir", payload.get("summary_output_dir"))
    append_optional_arg(command, "--story-id", payload.get("story_id"))

    append_optional_number(command, "--candidate-scenes", payload.get("candidate_scenes"))
    append_optional_number(command, "--min-scenes", payload.get("min_scenes"))
    append_optional_number(command, "--max-scenes", payload.get("max_scenes"))
    append_optional_number(command, "--concurrency", payload.get("concurrency"))

    append_optional_arg(command, "--image-size", payload.get("image_size"))
    append_optional_number(command, "--timeout-sec", payload.get("timeout_sec"))
    append_optional_number(command, "--poll-seconds", payload.get("poll_seconds"))
    append_optional_number(command, "--poll-attempts", payload.get("poll_attempts"))

    append_optional_arg(command, "--log-file", payload.get("log_file") or job.log_file)
    append_optional_arg(command, "--event-log-file", payload.get("event_log_file") or job.event_log_file)

    if bool(payload.get("watermark")):
        command.append("--watermark")
    if bool(payload.get("review_mode")):
        command.append("--review-mode")
    if job.dry_run or bool(payload.get("dry_run")):
        command.append("--dry-run")

    return command


def run_job(job: GenerationJob, *, python_bin: str) -> tuple[int, str]:
    command = build_pipeline_command(job, python_bin)
    LOGGER.info("Run job %s as %s", job.run_id, command[0])
    LOGGER.debug("Pipeline command: %s", " ".join(command))

    completed = subprocess.run(command, cwd=ROOT_DIR, env=os.environ.copy(), check=False)
    exit_code = int(completed.returncode)

    if exit_code == 0:
        return 0, ""

    return exit_code, f"pipeline exited with code {exit_code}"


def sync_books_generation_link(job: GenerationJob, books_db_path: Path) -> None:
    if job.dry_run:
        LOGGER.info("Skip books sync for dry-run job: %s", job.run_id)
        return

    summary = read_json_file(job.summary_path)
    chapter_id = extract_chapter_id(job, summary)
    if not chapter_id:
        LOGGER.info("Skip books sync: no chapter_id found for run_id=%s", job.run_id)
        return

    if not books_db_path.exists():
        LOGGER.warning("Skip books sync: books db not found: %s", books_db_path)
        return

    story_id = extract_story_id(job, summary)

    conn = sqlite3.connect(books_db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")

    try:
        conn.execute("BEGIN IMMEDIATE")

        chapter = conn.execute("SELECT id FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
        if chapter is None:
            conn.execute("ROLLBACK")
            LOGGER.warning("Skip books sync: chapter not found in books db: chapter_id=%s", chapter_id)
            return

        usage = conn.execute(
            """
            SELECT id, pipeline_run_id
            FROM chapter_usage
            WHERE chapter_id = ?
              AND usage_type = 'puzzle_story'
              AND status = 'succeeded'
            LIMIT 1
            """,
            (chapter_id,),
        ).fetchone()

        is_same_run = bool(usage and str(usage["pipeline_run_id"] or "") == job.run_id)

        if usage:
            conn.execute(
                """
                UPDATE chapter_usage
                SET pipeline_run_id = ?,
                    generated_story_id = ?,
                    summary_path = ?,
                    status = 'succeeded',
                    error_message = '',
                    updated_at = datetime('now')
                WHERE id = ?
                """,
                (job.run_id, story_id, job.summary_path, usage["id"]),
            )
        else:
            conn.execute(
                """
                INSERT INTO chapter_usage (
                    chapter_id, usage_type, status, reserved_at, expires_at,
                    pipeline_run_id, generated_story_id, summary_path, error_message, updated_at
                )
                VALUES (?, 'puzzle_story', 'succeeded', datetime('now'), NULL, ?, ?, ?, '', datetime('now'))
                """,
                (chapter_id, job.run_id, story_id, job.summary_path),
            )

        if not is_same_run:
            conn.execute(
                """
                UPDATE chapters
                SET used_count = used_count + 1,
                    last_used_at = datetime('now'),
                    updated_at = datetime('now')
                WHERE id = ?
                """,
                (chapter_id,),
            )

        conn.execute("COMMIT")
        LOGGER.info(
            "Books sync done: run_id=%s chapter_id=%s story_id=%s",
            job.run_id,
            chapter_id,
            story_id or "",
        )
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def run_worker(args: argparse.Namespace) -> int:
    stop_signal = StopSignal()

    def _handle_signal(_signum: int, _frame: Any) -> None:
        stop_signal.stop()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    db_path = Path(args.db).expanduser().resolve()
    backend_url = normalize_backend_url(args.backend_url)
    worker_token = str(args.worker_token or "").strip()
    http_timeout = max(1.0, float(args.http_timeout))
    use_api_mode = bool(backend_url)
    books_db_path = Path(args.books_db).expanduser().resolve()
    poll_seconds = max(0.2, float(args.poll_seconds))
    max_jobs = max(0, int(args.max_jobs))
    processed = 0

    if use_api_mode and not worker_token:
        LOGGER.error("API mode requires --worker-token or STORY_GENERATOR_WORKER_TOKEN")
        return 2

    LOGGER.info(
        "Queue worker started: mode=%s backend=%s db=%s books_db=%s poll_seconds=%.2f",
        "api" if use_api_mode else "sqlite",
        backend_url or "",
        db_path if not use_api_mode else "",
        books_db_path,
        poll_seconds,
    )

    conn: sqlite3.Connection | None = None
    if not use_api_mode:
        conn = connect_db(db_path)

    try:
        while not stop_signal.stopped:
            if max_jobs > 0 and processed >= max_jobs:
                LOGGER.info("Reached max-jobs=%s, exiting", max_jobs)
                break

            try:
                job: GenerationJob | None = None
                retry_task: RetryImageTask | None = None
                if use_api_mode:
                    job = claim_next_job_via_api(
                        backend_url=backend_url,
                        worker_token=worker_token,
                        timeout=http_timeout,
                    )
                    if job is None:
                        retry_task = claim_next_retry_image_task_via_api(
                            backend_url=backend_url,
                            worker_token=worker_token,
                            timeout=http_timeout,
                        )
                else:
                    assert conn is not None
                    job = claim_next_job(conn)
            except sqlite3.OperationalError as error:
                if conn is not None and conn.in_transaction:
                    conn.rollback()
                LOGGER.warning("Queue poll failed: %s", error)
                time.sleep(poll_seconds)
                continue
            except Exception as error:  # noqa: BLE001
                LOGGER.warning("Queue poll failed: %s", error)
                time.sleep(poll_seconds)
                continue

            if job is None and retry_task is None:
                if args.once:
                    LOGGER.info("No queued task found, exiting due to --once")
                    break
                time.sleep(poll_seconds)
                continue

            if retry_task is not None:
                processed += 1
                LOGGER.info(
                    "Claimed retry task retry_id=%s run_id=%s scene_index=%s",
                    retry_task.retry_id,
                    retry_task.run_id,
                    retry_task.scene_index,
                )

                try:
                    succeeded, image_url, image_path, error_message = run_retry_image_task(retry_task)
                    if succeeded:
                        complete_retry_image_task_via_api(
                            backend_url=backend_url,
                            worker_token=worker_token,
                            timeout=http_timeout,
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
                    else:
                        complete_retry_image_task_via_api(
                            backend_url=backend_url,
                            worker_token=worker_token,
                            timeout=http_timeout,
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
                        complete_retry_image_task_via_api(
                            backend_url=backend_url,
                            worker_token=worker_token,
                            timeout=http_timeout,
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

                if args.once:
                    break
                continue

            processed += 1
            LOGGER.info("Claimed job run_id=%s requested_by=%s", job.run_id, job.requested_by)

            try:
                exit_code, error_message = run_job(job, python_bin=args.python_bin)
                summary = read_json_file(job.summary_path)
                completed_story_id = extract_story_id(job, summary)
                if exit_code == 0:
                    if use_api_mode:
                        complete_job_via_api(
                            backend_url=backend_url,
                            worker_token=worker_token,
                            timeout=http_timeout,
                            run_id=job.run_id,
                            status="succeeded",
                            exit_code=0,
                            error_message="",
                            story_id=completed_story_id,
                        )
                    else:
                        assert conn is not None
                        complete_job(conn, job_id=job.id, status="succeeded", exit_code=0, error_message="")

                    if not args.skip_books_sync:
                        try:
                            sync_books_generation_link(job, books_db_path)
                        except Exception as sync_error:  # noqa: BLE001
                            LOGGER.warning("Books sync failed for run_id=%s: %s", job.run_id, sync_error)
                    LOGGER.info("Job succeeded: run_id=%s", job.run_id)
                else:
                    if use_api_mode:
                        complete_job_via_api(
                            backend_url=backend_url,
                            worker_token=worker_token,
                            timeout=http_timeout,
                            run_id=job.run_id,
                            status="failed",
                            exit_code=exit_code,
                            error_message=error_message,
                            story_id=completed_story_id,
                        )
                    else:
                        assert conn is not None
                        complete_job(
                            conn,
                            job_id=job.id,
                            status="failed",
                            exit_code=exit_code,
                            error_message=error_message,
                        )

                    LOGGER.error("Job failed: run_id=%s exit_code=%s", job.run_id, exit_code)
            except Exception as error:  # noqa: BLE001
                try:
                    if use_api_mode:
                        complete_job_via_api(
                            backend_url=backend_url,
                            worker_token=worker_token,
                            timeout=http_timeout,
                            run_id=job.run_id,
                            status="failed",
                            exit_code=None,
                            error_message=str(error),
                            story_id="",
                        )
                    else:
                        assert conn is not None
                        complete_job(
                            conn,
                            job_id=job.id,
                            status="failed",
                            exit_code=None,
                            error_message=str(error),
                        )
                except Exception as complete_error:  # noqa: BLE001
                    LOGGER.warning("Mark job failed error: run_id=%s err=%s", job.run_id, complete_error)

                LOGGER.exception("Unexpected worker error for run_id=%s", job.run_id)

            if args.once:
                break
    finally:
        if conn is not None:
            conn.close()

    LOGGER.info("Queue worker stopped")
    return 0


def main() -> int:
    args = parse_args()
    setup_logging(args.log_level)
    return run_worker(args)


if __name__ == "__main__":
    raise SystemExit(main())
