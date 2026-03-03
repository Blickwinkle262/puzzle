"""Select source Liaozhai text deterministically by date or seed."""

from __future__ import annotations

import datetime as dt
import random
from pathlib import Path

from .exceptions import PipelineError
from .models import SourceStory


def select_story(
    *,
    source_dir: Path,
    target_date: dt.date,
    seed: int | None = None,
    story_file: Path | None = None,
) -> SourceStory:
    if story_file:
        if not story_file.exists() or not story_file.is_file():
            raise PipelineError(f"Story file not found: {story_file}")
        return SourceStory(title=story_file.stem, text=story_file.read_text(encoding="utf-8"), source_path=story_file)

    if not source_dir.exists() or not source_dir.is_dir():
        raise PipelineError(f"Source dir not found: {source_dir}")

    files = sorted(path for path in source_dir.glob("*.txt") if path.is_file())
    if not files:
        raise PipelineError(f"No .txt files found in: {source_dir}")

    effective_seed = seed if seed is not None else int(target_date.strftime("%Y%m%d"))
    rng = random.Random(effective_seed)
    selected = rng.choice(files)
    text = selected.read_text(encoding="utf-8")

    return SourceStory(title=selected.stem, text=text, source_path=selected)
