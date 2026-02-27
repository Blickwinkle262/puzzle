from __future__ import annotations

import pygame

from puzzle_game.application.session import GameSession, SessionState
from puzzle_game.domain.state import GameState
from puzzle_game.infra.config import LevelConfig
from puzzle_game.ui.layout import compute_fixed_board_rect


class PygameRenderer:
    def __init__(
        self,
        *,
        screen: pygame.Surface,
        level: LevelConfig,
        background_surface: pygame.Surface | None,
    ) -> None:
        self.screen = screen
        self.level = level
        self.background_surface = background_surface
        self.preview_cache: dict[int, pygame.Surface] = {}

        self.title_font = self._build_font(size=30)
        self.text_font = self._build_font(size=22)
        self.hint_font = self._build_font(size=18)

    def render(
        self,
        *,
        state: GameState,
        session: GameSession,
        selected_piece_ids: set[int] | None = None,
        preview_offset: tuple[int, int] | None = None,
    ) -> None:
        if self.background_surface is not None:
            self.screen.blit(self.background_surface, (0, 0))
        else:
            self.screen.fill((22, 24, 30))

        self._draw_board_frame(state)
        self._draw_board_grid(state)
        self._draw_pieces_with_seam_rules(
            state,
            selected_piece_ids=selected_piece_ids,
            preview_offset=preview_offset,
        )

        if self.level.ui.show_title:
            title_surface = self.title_font.render(self.level.title, True, (245, 245, 245))
            self.screen.blit(title_surface, (20, 16))

        if self.level.ui.show_description and self.level.description:
            desc_surface = self.text_font.render(self.level.description, True, (220, 220, 220))
            self.screen.blit(desc_surface, (20, 54))

        if self.level.ui.show_timer:
            timer_text = f"Time: {int(session.remaining_time):03d}s"
            timer_surface = self.title_font.render(timer_text, True, (255, 220, 130))
            timer_rect = timer_surface.get_rect(topright=(self.level.window.width - 20, 16))
            self.screen.blit(timer_surface, timer_rect)

        if self._is_grid_swap_mode():
            hint_text = "LMB select -> target swap  RMB split  R restart  ESC quit"
        else:
            hint_text = "LMB drag/swap  RMB split  R restart  ESC quit"
        hint = self.hint_font.render(hint_text, True, (186, 186, 186))
        hint_rect = hint.get_rect(bottomleft=(20, self.level.window.height - 14))
        self.screen.blit(hint, hint_rect)

        if session.state is SessionState.WON:
            self._draw_center_message("Puzzle Solved!")
        elif session.state is SessionState.LOST:
            self._draw_center_message("Time Up")

        pygame.display.flip()

    def _draw_pieces_with_seam_rules(
        self,
        state: GameState,
        *,
        selected_piece_ids: set[int] | None,
        preview_offset: tuple[int, int] | None,
    ) -> None:
        selected = selected_piece_ids or set()
        preview_dx, preview_dy = preview_offset if preview_offset is not None else (0, 0)
        has_preview = preview_offset is not None and bool(selected)

        if not has_preview:
            self.preview_cache.clear()

        for piece_id in state.draw_order:
            piece = state.pieces[piece_id]
            draw_x = int(piece.x)
            draw_y = int(piece.y)
            image = piece.image

            if has_preview and piece_id in selected:
                draw_x += preview_dx
                draw_y += preview_dy
                ghost = self.preview_cache.get(piece_id)
                if ghost is None:
                    ghost = piece.image.copy()
                    # Keep ghost visible enough while still signaling drag preview.
                    ghost.set_alpha(212)
                    self.preview_cache[piece_id] = ghost
                image = ghost

            self.screen.blit(image, (draw_x, draw_y))

        hidden_sides = self._hidden_sides_from_locked_edges(state)
        line_color = (245, 245, 245)
        line_width = 1

        for piece_id in state.draw_order:
            piece = state.pieces[piece_id]
            rect_x = int(piece.x) + (preview_dx if has_preview and piece_id in selected else 0)
            rect_y = int(piece.y) + (preview_dy if has_preview and piece_id in selected else 0)
            rect = pygame.Rect(rect_x, rect_y, piece.width, piece.height)
            hidden = hidden_sides.get(piece_id, set())

            if "top" not in hidden:
                pygame.draw.line(self.screen, line_color, (rect.left, rect.top), (rect.right, rect.top), line_width)
            if "right" not in hidden:
                pygame.draw.line(self.screen, line_color, (rect.right, rect.top), (rect.right, rect.bottom), line_width)
            if "bottom" not in hidden:
                pygame.draw.line(
                    self.screen,
                    line_color,
                    (rect.left, rect.bottom),
                    (rect.right, rect.bottom),
                    line_width,
                )
            if "left" not in hidden:
                pygame.draw.line(self.screen, line_color, (rect.left, rect.top), (rect.left, rect.bottom), line_width)

            if piece_id in selected:
                highlight_color = (76, 220, 110)
                highlight_width = 2
                if "top" not in hidden:
                    pygame.draw.line(
                        self.screen,
                        highlight_color,
                        (rect.left, rect.top),
                        (rect.right, rect.top),
                        highlight_width,
                    )
                if "right" not in hidden:
                    pygame.draw.line(
                        self.screen,
                        highlight_color,
                        (rect.right, rect.top),
                        (rect.right, rect.bottom),
                        highlight_width,
                    )
                if "bottom" not in hidden:
                    pygame.draw.line(
                        self.screen,
                        highlight_color,
                        (rect.left, rect.bottom),
                        (rect.right, rect.bottom),
                        highlight_width,
                    )
                if "left" not in hidden:
                    pygame.draw.line(
                        self.screen,
                        highlight_color,
                        (rect.left, rect.top),
                        (rect.left, rect.bottom),
                        highlight_width,
                    )

    def _hidden_sides_from_locked_edges(self, state: GameState) -> dict[int, set[str]]:
        hidden: dict[int, set[str]] = {piece_id: set() for piece_id in state.pieces}

        for edge_key in state.locked_edges:
            spec = state.expected_edges.get(edge_key)
            if spec is None:
                continue

            if spec.expected_dx > 0 and spec.expected_dy == 0:
                hidden[spec.first_id].add("right")
                hidden[spec.second_id].add("left")
            elif spec.expected_dy > 0 and spec.expected_dx == 0:
                hidden[spec.first_id].add("bottom")
                hidden[spec.second_id].add("top")

        return hidden

    def _draw_board_frame(self, state: GameState) -> None:
        if not state.pieces:
            return

        board_rect = self._fixed_board_rect(state)

        frame_rect = board_rect.inflate(20, 20)
        frame_rect.clamp_ip(self.screen.get_rect())

        panel = pygame.Surface(frame_rect.size, pygame.SRCALPHA)
        panel.fill((18, 14, 10, 75))
        self.screen.blit(panel, frame_rect.topleft)

        pygame.draw.rect(
            self.screen,
            (238, 227, 204),
            frame_rect,
            width=2,
            border_radius=10,
        )

    def _draw_board_grid(self, state: GameState) -> None:
        if not state.pieces:
            return

        board_rect = self._fixed_board_rect(state)
        sample_piece = next(iter(state.pieces.values()))
        tile_w, tile_h = sample_piece.width, sample_piece.height

        line_color = (120, 120, 120)
        for col in range(1, self.level.grid.cols):
            x = board_rect.left + col * tile_w
            pygame.draw.line(
                self.screen,
                line_color,
                (x, board_rect.top),
                (x, board_rect.bottom),
                1,
            )
        for row in range(1, self.level.grid.rows):
            y = board_rect.top + row * tile_h
            pygame.draw.line(
                self.screen,
                line_color,
                (board_rect.left, y),
                (board_rect.right, y),
                1,
            )

    def _fixed_board_rect(self, state: GameState) -> pygame.Rect:
        sample_piece = next(iter(state.pieces.values()))
        x, y, board_w, board_h = compute_fixed_board_rect(
            screen_size=(self.level.window.width, self.level.window.height),
            rows=self.level.grid.rows,
            cols=self.level.grid.cols,
            tile_size=(sample_piece.width, sample_piece.height),
        )
        return pygame.Rect(x, y, board_w, board_h)

    def _draw_center_message(self, text: str) -> None:
        overlay = pygame.Surface((self.level.window.width, self.level.window.height), pygame.SRCALPHA)
        overlay.fill((0, 0, 0, 130))
        self.screen.blit(overlay, (0, 0))

        message = self.title_font.render(text, True, (255, 255, 255))
        message_rect = message.get_rect(center=(self.level.window.width // 2, self.level.window.height // 2))
        self.screen.blit(message, message_rect)

    def _build_font(self, *, size: int) -> pygame.font.Font:
        configured = self.level.ui.font_path
        if configured and configured.exists():
            try:
                return pygame.font.Font(str(configured), size)
            except Exception:
                pass

        system_candidates = [
            "PingFang SC",
            "Hiragino Sans GB",
            "Source Han Sans SC",
            "Noto Sans CJK SC",
            "Microsoft YaHei",
            "SimHei",
            "Arial Unicode MS",
            "arial",
        ]

        for name in system_candidates:
            try:
                matched_path = pygame.font.match_font(name)
                if not matched_path:
                    continue
                return pygame.font.Font(matched_path, size)
            except Exception:
                continue

        return pygame.font.Font(None, size)

    def _is_grid_swap_mode(self) -> bool:
        mode = self.level.shuffle.mode.strip().lower()
        return mode in {"grid_shuffle", "shuffle_grid", "grid"}
