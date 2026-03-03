"""Prompt loading and rendering helpers."""

from __future__ import annotations

from pathlib import Path

from .exceptions import PipelineError
from .models import PromptBundle, SourceStory


def load_prompt_bundle(
    *,
    prompts_dir: Path,
    system_prompt_file: str,
    user_prompt_template_file: str,
    image_prompt_suffix_file: str,
) -> PromptBundle:
    system_prompt = load_prompt_text(prompts_dir, system_prompt_file).strip()
    user_prompt_template = load_prompt_text(prompts_dir, user_prompt_template_file)
    image_prompt_suffix = load_prompt_text(prompts_dir, image_prompt_suffix_file).strip()

    if not system_prompt:
        raise PipelineError("System prompt is empty")
    if "{{SOURCE_TEXT}}" not in user_prompt_template:
        raise PipelineError("User prompt template must include {{SOURCE_TEXT}}")

    return PromptBundle(
        system_prompt=system_prompt,
        user_prompt_template=user_prompt_template,
        image_prompt_suffix=image_prompt_suffix,
    )


def load_prompt_text(prompts_dir: Path, file_name_or_path: str) -> str:
    candidate = Path(file_name_or_path)
    target = candidate if candidate.is_absolute() else prompts_dir / candidate
    if not target.exists() or not target.is_file():
        raise PipelineError(f"Prompt file not found: {target}")
    return target.read_text(encoding="utf-8")


def render_user_prompt(template: str, *, story: SourceStory, candidate_scenes: int) -> str:
    rendered = template
    rendered = rendered.replace("{{SOURCE_NAME}}", story.title)
    rendered = rendered.replace("{{CANDIDATE_SCENES}}", str(candidate_scenes))
    rendered = rendered.replace("{{SOURCE_TEXT}}", story.text)
    return rendered
