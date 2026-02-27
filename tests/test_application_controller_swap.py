from __future__ import annotations

import unittest

import pygame

from puzzle_game.application.controller import InteractionController
from puzzle_game.domain.graph import EdgeSpec
from puzzle_game.domain.models import Piece
from puzzle_game.domain.state import GameState
from puzzle_game.rules.snap import SnapRuleEngine, StrictSnapStrategy


class ApplicationControllerSwapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        pygame.init()

    @classmethod
    def tearDownClass(cls) -> None:
        pygame.quit()

    def _controller(self) -> tuple[InteractionController, GameState]:
        state = GameState(
            pieces={
                0: Piece(0, 0, 0, pygame.Surface((40, 40)), x=10.0, y=10.0),
                1: Piece(1, 0, 1, pygame.Surface((40, 40)), x=80.0, y=10.0),
            },
            draw_order=[0, 1],
            expected_edges={},
            snap_tolerance_px=10.0,
        )
        controller = InteractionController(
            state=state,
            snap_engine=SnapRuleEngine(strategy=StrictSnapStrategy(), magnet_strength=0.0),
        )
        return controller, state

    def test_drop_on_another_piece_swaps_positions(self) -> None:
        controller, state = self._controller()

        down_cues = controller.on_left_mouse_down((12, 12))
        up_cues = controller.on_left_mouse_up((82, 12))

        self.assertEqual(down_cues, ("piece_pick",))
        self.assertEqual(up_cues, ("piece_drop",))
        self.assertEqual((state.pieces[0].x, state.pieces[0].y), (80.0, 10.0))
        self.assertEqual((state.pieces[1].x, state.pieces[1].y), (10.0, 10.0))

    def test_swap_uses_drag_start_anchor_not_release_anchor(self) -> None:
        controller, state = self._controller()

        controller.on_left_mouse_down((12, 12))
        controller.on_mouse_motion((70, 12))  # dragged piece now near x=68
        up_cues = controller.on_left_mouse_up((82, 12))

        self.assertEqual(up_cues, ("piece_drop",))
        self.assertEqual((state.pieces[0].x, state.pieces[0].y), (80.0, 10.0))
        self.assertEqual((state.pieces[1].x, state.pieces[1].y), (10.0, 10.0))

    def test_grid_swap_mode_disables_free_drag_motion(self) -> None:
        controller, state = self._controller()
        controller.grid_swap_only = True

        controller.on_left_mouse_down((12, 12))
        controller.on_mouse_motion((120, 120))

        # In grid swap mode, motion should not move pieces freely.
        self.assertEqual((state.pieces[0].x, state.pieces[0].y), (10.0, 10.0))

        up_cues = controller.on_left_mouse_up((82, 12))
        self.assertEqual(up_cues, ("piece_drop",))
        self.assertEqual((state.pieces[0].x, state.pieces[0].y), (80.0, 10.0))
        self.assertEqual((state.pieces[1].x, state.pieces[1].y), (10.0, 10.0))

    def test_plan_and_apply_group_swap_works_without_linking(self) -> None:
        controller, state = self._controller()

        plan = controller.plan_group_swap(
            first_piece_ids={0},
            second_piece_ids={1},
            require_first_within_grid=True,
        )

        self.assertIsNotNone(plan)
        assert plan is not None
        cues = controller.apply_swap_plan(plan)
        self.assertEqual(cues, ("piece_drop",))
        self.assertEqual((state.pieces[0].x, state.pieces[0].y), (80.0, 10.0))
        self.assertEqual((state.pieces[1].x, state.pieces[1].y), (10.0, 10.0))

    def test_plan_group_swap_rejects_when_first_group_would_leave_grid(self) -> None:
        state = GameState(
            pieces={
                0: Piece(0, 0, 0, pygame.Surface((40, 40)), x=10.0, y=10.0),
                1: Piece(1, 0, 1, pygame.Surface((40, 40)), x=80.0, y=10.0),
                2: Piece(2, 1, 0, pygame.Surface((40, 40)), x=10.0, y=80.0),
            },
            draw_order=[0, 1, 2],
            expected_edges={
                frozenset({0, 1}): EdgeSpec(first_id=0, second_id=1, expected_dx=40, expected_dy=0)
            },
            snap_tolerance_px=10.0,
            locked_edges={frozenset({0, 1})},
        )

        controller = InteractionController(
            state=state,
            snap_engine=SnapRuleEngine(strategy=StrictSnapStrategy(), magnet_strength=0.0),
            grid_swap_only=True,
        )

        plan = controller.plan_group_swap(
            first_piece_ids={0, 1},
            second_piece_ids={2},
            require_first_within_grid=True,
        )
        self.assertIsNone(plan)

    def test_plan_group_swap_by_target_piece_uses_shape_footprint(self) -> None:
        state = GameState(
            pieces={
                0: Piece(0, 0, 0, pygame.Surface((40, 40)), x=10.0, y=10.0),
                1: Piece(1, 0, 1, pygame.Surface((40, 40)), x=50.0, y=10.0),
                2: Piece(2, 0, 2, pygame.Surface((40, 40)), x=90.0, y=10.0),
                3: Piece(3, 1, 0, pygame.Surface((40, 40)), x=10.0, y=50.0),
                4: Piece(4, 1, 1, pygame.Surface((40, 40)), x=50.0, y=50.0),
                5: Piece(5, 1, 2, pygame.Surface((40, 40)), x=90.0, y=50.0),
            },
            draw_order=[0, 1, 2, 3, 4, 5],
            expected_edges={
                frozenset({0, 3}): EdgeSpec(first_id=0, second_id=3, expected_dx=0, expected_dy=40)
            },
            snap_tolerance_px=10.0,
            locked_edges={frozenset({0, 3})},
        )

        controller = InteractionController(
            state=state,
            snap_engine=SnapRuleEngine(strategy=StrictSnapStrategy(), magnet_strength=0.0),
            grid_swap_only=True,
        )

        plan = controller.plan_group_swap_by_target_piece(
            first_piece_ids={0, 3},
            target_piece_id=2,
            require_first_within_grid=True,
        )

        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertEqual(set(plan.second_piece_ids), {2, 5})

        cues = controller.apply_swap_plan(plan)
        self.assertEqual(cues, ("piece_drop",))
        self.assertEqual((state.pieces[0].x, state.pieces[0].y), (90.0, 10.0))
        self.assertEqual((state.pieces[3].x, state.pieces[3].y), (90.0, 50.0))
        self.assertEqual((state.pieces[2].x, state.pieces[2].y), (10.0, 10.0))
        self.assertEqual((state.pieces[5].x, state.pieces[5].y), (10.0, 50.0))

    def test_plan_group_swap_by_target_piece_uses_nearest_group_edge_as_anchor(self) -> None:
        state = GameState(
            pieces={
                0: Piece(0, 0, 0, pygame.Surface((40, 40)), x=10.0, y=10.0),
                1: Piece(1, 0, 1, pygame.Surface((40, 40)), x=50.0, y=10.0),
                2: Piece(2, 0, 2, pygame.Surface((40, 40)), x=90.0, y=10.0),
                3: Piece(3, 0, 3, pygame.Surface((40, 40)), x=130.0, y=10.0),
            },
            draw_order=[0, 1, 2, 3],
            expected_edges={},
            snap_tolerance_px=10.0,
            locked_edges={frozenset({0, 1})},
        )

        controller = InteractionController(
            state=state,
            snap_engine=SnapRuleEngine(strategy=StrictSnapStrategy(), magnet_strength=0.0),
            grid_swap_only=True,
        )

        plan = controller.plan_group_swap_by_target_piece(
            first_piece_ids={0, 1},
            target_piece_id=3,
            require_first_within_grid=True,
        )

        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertEqual(set(plan.second_piece_ids), {2, 3})

        cues = controller.apply_swap_plan(plan)
        self.assertEqual(cues, ("piece_drop",))
        self.assertEqual((state.pieces[0].x, state.pieces[0].y), (90.0, 10.0))
        self.assertEqual((state.pieces[1].x, state.pieces[1].y), (130.0, 10.0))
        self.assertEqual((state.pieces[2].x, state.pieces[2].y), (10.0, 10.0))
        self.assertEqual((state.pieces[3].x, state.pieces[3].y), (50.0, 10.0))

    def test_rebuild_all_locked_edges_adds_missing_links(self) -> None:
        state = GameState(
            pieces={
                0: Piece(0, 0, 0, pygame.Surface((40, 40)), x=10.0, y=10.0),
                1: Piece(1, 0, 1, pygame.Surface((40, 40)), x=50.0, y=10.0),
                2: Piece(2, 0, 2, pygame.Surface((40, 40)), x=90.0, y=10.0),
            },
            draw_order=[0, 1, 2],
            expected_edges={
                frozenset({0, 1}): EdgeSpec(first_id=0, second_id=1, expected_dx=40, expected_dy=0),
                frozenset({1, 2}): EdgeSpec(first_id=1, second_id=2, expected_dx=40, expected_dy=0),
            },
            snap_tolerance_px=10.0,
            locked_edges={frozenset({0, 1})},
        )

        controller = InteractionController(
            state=state,
            snap_engine=SnapRuleEngine(strategy=StrictSnapStrategy(), magnet_strength=0.0),
            grid_swap_only=True,
        )

        controller.rebuild_all_locked_edges(tolerance=0.01)

        self.assertEqual(state.locked_edges, {frozenset({0, 1}), frozenset({1, 2})})

    def test_rebuild_all_locked_edges_removes_stale_links(self) -> None:
        state = GameState(
            pieces={
                0: Piece(0, 0, 0, pygame.Surface((40, 40)), x=10.0, y=10.0),
                1: Piece(1, 0, 1, pygame.Surface((40, 40)), x=90.0, y=10.0),
            },
            draw_order=[0, 1],
            expected_edges={
                frozenset({0, 1}): EdgeSpec(first_id=0, second_id=1, expected_dx=40, expected_dy=0),
            },
            snap_tolerance_px=10.0,
            locked_edges={frozenset({0, 1})},
        )

        controller = InteractionController(
            state=state,
            snap_engine=SnapRuleEngine(strategy=StrictSnapStrategy(), magnet_strength=0.0),
            grid_swap_only=True,
        )

        controller.rebuild_all_locked_edges(tolerance=0.01)

        self.assertEqual(state.locked_edges, set())

    def test_plan_group_swap_by_target_piece_allows_overlap_via_cycle_mapping(self) -> None:
        state = GameState(
            pieces={
                0: Piece(0, 0, 0, pygame.Surface((40, 40)), x=10.0, y=10.0),
                1: Piece(1, 0, 1, pygame.Surface((40, 40)), x=50.0, y=10.0),
                2: Piece(2, 0, 2, pygame.Surface((40, 40)), x=90.0, y=10.0),
                3: Piece(3, 0, 3, pygame.Surface((40, 40)), x=130.0, y=10.0),
            },
            draw_order=[0, 1, 2, 3],
            expected_edges={},
            snap_tolerance_px=10.0,
            locked_edges={frozenset({0, 1})},
        )

        controller = InteractionController(
            state=state,
            snap_engine=SnapRuleEngine(strategy=StrictSnapStrategy(), magnet_strength=0.0),
            grid_swap_only=True,
        )

        plan = controller.plan_group_swap_by_target_piece(
            first_piece_ids={0, 1},
            target_piece_id=2,
            require_first_within_grid=True,
        )

        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertEqual(set(plan.second_piece_ids), {2})

        cues = controller.apply_swap_plan(plan)
        self.assertEqual(cues, ("piece_drop",))
        self.assertEqual((state.pieces[0].x, state.pieces[0].y), (50.0, 10.0))
        self.assertEqual((state.pieces[1].x, state.pieces[1].y), (90.0, 10.0))
        self.assertEqual((state.pieces[2].x, state.pieces[2].y), (10.0, 10.0))
        self.assertEqual((state.pieces[3].x, state.pieces[3].y), (130.0, 10.0))


if __name__ == "__main__":
    unittest.main()
