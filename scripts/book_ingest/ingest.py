#!/usr/bin/env python3
"""Ingest TXT/EPUB books into chapterized SQLite storage."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .parsers import parse_book
from .repository import BookRepository
from .storage import apply_schema, connect_db, new_run_id, utc_now

DEFAULT_DB = Path("scripts/book_ingest/data/books.sqlite")


def _parse_json(value: str, *, field_name: str) -> dict:
    if not value:
        return {}
    try:
        data = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{field_name} must be valid JSON") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{field_name} must be a JSON object")
    return data


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Ingest a book file into SQLite chapter storage.")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--source", required=True)
    parser.add_argument("--format", choices=["auto", "txt", "epub"], default="auto")
    parser.add_argument("--title", default="")
    parser.add_argument("--author", default="")
    parser.add_argument("--genre", default="")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--book-meta-json", default="{}")
    parser.add_argument("--chapter-meta-json", default="{}")
    parser.add_argument("--min-chars", type=int, default=0)
    parser.add_argument("--max-chapters", type=int, default=0)
    parser.add_argument("--replace-book", action="store_true")
    return parser


def run(args: argparse.Namespace) -> dict:
    source_path = Path(args.source).expanduser().resolve()
    if not source_path.exists() or not source_path.is_file():
        raise FileNotFoundError(f"Source file not found: {source_path}")

    book_meta = _parse_json(args.book_meta_json, field_name="--book-meta-json")
    chapter_meta = _parse_json(args.chapter_meta_json, field_name="--chapter-meta-json")

    db_path = Path(args.db).expanduser().resolve()
    conn = connect_db(db_path)
    apply_schema(conn)
    repo = BookRepository(conn)

    run_id = new_run_id("ingest")
    ingest_run_id = repo.start_ingest_run(
        run_id=run_id,
        source_path=str(source_path),
        source_format=args.format,
        started_at=utc_now(),
    )

    inserted = 0
    updated = 0
    skipped = 0

    try:
        parsed = parse_book(
            source_path,
            source_format=args.format,
            fallback_title=args.title.strip() or None,
            fallback_author=args.author.strip(),
            min_chapter_chars=max(0, int(args.min_chars)),
            base_chapter_meta=chapter_meta,
        )

        metadata = dict(book_meta)
        metadata.update(parsed.metadata)
        book_id = repo.upsert_book(
            title=parsed.title,
            author=parsed.author,
            source_path=str(source_path),
            source_format=parsed.source_format,
            language=args.language.strip() or "zh",
            genre=args.genre.strip(),
            metadata_json=metadata,
        )

        if args.replace_book:
            removed = repo.replace_book_chapters(book_id=book_id)
            repo.log_ingest_item(
                ingest_run_id=ingest_run_id,
                chapter_key=f"book:{book_id}",
                action="updated",
                detail=f"replace_book=true, removed={removed}",
            )

        chapters = parsed.chapters
        if args.max_chapters and args.max_chapters > 0:
            chapters = chapters[: int(args.max_chapters)]

        for chapter in chapters:
            chapter_key = f"{book_id}:{chapter.chapter_index}:{chapter.chapter_title}"
            action = repo.upsert_chapter(
                book_id=book_id,
                chapter_index=chapter.chapter_index,
                chapter_title=chapter.chapter_title,
                chapter_text=chapter.chapter_text,
                char_count=chapter.char_count,
                word_count=chapter.word_count,
                checksum=chapter.checksum,
                meta_json=chapter.meta,
            )

            if action == "inserted":
                inserted += 1
            elif action == "updated":
                updated += 1
            else:
                skipped += 1

            repo.log_ingest_item(
                ingest_run_id=ingest_run_id,
                chapter_key=chapter_key,
                action=action,
                detail=f"char_count={chapter.char_count}",
            )

        total = inserted + updated + skipped
        repo.finish_ingest_run(
            run_id=ingest_run_id,
            status="success",
            total=total,
            inserted=inserted,
            updated=updated,
            skipped=skipped,
        )
        conn.commit()

        return {
            "run_id": run_id,
            "db": str(db_path),
            "source": str(source_path),
            "book_title": parsed.title,
            "book_author": parsed.author,
            "format": parsed.source_format,
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "total": total,
        }
    except Exception as exc:
        repo.finish_ingest_run(
            run_id=ingest_run_id,
            status="failed",
            total=inserted + updated + skipped,
            inserted=inserted,
            updated=updated,
            skipped=skipped,
            error_message=str(exc)[:500],
        )
        conn.commit()
        raise
    finally:
        conn.close()


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        payload = run(args)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1

    print(json.dumps({"ok": True, **payload}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
