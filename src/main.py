from __future__ import annotations

import argparse
from pathlib import Path

from puzzle_game.infra.config import load_game_entry
from puzzle_game.ui.app import PuzzleGameApp


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Config-driven pygame puzzle game")
    parser.add_argument(
        "--entry",
        type=Path,
        default=Path("configs/game_entry.json"),
        help="Path to fixed game entry JSON (active_level/defaults_path)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    entry = load_game_entry(args.entry)
    app = PuzzleGameApp.from_files(
        level_path=entry.active_level,
        defaults_path=entry.defaults_path,
        project_root=entry.project_root,
    )
    app.run()


if __name__ == "__main__":
    main()
