from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Protocol

import pygame


class Movable(Protocol):
    def move(self, dx: float, dy: float) -> None:
        """Move by delta in pixels."""


@dataclass
class Piece:
    piece_id: int
    correct_row: int
    correct_col: int
    image: pygame.Surface
    x: float
    y: float

    def move(self, dx: float, dy: float) -> None:
        self.x += dx
        self.y += dy

    @property
    def width(self) -> int:
        return self.image.get_width()

    @property
    def height(self) -> int:
        return self.image.get_height()

    @property
    def rect(self) -> pygame.Rect:
        return pygame.Rect(int(self.x), int(self.y), self.width, self.height)

    @property
    def correct_id(self) -> tuple[int, int]:
        """Grid identity in (row, col), e.g. (0, 0) ... (m-1, n-1)."""
        return self.correct_row, self.correct_col


class Group:
    """Composite over pieces: group and single piece share the same move API."""

    def __init__(self, pieces: Iterable[Piece]) -> None:
        self._pieces = list(pieces)
        self.piece_ids = {piece.piece_id for piece in self._pieces}

    @property
    def pieces(self) -> tuple[Piece, ...]:
        return tuple(self._pieces)

    def move(self, dx: float, dy: float) -> None:
        for piece in self._pieces:
            piece.move(dx, dy)
