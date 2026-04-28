"""Locked breakout logic (legacy fallback)."""
from __future__ import annotations

from typing import Callable

from .config import LegacyFallbackConfig


def try_emit_breakout(
    *,
    i: int,
    cfg: LegacyFallbackConfig,
    watch_ids: set[str] | None,
    avg_vol: float,
    recent_high: float,
    recent_low: float,
    high: float,
    low: float,
    vol: float,
    can_emit: Callable[[str, str, int], bool],
    emit: Callable[..., None],
) -> None:
    if watch_ids is not None and "breakout" not in watch_ids:
        return
    vol_gate = vol > (avg_vol * (1.65 if cfg.use_regime_filter else 1.0))
    if high > recent_high:
        if vol_gate and can_emit("breakout", "up", i):
            emit(
                "breakout",
                "up",
                high,
                i,
                diagnostics={
                    "checks": {
                        "rangeBreak": True,
                        "volumeGate": bool(vol_gate),
                        "cooldown": True,
                    },
                    "passing": 3,
                    "total": 3,
                    "alignment": None,
                    "tag": "STANDARD",
                    "strategyExtras": {"recentHigh": recent_high, "avgVol": avg_vol},
                    "diagnosticVersion": "v1",
                },
            )
    elif low < recent_low:
        if vol_gate and can_emit("breakout", "down", i):
            emit(
                "breakout",
                "down",
                low,
                i,
                diagnostics={
                    "checks": {
                        "rangeBreak": True,
                        "volumeGate": bool(vol_gate),
                        "cooldown": True,
                    },
                    "passing": 3,
                    "total": 3,
                    "alignment": None,
                    "tag": "STANDARD",
                    "strategyExtras": {"recentLow": recent_low, "avgVol": avg_vol},
                    "diagnosticVersion": "v1",
                },
            )
