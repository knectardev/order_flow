"""Compose locked strategy modules for pipeline backtest parity.

Orchestrates per-bar evaluation; per-watchid logic lives in sibling modules.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from .absorption_wall import try_emit_absorption_wall
from .breakout import try_emit_breakout
from .config import LegacyFallbackConfig, config_for_timeframe
from .fade import try_emit_fade
from .opening_range_breakout import try_emit_opening_range_breakout
from .value_edge_reject import try_emit_value_edge_reject

__all__ = [
    "LegacyFallbackConfig",
    "config_for_timeframe",
    "derive_fires_from_bars",
]


def derive_fires_from_bars(
    bars: list[dict],
    *,
    watch_ids: set[str] | None = None,
    config: LegacyFallbackConfig | None = None,
    timeframe: str = "1m",
    rank_gate_enabled: Optional[bool] = None,
    trade_context_gate_enabled: bool = False,
    trade_context_allowed: frozenset[str] | None = None,
) -> dict[datetime, list[dict]]:
    cfg = config or LegacyFallbackConfig()
    tf = (timeframe or "1m").strip()
    orb_rank = bool(cfg.use_regime_filter) if rank_gate_enabled is None else bool(rank_gate_enabled)
    if not bars:
        return {}

    out: dict[datetime, list[dict]] = {}
    last_idx: dict[tuple[str, str], int] = {}

    def can_emit(watch_id: str, direction: str, idx: int) -> bool:
        prev = last_idx.get((watch_id, direction))
        if prev is None:
            return True
        return (idx - prev) >= cfg.cooldown_bars

    def emit(
        watch_id: str,
        direction: str,
        price: float,
        idx: int,
        *,
        diagnostics: dict | None = None,
    ) -> None:
        last_idx[(watch_id, direction)] = idx
        ts = bars[idx]["bar_time"]
        out.setdefault(ts, []).append(
            {
                "bar_time": ts,
                "watch_id": watch_id,
                "direction": direction,
                "price": round(float(price), 6),
                "diagnostics": diagnostics,
            }
        )

    orb_state: dict = {}
    for i in range(len(bars)):
        try_emit_opening_range_breakout(
            i=i,
            timeframe=tf,
            watch_ids=watch_ids,
            bars=bars,
            emit=emit,
            orb_state=orb_state,
            rank_gate_enabled=orb_rank,
            trade_context_gate_enabled=trade_context_gate_enabled,
            trade_context_allowed=trade_context_allowed,
        )

    if len(bars) < cfg.min_bars:
        return out

    for i in range(cfg.warmup_start, len(bars)):
        b = bars[i]
        prev10 = bars[i - cfg.lookback_bars:i]
        avg_vol = sum(float(x["volume"]) for x in prev10) / len(prev10)
        recent_high = max(float(x["high"]) for x in prev10)
        recent_low = min(float(x["low"]) for x in prev10)
        recent_close_mean = sum(float(x["close"]) for x in prev10) / len(prev10)
        close = float(b["close"])
        open_ = float(b["open"])
        high = float(b["high"])
        low = float(b["low"])
        vol = float(b["volume"])
        rng = max(1e-9, high - low)

        try_emit_breakout(
            i=i,
            cfg=cfg,
            watch_ids=watch_ids,
            avg_vol=avg_vol,
            recent_high=recent_high,
            recent_low=recent_low,
            high=high,
            low=low,
            vol=vol,
            can_emit=can_emit,
            emit=emit,
        )

        closes10 = [float(x["close"]) for x in prev10]
        mean_close = sum(closes10) / len(closes10)
        var = sum((x - mean_close) ** 2 for x in closes10) / max(1, len(closes10) - 1)
        sigma = var**0.5
        if sigma <= 0:
            continue
        last3 = [float(x["close"]) for x in bars[i - 2:i + 1]]
        prev_close = float(bars[i - 1]["close"])

        try_emit_fade(
            i=i,
            cfg=cfg,
            watch_ids=watch_ids,
            close=close,
            prev_close=prev_close,
            mean_close=mean_close,
            sigma=sigma,
            last3=last3,
            can_emit=can_emit,
            emit=emit,
        )
        try_emit_absorption_wall(
            i=i,
            cfg=cfg,
            watch_ids=watch_ids,
            close=close,
            open_=open_,
            vol=vol,
            rng=rng,
            avg_vol=avg_vol,
            recent_close_mean=recent_close_mean,
            sigma=sigma,
            can_emit=can_emit,
            emit=emit,
        )
        try_emit_value_edge_reject(
            i=i,
            cfg=cfg,
            watch_ids=watch_ids,
            close=close,
            open_=open_,
            high=high,
            low=low,
            vol=vol,
            avg_vol=avg_vol,
            recent_high=recent_high,
            recent_low=recent_low,
            can_emit=can_emit,
            emit=emit,
        )

    return out
