from __future__ import annotations

from dataclasses import dataclass

from puzzle_game.application.session import GameSession, SessionState
from puzzle_game.domain.state import GameState


@dataclass
class GameFlow:
    session: GameSession
    timeout_sound_played: bool = False
    win_sound_played: bool = False

    def update(self, *, state: GameState, delta_sec: float) -> tuple[str, ...]:
        cues: list[str] = []
        self.session.update(delta_sec)

        if self.session.state is SessionState.LOST and not self.timeout_sound_played:
            cues.append("timeout")
            self.timeout_sound_played = True

        if self.session.state is SessionState.RUNNING and state.is_solved():
            self.session.mark_won()

        if self.session.state is SessionState.WON and not self.win_sound_played:
            cues.append("win")
            self.win_sound_played = True

        return tuple(cues)
