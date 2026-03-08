"""SQLite queue helpers for queue worker legacy mode."""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
from pathlib import Path
from typing import Any

from .types import GenerationJob


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


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


def complete_job(
    conn: sqlite3.Connection,
    *,
    job_id: int,
    status: str,
    exit_code: int | None,
    error_message: str,
    review_status: str = "",
) -> None:
    now = now_iso()
    published_at = now if review_status == "published" else None
    try:
        conn.execute(
            """
            UPDATE generation_jobs
            SET status = ?,
                review_status = ?,
                exit_code = ?,
                error_message = ?,
                published_at = ?,
                ended_at = COALESCE(ended_at, ?),
                updated_at = ?
            WHERE id = ?
            """,
            (status, review_status, exit_code, error_message, published_at, now, now, job_id),
        )
    except sqlite3.OperationalError as exc:
        if "review_status" not in str(exc).lower() and "published_at" not in str(exc).lower():
            raise
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
