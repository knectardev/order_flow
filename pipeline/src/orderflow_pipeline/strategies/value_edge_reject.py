"""Locked value edge rejection logic (legacy fallback)."""
from __future__ import annotations

from typing import Callable

from .config import LegacyFallbackConfig


def try_emit_value_edge_reject(
    *,
    i: int,
    cfg: LegacyFallbackConfig,
    watch_ids: set[str] | None,
    close: float,
    open_: float,
    high: float,
    low: float,
    vol: float,
    avg_vol: float,
    recent_high: float,
    recent_low: float,
    can_emit: Callable[[str, str, int], bool],
    emit: Callable[..., None],
) -> None:
    if watch_ids is not None and "valueEdgeReject" not in watch_ids:
        return
    vol_ratio = vol / avg_vol if avg_vol > 0 else 1.0
    normal_vol = 0.8 <= vol_ratio <= 1.2
    close_inside = recent_low < close < recent_high
    upper_reject = (
        high >= recent_high
        and close_inside
        and (high - close) > max(0.0, close - open_)
    )
    lower_reject = (
        low <= recent_low
        and close_inside
        and (close - low) > max(0.0, open_ - close)
    )
    vol_ok = normal_vol if cfg.use_regime_filter else True
    if vol_ok and upper_reject:
        if can_emit("valueEdgeReject", "down", i):
            emit(
                "valueEdgeReject",
                "down",
                close,
                i,
                diagnostics={
                    "checks": {
                        "failedAtEdge": True,
                        "rejectionWick": True,
                        "volumeGate": bool(vol_ok),
                        "cooldown": True,
                    },
                    "passing": 4,
                    "total": 4,
                    "alignment": None,
                    "tag": "STANDARD",
                    "strategyExtras": {"edge": "vah", "volRatio": vol_ratio},
                    "diagnosticVersion": "v1",
                },
            )
    elif vol_ok and lower_reject:
        if can_emit("valueEdgeReject", "up", i):
            emit(
                "valueEdgeReject",
                "up",
                close,
                i,
                diagnostics={
                    "checks": {
                        "failedAtEdge": True,
                        "rejectionWick": True,
                        "volumeGate": bool(vol_ok),
                        "cooldown": True,
                    },
                    "passing": 4,
                    "total": 4,
                    "alignment": None,
                    "tag": "STANDARD",
                    "strategyExtras": {"edge": "val", "volRatio": vol_ratio},
                    "diagnosticVersion": "v1",
                },
            )
