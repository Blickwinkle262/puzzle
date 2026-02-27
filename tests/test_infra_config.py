from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from puzzle_game.infra.config import ConfigError, load_game_entry, load_level_config


class InfraConfigTests(unittest.TestCase):
    def test_load_level_config_merge_defaults_and_rules(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "levels").mkdir(parents=True)
            (root / "configs").mkdir(parents=True)

            defaults = {
                "time_limit_sec": 300,
                "snap_tolerance_px": 18,
                "rules": {"snap_strategy": "strict", "magnet_strength": 0.2},
                "window": {"width": 1280, "height": 720, "fps": 60},
                "ui": {"show_timer": True, "show_title": True, "show_description": True},
            }
            level = {
                "id": "level_x",
                "title": "test",
                "description": "desc",
                "grid": {"rows": 2, "cols": 2},
                "source_image": "materials/source/images/a.jpg",
                "background_music": "materials/source/music/a.ogg",
                "rules": {"snap_strategy": "lenient", "magnet_strength": 0.5},
                "audio": {},
            }

            defaults_path = root / "configs" / "game_defaults.json"
            level_path = root / "levels" / "level_x.json"
            defaults_path.write_text(json.dumps(defaults), encoding="utf-8")
            level_path.write_text(json.dumps(level), encoding="utf-8")

            loaded = load_level_config(level_path=level_path, defaults_path=defaults_path)

            self.assertEqual(loaded.config.level_id, "level_x")
            self.assertEqual(loaded.config.rules.snap_strategy, "lenient")
            self.assertAlmostEqual(loaded.config.rules.magnet_strength, 0.5)
            self.assertEqual(loaded.config.time_limit_sec, 300)
            self.assertEqual(loaded.project_root.resolve(), root.resolve())

    def test_invalid_json_type_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "levels").mkdir(parents=True)
            level_path = root / "levels" / "bad.json"
            level_path.write_text("[]", encoding="utf-8")

            with self.assertRaises(ConfigError):
                load_level_config(level_path=level_path)

    def test_load_game_entry_resolves_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "configs").mkdir(parents=True)
            (root / "levels").mkdir(parents=True)

            defaults_path = root / "configs" / "game_defaults.json"
            level_path = root / "levels" / "level_001.json"
            entry_path = root / "configs" / "game_entry.json"

            defaults_path.write_text("{}", encoding="utf-8")
            level_path.write_text("{}", encoding="utf-8")
            entry_path.write_text(
                json.dumps(
                    {
                        "defaults_path": "configs/game_defaults.json",
                        "active_level": "levels/level_001.json",
                    }
                ),
                encoding="utf-8",
            )

            entry = load_game_entry(entry_path)
            self.assertEqual(entry.project_root.resolve(), root.resolve())
            self.assertEqual(entry.defaults_path, defaults_path.resolve())
            self.assertEqual(entry.active_level, level_path.resolve())

    def test_load_game_entry_missing_level_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "configs").mkdir(parents=True)

            entry_path = root / "configs" / "game_entry.json"
            entry_path.write_text(
                json.dumps(
                    {
                        "defaults_path": "configs/game_defaults.json",
                        "active_level": "levels/missing.json",
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaises(ConfigError):
                load_game_entry(entry_path)

    def test_load_level_config_uses_explicit_project_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shared = root / "shared"
            game = root / "game"

            (shared / "materials" / "source" / "images").mkdir(parents=True)
            (game / "levels" / "chapter").mkdir(parents=True)

            level_path = game / "levels" / "chapter" / "level_nested.json"
            level_path.write_text(
                json.dumps(
                    {
                        "id": "nested",
                        "title": "nested",
                        "grid": {"rows": 2, "cols": 2},
                        "source_image": "materials/source/images/a.jpg",
                    }
                ),
                encoding="utf-8",
            )

            loaded = load_level_config(level_path=level_path, project_root=shared)
            self.assertEqual(
                loaded.config.source_image,
                (shared / "materials" / "source" / "images" / "a.jpg").resolve(),
            )


if __name__ == "__main__":
    unittest.main()
