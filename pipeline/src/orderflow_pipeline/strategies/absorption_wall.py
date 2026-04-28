"""Locked absorption wall logic (legacy fallback)."""
from __future__ import annotations

from typing import Callable

from .config import LegacyFallbackConfig


def try_emit_absorption_wall(
    *,
    i: int,
    cfg: LegacyFallbackConfig,
    watch_ids: set[str] | None,
    close: float,
    open_: float,
    vol: float,
    rng: float,
    avg_vol: float,
    recent_close_mean: float,
    sigma: float,
    can_emit: Callable[[str, str, int], bool],
    emit: Callable[..., None],
) -> None:
    if watch_ids is not None and "absorptionWall" not in watch_ids:
        return
    body = abs(close - open_)
    near_mean = abs(close - recent_close_mean) <= (0.35 * max(0.25, sigma))
    vol_ok = vol > (avg_vol * (1.25 if cfg.use_regime_filter else 1.0))
    mean_ok = near_mean if cfg.use_regime_filter else True
    if vol_ok and body <= (0.40 * rng) and mean_ok:
        direction = "down" if close >= open_ else "up"
        if can_emit("absorptionWall", direction, i):
            emit(
                "absorptionWall",
                direction,
                close,
                i,
                diagnostics={
                    "checks": {
                        "volumeGate": bool(vol_ok),
                        "stallBody": bool(body <= (0.40 * rng)),
                        "meanGate": bool(mean_ok),
                        "cooldown": True,
                    },
                    "passing": 4,
                    "total": 4,
                    "alignment": None,
                    "tag": "STANDARD",
                    "strategyExtras": {"range": rng, "body": body},
                    "diagnosticVersion": "v1",
                },
            )
