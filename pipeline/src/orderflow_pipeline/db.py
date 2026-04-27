"""DuckDB schema + per-session writer.

The aggregator is the only writer to this DB. The dashboard (via the FastAPI
layer in `api/main.py`) is read-only.

Tables (plan §1a):

    bars
        session_date    DATE        - "2026-04-21" etc., RTH date
        bar_time        TIMESTAMP   - bin-start UTC, primary key
        open / high / low / close   FLOAT
        volume                       INTEGER
        delta                        INTEGER
        trade_count                  INTEGER
        large_print_count            INTEGER
        distinct_prices              INTEGER     - len(price_volume)
        range_pct                    DOUBLE      - filled by Phase 2 regime.py
        vpt                          DOUBLE      - volume / distinct_prices
        concentration                DOUBLE      - modal_volume / volume
        v_rank                       SMALLINT    - 1..5, NULL during warmup (Phase 2)
        d_rank                       SMALLINT    - 1..5, NULL during warmup (Phase 2)

    events
        bar_time        TIMESTAMP
        event_type      VARCHAR     - 'sweep' / 'absorption' / 'stoprun' / 'divergence'
        direction       VARCHAR     - 'up' / 'down' / NULL
        price           FLOAT
        PRIMARY KEY (bar_time, event_type, direction)

    fires
        bar_time            TIMESTAMP
        watch_id            VARCHAR     - 'breakout' / 'fade'
        direction           VARCHAR
        price               FLOAT
        outcome             VARCHAR     - reserved for Phase 5+ outcome tracking
        outcome_resolved_at TIMESTAMP   - reserved
        PRIMARY KEY (bar_time, watch_id, direction)

    bar_volume_profile
        bar_time    TIMESTAMP
        price_tick  INTEGER     - round(price / 0.25); recover price as price_tick * 0.25
        volume      INTEGER     - sum(trade.size) at this tick within the bar
        delta       INTEGER     - signed; sums to bars.delta when grouped by bar_time
        PRIMARY KEY (bar_time, price_tick)

Indexes (named explicitly so verify_phase1.py / Phase 4a's brushing query can
EXPLAIN against them):

    idx_bars_session    bars(session_date)
    idx_bars_rank       bars(v_rank, d_rank)        - drives /occupancy + tuple-IN brushing
    idx_bvp_bar         bar_volume_profile(bar_time)
    idx_bvp_tick        bar_volume_profile(price_tick)

Public API:

    connect(path) -> duckdb.DuckDBPyConnection
    init_schema(con)
    write_session(con, session_date, bars_df, events_df, fires_df, profile_df)

`write_session` is idempotent: re-running on the same `session_date` deletes
that day's rows (in all four tables) before inserting. No partial state if a
write is interrupted — everything happens in one transaction.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING

import duckdb

if TYPE_CHECKING:
    import pandas as pd


_SCHEMA_SQL: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS bars (
        session_date      DATE       NOT NULL,
        bar_time          TIMESTAMP  NOT NULL PRIMARY KEY,
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
        d_rank            SMALLINT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS events (
        bar_time   TIMESTAMP NOT NULL,
        event_type VARCHAR   NOT NULL,
        direction  VARCHAR,
        price      DOUBLE    NOT NULL,
        PRIMARY KEY (bar_time, event_type, direction)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS fires (
        bar_time            TIMESTAMP NOT NULL,
        watch_id            VARCHAR   NOT NULL,
        direction           VARCHAR,
        price               DOUBLE    NOT NULL,
        outcome             VARCHAR,
        outcome_resolved_at TIMESTAMP,
        PRIMARY KEY (bar_time, watch_id, direction)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS bar_volume_profile (
        bar_time   TIMESTAMP NOT NULL,
        price_tick INTEGER   NOT NULL,
        volume     INTEGER   NOT NULL,
        delta      INTEGER   NOT NULL,
        PRIMARY KEY (bar_time, price_tick)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_bars_session ON bars(session_date)",
    "CREATE INDEX IF NOT EXISTS idx_bars_rank    ON bars(v_rank, d_rank)",
    "CREATE INDEX IF NOT EXISTS idx_bvp_bar      ON bar_volume_profile(bar_time)",
    "CREATE INDEX IF NOT EXISTS idx_bvp_tick     ON bar_volume_profile(price_tick)",
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
    """Idempotent CREATE TABLE / CREATE INDEX. Safe to call on every run."""
    for stmt in _SCHEMA_SQL:
        con.execute(stmt)


def write_session(
    con: duckdb.DuckDBPyConnection,
    session_date: date,
    bars_df: "pd.DataFrame",
    events_df: "pd.DataFrame",
    fires_df: "pd.DataFrame",
    profile_df: "pd.DataFrame",
) -> None:
    """Replace all rows for `session_date` across the four tables.

    Transactional: if any DELETE or INSERT fails, the whole write rolls back
    and no rows are left in an inconsistent state. Re-running on the same
    `session_date` is therefore a true refresh — never a partial overwrite.

    Expected DataFrame columns (all required, must match table column names):

        bars_df:    session_date, bar_time, open, high, low, close, volume,
                    delta, trade_count, large_print_count, distinct_prices,
                    range_pct, vpt, concentration, v_rank, d_rank
        events_df:  bar_time, event_type, direction, price
        fires_df:   bar_time, watch_id, direction, price, outcome,
                    outcome_resolved_at
        profile_df: bar_time, price_tick, volume, delta

    Phase 1 leaves `range_pct`, `v_rank`, `d_rank` as NULL; Phase 2 fills
    them in. `events_df` / `fires_df` / `profile_df` may be empty (no rows
    to insert) but must still have the listed columns.

    `bar_volume_profile` has no session_date column, so we delete those rows
    by joining the existing bars table on bar_time before purging that day's
    bars rows.
    """
    con.execute("BEGIN TRANSACTION")
    try:
        # Order matters: purge bar_volume_profile first because the join uses
        # the bars table to find which bar_times to drop.
        con.execute(
            """
            DELETE FROM bar_volume_profile
            WHERE bar_time IN (
                SELECT bar_time FROM bars WHERE session_date = ?
            )
            """,
            [session_date],
        )
        con.execute("DELETE FROM bars   WHERE session_date = ?", [session_date])
        # events / fires don't carry session_date directly; bound them by the
        # session's bar_time range from the incoming bars_df. This keeps the
        # writer self-contained (no need to query the about-to-be-purged
        # bars table for its prior date range).
        if len(bars_df) > 0:
            t_lo = bars_df["bar_time"].min()
            t_hi = bars_df["bar_time"].max()
            con.execute(
                "DELETE FROM events WHERE bar_time BETWEEN ? AND ?", [t_lo, t_hi]
            )
            con.execute(
                "DELETE FROM fires  WHERE bar_time BETWEEN ? AND ?", [t_lo, t_hi]
            )

        # `bars_df` etc. are referenced by name from the SQL via DuckDB's
        # zero-copy DataFrame integration. The column-list keeps row order
        # explicit and protects against silent column-order drift.
        if len(bars_df) > 0:
            con.execute(
                """
                INSERT INTO bars
                    (session_date, bar_time, open, high, low, close,
                     volume, delta, trade_count, large_print_count,
                     distinct_prices, range_pct, vpt, concentration,
                     v_rank, d_rank)
                SELECT session_date, bar_time, open, high, low, close,
                       volume, delta, trade_count, large_print_count,
                       distinct_prices, range_pct, vpt, concentration,
                       v_rank, d_rank
                FROM bars_df
                """
            )
        if len(events_df) > 0:
            con.execute(
                """
                INSERT INTO events (bar_time, event_type, direction, price)
                SELECT bar_time, event_type, direction, price FROM events_df
                """
            )
        if len(fires_df) > 0:
            con.execute(
                """
                INSERT INTO fires
                    (bar_time, watch_id, direction, price, outcome,
                     outcome_resolved_at)
                SELECT bar_time, watch_id, direction, price, outcome,
                       outcome_resolved_at
                FROM fires_df
                """
            )
        if len(profile_df) > 0:
            con.execute(
                """
                INSERT INTO bar_volume_profile (bar_time, price_tick, volume, delta)
                SELECT bar_time, price_tick, volume, delta FROM profile_df
                """
            )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
