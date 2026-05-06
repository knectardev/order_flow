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


def test_orb_long_first_breakout_emits_once_per_session() -> None:
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
            "high": 100.75,
            "low": 99.4,
            "close": 100.5,
            "volume": 1100.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
        {
            "bar_time": base + timedelta(minutes=10),
            "open": 100.5,
            "high": 101.5,
            "low": 100.4,
            "close": 101.0,
            "volume": 1200.0,
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
    assert long_fires[0]["price"] == 100.75


def test_orb_second_session_resets_state() -> None:
    vr, dr = _rank_ok()
    d1 = date(2026, 1, 26)
    d2 = date(2026, 1, 27)
    t1 = datetime(2026, 1, 26, 14, 35, tzinfo=timezone.utc)
    t2 = datetime(2026, 1, 27, 14, 35, tzinfo=timezone.utc)
    bars = [
        {
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
        {
            "bar_time": t1 + timedelta(minutes=5),
            "open": 50.5,
            "high": 52.0,
            "low": 50.4,
            "close": 51.5,
            "volume": 900.0,
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
            "high": 62.0,
            "low": 60.4,
            "close": 61.5,
            "volume": 900.0,
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


def test_orb_short_breakout() -> None:
    vr, dr = _rank_ok()
    d = date(2026, 2, 2)
    base = datetime(2026, 2, 2, 15, 0, tzinfo=timezone.utc)
    bars = [
        {
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
        {
            "bar_time": base + timedelta(minutes=5),
            "open": 200.0,
            "high": 200.5,
            "low": 197.0,
            "close": 197.5,
            "volume": 600.0,
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
    assert shorts[0]["price"] == 197.0


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
            "high": 12.0,
            "low": 10.4,
            "close": 11.5,
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
            "high": 12.0,
            "low": 10.4,
            "close": 11.5,
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
        {
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
        {
            "bar_time": noon_et_bar,
            "open": 5.5,
            "high": 7.0,
            "low": 5.4,
            "close": 6.5,
            "volume": 60.0,
            "session_date": d,
            "v_rank": vr,
            "d_rank": dr,
        },
    ]
    assert orb_entry_allowed_by_time(bars[1]["bar_time"]) is False
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
    base = datetime(2026, 6, 10, 14, 30)
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
    engine = BacktestEngine(con)
    out = engine.run(
        timeframe="5m",
        from_time=base,
        to_time=base + timedelta(minutes=5),
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


def test_engine_orb_relaxed_regime_filter_false_in_metadata() -> None:
    """use_regime_filter=false skips ORB rank gate; metadata records the flag."""
    sd = date(2026, 6, 11)
    base = datetime(2026, 6, 11, 14, 30)
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
    engine = BacktestEngine(con)
    out = engine.run(
        timeframe="5m",
        from_time=base,
        to_time=base + timedelta(minutes=5),
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
    """ORB fills at breakout high; tight SL would breach same bar's low; defer SL/TP to next bar."""
    vr, dr = _rank_ok()
    sd = date(2026, 7, 1)
    base = datetime(2026, 7, 1, 14, 30)
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
        high=100.5,
        low=99.0,
        open_=100.0,
        close=99.25,
        v_rank=vr,
        d_rank=dr,
    )
    engine = BacktestEngine(con)
    out = engine.run(
        timeframe="5m",
        from_time=base,
        to_time=base + timedelta(minutes=10),
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
