from __future__ import annotations

import json
from datetime import datetime, timedelta

import duckdb

from orderflow_pipeline.backtest_engine import BacktestEngine, BrokerConfig, ExecutionPolicy
from orderflow_pipeline.db import init_schema
from orderflow_pipeline.null_hypothesis import (
    NH_PARITY_VARIANTS_PER_K,
    effective_seed_from_baseline_run_id,
    eligible_bar_indices,
    greedy_cooldown_indices,
    max_cooldown_packed_fire_count,
    run_null_hypothesis_parity_loop,
)
from orderflow_pipeline.strategies.config import LegacyFallbackConfig
from orderflow_pipeline.strategies.legacy_fallback_logic import config_for_timeframe


def _bars_rows(con, n: int = 40) -> tuple[datetime, datetime]:
    t0 = datetime(2026, 1, 26, 14, 30)
    rows = []
    px = 7150.0
    for i in range(n):
        open_ = px
        close = px + (0.25 if i % 3 != 0 else -0.25)
        high = max(open_, close) + 0.5
        low = min(open_, close) - 0.5
        bt = t0 + timedelta(minutes=i)
        vol = 220 + (i % 7)
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
                vol,
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


def test_effective_seed_stable() -> None:
    s = effective_seed_from_baseline_run_id("abc-def-111", override=None)
    assert s == effective_seed_from_baseline_run_id("abc-def-111", override=None)
    assert effective_seed_from_baseline_run_id("abc-def-111", override=999) == (999 & ((1 << 63) - 1))


def test_eligible_bar_indices_subset_under_regime_ve() -> None:
    t0 = datetime(2026, 1, 1, 14, 0)
    bars = []
    base_vol = 100.0
    for i in range(25):
        bt = t0 + timedelta(minutes=i)
        vol = base_vol if i != 20 else base_vol * 3.0
        bars.append(
            {
                "bar_time": bt,
                "open": 100.0,
                "high": 101.0,
                "low": 99.0,
                "close": 100.25,
                "volume": vol,
            }
        )
    cfg = LegacyFallbackConfig(
        use_regime_filter=True,
        warmup_start=5,
        lookback_bars=4,
        cooldown_bars=2,
    )
    eligible = eligible_bar_indices(bars, cfg, "valueEdgeReject")
    assert 20 not in eligible


def test_null_hypothesis_metadata_and_trade_parity() -> None:
    con = duckdb.connect(":memory:")
    init_schema(con)
    lo, hi = _bars_rows(con, n=42)
    mid_fire = lo + timedelta(minutes=20)
    con.execute(
        """
        INSERT INTO fires (bar_time, timeframe, watch_id, direction, price, outcome, outcome_resolved_at)
        VALUES (?, '1m', 'valueEdgeReject', 'up', 7151.0, NULL, NULL)
        """,
        [mid_fire],
    )

    engine = BacktestEngine(con)
    cfg_broker = BrokerConfig()
    policy = ExecutionPolicy()
    summary = engine.run(
        timeframe="1m",
        from_time=lo,
        to_time=hi,
        config=cfg_broker,
        execution_policy=policy,
        watch_ids={"valueEdgeReject"},
        use_regime_filter=True,
    )
    n_base = int(summary["tradeCount"])
    assert n_base >= 1

    bars = engine._load_bars("1m", lo, hi)
    strat_cfg = config_for_timeframe("1m", use_regime_filter=True)
    eff = effective_seed_from_baseline_run_id(summary["runId"], override=None)

    def simulate_trade_count(fires_by_time):
        closed, _, _ = engine._simulate(
            bars,
            fires_by_time,
            timeframe="1m",
            config=cfg_broker,
            policy=policy,
        )
        return len(closed)

    nh_fires, nh_diag = run_null_hypothesis_parity_loop(
        bars=bars,
        cfg=strat_cfg,
        watch_id="valueEdgeReject",
        baseline_trade_count=n_base,
        baseline_run_id=summary["runId"],
        effective_seed=eff,
        cooldown_bars=strat_cfg.cooldown_bars,
        simulate_trade_count=simulate_trade_count,
    )

    nh_summary = engine.run(
        timeframe="1m",
        from_time=lo,
        to_time=hi,
        config=cfg_broker,
        execution_policy=policy,
        watch_ids={"valueEdgeReject"},
        use_regime_filter=True,
        fires_by_time=nh_fires,
        signal_source="null_hypothesis",
        metadata_extra={"is_null_hypothesis": True, "baseline_run_id": summary["runId"]},
    )
    assert nh_summary["tradeCount"] == n_base
    meta_row = con.execute(
        "SELECT metadata_json FROM backtest_runs WHERE run_id = ?", [nh_summary["runId"]]
    ).fetchone()
    meta = json.loads(meta_row[0])
    assert meta.get("is_null_hypothesis") is True
    assert meta.get("baseline_run_id") == summary["runId"]
    assert nh_diag["matched_trade_count"] == n_base
    assert nh_diag["max_schedulable_fires"] >= n_base
    assert nh_diag["parity_variants_per_k"] == NH_PARITY_VARIANTS_PER_K
    assert nh_diag["parity_placement_styles"] == 3


def test_max_cooldown_packed_fire_count_sorted_gap() -> None:
    valid = [0, 1, 2, 10, 11, 12, 20]
    cd = 4
    assert max_cooldown_packed_fire_count(valid, cd) == len(
        greedy_cooldown_indices(sorted(valid), len(valid), cd)
    )
    assert max_cooldown_packed_fire_count(valid, cd) == 3


def test_insufficient_eligible_raises() -> None:
    t0 = datetime(2026, 1, 1, 14, 0)
    bars = [
        {
            "bar_time": t0 + timedelta(minutes=i),
            "open": 100.0,
            "high": 101.0,
            "low": 99.0,
            "close": 100.0,
            "volume": 100.0,
        }
        for i in range(14)
    ]
    cfg = LegacyFallbackConfig(use_regime_filter=False, warmup_start=12, lookback_bars=4, cooldown_bars=1)
    eligible = eligible_bar_indices(bars, cfg, "valueEdgeReject")
    assert len(eligible) == 0 or len(eligible) < 500

    def sim(_):
        return 0

    try:
        run_null_hypothesis_parity_loop(
            bars=bars,
            cfg=cfg,
            watch_id="valueEdgeReject",
            baseline_trade_count=999,
            baseline_run_id="rid",
            effective_seed=1,
            cooldown_bars=1,
            simulate_trade_count=sim,
        )
    except ValueError as exc:
        assert "insufficient_eligible_bars" in str(exc)
    else:
        raise AssertionError("expected insufficient_eligible_bars")
