"""DuckDB schema + per-(session, timeframe) writer.

The aggregator is the only writer to this DB. The dashboard (via the FastAPI
layer in `api/main.py`) is read-only.

Phase 5 extends every table with a `timeframe` column ('1m' / '5m' / '15m' / '1h')
and promotes the primary keys to composites that include it. Each timeframe
is its own independent context — events, fires, regime ranks, and per-tick
volume profile are all computed per-timeframe and never mixed. Storage cost
is small (~8% growth for 2 added timeframes) and query patterns simplify to
`WHERE timeframe = ?` on every endpoint.

Tables (Phase 5):

    bars
        session_date    DATE        - "2026-04-21" etc., RTH date
        bar_time        TIMESTAMP   - bin-start UTC (inclusive)
        bar_end_time    TIMESTAMP   - exclusive bar end UTC (half-open [bar_time, bar_end_time))
        timeframe       VARCHAR     - '1m' | '5m' | '15m' | '1h'
        open / high / low / close   FLOAT
        volume                       INTEGER
        delta                        INTEGER
        trade_count                  INTEGER
        large_print_count            INTEGER
        distinct_prices              INTEGER     - len(price_volume)
        range_pct                    DOUBLE      - filled by regime.py
        vpt                          DOUBLE      - volume / distinct_prices
        concentration                DOUBLE      - modal_volume / volume
        v_rank                       SMALLINT    - 1..5, NULL during warmup (integer ranks).
        d_rank                       SMALLINT    - 1..5, NULL during warmup.
        vol_score                    DOUBLE      - scatter abscissa from regime.compute_ranks
                                       (mid-rank track; open (1,5) typical — not duplicate of v_rank).
        depth_score                  DOUBLE      - scatter ordinate (same contract as vol_score).
        vwap                         DOUBLE      - Phase 6 running session VWAP at bar close
        bias_state                   VARCHAR     - Phase 6 7-level bias for THIS bar's timeframe
        parent_1h_bias               VARCHAR     - Phase 6 denormalized 1h bias covering this bar
        parent_15m_bias              VARCHAR     - Phase 6 denormalized 15m bias covering this bar
        session_kind                 VARCHAR     - 'rth' | 'globex' (ingest session filter)
        path_length_ticks            BIGINT      - sum |Δticks| trade-to-trade within session
        vw_path_length               DOUBLE      - Σ |Δticks|×size per edge (volume-weighted path)
        displacement_ticks           INTEGER     - close_ticks − open_ticks (rounded)
        abs_displacement_ticks       INTEGER
        pld_ratio                    DOUBLE      - path_length_ticks / bar range in ticks; NULL if range is 0
        flip_count                   INTEGER     - within-bar aggressor side flips only
        flip_rate                    DOUBLE      - flip_count / (trade_count−1), NULL if ≤1 trade
        jitter_regime                VARCHAR     - Low | Mid | High | NULL (warmup)
        conviction_regime            VARCHAR     - Low | Mid | High | NULL (inverted vs flip)
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

import os
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
        bar_end_time      TIMESTAMP  NOT NULL,
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
        top_cvd           DOUBLE,
        bottom_cvd        DOUBLE,
        top_cvd_norm      DOUBLE,
        bottom_cvd_norm   DOUBLE,
        cvd_imbalance     DOUBLE,
        top_body_volume_ratio DOUBLE,
        bottom_body_volume_ratio DOUBLE,
        upper_wick_liquidity DOUBLE,
        lower_wick_liquidity DOUBLE,
        upper_wick_ticks  SMALLINT,
        lower_wick_ticks  SMALLINT,
        high_before_low   BOOLEAN,
        rejection_side    VARCHAR,
        rejection_strength DOUBLE,
        rejection_type    VARCHAR,
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
        diagnostic_version  VARCHAR,
        diagnostics_json    VARCHAR,
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
        exit_reason          VARCHAR,
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
    """
    CREATE TABLE IF NOT EXISTS backtest_benchmarks (
        run_id               VARCHAR    NOT NULL,
        strategy             VARCHAR    NOT NULL,
        bar_time             TIMESTAMP  NOT NULL,
        equity               DOUBLE     NOT NULL,
        PRIMARY KEY (run_id, strategy, bar_time)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS skipped_fires (
        run_id                VARCHAR    NOT NULL,
        bar_time              TIMESTAMP  NOT NULL,
        watch_id              VARCHAR    NOT NULL,
        direction             VARCHAR,
        reason_code           VARCHAR    NOT NULL,
        price                 DOUBLE,
        position_side_before  INTEGER,
        position_size_before  INTEGER,
        reason_detail_json    VARCHAR,
        PRIMARY KEY (run_id, bar_time, watch_id, direction, reason_code)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_backtest_runs_created ON backtest_runs(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_backtest_runs_tf_time ON backtest_runs(timeframe, from_time, to_time)",
    "CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades(run_id, entry_time)",
    "CREATE INDEX IF NOT EXISTS idx_backtest_equity_run ON backtest_equity(run_id, bar_time)",
    "CREATE INDEX IF NOT EXISTS idx_backtest_bench_run ON backtest_benchmarks(run_id, strategy, bar_time)",
    "CREATE INDEX IF NOT EXISTS idx_skipped_fires_run ON skipped_fires(run_id, bar_time)",
    """
    CREATE TABLE IF NOT EXISTS swing_events (
        session_date      DATE       NOT NULL,
        bar_time          TIMESTAMP  NOT NULL,
        timeframe         VARCHAR    NOT NULL,
        series_type       VARCHAR    NOT NULL,
        swing_value       DOUBLE     NOT NULL,
        swing_lookback    INTEGER    NOT NULL,
        PRIMARY KEY (bar_time, timeframe, series_type)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS divergence_events (
        session_date             DATE       NOT NULL,
        timeframe                VARCHAR    NOT NULL,
        div_kind                 VARCHAR    NOT NULL,
        earlier_bar_time         TIMESTAMP  NOT NULL,
        later_bar_time           TIMESTAMP  NOT NULL,
        earlier_price            DOUBLE,
        later_price              DOUBLE,
        earlier_cvd              BIGINT,
        later_cvd                BIGINT,
        bars_between             INTEGER    NOT NULL,
        size_confirmation        BOOLEAN    NOT NULL,
        swing_lookback           INTEGER    NOT NULL,
        min_price_delta          DOUBLE     NOT NULL,
        min_cvd_delta            BIGINT     NOT NULL,
        max_swing_bar_distance   INTEGER    NOT NULL,
        earlier_size_imbalance_ratio DOUBLE,
        later_size_imbalance_ratio   DOUBLE,
        PRIMARY KEY (timeframe, session_date, div_kind, earlier_bar_time, later_bar_time)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_swing_tf_time ON swing_events(timeframe, bar_time)",
    "CREATE INDEX IF NOT EXISTS idx_div_tf_session ON divergence_events(timeframe, session_date)",
)


# Phase 6 columns added on top of the Phase 5 schema. Existing
# databases predate these columns; `init_schema` runs IF NOT EXISTS
# guards via the per-column ALTER below so re-init on a Phase 5 DB
# is upgrade-safe (no rebuild required for the column to land — but
# you DO need a rebuild to populate the new values).
_PHASE6_BAR_COLUMNS: tuple[tuple[str, str], ...] = (
    ("vwap",            "DOUBLE"),
    ("top_cvd",         "DOUBLE"),
    ("bottom_cvd",      "DOUBLE"),
    ("top_cvd_norm", "DOUBLE"),
    ("bottom_cvd_norm", "DOUBLE"),
    ("cvd_imbalance", "DOUBLE"),
    ("top_body_volume_ratio", "DOUBLE"),
    ("bottom_body_volume_ratio", "DOUBLE"),
    ("upper_wick_liquidity", "DOUBLE"),
    ("lower_wick_liquidity", "DOUBLE"),
    ("upper_wick_ticks", "SMALLINT"),
    ("lower_wick_ticks", "SMALLINT"),
    ("high_before_low", "BOOLEAN"),
    ("rejection_side", "VARCHAR"),
    ("rejection_strength", "DOUBLE"),
    ("rejection_type", "VARCHAR"),
    ("bias_state",      "VARCHAR"),
    ("parent_1h_bias",  "VARCHAR"),
    ("parent_15m_bias", "VARCHAR"),
)
# Continuous 1..5 regime coordinates for matrix / API (upgrade-safe ALTER).
_BAR_REGIME_CONTINUOUS_COLUMNS: tuple[tuple[str, str], ...] = (
    ("vol_score", "DOUBLE"),
    ("depth_score", "DOUBLE"),
)
# Session CVD + aggressor size imbalance (upgrade-safe ALTER).
_CVD_FLOW_BAR_COLUMNS: tuple[tuple[str, str], ...] = (
    ("session_cvd", "BIGINT"),
    ("aggressive_buy_count", "INTEGER"),
    ("aggressive_sell_count", "INTEGER"),
    ("avg_aggressive_buy_size", "DOUBLE"),
    ("avg_aggressive_sell_size", "DOUBLE"),
    ("size_imbalance_ratio", "DOUBLE"),
)
# Velocity matrix (path-length / displacement, flip rate, regimes).
_VELOCITY_BAR_COLUMNS: tuple[tuple[str, str], ...] = (
    ("session_kind", "VARCHAR"),
    ("path_length_ticks", "BIGINT"),
    ("vw_path_length", "DOUBLE"),
    ("displacement_ticks", "INTEGER"),
    ("abs_displacement_ticks", "INTEGER"),
    ("pld_ratio", "DOUBLE"),
    ("flip_count", "INTEGER"),
    ("flip_rate", "DOUBLE"),
    ("jitter_regime", "VARCHAR"),
    ("conviction_regime", "VARCHAR"),
    ("trade_context", "VARCHAR"),
)
_BAR_SPAN_COLUMNS: tuple[tuple[str, str], ...] = (
    ("bar_end_time", "TIMESTAMP"),
)

_FIRE_DIAGNOSTIC_COLUMNS: tuple[tuple[str, str], ...] = (
    ("diagnostic_version", "VARCHAR"),
    ("diagnostics_json", "VARCHAR"),
)
_BACKTEST_TRADE_COLUMNS: tuple[tuple[str, str], ...] = (
    ("exit_reason", "VARCHAR"),
    ("stop_loss_ticks_effective", "DOUBLE"),
    ("take_profit_ticks_effective", "DOUBLE"),
    ("slippage_to_stop_ratio", "DOUBLE"),
)


def connect(path: Path | str) -> duckdb.DuckDBPyConnection:
    """Open (or create) the DuckDB file at `path` for read+write.

    The parent directory is created if needed. Initial connection does NOT
    auto-init the schema — call `init_schema(con)` once after connecting.

    Optional environment (large ingest / memory pressure):

    - ``ORDERFLOW_DUCKDB_MEMORY_LIMIT`` — ``SET memory_limit`` (e.g. ``8GB``). Empty = default.
    - ``ORDERFLOW_DUCKDB_TEMP_DIR`` — spill/temp directory (use forward slashes on Windows).
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(p))
    mem = os.environ.get("ORDERFLOW_DUCKDB_MEMORY_LIMIT", "").strip()
    if mem:
        con.execute(f"SET memory_limit = '{mem}'")
    tmp = os.environ.get("ORDERFLOW_DUCKDB_TEMP_DIR", "").strip()
    if tmp:
        tmp_esc = tmp.replace("\\", "/")
        con.execute(f"SET temp_directory = '{tmp_esc}'")
    return con


def _profile_insert_chunk_rows() -> int:
    raw = os.environ.get("ORDERFLOW_DUCKDB_PROFILE_CHUNK", "").strip()
    if raw:
        try:
            return max(10_000, int(raw))
        except ValueError:
            pass
    return 250_000


def init_schema(con: duckdb.DuckDBPyConnection) -> None:
    """Idempotent CREATE TABLE / CREATE INDEX. Safe to call on every run.

    For databases created without newer columns we add them via
    ``ALTER TABLE ... ADD COLUMN IF NOT EXISTS``. ``bar_end_time``
    (exclusive bar end UTC, half-open with ``bar_time``) enables Phase 6
    HTF parent bias joins without fragile fixed ``INTERVAL`` widths.
    """
    for stmt in _SCHEMA_SQL:
        con.execute(stmt)
    # bar_end_time: exclusive end instant for Phase 6 HTF joins (upgrade-safe).
    for col_name, col_type in _BAR_SPAN_COLUMNS:
        con.execute(f"ALTER TABLE bars ADD COLUMN IF NOT EXISTS {col_name} {col_type}")
    # Phase 6 in-place upgrade for pre-existing databases.
    for col_name, col_type in _PHASE6_BAR_COLUMNS:
        con.execute(f"ALTER TABLE bars ADD COLUMN IF NOT EXISTS {col_name} {col_type}")
    for col_name, col_type in _BAR_REGIME_CONTINUOUS_COLUMNS:
        con.execute(f"ALTER TABLE bars ADD COLUMN IF NOT EXISTS {col_name} {col_type}")
    for col_name, col_type in _CVD_FLOW_BAR_COLUMNS:
        con.execute(f"ALTER TABLE bars ADD COLUMN IF NOT EXISTS {col_name} {col_type}")
    for col_name, col_type in _VELOCITY_BAR_COLUMNS:
        con.execute(f"ALTER TABLE bars ADD COLUMN IF NOT EXISTS {col_name} {col_type}")
    for col_name, col_type in _FIRE_DIAGNOSTIC_COLUMNS:
        con.execute(f"ALTER TABLE fires ADD COLUMN IF NOT EXISTS {col_name} {col_type}")
    for col_name, col_type in _BACKTEST_TRADE_COLUMNS:
        con.execute(f"ALTER TABLE backtest_trades ADD COLUMN IF NOT EXISTS {col_name} {col_type}")


def write_session(
    con: duckdb.DuckDBPyConnection,
    session_date: date,
    timeframe: str,
    bars_df: "pd.DataFrame",
    events_df: "pd.DataFrame",
    fires_df: "pd.DataFrame",
    profile_df: "pd.DataFrame",
    swing_df: "pd.DataFrame | None" = None,
    divergence_df: "pd.DataFrame | None" = None,
) -> None:
    """Replace all rows for `(session_date, timeframe)` across the four tables.

    Transactional: if any DELETE or INSERT fails, the whole write rolls back
    and no rows are left in an inconsistent state. Re-running on the same
    `(session_date, timeframe)` is therefore a true refresh — never a
    partial overwrite. Re-running one timeframe never disturbs another:
    every DELETE is keyed on `(session_date, timeframe)` so the other
    timeframes' rows for the same date stay intact.

    Expected DataFrame columns (all required, must match table column names):

        bars_df:    session_date, bar_time, bar_end_time, timeframe, open, high, low,
                    close, volume, delta, trade_count, large_print_count,
                    distinct_prices, range_pct, vpt, concentration, v_rank,
                    d_rank, vol_score, depth_score, vwap, top_cvd, bottom_cvd, top_cvd_norm, bottom_cvd_norm, cvd_imbalance, top_body_volume_ratio, bottom_body_volume_ratio, upper_wick_liquidity, lower_wick_liquidity, upper_wick_ticks, lower_wick_ticks, high_before_low, rejection_side, rejection_strength, rejection_type, bias_state, parent_1h_bias,
                    parent_15m_bias  (Phase 6 cols may be empty strings or
                    NULL during ingest; the bias-stamp pass + denorm pass
                    fill them after this write completes)
        events_df:  bar_time, timeframe, event_type, direction, price
        fires_df:   bar_time, timeframe, watch_id, direction, price,
                    outcome, outcome_resolved_at, diagnostic_version, diagnostics_json
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
            con.execute(
                "DELETE FROM swing_events WHERE timeframe = ? AND bar_time BETWEEN ? AND ?",
                [timeframe, t_lo, t_hi],
            )
            con.execute(
                "DELETE FROM divergence_events WHERE timeframe = ? AND session_date = ?",
                [timeframe, session_date],
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
            for col in (
                "bar_end_time", "vwap", "top_cvd", "bottom_cvd", "top_cvd_norm", "bottom_cvd_norm",
                "cvd_imbalance", "top_body_volume_ratio", "bottom_body_volume_ratio", "upper_wick_liquidity",
                "lower_wick_liquidity", "upper_wick_ticks", "lower_wick_ticks", "high_before_low",
                "rejection_side", "rejection_strength", "rejection_type", "bias_state", "parent_1h_bias",
                "parent_15m_bias", "vol_score", "depth_score", "session_cvd", "aggressive_buy_count",
                "aggressive_sell_count", "avg_aggressive_buy_size", "avg_aggressive_sell_size",
                "size_imbalance_ratio",
                "session_kind", "path_length_ticks", "vw_path_length", "displacement_ticks",
                "abs_displacement_ticks", "pld_ratio", "flip_count", "flip_rate",
                "jitter_regime", "conviction_regime", "trade_context",
            ):
                if col not in bars_df.columns:
                    bars_df[col] = None
            con.execute(
                """
                INSERT INTO bars
                    (session_date, bar_time, bar_end_time, timeframe, open, high, low, close,
                     volume, delta, trade_count, large_print_count,
                     distinct_prices, range_pct, vpt, concentration,
                     v_rank, d_rank, vol_score, depth_score,
                     vwap, top_cvd, bottom_cvd, top_cvd_norm, bottom_cvd_norm, cvd_imbalance, top_body_volume_ratio, bottom_body_volume_ratio, upper_wick_liquidity, lower_wick_liquidity, upper_wick_ticks, lower_wick_ticks, high_before_low, rejection_side, rejection_strength, rejection_type,
                     bias_state, parent_1h_bias, parent_15m_bias,
                     session_cvd, aggressive_buy_count, aggressive_sell_count,
                     avg_aggressive_buy_size, avg_aggressive_sell_size, size_imbalance_ratio,
                     session_kind, path_length_ticks, vw_path_length, displacement_ticks,
                     abs_displacement_ticks, pld_ratio, flip_count, flip_rate,
                     jitter_regime, conviction_regime, trade_context)
                SELECT session_date, bar_time, bar_end_time, timeframe, open, high, low, close,
                       volume, delta, trade_count, large_print_count,
                       distinct_prices, range_pct, vpt, concentration,
                       v_rank, d_rank, vol_score, depth_score,
                       vwap, top_cvd, bottom_cvd, top_cvd_norm, bottom_cvd_norm, cvd_imbalance, top_body_volume_ratio, bottom_body_volume_ratio, upper_wick_liquidity, lower_wick_liquidity, upper_wick_ticks, lower_wick_ticks, high_before_low, rejection_side, rejection_strength, rejection_type,
                       bias_state, parent_1h_bias, parent_15m_bias,
                       session_cvd, aggressive_buy_count, aggressive_sell_count,
                       avg_aggressive_buy_size, avg_aggressive_sell_size, size_imbalance_ratio,
                       session_kind, path_length_ticks, vw_path_length, displacement_ticks,
                       abs_displacement_ticks, pld_ratio, flip_count, flip_rate,
                       jitter_regime, conviction_regime, trade_context
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
            for col in ("diagnostic_version", "diagnostics_json"):
                if col not in fires_df.columns:
                    fires_df[col] = None
            con.execute(
                """
                INSERT INTO fires
                    (bar_time, timeframe, watch_id, direction, price, outcome,
                     outcome_resolved_at, diagnostic_version, diagnostics_json)
                SELECT bar_time, timeframe, watch_id, direction, price, outcome,
                       outcome_resolved_at, diagnostic_version, diagnostics_json
                FROM fires_df
                """
            )
        if len(profile_df) > 0:
            chunk_n = _profile_insert_chunk_rows()
            nprof = len(profile_df)
            if nprof <= chunk_n:
                con.execute(
                    """
                    INSERT INTO bar_volume_profile (bar_time, timeframe, price_tick, volume, delta)
                    SELECT bar_time, timeframe, price_tick, volume, delta FROM profile_df
                    """
                )
            else:
                for start in range(0, nprof, chunk_n):
                    sub = profile_df.iloc[start : start + chunk_n]
                    con.register("_bvp_chunk", sub)
                    try:
                        con.execute(
                            """
                            INSERT INTO bar_volume_profile (bar_time, timeframe, price_tick, volume, delta)
                            SELECT bar_time, timeframe, price_tick, volume, delta FROM _bvp_chunk
                            """
                        )
                    finally:
                        con.unregister("_bvp_chunk")
        if swing_df is not None and len(swing_df) > 0:
            con.execute(
                """
                INSERT INTO swing_events
                    (session_date, bar_time, timeframe, series_type, swing_value, swing_lookback)
                SELECT session_date, bar_time, timeframe, series_type, swing_value, swing_lookback
                FROM swing_df
                """
            )
        if divergence_df is not None and len(divergence_df) > 0:
            con.execute(
                """
                INSERT INTO divergence_events
                    (session_date, timeframe, div_kind, earlier_bar_time, later_bar_time,
                     earlier_price, later_price, earlier_cvd, later_cvd, bars_between,
                     size_confirmation, swing_lookback, min_price_delta, min_cvd_delta,
                     max_swing_bar_distance, earlier_size_imbalance_ratio, later_size_imbalance_ratio)
                SELECT session_date, timeframe, div_kind, earlier_bar_time, later_bar_time,
                       earlier_price, later_price, earlier_cvd, later_cvd, bars_between,
                       size_confirmation, swing_lookback, min_price_delta, min_cvd_delta,
                       max_swing_bar_distance, earlier_size_imbalance_ratio, later_size_imbalance_ratio
                FROM divergence_df
                """
            )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def replace_divergence_session(
    con: duckdb.DuckDBPyConnection,
    timeframe: str,
    session_date: date,
    divergence_df: "pd.DataFrame",
) -> None:
    """DELETE then INSERT divergence_events for one (timeframe, session_date).

    Used by ``recompute-divergences`` to refresh persisted divergences without
    touching bars, swings, or fires. Empty ``divergence_df`` clears divergences
    for that session slice (same semantics as ingest writing zero rows after delete).

    Expected columns match ``write_session`` divergence INSERT:
    session_date, timeframe, div_kind, earlier_bar_time, later_bar_time,
    earlier_price, later_price, earlier_cvd, later_cvd, bars_between,
    size_confirmation, swing_lookback, min_price_delta, min_cvd_delta,
    max_swing_bar_distance, earlier_size_imbalance_ratio, later_size_imbalance_ratio.
    """
    con.execute("BEGIN TRANSACTION")
    try:
        con.execute(
            "DELETE FROM divergence_events WHERE timeframe = ? AND session_date = ?",
            [timeframe, session_date],
        )
        if divergence_df is not None and len(divergence_df) > 0:
            con.execute(
                """
                INSERT INTO divergence_events
                    (session_date, timeframe, div_kind, earlier_bar_time, later_bar_time,
                     earlier_price, later_price, earlier_cvd, later_cvd, bars_between,
                     size_confirmation, swing_lookback, min_price_delta, min_cvd_delta,
                     max_swing_bar_distance, earlier_size_imbalance_ratio, later_size_imbalance_ratio)
                SELECT session_date, timeframe, div_kind, earlier_bar_time, later_bar_time,
                       earlier_price, later_price, earlier_cvd, later_cvd, bars_between,
                       size_confirmation, swing_lookback, min_price_delta, min_cvd_delta,
                       max_swing_bar_distance, earlier_size_imbalance_ratio, later_size_imbalance_ratio
                FROM divergence_df
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
    benchmark_points: list[dict[str, Any]] | None = None,
    skipped_fires: list[dict[str, Any]] | None = None,
) -> None:
    """Persist one backtest run plus its trades/equity timeline atomically."""
    con.execute("BEGIN TRANSACTION")
    try:
        con.execute("DELETE FROM backtest_runs WHERE run_id = ?", [run_row["run_id"]])
        con.execute("DELETE FROM backtest_trades WHERE run_id = ?", [run_row["run_id"]])
        con.execute("DELETE FROM backtest_equity WHERE run_id = ?", [run_row["run_id"]])
        con.execute("DELETE FROM backtest_benchmarks WHERE run_id = ?", [run_row["run_id"]])
        con.execute("DELETE FROM skipped_fires WHERE run_id = ?", [run_row["run_id"]])

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
                    commission, net_pnl, bars_held, exit_reason,
                    stop_loss_ticks_effective, take_profit_ticks_effective, slippage_to_stop_ratio
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        t.get("exit_reason"),
                        t.get("stop_loss_ticks_effective"),
                        t.get("take_profit_ticks_effective"),
                        t.get("slippage_to_stop_ratio"),
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

        if benchmark_points:
            con.executemany(
                """
                INSERT INTO backtest_benchmarks (
                    run_id, strategy, bar_time, equity
                )
                VALUES (?, ?, ?, ?)
                """,
                [
                    [
                        p["run_id"],
                        p["strategy"],
                        p["bar_time"],
                        p["equity"],
                    ]
                    for p in benchmark_points
                ],
            )

        if skipped_fires:
            con.executemany(
                """
                INSERT INTO skipped_fires (
                    run_id, bar_time, watch_id, direction, reason_code, price,
                    position_side_before, position_size_before, reason_detail_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    [
                        s["run_id"],
                        s["bar_time"],
                        s["watch_id"],
                        s.get("direction"),
                        s["reason_code"],
                        s.get("price"),
                        s.get("position_side_before"),
                        s.get("position_size_before"),
                        s.get("reason_detail_json"),
                    ]
                    for s in skipped_fires
                ],
            )

        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
