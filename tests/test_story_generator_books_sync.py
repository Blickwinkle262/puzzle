from __future__ import annotations

import json
import logging
import tempfile
import unittest
from pathlib import Path

from scripts.book_ingest.repository import BookRepository
from scripts.book_ingest.storage import apply_schema, connect_db
from scripts.story_generator_pipeline.worker.books_sync import extract_story_id, read_json_file, sync_books_generation_link
from scripts.story_generator_pipeline.worker.types import GenerationJob


class StoryGeneratorBooksSyncTests(unittest.TestCase):
    def test_extract_story_id_prefers_summary_over_payload(self) -> None:
        job = GenerationJob(
            id=1,
            run_id="run_test_story_id",
            requested_by="admin",
            target_date="2026-03-08",
            story_file="/tmp/chapter_1.txt",
            dry_run=False,
            payload={"story_id": "payload-story-id"},
            log_file="",
            event_log_file="",
            summary_path="",
        )

        summary = {"story_id": "summary-story-id"}
        self.assertEqual(extract_story_id(job, summary), "summary-story-id")

    def test_sync_books_generation_link_updates_usage_and_chapter(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            books_db_path = root / "books.sqlite"
            summary_path = root / "summary.json"
            summary_path.write_text(json.dumps({"story_id": "story-001"}, ensure_ascii=False), encoding="utf-8")

            conn = connect_db(books_db_path)
            apply_schema(conn)
            repo = BookRepository(conn)

            book_id = repo.upsert_book(
                title="聊斋",
                author="蒲松龄",
                source_path="/tmp/liaozhai.txt",
                source_format="txt",
                language="zh",
                genre="志怪",
                metadata_json={},
            )
            action = repo.upsert_chapter(
                book_id=book_id,
                chapter_index=1,
                chapter_title="画皮",
                chapter_text="正文" * 20,
                char_count=len("正文" * 20),
                word_count=1,
                checksum="checksum-sync-1",
                meta_json={},
            )
            self.assertIn(action, {"inserted", "updated", "skipped_duplicate"})
            conn.commit()

            chapter = conn.execute("SELECT id, used_count FROM chapters WHERE book_id = ? AND chapter_index = 1", (book_id,)).fetchone()
            assert chapter is not None
            chapter_id = int(chapter["id"])
            self.assertEqual(int(chapter["used_count"]), 0)

            job = GenerationJob(
                id=2,
                run_id="run_sync_001",
                requested_by="admin",
                target_date="2026-03-08",
                story_file="/tmp/chapter_1.txt",
                dry_run=False,
                payload={"chapter_id": chapter_id, "story_id": "payload-story-id"},
                log_file="",
                event_log_file="",
                summary_path=str(summary_path),
            )

            logger = logging.getLogger("test.story_generator.books_sync")
            sync_books_generation_link(job, books_db_path, logger=logger)

            usage = conn.execute(
                """
                SELECT pipeline_run_id, generated_story_id, summary_path, status
                FROM chapter_usage
                WHERE chapter_id = ? AND usage_type = 'puzzle_story'
                LIMIT 1
                """,
                (chapter_id,),
            ).fetchone()
            assert usage is not None
            self.assertEqual(str(usage["pipeline_run_id"]), "run_sync_001")
            self.assertEqual(str(usage["generated_story_id"]), "story-001")
            self.assertEqual(str(usage["summary_path"]), str(summary_path))
            self.assertEqual(str(usage["status"]), "succeeded")

            chapter_after_first = conn.execute("SELECT used_count FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
            assert chapter_after_first is not None
            self.assertEqual(int(chapter_after_first["used_count"]), 1)

            sync_books_generation_link(job, books_db_path, logger=logger)

            chapter_after_second = conn.execute("SELECT used_count FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
            assert chapter_after_second is not None
            self.assertEqual(int(chapter_after_second["used_count"]), 1)

            parsed = read_json_file(str(summary_path))
            self.assertEqual(str(parsed.get("story_id") or ""), "story-001")

            conn.close()


if __name__ == "__main__":
    unittest.main()
