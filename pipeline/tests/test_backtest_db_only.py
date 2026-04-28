from __future__ import annotations

import json
from datetime import datetime, timedelta

from orderflow_pipeline.backtest_engine import BacktestEngine, BrokerConfig
from orderflow_pipeline.db import init_schema


def _seed_bars(con) -> tuple[datetime, datetime]:
    t0 = datetime(2026, 1, 26, 14, 30)
    rows = []
    px = 7150.0
    for i in range(12):
        open_ = px
        close = px + (0.5 if i % 2 == 0 else -0.25)
        high = max(open_, close) + 0.5
        low = min(open_, close) - 0.5
        rows.append(
            (
                datetime(2026, 1, 26).date(),
                t0 + timedelta(minutes=i),
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
            session_date, bar_time, timeframe, open, high, low, close, volume, delta,
            trade_count, large_print_count, distinct_prices, range_pct, vpt, concentration,
            v_rank, d_rank, vwap, bias_state, parent_1h_bias, parent_15m_bias
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    return rows[0][1], rows[-1][1]


def test_backtest_requires_db_fires() -> None:
    import duckdb

    con = duckdb.connect(":memory:")
    init_schema(con)
    lo, hi = _seed_bars(con)
    engine = BacktestEngine(con)
    try:
        engine.run(
            timeframe="1m",
            from_time=lo,
            to_time=hi,
            config=BrokerConfig(),
            watch_ids={"valueEdgeReject"},
            use_regime_filter=True,
        )
    except ValueError as exc:
        assert "No DB fires" in str(exc)
    else:
        raise AssertionError("Expected DB-only backtest to fail when fires are missing.")


def test_backtest_persists_skip_reasons() -> None:
    import duckdb

    con = duckdb.connect(":memory:")
    init_schema(con)
    lo, hi = _seed_bars(con)
    # three same-side fires in a row -> first opens position, next two should skip.
    fire_rows = [
        (lo + timedelta(minutes=1), "1m", "valueEdgeReject", "up", 7151.0, None, None),
        (lo + timedelta(minutes=2), "1m", "valueEdgeReject", "up", 7152.0, None, None),
        (lo + timedelta(minutes=3), "1m", "valueEdgeReject", "up", 7153.0, None, None),
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
        from_time=lo,
        to_time=hi,
        config=BrokerConfig(),
        watch_ids={"valueEdgeReject"},
        use_regime_filter=True,
    )
    assert out["signalSource"] == "db"
    meta = con.execute("SELECT metadata_json FROM backtest_runs WHERE run_id = ?", [out["runId"]]).fetchone()
    meta_json = json.loads(meta[0])
    assert "skipped_fires" in meta_json
    skipped = con.execute("SELECT reason_code FROM skipped_fires WHERE run_id = ?", [out["runId"]]).fetchall()
    assert any(r[0] == "already_in_position_same_side" for r in skipped)

