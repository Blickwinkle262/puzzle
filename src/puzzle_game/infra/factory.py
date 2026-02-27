from __future__ import annotations

import random
from dataclasses import dataclass

import pygame

from puzzle_game.domain.graph import build_expected_edges
from puzzle_game.domain.models import Piece
from puzzle_game.domain.state import GameState
from puzzle_game.infra.assets import AssetManager
from puzzle_game.infra.config import LevelConfig
from puzzle_game.ui.layout import compute_fixed_board_rect


@dataclass(frozen=True)
class SpawnZone:
    x_min: int
    x_max: int
    y_min: int
    y_max: int

    @property
    def area(self) -> int:
        return (self.x_max - self.x_min + 1) * (self.y_max - self.y_min + 1)


class PuzzleStateFactory:
    def __init__(self, assets: AssetManager) -> None:
        self.assets = assets

    def create_state(self, *, level: LevelConfig, screen_size: tuple[int, int]) -> GameState:
        image = self._load_or_placeholder(level=level)

        # Required pipeline: split source image to 2D ids -> intermediate.blit -> scale.
        tile_grid_2d, cell_to_piece_id = self._split_tiles_to_id_grid(
            image=image,
            rows=level.grid.rows,
            cols=level.grid.cols,
        )

        src_tile_w = tile_grid_2d[0][0].get_width()
        src_tile_h = tile_grid_2d[0][0].get_height()
        target_tile_w, target_tile_h = self._compute_target_tile_size(
            src_tile_w=src_tile_w,
            src_tile_h=src_tile_h,
            rows=level.grid.rows,
            cols=level.grid.cols,
            screen_size=screen_size,
        )

        pieces: dict[int, Piece] = {}
        draw_order: list[int] = []
        rng = random.Random(level.shuffle.seed)

        board_x, board_y, board_w, board_h = compute_fixed_board_rect(
            screen_size=screen_size,
            rows=level.grid.rows,
            cols=level.grid.cols,
            tile_size=(target_tile_w, target_tile_h),
        )
        board_rect = pygame.Rect(board_x, board_y, board_w, board_h)
        shuffle_mode = self._normalized_shuffle_mode(level.shuffle.mode)
        spawn_zones = self._build_scatter_spawn_zones(
            screen_size=screen_size,
            board_rect=board_rect,
            piece_size=(target_tile_w, target_tile_h),
        )
        grid_spawn_positions = self._build_grid_shuffle_positions(
            board_rect=board_rect,
            rows=level.grid.rows,
            cols=level.grid.cols,
            tile_size=(target_tile_w, target_tile_h),
            rng=rng,
        )
        grid_index = 0

        for row in range(level.grid.rows):
            for col in range(level.grid.cols):
                piece_id = cell_to_piece_id[(row, col)]
                source_tile = tile_grid_2d[row][col]

                intermediate = pygame.Surface(source_tile.get_size(), pygame.SRCALPHA)
                intermediate.blit(source_tile, (0, 0))

                if intermediate.get_size() != (target_tile_w, target_tile_h):
                    tile_image = pygame.transform.smoothscale(intermediate, (target_tile_w, target_tile_h))
                else:
                    tile_image = intermediate

                if shuffle_mode == "grid_shuffle":
                    x, y = grid_spawn_positions[grid_index]
                    grid_index += 1
                else:
                    x, y = self._random_spawn_position(
                        rng=rng,
                        spawn_zones=spawn_zones,
                        screen_size=screen_size,
                        piece_size=(target_tile_w, target_tile_h),
                    )

                pieces[piece_id] = Piece(
                    piece_id=piece_id,
                    correct_row=row,
                    correct_col=col,
                    image=tile_image,
                    x=float(x),
                    y=float(y),
                )
                draw_order.append(piece_id)

        expected_edges = build_expected_edges(
            cell_to_piece_id=cell_to_piece_id,
            tile_w=target_tile_w,
            tile_h=target_tile_h,
        )

        return GameState(
            pieces=pieces,
            draw_order=draw_order,
            expected_edges=expected_edges,
            snap_tolerance_px=float(level.snap_tolerance_px),
        )

    def _load_or_placeholder(self, *, level: LevelConfig) -> pygame.Surface:
        try:
            return self.assets.load_image(level.source_image)
        except FileNotFoundError:
            return build_placeholder_image(
                size=(960, 720),
                rows=level.grid.rows,
                cols=level.grid.cols,
            )

    @staticmethod
    def _split_tiles_to_id_grid(
        *,
        image: pygame.Surface,
        rows: int,
        cols: int,
    ) -> tuple[list[list[pygame.Surface]], dict[tuple[int, int], int]]:
        working = image
        src_w, src_h = working.get_width(), working.get_height()

        # Ensure tiny images are large enough to produce at least 1x1 tile size.
        if src_w < cols or src_h < rows:
            upscale_w = max(cols, src_w)
            upscale_h = max(rows, src_h)
            working = pygame.transform.smoothscale(working, (upscale_w, upscale_h))
            src_w, src_h = working.get_width(), working.get_height()

        usable_w = (src_w // cols) * cols
        usable_h = (src_h // rows) * rows
        if usable_w != src_w or usable_h != src_h:
            working = working.subsurface(pygame.Rect(0, 0, usable_w, usable_h)).copy()

        tile_w = usable_w // cols
        tile_h = usable_h // rows

        tile_grid: list[list[pygame.Surface]] = []
        cell_to_piece_id: dict[tuple[int, int], int] = {}

        for row in range(rows):
            row_tiles: list[pygame.Surface] = []
            for col in range(cols):
                tile_rect = pygame.Rect(col * tile_w, row * tile_h, tile_w, tile_h)
                row_tiles.append(working.subsurface(tile_rect).copy())
                cell_to_piece_id[(row, col)] = row * cols + col
            tile_grid.append(row_tiles)

        return tile_grid, cell_to_piece_id

    @staticmethod
    def _compute_target_tile_size(
        *,
        src_tile_w: int,
        src_tile_h: int,
        rows: int,
        cols: int,
        screen_size: tuple[int, int],
    ) -> tuple[int, int]:
        screen_w, screen_h = screen_size
        src_board_w = src_tile_w * cols
        src_board_h = src_tile_h * rows

        max_w = int(screen_w * 0.58)
        max_h = int(screen_h * 0.75)
        scale = min(max_w / src_board_w, max_h / src_board_h, 1.0)

        target_board_w = max(cols * 32, int(src_board_w * scale))
        target_board_h = max(rows * 32, int(src_board_h * scale))

        target_board_w = max(cols, (target_board_w // cols) * cols)
        target_board_h = max(rows, (target_board_h // rows) * rows)

        return target_board_w // cols, target_board_h // rows

    @staticmethod
    def _normalized_shuffle_mode(mode: str) -> str:
        name = mode.strip().lower()
        if name in {"grid_shuffle", "shuffle_grid", "grid"}:
            return "grid_shuffle"
        return "random_scatter"

    @staticmethod
    def _build_grid_shuffle_positions(
        *,
        board_rect: pygame.Rect,
        rows: int,
        cols: int,
        tile_size: tuple[int, int],
        rng: random.Random,
    ) -> list[tuple[int, int]]:
        tile_w, tile_h = tile_size
        ordered: list[tuple[int, int]] = []
        for row in range(rows):
            for col in range(cols):
                ordered.append((board_rect.left + col * tile_w, board_rect.top + row * tile_h))

        shuffled = ordered.copy()
        rng.shuffle(shuffled)

        # Avoid solved-at-start edge case when shuffle happens to keep identity order.
        if len(shuffled) > 1 and shuffled == ordered:
            shuffled[0], shuffled[1] = shuffled[1], shuffled[0]

        return shuffled

    @staticmethod
    def _build_scatter_spawn_zones(
        *,
        screen_size: tuple[int, int],
        board_rect: pygame.Rect,
        piece_size: tuple[int, int],
    ) -> list[SpawnZone]:
        screen_w, screen_h = screen_size
        piece_w, piece_h = piece_size

        safe_left = 16
        safe_right = max(safe_left, screen_w - piece_w - 16)
        safe_top = 96
        safe_bottom = max(safe_top, screen_h - piece_h - 56)
        gap = 12

        zones: list[SpawnZone] = []

        # Left / right side of puzzle stage.
        zones.extend(
            PuzzleStateFactory._zones_from_bounds(
                x1=safe_left,
                x2=board_rect.left - piece_w - gap,
                y1=safe_top,
                y2=safe_bottom,
            )
        )
        zones.extend(
            PuzzleStateFactory._zones_from_bounds(
                x1=board_rect.right + gap,
                x2=safe_right,
                y1=safe_top,
                y2=safe_bottom,
            )
        )

        # Top / bottom strips to increase whole-screen scatter when space allows.
        zones.extend(
            PuzzleStateFactory._zones_from_bounds(
                x1=safe_left,
                x2=safe_right,
                y1=safe_top,
                y2=board_rect.top - piece_h - gap,
            )
        )
        zones.extend(
            PuzzleStateFactory._zones_from_bounds(
                x1=safe_left,
                x2=safe_right,
                y1=board_rect.bottom + gap,
                y2=safe_bottom,
            )
        )

        return zones

    @staticmethod
    def _zones_from_bounds(*, x1: int, x2: int, y1: int, y2: int) -> list[SpawnZone]:
        if x1 > x2 or y1 > y2:
            return []
        return [SpawnZone(x_min=x1, x_max=x2, y_min=y1, y_max=y2)]

    @staticmethod
    def _random_spawn_position(
        *,
        rng: random.Random,
        spawn_zones: list[SpawnZone],
        screen_size: tuple[int, int],
        piece_size: tuple[int, int],
    ) -> tuple[int, int]:
        if spawn_zones:
            weights = [zone.area for zone in spawn_zones]
            zone = rng.choices(spawn_zones, weights=weights, k=1)[0]
            return rng.randint(zone.x_min, zone.x_max), rng.randint(zone.y_min, zone.y_max)

        # Fallback when board occupies almost all safe area.
        screen_w, screen_h = screen_size
        piece_w, piece_h = piece_size
        max_x = max(16, screen_w - piece_w - 16)
        max_y = max(96, screen_h - piece_h - 56)
        return rng.randint(16, max_x), rng.randint(96, max_y)


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
