from __future__ import annotations

from dataclasses import dataclass, field

from puzzle_game.domain.graph import EdgeKey, EdgeSpec, build_adjacency, connected_component
from puzzle_game.domain.models import Group, Piece


@dataclass
class GameState:
    pieces: dict[int, Piece]
    draw_order: list[int]
    expected_edges: dict[EdgeKey, EdgeSpec]
    snap_tolerance_px: float
    locked_edges: set[EdgeKey] = field(default_factory=set)

    def piece_at(self, mouse_pos: tuple[int, int], excluded_ids: set[int] | None = None) -> Piece | None:
        excluded = excluded_ids or set()
        for piece_id in reversed(self.draw_order):
            if piece_id in excluded:
                continue
            piece = self.pieces[piece_id]
            if piece.rect.collidepoint(mouse_pos):
                return piece
        return None

    def bring_group_to_front(self, group_piece_ids: set[int]) -> None:
        if not group_piece_ids:
            return
        self.draw_order = [pid for pid in self.draw_order if pid not in group_piece_ids] + sorted(group_piece_ids)

    def group_ids_for_piece(self, piece_id: int) -> set[int]:
        adjacency = build_adjacency(piece_ids=set(self.pieces), locked_edges=self.locked_edges)
        return connected_component(start_id=piece_id, adjacency=adjacency)

    def group_for_piece(self, piece_id: int) -> Group:
        return self.create_group(self.group_ids_for_piece(piece_id))

    def create_group(self, piece_ids: set[int]) -> Group:
        return Group(self.pieces[pid] for pid in piece_ids)

    def move_pieces(self, piece_ids: set[int], dx: float, dy: float) -> None:
        for piece_id in piece_ids:
            self.pieces[piece_id].move(dx, dy)

    def lock_edge(self, edge_key: EdgeKey) -> bool:
        if edge_key in self.locked_edges:
            return False
        if edge_key not in self.expected_edges:
            return False
        self.locked_edges.add(edge_key)
        return True

    def split_piece(self, piece_id: int) -> int:
        to_remove = {edge for edge in self.locked_edges if piece_id in edge}
        if not to_remove:
            return 0
        self.locked_edges.difference_update(to_remove)
        return len(to_remove)

    def remove_locked_edges_touching(self, piece_ids: set[int]) -> int:
        if not piece_ids:
            return 0
        to_remove = {edge for edge in self.locked_edges if any(piece_id in edge for piece_id in piece_ids)}
        if not to_remove:
            return 0
        self.locked_edges.difference_update(to_remove)
        return len(to_remove)

    def aligned_unlocked_edges(
        self,
        *,
        tolerance: float,
        candidate_piece_ids: set[int] | None = None,
    ) -> list[EdgeKey]:
        aligned: list[EdgeKey] = []
        for edge_key, edge_spec in self.expected_edges.items():
            if edge_key in self.locked_edges:
                continue

            if candidate_piece_ids is not None:
                touches_candidate = (
                    edge_spec.first_id in candidate_piece_ids
                    or edge_spec.second_id in candidate_piece_ids
                )
                if not touches_candidate:
                    continue

            first_piece = self.pieces[edge_spec.first_id]
            second_piece = self.pieces[edge_spec.second_id]
            dx = (second_piece.x - first_piece.x) - edge_spec.expected_dx
            dy = (second_piece.y - first_piece.y) - edge_spec.expected_dy

            if abs(dx) <= tolerance and abs(dy) <= tolerance:
                aligned.append(edge_key)

        return aligned

    def is_solved(self) -> bool:
        return len(self.locked_edges) == len(self.expected_edges)
