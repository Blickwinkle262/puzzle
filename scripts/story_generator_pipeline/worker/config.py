"""Argument parsing and env helpers for queue worker."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[3]
DEFAULT_DB_PATH = ROOT_DIR / "backend" / "data" / "puzzle.sqlite"
DEFAULT_BOOKS_DB_PATH = ROOT_DIR / "scripts" / "book_ingest" / "data" / "books.sqlite"


def get_env(primary: str, *fallbacks: str, default: str = "") -> str:
    keys = (primary, *fallbacks)
    for key in keys:
        value = os.environ.get(key)
        if value is not None and str(value).strip() != "":
            return str(value)
    return default


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run queue worker for story generator jobs.")
    parser.add_argument(
        "--db",
        default=get_env(
            "STORY_GENERATOR_QUEUE_DB_PATH",
            "STORY_GENERATION_QUEUE_DB_PATH",
            default=str(DEFAULT_DB_PATH),
        ),
        help="Path to backend SQLite database (legacy fallback mode).",
    )
    parser.add_argument(
        "--backend-url",
        default=get_env("STORY_GENERATOR_BACKEND_URL", "STORY_GENERATION_BACKEND_URL", default=""),
        help="Backend base URL for internal queue APIs (recommended).",
    )
    parser.add_argument(
        "--worker-token",
        default=get_env("STORY_GENERATOR_WORKER_TOKEN", "STORY_GENERATION_WORKER_TOKEN", default=""),
        help="Shared secret token for backend internal worker APIs.",
    )
    parser.add_argument(
        "--http-timeout",
        type=float,
        default=float(
            get_env(
                "STORY_GENERATOR_QUEUE_HTTP_TIMEOUT",
                "STORY_GENERATION_QUEUE_HTTP_TIMEOUT",
                default="15.0",
            )
        ),
        help="HTTP timeout seconds for backend internal queue APIs.",
    )
    parser.add_argument(
        "--books-db",
        default=os.environ.get("BOOK_INGEST_DB_PATH", str(DEFAULT_BOOKS_DB_PATH)),
        help="Path to book_ingest SQLite database.",
    )
    parser.add_argument(
        "--skip-books-sync",
        action="store_true",
        help="Skip syncing chapter-generation linkage to books.sqlite.",
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=float(
            get_env(
                "STORY_GENERATOR_QUEUE_POLL_SECONDS",
                "STORY_GENERATION_QUEUE_POLL_SECONDS",
                default="2.0",
            )
        ),
        help="Polling interval when queue is empty.",
    )
    parser.add_argument(
        "--max-jobs",
        type=int,
        default=int(
            get_env(
                "STORY_GENERATOR_QUEUE_MAX_JOBS",
                "STORY_GENERATION_QUEUE_MAX_JOBS",
                default="0",
            )
        ),
        help="Process at most N jobs then exit (0 means unlimited).",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Process at most one job and exit.",
    )
    parser.add_argument(
        "--python-bin",
        default=get_env(
            "STORY_GENERATOR_QUEUE_PYTHON",
            "STORY_GENERATION_QUEUE_PYTHON",
            default=sys.executable,
        ),
        help="Python executable used to run the pipeline script.",
    )
    parser.add_argument(
        "--log-level",
        default=get_env(
            "STORY_GENERATOR_QUEUE_LOG_LEVEL",
            "STORY_GENERATION_QUEUE_LOG_LEVEL",
            default="INFO",
        ),
        help="Worker log level.",
    )
    return parser.parse_args()

