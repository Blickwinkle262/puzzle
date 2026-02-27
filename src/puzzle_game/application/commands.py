from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from puzzle_game.domain.graph import EdgeKey
from puzzle_game.domain.models import Movable
from puzzle_game.domain.state import GameState


@dataclass(frozen=True)
class CommandResult:
    moved: bool = False
    merged_edges: int = 0
    split_edges: int = 0


class Command(Protocol):
    def execute(self) -> CommandResult:
        """Execute command and return changed counts."""


@dataclass
class MoveCommand:
    target: Movable
    dx: float
    dy: float

    def execute(self) -> CommandResult:
        if self.dx == 0 and self.dy == 0:
            return CommandResult(moved=False)
        self.target.move(self.dx, self.dy)
        return CommandResult(moved=True)


@dataclass
class MergeCommand:
    state: GameState
    edge_key: EdgeKey

    def execute(self) -> CommandResult:
        merged = 1 if self.state.lock_edge(self.edge_key) else 0
        return CommandResult(merged_edges=merged)


@dataclass
class SplitCommand:
    state: GameState
    piece_id: int

    def execute(self) -> CommandResult:
        removed = self.state.split_piece(self.piece_id)
        return CommandResult(split_edges=removed)
