"""Swing + divergence detection sanity."""
from __future__ import annotations

from datetime import date

from orderflow_pipeline.aggregate import Bar, _stamp_session_cvd
from orderflow_pipeline.divergence import detect_divergences
from orderflow_pipeline.swings import SERIES_PRICE_HIGH, detect_swings, swings_by_series


def _bar(ts_ns: int, hi: float, lo: float, d: int) -> Bar:
    b = Bar(
        open=(hi + lo) / 2,
        high=hi,
        low=lo,
        close=(hi + lo) / 2,
        bin_start_ns=ts_ns,
        bar_end_ns=ts_ns + 60_000_000_000,
        high_first_ns=ts_ns,
        low_first_ns=ts_ns,
    )
    b.delta = d
    return b


def test_detect_swings_price_high_k1():
    k = 1
    ns = 60_000_000_000
    highs = [10.0, 12.0, 10.0, 9.0, 11.0]
    bars = [_bar(i * ns, highs[i], highs[i] - 1.0, 10) for i in range(5)]
    _stamp_session_cvd(bars)
    sd = date(2026, 1, 2)
    rows = detect_swings(bars, session_date=sd, timeframe="1m", swing_lookback=k)
    ph = swings_by_series(rows, SERIES_PRICE_HIGH)
    assert len(ph) >= 1
    assert ph[0]["swing_value"] == 12.0


def test_divergence_smoke():
    k = 1
    ns = 60_000_000_000
    bars = []
    for i in range(8):
        h = 100.0 + (0.5 * i if i < 4 else 0.3 * i)
        lo = h - 1.0
        bars.append(_bar(i * ns, h, lo, 5))
    _stamp_session_cvd(bars)
    sd = date(2026, 1, 2)
    swings = detect_swings(bars, session_date=sd, timeframe="1m", swing_lookback=k)
    divs = detect_divergences(
        bars,
        swings,
        session_date=sd,
        timeframe="1m",
        swing_lookback=k,
        min_price_delta=0.0,
        min_cvd_delta=0,
        max_swing_bar_distance=500,
    )
    assert isinstance(divs, list)
