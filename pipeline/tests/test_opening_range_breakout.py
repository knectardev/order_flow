"""Tests for runtime-derived opening range breakout (`orb`) watch."""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

import duckdb

from orderflow_pipeline.backtest_engine import BacktestEngine, BrokerConfig, ExecutionPolicy
from orderflow_pipeline.db import init_schema
from orderflow_pipeline.strategies.legacy_fallback_logic import derive_fires_from_bars
from orderflow_pipeline.strategies.opening_range_breakout import (
    ORB_ALLOWED_RANK_CELLS,
    orb_entry_allowed_by_time,
)
from orderflow_pipeline.strategies.config import config_for_timeframe


def _rank_ok():
    vr, dr = next(iter(ORB_ALLOWED_RANK_CELLS))
    return int(vr), int(dr)


def test_orb_long_requires_break_then_retest_confirm() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 1, 26)
    base = datetime(2026, 1, 26, 14, 35, tzinfo=timezone.utc)
    bars = [
        {
            "bar_time": base,
            "open": 99.0,
            "high": 100.0,
            "low": 98.5,
            "close": 99.25,
            "volume": 1000.0,
            "session_date": d,
            "v_rank": 2,
            "d_rank": 2,
        },
        {
            "bar_time": base + timedelta(minutes=5),
            "open": 99.5,
            "high": 100.5,
            "low": 99.4,
            "close": 100.1,
            "volume": 1100.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
        {
            "bar_time": base + timedelta(minutes=10),
            "open": 100.1,
            "high": 100.3,
            "low": 99.2,
            "close": 99.6,
            "volume": 1200.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
        # Break above OR high (100.5) but no same-bar confirm.
        {
            "bar_time": base + timedelta(minutes=15),
            "open": 99.6,
            "high": 101.1,
            "low": 99.6,
            "close": 100.9,
            "volume": 1300.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
        # Retest-and-hold confirmation (later bar): low <= OR high and close > OR high.
        {
            "bar_time": base + timedelta(minutes=20),
            "open": 100.9,
            "high": 101.0,
            "low": 100.4,
            "close": 100.7,
            "volume": 1250.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
    ]
    fires = derive_fires_from_bars(
        bars,
        watch_ids={"orb"},
        config=config_for_timeframe("5m", use_regime_filter=True),
        timeframe="5m",
    )
    long_fires = [
        f for ts in fires.values() for f in ts if f["watch_id"] == "orb" and f["direction"] == "up"
    ]
    assert len(long_fires) == 1
    assert long_fires[0]["price"] == 100.7


def test_orb_second_session_resets_state() -> None:
    vr, dr = _rank_ok()
    d1 = date(2026, 1, 26)
    d2 = date(2026, 1, 27)
    t1 = datetime(2026, 1, 26, 14, 35, tzinfo=timezone.utc)
    t2 = datetime(2026, 1, 27, 14, 35, tzinfo=timezone.utc)
    bars = [
        {  # OR bar 1
            "bar_time": t1,
            "open": 50.0,
            "high": 51.0,
            "low": 49.5,
            "close": 50.25,
            "volume": 800.0,
            "session_date": d1,
            "v_rank": 1,
            "d_rank": 1,
        },
        {  # OR bar 2
            "bar_time": t1 + timedelta(minutes=5),
            "open": 50.5,
            "high": 51.8,
            "low": 50.4,
            "close": 51.5,
            "volume": 900.0,
            "session_date": d1,
            "v_rank": vr,
            "d_rank": dr,
        },
        {  # OR bar 3
            "bar_time": t1 + timedelta(minutes=10),
            "open": 51.5,
            "high": 52.0,
            "low": 51.3,
            "close": 51.7,
            "volume": 950.0,
            "session_date": d1,
            "v_rank": vr,
            "d_rank": dr,
        },
        {  # breakout
            "bar_time": t1 + timedelta(minutes=15),
            "open": 51.7,
            "high": 52.6,
            "low": 51.6,
            "close": 52.4,
            "volume": 1000.0,
            "session_date": d1,
            "v_rank": vr,
            "d_rank": dr,
        },
        {  # retest confirm
            "bar_time": t1 + timedelta(minutes=20),
            "open": 52.4,
            "high": 52.5,
            "low": 51.9,
            "close": 52.2,
            "volume": 980.0,
            "session_date": d1,
            "v_rank": vr,
            "d_rank": dr,
        },
        {
            "bar_time": t2,
            "open": 60.0,
            "high": 61.0,
            "low": 59.5,
            "close": 60.25,
            "volume": 800.0,
            "session_date": d2,
            "v_rank": 2,
            "d_rank": 2,
        },
        {
            "bar_time": t2 + timedelta(minutes=5),
            "open": 60.5,
            "high": 61.8,
            "low": 60.4,
            "close": 61.5,
            "volume": 900.0,
            "session_date": d2,
            "v_rank": vr,
            "d_rank": dr,
        },
        {
            "bar_time": t2 + timedelta(minutes=10),
            "open": 61.5,
            "high": 62.0,
            "low": 61.3,
            "close": 61.7,
            "volume": 950.0,
            "session_date": d2,
            "v_rank": vr,
            "d_rank": dr,
        },
        {
            "bar_time": t2 + timedelta(minutes=15),
            "open": 61.7,
            "high": 62.6,
            "low": 61.6,
            "close": 62.4,
            "volume": 1000.0,
            "session_date": d2,
            "v_rank": vr,
            "d_rank": dr,
        },
        {
            "bar_time": t2 + timedelta(minutes=20),
            "open": 62.4,
            "high": 62.5,
            "low": 61.9,
            "close": 62.2,
            "volume": 980.0,
            "session_date": d2,
            "v_rank": vr,
            "d_rank": dr,
        },
    ]
    fires = derive_fires_from_bars(
        bars,
        watch_ids={"orb"},
        config=config_for_timeframe("5m", use_regime_filter=True),
        timeframe="5m",
    )
    long_fires = [
        f for ts in fires.values() for f in ts if f["watch_id"] == "orb" and f["direction"] == "up"
    ]
    assert len(long_fires) == 2


def test_orb_short_requires_break_then_retest_confirm() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 2, 2)
    base = datetime(2026, 2, 2, 14, 30, tzinfo=timezone.utc)
    bars = [
        {  # OR bar 1
            "bar_time": base,
            "open": 200.0,
            "high": 201.0,
            "low": 198.0,
            "close": 200.5,
            "volume": 500.0,
            "session_date": d,
            "v_rank": 2,
            "d_rank": 2,
        },
        {  # OR bar 2
            "bar_time": base + timedelta(minutes=5),
            "open": 200.5,
            "high": 200.9,
            "low": 198.5,
            "close": 199.0,
            "volume": 600.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
        {  # OR bar 3
            "bar_time": base + timedelta(minutes=10),
            "open": 200.0,
            "high": 200.4,
            "low": 198.2,
            "close": 199.1,
            "volume": 600.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
        {  # breakout below OR low
            "bar_time": base + timedelta(minutes=15),
            "open": 199.1,
            "high": 199.2,
            "low": 197.0,
            "close": 197.4,
            "volume": 700.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
        {  # retest fail confirm: high >= OR low and close < OR low
            "bar_time": base + timedelta(minutes=20),
            "open": 197.4,
            "high": 198.1,
            "low": 197.2,
            "close": 197.8,
            "volume": 720.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
    ]
    fires = derive_fires_from_bars(
        bars,
        watch_ids={"orb"},
        config=config_for_timeframe("5m", use_regime_filter=True),
        timeframe="5m",
    )
    shorts = [
        f for ts in fires.values() for f in ts if f["watch_id"] == "orb" and f["direction"] == "down"
    ]
    assert len(shorts) == 1
    assert shorts[0]["price"] == 197.8


def test_orb_break_without_retest_emits_nothing() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 2, 3)
    base = datetime(2026, 2, 3, 14, 30, tzinfo=timezone.utc)
    bars = [
        {"bar_time": base, "open": 100.0, "high": 101.0, "low": 99.5, "close": 100.5, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=5), "open": 100.5, "high": 101.5, "low": 100.2, "close": 101.0, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=10), "open": 101.0, "high": 101.2, "low": 100.3, "close": 100.8, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=15), "open": 100.8, "high": 102.0, "low": 100.8, "close": 101.9, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=20), "open": 101.9, "high": 102.4, "low": 101.8, "close": 102.3, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
    ]
    fires = derive_fires_from_bars(
        bars,
        watch_ids={"orb"},
        config=config_for_timeframe("5m", use_regime_filter=True),
        timeframe="5m",
    )
    orb_ct = sum(len([f for f in batch if f["watch_id"] == "orb"]) for batch in fires.values())
    assert orb_ct == 0


def test_orb_same_bar_break_and_retest_does_not_confirm() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 2, 4)
    base = datetime(2026, 2, 4, 14, 30, tzinfo=timezone.utc)
    bars = [
        {"bar_time": base, "open": 100.0, "high": 101.0, "low": 99.5, "close": 100.5, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=5), "open": 100.5, "high": 101.5, "low": 100.2, "close": 101.0, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=10), "open": 101.0, "high": 101.2, "low": 100.3, "close": 100.8, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # Break + retest + close above all in one bar; must not emit.
        {"bar_time": base + timedelta(minutes=15), "open": 100.8, "high": 102.0, "low": 101.4, "close": 101.6, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # Later real retest confirm should emit exactly once.
        {"bar_time": base + timedelta(minutes=20), "open": 101.6, "high": 101.8, "low": 101.4, "close": 101.7, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
    ]
    fires = derive_fires_from_bars(
        bars,
        watch_ids={"orb"},
        config=config_for_timeframe("5m", use_regime_filter=True),
        timeframe="5m",
    )
    longs = [f for ts in fires.values() for f in ts if f["watch_id"] == "orb" and f["direction"] == "up"]
    assert len(longs) == 1
    assert longs[0]["bar_time"] == base + timedelta(minutes=20)


def test_orb_single_direction_per_session_lock() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 2, 5)
    base = datetime(2026, 2, 5, 14, 30, tzinfo=timezone.utc)
    bars = [
        {"bar_time": base, "open": 100.0, "high": 101.0, "low": 99.5, "close": 100.5, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=5), "open": 100.5, "high": 101.5, "low": 100.2, "close": 101.0, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=10), "open": 101.0, "high": 101.2, "low": 100.3, "close": 100.8, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=15), "open": 100.8, "high": 102.0, "low": 100.8, "close": 101.9, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=20), "open": 101.9, "high": 102.0, "low": 101.4, "close": 101.7, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # Opposite-direction setup appears later, but session lock should prevent short emit.
        {"bar_time": base + timedelta(minutes=25), "open": 101.7, "high": 101.8, "low": 99.0, "close": 99.2, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=30), "open": 99.2, "high": 99.6, "low": 99.1, "close": 99.3, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
    ]
    fires = derive_fires_from_bars(
        bars,
        watch_ids={"orb"},
        config=config_for_timeframe("5m", use_regime_filter=True),
        timeframe="5m",
    )
    longs = [f for ts in fires.values() for f in ts if f["watch_id"] == "orb" and f["direction"] == "up"]
    shorts = [f for ts in fires.values() for f in ts if f["watch_id"] == "orb" and f["direction"] == "down"]
    assert len(longs) == 1
    assert len(shorts) == 0


def test_orb_retest_timeout_expires_setup() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 2, 6)
    base = datetime(2026, 2, 6, 14, 30, tzinfo=timezone.utc)
    bars = [
        {"bar_time": base, "open": 100.0, "high": 101.0, "low": 99.5, "close": 100.4, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=5), "open": 100.4, "high": 101.4, "low": 100.2, "close": 101.0, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=10), "open": 101.0, "high": 101.3, "low": 100.3, "close": 100.8, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=15), "open": 100.8, "high": 102.0, "low": 100.8, "close": 101.9, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # Seven bars after break without retest confirmation -> setup expires (retest_max_bars=6).
        {"bar_time": base + timedelta(minutes=20), "open": 101.9, "high": 102.1, "low": 101.8, "close": 102.0, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=25), "open": 102.0, "high": 102.2, "low": 101.9, "close": 102.1, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=30), "open": 102.1, "high": 102.3, "low": 102.0, "close": 102.2, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=35), "open": 102.2, "high": 102.4, "low": 102.1, "close": 102.3, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=40), "open": 102.3, "high": 102.5, "low": 102.2, "close": 102.4, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=45), "open": 102.4, "high": 102.6, "low": 102.3, "close": 102.5, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=50), "open": 102.5, "high": 102.7, "low": 102.4, "close": 102.6, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # Stay capped below OR high so clearing the stale break cannot immediately re-arm long_break_idx.
        {"bar_time": base + timedelta(minutes=55), "open": 101.8, "high": 101.35, "low": 101.05, "close": 101.15, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
    ]
    fires = derive_fires_from_bars(
        bars, watch_ids={"orb"}, config=config_for_timeframe("5m", use_regime_filter=True), timeframe="5m"
    )
    orb_ct = sum(len([f for f in batch if f["watch_id"] == "orb"]) for batch in fires.values())
    assert orb_ct == 0


def test_orb_opposite_side_breach_invalidates_pending_long() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 2, 9)
    base = datetime(2026, 2, 9, 14, 30, tzinfo=timezone.utc)
    bars = [
        {"bar_time": base, "open": 100.0, "high": 101.0, "low": 99.5, "close": 100.4, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=5), "open": 100.4, "high": 101.4, "low": 100.2, "close": 101.0, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=10), "open": 101.0, "high": 101.3, "low": 100.3, "close": 100.8, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=15), "open": 100.8, "high": 102.0, "low": 100.8, "close": 101.9, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # Breach below OR low invalidates pending long.
        {"bar_time": base + timedelta(minutes=20), "open": 101.9, "high": 102.0, "low": 99.0, "close": 99.4, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # Later retest at OR high should not use stale long-break state.
        {"bar_time": base + timedelta(minutes=25), "open": 99.4, "high": 101.3, "low": 101.2, "close": 101.25, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
    ]
    fires = derive_fires_from_bars(
        bars, watch_ids={"orb"}, config=config_for_timeframe("5m", use_regime_filter=True), timeframe="5m"
    )
    longs = [f for ts in fires.values() for f in ts if f["watch_id"] == "orb" and f["direction"] == "up"]
    assert len(longs) == 0


def test_orb_reclaim_tolerance_allows_near_level_close() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 2, 10)
    base = datetime(2026, 2, 10, 14, 30, tzinfo=timezone.utc)
    bars = [
        {"bar_time": base, "open": 100.0, "high": 101.0, "low": 99.5, "close": 100.4, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=5), "open": 100.4, "high": 101.5, "low": 100.2, "close": 101.0, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=10), "open": 101.0, "high": 101.3, "low": 100.3, "close": 100.8, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # Break above OR high.
        {"bar_time": base + timedelta(minutes=15), "open": 100.8, "high": 102.0, "low": 100.8, "close": 101.9, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # Close is 1 tick below OR high; tolerance should still confirm.
        {"bar_time": base + timedelta(minutes=20), "open": 101.9, "high": 102.0, "low": 101.3, "close": 101.25, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
    ]
    fires = derive_fires_from_bars(
        bars, watch_ids={"orb"}, config=config_for_timeframe("5m", use_regime_filter=True), timeframe="5m"
    )
    longs = [f for ts in fires.values() for f in ts if f["watch_id"] == "orb" and f["direction"] == "up"]
    assert len(longs) == 1
    assert longs[0]["price"] == 101.25


def test_orb_confirmation_after_1145_et_is_blocked() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 2, 12)
    # 14:30 UTC = 9:30 ET (EST)
    base = datetime(2026, 2, 12, 14, 30, tzinfo=timezone.utc)
    bars = [
        {"bar_time": base, "open": 100.0, "high": 101.0, "low": 99.5, "close": 100.4, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=5), "open": 100.4, "high": 101.5, "low": 100.2, "close": 101.0, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        {"bar_time": base + timedelta(minutes=10), "open": 101.0, "high": 101.2, "low": 100.3, "close": 100.8, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # breakout around 10:00 ET
        {"bar_time": base + timedelta(minutes=30), "open": 100.8, "high": 101.9, "low": 100.8, "close": 101.7, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # confirmation candidate at 11:50 ET should be blocked.
        {"bar_time": base + timedelta(minutes=140), "open": 101.7, "high": 101.8, "low": 101.2, "close": 101.35, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
    ]
    fires = derive_fires_from_bars(
        bars, watch_ids={"orb"}, config=config_for_timeframe("5m", use_regime_filter=True), timeframe="5m"
    )
    orb_ct = sum(len([f for f in batch if f["watch_id"] == "orb"]) for batch in fires.values())
    assert orb_ct == 0


def test_orb_rank_gate_can_pass_on_break_bar() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 2, 13)
    base = datetime(2026, 2, 13, 14, 30, tzinfo=timezone.utc)
    bars = [
        {"bar_time": base, "open": 100.0, "high": 101.0, "low": 99.5, "close": 100.4, "volume": 100.0, "session_date": d, "v_rank": 2, "d_rank": 2},
        {"bar_time": base + timedelta(minutes=5), "open": 100.4, "high": 101.5, "low": 100.2, "close": 101.0, "volume": 100.0, "session_date": d, "v_rank": 2, "d_rank": 2},
        {"bar_time": base + timedelta(minutes=10), "open": 101.0, "high": 101.2, "low": 100.3, "close": 100.8, "volume": 100.0, "session_date": d, "v_rank": 2, "d_rank": 2},
        # breakout with allowed rank
        {"bar_time": base + timedelta(minutes=15), "open": 100.8, "high": 102.0, "low": 100.8, "close": 101.8, "volume": 100.0, "session_date": d, "v_rank": vr, "d_rank": dr},
        # confirmation has disallowed rank but should still pass due to breakout-bar rank
        {"bar_time": base + timedelta(minutes=20), "open": 101.8, "high": 101.9, "low": 101.3, "close": 101.35, "volume": 100.0, "session_date": d, "v_rank": 1, "d_rank": 1},
    ]
    fires = derive_fires_from_bars(
        bars, watch_ids={"orb"}, config=config_for_timeframe("5m", use_regime_filter=True), timeframe="5m"
    )
    longs = [f for ts in fires.values() for f in ts if f["watch_id"] == "orb" and f["direction"] == "up"]
    assert len(longs) == 1


def test_orb_skips_when_rank_gate_fails() -> None:
    d = date(2026, 3, 1)
    base = datetime(2026, 3, 1, 14, 35, tzinfo=timezone.utc)
    bars = [
        {
            "bar_time": base,
            "open": 10.0,
            "high": 11.0,
            "low": 9.5,
            "close": 10.25,
            "volume": 100.0,
            "session_date": d,
            "v_rank": 2,
            "d_rank": 2,
        },
        {
            "bar_time": base + timedelta(minutes=5),
            "open": 10.5,
            "high": 10.8,
            "low": 10.4,
            "close": 10.6,
            "volume": 110.0,
            "session_date": d,
            "v_rank": 1,
            "d_rank": 1,
        },
        {
            "bar_time": base + timedelta(minutes=10),
            "open": 10.6,
            "high": 11.0,
            "low": 10.5,
            "close": 10.7,
            "volume": 110.0,
            "session_date": d,
            "v_rank": 1,
            "d_rank": 1,
        },
        # break
        {
            "bar_time": base + timedelta(minutes=15),
            "open": 10.7,
            "high": 12.0,
            "low": 10.7,
            "close": 11.6,
            "volume": 110.0,
            "session_date": d,
            "v_rank": 1,
            "d_rank": 1,
        },
        # retest confirm, but gate fails
        {
            "bar_time": base + timedelta(minutes=20),
            "open": 11.6,
            "high": 11.8,
            "low": 10.9,
            "close": 11.1,
            "volume": 110.0,
            "session_date": d,
            "v_rank": 1,
            "d_rank": 1,
        },
    ]
    fires = derive_fires_from_bars(
        bars,
        watch_ids={"orb"},
        config=config_for_timeframe("5m", use_regime_filter=True),
        timeframe="5m",
    )
    orb_ct = sum(len([f for f in batch if f["watch_id"] == "orb"]) for batch in fires.values())
    assert orb_ct == 0


def test_orb_emits_when_rank_gate_skipped_regime_filter_off() -> None:
    """Same bars as test_orb_skips_when_rank_gate_fails; OFF skips (v_rank,d_rank) gate."""
    d = date(2026, 3, 1)
    base = datetime(2026, 3, 1, 14, 35, tzinfo=timezone.utc)
    bars = [
        {
            "bar_time": base,
            "open": 10.0,
            "high": 11.0,
            "low": 9.5,
            "close": 10.25,
            "volume": 100.0,
            "session_date": d,
            "v_rank": 2,
            "d_rank": 2,
        },
        {
            "bar_time": base + timedelta(minutes=5),
            "open": 10.5,
            "high": 10.8,
            "low": 10.4,
            "close": 10.6,
            "volume": 110.0,
            "session_date": d,
            "v_rank": 1,
            "d_rank": 1,
        },
        {
            "bar_time": base + timedelta(minutes=10),
            "open": 10.6,
            "high": 11.0,
            "low": 10.5,
            "close": 10.7,
            "volume": 110.0,
            "session_date": d,
            "v_rank": 1,
            "d_rank": 1,
        },
        {
            "bar_time": base + timedelta(minutes=15),
            "open": 10.7,
            "high": 12.0,
            "low": 10.7,
            "close": 11.6,
            "volume": 110.0,
            "session_date": d,
            "v_rank": 1,
            "d_rank": 1,
        },
        {
            "bar_time": base + timedelta(minutes=20),
            "open": 11.6,
            "high": 11.8,
            "low": 10.9,
            "close": 11.1,
            "volume": 110.0,
            "session_date": d,
            "v_rank": 1,
            "d_rank": 1,
        },
    ]
    fires = derive_fires_from_bars(
        bars,
        watch_ids={"orb"},
        config=config_for_timeframe("5m", use_regime_filter=False),
        timeframe="5m",
    )
    orb_ct = sum(len([f for f in batch if f["watch_id"] == "orb"]) for batch in fires.values())
    assert orb_ct >= 1


def test_orb_no_signals_after_noon_et() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 3, 4)
    # 17:00 UTC on 2026-03-04 is 12:00 Eastern (standard); gate rejects hour >= 12.
    noon_et_bar = datetime(2026, 3, 4, 17, 0, tzinfo=timezone.utc)
    bars = [
        {  # OR bar 1
            "bar_time": noon_et_bar - timedelta(minutes=10),
            "open": 5.0,
            "high": 6.0,
            "low": 4.5,
            "close": 5.25,
            "volume": 50.0,
            "session_date": d,
            "v_rank": 2,
            "d_rank": 2,
        },
        {  # OR bar 2
            "bar_time": noon_et_bar - timedelta(minutes=5),
            "open": 5.2,
            "high": 6.2,
            "low": 5.0,
            "close": 5.8,
            "volume": 55.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
        {  # OR bar 3
            "bar_time": noon_et_bar,
            "open": 5.5,
            "high": 6.4,
            "low": 5.4,
            "close": 6.1,
            "volume": 60.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
        # 12:05 ET breakout candidate should still be blocked by noon cutoff.
        {
            "bar_time": noon_et_bar + timedelta(minutes=5),
            "open": 6.1,
            "high": 7.0,
            "low": 6.0,
            "close": 6.8,
            "volume": 70.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
    ]
    assert orb_entry_allowed_by_time(bars[2]["bar_time"]) is False
    fires = derive_fires_from_bars(
        bars,
        watch_ids={"orb"},
        config=config_for_timeframe("5m", use_regime_filter=True),
        timeframe="5m",
    )
    orb_ct = sum(len([f for f in batch if f["watch_id"] == "orb"]) for batch in fires.values())
    assert orb_ct == 0


def test_orb_disabled_when_timeframe_not_5m() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 4, 1)
    base = datetime(2026, 4, 1, 14, 35, tzinfo=timezone.utc)
    bars = [
        {
            "bar_time": base,
            "open": 1.0,
            "high": 2.0,
            "low": 0.5,
            "close": 1.25,
            "volume": 10.0,
            "session_date": d,
            "v_rank": 2,
            "d_rank": 2,
        },
        {
            "bar_time": base + timedelta(minutes=1),
            "open": 1.5,
            "high": 3.0,
            "low": 1.4,
            "close": 2.5,
            "volume": 11.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
    ]
    fires = derive_fires_from_bars(
        bars,
        watch_ids={"orb"},
        config=config_for_timeframe("1m", use_regime_filter=True),
        timeframe="1m",
    )
    orb_ct = sum(len([f for f in batch if f["watch_id"] == "orb"]) for batch in fires.values())
    assert orb_ct == 0


def _insert_5m_bar_row(
    con,
    *,
    session_date: date,
    bar_time: datetime,
    high: float,
    low: float,
    open_: float,
    close: float,
    v_rank: int,
    d_rank: int,
) -> None:
    end_t = bar_time + timedelta(minutes=5)
    con.execute(
        """
        INSERT INTO bars (
            session_date, bar_time, bar_end_time, timeframe, open, high, low, close, volume, delta,
            trade_count, large_print_count, distinct_prices, range_pct, vpt, concentration,
            v_rank, d_rank, vwap, bias_state, parent_1h_bias, parent_15m_bias
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            session_date,
            bar_time,
            end_t,
            "5m",
            open_,
            high,
            low,
            close,
            500.0,
            0,
            0,
            0,
            2,
            0.1,
            0.0,
            0.1,
            v_rank,
            d_rank,
            close,
            None,
            None,
            None,
        ],
    )


def test_engine_orb_derived_runtime_signal_source() -> None:
    vr, dr = _rank_ok()
    sd = date(2026, 6, 10)
    base = datetime(2026, 6, 10, 13, 30)
    con = duckdb.connect(":memory:")
    init_schema(con)
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base,
        high=100.0,
        low=99.0,
        open_=99.5,
        close=99.75,
        v_rank=2,
        d_rank=2,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=5),
        high=101.0,
        low=99.9,
        open_=100.0,
        close=100.5,
        v_rank=vr,
        d_rank=dr,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=10),
        high=100.9,
        low=99.8,
        open_=100.4,
        close=100.2,
        v_rank=vr,
        d_rank=dr,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=15),
        high=101.4,
        low=100.2,
        open_=100.2,
        close=101.2,
        v_rank=vr,
        d_rank=dr,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=20),
        high=101.3,
        low=100.9,
        open_=101.2,
        close=101.1,
        v_rank=vr,
        d_rank=dr,
    )
    engine = BacktestEngine(con)
    out = engine.run(
        timeframe="5m",
        from_time=base,
        to_time=base + timedelta(minutes=20),
        config=BrokerConfig(),
        watch_ids={"orb"},
        use_regime_filter=True,
    )
    assert out["signalSource"] == "derived_runtime"
    meta_row = con.execute(
        "SELECT metadata_json FROM backtest_runs WHERE run_id = ?", [out["runId"]]
    ).fetchone()
    meta = json.loads(meta_row[0])
    assert meta["fire_source"] == "derived_runtime"


def test_engine_orb_zero_derived_fires_completes_without_error() -> None:
    """Afternoon-only slice never finalizes OR for that session → empty derived fires; run still persists."""
    vr, dr = _rank_ok()
    sd = date(2026, 6, 12)
    # 17:00 UTC ≈ 13:00 America/New_York (June): OR window already passed; first bars skip finalize path.
    base = datetime(2026, 6, 12, 17, 0)
    con = duckdb.connect(":memory:")
    init_schema(con)
    for i in range(4):
        t = base + timedelta(minutes=5 * i)
        _insert_5m_bar_row(
            con,
            session_date=sd,
            bar_time=t,
            high=101.0,
            low=99.0,
            open_=100.0,
            close=100.25,
            v_rank=vr,
            d_rank=dr,
        )
    engine = BacktestEngine(con)
    out = engine.run(
        timeframe="5m",
        from_time=base,
        to_time=base + timedelta(minutes=15),
        config=BrokerConfig(),
        watch_ids={"orb"},
        use_regime_filter=True,
    )
    assert out["tradeCount"] == 0
    assert out["signalSource"] == "derived_runtime"


def test_engine_orb_relaxed_regime_filter_false_in_metadata() -> None:
    """use_regime_filter=false skips ORB rank gate; metadata records the flag."""
    sd = date(2026, 6, 11)
    base = datetime(2026, 6, 11, 13, 30)
    con = duckdb.connect(":memory:")
    init_schema(con)
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base,
        high=100.0,
        low=99.0,
        open_=99.5,
        close=99.75,
        v_rank=2,
        d_rank=2,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=5),
        high=101.0,
        low=99.9,
        open_=100.0,
        close=100.5,
        v_rank=1,
        d_rank=1,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=10),
        high=100.9,
        low=99.8,
        open_=100.4,
        close=100.2,
        v_rank=1,
        d_rank=1,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=15),
        high=101.4,
        low=100.2,
        open_=100.2,
        close=101.2,
        v_rank=1,
        d_rank=1,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=20),
        high=101.3,
        low=100.9,
        open_=101.2,
        close=101.1,
        v_rank=1,
        d_rank=1,
    )
    engine = BacktestEngine(con)
    out = engine.run(
        timeframe="5m",
        from_time=base,
        to_time=base + timedelta(minutes=20),
        config=BrokerConfig(),
        watch_ids={"orb"},
        use_regime_filter=False,
    )
    assert out["signalSource"] == "derived_runtime"
    meta_row = con.execute(
        "SELECT metadata_json FROM backtest_runs WHERE run_id = ?", [out["runId"]]
    ).fetchone()
    meta = json.loads(meta_row[0])
    assert meta["fire_source"] == "derived_runtime"
    assert meta["use_regime_filter"] is False


def test_orb_mechanical_sl_tp_not_evaluated_on_entry_bar() -> None:
    """ORB confirms at bar close; tight SL should not trigger on the entry bar."""
    vr, dr = _rank_ok()
    sd = date(2026, 7, 1)
    base = datetime(2026, 7, 1, 13, 30)
    con = duckdb.connect(":memory:")
    init_schema(con)
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base,
        high=100.0,
        low=99.0,
        open_=99.5,
        close=99.75,
        v_rank=2,
        d_rank=2,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=5),
        high=101.0,
        low=99.0,
        open_=100.0,
        close=100.5,
        v_rank=vr,
        d_rank=dr,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=10),
        high=100.8,
        low=99.2,
        open_=100.2,
        close=100.1,
        v_rank=vr,
        d_rank=dr,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=15),
        high=101.5,
        low=100.1,
        open_=100.1,
        close=101.3,
        v_rank=vr,
        d_rank=dr,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=20),
        high=101.4,
        low=100.9,
        open_=101.3,
        close=101.2,
        v_rank=vr,
        d_rank=dr,
    )
    _insert_5m_bar_row(
        con,
        session_date=sd,
        bar_time=base + timedelta(minutes=25),
        high=100.5,
        low=99.0,
        open_=101.2,
        close=99.25,
        v_rank=vr,
        d_rank=dr,
    )
    engine = BacktestEngine(con)
    out = engine.run(
        timeframe="5m",
        from_time=base,
        to_time=base + timedelta(minutes=25),
        config=BrokerConfig(stop_loss_ticks=4.0, take_profit_ticks=500.0),
        watch_ids={"orb"},
        use_regime_filter=True,
        execution_policy=ExecutionPolicy(close_at_end_of_window=False),
    )
    rows = con.execute(
        """
        SELECT watch_id, exit_reason, bars_held, entry_time, exit_time
        FROM backtest_trades WHERE run_id = ? ORDER BY trade_id
        """,
        [out["runId"]],
    ).fetchall()
    assert len(rows) == 1
    wid, reason, bars_held, ent, ext = rows[0]
    assert wid == "orb"
    assert reason == "stop_loss"
    # `bars_held` is max(1, exit_bar_index - entry_bar_index), so adjacent bars => 1.
    assert int(bars_held) == 1
    assert ent != ext, "ORB defers mechanical SL on the entry bar; stop should hit a later bar"


def test_engine_orb_rejects_non_5m_timeframe() -> None:
    con = duckdb.connect(":memory:")
    init_schema(con)
    engine = BacktestEngine(con)
    base = datetime(2026, 6, 11, 14, 30)
    try:
        engine.run(
            timeframe="1m",
            from_time=base,
            to_time=base,
            config=BrokerConfig(),
            watch_ids={"orb"},
            use_regime_filter=True,
        )
    except ValueError as exc:
        assert "5m" in str(exc)
    else:
        raise AssertionError("expected ValueError for orb with wrong timeframe")
