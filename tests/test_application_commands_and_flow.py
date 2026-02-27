from __future__ import annotations

import unittest

import pygame

from puzzle_game.application.commands import MergeCommand, MoveCommand, SplitCommand
from puzzle_game.application.flow import GameFlow
from puzzle_game.application.session import GameSession
from puzzle_game.domain.graph import build_expected_edges
from puzzle_game.domain.models import Piece
from puzzle_game.domain.state import GameState


class ApplicationCommandAndFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        pygame.init()

    @classmethod
    def tearDownClass(cls) -> None:
        pygame.quit()

    def _state(self) -> GameState:
        pieces = {
            0: Piece(0, 0, 0, pygame.Surface((40, 40)), x=10.0, y=10.0),
            1: Piece(1, 0, 1, pygame.Surface((40, 40)), x=50.0, y=10.0),
        }
        edges = build_expected_edges(
            cell_to_piece_id={(0, 0): 0, (0, 1): 1},
            tile_w=40,
            tile_h=40,
        )
        return GameState(
            pieces=pieces,
            draw_order=[0, 1],
            expected_edges=edges,
            snap_tolerance_px=10.0,
        )

    def test_move_merge_split_commands(self) -> None:
        state = self._state()

        move_result = MoveCommand(target=state.pieces[0], dx=5.0, dy=-2.0).execute()
        self.assertTrue(move_result.moved)
        self.assertEqual((state.pieces[0].x, state.pieces[0].y), (15.0, 8.0))

        merge_result = MergeCommand(state=state, edge_key=frozenset({0, 1})).execute()
        self.assertEqual(merge_result.merged_edges, 1)

        split_result = SplitCommand(state=state, piece_id=1).execute()
        self.assertEqual(split_result.split_edges, 1)

    def test_flow_emits_win_and_timeout_cues(self) -> None:
        state = self._state()
        # Empty expected_edges means solved immediately.
        solved_state = GameState(
            pieces=state.pieces,
            draw_order=state.draw_order,
            expected_edges={},
            snap_tolerance_px=state.snap_tolerance_px,
        )

        flow = GameFlow(session=GameSession.new(30))
        win_cues = flow.update(state=solved_state, delta_sec=0.1)
        self.assertEqual(win_cues, ("win",))

        timeout_flow = GameFlow(session=GameSession.new(1))
        timeout_cues = timeout_flow.update(state=state, delta_sec=2.0)
        self.assertEqual(timeout_cues, ("timeout",))


if __name__ == "__main__":
    unittest.main()
