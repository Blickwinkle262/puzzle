"""Backfill chapter-generation linkage from backend generation_jobs to books.sqlite.

Usage:
  uv run python scripts/book_ingest/backfill_generation_links.py
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_BACKEND_DB = ROOT_DIR / "backend" / "data" / "puzzle.sqlite"
DEFAULT_BOOKS_DB = ROOT_DIR / "scripts" / "book_ingest" / "data" / "books.sqlite"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill chapter usage from generation_jobs.")
    parser.add_argument("--backend-db", default=str(DEFAULT_BACKEND_DB), help="Path to backend puzzle.sqlite")
    parser.add_argument("--books-db", default=str(DEFAULT_BOOKS_DB), help="Path to book_ingest books.sqlite")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, do not write books db")
    return parser.parse_args()


def parse_json_object(value: str | None) -> dict[str, Any]:
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


def choose_jobs_per_chapter(backend_conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = backend_conn.execute(
        """
        SELECT run_id, payload_json, summary_path, story_file, created_at, updated_at, ended_at
        FROM generation_jobs
        WHERE status = 'succeeded'
        ORDER BY COALESCE(ended_at, updated_at, created_at) DESC, id DESC
        """,
    ).fetchall()

    selected: dict[int, dict[str, Any]] = {}

    for row in rows:
        payload = parse_json_object(row["payload_json"])
        summary = read_json_file(str(row["summary_path"] or ""))

        chapter_id = parse_positive_int(payload.get("chapter_id"))
        if chapter_id is None:
            chapter_id = infer_chapter_id_from_path(str(payload.get("story_file") or ""))
        if chapter_id is None:
            chapter_id = infer_chapter_id_from_path(str(row["story_file"] or ""))
        if chapter_id is None:
            chapter_id = infer_chapter_id_from_path(str(summary.get("source_file") or ""))
        if chapter_id is None:
            continue

        if chapter_id in selected:
            continue

        story_id = str(summary.get("story_id") or payload.get("story_id") or "").strip()
        selected[chapter_id] = {
            "chapter_id": chapter_id,
            "run_id": str(row["run_id"] or ""),
            "story_id": story_id,
            "summary_path": str(row["summary_path"] or ""),
            "generated_at": str(row["ended_at"] or row["updated_at"] or row["created_at"] or ""),
        }

    return list(selected.values())


def upsert_books_usage(books_conn: sqlite3.Connection, item: dict[str, Any]) -> bool:
    chapter_id = int(item["chapter_id"])
    run_id = str(item["run_id"])
    story_id = str(item.get("story_id") or "")
    summary_path = str(item.get("summary_path") or "")

    chapter = books_conn.execute("SELECT id FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
    if chapter is None:
        return False

    usage = books_conn.execute(
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

    same_run = bool(usage and str(usage["pipeline_run_id"] or "") == run_id)

    if usage:
        books_conn.execute(
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
            (run_id, story_id, summary_path, usage["id"]),
        )
    else:
        books_conn.execute(
            """
            INSERT INTO chapter_usage (
                chapter_id, usage_type, status, reserved_at, expires_at,
                pipeline_run_id, generated_story_id, summary_path, error_message, updated_at
            )
            VALUES (?, 'puzzle_story', 'succeeded', datetime('now'), NULL, ?, ?, ?, '', datetime('now'))
            """,
            (chapter_id, run_id, story_id, summary_path),
        )

    if not same_run:
        books_conn.execute(
            """
            UPDATE chapters
            SET used_count = used_count + 1,
                last_used_at = datetime('now'),
                updated_at = datetime('now')
            WHERE id = ?
            """,
            (chapter_id,),
        )

    return True


def main() -> int:
    args = parse_args()
    backend_db = Path(args.backend_db).expanduser().resolve()
    books_db = Path(args.books_db).expanduser().resolve()

    if not backend_db.exists():
        raise SystemExit(f"backend db not found: {backend_db}")
    if not books_db.exists():
        raise SystemExit(f"books db not found: {books_db}")

    backend_conn = sqlite3.connect(backend_db)
    backend_conn.row_factory = sqlite3.Row

    try:
        jobs = choose_jobs_per_chapter(backend_conn)
    finally:
        backend_conn.close()

    print(f"[info] candidate chapter links: {len(jobs)}")
    if args.dry_run:
        for item in jobs[:20]:
            print(f"[dry-run] chapter={item['chapter_id']} run={item['run_id']} story={item['story_id']}")
        return 0

    books_conn = sqlite3.connect(books_db)
    books_conn.row_factory = sqlite3.Row
    books_conn.execute("PRAGMA busy_timeout = 5000")

    updated = 0
    skipped = 0

    try:
        books_conn.execute("BEGIN IMMEDIATE")
        for item in jobs:
            ok = upsert_books_usage(books_conn, item)
            if ok:
                updated += 1
            else:
                skipped += 1
        books_conn.execute("COMMIT")
    except Exception:
        books_conn.execute("ROLLBACK")
        raise
    finally:
        books_conn.close()

    print(f"[done] updated={updated} skipped={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
