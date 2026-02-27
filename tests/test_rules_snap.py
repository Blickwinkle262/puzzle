from __future__ import annotations

import unittest

import pygame

from puzzle_game.domain.graph import EdgeSpec, build_expected_edges
from puzzle_game.domain.models import Piece
from puzzle_game.domain.state import GameState
from puzzle_game.rules.snap import (
    LenientSnapStrategy,
    SnapRuleEngine,
    StrictSnapStrategy,
    build_snap_strategy,
)


class SnapRuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        pygame.init()

    @classmethod
    def tearDownClass(cls) -> None:
        pygame.quit()

    def _state_with_two_pieces(self, second_x: float, tolerance: float) -> GameState:
        pieces = {
            0: Piece(0, 0, 0, pygame.Surface((100, 100)), x=100.0, y=100.0),
            1: Piece(1, 0, 1, pygame.Surface((100, 100)), x=second_x, y=100.0),
        }
        edges = build_expected_edges(
            cell_to_piece_id={(0, 0): 0, (0, 1): 1},
            tile_w=100,
            tile_h=100,
        )
        return GameState(
            pieces=pieces,
            draw_order=[0, 1],
            expected_edges=edges,
            snap_tolerance_px=tolerance,
        )

    def test_strict_snap_merges_and_repositions(self) -> None:
        state = self._state_with_two_pieces(second_x=205.0, tolerance=20.0)
        engine = SnapRuleEngine(strategy=StrictSnapStrategy(), magnet_strength=0.0)

        linked = engine.apply_drop(state=state, moved_piece_ids={1})

        self.assertEqual(linked, 1)
        self.assertEqual(len(state.locked_edges), 1)
        self.assertEqual(state.pieces[1].x, 200.0)

    def test_lenient_allows_wider_offset_than_strict(self) -> None:
        strict_state = self._state_with_two_pieces(second_x=213.0, tolerance=10.0)
        lenient_state = self._state_with_two_pieces(second_x=213.0, tolerance=10.0)

        strict_linked = SnapRuleEngine(
            strategy=StrictSnapStrategy(),
            magnet_strength=0.0,
        ).apply_drop(state=strict_state, moved_piece_ids={1})
        lenient_linked = SnapRuleEngine(
            strategy=LenientSnapStrategy(),
            magnet_strength=0.0,
        ).apply_drop(state=lenient_state, moved_piece_ids={1})

        self.assertEqual(strict_linked, 0)
        self.assertEqual(lenient_linked, 1)

    def test_build_snap_strategy(self) -> None:
        self.assertIsInstance(build_snap_strategy("strict"), StrictSnapStrategy)
        self.assertIsInstance(build_snap_strategy("lenient"), LenientSnapStrategy)
        with self.assertRaises(ValueError):
            build_snap_strategy("unknown")

    def test_apply_drop_does_not_lock_unrelated_edges(self) -> None:
        pieces = {
            0: Piece(0, 0, 0, pygame.Surface((100, 100)), x=100.0, y=100.0),
            1: Piece(1, 0, 1, pygame.Surface((100, 100)), x=200.2, y=100.0),
            2: Piece(2, 1, 0, pygame.Surface((100, 100)), x=500.0, y=300.0),
            3: Piece(3, 1, 1, pygame.Surface((100, 100)), x=600.0, y=300.0),
        }
        edge_01 = frozenset({0, 1})
        edge_23 = frozenset({2, 3})
        state = GameState(
            pieces=pieces,
            draw_order=[0, 1, 2, 3],
            expected_edges={
                edge_01: EdgeSpec(first_id=0, second_id=1, expected_dx=100, expected_dy=0),
                edge_23: EdgeSpec(first_id=2, second_id=3, expected_dx=100, expected_dy=0),
            },
            snap_tolerance_px=5.0,
        )

        linked = SnapRuleEngine(strategy=StrictSnapStrategy(), magnet_strength=0.0).apply_drop(
            state=state,
            moved_piece_ids={1},
        )

        self.assertEqual(linked, 1)
        self.assertIn(edge_01, state.locked_edges)
        self.assertNotIn(edge_23, state.locked_edges)


if __name__ == "__main__":
    unittest.main()
