from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.book_ingest.repository import BookRepository
from scripts.book_ingest.storage import apply_schema, connect_db


class BookIngestRepositoryTests(unittest.TestCase):
    def test_reserve_and_mark_succeeded_updates_usage_and_chapter(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "books.sqlite"
            conn = connect_db(db_path)
            apply_schema(conn)
            repo = BookRepository(conn)

            book_id = repo.upsert_book(
                title="聊斋",
                author="蒲松龄",
                source_path="/tmp/liaozhai.epub",
                source_format="epub",
                language="zh",
                genre="志怪",
                metadata_json={},
            )
            action = repo.upsert_chapter(
                book_id=book_id,
                chapter_index=1,
                chapter_title="画皮",
                chapter_text="这是正文。" * 30,
                char_count=len("这是正文。" * 30),
                word_count=1,
                checksum="abc",
                meta_json={"tone": "mystery"},
            )
            self.assertEqual(action, "inserted")
            conn.commit()

            reserved = repo.reserve_next_chapter(
                usage_type="puzzle_story",
                reserve_minutes=30,
                pipeline_run_id="run-1",
                min_chars=10,
                max_chars=None,
                book_id=None,
                genre=None,
                allow_reuse=False,
                cooldown_days=30,
                exclude_toc_like=True,
            )
            self.assertIsNotNone(reserved)
            assert reserved is not None
            self.assertEqual(reserved.chapter_title, "画皮")

            reserved_again = repo.reserve_next_chapter(
                usage_type="puzzle_story",
                reserve_minutes=30,
                pipeline_run_id="run-2",
                min_chars=10,
                max_chars=None,
                book_id=None,
                genre=None,
                allow_reuse=False,
                cooldown_days=30,
                exclude_toc_like=True,
            )
            self.assertIsNone(reserved_again)

            self.assertTrue(repo.mark_succeeded(usage_id=reserved.usage_id, generated_story_id="story-001"))
            conn.commit()

            row = conn.execute("SELECT used_count, last_used_at FROM chapters WHERE id = ?", (reserved.chapter_id,)).fetchone()
            self.assertEqual(int(row["used_count"]), 1)
            self.assertTrue(bool(row["last_used_at"]))

            usage = repo.get_usage(usage_id=reserved.usage_id)
            self.assertIsNotNone(usage)
            assert usage is not None
            self.assertEqual(usage["status"], "succeeded")
            self.assertEqual(usage["generated_story_id"], "story-001")

            self.assertTrue(repo.chapter_has_succeeded(chapter_id=reserved.chapter_id, usage_type="puzzle_story"))
            conn.close()


if __name__ == "__main__":
    unittest.main()
