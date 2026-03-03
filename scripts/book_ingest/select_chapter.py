#!/usr/bin/env python3
"""Chapter selection and usage lifecycle operations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .repository import BookRepository
from .storage import apply_schema, connect_db, new_run_id

DEFAULT_DB = Path("scripts/book_ingest/data/books.sqlite")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reserve and manage chapter usage records.")
    sub = parser.add_subparsers(dest="command", required=True)

    reserve = sub.add_parser("reserve", help="Select and reserve one available chapter")
    reserve.add_argument("--db", default=str(DEFAULT_DB))
    reserve.add_argument("--usage-type", default="puzzle_story")
    reserve.add_argument("--reserve-minutes", type=int, default=30)
    reserve.add_argument("--pipeline-run-id", default="")
    reserve.add_argument("--book-id", type=int, default=None)
    reserve.add_argument("--genre", default="")
    reserve.add_argument("--min-chars", type=int, default=300)
    reserve.add_argument("--max-chars", type=int, default=None)
    reserve.add_argument("--allow-reuse", action="store_true")
    reserve.add_argument("--cooldown-days", type=int, default=30)
    reserve.add_argument("--include-toc-like", action="store_true")
    reserve.add_argument("--with-text", action="store_true")

    succeed = sub.add_parser("succeed", help="Mark reserved usage as succeeded")
    succeed.add_argument("--db", default=str(DEFAULT_DB))
    succeed.add_argument("--usage-id", type=int, required=True)
    succeed.add_argument("--generated-story-id", required=True)
    succeed.add_argument("--summary-path", default="")

    failed = sub.add_parser("fail", help="Mark usage as failed")
    failed.add_argument("--db", default=str(DEFAULT_DB))
    failed.add_argument("--usage-id", type=int, required=True)
    failed.add_argument("--error-message", default="")

    release = sub.add_parser("release", help="Release a reserved usage")
    release.add_argument("--db", default=str(DEFAULT_DB))
    release.add_argument("--usage-id", type=int, required=True)
    release.add_argument("--error-message", default="")

    info = sub.add_parser("usage", help="Inspect one usage record")
    info.add_argument("--db", default=str(DEFAULT_DB))
    info.add_argument("--usage-id", type=int, required=True)

    chapter_status = sub.add_parser("chapter-status", help="Check if chapter already succeeded")
    chapter_status.add_argument("--db", default=str(DEFAULT_DB))
    chapter_status.add_argument("--chapter-id", type=int, required=True)
    chapter_status.add_argument("--usage-type", default="puzzle_story")

    return parser


def _db_repo(db_value: str) -> tuple[Path, BookRepository]:
    db_path = Path(db_value).expanduser().resolve()
    conn = connect_db(db_path)
    apply_schema(conn)
    return db_path, BookRepository(conn)


def _cmd_reserve(args: argparse.Namespace) -> dict:
    db_path, repo = _db_repo(args.db)
    conn = repo.conn
    try:
        result = repo.reserve_next_chapter(
            usage_type=args.usage_type,
            reserve_minutes=max(1, int(args.reserve_minutes)),
            pipeline_run_id=args.pipeline_run_id or new_run_id("pipeline"),
            min_chars=max(0, int(args.min_chars)),
            max_chars=args.max_chars,
            book_id=args.book_id,
            genre=args.genre.strip() or None,
            allow_reuse=bool(args.allow_reuse),
            cooldown_days=max(0, int(args.cooldown_days)),
            exclude_toc_like=not bool(args.include_toc_like),
        )

        if result is None:
            return {"ok": True, "selected": False, "db": str(db_path)}

        payload = {
            "ok": True,
            "selected": True,
            "db": str(db_path),
            "usage_id": result.usage_id,
            "chapter_id": result.chapter_id,
            "book_id": result.book_id,
            "book_title": result.book_title,
            "chapter_index": result.chapter_index,
            "chapter_title": result.chapter_title,
            "char_count": result.char_count,
            "used_count": result.used_count,
            "meta_json": result.meta_json,
        }
        if args.with_text:
            payload["chapter_text"] = result.chapter_text
        return payload
    finally:
        conn.close()


def _cmd_succeed(args: argparse.Namespace) -> dict:
    db_path, repo = _db_repo(args.db)
    conn = repo.conn
    try:
        ok = repo.mark_succeeded(
            usage_id=args.usage_id,
            generated_story_id=args.generated_story_id,
            summary_path=args.summary_path,
        )
        conn.commit()
        return {"ok": ok, "db": str(db_path), "usage_id": args.usage_id}
    finally:
        conn.close()


def _cmd_fail(args: argparse.Namespace) -> dict:
    db_path, repo = _db_repo(args.db)
    conn = repo.conn
    try:
        ok = repo.mark_failed(usage_id=args.usage_id, error_message=args.error_message)
        conn.commit()
        return {"ok": ok, "db": str(db_path), "usage_id": args.usage_id}
    finally:
        conn.close()


def _cmd_release(args: argparse.Namespace) -> dict:
    db_path, repo = _db_repo(args.db)
    conn = repo.conn
    try:
        ok = repo.mark_released(usage_id=args.usage_id, error_message=args.error_message)
        conn.commit()
        return {"ok": ok, "db": str(db_path), "usage_id": args.usage_id}
    finally:
        conn.close()


def _cmd_usage(args: argparse.Namespace) -> dict:
    db_path, repo = _db_repo(args.db)
    conn = repo.conn
    try:
        data = repo.get_usage(usage_id=args.usage_id)
        return {"ok": data is not None, "db": str(db_path), "usage": data}
    finally:
        conn.close()


def _cmd_chapter_status(args: argparse.Namespace) -> dict:
    db_path, repo = _db_repo(args.db)
    conn = repo.conn
    try:
        succeeded = repo.chapter_has_succeeded(chapter_id=args.chapter_id, usage_type=args.usage_type)
        return {
            "ok": True,
            "db": str(db_path),
            "chapter_id": args.chapter_id,
            "usage_type": args.usage_type,
            "has_succeeded_story": succeeded,
        }
    finally:
        conn.close()


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()

    try:
        if args.command == "reserve":
            payload = _cmd_reserve(args)
        elif args.command == "succeed":
            payload = _cmd_succeed(args)
        elif args.command == "fail":
            payload = _cmd_fail(args)
        elif args.command == "release":
            payload = _cmd_release(args)
        elif args.command == "usage":
            payload = _cmd_usage(args)
        elif args.command == "chapter-status":
            payload = _cmd_chapter_status(args)
        else:  # pragma: no cover
            raise ValueError(f"Unknown command: {args.command}")
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1

    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
