"""Backfill story index book metadata for entries missing book_id/book_title.

Usage:
  python scripts/book_ingest/backfill_story_index_book_meta.py --dry-run
  python scripts/book_ingest/backfill_story_index_book_meta.py
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_BOOKS_DB = ROOT_DIR / "scripts" / "book_ingest" / "data" / "books.sqlite"
DEFAULT_INDEX_FILE = ROOT_DIR / "backend" / "data" / "generated" / "content" / "stories" / "index.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill missing story book metadata to a target book")
    parser.add_argument("--books-db", default=str(DEFAULT_BOOKS_DB), help="Path to books.sqlite")
    parser.add_argument(
        "--index-file",
        action="append",
        default=[],
        help="Story index file to patch (repeatable). Defaults to generated stories index.json",
    )
    parser.add_argument("--book-id", type=int, default=0, help="Target book id. If omitted, auto-detect via title keyword")
    parser.add_argument("--book-title-keyword", default="聊斋", help="Keyword used to auto-detect target book")
    parser.add_argument("--source-path-keyword", default="liaozhai", help="Keyword matched against source_path")
    parser.add_argument("--force", action="store_true", help="Overwrite existing book_id/book_title for all stories")
    parser.add_argument("--dry-run", action="store_true", help="Preview only")
    return parser.parse_args()


def normalize_story_book_id(value: Any) -> str:
    normalized = (
        str(value or "")
        .strip()
        .lower()
        .replace(" ", "-")
    )
    normalized = "".join(ch if ch.isalnum() or ch == "-" or "\u4e00" <= ch <= "\u9fff" else "-" for ch in normalized)
    while "--" in normalized:
        normalized = normalized.replace("--", "-")
    return normalized.strip("-")[:48]


def resolve_target_book(conn: sqlite3.Connection, book_id: int, title_keyword: str, source_path_keyword: str) -> tuple[str, str]:
    if book_id > 0:
        row = conn.execute("SELECT id, title FROM books WHERE id = ? LIMIT 1", (book_id,)).fetchone()
        if row is None:
            raise ValueError(f"book_id={book_id} 不存在")
        return normalize_story_book_id(row[0]), str(row[1] or "").strip()

    title_like = f"%{title_keyword}%"
    source_like = f"%{source_path_keyword}%"
    row = conn.execute(
        """
        SELECT id, title
        FROM books
        WHERE title LIKE ? OR source_path LIKE ?
        ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END, id ASC
        LIMIT 1
        """,
        (title_like, source_like, title_like),
    ).fetchone()
    if row is None:
        raise ValueError("未找到可用目标书籍，请通过 --book-id 明确指定")

    resolved_id = normalize_story_book_id(row[0])
    resolved_title = str(row[1] or "").strip()
    if not resolved_id or not resolved_title:
        raise ValueError("目标书籍缺少有效 id/title")
    return resolved_id, resolved_title


def load_index(path_value: Path) -> dict[str, Any]:
    with path_value.open("r", encoding="utf-8") as file:
        payload = json.load(file)
    if not isinstance(payload, dict):
        raise ValueError(f"索引格式不合法: {path_value}")
    stories = payload.get("stories")
    if not isinstance(stories, list):
        raise ValueError(f"索引缺少 stories 数组: {path_value}")
    return payload


def should_patch_story(story: dict[str, Any], force: bool) -> bool:
    if force:
        return True
    book_id = str(story.get("book_id") or "").strip()
    book_title = str(story.get("book_title") or "").strip()
    return not book_id or not book_title


def patch_index(payload: dict[str, Any], target_book_id: str, target_book_title: str, force: bool) -> list[str]:
    changed_ids: list[str] = []
    stories = payload.get("stories")
    if not isinstance(stories, list):
        return changed_ids

    for item in stories:
        if not isinstance(item, dict):
            continue
        if not should_patch_story(item, force):
            continue
        item["book_id"] = target_book_id
        item["book_title"] = target_book_title
        changed_ids.append(str(item.get("id") or ""))

    return changed_ids


def main() -> int:
    args = parse_args()
    books_db = Path(args.books_db).expanduser().resolve()
    if not books_db.exists():
        raise SystemExit(f"books db not found: {books_db}")

    index_files = [Path(item).expanduser().resolve() for item in args.index_file] or [DEFAULT_INDEX_FILE]
    for path_value in index_files:
        if not path_value.exists():
            raise SystemExit(f"index file not found: {path_value}")

    conn = sqlite3.connect(books_db)
    try:
        target_book_id, target_book_title = resolve_target_book(
            conn,
            book_id=max(0, int(args.book_id or 0)),
            title_keyword=str(args.book_title_keyword or "").strip() or "聊斋",
            source_path_keyword=str(args.source_path_keyword or "").strip() or "liaozhai",
        )
    finally:
        conn.close()

    print(f"[target] book_id={target_book_id} title={target_book_title}")

    total_changed = 0
    for index_file in index_files:
        payload = load_index(index_file)
        changed_ids = patch_index(payload, target_book_id, target_book_title, force=bool(args.force))
        total_changed += len(changed_ids)
        print(f"[index] {index_file} changed={len(changed_ids)}")
        if changed_ids:
            print("[stories] " + ", ".join(changed_ids))
        if not args.dry_run and changed_ids:
            index_file.write_text(f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n", encoding="utf-8")

    print(f"[done] total_changed={total_changed} dry_run={bool(args.dry_run)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
