from __future__ import annotations

import json
from datetime import datetime, timedelta

import duckdb
import pytest

from orderflow_pipeline.backtest_defaults import merged_execution_policy_from_request_payload
from orderflow_pipeline.backtest_engine import (
    BacktestEngine,
    BrokerConfig,
    ExecutionPolicy,
    gap_blocks_next_bar_entry,
    signal_bar_allows_next_bar_entry,
)
from orderflow_pipeline.db import init_schema


def _seed_bars(con) -> tuple[datetime, datetime]:
    """Mirror ``test_backtest_db_only._seed_bars`` for isolated imports."""
    t0 = datetime(2026, 1, 26, 14, 30)
    rows = []
    px = 7150.0
    for i in range(12):
        open_ = px
        close = px + (0.5 if i % 2 == 0 else -0.25)
        high = max(open_, close) + 0.5
        low = min(open_, close) - 0.5
        bt = t0 + timedelta(minutes=i)
        rows.append(
            (
                datetime(2026, 1, 26).date(),
                bt,
                bt + timedelta(minutes=1),
                "1m",
                open_,
                high,
                low,
                close,
                200 + i,
                5,
                10,
                1,
                8,
                0.5,
                25.0,
                0.2,
                3,
                3,
                close,
                None,
                None,
                None,
            )
        )
        px = close
    con.executemany(
        """
        INSERT INTO bars (
            session_date, bar_time, bar_end_time, timeframe, open, high, low, close, volume, delta,
            trade_count, large_print_count, distinct_prices, range_pct, vpt, concentration,
            v_rank, d_rank, vwap, bias_state, parent_1h_bias, parent_15m_bias
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    return rows[0][1], rows[-1][1]


def test_execution_policy_deadlock_validate_raises() -> None:
    with pytest.raises(ValueError, match="deadlock"):
        ExecutionPolicy(
            flip_on_opposite_fire=False,
            exit_on_stop_loss=False,
            exit_on_take_profit=False,
            close_at_end_of_window=False,
        ).validate()


def test_execution_policy_ignore_same_side_false_raises() -> None:
    with pytest.raises(ValueError, match="ignore_same_side_fire_when_open=false"):
        ExecutionPolicy(ignore_same_side_fire_when_open=False).validate()


def test_merged_execution_policy_request_overlay_flip_false_requires_defaults_coherence() -> None:
    p = merged_execution_policy_from_request_payload({"flip_on_opposite_fire": False})
    p.validate()


def test_flip_disabled_logged_for_value_edge_opposing_fire() -> None:
    import duckdb

    con = duckdb.connect(":memory:")
    init_schema(con)
    lo, hi = _seed_bars(con)
    fire_rows = [
        (lo + timedelta(minutes=1), "1m", "valueEdgeReject", "up", 7151.0, None, None),
        (lo + timedelta(minutes=2), "1m", "valueEdgeReject", "down", 7152.0, None, None),
    ]
    con.executemany(
        """
        INSERT INTO fires (bar_time, timeframe, watch_id, direction, price, outcome, outcome_resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        fire_rows,
    )
    engine = BacktestEngine(con)
    pol = ExecutionPolicy(
        flip_on_opposite_fire=False,
        exit_on_stop_loss=False,
        exit_on_take_profit=False,
        close_at_end_of_window=True,
    )
    pol.validate()
    out = engine.run(
        timeframe="1m",
        from_time=lo,
        to_time=hi,
        config=BrokerConfig(),
        execution_policy=pol,
        watch_ids={"valueEdgeReject"},
        use_regime_filter=True,
    )
    skipped = con.execute(
        "SELECT reason_code FROM skipped_fires WHERE run_id = ?",
        [out["runId"]],
    ).fetchall()
    assert any(r[0] == "flip_disabled" for r in skipped)
    meta = con.execute("SELECT metadata_json FROM backtest_runs WHERE run_id = ?", [out["runId"]]).fetchone()
    meta_json = json.loads(meta[0])
    assert meta_json.get("execution_policy", {}).get("flip_on_opposite_fire") is False


def test_exit_on_stop_loss_false_skips_intrabar_stop_then_flips() -> None:
    """When honoring SL is disabled, barriers stay on Position but intrabar stop does not fire."""
    import duckdb

    con = duckdb.connect(":memory:")
    init_schema(con)
    t0 = datetime(2026, 1, 26, 14, 30)

    def row(bt: datetime, o: float, h: float, l: float, c: float):
        return (
            bt.date(),
            bt,
            bt + timedelta(minutes=1),
            "1m",
            o,
            h,
            l,
            c,
            200,
            5,
            10,
            1,
            8,
            0.5,
            25.0,
            0.2,
            3,
            3,
            c,
            None,
            None,
            None,
        )

    rows = [
        row(t0 + timedelta(minutes=0), 7150.0, 7151.0, 7149.0, 7150.5),
        row(t0 + timedelta(minutes=1), 7150.5, 7152.0, 7150.0, 7151.0),
        row(t0 + timedelta(minutes=2), 7151.0, 7152.0, 7148.0, 7149.5),
        row(t0 + timedelta(minutes=3), 7149.5, 7160.0, 7149.0, 7158.0),
    ]
    con.executemany(
        """
        INSERT INTO bars (
            session_date, bar_time, bar_end_time, timeframe, open, high, low, close, volume, delta,
            trade_count, large_print_count, distinct_prices, range_pct, vpt, concentration,
            v_rank, d_rank, vwap, bias_state, parent_1h_bias, parent_15m_bias
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )

    lo = t0 + timedelta(minutes=1)
    hi = t0 + timedelta(minutes=3)
    fire_rows = [
        (lo, "1m", "breakout", "up", 7151.0, None, None),
        (hi, "1m", "fade", "up", 7158.0, None, None),
    ]
    con.executemany(
        """
        INSERT INTO fires (bar_time, timeframe, watch_id, direction, price, outcome, outcome_resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        fire_rows,
    )

    engine = BacktestEngine(con)
    pol = ExecutionPolicy(exit_on_stop_loss=False)
    pol.validate()
    out = engine.run(
        timeframe="1m",
        from_time=t0,
        to_time=hi,
        config=BrokerConfig(stop_loss_ticks=4.0, tick_size=0.25),
        execution_policy=pol,
        watch_ids={"breakout", "fade"},
        use_regime_filter=True,
    )

    trades = con.execute(
        "SELECT exit_reason FROM backtest_trades WHERE run_id = ? ORDER BY trade_id",
        [out["runId"]],
    ).fetchall()
    assert len(trades) >= 1
    assert trades[0][0] == "flip"


def test_next_bar_open_fills_at_next_bar_open() -> None:
    t0 = datetime(2026, 1, 26, 14, 30)

    def bar(bt: datetime, o: float, c: float):
        return {
            "bar_time": bt,
            "open": o,
            "high": max(o, c) + 0.25,
            "low": min(o, c) - 0.25,
            "close": c,
        }

    bars = [
        bar(t0 + timedelta(minutes=0), 100.0, 100.5),
        bar(t0 + timedelta(minutes=1), 102.0, 102.25),
        bar(t0 + timedelta(minutes=2), 102.25, 101.0),
    ]
    bt_fire = bars[0]["bar_time"]
    fires = {
        bt_fire: [
            {
                "bar_time": bt_fire,
                "watch_id": "breakout",
                "direction": "up",
                "price": 100.5,
            }
        ]
    }
    con = duckdb.connect(":memory:")
    init_schema(con)
    eng = BacktestEngine(con)
    pol = ExecutionPolicy(entry_next_bar_open=True)
    pol.validate()
    cfg = BrokerConfig(slippage_ticks=0.0, tick_size=0.25)
    closed, _, skipped = eng._simulate(
        bars,
        fires,
        timeframe="1m",
        config=cfg,
        policy=pol,
    )
    assert not any(s["reason_code"] == "gap_guard_blocked" for s in skipped)
    assert closed
    assert closed[0]["entry_time"] == bars[1]["bar_time"]
    assert closed[0]["entry_price"] == 102.0


def test_next_bar_open_last_bar_fire_skipped() -> None:
    t0 = datetime(2026, 1, 26, 14, 30)
    bars = [
        {
            "bar_time": t0 + timedelta(minutes=i),
            "open": 100.0 + i,
            "high": 101.0 + i,
            "low": 99.0 + i,
            "close": 100.5 + i,
        }
        for i in range(2)
    ]
    bt_last = bars[-1]["bar_time"]
    fires = {
        bt_last: [
            {
                "bar_time": bt_last,
                "watch_id": "breakout",
                "direction": "up",
                "price": 101.5,
            }
        ]
    }
    con = duckdb.connect(":memory:")
    init_schema(con)
    eng = BacktestEngine(con)
    pol = ExecutionPolicy(entry_next_bar_open=True)
    pol.validate()
    cfg = BrokerConfig()
    _, _, skipped = eng._simulate(
        bars,
        fires,
        timeframe="1m",
        config=cfg,
        policy=pol,
    )
    assert any(s["reason_code"] == "entry_deferred_no_next_bar" for s in skipped)


def test_gap_guard_blocks_wide_open() -> None:
    t0 = datetime(2026, 1, 26, 14, 30)
    bars = [
        {
            "bar_time": t0,
            "open": 100.0,
            "high": 101.0,
            "low": 99.0,
            "close": 100.0,
        },
        {
            "bar_time": t0 + timedelta(minutes=1),
            "open": 110.0,
            "high": 111.0,
            "low": 109.0,
            "close": 109.5,
        },
    ]
    bt0 = bars[0]["bar_time"]
    fires = {
        bt0: [
            {"bar_time": bt0, "watch_id": "breakout", "direction": "up", "price": 100.0},
        ]
    }
    con = duckdb.connect(":memory:")
    init_schema(con)
    eng = BacktestEngine(con)
    pol = ExecutionPolicy(entry_next_bar_open=True, entry_gap_guard_max_ticks=5.0)
    pol.validate()
    cfg = BrokerConfig(tick_size=1.0, slippage_ticks=0.0)
    closed, _, skipped = eng._simulate(
        bars,
        fires,
        timeframe="1m",
        config=cfg,
        policy=pol,
    )
    assert not closed
    assert any(s["reason_code"] == "gap_guard_blocked" for s in skipped)


def test_signal_bar_allows_next_bar_requires_follow_on_bar() -> None:
    bars = [
        {"open": 1.0, "close": 1.0},
        {"open": 1.0, "close": 1.0},
    ]
    assert signal_bar_allows_next_bar_entry(
        bars,
        0,
        entry_next_bar_open=True,
        tick_size=0.25,
        gap_max_ticks=None,
    )
    assert not signal_bar_allows_next_bar_entry(
        bars,
        1,
        entry_next_bar_open=True,
        tick_size=0.25,
        gap_max_ticks=None,
    )


def test_gap_blocks_matches_guard_ticks() -> None:
    bars = [
        {"close": 100.0, "open": 100.0},
        {"open": 103.0, "close": 103.0},
    ]
    assert gap_blocks_next_bar_entry(bars, 0, tick_size=1.0, gap_max_ticks=2.0)
    assert not gap_blocks_next_bar_entry(bars, 0, tick_size=1.0, gap_max_ticks=10.0)


def test_run_metadata_includes_entry_mode() -> None:
    con = duckdb.connect(":memory:")
    init_schema(con)
    lo, hi = _seed_bars(con)
    fire_rows = [
        (lo + timedelta(minutes=1), "1m", "valueEdgeReject", "up", 7151.0, None, None),
    ]
    con.executemany(
        """
        INSERT INTO fires (bar_time, timeframe, watch_id, direction, price, outcome, outcome_resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        fire_rows,
    )
    engine = BacktestEngine(con)
    pol = ExecutionPolicy(entry_next_bar_open=True)
    pol.validate()
    out = engine.run(
        timeframe="1m",
        from_time=lo,
        to_time=hi,
        config=BrokerConfig(),
        execution_policy=pol,
        watch_ids={"valueEdgeReject"},
        use_regime_filter=True,
    )
    meta = con.execute("SELECT metadata_json FROM backtest_runs WHERE run_id = ?", [out["runId"]]).fetchone()
    meta_json = json.loads(meta[0])
    assert meta_json.get("entry_mode") == "next_bar_open"
    assert meta_json.get("entry_gap_guard_max_ticks") is None
    assert meta_json.get("execution_policy", {}).get("entry_next_bar_open") is True
