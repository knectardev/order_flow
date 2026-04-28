"""DuckDB schema + per-(session, timeframe) writer.

The aggregator is the only writer to this DB. The dashboard (via the FastAPI
layer in `api/main.py`) is read-only.

Phase 5 extends every table with a `timeframe` column ('1m' / '15m' / '1h')
and promotes the primary keys to composites that include it. Each timeframe
is its own independent context — events, fires, regime ranks, and per-tick
volume profile are all computed per-timeframe and never mixed. Storage cost
is small (~8% growth for 2 added timeframes) and query patterns simplify to
`WHERE timeframe = ?` on every endpoint.

Tables (Phase 5):

    bars
        session_date    DATE        - "2026-04-21" etc., RTH date
        bar_time        TIMESTAMP   - bin-start UTC
        timeframe       VARCHAR     - '1m' | '15m' | '1h'
        open / high / low / close   FLOAT
        volume                       INTEGER
        delta                        INTEGER
        trade_count                  INTEGER
        large_print_count            INTEGER
        distinct_prices              INTEGER     - len(price_volume)
        range_pct                    DOUBLE      - filled by regime.py
        vpt                          DOUBLE      - volume / distinct_prices
        concentration                DOUBLE      - modal_volume / volume
        v_rank                       SMALLINT    - 1..5, NULL during warmup
        d_rank                       SMALLINT    - 1..5, NULL during warmup
        vwap                         DOUBLE      - Phase 6 running session VWAP at bar close
        bias_state                   VARCHAR     - Phase 6 7-level bias for THIS bar's timeframe
        parent_1h_bias               VARCHAR     - Phase 6 denormalized 1h bias covering this bar
        parent_15m_bias              VARCHAR     - Phase 6 denormalized 15m bias covering this bar
        PRIMARY KEY (bar_time, timeframe)

    events
        bar_time        TIMESTAMP
        timeframe       VARCHAR
        event_type      VARCHAR     - 'sweep' / 'absorption' / 'stoprun' / 'divergence'
        direction       VARCHAR     - 'up' / 'down' / NULL
        price           FLOAT
        PRIMARY KEY (bar_time, timeframe, event_type, direction)

    fires
        bar_time            TIMESTAMP
        timeframe           VARCHAR
        watch_id            VARCHAR     - 'breakout' / 'fade'
        direction           VARCHAR
        price               FLOAT
        outcome             VARCHAR     - reserved for outcome tracking
        outcome_resolved_at TIMESTAMP   - reserved
        PRIMARY KEY (bar_time, timeframe, watch_id, direction)

    bar_volume_profile
        bar_time    TIMESTAMP
        timeframe   VARCHAR
        price_tick  INTEGER     - round(price / 0.25); recover price as price_tick * 0.25
        volume      INTEGER     - sum(trade.size) at this tick within the bar
        delta       INTEGER     - signed; sums to bars.delta when grouped by bar_time/timeframe
        PRIMARY KEY (bar_time, timeframe, price_tick)

Indexes (Phase 5):

    idx_bars_tf_session   bars(timeframe, session_date)
    idx_bars_tf_rank      bars(timeframe, v_rank, d_rank)   - drives /occupancy + tuple-IN brushing
    idx_bars_tf_bartime   bars(timeframe, bar_time)         - Phase 6 denormalization JOIN drive
    idx_bvp_tf_bar        bar_volume_profile(timeframe, bar_time)
    idx_bvp_tick          bar_volume_profile(price_tick)

Public API:

    connect(path) -> duckdb.DuckDBPyConnection
    init_schema(con)
    write_session(con, session_date, timeframe, bars_df, events_df, fires_df, profile_df)

`write_session` is idempotent: re-running on the same `(session_date,
timeframe)` deletes that day+timeframe's rows (in all four tables) before
inserting. No partial state if a write is interrupted — everything happens
in one transaction. Re-running one timeframe never disturbs another.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING, Any

import duckdb

if TYPE_CHECKING:
    import pandas as pd


_SCHEMA_SQL: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS bars (
        session_date      DATE       NOT NULL,
        bar_time          TIMESTAMP  NOT NULL,
        timeframe         VARCHAR    NOT NULL,
        open              DOUBLE     NOT NULL,
        high              DOUBLE     NOT NULL,
        low               DOUBLE     NOT NULL,
        close             DOUBLE     NOT NULL,
        volume            INTEGER    NOT NULL,
        delta             INTEGER    NOT NULL,
        trade_count       INTEGER    NOT NULL,
        large_print_count INTEGER    NOT NULL,
        distinct_prices   INTEGER    NOT NULL,
        range_pct         DOUBLE,
        vpt               DOUBLE,
        concentration     DOUBLE,
        v_rank            SMALLINT,
        d_rank            SMALLINT,
        vwap              DOUBLE,
        bias_state        VARCHAR,
        parent_1h_bias    VARCHAR,
        parent_15m_bias   VARCHAR,
        PRIMARY KEY (bar_time, timeframe)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS events (
        bar_time   TIMESTAMP NOT NULL,
        timeframe  VARCHAR   NOT NULL,
        event_type VARCHAR   NOT NULL,
        direction  VARCHAR,
        price      DOUBLE    NOT NULL,
        PRIMARY KEY (bar_time, timeframe, event_type, direction)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS fires (
        bar_time            TIMESTAMP NOT NULL,
        timeframe           VARCHAR   NOT NULL,
        watch_id            VARCHAR   NOT NULL,
        direction           VARCHAR,
        price               DOUBLE    NOT NULL,
        outcome             VARCHAR,
        outcome_resolved_at TIMESTAMP,
        PRIMARY KEY (bar_time, timeframe, watch_id, direction)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS bar_volume_profile (
        bar_time   TIMESTAMP NOT NULL,
        timeframe  VARCHAR   NOT NULL,
        price_tick INTEGER   NOT NULL,
        volume     INTEGER   NOT NULL,
        delta      INTEGER   NOT NULL,
        PRIMARY KEY (bar_time, timeframe, price_tick)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_bars_tf_session ON bars(timeframe, session_date)",
    "CREATE INDEX IF NOT EXISTS idx_bars_tf_rank    ON bars(timeframe, v_rank, d_rank)",
    "CREATE INDEX IF NOT EXISTS idx_bars_tf_bartime ON bars(timeframe, bar_time)",
    "CREATE INDEX IF NOT EXISTS idx_bvp_tf_bar      ON bar_volume_profile(timeframe, bar_time)",
    "CREATE INDEX IF NOT EXISTS idx_bvp_tick        ON bar_volume_profile(price_tick)",
    """
    CREATE TABLE IF NOT EXISTS backtest_runs (
        run_id               VARCHAR    PRIMARY KEY,
        created_at           TIMESTAMP  NOT NULL,
        timeframe            VARCHAR    NOT NULL,
        from_time            TIMESTAMP  NOT NULL,
        to_time              TIMESTAMP  NOT NULL,
        initial_capital      DOUBLE     NOT NULL,
        qty                  INTEGER    NOT NULL,
        slippage_ticks       DOUBLE     NOT NULL,
        commission_per_side  DOUBLE     NOT NULL,
        tick_size            DOUBLE     NOT NULL,
        point_value          DOUBLE     NOT NULL,
        trade_count          INTEGER    NOT NULL,
        win_rate             DOUBLE,
        sharpe               DOUBLE,
        max_drawdown         DOUBLE,
        net_pnl              DOUBLE     NOT NULL,
        metadata_json        VARCHAR
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS backtest_trades (
        run_id               VARCHAR    NOT NULL,
        trade_id             INTEGER    NOT NULL,
        watch_id             VARCHAR,
        entry_time           TIMESTAMP  NOT NULL,
        exit_time            TIMESTAMP  NOT NULL,
        direction            VARCHAR    NOT NULL,
        qty                  INTEGER    NOT NULL,
        entry_price          DOUBLE     NOT NULL,
        exit_price           DOUBLE     NOT NULL,
        gross_pnl            DOUBLE     NOT NULL,
        commission           DOUBLE     NOT NULL,
        net_pnl              DOUBLE     NOT NULL,
        bars_held            INTEGER    NOT NULL,
        PRIMARY KEY (run_id, trade_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS backtest_equity (
        run_id               VARCHAR    NOT NULL,
        bar_time             TIMESTAMP  NOT NULL,
        equity               DOUBLE     NOT NULL,
        cash                 DOUBLE     NOT NULL,
        unrealized_pnl       DOUBLE     NOT NULL,
        realized_pnl         DOUBLE     NOT NULL,
        PRIMARY KEY (run_id, bar_time)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_backtest_runs_created ON backtest_runs(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_backtest_runs_tf_time ON backtest_runs(timeframe, from_time, to_time)",
    "CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades(run_id, entry_time)",
    "CREATE INDEX IF NOT EXISTS idx_backtest_equity_run ON backtest_equity(run_id, bar_time)",
)


# Phase 6 columns added on top of the Phase 5 schema. Existing
# databases predate these columns; `init_schema` runs IF NOT EXISTS
# guards via the per-column ALTER below so re-init on a Phase 5 DB
# is upgrade-safe (no rebuild required for the column to land — but
# you DO need a rebuild to populate the new values).
_PHASE6_BAR_COLUMNS: tuple[tuple[str, str], ...] = (
    ("vwap",            "DOUBLE"),
    ("bias_state",      "VARCHAR"),
    ("parent_1h_bias",  "VARCHAR"),
    ("parent_15m_bias", "VARCHAR"),
)


def connect(path: Path | str) -> duckdb.DuckDBPyConnection:
    """Open (or create) the DuckDB file at `path` for read+write.

    The parent directory is created if needed. Initial connection does NOT
    auto-init the schema — call `init_schema(con)` once after connecting.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(p))


def init_schema(con: duckdb.DuckDBPyConnection) -> None:
    """Idempotent CREATE TABLE / CREATE INDEX. Safe to call on every run.

    For databases created by Phase 5 (without the Phase 6 ``vwap`` /
    ``bias_state`` / ``parent_*_bias`` columns) we add them via
    ``ALTER TABLE ... ADD COLUMN IF NOT EXISTS``. The columns default
    to NULL; a subsequent rebuild via ``cli.py rebuild`` populates them.
    """
    for stmt in _SCHEMA_SQL:
        con.execute(stmt)
    # Phase 6 in-place upgrade for pre-existing databases.
    for col_name, col_type in _PHASE6_BAR_COLUMNS:
        con.execute(f"ALTER TABLE bars ADD COLUMN IF NOT EXISTS {col_name} {col_type}")


def write_session(
    con: duckdb.DuckDBPyConnection,
    session_date: date,
    timeframe: str,
    bars_df: "pd.DataFrame",
    events_df: "pd.DataFrame",
    fires_df: "pd.DataFrame",
    profile_df: "pd.DataFrame",
) -> None:
    """Replace all rows for `(session_date, timeframe)` across the four tables.

    Transactional: if any DELETE or INSERT fails, the whole write rolls back
    and no rows are left in an inconsistent state. Re-running on the same
    `(session_date, timeframe)` is therefore a true refresh — never a
    partial overwrite. Re-running one timeframe never disturbs another:
    every DELETE is keyed on `(session_date, timeframe)` so the other
    timeframes' rows for the same date stay intact.

    Expected DataFrame columns (all required, must match table column names):

        bars_df:    session_date, bar_time, timeframe, open, high, low,
                    close, volume, delta, trade_count, large_print_count,
                    distinct_prices, range_pct, vpt, concentration, v_rank,
                    d_rank, vwap, bias_state, parent_1h_bias,
                    parent_15m_bias  (Phase 6 cols may be empty strings or
                    NULL during ingest; the bias-stamp pass + denorm pass
                    fill them after this write completes)
        events_df:  bar_time, timeframe, event_type, direction, price
        fires_df:   bar_time, timeframe, watch_id, direction, price,
                    outcome, outcome_resolved_at
        profile_df: bar_time, timeframe, price_tick, volume, delta

    `events_df` / `fires_df` / `profile_df` may be empty (no rows to
    insert) but must still have the listed columns.

    `bar_volume_profile` rows are deleted by `(timeframe, bar_time)` joined
    against the bars table for the requested `(session_date, timeframe)`,
    before purging that day+timeframe's bars rows themselves.
    """
    con.execute("BEGIN TRANSACTION")
    try:
        # Order matters: purge bar_volume_profile first because the join uses
        # the bars table to find which (bar_time, timeframe) rows to drop.
        con.execute(
            """
            DELETE FROM bar_volume_profile
            WHERE timeframe = ?
              AND bar_time IN (
                SELECT bar_time FROM bars
                WHERE session_date = ? AND timeframe = ?
              )
            """,
            [timeframe, session_date, timeframe],
        )
        con.execute(
            "DELETE FROM bars WHERE session_date = ? AND timeframe = ?",
            [session_date, timeframe],
        )
        # events / fires don't carry session_date directly; bound them by
        # the session's bar_time range from the incoming bars_df scoped to
        # this timeframe. Re-running 15m never touches 1m's events/fires
        # because the WHERE clause filters on timeframe.
        if len(bars_df) > 0:
            t_lo = bars_df["bar_time"].min()
            t_hi = bars_df["bar_time"].max()
            con.execute(
                "DELETE FROM events WHERE timeframe = ? AND bar_time BETWEEN ? AND ?",
                [timeframe, t_lo, t_hi],
            )
            con.execute(
                "DELETE FROM fires  WHERE timeframe = ? AND bar_time BETWEEN ? AND ?",
                [timeframe, t_lo, t_hi],
            )

        # `bars_df` etc. are referenced by name from the SQL via DuckDB's
        # zero-copy DataFrame integration. The column-list keeps row order
        # explicit and protects against silent column-order drift.
        if len(bars_df) > 0:
            # Phase 6 columns are optional in the input frame for
            # backwards compatibility — any missing column is filled with
            # NULL so a partially-stamped frame still writes cleanly. The
            # cli.py rebuild always populates them, so this fallback is
            # only exercised by tests / direct API users.
            for col in ("vwap", "bias_state", "parent_1h_bias", "parent_15m_bias"):
                if col not in bars_df.columns:
                    bars_df[col] = None
            con.execute(
                """
                INSERT INTO bars
                    (session_date, bar_time, timeframe, open, high, low, close,
                     volume, delta, trade_count, large_print_count,
                     distinct_prices, range_pct, vpt, concentration,
                     v_rank, d_rank,
                     vwap, bias_state, parent_1h_bias, parent_15m_bias)
                SELECT session_date, bar_time, timeframe, open, high, low, close,
                       volume, delta, trade_count, large_print_count,
                       distinct_prices, range_pct, vpt, concentration,
                       v_rank, d_rank,
                       vwap, bias_state, parent_1h_bias, parent_15m_bias
                FROM bars_df
                """
            )
        if len(events_df) > 0:
            con.execute(
                """
                INSERT INTO events (bar_time, timeframe, event_type, direction, price)
                SELECT bar_time, timeframe, event_type, direction, price FROM events_df
                """
            )
        if len(fires_df) > 0:
            con.execute(
                """
                INSERT INTO fires
                    (bar_time, timeframe, watch_id, direction, price, outcome,
                     outcome_resolved_at)
                SELECT bar_time, timeframe, watch_id, direction, price, outcome,
                       outcome_resolved_at
                FROM fires_df
                """
            )
        if len(profile_df) > 0:
            con.execute(
                """
                INSERT INTO bar_volume_profile (bar_time, timeframe, price_tick, volume, delta)
                SELECT bar_time, timeframe, price_tick, volume, delta FROM profile_df
                """
            )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def write_backtest_results(
    con: duckdb.DuckDBPyConnection,
    run_row: dict[str, Any],
    trades: list[dict[str, Any]],
    equity_points: list[dict[str, Any]],
) -> None:
    """Persist one backtest run plus its trades/equity timeline atomically."""
    con.execute("BEGIN TRANSACTION")
    try:
        con.execute("DELETE FROM backtest_runs WHERE run_id = ?", [run_row["run_id"]])
        con.execute("DELETE FROM backtest_trades WHERE run_id = ?", [run_row["run_id"]])
        con.execute("DELETE FROM backtest_equity WHERE run_id = ?", [run_row["run_id"]])

        con.execute(
            """
            INSERT INTO backtest_runs (
                run_id, created_at, timeframe, from_time, to_time,
                initial_capital, qty, slippage_ticks, commission_per_side,
                tick_size, point_value, trade_count, win_rate, sharpe,
                max_drawdown, net_pnl, metadata_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                run_row["run_id"],
                run_row["created_at"],
                run_row["timeframe"],
                run_row["from_time"],
                run_row["to_time"],
                run_row["initial_capital"],
                run_row["qty"],
                run_row["slippage_ticks"],
                run_row["commission_per_side"],
                run_row["tick_size"],
                run_row["point_value"],
                run_row["trade_count"],
                run_row.get("win_rate"),
                run_row.get("sharpe"),
                run_row.get("max_drawdown"),
                run_row["net_pnl"],
                run_row.get("metadata_json"),
            ],
        )

        if trades:
            con.executemany(
                """
                INSERT INTO backtest_trades (
                    run_id, trade_id, watch_id, entry_time, exit_time,
                    direction, qty, entry_price, exit_price, gross_pnl,
                    commission, net_pnl, bars_held
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    [
                        t["run_id"],
                        t["trade_id"],
                        t.get("watch_id"),
                        t["entry_time"],
                        t["exit_time"],
                        t["direction"],
                        t["qty"],
                        t["entry_price"],
                        t["exit_price"],
                        t["gross_pnl"],
                        t["commission"],
                        t["net_pnl"],
                        t["bars_held"],
                    ]
                    for t in trades
                ],
            )

        if equity_points:
            con.executemany(
                """
                INSERT INTO backtest_equity (
                    run_id, bar_time, equity, cash, unrealized_pnl, realized_pnl
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    [
                        p["run_id"],
                        p["bar_time"],
                        p["equity"],
                        p["cash"],
                        p["unrealized_pnl"],
                        p["realized_pnl"],
                    ]
                    for p in equity_points
                ],
            )

        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
