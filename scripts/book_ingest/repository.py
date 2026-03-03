"""Repository layer for book ingestion and chapter usage tracking."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any


@dataclass
class ReserveResult:
    usage_id: int
    chapter_id: int
    book_id: int
    book_title: str
    chapter_index: int
    chapter_title: str
    chapter_text: str
    char_count: int
    used_count: int
    meta_json: dict[str, Any]


class BookRepository:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def upsert_book(
        self,
        *,
        title: str,
        author: str,
        source_path: str,
        source_format: str,
        language: str,
        genre: str,
        metadata_json: dict[str, Any],
    ) -> int:
        row = self.conn.execute("SELECT id FROM books WHERE source_path = ?", (source_path,)).fetchone()
        payload = json.dumps(metadata_json, ensure_ascii=False)

        if row:
            self.conn.execute(
                """
                UPDATE books
                SET title = ?, author = ?, source_format = ?, language = ?, genre = ?,
                    metadata_json = ?, updated_at = datetime('now')
                WHERE id = ?
                """,
                (title, author, source_format, language, genre, payload, row["id"]),
            )
            return int(row["id"])

        cursor = self.conn.execute(
            """
            INSERT INTO books (title, author, source_path, source_format, language, genre, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (title, author, source_path, source_format, language, genre, payload),
        )
        return int(cursor.lastrowid)

    def replace_book_chapters(self, *, book_id: int) -> int:
        cursor = self.conn.execute("DELETE FROM chapters WHERE book_id = ?", (book_id,))
        return int(cursor.rowcount)

    def start_ingest_run(self, *, run_id: str, source_path: str, source_format: str, started_at: str) -> int:
        cursor = self.conn.execute(
            """
            INSERT INTO ingest_runs (run_id, source_path, source_format, started_at, status)
            VALUES (?, ?, ?, ?, 'running')
            """,
            (run_id, source_path, source_format, started_at),
        )
        return int(cursor.lastrowid)

    def finish_ingest_run(
        self,
        *,
        run_id: int,
        status: str,
        total: int,
        inserted: int,
        updated: int,
        skipped: int,
        error_message: str = "",
    ) -> None:
        self.conn.execute(
            """
            UPDATE ingest_runs
            SET status = ?, finished_at = datetime('now'), total_chapters = ?,
                inserted_chapters = ?, updated_chapters = ?, skipped_chapters = ?,
                error_message = ?
            WHERE id = ?
            """,
            (status, total, inserted, updated, skipped, error_message, run_id),
        )

    def log_ingest_item(self, *, ingest_run_id: int, chapter_key: str, action: str, detail: str = "") -> None:
        self.conn.execute(
            """
            INSERT INTO ingest_run_items (ingest_run_id, chapter_key, action, detail)
            VALUES (?, ?, ?, ?)
            """,
            (ingest_run_id, chapter_key, action, detail),
        )

    def upsert_chapter(
        self,
        *,
        book_id: int,
        chapter_index: int,
        chapter_title: str,
        chapter_text: str,
        char_count: int,
        word_count: int,
        checksum: str,
        meta_json: dict[str, Any],
    ) -> str:
        payload = json.dumps(meta_json, ensure_ascii=False)

        by_checksum = self.conn.execute(
            "SELECT id, chapter_index, chapter_title, chapter_text, meta_json FROM chapters WHERE book_id = ? AND checksum = ?",
            (book_id, checksum),
        ).fetchone()
        if by_checksum:
            unchanged = (
                int(by_checksum["chapter_index"]) == chapter_index
                and str(by_checksum["chapter_title"]) == chapter_title
                and str(by_checksum["chapter_text"]) == chapter_text
                and str(by_checksum["meta_json"] or "{}") == payload
            )
            if unchanged:
                return "skipped_duplicate"
            self.conn.execute(
                """
                UPDATE chapters
                SET chapter_index = ?, chapter_title = ?, chapter_text = ?, char_count = ?,
                    word_count = ?, meta_json = ?, updated_at = datetime('now')
                WHERE id = ?
                """,
                (chapter_index, chapter_title, chapter_text, char_count, word_count, payload, by_checksum["id"]),
            )
            return "updated"

        by_index = self.conn.execute(
            "SELECT id FROM chapters WHERE book_id = ? AND chapter_index = ?",
            (book_id, chapter_index),
        ).fetchone()
        if by_index:
            self.conn.execute(
                """
                UPDATE chapters
                SET chapter_title = ?, chapter_text = ?, char_count = ?, word_count = ?,
                    checksum = ?, meta_json = ?, updated_at = datetime('now')
                WHERE id = ?
                """,
                (chapter_title, chapter_text, char_count, word_count, checksum, payload, by_index["id"]),
            )
            return "updated"

        self.conn.execute(
            """
            INSERT INTO chapters (
              book_id, chapter_index, chapter_title, chapter_text,
              char_count, word_count, checksum, meta_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (book_id, chapter_index, chapter_title, chapter_text, char_count, word_count, checksum, payload),
        )
        return "inserted"

    def expire_reservations(self, *, usage_type: str) -> int:
        cursor = self.conn.execute(
            """
            UPDATE chapter_usage
            SET status = 'expired', updated_at = datetime('now')
            WHERE usage_type = ? AND status = 'reserved'
              AND expires_at IS NOT NULL
              AND expires_at <= datetime('now')
            """,
            (usage_type,),
        )
        return int(cursor.rowcount)

    def reserve_next_chapter(
        self,
        *,
        usage_type: str,
        reserve_minutes: int,
        pipeline_run_id: str,
        min_chars: int,
        max_chars: int | None,
        book_id: int | None,
        genre: str | None,
        allow_reuse: bool,
        cooldown_days: int,
        exclude_toc_like: bool,
    ) -> ReserveResult | None:
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            self.expire_reservations(usage_type=usage_type)

            where = ["c.char_count >= ?"]
            params: list[Any] = [min_chars]

            if max_chars is not None:
                where.append("c.char_count <= ?")
                params.append(max_chars)

            if book_id is not None:
                where.append("c.book_id = ?")
                params.append(book_id)

            if genre:
                where.append("b.genre = ?")
                params.append(genre)

            if exclude_toc_like:
                where.append("COALESCE(CAST(json_extract(c.meta_json, '$.is_toc_like') AS INTEGER), 0) = 0")

            where.append(
                """
                NOT EXISTS (
                    SELECT 1
                    FROM chapter_usage ru
                    WHERE ru.chapter_id = c.id
                      AND ru.usage_type = ?
                      AND ru.status = 'reserved'
                      AND (ru.expires_at IS NULL OR ru.expires_at > datetime('now'))
                )
                """
            )
            params.append(usage_type)

            if allow_reuse:
                where.append("(c.last_used_at IS NULL OR julianday('now') - julianday(c.last_used_at) >= ?)")
                params.append(max(0, cooldown_days))
            else:
                where.append(
                    """
                    NOT EXISTS (
                        SELECT 1
                        FROM chapter_usage su
                        WHERE su.chapter_id = c.id
                          AND su.usage_type = ?
                          AND su.status = 'succeeded'
                    )
                    """
                )
                params.append(usage_type)

            sql = f"""
                SELECT c.id, c.book_id, c.chapter_index, c.chapter_title, c.chapter_text,
                       c.char_count, c.used_count, c.meta_json, b.title AS book_title
                FROM chapters c
                JOIN books b ON b.id = c.book_id
                WHERE {' AND '.join(where)}
                ORDER BY
                    CASE WHEN c.used_count = 0 THEN 0 ELSE 1 END,
                    c.used_count ASC,
                    CASE WHEN c.last_used_at IS NULL THEN 0 ELSE 1 END,
                    c.last_used_at ASC,
                    RANDOM()
                LIMIT 1
            """
            row = self.conn.execute(sql, params).fetchone()
            if row is None:
                self.conn.execute("ROLLBACK")
                return None

            cursor = self.conn.execute(
                """
                INSERT INTO chapter_usage (
                    chapter_id, usage_type, status, reserved_at, expires_at, pipeline_run_id, updated_at
                )
                VALUES (?, ?, 'reserved', datetime('now'), datetime('now', ?), ?, datetime('now'))
                """,
                (row["id"], usage_type, f"+{max(1, reserve_minutes)} minutes", pipeline_run_id or ""),
            )
            usage_id = int(cursor.lastrowid)
            self.conn.execute("COMMIT")

            return ReserveResult(
                usage_id=usage_id,
                chapter_id=int(row["id"]),
                book_id=int(row["book_id"]),
                book_title=str(row["book_title"]),
                chapter_index=int(row["chapter_index"]),
                chapter_title=str(row["chapter_title"]),
                chapter_text=str(row["chapter_text"]),
                char_count=int(row["char_count"]),
                used_count=int(row["used_count"]),
                meta_json=json.loads(row["meta_json"] or "{}"),
            )
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

    def _mark_usage(
        self,
        *,
        usage_id: int,
        target_status: str,
        error_message: str = "",
        generated_story_id: str = "",
        summary_path: str = "",
    ) -> int:
        cursor = self.conn.execute(
            """
            UPDATE chapter_usage
            SET status = ?, error_message = ?, generated_story_id = ?, summary_path = ?, updated_at = datetime('now')
            WHERE id = ?
            """,
            (target_status, error_message, generated_story_id, summary_path, usage_id),
        )
        return int(cursor.rowcount)

    def mark_succeeded(self, *, usage_id: int, generated_story_id: str, summary_path: str = "") -> bool:
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            usage = self.conn.execute(
                "SELECT chapter_id, status FROM chapter_usage WHERE id = ?",
                (usage_id,),
            ).fetchone()
            if usage is None or usage["status"] != "reserved":
                self.conn.execute("ROLLBACK")
                return False

            self._mark_usage(
                usage_id=usage_id,
                target_status="succeeded",
                generated_story_id=generated_story_id,
                summary_path=summary_path,
            )
            self.conn.execute(
                """
                UPDATE chapters
                SET used_count = used_count + 1,
                    last_used_at = datetime('now'),
                    updated_at = datetime('now')
                WHERE id = ?
                """,
                (usage["chapter_id"],),
            )
            self.conn.execute("COMMIT")
            return True
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

    def mark_failed(self, *, usage_id: int, error_message: str) -> bool:
        rows = self._mark_usage(usage_id=usage_id, target_status="failed", error_message=error_message)
        return rows == 1

    def mark_released(self, *, usage_id: int, error_message: str = "") -> bool:
        rows = self._mark_usage(usage_id=usage_id, target_status="released", error_message=error_message)
        return rows == 1

    def chapter_has_succeeded(self, *, chapter_id: int, usage_type: str) -> bool:
        row = self.conn.execute(
            """
            SELECT 1
            FROM chapter_usage
            WHERE chapter_id = ?
              AND usage_type = ?
              AND status = 'succeeded'
            LIMIT 1
            """,
            (chapter_id, usage_type),
        ).fetchone()
        return row is not None

    def get_usage(self, *, usage_id: int) -> dict[str, Any] | None:
        row = self.conn.execute(
            """
            SELECT u.*, c.chapter_title, c.chapter_index, c.book_id, b.title AS book_title
            FROM chapter_usage u
            JOIN chapters c ON c.id = u.chapter_id
            JOIN books b ON b.id = c.book_id
            WHERE u.id = ?
            """,
            (usage_id,),
        ).fetchone()
        if row is None:
            return None
        return dict(row)
