from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pygame

from puzzle_game.assets import AssetManager
from puzzle_game.audio import AudioManager
from puzzle_game.config import LevelConfig, load_level_config
from puzzle_game.puzzle import PuzzleBoard, build_placeholder_image
from puzzle_game.session import GameSession, SessionState


@dataclass
class RuntimeAudio:
    piece_pick: Path | None
    piece_drop: Path | None
    piece_link: Path | None
    piece_unlink: Path | None
    win: Path | None
    timeout: Path | None


class PuzzleGameApp:
    def __init__(self, *, level_config: LevelConfig, project_root: Path) -> None:
        self.level = level_config
        self.project_root = project_root

        pygame.init()
        self.screen = pygame.display.set_mode((self.level.window.width, self.level.window.height))
        pygame.display.set_caption(self.level.title)
        self.clock = pygame.time.Clock()

        self.assets = AssetManager()
        self.audio = AudioManager(self.assets)
        self.runtime_audio = RuntimeAudio(
            piece_pick=self.level.audio.get("piece_pick"),
            piece_drop=self.level.audio.get("piece_drop"),
            piece_link=self.level.audio.get("piece_link"),
            piece_unlink=self.level.audio.get("piece_unlink"),
            win=self.level.audio.get("win"),
            timeout=self.level.audio.get("timeout"),
        )
        self.audio.play_bgm(self.level.background_music)

        self.title_font = pygame.font.SysFont("arial", 30)
        self.text_font = pygame.font.SysFont("arial", 22)
        self.hint_font = pygame.font.SysFont("arial", 18)

        self.board = self._build_board()
        self.session = GameSession.new(self.level.time_limit_sec)

        self.dragging_group: set[int] | None = None
        self.last_mouse_pos: tuple[int, int] | None = None
        self.timeout_sound_played = False
        self.win_sound_played = False

    @classmethod
    def from_files(cls, *, level_path: Path, defaults_path: Path | None) -> "PuzzleGameApp":
        loaded = load_level_config(level_path=level_path, defaults_path=defaults_path)
        return cls(level_config=loaded.config, project_root=loaded.project_root)

    def _build_board(self) -> PuzzleBoard:
        try:
            image = self.assets.load_image(self.level.source_image)
        except FileNotFoundError:
            image = build_placeholder_image(
                size=(960, 720),
                rows=self.level.grid.rows,
                cols=self.level.grid.cols,
            )

        return PuzzleBoard.from_image(
            image=image,
            rows=self.level.grid.rows,
            cols=self.level.grid.cols,
            screen_size=(self.level.window.width, self.level.window.height),
            snap_tolerance_px=self.level.snap_tolerance_px,
            seed=self.level.shuffle.seed,
        )

    def run(self) -> None:
        running = True
        while running:
            delta_sec = self.clock.tick(self.level.window.fps) / 1000.0
            running = self._handle_events()
            self._update(delta_sec)
            self._render()

        self.audio.stop_bgm()
        pygame.quit()

    def _handle_events(self) -> bool:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return False

            if event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    return False
                if event.key == pygame.K_r:
                    self._restart_level()

            if self.session.state is not SessionState.RUNNING:
                continue

            if event.type == pygame.MOUSEBUTTONDOWN:
                if event.button == 1:
                    self._on_left_mouse_down(event.pos)
                elif event.button == 3:
                    self._on_right_mouse_down(event.pos)

            elif event.type == pygame.MOUSEMOTION:
                self._on_mouse_motion(event.pos)

            elif event.type == pygame.MOUSEBUTTONUP and event.button == 1:
                self._on_left_mouse_up()

        return True

    def _on_left_mouse_down(self, mouse_pos: tuple[int, int]) -> None:
        piece = self.board.piece_at(mouse_pos)
        if piece is None:
            return
        group = self.board.get_group(piece.piece_id)
        self.board.bring_group_to_front(group)
        self.dragging_group = group
        self.last_mouse_pos = mouse_pos
        self.audio.play_sfx(self.runtime_audio.piece_pick)

    def _on_right_mouse_down(self, mouse_pos: tuple[int, int]) -> None:
        piece = self.board.piece_at(mouse_pos)
        if piece is None:
            return
        removed_edges = self.board.split_piece(piece.piece_id)
        if removed_edges > 0:
            self.audio.play_sfx(self.runtime_audio.piece_unlink)

    def _on_mouse_motion(self, mouse_pos: tuple[int, int]) -> None:
        if not self.dragging_group or self.last_mouse_pos is None:
            return
        dx = mouse_pos[0] - self.last_mouse_pos[0]
        dy = mouse_pos[1] - self.last_mouse_pos[1]
        self.board.move_group(self.dragging_group, dx, dy)
        self.last_mouse_pos = mouse_pos

    def _on_left_mouse_up(self) -> None:
        if not self.dragging_group:
            return

        linked_edges = self.board.drop_group(self.dragging_group)
        self.audio.play_sfx(self.runtime_audio.piece_drop)
        if linked_edges > 0:
            self.audio.play_sfx(self.runtime_audio.piece_link)

        self.dragging_group = None
        self.last_mouse_pos = None

    def _update(self, delta_sec: float) -> None:
        self.session.update(delta_sec)

        if self.session.state is SessionState.LOST and not self.timeout_sound_played:
            self.audio.play_sfx(self.runtime_audio.timeout)
            self.timeout_sound_played = True

        if self.session.state is SessionState.RUNNING and self.board.is_solved():
            self.session.mark_won()

        if self.session.state is SessionState.WON and not self.win_sound_played:
            self.audio.play_sfx(self.runtime_audio.win)
            self.win_sound_played = True

    def _render(self) -> None:
        self.screen.fill((22, 24, 30))
        self.board.draw(self.screen)

        if self.level.ui.show_title:
            title_surface = self.title_font.render(self.level.title, True, (245, 245, 245))
            self.screen.blit(title_surface, (20, 16))

        if self.level.ui.show_description and self.level.description:
            desc_surface = self.text_font.render(self.level.description, True, (210, 210, 210))
            self.screen.blit(desc_surface, (20, 52))

        if self.level.ui.show_timer:
            timer_text = f"Time: {int(self.session.remaining_time):03d}s"
            timer_surface = self.title_font.render(timer_text, True, (255, 220, 130))
            timer_rect = timer_surface.get_rect(topright=(self.level.window.width - 20, 16))
            self.screen.blit(timer_surface, timer_rect)

        hint = self.hint_font.render("LMB drag  RMB split  R restart  ESC quit", True, (180, 180, 180))
        hint_rect = hint.get_rect(bottomleft=(20, self.level.window.height - 14))
        self.screen.blit(hint, hint_rect)

        if self.session.state is SessionState.WON:
            self._draw_center_message("Puzzle Solved!")
        elif self.session.state is SessionState.LOST:
            self._draw_center_message("Time Up")

        pygame.display.flip()

    def _draw_center_message(self, text: str) -> None:
        overlay = pygame.Surface((self.level.window.width, self.level.window.height), pygame.SRCALPHA)
        overlay.fill((0, 0, 0, 130))
        self.screen.blit(overlay, (0, 0))

        message = self.title_font.render(text, True, (255, 255, 255))
        rect = message.get_rect(
            center=(self.level.window.width // 2, self.level.window.height // 2)
        )
        self.screen.blit(message, rect)

    def _restart_level(self) -> None:
        self.board = self._build_board()
        self.session = GameSession.new(self.level.time_limit_sec)
        self.dragging_group = None
        self.last_mouse_pos = None
        self.timeout_sound_played = False
        self.win_sound_played = False
