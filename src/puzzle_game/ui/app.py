from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pygame

from puzzle_game.application.controller import InteractionController, SwapPlan
from puzzle_game.application.flow import GameFlow
from puzzle_game.application.session import GameSession, SessionState
from puzzle_game.infra.assets import AssetManager
from puzzle_game.infra.audio import AudioManager
from puzzle_game.infra.config import LevelConfig, load_level_config
from puzzle_game.infra.factory import PuzzleStateFactory
from puzzle_game.rules.snap import SnapRuleEngine, build_snap_strategy
from puzzle_game.ui.renderer import PygameRenderer


@dataclass
class RuntimeAudio:
    piece_pick: Path | None
    piece_drop: Path | None
    piece_link: Path | None
    piece_unlink: Path | None
    win: Path | None
    timeout: Path | None


@dataclass
class SwapAnimation:
    plan: SwapPlan
    duration_sec: float = 0.18
    elapsed_sec: float = 0.0


@dataclass
class GridDragState:
    active: bool = False
    moved: bool = False
    start_pos: tuple[int, int] | None = None
    preview_dx: int = 0
    preview_dy: int = 0
    started_with_new_selection: bool = False


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

        self.factory = PuzzleStateFactory(self.assets)
        self.snap_engine = SnapRuleEngine(
            strategy=build_snap_strategy(self.level.rules.snap_strategy),
            magnet_strength=self.level.rules.magnet_strength,
        )

        self.state = self.factory.create_state(
            level=self.level,
            screen_size=(self.level.window.width, self.level.window.height),
        )
        self.controller = InteractionController(
            state=self.state,
            snap_engine=self.snap_engine,
            grid_swap_only=self._is_grid_swap_mode(),
        )
        self.flow = GameFlow(session=GameSession.new(self.level.time_limit_sec))

        self.renderer = PygameRenderer(
            screen=self.screen,
            level=self.level,
            background_surface=self._load_background_surface(),
        )

        self.audio.play_bgm(self.level.background_music)

        self.selected_group_ids: set[int] | None = None
        self.swap_animation: SwapAnimation | None = None
        self.grid_drag = GridDragState()

    @classmethod
    def from_files(
        cls,
        *,
        level_path: Path,
        defaults_path: Path | None,
        project_root: Path | None = None,
    ) -> "PuzzleGameApp":
        loaded = load_level_config(
            level_path=level_path,
            defaults_path=defaults_path,
            project_root=project_root,
        )
        return cls(level_config=loaded.config, project_root=loaded.project_root)

    def run(self) -> None:
        running = True
        while running:
            delta_sec = self.clock.tick(self.level.window.fps) / 1000.0
            running = self._handle_events()
            self._update_swap_animation(delta_sec)
            self._play_cues(self.flow.update(state=self.state, delta_sec=delta_sec))
            self.renderer.render(
                state=self.state,
                session=self.flow.session,
                selected_piece_ids=self.selected_group_ids,
                preview_offset=self._current_preview_offset(),
            )

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

            if self.flow.session.state is not SessionState.RUNNING:
                continue

            if self.swap_animation is not None:
                continue

            cues: tuple[str, ...] = ()
            if self._is_grid_swap_mode():
                if event.type == pygame.MOUSEBUTTONDOWN:
                    if event.button == 1:
                        cues = self._on_grid_left_down(event.pos)
                    elif event.button == 3:
                        cues = self.controller.on_right_mouse_down(event.pos)
                elif event.type == pygame.MOUSEMOTION:
                    cues = self._on_grid_mouse_motion(event.pos)
                elif event.type == pygame.MOUSEBUTTONUP and event.button == 1:
                    cues = self._on_grid_left_up(event.pos)
            else:
                if event.type == pygame.MOUSEBUTTONDOWN:
                    if event.button == 1:
                        cues = self.controller.on_left_mouse_down(event.pos)
                    elif event.button == 3:
                        cues = self.controller.on_right_mouse_down(event.pos)
                elif event.type == pygame.MOUSEMOTION:
                    cues = self.controller.on_mouse_motion(event.pos)
                elif event.type == pygame.MOUSEBUTTONUP and event.button == 1:
                    cues = self.controller.on_left_mouse_up(event.pos)

            self._play_cues(cues)

        return True

    def _play_cues(self, cues: tuple[str, ...]) -> None:
        for cue in cues:
            if cue == "piece_pick":
                self.audio.play_sfx(self.runtime_audio.piece_pick)
            elif cue == "piece_drop":
                self.audio.play_sfx(self.runtime_audio.piece_drop)
            elif cue == "piece_link":
                self.audio.play_sfx(self.runtime_audio.piece_link)
            elif cue == "piece_unlink":
                self.audio.play_sfx(self.runtime_audio.piece_unlink)
            elif cue == "win":
                self.audio.play_sfx(self.runtime_audio.win)
            elif cue == "timeout":
                self.audio.play_sfx(self.runtime_audio.timeout)

    def _load_background_surface(self) -> pygame.Surface | None:
        path = self.level.background_image
        if path is None or not path.exists():
            return None

        try:
            raw = self.assets.load_image(path)
        except FileNotFoundError:
            return None

        size = (self.level.window.width, self.level.window.height)
        return pygame.transform.smoothscale(raw, size)

    def _restart_level(self) -> None:
        self.state = self.factory.create_state(
            level=self.level,
            screen_size=(self.level.window.width, self.level.window.height),
        )
        self.controller = InteractionController(
            state=self.state,
            snap_engine=self.snap_engine,
            grid_swap_only=self._is_grid_swap_mode(),
        )
        self.flow = GameFlow(session=GameSession.new(self.level.time_limit_sec))
        self.selected_group_ids = None
        self.swap_animation = None
        self.grid_drag = GridDragState()

    def _on_grid_left_down(self, mouse_pos: tuple[int, int]) -> tuple[str, ...]:
        self._refresh_grid_boundaries()
        clicked_piece_id = self.controller.piece_id_at(mouse_pos)
        if clicked_piece_id is None:
            self.selected_group_ids = None
            self.grid_drag = GridDragState()
            return ()

        clicked_group_ids = self.state.group_ids_for_piece(clicked_piece_id)

        self.state.bring_group_to_front(clicked_group_ids)

        if self.selected_group_ids is None:
            self.selected_group_ids = clicked_group_ids
            # First press can directly start dragging this newly selected group.
            self.grid_drag = GridDragState(
                active=True,
                moved=False,
                start_pos=mouse_pos,
                started_with_new_selection=True,
            )
            return ("piece_pick",)

        if clicked_group_ids == self.selected_group_ids:
            self.grid_drag = GridDragState(
                active=True,
                moved=False,
                start_pos=mouse_pos,
                started_with_new_selection=False,
            )
            return ()

        return self._start_grid_swap(target_piece_id=clicked_piece_id)

    def _on_grid_mouse_motion(self, mouse_pos: tuple[int, int]) -> tuple[str, ...]:
        if not self.grid_drag.active or self.grid_drag.start_pos is None:
            return ()

        dx = mouse_pos[0] - self.grid_drag.start_pos[0]
        dy = mouse_pos[1] - self.grid_drag.start_pos[1]
        if dx * dx + dy * dy >= 36:
            self.grid_drag.moved = True
        self.grid_drag.preview_dx = dx
        self.grid_drag.preview_dy = dy
        return ()

    def _on_grid_left_up(self, mouse_pos: tuple[int, int]) -> tuple[str, ...]:
        if not self.grid_drag.active:
            return ()

        dragged = self.grid_drag
        self.grid_drag = GridDragState()

        if self.selected_group_ids is None:
            return ()

        target_piece_id = None
        if dragged.moved:
            target_piece_id = self._target_piece_from_drag_preview(dragged)

        if target_piece_id is None:
            target_piece_id = self.controller.piece_id_at(mouse_pos, excluded_ids=set(self.selected_group_ids))

        if target_piece_id is None:
            # Keep selection on first tap; second tap can toggle off.
            if not dragged.moved and not dragged.started_with_new_selection:
                self.selected_group_ids = None
            return ()

        return self._start_grid_swap(
            target_piece_id=target_piece_id,
            first_start_offset=(dragged.preview_dx, dragged.preview_dy) if dragged.moved else None,
        )

    def _start_grid_swap(
        self,
        *,
        target_piece_id: int,
        first_start_offset: tuple[int, int] | None = None,
    ) -> tuple[str, ...]:
        if self.selected_group_ids is None:
            return ()

        self._refresh_grid_boundaries()
        first_ids = set(self.selected_group_ids)
        plan = self.controller.plan_group_swap_by_target_piece(
            first_piece_ids=first_ids,
            target_piece_id=target_piece_id,
            require_first_within_grid=True,
        )
        if plan is None:
            return ()

        if first_start_offset is not None:
            dx, dy = first_start_offset
            start_positions = dict(plan.start_positions)
            for piece_id in plan.first_piece_ids:
                piece = self.state.pieces[piece_id]
                start_positions[piece_id] = (piece.x + dx, piece.y + dy)

            plan = SwapPlan(
                first_piece_ids=plan.first_piece_ids,
                second_piece_ids=plan.second_piece_ids,
                start_positions=start_positions,
                end_positions=plan.end_positions,
            )

        self.selected_group_ids = None
        self.swap_animation = SwapAnimation(plan=plan)
        return ()

    def _refresh_grid_boundaries(self) -> None:
        if not self._is_grid_swap_mode():
            return
        self.controller.rebuild_all_locked_edges(tolerance=0.01)

    def _current_preview_offset(self) -> tuple[int, int] | None:
        if self.selected_group_ids is None:
            return None
        if not self.grid_drag.active:
            return None
        return (self.grid_drag.preview_dx, self.grid_drag.preview_dy)

    def _target_piece_from_drag_preview(self, drag_state: GridDragState) -> int | None:
        if self.selected_group_ids is None:
            return None

        group = self.state.create_group(set(self.selected_group_ids))
        anchor_x, anchor_y = min(((piece.x, piece.y) for piece in group.pieces), key=lambda p: (p[0], p[1]))
        preview_x = anchor_x + drag_state.preview_dx
        preview_y = anchor_y + drag_state.preview_dy

        candidates = [
            piece
            for piece_id, piece in self.state.pieces.items()
            if piece_id not in self.selected_group_ids
        ]
        if not candidates:
            return None

        nearest = min(
            candidates,
            key=lambda piece: (piece.x - preview_x) * (piece.x - preview_x) + (piece.y - preview_y) * (piece.y - preview_y),
        )
        return nearest.piece_id

    def _update_swap_animation(self, delta_sec: float) -> None:
        animation = self.swap_animation
        if animation is None:
            return

        animation.elapsed_sec = min(animation.duration_sec, animation.elapsed_sec + delta_sec)
        progress = animation.elapsed_sec / animation.duration_sec if animation.duration_sec > 0 else 1.0
        eased = 1.0 - (1.0 - progress) * (1.0 - progress)

        for piece_id, (start_x, start_y) in animation.plan.start_positions.items():
            end_x, end_y = animation.plan.end_positions[piece_id]
            piece = self.state.pieces[piece_id]
            piece.x = start_x + (end_x - start_x) * eased
            piece.y = start_y + (end_y - start_y) * eased

        if progress >= 1.0:
            cues = self.controller.apply_swap_plan(animation.plan)
            self.swap_animation = None
            self._play_cues(cues)

    def _is_grid_swap_mode(self) -> bool:
        mode = self.level.shuffle.mode.strip().lower()
        return mode in {"grid_shuffle", "shuffle_grid", "grid"}
