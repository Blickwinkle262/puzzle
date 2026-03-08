"""HTTP API helpers for queue worker internal endpoints."""

from __future__ import annotations

import ipaddress
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .types import GenerationJob, RetryImageTask


def parse_positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def parse_positive_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def parse_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def normalize_backend_url(value: str | None) -> str:
    text = str(value or "").strip()
    return text.rstrip("/")


def read_json_response(raw_text: str) -> dict[str, Any]:
    if not raw_text.strip():
        return {}
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def should_bypass_proxy_for_backend(url: str) -> bool:
    try:
        host = (urllib.parse.urlparse(url).hostname or "").strip().lower()
    except Exception:  # noqa: BLE001
        return False

    if not host:
        return False

    if host in {"localhost", "backend", "node-app", "story-worker"}:
        return True

    try:
        ip_addr = ipaddress.ip_address(host)
    except ValueError:
        return host.endswith(".local")

    return bool(ip_addr.is_loopback or ip_addr.is_private or ip_addr.is_link_local)


def post_json(url: str, payload: dict[str, Any], *, worker_token: str, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url=url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Worker-Token": worker_token,
        },
        method="POST",
    )

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if should_bypass_proxy_for_backend(url) else None

    try:
        if opener is not None:
            response_ctx = opener.open(request, timeout=timeout)
        else:
            response_ctx = urllib.request.urlopen(request, timeout=timeout)

        with response_ctx as response:
            body = response.read().decode("utf-8", errors="replace")
            parsed = read_json_response(body)
            if parsed:
                return parsed
            return {}
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        parsed = read_json_response(body)
        message = str(parsed.get("message") or "").strip() or body.strip() or f"HTTP {error.code}"
        raise RuntimeError(f"HTTP {error.code}: {message}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Network error: {error}") from error


def build_generation_job_from_api(raw_job: dict[str, Any]) -> GenerationJob:
    payload = raw_job.get("payload")
    payload_dict = payload if isinstance(payload, dict) else {}

    return GenerationJob(
        id=parse_positive_int(raw_job.get("id")) or 0,
        run_id=str(raw_job.get("run_id") or ""),
        requested_by=str(raw_job.get("requested_by") or ""),
        target_date=str(raw_job.get("target_date") or ""),
        story_file=str(raw_job.get("story_file") or ""),
        dry_run=bool(raw_job.get("dry_run")),
        payload=payload_dict,
        log_file=str(raw_job.get("log_file") or ""),
        event_log_file=str(raw_job.get("event_log_file") or ""),
        summary_path=str(raw_job.get("summary_path") or ""),
    )


def build_retry_image_task_from_api(raw_task: dict[str, Any]) -> RetryImageTask:
    return RetryImageTask(
        retry_id=parse_positive_int(raw_task.get("retry_id")) or 0,
        run_id=str(raw_task.get("run_id") or ""),
        scene_index=parse_positive_int(raw_task.get("scene_index")) or 0,
        scene_id=parse_positive_int(raw_task.get("scene_id")) or parse_positive_int(raw_task.get("scene_index")) or 1,
        title=str(raw_task.get("title") or "").strip(),
        description=str(raw_task.get("description") or "").strip(),
        story_text=str(raw_task.get("story_text") or "").strip(),
        image_prompt=str(raw_task.get("image_prompt") or "").strip(),
        mood=str(raw_task.get("mood") or "").strip(),
        characters=parse_string_list(raw_task.get("characters")),
        grid_rows=parse_positive_int(raw_task.get("grid_rows")) or 6,
        grid_cols=parse_positive_int(raw_task.get("grid_cols")) or 4,
        time_limit_sec=parse_positive_int(raw_task.get("time_limit_sec")) or 180,
        target_date=str(raw_task.get("target_date") or "").strip(),
        image_size=str(raw_task.get("image_size") or "2K").strip() or "2K",
        timeout_sec=parse_positive_float(raw_task.get("timeout_sec")) or 120.0,
        poll_seconds=parse_positive_float(raw_task.get("poll_seconds")) or 2.5,
        poll_attempts=parse_positive_int(raw_task.get("poll_attempts")) or 40,
        watermark=bool(raw_task.get("watermark")),
        output_root=str(raw_task.get("output_root") or "").strip(),
    )


def claim_next_retry_image_task_via_api(*, backend_url: str, worker_token: str, timeout: float) -> RetryImageTask | None:
    response = post_json(
        f"{backend_url}/api/internal/generation-candidate-retries/claim",
        {},
        worker_token=worker_token,
        timeout=timeout,
    )
    raw_task = response.get("task")
    if not isinstance(raw_task, dict) or not raw_task:
        return None
    return build_retry_image_task_from_api(raw_task)


def complete_retry_image_task_via_api(
    *,
    backend_url: str,
    worker_token: str,
    timeout: float,
    retry_id: int,
    status: str,
    image_url: str = "",
    image_path: str = "",
    error_message: str = "",
) -> None:
    encoded_retry_id = urllib.parse.quote(str(retry_id).strip(), safe="")
    post_json(
        f"{backend_url}/api/internal/generation-candidate-retries/{encoded_retry_id}/complete",
        {
            "status": status,
            "image_url": image_url,
            "image_path": image_path,
            "error_message": error_message,
        },
        worker_token=worker_token,
        timeout=timeout,
    )


def claim_next_job_via_api(*, backend_url: str, worker_token: str, timeout: float) -> GenerationJob | None:
    response = post_json(
        f"{backend_url}/api/internal/generation-jobs/claim",
        {},
        worker_token=worker_token,
        timeout=timeout,
    )
    raw_job = response.get("job")
    if not isinstance(raw_job, dict) or not raw_job:
        return None
    return build_generation_job_from_api(raw_job)


def complete_job_via_api(
    *,
    backend_url: str,
    worker_token: str,
    timeout: float,
    run_id: str,
    status: str,
    exit_code: int | None,
    error_message: str,
    story_id: str = "",
    review_status: str = "",
) -> None:
    encoded_run_id = urllib.parse.quote(str(run_id).strip(), safe="")
    post_json(
        f"{backend_url}/api/internal/generation-jobs/{encoded_run_id}/complete",
        {
            "status": status,
            "exit_code": exit_code,
            "error_message": error_message,
            "story_id": story_id,
            "review_status": review_status,
        },
        worker_token=worker_token,
        timeout=timeout,
    )
