"""Rule layer: matching and snapping strategies."""

from puzzle_game.rules.snap import (
    LenientSnapStrategy,
    MobileSnapStrategy,
    SnapRuleEngine,
    SnapStrategy,
    StrictSnapStrategy,
    build_snap_strategy,
)

__all__ = [
    "LenientSnapStrategy",
    "MobileSnapStrategy",
    "SnapRuleEngine",
    "SnapStrategy",
    "StrictSnapStrategy",
    "build_snap_strategy",
]
