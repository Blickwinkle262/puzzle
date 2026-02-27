from __future__ import annotations


def compute_fixed_board_rect(
    *,
    screen_size: tuple[int, int],
    rows: int,
    cols: int,
    tile_size: tuple[int, int],
) -> tuple[int, int, int, int]:
    tile_w, tile_h = tile_size
    board_w = tile_w * cols
    board_h = tile_h * rows

    screen_w, screen_h = screen_size
    x = (screen_w - board_w) // 2
    y = (screen_h - board_h) // 2

    min_margin_x = 20
    min_y = 96
    max_x = max(min_margin_x, screen_w - board_w - min_margin_x)
    max_y = max(min_y, screen_h - board_h - 56)
    x = max(min_margin_x, min(x, max_x))
    y = max(min_y, min(y, max_y))
    return x, y, board_w, board_h

