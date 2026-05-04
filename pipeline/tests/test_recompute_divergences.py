"""Tests for ``recompute-divergences`` CLI (swing-backed divergence refresh)."""

from __future__ import annotations

import pathlib
import sys
from datetime import date, datetime, timedelta

import pytest

_SRC = pathlib.Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from orderflow_pipeline.cli import (  # noqa: E402
    _bars_for_divergence_from_db_rows,
    main as cli_main,
)
from orderflow_pipeline.db import init_schema  # noqa: E402
from orderflow_pipeline.divergence import detect_divergences  # noqa: E402
from orderflow_pipeline.swings import (  # noqa: E402
    SERIES_CVD_HIGH,
    SERIES_PRICE_HIGH,
)

SESSION_D = date(2026, 5, 1)
TF = "1m"
LB = 5


def _t0() -> datetime:
    return datetime(2026, 5, 1, 14, 30, 0)


def _seed_session(con, *, diverge_stale: bool) -> None:
    """Minimal bars + swings so ``detect_divergences`` emits one bearish row."""
    t0 = _t0()
    rows = []
    for i in range(8):
        bt = t0 + timedelta(minutes=i)
        bet = bt + timedelta(minutes=1)
        # Ratio higher at bar 2 than bar 7 → bearish size_confirmation True when both ratios exist.
        if i == 2:
            scvd, bc, sc, avgb, avgs = 10, 10, 10, 20.0, 10.0
        elif i == 7:
            scvd, bc, sc, avgb, avgs = 70, 10, 10, 10.0, 10.0
        else:
            scvd, bc, sc, avgb, avgs = i * 10, 4, 4, 5.0, 5.0
        ratio = round(avgb / avgs, 6) if bc and sc else None
        rows.append(
            (
                SESSION_D,
                bt,
                bet,
                TF,
                4500.0,
                4501.0,
                4499.0,
                4500.25,
                100,
                1,
                5,
                0,
                4,
                0.01,
                10.0,
                0.2,
                3,
                3,
                1.5,
                2.5,
                4500.0,
                None,
                None,
                None,
                scvd,
                bc,
                sc,
                avgb,
                avgs,
                ratio,
            )
        )
    con.executemany(
        """
        INSERT INTO bars (
            session_date, bar_time, bar_end_time, timeframe,
            open, high, low, close, volume, delta,
            trade_count, large_print_count, distinct_prices, range_pct, vpt, concentration,
            v_rank, d_rank, vol_score, depth_score, vwap,
            bias_state, parent_1h_bias, parent_15m_bias,
            session_cvd, aggressive_buy_count, aggressive_sell_count,
            avg_aggressive_buy_size, avg_aggressive_sell_size, size_imbalance_ratio
        )
        VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """,
        rows,
    )

    bt2 = t0 + timedelta(minutes=2)
    bt7 = t0 + timedelta(minutes=7)
    swings = [
        (SESSION_D, bt2, TF, SERIES_PRICE_HIGH, 4500.0, LB),
        (SESSION_D, bt7, TF, SERIES_PRICE_HIGH, 4501.0, LB),
        (SESSION_D, bt2, TF, SERIES_CVD_HIGH, 100.0, LB),
        (SESSION_D, bt7, TF, SERIES_CVD_HIGH, 97.0, LB),
    ]
    con.executemany(
        """
        INSERT INTO swing_events (session_date, bar_time, timeframe, series_type, swing_value, swing_lookback)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        swings,
    )

    if diverge_stale:
        con.execute(
            """
            INSERT INTO divergence_events (
                session_date, timeframe, div_kind, earlier_bar_time, later_bar_time,
                earlier_price, later_price, earlier_cvd, later_cvd, bars_between,
                size_confirmation, swing_lookback, min_price_delta, min_cvd_delta,
                max_swing_bar_distance, earlier_size_imbalance_ratio, later_size_imbalance_ratio
            )
            VALUES (
                ?, ?, 'bullish', ?, ?, 0, 0, 0, 0, 99, false, ?, 9, 9, 9, NULL, NULL
            )
            """,
            [SESSION_D, TF, bt2, bt7, LB],
        )


@pytest.fixture()
def duckdb_path(tmp_path: pathlib.Path) -> pathlib.Path:
    return tmp_path / "t.duckdb"


def test_recompute_divergences_preview_leaves_rows_unchanged(duckdb_path: pathlib.Path) -> None:
    import duckdb

    con = duckdb.connect(str(duckdb_path))
    init_schema(con)
    _seed_session(con, diverge_stale=True)
    con.close()

    before = duckdb.connect(str(duckdb_path))
    n0 = before.execute("SELECT COUNT(*) FROM divergence_events").fetchone()[0]
    before.close()
    assert n0 == 1

    code = cli_main(
        [
            "recompute-divergences",
            "--db-path",
            str(duckdb_path),
            "--timeframe",
            TF,
            "--preview",
        ]
    )
    assert code == 0

    after = duckdb.connect(str(duckdb_path))
    n1 = after.execute("SELECT COUNT(*) FROM divergence_events").fetchone()[0]
    row = after.execute(
        "SELECT div_kind FROM divergence_events LIMIT 1"
    ).fetchone()
    after.close()
    assert n1 == n0 == 1
    assert row and row[0] == "bullish"


def test_recompute_divergences_replaces_slice(duckdb_path: pathlib.Path) -> None:
    import duckdb

    con = duckdb.connect(str(duckdb_path))
    init_schema(con)
    _seed_session(con, diverge_stale=True)
    con.close()

    code = cli_main(
        [
            "recompute-divergences",
            "--db-path",
            str(duckdb_path),
            "--timeframe",
            TF,
            "--div-min-price",
            "0.25",
            "--div-min-cvd",
            "1",
        ]
    )
    assert code == 0

    con = duckdb.connect(str(duckdb_path))
    rows = con.execute(
        """
        SELECT div_kind, swing_lookback, min_price_delta, min_cvd_delta, max_swing_bar_distance,
               size_confirmation
        FROM divergence_events
        ORDER BY earlier_bar_time
        """
    ).fetchall()
    con.close()

    assert len(rows) == 1
    kind, slb, mp, mc, mb, sz = rows[0]
    assert kind == "bearish"
    assert slb == LB
    assert mp == pytest.approx(0.25)
    assert mc == 1
    assert mb == 240
    assert sz is True


def test_recompute_divergences_mixed_swing_lookback_errors(duckdb_path: pathlib.Path) -> None:
    import duckdb

    con = duckdb.connect(str(duckdb_path))
    init_schema(con)
    _seed_session(con, diverge_stale=False)
    bt7 = _t0() + timedelta(minutes=7)
    con.execute(
        """
        UPDATE swing_events SET swing_lookback = 7
        WHERE timeframe = ? AND bar_time = ? AND series_type = ?
        """,
        [TF, bt7, SERIES_PRICE_HIGH],
    )
    con.close()

    code = cli_main(
        ["recompute-divergences", "--db-path", str(duckdb_path), "--timeframe", TF]
    )
    assert code == 2


def test_bars_for_divergence_roundtrip_matches_detect_direct() -> None:
    """Reconstructed Bars from persisted avg×count match direct detection on this fixture."""
    import duckdb

    con = duckdb.connect(":memory:")
    init_schema(con)
    _seed_session(con, diverge_stale=False)

    bar_rows = con.execute(
        """
        SELECT bar_time, session_cvd, aggressive_buy_count, aggressive_sell_count,
               avg_aggressive_buy_size, avg_aggressive_sell_size
        FROM bars WHERE timeframe = ? AND session_date = ?
        ORDER BY bar_time
        """,
        [TF, SESSION_D],
    ).fetchall()
    swings_raw = con.execute(
        """
        SELECT session_date, bar_time, timeframe, series_type, swing_value, swing_lookback
        FROM swing_events WHERE timeframe = ? AND session_date = ?
        ORDER BY bar_time, series_type
        """,
        [TF, SESSION_D],
    ).fetchall()
    swing_rows = [
        {
            "session_date": r[0],
            "bar_time": r[1],
            "timeframe": r[2],
            "series_type": r[3],
            "swing_value": float(r[4]),
            "swing_lookback": int(r[5]),
        }
        for r in swings_raw
    ]
    con.close()

    bars_rehyd = _bars_for_divergence_from_db_rows(bar_rows, TF)
    assert bars_rehyd[2].sum_aggressive_buy_size == 200 and bars_rehyd[2].sum_aggressive_sell_size == 100
    assert bars_rehyd[7].sum_aggressive_buy_size == 100 and bars_rehyd[7].sum_aggressive_sell_size == 100

    divs = detect_divergences(
        bars_rehyd,
        swing_rows,
        session_date=SESSION_D,
        timeframe=TF,
        swing_lookback=LB,
        min_price_delta=0.25,
        min_cvd_delta=1,
        max_swing_bar_distance=240,
    )

    assert len(divs) == 1
    assert divs[0]["size_confirmation"] is True
