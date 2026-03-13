#!/usr/bin/env python3
"""Generate chapter summaries and store them into chapter meta_json."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

from .storage import apply_schema, connect_db, new_run_id, utc_now

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore[assignment]


DEFAULT_DB = Path("scripts/book_ingest/data/books.sqlite")
DEFAULT_BASE_URL = "https://aihubmix.com/v1"
DEFAULT_TEXT_MODEL = "qwen3-next-80b-a3b-instruct"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate chapter summaries for a book.")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--book-id", type=int, default=0)
    parser.add_argument("--chapter-id", type=int, default=0)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--chunk-size", type=int, default=1000)
    parser.add_argument("--summary-max-chars", type=int, default=200)
    parser.add_argument("--text-model", default=os.environ.get("STORY_GENERATOR_TEXT_MODEL", DEFAULT_TEXT_MODEL))
    parser.add_argument("--base-url", default=os.environ.get("AIHUBMIX_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--api-key", default=os.environ.get("AIHUBMIX_API_KEY", ""))
    parser.add_argument("--force", action="store_true")
    return parser


def _normalize_text(text: str) -> str:
    value = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in value.split("\n")]
    compact: list[str] = []
    blank = False
    for line in lines:
        if not line:
            if not blank:
                compact.append("")
                blank = True
            continue
        compact.append(line)
        blank = False
    return "\n".join(compact).strip()


def _split_text_chunks(text: str, max_chars: int) -> list[str]:
    normalized = _normalize_text(text)
    if not normalized:
        return []

    limit = max(200, int(max_chars or 1000))
    paragraphs = [item.strip() for item in re.split(r"\n{2,}", normalized) if item.strip()]

    if not paragraphs:
        paragraphs = [normalized]

    chunks: list[str] = []
    buffer = ""

    def flush() -> None:
        nonlocal buffer
        if buffer.strip():
            chunks.append(buffer.strip())
        buffer = ""

    for paragraph in paragraphs:
        if len(paragraph) > limit:
            flush()
            start = 0
            while start < len(paragraph):
                piece = paragraph[start : start + limit]
                if piece.strip():
                    chunks.append(piece.strip())
                start += limit
            continue

        candidate = f"{buffer}\n\n{paragraph}".strip() if buffer else paragraph
        if len(candidate) <= limit:
            buffer = candidate
            continue

        flush()
        buffer = paragraph

    flush()
    return [item for item in chunks if item.strip()]


def _truncate_chars(text: str, max_chars: int) -> str:
    value = str(text or "").strip()
    if max_chars <= 0:
        return value
    if len(value) <= max_chars:
        return value
    return value[:max_chars].rstrip("，、；：,. ") + "…"


def _fallback_summary(text: str, max_chars: int) -> str:
    normalized = _normalize_text(text)
    if not normalized:
        return ""

    sentences = [item.strip() for item in re.split(r"(?<=[。！？!?；;])", normalized) if item.strip()]
    if not sentences:
        return _truncate_chars(normalized, max_chars)

    picked: list[str] = []
    current = ""
    for sentence in sentences:
        candidate = f"{current}{sentence}"
        if len(candidate) > max_chars and picked:
            break
        picked.append(sentence)
        current = candidate
        if len(current) >= max_chars:
            break

    result = "".join(picked).strip() or sentences[0]
    return _truncate_chars(result, max_chars)


def _summarize_with_llm(*, client: Any, model: str, text: str, max_chars: int, mode: str) -> str:
    if client is None:
        raise RuntimeError("client is required")

    if mode == "merge":
        user_prompt = (
            f"请将下面同一章节的分段摘要合并为一段连贯中文，不超过{max_chars}字。"
            "保留关键人物、冲突和结果，不要列编号。\n\n"
            f"分段摘要：\n{text}"
        )
    else:
        user_prompt = (
            f"请总结以下章节内容，不超过{max_chars}字。"
            "要求中文、简洁、保留核心情节，不要分点。\n\n"
            f"原文：\n{text}"
        )

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "你是中文文学章节摘要助手。"},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.2,
        max_tokens=320,
    )

    content = ""
    try:
        content = str(response.choices[0].message.content or "").strip()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"invalid llm response: {exc}") from exc

    if not content:
        raise RuntimeError("empty llm summary")

    return _truncate_chars(content, max_chars)


def _build_llm_client(api_key: str, base_url: str) -> Any:
    if not api_key or not str(api_key).strip():
        return None
    if OpenAI is None:
        return None
    return OpenAI(api_key=str(api_key).strip(), base_url=str(base_url or DEFAULT_BASE_URL).strip())


def _summarize_text(*, client: Any, model: str, text: str, max_chars: int, mode: str) -> tuple[str, str]:
    normalized = _normalize_text(text)
    if not normalized:
        return "", "empty"

    try:
        summary = _summarize_with_llm(client=client, model=model, text=normalized, max_chars=max_chars, mode=mode)
        if summary.strip():
            return summary.strip(), model
    except Exception:
        pass

    return _fallback_summary(normalized, max_chars), "fallback_extractive"


def _load_target_chapters(conn, *, book_id: int, chapter_id: int) -> list[dict[str, Any]]:
    if chapter_id > 0:
        row = conn.execute(
            """
            SELECT c.id, c.book_id, b.title AS book_title, c.chapter_index, c.chapter_title,
                   c.chapter_text, c.char_count, c.meta_json
            FROM chapters c
            JOIN books b ON b.id = c.book_id
            WHERE c.id = ?
            LIMIT 1
            """,
            (chapter_id,),
        ).fetchone()
        return [dict(row)] if row is not None else []

    rows = conn.execute(
        """
        SELECT c.id, c.book_id, b.title AS book_title, c.chapter_index, c.chapter_title,
               c.chapter_text, c.char_count, c.meta_json
        FROM chapters c
        JOIN books b ON b.id = c.book_id
        WHERE c.book_id = ?
        ORDER BY c.chapter_index ASC, c.id ASC
        """,
        (book_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def run(args: argparse.Namespace) -> dict[str, Any]:
    db_path = Path(args.db).expanduser().resolve()
    conn = connect_db(db_path)
    apply_schema(conn)

    book_id = int(args.book_id or 0)
    chapter_id = int(args.chapter_id or 0)
    if book_id <= 0 and chapter_id <= 0:
        raise ValueError("--book-id 或 --chapter-id 至少传一个")

    chapters = _load_target_chapters(conn, book_id=book_id, chapter_id=chapter_id)
    if not chapters:
        raise ValueError("未找到可处理章节")

    run_id = str(args.run_id or "").strip() or new_run_id("summary")
    chunk_size = max(300, int(args.chunk_size or 1000))
    summary_max_chars = max(80, int(args.summary_max_chars or 200))
    force = bool(args.force)

    scope_type = "chapter" if chapter_id > 0 else "book"
    scope_id = chapter_id if chapter_id > 0 else book_id

    conn.execute(
        """
        INSERT OR REPLACE INTO chapter_summary_runs (
          run_id, scope_type, scope_id, started_at, status,
          total_chapters, processed_chapters, succeeded_chapters,
          failed_chapters, skipped_chapters, error_message
        ) VALUES (?, ?, ?, datetime('now'), 'running', ?, 0, 0, 0, 0, '')
        """,
        (run_id, scope_type, scope_id, len(chapters)),
    )
    conn.commit()

    api_key = str(args.api_key or "").strip()
    base_url = str(args.base_url or DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL
    model = str(args.text_model or DEFAULT_TEXT_MODEL).strip() or DEFAULT_TEXT_MODEL
    client = _build_llm_client(api_key, base_url)

    succeeded = 0
    failed = 0
    skipped = 0
    first_error = ""

    run_row = conn.execute("SELECT id FROM chapter_summary_runs WHERE run_id = ? LIMIT 1", (run_id,)).fetchone()
    if run_row is None:
        raise RuntimeError("创建摘要任务失败")
    run_db_id = int(run_row[0])

    def _flush_run_progress() -> None:
        processed = succeeded + skipped + failed
        conn.execute(
            """
            UPDATE chapter_summary_runs
            SET status = 'running',
                processed_chapters = ?,
                succeeded_chapters = ?,
                failed_chapters = ?,
                skipped_chapters = ?,
                error_message = ?
            WHERE run_id = ?
            """,
            (
                processed,
                succeeded,
                failed,
                skipped,
                first_error,
                run_id,
            ),
        )
        conn.commit()

    for chapter in chapters:
        chapter_meta = {}
        try:
            chapter_meta = json.loads(str(chapter.get("meta_json") or "{}"))
            if not isinstance(chapter_meta, dict):
                chapter_meta = {}
        except Exception:
            chapter_meta = {}

        summary_meta = chapter_meta.get("summary") if isinstance(chapter_meta.get("summary"), dict) else {}
        existing_summary = str(summary_meta.get("text") or "").strip()
        chapter_text = str(chapter.get("chapter_text") or "").strip()
        chapter_char_count = int(chapter.get("char_count") or len(chapter_text))
        chapter_db_id = int(chapter.get("id") or 0)

        if chapter_db_id <= 0 or not chapter_text:
            failed += 1
            message = "章节正文为空"
            if not first_error:
                first_error = message
            conn.execute(
                """
                INSERT INTO chapter_summary_run_items (
                  summary_run_id, chapter_id, status, source_chars, chunks_count, summary_text, error_message
                ) VALUES (?, ?, 'failed', ?, 0, '', ?)
                ON CONFLICT(summary_run_id, chapter_id) DO UPDATE SET
                  status = excluded.status,
                  source_chars = excluded.source_chars,
                  chunks_count = excluded.chunks_count,
                  summary_text = excluded.summary_text,
                  error_message = excluded.error_message,
                  updated_at = datetime('now')
                """,
                (run_db_id, max(0, chapter_db_id), max(0, chapter_char_count), message),
            )
            _flush_run_progress()
            continue

        if existing_summary and not force:
            skipped += 1
            conn.execute(
                """
                INSERT INTO chapter_summary_run_items (
                  summary_run_id, chapter_id, status, source_chars, chunks_count, summary_text, error_message
                ) VALUES (?, ?, 'skipped', ?, 0, ?, '')
                ON CONFLICT(summary_run_id, chapter_id) DO UPDATE SET
                  status = excluded.status,
                  source_chars = excluded.source_chars,
                  summary_text = excluded.summary_text,
                  error_message = excluded.error_message,
                  updated_at = datetime('now')
                """,
                (run_db_id, chapter_db_id, max(0, chapter_char_count), existing_summary),
            )
            _flush_run_progress()
            continue

        try:
            chunks = _split_text_chunks(chapter_text, chunk_size)
            if not chunks:
                raise RuntimeError("章节正文为空")

            chunk_summaries: list[str] = []
            model_used = "fallback_extractive"
            for chunk in chunks:
                chunk_summary, used = _summarize_text(
                    client=client,
                    model=model,
                    text=chunk,
                    max_chars=min(140, summary_max_chars),
                    mode="chunk",
                )
                model_used = used if used != "fallback_extractive" else model_used
                chunk_summaries.append(chunk_summary)

            merged_source = "\n".join([f"片段{idx + 1}：{item}" for idx, item in enumerate(chunk_summaries)])
            final_summary, merge_used = _summarize_text(
                client=client,
                model=model,
                text=merged_source if len(chunk_summaries) > 1 else chunk_summaries[0],
                max_chars=summary_max_chars,
                mode="merge" if len(chunk_summaries) > 1 else "chunk",
            )
            if merge_used != "fallback_extractive":
                model_used = merge_used

            summary_payload = {
                "text": _truncate_chars(final_summary, summary_max_chars),
                "status": "succeeded",
                "updated_at": utc_now(),
                "source_chars": max(0, chapter_char_count),
                "chunk_size": chunk_size,
                "chunks": len(chunks),
                "max_chars": summary_max_chars,
                "model": model_used,
            }
            chapter_meta["summary"] = summary_payload

            conn.execute(
                "UPDATE chapters SET meta_json = ?, updated_at = datetime('now') WHERE id = ?",
                (json.dumps(chapter_meta, ensure_ascii=False), chapter_db_id),
            )

            conn.execute(
                """
                INSERT INTO chapter_summary_run_items (
                  summary_run_id, chapter_id, status, source_chars, chunks_count, summary_text, error_message
                ) VALUES (?, ?, 'succeeded', ?, ?, ?, '')
                ON CONFLICT(summary_run_id, chapter_id) DO UPDATE SET
                  status = excluded.status,
                  source_chars = excluded.source_chars,
                  chunks_count = excluded.chunks_count,
                  summary_text = excluded.summary_text,
                  error_message = excluded.error_message,
                  updated_at = datetime('now')
                """,
                (
                    run_db_id,
                    chapter_db_id,
                    max(0, chapter_char_count),
                    len(chunks),
                    str(summary_payload.get("text") or ""),
                ),
            )
            succeeded += 1
            _flush_run_progress()
        except Exception as exc:  # noqa: BLE001
            failed += 1
            message = str(exc).strip() or "章节摘要失败"
            if not first_error:
                first_error = message

            summary_payload = dict(summary_meta)
            summary_payload.update(
                {
                    "status": "failed",
                    "updated_at": utc_now(),
                    "error": message,
                }
            )
            chapter_meta["summary"] = summary_payload
            conn.execute(
                "UPDATE chapters SET meta_json = ?, updated_at = datetime('now') WHERE id = ?",
                (json.dumps(chapter_meta, ensure_ascii=False), chapter_db_id),
            )

            conn.execute(
                """
                INSERT INTO chapter_summary_run_items (
                  summary_run_id, chapter_id, status, source_chars, chunks_count, summary_text, error_message
                ) VALUES (?, ?, 'failed', ?, 0, '', ?)
                ON CONFLICT(summary_run_id, chapter_id) DO UPDATE SET
                  status = excluded.status,
                  source_chars = excluded.source_chars,
                  chunks_count = excluded.chunks_count,
                  summary_text = excluded.summary_text,
                  error_message = excluded.error_message,
                  updated_at = datetime('now')
                """,
                (
                    run_db_id,
                    chapter_db_id,
                    max(0, chapter_char_count),
                    message,
                ),
            )
            _flush_run_progress()

    processed = succeeded + skipped + failed
    status = "success" if failed == 0 else "failed"
    conn.execute(
        """
        UPDATE chapter_summary_runs
        SET status = ?,
            finished_at = datetime('now'),
            processed_chapters = ?,
            succeeded_chapters = ?,
            failed_chapters = ?,
            skipped_chapters = ?,
            error_message = ?
        WHERE run_id = ?
        """,
        (
            status,
            processed,
            succeeded,
            failed,
            skipped,
            first_error,
            run_id,
        ),
    )
    conn.commit()

    return {
        "ok": status == "success",
        "run_id": run_id,
        "status": status,
        "scope_type": scope_type,
        "scope_id": scope_id,
        "total": len(chapters),
        "processed": processed,
        "succeeded": succeeded,
        "failed": failed,
        "skipped": skipped,
        "error": first_error,
    }


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        payload = run(args)
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
