"""Books usage sync helpers for queue worker success path."""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from pathlib import Path
from typing import Any

from .types import GenerationJob


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


def sync_books_generation_link(job: GenerationJob, books_db_path: Path, *, logger: logging.Logger) -> None:
    if job.dry_run:
        logger.info("Skip books sync for dry-run job: %s", job.run_id)
        return

    summary = read_json_file(job.summary_path)
    chapter_id = extract_chapter_id(job, summary)
    if not chapter_id:
        logger.info("Skip books sync: no chapter_id found for run_id=%s", job.run_id)
        return

    if not books_db_path.exists():
        logger.warning("Skip books sync: books db not found: %s", books_db_path)
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
            logger.warning("Skip books sync: chapter not found in books db: chapter_id=%s", chapter_id)
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
        logger.info(
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
