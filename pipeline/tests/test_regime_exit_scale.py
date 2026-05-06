"""Tests for regime-scaled exit ticks and engine integration."""
from __future__ import annotations

import math
from datetime import datetime, timedelta

import duckdb
import pytest

from orderflow_pipeline.backtest_engine import BacktestEngine, BrokerConfig, ExecutionPolicy
from orderflow_pipeline.db import init_schema
from dataclasses import replace

from orderflow_pipeline.strategies.regime_exit_scale import (
    RegimeExitScaleParams,
    apply_regime_exit_scale,
)


def _params(**kwargs: object) -> RegimeExitScaleParams:
    return replace(RegimeExitScaleParams(), **kwargs)


def test_apply_garbage_range_pct_falls_back_to_template() -> None:
    p = _params(regime_exit_scale_enabled=True)
    bar = {"range_pct": float("nan"), "v_rank": None}
    sl, tp = apply_regime_exit_scale(
        8.0, 16.0, bar, p, broker_stop_loss_ticks=None, broker_take_profit_ticks=None
    )
    assert sl == 8.0 and tp == 16.0


def test_apply_negative_range_pct_neutral() -> None:
    p = _params(regime_exit_scale_enabled=True)
    bar = {"range_pct": -3.0, "v_rank": 3}
    sl, tp = apply_regime_exit_scale(
        10.0, None, bar, p, broker_stop_loss_ticks=None, broker_take_profit_ticks=None
    )
    assert sl == 10.0


def test_broker_override_skips_scaling() -> None:
    p = _params(regime_exit_scale_enabled=True)
    bar = {"range_pct": 1.0, "v_rank": 5}
    sl, tp = apply_regime_exit_scale(
        10.0,
        20.0,
        bar,
        p,
        broker_stop_loss_ticks=4.0,
        broker_take_profit_ticks=None,
    )
    assert sl == 10.0 and tp == 20.0


def test_range_pct_lerp_endpoints() -> None:
    p = _params(
        regime_exit_scale_enabled=True,
        regime_sl_mult_min=0.5,
        regime_sl_mult_max=1.5,
        regime_tp_mult_min=0.5,
        regime_tp_mult_max=1.5,
    )
    bar_low = {"range_pct": 0.0, "v_rank": 3}
    sl0, tp0 = apply_regime_exit_scale(
        10.0, 10.0, bar_low, p, broker_stop_loss_ticks=None, broker_take_profit_ticks=None
    )
    assert sl0 == 5.0 and tp0 == 5.0
    bar_hi = {"range_pct": 1.0, "v_rank": 3}
    sl1, tp1 = apply_regime_exit_scale(
        10.0, 10.0, bar_hi, p, broker_stop_loss_ticks=None, broker_take_profit_ticks=None
    )
    assert sl1 == 15.0 and tp1 == 15.0


def test_v_rank_mode_table() -> None:
    p = _params(
        regime_exit_scale_enabled=True,
        regime_exit_scale_mode="v_rank",
        regime_v_rank_sl_mults=(2.0, 2.0, 2.0, 2.0, 2.0),
        regime_v_rank_tp_mults=(1.0, 1.0, 1.0, 1.0, 1.0),
    )
    bar = {"v_rank": 3, "range_pct": 0.5}
    sl, tp = apply_regime_exit_scale(
        4.0, 5.0, bar, p, broker_stop_loss_ticks=None, broker_take_profit_ticks=None
    )
    assert sl == 8.0 and tp == 5.0


@pytest.fixture()
def duck_con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    init_schema(con)
    return con


def test_next_bar_open_uses_entry_bar_range_pct(monkeypatch: pytest.MonkeyPatch, duck_con: duckdb.DuckDBPyConnection) -> None:
    monkeypatch.setattr(
        "orderflow_pipeline.backtest_engine.resolve_exit_ticks",
        lambda *a, **kw: (10.0, None),
    )
    t0 = datetime(2026, 2, 2, 14, 30)

    def row(bt: datetime, o: float, h: float, l: float, c: float, rp: float):
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
            rp,
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
        row(t0 + timedelta(minutes=0), 7150.0, 7151.0, 7149.0, 7150.5, 1.0),
        row(t0 + timedelta(minutes=1), 7150.5, 7152.0, 7150.0, 7151.0, 1.0),
        row(t0 + timedelta(minutes=2), 7151.0, 7152.0, 7148.0, 7149.5, 0.0),
    ]
    duck_con.executemany(
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
    sig = t0 + timedelta(minutes=1)
    duck_con.execute(
        """
        INSERT INTO fires (bar_time, timeframe, watch_id, direction, price, outcome, outcome_resolved_at)
        VALUES (?, '1m', 'breakout', 'up', 7151.0, NULL, NULL)
        """,
        [sig],
    )
    cfg = BrokerConfig(
        tick_size=0.25,
        slippage_ticks=1.0,
        regime_exit_scale_enabled=True,
        regime_sl_mult_min=0.75,
        regime_sl_mult_max=1.25,
    )
    pol = ExecutionPolicy(entry_next_bar_open=True)
    engine = BacktestEngine(duck_con)
    out = engine.run(
        timeframe="1m",
        from_time=t0,
        to_time=t0 + timedelta(minutes=3),
        config=cfg,
        execution_policy=pol,
        watch_ids={"breakout"},
        use_regime_filter=True,
    )
    rows_db = duck_con.execute(
        """
        SELECT stop_loss_ticks_effective FROM backtest_trades WHERE run_id = ? ORDER BY trade_id
        """,
        [out["runId"]],
    ).fetchall()
    assert len(rows_db) == 1
    eff = rows_db[0][0]
    assert eff is not None and not math.isnan(eff)
    assert abs(float(eff) - 7.5) < 1e-5


def test_scaling_disabled_matches_template(monkeypatch: pytest.MonkeyPatch, duck_con: duckdb.DuckDBPyConnection) -> None:
    monkeypatch.setattr(
        "orderflow_pipeline.backtest_engine.resolve_exit_ticks",
        lambda *a, **kw: (10.0, None),
    )
    t0 = datetime(2026, 2, 3, 14, 30)

    def row(bt: datetime, rp: float):
        return (
            bt.date(),
            bt,
            bt + timedelta(minutes=1),
            "1m",
            7150.0,
            7152.0,
            7149.0,
            7151.0,
            200,
            5,
            10,
            1,
            8,
            rp,
            25.0,
            0.2,
            3,
            3,
            7151.0,
            None,
            None,
            None,
        )

    duck_con.executemany(
        """
        INSERT INTO bars (
            session_date, bar_time, bar_end_time, timeframe, open, high, low, close, volume, delta,
            trade_count, large_print_count, distinct_prices, range_pct, vpt, concentration,
            v_rank, d_rank, vwap, bias_state, parent_1h_bias, parent_15m_bias
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [row(t0, 1.0), row(t0 + timedelta(minutes=1), 0.0)],
    )
    duck_con.execute(
        """
        INSERT INTO fires (bar_time, timeframe, watch_id, direction, price, outcome, outcome_resolved_at)
        VALUES (?, '1m', 'breakout', 'up', 7151.0, NULL, NULL)
        """,
        [t0],
    )
    cfg = BrokerConfig(
        tick_size=0.25,
        regime_exit_scale_enabled=False,
    )
    engine = BacktestEngine(duck_con)
    out = engine.run(
        timeframe="1m",
        from_time=t0,
        to_time=t0 + timedelta(minutes=2),
        config=cfg,
        watch_ids={"breakout"},
        use_regime_filter=True,
    )
    eff = duck_con.execute(
        "SELECT stop_loss_ticks_effective FROM backtest_trades WHERE run_id = ?",
        [out["runId"]],
    ).fetchone()[0]
    assert eff == 10.0
