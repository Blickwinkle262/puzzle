from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any
import copy
import json


class ConfigError(ValueError):
    """Raised when level/default config is invalid."""


@dataclass(frozen=True)
class GridConfig:
    rows: int
    cols: int


@dataclass(frozen=True)
class ShuffleConfig:
    seed: int | None = None
    mode: str = "random_scatter"


@dataclass(frozen=True)
class UIConfig:
    show_timer: bool = True
    show_title: bool = True
    show_description: bool = True


@dataclass(frozen=True)
class WindowConfig:
    width: int = 1280
    height: int = 720
    fps: int = 60


@dataclass(frozen=True)
class LevelConfig:
    level_id: str
    title: str
    description: str
    grid: GridConfig
    source_image: Path
    background_music: Path | None
    time_limit_sec: int
    snap_tolerance_px: int
    shuffle: ShuffleConfig
    audio: dict[str, Path]
    ui: UIConfig
    window: WindowConfig


@dataclass(frozen=True)
class LoadResult:
    config: LevelConfig
    project_root: Path
    level_path: Path


def load_level_config(level_path: Path, defaults_path: Path | None = None) -> LoadResult:
    level_path = level_path.resolve()
    if not level_path.exists():
        raise ConfigError(f"Level config does not exist: {level_path}")

    project_root = level_path.parent.parent
    level_data = _read_json(level_path)
    defaults_data = _read_json(defaults_path.resolve()) if defaults_path else {}

    merged = _deep_merge(defaults_data, level_data)
    config = _parse_level_config(merged, project_root=project_root)
    return LoadResult(config=config, project_root=project_root, level_path=level_path)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"Invalid JSON in {path}: {exc}") from exc
    except FileNotFoundError as exc:
        raise ConfigError(f"Config does not exist: {path}") from exc

    if not isinstance(data, dict):
        raise ConfigError(f"Top-level JSON must be an object: {path}")
    return data


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _parse_level_config(data: dict[str, Any], project_root: Path) -> LevelConfig:
    grid_raw = _require_dict(data, "grid")
    rows = _require_positive_int(grid_raw, "rows")
    cols = _require_positive_int(grid_raw, "cols")

    level_id = _require_str(data, "id")
    title = _require_str(data, "title")
    description = str(data.get("description", ""))

    source_image = _resolve_asset_path(_require_str(data, "source_image"), project_root)
    bgm_raw = data.get("background_music")
    background_music = _resolve_asset_path(bgm_raw, project_root) if bgm_raw else None

    time_limit_sec = _optional_positive_int(data, "time_limit_sec", default=300)
    snap_tolerance_px = _optional_positive_int(data, "snap_tolerance_px", default=18)

    shuffle_raw = data.get("shuffle", {})
    if not isinstance(shuffle_raw, dict):
        raise ConfigError("Field shuffle must be an object")
    shuffle = ShuffleConfig(
        seed=_optional_int(shuffle_raw, "seed"),
        mode=str(shuffle_raw.get("mode", "random_scatter")),
    )

    audio_raw = data.get("audio", {})
    if not isinstance(audio_raw, dict):
        raise ConfigError("Field audio must be an object")
    audio = {
        key: _resolve_asset_path(str(value), project_root)
        for key, value in audio_raw.items()
        if value
    }

    ui_raw = data.get("ui", {})
    if not isinstance(ui_raw, dict):
        raise ConfigError("Field ui must be an object")
    ui = UIConfig(
        show_timer=bool(ui_raw.get("show_timer", True)),
        show_title=bool(ui_raw.get("show_title", True)),
        show_description=bool(ui_raw.get("show_description", True)),
    )

    window_raw = data.get("window", {})
    if not isinstance(window_raw, dict):
        raise ConfigError("Field window must be an object")
    window = WindowConfig(
        width=_optional_positive_int(window_raw, "width", default=1280),
        height=_optional_positive_int(window_raw, "height", default=720),
        fps=_optional_positive_int(window_raw, "fps", default=60),
    )

    return LevelConfig(
        level_id=level_id,
        title=title,
        description=description,
        grid=GridConfig(rows=rows, cols=cols),
        source_image=source_image,
        background_music=background_music,
        time_limit_sec=time_limit_sec,
        snap_tolerance_px=snap_tolerance_px,
        shuffle=shuffle,
        audio=audio,
        ui=ui,
        window=window,
    )


def _require_dict(data: dict[str, Any], key: str) -> dict[str, Any]:
    value = data.get(key)
    if not isinstance(value, dict):
        raise ConfigError(f"Field {key} must be an object")
    return value


def _require_str(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"Field {key} must be a non-empty string")
    return value.strip()


def _require_positive_int(data: dict[str, Any], key: str) -> int:
    value = data.get(key)
    if not isinstance(value, int) or value <= 0:
        raise ConfigError(f"Field {key} must be a positive integer")
    return value


def _optional_positive_int(data: dict[str, Any], key: str, default: int) -> int:
    value = data.get(key, default)
    if not isinstance(value, int) or value <= 0:
        raise ConfigError(f"Field {key} must be a positive integer")
    return value


def _optional_int(data: dict[str, Any], key: str) -> int | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, int):
        raise ConfigError(f"Field {key} must be an integer")
    return value


def _resolve_asset_path(raw_value: str | Path, project_root: Path) -> Path:
    path = Path(raw_value)
    if path.is_absolute():
        return path
    return (project_root / path).resolve()
