from __future__ import annotations

import argparse
import sqlite3
import unittest
from unittest.mock import Mock, patch

from scripts.story_generator_pipeline import queue_worker as qw


class QueueWorkerLoopPolicyTests(unittest.TestCase):
    def test_policy_max_jobs_and_once_flags(self) -> None:
        policy = qw.WorkerLoopPolicy(poll_seconds=0.2, max_jobs=2, once=True)
        self.assertFalse(policy.reached_max_jobs(1))
        self.assertTrue(policy.reached_max_jobs(2))
        self.assertTrue(policy.should_exit_when_idle())
        self.assertTrue(policy.should_exit_after_task())


class QueueWorkerRunWorkerTests(unittest.TestCase):
    def _build_args(self, **overrides: object) -> argparse.Namespace:
        payload = {
            "db": "/tmp/puzzle.sqlite",
            "backend_url": "http://backend",
            "worker_token": "token",
            "http_timeout": 15.0,
            "books_db": "/tmp/books.sqlite",
            "poll_seconds": 0.1,
            "max_jobs": 0,
            "python_bin": "python3",
            "skip_books_sync": False,
            "once": False,
        }
        payload.update(overrides)
        return argparse.Namespace(**payload)

    def _build_retry_task(self) -> qw.RetryImageTask:
        return qw.RetryImageTask(
            retry_id=1,
            run_id="run_r_1",
            scene_index=1,
            scene_id=1,
            title="t",
            description="d",
            story_text="s",
            image_prompt="p",
            mood="m",
            characters=[],
            grid_rows=6,
            grid_cols=4,
            time_limit_sec=180,
            target_date="2026-03-08",
            image_size="2K",
            timeout_sec=120.0,
            poll_seconds=2.5,
            poll_attempts=10,
            watermark=False,
            output_root="",
        )

    def test_run_worker_api_mode_requires_token(self) -> None:
        args = self._build_args(worker_token="")
        with patch("scripts.story_generator_pipeline.queue_worker.signal.signal"):
            result = qw.run_worker(args)
        self.assertEqual(result, 2)

    def test_run_worker_once_exits_when_idle(self) -> None:
        args = self._build_args(once=True)

        with (
            patch("scripts.story_generator_pipeline.queue_worker.signal.signal"),
            patch("scripts.story_generator_pipeline.queue_worker._claim_next_task", return_value=(None, None)) as claim_mock,
            patch("scripts.story_generator_pipeline.queue_worker._handle_retry_task") as retry_mock,
            patch("scripts.story_generator_pipeline.queue_worker._handle_generation_job") as job_mock,
            patch("scripts.story_generator_pipeline.queue_worker.time.sleep") as sleep_mock,
        ):
            result = qw.run_worker(args)

        self.assertEqual(result, 0)
        self.assertEqual(claim_mock.call_count, 1)
        retry_mock.assert_not_called()
        job_mock.assert_not_called()
        sleep_mock.assert_not_called()

    def test_run_worker_stops_after_max_jobs(self) -> None:
        args = self._build_args(max_jobs=1, once=False)
        retry_task = self._build_retry_task()

        with (
            patch("scripts.story_generator_pipeline.queue_worker.signal.signal"),
            patch("scripts.story_generator_pipeline.queue_worker._claim_next_task", return_value=(None, retry_task)) as claim_mock,
            patch("scripts.story_generator_pipeline.queue_worker._handle_retry_task") as retry_mock,
            patch("scripts.story_generator_pipeline.queue_worker._handle_generation_job") as job_mock,
        ):
            result = qw.run_worker(args)

        self.assertEqual(result, 0)
        self.assertEqual(claim_mock.call_count, 1)
        retry_mock.assert_called_once()
        job_mock.assert_not_called()

    def test_run_worker_sqlite_poll_error_rolls_back_and_closes(self) -> None:
        args = self._build_args(backend_url="", once=True)
        conn = Mock()
        conn.in_transaction = True

        with (
            patch("scripts.story_generator_pipeline.queue_worker.signal.signal"),
            patch("scripts.story_generator_pipeline.queue_worker.connect_db", return_value=conn),
            patch(
                "scripts.story_generator_pipeline.queue_worker._claim_next_task",
                side_effect=[sqlite3.OperationalError("busy"), (None, None)],
            ) as claim_mock,
            patch("scripts.story_generator_pipeline.queue_worker.time.sleep") as sleep_mock,
        ):
            result = qw.run_worker(args)

        self.assertEqual(result, 0)
        self.assertEqual(claim_mock.call_count, 2)
        conn.rollback.assert_called_once()
        conn.close.assert_called_once()
        sleep_mock.assert_called_once_with(0.2)


if __name__ == "__main__":
    unittest.main()
