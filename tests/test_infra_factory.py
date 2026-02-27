from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import pygame

from puzzle_game.infra.assets import AssetManager
from puzzle_game.infra.config import GridConfig, LevelConfig, RuleConfig, ShuffleConfig, UIConfig, WindowConfig
from puzzle_game.infra.factory import PuzzleStateFactory
from puzzle_game.ui.layout import compute_fixed_board_rect


class InfraFactoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        pygame.init()

    @classmethod
    def tearDownClass(cls) -> None:
        pygame.quit()

    def test_factory_creates_expected_piece_and_edge_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            level = LevelConfig(
                level_id="level_factory",
                title="factory",
                description="",
                grid=GridConfig(rows=2, cols=2),
                source_image=root / "missing.jpg",
                background_music=None,
                time_limit_sec=120,
                snap_tolerance_px=20,
                shuffle=ShuffleConfig(seed=1, mode="random_scatter"),
                rules=RuleConfig(snap_strategy="strict", magnet_strength=0.0),
                audio={},
                ui=UIConfig(),
                window=WindowConfig(width=1280, height=720, fps=60),
            )

            factory = PuzzleStateFactory(assets=AssetManager())
            state = factory.create_state(level=level, screen_size=(1280, 720))

            self.assertEqual(len(state.pieces), 4)
            # 2x2 grid has 4 adjacency edges.
            self.assertEqual(len(state.expected_edges), 4)
            self.assertEqual(state.snap_tolerance_px, 20.0)

    def test_split_handles_tiny_images_smaller_than_grid(self) -> None:
        tiny = pygame.Surface((2, 2))
        grid, mapping = PuzzleStateFactory._split_tiles_to_id_grid(image=tiny, rows=3, cols=4)

        self.assertEqual(len(grid), 3)
        self.assertTrue(all(len(row) == 4 for row in grid))
        self.assertEqual(mapping[(2, 3)], 11)
        self.assertEqual(grid[0][0].get_size(), (1, 1))

    def test_scatter_starts_outside_fixed_board_frame(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            level = LevelConfig(
                level_id="level_scatter",
                title="scatter",
                description="",
                grid=GridConfig(rows=6, cols=6),
                source_image=root / "missing.jpg",
                background_music=None,
                time_limit_sec=120,
                snap_tolerance_px=20,
                shuffle=ShuffleConfig(seed=42, mode="random_scatter"),
                rules=RuleConfig(snap_strategy="strict", magnet_strength=0.0),
                audio={},
                ui=UIConfig(),
                window=WindowConfig(width=1280, height=720, fps=60),
            )

            factory = PuzzleStateFactory(assets=AssetManager())
            state = factory.create_state(level=level, screen_size=(1280, 720))

            sample_piece = next(iter(state.pieces.values()))
            x, y, w, h = compute_fixed_board_rect(
                screen_size=(1280, 720),
                rows=level.grid.rows,
                cols=level.grid.cols,
                tile_size=(sample_piece.width, sample_piece.height),
            )
            board_rect = pygame.Rect(x, y, w, h)

            self.assertTrue(
                all(not piece.rect.colliderect(board_rect) for piece in state.pieces.values()),
                "initial pieces should spawn outside fixed board frame",
            )

    def test_grid_shuffle_starts_inside_board_cells(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            level = LevelConfig(
                level_id="level_grid_shuffle",
                title="grid_shuffle",
                description="",
                grid=GridConfig(rows=3, cols=3),
                source_image=root / "missing.jpg",
                background_music=None,
                time_limit_sec=120,
                snap_tolerance_px=20,
                shuffle=ShuffleConfig(seed=7, mode="grid_shuffle"),
                rules=RuleConfig(snap_strategy="strict", magnet_strength=0.0),
                audio={},
                ui=UIConfig(),
                window=WindowConfig(width=960, height=640, fps=60),
            )

            factory = PuzzleStateFactory(assets=AssetManager())
            state = factory.create_state(level=level, screen_size=(960, 640))

            sample_piece = next(iter(state.pieces.values()))
            tile_w, tile_h = sample_piece.width, sample_piece.height
            x, y, w, h = compute_fixed_board_rect(
                screen_size=(960, 640),
                rows=level.grid.rows,
                cols=level.grid.cols,
                tile_size=(tile_w, tile_h),
            )

            valid_cells = {
                (x + col * tile_w, y + row * tile_h)
                for row in range(level.grid.rows)
                for col in range(level.grid.cols)
            }
            placed_cells = {(int(piece.x), int(piece.y)) for piece in state.pieces.values()}

            self.assertEqual(len(placed_cells), level.grid.rows * level.grid.cols)
            self.assertEqual(placed_cells, valid_cells)


if __name__ == "__main__":
    unittest.main()
