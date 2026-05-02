"""Fractal swing detection on price OHLC and session CVD (per session)."""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .aggregate import Bar

UTC = timezone.utc

SERIES_PRICE_HIGH = "price_high"
SERIES_PRICE_LOW = "price_low"
SERIES_CVD_HIGH = "cvd_high"
SERIES_CVD_LOW = "cvd_low"


def _window_ok(i: int, k: int, n: int) -> bool:
    return i - k >= 0 and i + k < n


def _is_swing_high(vals: list[float], i: int, k: int) -> bool:
    v = vals[i]
    for j in range(i - k, i):
        if vals[j] > v:
            return False
    for j in range(i + 1, i + k + 1):
        if vals[j] > v:
            return False
    return True


def _is_swing_low(vals: list[float], i: int, k: int) -> bool:
    v = vals[i]
    for j in range(i - k, i):
        if vals[j] < v:
            return False
    for j in range(i + 1, i + k + 1):
        if vals[j] < v:
            return False
    return True


def detect_swings(
    bars: list[Bar],
    *,
    session_date: date,
    timeframe: str,
    swing_lookback: int,
) -> list[dict]:
    """Emit swing rows for one session's bars (chronological order)."""
    k = swing_lookback
    n = len(bars)
    if n == 0 or k < 1:
        return []

    highs = [float(b.high) for b in bars]
    lows = [float(b.low) for b in bars]
    cvds = [float(b.session_cvd) for b in bars]
    bar_times = [
        datetime.fromtimestamp(b.bin_start_ns / 1e9, tz=UTC).replace(tzinfo=None)
        for b in bars
    ]

    out: list[dict] = []
    for i in range(n):
        if not _window_ok(i, k, n):
            continue
        if _is_swing_high(highs, i, k):
            out.append(
                {
                    "session_date": session_date,
                    "bar_time": bar_times[i],
                    "timeframe": timeframe,
                    "series_type": SERIES_PRICE_HIGH,
                    "swing_value": highs[i],
                    "swing_lookback": k,
                }
            )
        if _is_swing_low(lows, i, k):
            out.append(
                {
                    "session_date": session_date,
                    "bar_time": bar_times[i],
                    "timeframe": timeframe,
                    "series_type": SERIES_PRICE_LOW,
                    "swing_value": lows[i],
                    "swing_lookback": k,
                }
            )
        if _is_swing_high(cvds, i, k):
            out.append(
                {
                    "session_date": session_date,
                    "bar_time": bar_times[i],
                    "timeframe": timeframe,
                    "series_type": SERIES_CVD_HIGH,
                    "swing_value": cvds[i],
                    "swing_lookback": k,
                }
            )
        if _is_swing_low(cvds, i, k):
            out.append(
                {
                    "session_date": session_date,
                    "bar_time": bar_times[i],
                    "timeframe": timeframe,
                    "series_type": SERIES_CVD_LOW,
                    "swing_value": cvds[i],
                    "swing_lookback": k,
                }
            )
    return out


def swings_by_series(swings: list[dict], series_type: str) -> list[dict]:
    rows = [s for s in swings if s["series_type"] == series_type]
    rows.sort(key=lambda r: r["bar_time"])
    return rows
