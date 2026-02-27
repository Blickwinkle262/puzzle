from __future__ import annotations

from dataclasses import dataclass
import random

import pygame


@dataclass
class Piece:
    piece_id: int
    correct_row: int
    correct_col: int
    image: pygame.Surface
    x: float
    y: float

    @property
    def width(self) -> int:
        return self.image.get_width()

    @property
    def height(self) -> int:
        return self.image.get_height()

    @property
    def rect(self) -> pygame.Rect:
        return pygame.Rect(int(self.x), int(self.y), self.width, self.height)


class PuzzleBoard:
    def __init__(
        self,
        *,
        pieces: dict[int, Piece],
        cell_to_piece_id: dict[tuple[int, int], int],
        expected_edges: dict[frozenset[int], tuple[int, int, int, int]],
        draw_order: list[int],
        snap_tolerance_px: float,
    ) -> None:
        self.pieces = pieces
        self.cell_to_piece_id = cell_to_piece_id
        self.expected_edges = expected_edges
        self.draw_order = draw_order
        self.snap_tolerance_px = float(snap_tolerance_px)
        self.locked_edges: set[frozenset[int]] = set()

    @classmethod
    def from_image(
        cls,
        *,
        image: pygame.Surface,
        rows: int,
        cols: int,
        screen_size: tuple[int, int],
        snap_tolerance_px: float,
        seed: int | None,
    ) -> "PuzzleBoard":
        screen_w, screen_h = screen_size
        image = cls._fit_image(image=image, rows=rows, cols=cols, screen_size=screen_size)

        board_w = image.get_width()
        board_h = image.get_height()
        tile_w = board_w // cols
        tile_h = board_h // rows

        pieces: dict[int, Piece] = {}
        cell_to_piece_id: dict[tuple[int, int], int] = {}
        draw_order: list[int] = []
        rng = random.Random(seed)

        piece_id = 0
        for row in range(rows):
            for col in range(cols):
                tile_rect = pygame.Rect(col * tile_w, row * tile_h, tile_w, tile_h)
                tile = image.subsurface(tile_rect).copy()

                max_x = max(32, screen_w - tile_w - 32)
                max_y = max(120, screen_h - tile_h - 32)
                x = float(rng.randint(32, max_x))
                y = float(rng.randint(96, max_y))

                piece = Piece(
                    piece_id=piece_id,
                    correct_row=row,
                    correct_col=col,
                    image=tile,
                    x=x,
                    y=y,
                )
                pieces[piece_id] = piece
                cell_to_piece_id[(row, col)] = piece_id
                draw_order.append(piece_id)
                piece_id += 1

        expected_edges = cls._build_expected_edges(
            cell_to_piece_id=cell_to_piece_id,
            tile_w=tile_w,
            tile_h=tile_h,
        )

        return cls(
            pieces=pieces,
            cell_to_piece_id=cell_to_piece_id,
            expected_edges=expected_edges,
            draw_order=draw_order,
            snap_tolerance_px=snap_tolerance_px,
        )

    @staticmethod
    def _fit_image(
        image: pygame.Surface,
        rows: int,
        cols: int,
        screen_size: tuple[int, int],
    ) -> pygame.Surface:
        screen_w, screen_h = screen_size
        max_w = int(screen_w * 0.58)
        max_h = int(screen_h * 0.75)

        src_w, src_h = image.get_width(), image.get_height()
        scale = min(max_w / src_w, max_h / src_h, 1.0)

        scaled_w = max(cols * 32, int(src_w * scale))
        scaled_h = max(rows * 32, int(src_h * scale))

        # Keep dimensions divisible by the grid shape.
        scaled_w = max(cols, (scaled_w // cols) * cols)
        scaled_h = max(rows, (scaled_h // rows) * rows)

        if scaled_w == src_w and scaled_h == src_h:
            return image
        return pygame.transform.smoothscale(image, (scaled_w, scaled_h))

    @staticmethod
    def _build_expected_edges(
        *,
        cell_to_piece_id: dict[tuple[int, int], int],
        tile_w: int,
        tile_h: int,
    ) -> dict[frozenset[int], tuple[int, int, int, int]]:
        edges: dict[frozenset[int], tuple[int, int, int, int]] = {}
        for (row, col), piece_id in cell_to_piece_id.items():
            right = cell_to_piece_id.get((row, col + 1))
            down = cell_to_piece_id.get((row + 1, col))

            if right is not None:
                edges[frozenset({piece_id, right})] = (piece_id, right, tile_w, 0)
            if down is not None:
                edges[frozenset({piece_id, down})] = (piece_id, down, 0, tile_h)
        return edges

    def piece_at(self, mouse_pos: tuple[int, int]) -> Piece | None:
        for piece_id in reversed(self.draw_order):
            piece = self.pieces[piece_id]
            if piece.rect.collidepoint(mouse_pos):
                return piece
        return None

    def bring_group_to_front(self, group: set[int]) -> None:
        if not group:
            return
        self.draw_order = [pid for pid in self.draw_order if pid not in group] + sorted(group)

    def move_group(self, group: set[int], dx: float, dy: float) -> None:
        for piece_id in group:
            piece = self.pieces[piece_id]
            piece.x += dx
            piece.y += dy

    def drop_group(self, moved_group: set[int]) -> int:
        if not moved_group:
            return 0

        candidate = self._find_best_snap_candidate(moved_group)
        linked_count = 0
        if candidate is not None:
            shift_x, shift_y, edge_key = candidate
            self.move_group(moved_group, shift_x, shift_y)
            if edge_key not in self.locked_edges:
                self.locked_edges.add(edge_key)
                linked_count += 1

        # After one snap adjustment, lock any exact-adjacent edges.
        linked_count += self._lock_aligned_edges(tolerance=0.5)
        return linked_count

    def split_piece(self, piece_id: int) -> int:
        to_remove = {edge for edge in self.locked_edges if piece_id in edge}
        if not to_remove:
            return 0
        self.locked_edges.difference_update(to_remove)
        return len(to_remove)

    def get_group(self, piece_id: int) -> set[int]:
        adjacency = self._locked_adjacency()
        stack = [piece_id]
        visited: set[int] = set()
        while stack:
            current = stack.pop()
            if current in visited:
                continue
            visited.add(current)
            stack.extend(adjacency[current] - visited)
        return visited

    def is_solved(self) -> bool:
        return len(self.locked_edges) == len(self.expected_edges)

    def draw(self, target: pygame.Surface) -> None:
        for piece_id in self.draw_order:
            piece = self.pieces[piece_id]
            target.blit(piece.image, (int(piece.x), int(piece.y)))
            pygame.draw.rect(target, (20, 20, 20), piece.rect, 1)

    def _locked_adjacency(self) -> dict[int, set[int]]:
        adjacency: dict[int, set[int]] = {piece_id: set() for piece_id in self.pieces}
        for edge in self.locked_edges:
            first, second = tuple(edge)
            adjacency[first].add(second)
            adjacency[second].add(first)
        return adjacency

    def _find_best_snap_candidate(
        self,
        moved_group: set[int],
    ) -> tuple[float, float, frozenset[int]] | None:
        best: tuple[float, float, frozenset[int], float] | None = None

        for edge_key, (first_id, second_id, rel_x, rel_y) in self.expected_edges.items():
            if edge_key in self.locked_edges:
                continue

            first_in = first_id in moved_group
            second_in = second_id in moved_group
            if first_in == second_in:
                continue

            first_piece = self.pieces[first_id]
            second_piece = self.pieces[second_id]

            if first_in:
                target_x = second_piece.x - rel_x
                target_y = second_piece.y - rel_y
                shift_x = target_x - first_piece.x
                shift_y = target_y - first_piece.y
            else:
                target_x = first_piece.x + rel_x
                target_y = first_piece.y + rel_y
                shift_x = target_x - second_piece.x
                shift_y = target_y - second_piece.y

            if abs(shift_x) > self.snap_tolerance_px or abs(shift_y) > self.snap_tolerance_px:
                continue

            score = shift_x * shift_x + shift_y * shift_y
            if best is None or score < best[3]:
                best = (shift_x, shift_y, edge_key, score)

        if best is None:
            return None
        return best[0], best[1], best[2]

    def _lock_aligned_edges(self, tolerance: float) -> int:
        added = 0
        for edge_key, (first_id, second_id, rel_x, rel_y) in self.expected_edges.items():
            if edge_key in self.locked_edges:
                continue
            first_piece = self.pieces[first_id]
            second_piece = self.pieces[second_id]
            dx = (second_piece.x - first_piece.x) - rel_x
            dy = (second_piece.y - first_piece.y) - rel_y
            if abs(dx) <= tolerance and abs(dy) <= tolerance:
                self.locked_edges.add(edge_key)
                added += 1
        return added


def build_placeholder_image(size: tuple[int, int], rows: int, cols: int) -> pygame.Surface:
    width, height = size
    surface = pygame.Surface((width, height))
    font = pygame.font.SysFont("arial", max(24, min(width, height) // 9))

    tile_w = width // cols
    tile_h = height // rows
    for row in range(rows):
        for col in range(cols):
            rect = pygame.Rect(col * tile_w, row * tile_h, tile_w, tile_h)
            color = (96 + row * 28, 120 + col * 18, 170)
            pygame.draw.rect(surface, color, rect)
            pygame.draw.rect(surface, (35, 35, 35), rect, 2)

            label = font.render(f"{row},{col}", True, (245, 245, 245))
            label_rect = label.get_rect(center=rect.center)
            surface.blit(label, label_rect)

    return surface
