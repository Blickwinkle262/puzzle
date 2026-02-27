from __future__ import annotations

from pathlib import Path

from puzzle_game.assets import AssetManager


class AudioManager:
    def __init__(self, assets: AssetManager) -> None:
        self.assets = assets
        self.enabled = False
        self._init_mixer()

    def _init_mixer(self) -> None:
        try:
            import pygame

            if not pygame.mixer.get_init():
                pygame.mixer.init()
            self.enabled = True
        except Exception:
            self.enabled = False

    def play_bgm(self, music_path: Path | None) -> None:
        if not self.enabled or music_path is None or not music_path.exists():
            return
        import pygame

        pygame.mixer.music.load(str(music_path))
        pygame.mixer.music.play(-1)

    def stop_bgm(self) -> None:
        if not self.enabled:
            return
        import pygame

        pygame.mixer.music.stop()

    def play_sfx(self, sfx_path: Path | None) -> None:
        if not self.enabled or sfx_path is None:
            return
        if not sfx_path.exists():
            return
        try:
            sound = self.assets.load_sound(sfx_path)
        except FileNotFoundError:
            return
        sound.play()
