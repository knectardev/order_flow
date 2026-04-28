"""Locked fade logic (legacy fallback)."""
from __future__ import annotations

from typing import Callable

from .config import LegacyFallbackConfig


def try_emit_fade(
    *,
    i: int,
    cfg: LegacyFallbackConfig,
    watch_ids: set[str] | None,
    close: float,
    prev_close: float,
    mean_close: float,
    sigma: float,
    last3: list[float],
    can_emit: Callable[[str, str, int], bool],
    emit: Callable[..., None],
) -> None:
    if watch_ids is not None and "fade" not in watch_ids:
        return
    stretch = 1.0 if cfg.use_regime_filter else 0.6
    if all(x > mean_close + (stretch * sigma) for x in last3) and close < prev_close:
        if can_emit("fade", "down", i):
            emit(
                "fade",
                "down",
                close,
                i,
                diagnostics={
                    "checks": {
                        "stretch": True,
                        "meanRevertTurn": True,
                        "cooldown": True,
                    },
                    "passing": 3,
                    "total": 3,
                    "alignment": None,
                    "tag": "STANDARD",
                    "strategyExtras": {"sigma": sigma, "meanClose": mean_close},
                    "diagnosticVersion": "v1",
                },
            )
    elif all(x < mean_close - (stretch * sigma) for x in last3) and close > prev_close:
        if can_emit("fade", "up", i):
            emit(
                "fade",
                "up",
                close,
                i,
                diagnostics={
                    "checks": {
                        "stretch": True,
                        "meanRevertTurn": True,
                        "cooldown": True,
                    },
                    "passing": 3,
                    "total": 3,
                    "alignment": None,
                    "tag": "STANDARD",
                    "strategyExtras": {"sigma": sigma, "meanClose": mean_close},
                    "diagnosticVersion": "v1",
                },
            )
