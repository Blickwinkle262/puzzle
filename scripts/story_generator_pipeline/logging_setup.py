"""Logging setup for story generator pipeline.

This module configures non-blocking logging with QueueHandler/QueueListener and
emits structured JSONL event logs for frontend progress display.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import logging.config
import logging.handlers
import queue
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import PipelineConfig

EVENT_LOGGER_NAME = "story_generator.events"


class IncludeLoggerPrefixFilter(logging.Filter):
    """Keep only records whose logger name starts with prefix."""

    def __init__(self, prefix: str) -> None:
        super().__init__()
        self.prefix = prefix

    def filter(self, record: logging.LogRecord) -> bool:
        return record.name.startswith(self.prefix)


class ExcludeLoggerPrefixFilter(logging.Filter):
    """Drop records whose logger name starts with prefix."""

    def __init__(self, prefix: str) -> None:
        super().__init__()
        self.prefix = prefix

    def filter(self, record: logging.LogRecord) -> bool:
        return not record.name.startswith(self.prefix)


class JsonLineFormatter(logging.Formatter):
    """Serialize logging records as one-line JSON objects."""

    def format(self, record: logging.LogRecord) -> str:
        ts = dt.datetime.fromtimestamp(record.created, tz=dt.timezone.utc)
        payload: dict[str, Any] = {
            "ts": ts.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "event": getattr(record, "event", record.getMessage()),
            "run_id": getattr(record, "run_id", ""),
            "message": record.getMessage(),
        }

        extra_payload = getattr(record, "payload", None)
        if isinstance(extra_payload, dict):
            payload.update(extra_payload)

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, ensure_ascii=False)


@dataclass
class LoggingRuntime:
    listener: logging.handlers.QueueListener

    def close(self) -> None:
        self.listener.stop()
        for handler in self.listener.handlers:
            handler.flush()
            handler.close()
        logging.shutdown()


def _normalize_level(level_name: str) -> str:
    normalized = str(level_name).strip().upper() or "INFO"
    level = logging.getLevelName(normalized)
    if isinstance(level, int):
        return normalized
    return "INFO"


def _build_queue_dict_config(level: str) -> dict[str, Any]:
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "handlers": {
            "queue": {
                "class": "logging.handlers.QueueHandler",
                "queue": {"()": "queue.SimpleQueue"},
            }
        },
        "root": {
            "handlers": ["queue"],
            "level": level,
        },
        "loggers": {
            EVENT_LOGGER_NAME: {
                "level": "INFO",
                "propagate": True,
            }
        },
    }


def _prepare_path(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def configure_logging(config: PipelineConfig) -> LoggingRuntime:
    """Configure queue-based logging for stdout + text file + JSONL event file."""

    level_name = _normalize_level(config.log_level)
    level_no = logging.getLevelName(level_name)

    _prepare_path(config.log_file)
    _prepare_path(config.event_log_file)

    text_formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(name)s - %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )
    event_formatter = JsonLineFormatter()

    exclude_event_logs = ExcludeLoggerPrefixFilter(EVENT_LOGGER_NAME)
    include_event_logs = IncludeLoggerPrefixFilter(EVENT_LOGGER_NAME)

    stream_handler = logging.StreamHandler(stream=sys.stdout)
    stream_handler.setLevel(level_no)
    stream_handler.setFormatter(text_formatter)
    stream_handler.addFilter(exclude_event_logs)

    file_handler = logging.handlers.RotatingFileHandler(
        filename=config.log_file,
        maxBytes=max(1, int(config.log_max_bytes)),
        backupCount=max(1, int(config.log_backup_count)),
        encoding="utf-8",
        delay=True,
    )
    file_handler.setLevel(level_no)
    file_handler.setFormatter(text_formatter)
    file_handler.addFilter(exclude_event_logs)

    event_file_handler = logging.handlers.RotatingFileHandler(
        filename=config.event_log_file,
        maxBytes=max(1, int(config.event_log_max_bytes)),
        backupCount=max(1, int(config.event_log_backup_count)),
        encoding="utf-8",
        delay=True,
    )
    event_file_handler.setLevel(logging.INFO)
    event_file_handler.setFormatter(event_formatter)
    event_file_handler.addFilter(include_event_logs)

    logging.config.dictConfig(_build_queue_dict_config(level_name))

    root_logger = logging.getLogger()
    queue_handler = next(
        (handler for handler in root_logger.handlers if isinstance(handler, logging.handlers.QueueHandler)),
        None,
    )
    if queue_handler is None:
        raise RuntimeError("QueueHandler is not configured on root logger")

    log_queue = queue_handler.queue

    listener = logging.handlers.QueueListener(
        log_queue,
        stream_handler,
        file_handler,
        event_file_handler,
        respect_handler_level=True,
    )
    listener.start()

    return LoggingRuntime(listener=listener)


def emit_event(event: str, *, run_id: str, level: int = logging.INFO, **payload: Any) -> None:
    """Write one JSONL event entry through the event logger channel."""

    logger = logging.getLogger(EVENT_LOGGER_NAME)
    logger.log(level, event, extra={"event": event, "run_id": run_id, "payload": payload})
