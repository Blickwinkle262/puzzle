from __future__ import annotations

from dataclasses import dataclass

EdgeKey = frozenset[int]


@dataclass(frozen=True)
class EdgeSpec:
    first_id: int
    second_id: int
    expected_dx: int
    expected_dy: int


def build_expected_edges(
    *,
    cell_to_piece_id: dict[tuple[int, int], int],
    tile_w: int,
    tile_h: int,
) -> dict[EdgeKey, EdgeSpec]:
    edges: dict[EdgeKey, EdgeSpec] = {}
    for (row, col), piece_id in cell_to_piece_id.items():
        right_piece = cell_to_piece_id.get((row, col + 1))
        down_piece = cell_to_piece_id.get((row + 1, col))

        if right_piece is not None:
            edge_key = frozenset({piece_id, right_piece})
            edges[edge_key] = EdgeSpec(
                first_id=piece_id,
                second_id=right_piece,
                expected_dx=tile_w,
                expected_dy=0,
            )
        if down_piece is not None:
            edge_key = frozenset({piece_id, down_piece})
            edges[edge_key] = EdgeSpec(
                first_id=piece_id,
                second_id=down_piece,
                expected_dx=0,
                expected_dy=tile_h,
            )
    return edges


def build_adjacency(
    *,
    piece_ids: set[int],
    locked_edges: set[EdgeKey],
) -> dict[int, set[int]]:
    adjacency = {piece_id: set() for piece_id in piece_ids}
    for edge in locked_edges:
        first_id, second_id = tuple(edge)
        adjacency[first_id].add(second_id)
        adjacency[second_id].add(first_id)
    return adjacency


def connected_component(
    *,
    start_id: int,
    adjacency: dict[int, set[int]],
) -> set[int]:
    stack = [start_id]
    visited: set[int] = set()

    while stack:
        current = stack.pop()
        if current in visited:
            continue
        visited.add(current)
        stack.extend(adjacency[current] - visited)

    return visited
