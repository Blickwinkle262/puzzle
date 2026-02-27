from __future__ import annotations

import unittest

import pygame

from puzzle_game.domain.graph import build_expected_edges
from puzzle_game.domain.models import Group, Piece
from puzzle_game.domain.state import GameState


class DomainModelsAndStateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        pygame.init()

    @classmethod
    def tearDownClass(cls) -> None:
        pygame.quit()

    def test_piece_and_group_move(self) -> None:
        piece_a = Piece(0, 0, 0, pygame.Surface((20, 20)), x=10.0, y=10.0)
        piece_b = Piece(1, 0, 1, pygame.Surface((20, 20)), x=40.0, y=10.0)

        piece_a.move(3.0, -2.0)
        self.assertEqual((piece_a.x, piece_a.y), (13.0, 8.0))

        group = Group([piece_a, piece_b])
        group.move(5.0, 5.0)
        self.assertEqual((piece_a.x, piece_a.y), (18.0, 13.0))
        self.assertEqual((piece_b.x, piece_b.y), (45.0, 15.0))

    def test_state_connectivity_and_split(self) -> None:
        pieces = {
            0: Piece(0, 0, 0, pygame.Surface((50, 50)), x=100.0, y=100.0),
            1: Piece(1, 0, 1, pygame.Surface((50, 50)), x=150.0, y=100.0),
        }
        expected_edges = build_expected_edges(
            cell_to_piece_id={(0, 0): 0, (0, 1): 1},
            tile_w=50,
            tile_h=50,
        )
        state = GameState(
            pieces=pieces,
            draw_order=[0, 1],
            expected_edges=expected_edges,
            snap_tolerance_px=20.0,
        )

        edge_key = frozenset({0, 1})
        self.assertTrue(state.lock_edge(edge_key))
        self.assertEqual(state.group_ids_for_piece(0), {0, 1})

        removed = state.split_piece(1)
        self.assertEqual(removed, 1)
        self.assertEqual(state.group_ids_for_piece(0), {0})

    def test_piece_at_uses_draw_order_frontmost(self) -> None:
        # Two overlapping pieces, the later draw_order item should be selected.
        pieces = {
            0: Piece(0, 0, 0, pygame.Surface((40, 40)), x=10.0, y=10.0),
            1: Piece(1, 0, 1, pygame.Surface((40, 40)), x=10.0, y=10.0),
        }
        state = GameState(
            pieces=pieces,
            draw_order=[0, 1],
            expected_edges={},
            snap_tolerance_px=10.0,
        )

        picked = state.piece_at((15, 15))
        self.assertIsNotNone(picked)
        assert picked is not None
        self.assertEqual(picked.piece_id, 1)


if __name__ == "__main__":
    unittest.main()
