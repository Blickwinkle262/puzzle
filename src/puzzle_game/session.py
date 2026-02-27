from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, auto


class SessionState(Enum):
    RUNNING = auto()
    WON = auto()
    LOST = auto()


@dataclass
class GameSession:
    time_limit_sec: int
    remaining_time: float
    state: SessionState = SessionState.RUNNING

    @classmethod
    def new(cls, time_limit_sec: int) -> "GameSession":
        return cls(time_limit_sec=time_limit_sec, remaining_time=float(time_limit_sec))

    def update(self, delta_sec: float) -> None:
        if self.state is not SessionState.RUNNING:
            return
        self.remaining_time = max(0.0, self.remaining_time - delta_sec)
        if self.remaining_time <= 0:
            self.state = SessionState.LOST

    def mark_won(self) -> None:
        if self.state is SessionState.RUNNING:
            self.state = SessionState.WON
