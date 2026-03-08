"""Pipeline command builder and runner for queue worker."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

from .types import GenerationJob


def _is_truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        return normalized in {"1", "true", "yes", "on"}
    return False


def _append_optional_arg(command: list[str], flag: str, value: Any) -> None:
    if value is None:
        return
    text = str(value).strip()
    if not text:
        return
    command.extend([flag, text])


def _append_optional_number(command: list[str], flag: str, value: Any) -> None:
    if value is None:
        return
    if isinstance(value, bool):
        return
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return
    if parsed <= 0:
        return
    if parsed.is_integer():
        command.extend([flag, str(int(parsed))])
    else:
        command.extend([flag, str(parsed)])


def build_pipeline_command(job: GenerationJob, python_bin: str) -> list[str]:
    payload = job.payload
    command = [python_bin, "-m", "scripts.story_generator_pipeline.generate_story"]

    _append_optional_arg(command, "--run-id", payload.get("run_id") or job.run_id)
    _append_optional_arg(command, "--target-date", payload.get("target_date") or job.target_date)
    _append_optional_arg(command, "--story-file", payload.get("story_file") or job.story_file)

    _append_optional_arg(command, "--output-root", payload.get("output_root"))
    _append_optional_arg(command, "--index-file", payload.get("index_file"))
    _append_optional_arg(command, "--summary-output-dir", payload.get("summary_output_dir"))
    _append_optional_arg(command, "--summary-path", payload.get("summary_path") or job.summary_path)
    _append_optional_arg(command, "--story-id", payload.get("story_id"))

    _append_optional_number(command, "--candidate-scenes", payload.get("candidate_scenes"))
    _append_optional_number(command, "--min-scenes", payload.get("min_scenes"))
    _append_optional_number(command, "--max-scenes", payload.get("max_scenes"))
    _append_optional_number(command, "--concurrency", payload.get("concurrency"))

    _append_optional_arg(command, "--image-size", payload.get("image_size"))
    _append_optional_number(command, "--timeout-sec", payload.get("timeout_sec"))
    _append_optional_number(command, "--poll-seconds", payload.get("poll_seconds"))
    _append_optional_number(command, "--poll-attempts", payload.get("poll_attempts"))

    _append_optional_arg(command, "--log-file", payload.get("log_file") or job.log_file)
    _append_optional_arg(command, "--event-log-file", payload.get("event_log_file") or job.event_log_file)

    if _is_truthy(payload.get("watermark")):
        command.append("--watermark")
    if _is_truthy(payload.get("review_mode")):
        command.append("--review-mode")
    if job.dry_run or _is_truthy(payload.get("dry_run")):
        command.append("--dry-run")

    return command


def run_job(job: GenerationJob, *, python_bin: str, root_dir: Path, logger: Any) -> tuple[int, str]:
    command = build_pipeline_command(job, python_bin)
    logger.info("Run job %s as %s", job.run_id, command[0])
    logger.debug("Pipeline command: %s", " ".join(command))

    completed = subprocess.run(command, cwd=root_dir, env=os.environ.copy(), check=False)
    exit_code = int(completed.returncode)

    if exit_code == 0:
        return 0, ""

    return exit_code, f"pipeline exited with code {exit_code}"
