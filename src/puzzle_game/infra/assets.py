from __future__ import annotations

from pathlib import Path

import pygame


class AssetManager:
    def __init__(self) -> None:
        self._images: dict[Path, pygame.Surface] = {}
        self._sounds: dict[Path, pygame.mixer.Sound] = {}

    def load_image(self, path: Path) -> pygame.Surface:
        if path in self._images:
            return self._images[path]
        if not path.exists():
            raise FileNotFoundError(path)
        image = pygame.image.load(str(path)).convert_alpha()
        self._images[path] = image
        return image

    def load_sound(self, path: Path) -> pygame.mixer.Sound:
        if path in self._sounds:
            return self._sounds[path]
        if not path.exists():
            raise FileNotFoundError(path)
        sound = pygame.mixer.Sound(str(path))
        self._sounds[path] = sound
        return sound
