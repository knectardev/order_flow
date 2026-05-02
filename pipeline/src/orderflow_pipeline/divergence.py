"""CVD vs price divergence detection with optional size-imbalance confirmation."""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import TYPE_CHECKING

from .swings import (
    SERIES_CVD_HIGH,
    SERIES_CVD_LOW,
    SERIES_PRICE_HIGH,
    SERIES_PRICE_LOW,
    swings_by_series,
)

if TYPE_CHECKING:
    from .aggregate import Bar

UTC = timezone.utc


def _bar_time_index_map(bars: list[Bar]) -> dict[datetime, int]:
    out: dict[datetime, int] = {}
    for i, b in enumerate(bars):
        bt = datetime.fromtimestamp(b.bin_start_ns / 1e9, tz=UTC).replace(tzinfo=None)
        out[bt] = i
    return out


def _ratio_at_bar(bars: list[Bar], idx: int) -> float | None:
    return bars[idx]._size_imbalance_ratio() if 0 <= idx < len(bars) else None


def detect_divergences(
    bars: list[Bar],
    swings: list[dict],
    *,
    session_date: date,
    timeframe: str,
    swing_lookback: int,
    min_price_delta: float,
    min_cvd_delta: int,
    max_swing_bar_distance: int,
) -> list[dict]:
    """Pair swings by ordinal within each series; emit bearish/bullish divergences."""
    if not bars or not swings:
        return []

    bt_idx = _bar_time_index_map(bars)
    ph = swings_by_series(swings, SERIES_PRICE_HIGH)
    pl = swings_by_series(swings, SERIES_PRICE_LOW)
    ch = swings_by_series(swings, SERIES_CVD_HIGH)
    cl = swings_by_series(swings, SERIES_CVD_LOW)

    out: list[dict] = []

    # Bearish: higher price HH, lower CVD HH
    for n in range(1, min(len(ph), len(ch))):
        p0, p1 = ph[n - 1], ph[n]
        c0, c1 = ch[n - 1], ch[n]
        dt0: datetime = p0["bar_time"]
        dt1: datetime = p1["bar_time"]
        i0 = bt_idx.get(dt0)
        i1 = bt_idx.get(dt1)
        if i0 is None or i1 is None:
            continue
        bars_between = abs(i1 - i0)
        if bars_between > max_swing_bar_distance:
            continue
        price_delta = float(p1["swing_value"]) - float(p0["swing_value"])
        if price_delta < min_price_delta:
            continue
        cvd_delta = int(round(c0["swing_value"])) - int(round(c1["swing_value"]))
        if cvd_delta < min_cvd_delta:
            continue

        r0 = _ratio_at_bar(bars, i0)
        r1 = _ratio_at_bar(bars, i1)
        size_conf = False
        if r0 is not None and r1 is not None:
            size_conf = r1 < r0

        out.append(
            {
                "session_date": session_date,
                "timeframe": timeframe,
                "div_kind": "bearish",
                "earlier_bar_time": dt0,
                "later_bar_time": dt1,
                "earlier_price": float(p0["swing_value"]),
                "later_price": float(p1["swing_value"]),
                "earlier_cvd": int(round(c0["swing_value"])),
                "later_cvd": int(round(c1["swing_value"])),
                "bars_between": bars_between,
                "size_confirmation": size_conf,
                "swing_lookback": swing_lookback,
                "min_price_delta": min_price_delta,
                "min_cvd_delta": min_cvd_delta,
                "max_swing_bar_distance": max_swing_bar_distance,
                "earlier_size_imbalance_ratio": r0,
                "later_size_imbalance_ratio": r1,
            }
        )

    # Bullish: lower price LL, higher CVD HL
    for n in range(1, min(len(pl), len(cl))):
        p0, p1 = pl[n - 1], pl[n]
        c0, c1 = cl[n - 1], cl[n]
        dt0: datetime = p0["bar_time"]
        dt1: datetime = p1["bar_time"]
        i0 = bt_idx.get(dt0)
        i1 = bt_idx.get(dt1)
        if i0 is None or i1 is None:
            continue
        bars_between = abs(i1 - i0)
        if bars_between > max_swing_bar_distance:
            continue
        price_delta = float(p0["swing_value"]) - float(p1["swing_value"])
        if price_delta < min_price_delta:
            continue
        cvd_delta = int(round(c1["swing_value"])) - int(round(c0["swing_value"]))
        if cvd_delta < min_cvd_delta:
            continue

        r0 = _ratio_at_bar(bars, i0)
        r1 = _ratio_at_bar(bars, i1)
        size_conf = False
        if r0 is not None and r1 is not None:
            size_conf = r1 > r0

        out.append(
            {
                "session_date": session_date,
                "timeframe": timeframe,
                "div_kind": "bullish",
                "earlier_bar_time": dt0,
                "later_bar_time": dt1,
                "earlier_price": float(p0["swing_value"]),
                "later_price": float(p1["swing_value"]),
                "earlier_cvd": int(round(c0["swing_value"])),
                "later_cvd": int(round(c1["swing_value"])),
                "bars_between": bars_between,
                "size_confirmation": size_conf,
                "swing_lookback": swing_lookback,
                "min_price_delta": min_price_delta,
                "min_cvd_delta": min_cvd_delta,
                "max_swing_bar_distance": max_swing_bar_distance,
                "earlier_size_imbalance_ratio": r0,
                "later_size_imbalance_ratio": r1,
            }
        )

    return out
