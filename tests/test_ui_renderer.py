from __future__ import annotations

import unittest
from pathlib import Path

import pygame

from puzzle_game.domain.models import Piece
from puzzle_game.domain.state import GameState
from puzzle_game.infra.config import GridConfig, LevelConfig, RuleConfig, ShuffleConfig, UIConfig, WindowConfig
from puzzle_game.ui.renderer import PygameRenderer


class UIRendererTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        pygame.init()

    @classmethod
    def tearDownClass(cls) -> None:
        pygame.quit()

    def _level(self) -> LevelConfig:
        return LevelConfig(
            level_id="level_renderer",
            title="renderer",
            description="",
            grid=GridConfig(rows=2, cols=3),
            source_image=Path("materials/source/images/test.jpeg"),
            background_music=None,
            time_limit_sec=120,
            snap_tolerance_px=20,
            shuffle=ShuffleConfig(seed=1, mode="random_scatter"),
            rules=RuleConfig(snap_strategy="strict", magnet_strength=0.0),
            audio={},
            ui=UIConfig(),
            window=WindowConfig(width=800, height=600, fps=60),
            background_image=None,
        )

    def test_fixed_board_frame_not_affected_by_piece_positions(self) -> None:
        level = self._level()
        screen = pygame.Surface((level.window.width, level.window.height))
        renderer = PygameRenderer(screen=screen, level=level, background_surface=None)

        pieces = {
            0: Piece(0, 0, 0, pygame.Surface((50, 40)), x=10.0, y=12.0),
            1: Piece(1, 0, 1, pygame.Surface((50, 40)), x=620.0, y=510.0),
        }
        state = GameState(
            pieces=pieces,
            draw_order=[0, 1],
            expected_edges={},
            snap_tolerance_px=10.0,
        )

        rect_before = renderer._fixed_board_rect(state)
        pieces[0].x, pieces[0].y = 300.0, 300.0
        pieces[1].x, pieces[1].y = 100.0, 100.0
        rect_after = renderer._fixed_board_rect(state)

        self.assertEqual(rect_before.size, (150, 80))
        self.assertEqual(rect_before, rect_after)


if __name__ == "__main__":
    unittest.main()
