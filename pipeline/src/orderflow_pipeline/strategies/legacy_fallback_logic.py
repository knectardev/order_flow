"""Locked strategy logic extracted from backtest fallback.

This module intentionally preserves the previously high-Sharpe fallback
behavior so the pipeline can persist identical `fires` rows to DuckDB and
serve as the canonical signal source for both chart and backtests.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class LegacyFallbackConfig:
    use_regime_filter: bool = True
    cooldown_bars: int = 4
    min_bars: int = 20
    lookback_bars: int = 10
    warmup_start: int = 12


def derive_fires_from_bars(
    bars: list[dict],
    *,
    watch_ids: set[str] | None = None,
    config: LegacyFallbackConfig | None = None,
) -> dict[datetime, list[dict]]:
    cfg = config or LegacyFallbackConfig()
    if len(bars) < cfg.min_bars:
        return {}

    out: dict[datetime, list[dict]] = {}
    last_idx: dict[tuple[str, str], int] = {}

    def can_emit(watch_id: str, direction: str, idx: int) -> bool:
        prev = last_idx.get((watch_id, direction))
        if prev is None:
            return True
        return (idx - prev) >= cfg.cooldown_bars

    def emit(watch_id: str, direction: str, price: float, idx: int) -> None:
        last_idx[(watch_id, direction)] = idx
        ts = bars[idx]["bar_time"]
        out.setdefault(ts, []).append(
            {
                "bar_time": ts,
                "watch_id": watch_id,
                "direction": direction,
                "price": round(float(price), 6),
            }
        )

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

        if (watch_ids is None) or ("breakout" in watch_ids):
            vol_gate = vol > (avg_vol * (1.65 if cfg.use_regime_filter else 1.0))
            if high > recent_high:
                if vol_gate and can_emit("breakout", "up", i):
                    emit("breakout", "up", high, i)
            elif low < recent_low:
                if vol_gate and can_emit("breakout", "down", i):
                    emit("breakout", "down", low, i)

        closes10 = [float(x["close"]) for x in prev10]
        mean_close = sum(closes10) / len(closes10)
        var = sum((x - mean_close) ** 2 for x in closes10) / max(1, len(closes10) - 1)
        sigma = var**0.5
        if sigma <= 0:
            continue
        last3 = [float(x["close"]) for x in bars[i - 2:i + 1]]
        prev_close = float(bars[i - 1]["close"])
        if (watch_ids is None) or ("fade" in watch_ids):
            stretch = 1.0 if cfg.use_regime_filter else 0.6
            if all(x > mean_close + (stretch * sigma) for x in last3) and close < prev_close:
                if can_emit("fade", "down", i):
                    emit("fade", "down", close, i)
            elif all(x < mean_close - (stretch * sigma) for x in last3) and close > prev_close:
                if can_emit("fade", "up", i):
                    emit("fade", "up", close, i)

        if (watch_ids is None) or ("absorptionWall" in watch_ids):
            body = abs(close - open_)
            near_mean = abs(close - recent_close_mean) <= (0.35 * max(0.25, sigma))
            vol_ok = vol > (avg_vol * (1.25 if cfg.use_regime_filter else 1.0))
            mean_ok = near_mean if cfg.use_regime_filter else True
            if vol_ok and body <= (0.40 * rng) and mean_ok:
                direction = "down" if close >= open_ else "up"
                if can_emit("absorptionWall", direction, i):
                    emit("absorptionWall", direction, close, i)

        if (watch_ids is None) or ("valueEdgeReject" in watch_ids):
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
                    emit("valueEdgeReject", "down", close, i)
            elif vol_ok and lower_reject:
                if can_emit("valueEdgeReject", "up", i):
                    emit("valueEdgeReject", "up", close, i)

    return out

