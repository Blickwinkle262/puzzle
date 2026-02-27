from __future__ import annotations

from dataclasses import dataclass

from puzzle_game.application.commands import MoveCommand, SplitCommand
from puzzle_game.domain.models import Group
from puzzle_game.domain.state import GameState
from puzzle_game.rules.snap import SnapRuleEngine


@dataclass(frozen=True)
class SwapPlan:
    first_piece_ids: frozenset[int]
    second_piece_ids: frozenset[int]
    start_positions: dict[int, tuple[float, float]]
    end_positions: dict[int, tuple[float, float]]


@dataclass
class InteractionController:
    state: GameState
    snap_engine: SnapRuleEngine
    grid_swap_only: bool = False

    dragging_group: Group | None = None
    last_mouse_pos: tuple[int, int] | None = None
    dragging_group_origin_anchor: tuple[float, float] | None = None

    def on_left_mouse_down(self, mouse_pos: tuple[int, int]) -> tuple[str, ...]:
        piece = self.state.piece_at(mouse_pos)
        if piece is None:
            return ()

        group = self.state.group_for_piece(piece.piece_id)
        self.state.bring_group_to_front(group.piece_ids)
        self.dragging_group = group
        self.last_mouse_pos = None if self.grid_swap_only else mouse_pos
        self.dragging_group_origin_anchor = self._group_anchor(group)
        return ("piece_pick",)

    def on_mouse_motion(self, mouse_pos: tuple[int, int]) -> tuple[str, ...]:
        if self.grid_swap_only:
            return ()

        if self.dragging_group is None or self.last_mouse_pos is None:
            return ()

        dx = mouse_pos[0] - self.last_mouse_pos[0]
        dy = mouse_pos[1] - self.last_mouse_pos[1]
        MoveCommand(target=self.dragging_group, dx=dx, dy=dy).execute()
        self.last_mouse_pos = mouse_pos
        return ()

    def on_left_mouse_up(self, mouse_pos: tuple[int, int]) -> tuple[str, ...]:
        if self.dragging_group is None:
            return ()

        moved_ids = set(self.dragging_group.piece_ids)
        target_piece = self.state.piece_at(mouse_pos, excluded_ids=moved_ids)

        linked_edges = 0
        if target_piece is not None:
            target_group = self.state.group_for_piece(target_piece.piece_id)
            origin_anchor = self.dragging_group_origin_anchor or self._group_anchor(self.dragging_group)
            target_anchor = self._group_anchor(target_group)

            if self.grid_swap_only and not self._can_swap_groups(
                first=self.dragging_group,
                second=target_group,
                first_origin_anchor=origin_anchor,
                second_anchor=target_anchor,
            ):
                self.dragging_group = None
                self.last_mouse_pos = None
                self.dragging_group_origin_anchor = None
                return ("piece_drop",)

            self._swap_group_positions(
                first=self.dragging_group,
                second=target_group,
                first_origin_anchor=origin_anchor,
                second_anchor=target_anchor,
            )
            linked_edges += self.snap_engine.apply_drop(state=self.state, moved_piece_ids=moved_ids)
            linked_edges += self.snap_engine.apply_drop(
                state=self.state,
                moved_piece_ids=set(target_group.piece_ids),
            )
        elif not self.grid_swap_only:
            linked_edges += self.snap_engine.apply_drop(state=self.state, moved_piece_ids=moved_ids)

        self.dragging_group = None
        self.last_mouse_pos = None
        self.dragging_group_origin_anchor = None

        if linked_edges > 0:
            return ("piece_drop", "piece_link")
        return ("piece_drop",)

    def on_right_mouse_down(self, mouse_pos: tuple[int, int]) -> tuple[str, ...]:
        piece = self.state.piece_at(mouse_pos)
        if piece is None:
            return ()

        split_result = SplitCommand(state=self.state, piece_id=piece.piece_id).execute()
        if split_result.split_edges > 0:
            return ("piece_unlink",)
        return ()

    def group_ids_at(self, mouse_pos: tuple[int, int], excluded_ids: set[int] | None = None) -> set[int] | None:
        piece = self.state.piece_at(mouse_pos, excluded_ids=excluded_ids)
        if piece is None:
            return None
        return self.state.group_ids_for_piece(piece.piece_id)

    def piece_id_at(self, mouse_pos: tuple[int, int], excluded_ids: set[int] | None = None) -> int | None:
        piece = self.state.piece_at(mouse_pos, excluded_ids=excluded_ids)
        return None if piece is None else piece.piece_id

    def plan_group_swap(
        self,
        *,
        first_piece_ids: set[int],
        second_piece_ids: set[int],
        require_first_within_grid: bool,
    ) -> SwapPlan | None:
        first = self.state.create_group(first_piece_ids)
        second = self.state.create_group(second_piece_ids)

        first_origin_anchor = self._group_anchor(first)
        second_anchor = self._group_anchor(second)
        first_current_anchor = self._group_anchor(first)

        first_dx = second_anchor[0] - first_current_anchor[0]
        first_dy = second_anchor[1] - first_current_anchor[1]
        second_dx = first_origin_anchor[0] - second_anchor[0]
        second_dy = first_origin_anchor[1] - second_anchor[1]

        start_positions = {
            piece_id: (float(self.state.pieces[piece_id].x), float(self.state.pieces[piece_id].y))
            for piece_id in (first_piece_ids | second_piece_ids)
        }
        end_positions = dict(start_positions)

        for piece in first.pieces:
            end_positions[piece.piece_id] = (piece.x + first_dx, piece.y + first_dy)
        for piece in second.pieces:
            end_positions[piece.piece_id] = (piece.x + second_dx, piece.y + second_dy)

        if require_first_within_grid and not self._first_group_within_grid(first_piece_ids, end_positions):
            return None

        return SwapPlan(
            first_piece_ids=frozenset(first_piece_ids),
            second_piece_ids=frozenset(second_piece_ids),
            start_positions=start_positions,
            end_positions=end_positions,
        )

    def plan_group_swap_by_target_piece(
        self,
        *,
        first_piece_ids: set[int],
        target_piece_id: int,
        require_first_within_grid: bool,
    ) -> SwapPlan | None:
        if not first_piece_ids:
            return None

        first = self.state.create_group(first_piece_ids)
        target_piece = self.state.pieces.get(target_piece_id)
        if target_piece is None:
            return None

        anchor_piece_id = self._closest_piece_id_in_group(
            group_piece_ids=first_piece_ids,
            target=(target_piece.x, target_piece.y),
        )
        first_anchor_piece = self.state.pieces[anchor_piece_id]
        first_anchor = (first_anchor_piece.x, first_anchor_piece.y)

        delta_x = target_piece.x - first_anchor[0]
        delta_y = target_piece.y - first_anchor[1]
        delta_key = (int(round(delta_x)), int(round(delta_y)))
        if delta_key == (0, 0):
            return None

        valid_grid_positions = {
            (int(round(piece.x)), int(round(piece.y))): piece_id
            for piece_id, piece in self.state.pieces.items()
        }

        first_target_positions: dict[int, tuple[float, float]] = {}
        first_from_keys: dict[int, tuple[int, int]] = {}
        first_to_keys: dict[int, tuple[int, int]] = {}
        second_piece_ids: set[int] = set()
        second_target_positions: dict[int, tuple[float, float]] = {}

        for piece in first.pieces:
            offset_x = piece.x - first_anchor[0]
            offset_y = piece.y - first_anchor[1]

            from_x = first_anchor[0] + offset_x
            from_y = first_anchor[1] + offset_y
            from_key = (int(round(from_x)), int(round(from_y)))

            to_x = from_x + delta_x
            to_y = from_y + delta_y
            to_key = (int(round(to_x)), int(round(to_y)))

            if require_first_within_grid and to_key not in valid_grid_positions:
                return None

            first_target_positions[piece.piece_id] = (to_x, to_y)
            first_from_keys[piece.piece_id] = from_key
            first_to_keys[piece.piece_id] = to_key

        first_cell_keys = set(first_from_keys.values())
        target_cell_keys = set(first_to_keys.values())
        vacated_keys = first_cell_keys - target_cell_keys
        entering_keys = target_cell_keys - first_cell_keys

        for entering_key in entering_keys:
            occupied_id = valid_grid_positions.get(entering_key)
            if occupied_id is None:
                return None

            second_piece_ids.add(occupied_id)

            # Cycle mapping: walk backward along -delta until reaching a truly vacated cell.
            walk_key = entering_key
            visited: set[tuple[int, int]] = set()
            while walk_key not in vacated_keys:
                if walk_key in visited:
                    return None
                visited.add(walk_key)

                walk_key = (walk_key[0] - delta_key[0], walk_key[1] - delta_key[1])
                if walk_key not in first_cell_keys and walk_key not in vacated_keys:
                    return None

            second_target_positions[occupied_id] = (float(walk_key[0]), float(walk_key[1]))

        if not second_piece_ids:
            return None

        moved_ids = first_piece_ids | second_piece_ids
        start_positions = {
            piece_id: (float(self.state.pieces[piece_id].x), float(self.state.pieces[piece_id].y)
            )
            for piece_id in moved_ids
        }
        end_positions = dict(start_positions)
        end_positions.update(first_target_positions)
        end_positions.update(second_target_positions)

        return SwapPlan(
            first_piece_ids=frozenset(first_piece_ids),
            second_piece_ids=frozenset(second_piece_ids),
            start_positions=start_positions,
            end_positions=end_positions,
        )

    def apply_swap_plan(self, plan: SwapPlan) -> tuple[str, ...]:
        previous_locked_edges = set(self.state.locked_edges)

        for piece_id, (end_x, end_y) in plan.end_positions.items():
            piece = self.state.pieces[piece_id]
            piece.x = end_x
            piece.y = end_y

        if self.grid_swap_only:
            # Rebuild all locked edges from current board state to avoid stale links.
            self.rebuild_all_locked_edges(tolerance=0.01)
            linked_edges = len(self.state.locked_edges - previous_locked_edges)
        else:
            linked_edges = 0
            linked_edges += self.snap_engine.apply_drop(state=self.state, moved_piece_ids=set(plan.first_piece_ids))
            linked_edges += self.snap_engine.apply_drop(state=self.state, moved_piece_ids=set(plan.second_piece_ids))

        if linked_edges > 0:
            return ("piece_drop", "piece_link")
        return ("piece_drop",)

    def rebuild_all_locked_edges(self, *, tolerance: float = 0.01) -> None:
        self.state.locked_edges.clear()
        for edge_key in self.state.aligned_unlocked_edges(tolerance=tolerance):
            self.state.lock_edge(edge_key)

    def cancel_drag(self) -> None:
        self.dragging_group = None
        self.last_mouse_pos = None
        self.dragging_group_origin_anchor = None

    def _swap_group_positions(
        self,
        *,
        first: Group,
        second: Group,
        first_origin_anchor: tuple[float, float],
        second_anchor: tuple[float, float],
    ) -> None:
        first_current_anchor = self._group_anchor(first)

        MoveCommand(
            target=first,
            dx=second_anchor[0] - first_current_anchor[0],
            dy=second_anchor[1] - first_current_anchor[1],
        ).execute()
        MoveCommand(
            target=second,
            dx=first_origin_anchor[0] - second_anchor[0],
            dy=first_origin_anchor[1] - second_anchor[1],
        ).execute()

    def _can_swap_groups(
        self,
        *,
        first: Group,
        second: Group,
        first_origin_anchor: tuple[float, float],
        second_anchor: tuple[float, float],
    ) -> bool:
        if first.piece_ids == second.piece_ids:
            return True

        first_current_anchor = self._group_anchor(first)
        first_dx = second_anchor[0] - first_current_anchor[0]
        first_dy = second_anchor[1] - first_current_anchor[1]
        second_dx = first_origin_anchor[0] - second_anchor[0]
        second_dy = first_origin_anchor[1] - second_anchor[1]

        current_positions = {
            piece_id: (float(piece.x), float(piece.y))
            for piece_id, piece in self.state.pieces.items()
        }
        valid_grid_positions = {
            (int(round(piece.x)), int(round(piece.y)))
            for piece in self.state.pieces.values()
        }

        future_positions = dict(current_positions)
        for piece in first.pieces:
            future_positions[piece.piece_id] = (piece.x + first_dx, piece.y + first_dy)
        for piece in second.pieces:
            future_positions[piece.piece_id] = (piece.x + second_dx, piece.y + second_dy)

        moved_ids = first.piece_ids | second.piece_ids
        for piece_id in moved_ids:
            x, y = future_positions[piece_id]
            if (int(round(x)), int(round(y))) not in valid_grid_positions:
                return False

        occupied_after = {
            (int(round(x)), int(round(y)))
            for x, y in future_positions.values()
        }
        return len(occupied_after) == len(future_positions)

    def _first_group_within_grid(
        self,
        first_piece_ids: set[int],
        end_positions: dict[int, tuple[float, float]],
    ) -> bool:
        valid_grid_positions = {
            (int(round(piece.x)), int(round(piece.y)))
            for piece in self.state.pieces.values()
        }
        for piece_id in first_piece_ids:
            x, y = end_positions[piece_id]
            if (int(round(x)), int(round(y))) not in valid_grid_positions:
                return False
        return True

    @staticmethod
    def _group_anchor(group: Group) -> tuple[float, float]:
        points = [(piece.x, piece.y) for piece in group.pieces]
        return min(points, key=lambda p: (p[0], p[1]))

    def _closest_piece_id_in_group(
        self,
        *,
        group_piece_ids: set[int],
        target: tuple[float, float],
    ) -> int:
        target_x, target_y = target
        return min(
            group_piece_ids,
            key=lambda piece_id: (
                abs(self.state.pieces[piece_id].x - target_x)
                + abs(self.state.pieces[piece_id].y - target_y),
                self.state.pieces[piece_id].x,
                self.state.pieces[piece_id].y,
            ),
        )
