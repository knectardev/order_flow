from __future__ import annotations

from datetime import datetime, timedelta

from orderflow_pipeline.backtest_engine import (
    BacktestEngine,
    BrokerConfig,
    barrier_prices_from_ticks,
    intrabar_stop_take_hit,
)
from orderflow_pipeline.db import init_schema


def test_intrabar_long_stop_priority_when_both_hit() -> None:
    reason, px = intrabar_stop_take_hit(
        side=1,
        high=7160.0,
        low=7145.0,
        stop_px=7150.0,
        tp_px=7158.0,
    )
    assert reason == "stop_loss"
    assert px == 7150.0


def test_intrabar_short_stop_priority_when_both_hit() -> None:
    reason, px = intrabar_stop_take_hit(
        side=-1,
        high=7160.0,
        low=7145.0,
        stop_px=7158.0,
        tp_px=7150.0,
    )
    assert reason == "stop_loss"
    assert px == 7158.0


def test_barrier_prices_flip_only_when_ticks_none() -> None:
    sp, tp = barrier_prices_from_ticks(7150.25, 1, 0.25, None, None)
    assert sp is None and tp is None


def test_stop_loss_exit_reason_before_later_flip_fire() -> None:
    """Long breakout opens bar 1; bar 2 low breaches SL before opposing fire later."""
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
        (hi, "1m", "fade", "down", 7158.0, None, None),
    ]
    con.executemany(
        """
        INSERT INTO fires (bar_time, timeframe, watch_id, direction, price, outcome, outcome_resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        fire_rows,
    )

    engine = BacktestEngine(con)
    out = engine.run(
        timeframe="1m",
        from_time=t0,
        to_time=hi,
        config=BrokerConfig(stop_loss_ticks=4.0, tick_size=0.25),
        watch_ids={"breakout", "fade"},
        use_regime_filter=True,
    )

    trades = con.execute(
        "SELECT exit_reason FROM backtest_trades WHERE run_id = ? ORDER BY trade_id",
        [out["runId"]],
    ).fetchall()
    assert len(trades) >= 1
    assert trades[0][0] == "stop_loss"
