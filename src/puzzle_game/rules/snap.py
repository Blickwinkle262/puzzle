from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from puzzle_game.domain.graph import EdgeKey
from puzzle_game.domain.state import GameState


@dataclass(frozen=True)
class SnapCandidate:
    shift_x: float
    shift_y: float
    edge_key: EdgeKey


class SnapStrategy(Protocol):
    def pick_candidate(self, state: GameState, moved_piece_ids: set[int]) -> SnapCandidate | None:
        """Select one best snap candidate for dropped pieces."""


class _BaseOffsetSnapStrategy:
    tolerance_factor: float = 1.0

    def pick_candidate(self, state: GameState, moved_piece_ids: set[int]) -> SnapCandidate | None:
        best: tuple[float, float, EdgeKey, float] | None = None
        tolerance = state.snap_tolerance_px * self.tolerance_factor

        for edge_key, edge_spec in state.expected_edges.items():
            if edge_key in state.locked_edges:
                continue

            first_in_group = edge_spec.first_id in moved_piece_ids
            second_in_group = edge_spec.second_id in moved_piece_ids
            if first_in_group == second_in_group:
                continue

            first_piece = state.pieces[edge_spec.first_id]
            second_piece = state.pieces[edge_spec.second_id]

            if first_in_group:
                target_x = second_piece.x - edge_spec.expected_dx
                target_y = second_piece.y - edge_spec.expected_dy
                shift_x = target_x - first_piece.x
                shift_y = target_y - first_piece.y
            else:
                target_x = first_piece.x + edge_spec.expected_dx
                target_y = first_piece.y + edge_spec.expected_dy
                shift_x = target_x - second_piece.x
                shift_y = target_y - second_piece.y

            if abs(shift_x) > tolerance or abs(shift_y) > tolerance:
                continue

            score = self._score(shift_x, shift_y)
            if best is None or score < best[3]:
                best = (shift_x, shift_y, edge_key, score)

        if best is None:
            return None
        return SnapCandidate(shift_x=best[0], shift_y=best[1], edge_key=best[2])

    def _score(self, shift_x: float, shift_y: float) -> float:
        return shift_x * shift_x + shift_y * shift_y


class StrictSnapStrategy(_BaseOffsetSnapStrategy):
    tolerance_factor = 1.0


class LenientSnapStrategy(_BaseOffsetSnapStrategy):
    tolerance_factor = 1.4


class MobileSnapStrategy(_BaseOffsetSnapStrategy):
    tolerance_factor = 1.8

    def _score(self, shift_x: float, shift_y: float) -> float:
        # Manhattan distance feels forgiving for finger-drag style input.
        return abs(shift_x) + abs(shift_y)


@dataclass
class SnapRuleEngine:
    strategy: SnapStrategy
    magnet_strength: float = 0.0

    def __post_init__(self) -> None:
        self.magnet_strength = max(0.0, min(1.0, float(self.magnet_strength)))

    def apply_drop(self, *, state: GameState, moved_piece_ids: set[int]) -> int:
        if not moved_piece_ids:
            return 0

        linked_count = 0
        candidate = self.strategy.pick_candidate(state, moved_piece_ids)

        if candidate is not None:
            state.move_pieces(moved_piece_ids, candidate.shift_x, candidate.shift_y)
            if state.lock_edge(candidate.edge_key):
                linked_count += 1

        aligned_tolerance = 0.5 + (self.magnet_strength * 1.5)
        for edge_key in state.aligned_unlocked_edges(
            tolerance=aligned_tolerance,
            candidate_piece_ids=moved_piece_ids,
        ):
            if state.lock_edge(edge_key):
                linked_count += 1

        return linked_count


def build_snap_strategy(strategy_name: str) -> SnapStrategy:
    name = strategy_name.strip().lower()
    if name == "strict":
        return StrictSnapStrategy()
    if name == "lenient":
        return LenientSnapStrategy()
    if name == "mobile":
        return MobileSnapStrategy()
    raise ValueError(f"Unknown snap strategy: {strategy_name}")
