"""FastAPI app exposing read-only views of the orderflow DuckDB.

The aggregator (`pipeline/src/orderflow_pipeline/cli.py aggregate --db-path ...`)
is the only writer; this app is strictly read-only. Each endpoint opens a
short-lived DuckDB connection per request — DuckDB handles concurrent
readers natively, and per-request connections sidestep any thread-safety
landmines that would come from sharing a single connection across the
event loop.

Endpoints (regime-DB plan §1c, §1b'; Phase 5 timeframe extension):

    GET /timeframes
        Returns the timeframes present in the bars table (driven by
        SELECT DISTINCT). The dashboard uses this to populate the
        segmented selector and to validate `?timeframe=` URL params at
        bootstrap. Falls back to {"timeframes": ["1m"]} on an empty DB
        so the selector never disappears entirely.

    GET /sessions
        Lists distinct session_dates with bar_counts (metadata for timeline
        layout; no longer drives a session dropdown).

    GET /date-range?timeframe=
        Global MIN/MAX(bar_time) in `bars` for the timeframe (dashboard
        pan bounds).

    GET /bars?from=&to=&session_date=&timeframe=&cell=v,d&cell=...
        - `timeframe` (default '1m') scopes the query to one bin width.
        - `from`/`to` (or `session_date`) bound the time window. When
          `session_date` is provided, the resolved [lo, hi] window is
          taken from min/max bar_time at that (session_date, timeframe)
          pair so 15m / 1h sessions resolve to their own narrower window.
        - `cell=v,d` (repeatable, capped at 25 pairs) filters via DuckDB
          tuple-IN on (v_rank, d_rank). Composite index `idx_bars_tf_rank`
          on (timeframe, v_rank, d_rank) makes this an index probe.
        - JSON keys `volScore` / `depthScore` mirror DB `vol_score` /
          `depth_score` (scatter mid-rank track from `regime.compute_ranks`;
          requirements §4.3). Read-only: never derived in the API from
          `vRank`/`dRank`.

    GET /events?from=&to=&timeframe=&types=sweep,divergence&bar_times=t1,t2,...
        Optional `types` filters `event_type` (sweep, absorption, divergence,
        stoprun). Omitting `types` returns every type in the window.
    GET /fires?from=&to=&timeframe=
    GET /profile?from=&to=&session_date=&timeframe=
    GET /occupancy?from=&to=&session_date=&timeframe=
        Each gains the same `timeframe` query param (default '1m'). All
        SQL is filtered by `WHERE timeframe = ?` so a 15m bar at the same
        timestamp as a 1m bar is never accidentally double-counted.

    GET /profile + /occupancy use the per-timeframe min/max via the
    composite index `idx_bvp_tf_bar` on (timeframe, bar_time) for the
    profile aggregation.

CORS is open to `*` for local dev — when serving the dashboard via
`python -m http.server` on a different port, the browser blocks
cross-origin fetches without it.

Run:  uvicorn api.main:app --port 8001
"""
from __future__ import annotations

import os
import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
from pydantic import BaseModel, ConfigDict, Field

PIPELINE_SRC = (Path(__file__).resolve().parents[1] / "pipeline" / "src")
if str(PIPELINE_SRC) not in sys.path:
    sys.path.append(str(PIPELINE_SRC))


# Database path. Override via env var to point at a non-default DB file (e.g.
# during integration tests). The aggregator's `--db-path` flag should match.
DB_PATH = Path(os.environ.get("ORDERFLOW_DB_PATH", "data/orderflow.duckdb"))

# ES tick size — must match aggregate.TICK_SIZE. Recover prices from
# bar_volume_profile.price_tick as `price_tick * TICK_SIZE`.
TICK_SIZE = 0.25

# Value-area fraction. Mirrors src/config/constants.js#VA_FRACTION so the
# server-computed VAH/VAL match the existing client convention.
VA_FRACTION = 0.68

# Cap for the repeated `cell=v,d` parameter on /bars (saturation = 5x5 = 25).
MAX_CELL_PAIRS = 25
_CELL_RE = re.compile(r"^[1-5],[1-5]$")

# Phase 5 canonical timeframe set. Every endpoint that filters by
# `timeframe` validates against this allowlist before threading the value
# into a parameterized SQL query.
SUPPORTED_TIMEFRAMES = ("1m", "5m", "15m", "1h")
DEFAULT_TIMEFRAME = "1m"

# Event types stored in DuckDB `events.event_type` (see pipeline/db.py).
_EVENT_TYPES_ALLOWED = frozenset({"sweep", "absorption", "divergence", "stoprun"})
_WATCH_IDS_ALLOWED = frozenset({"breakout", "fade", "absorptionWall", "valueEdgeReject", "orb"})


app = FastAPI(
    title="Order Flow API",
    default_response_class=ORJSONResponse,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def _connect() -> duckdb.DuckDBPyConnection:
    """Open a fresh read-only DuckDB connection for one request.

    `read_only=True` is important: it lets DuckDB skip WAL setup and accept
    concurrent open() calls cleanly while the aggregator might also be
    holding the file open from a previous run. If the file is missing we
    surface a 503 so the dashboard's bootstrapFromApi can fall back to
    synthetic mode without a generic 500.
    """
    if not DB_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail=f"DuckDB file not found at {DB_PATH}. Run `orderflow_pipeline aggregate --db-path {DB_PATH}` first.",
        )
    return duckdb.connect(str(DB_PATH), read_only=True)


def _connect_rw() -> duckdb.DuckDBPyConnection:
    """Open a read-write connection (used by backtest run endpoint)."""
    if not DB_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail=f"DuckDB file not found at {DB_PATH}. Run `orderflow_pipeline aggregate --db-path {DB_PATH}` first.",
        )
    return duckdb.connect(str(DB_PATH))


def _validate_timeframe(tf: str | None) -> str:
    """Reject unknown timeframes; default to 1m when the param is absent.

    Defaulting to '1m' (rather than 400-ing on absence) keeps the API
    backward compatible with any caller that hasn't been updated for
    Phase 5 yet — the dashboard's old URLs still resolve to the same
    1m data they used to return. Unknown values are still 400'd because
    silently downgrading to 1m would mask client bugs.
    """
    if tf is None or tf == "":
        return DEFAULT_TIMEFRAME
    if tf not in SUPPORTED_TIMEFRAMES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid timeframe={tf!r}; expected one of {list(SUPPORTED_TIMEFRAMES)}.",
        )
    return tf


def _parse_iso(ts: str | None) -> datetime | None:
    if ts is None or ts == "":
        return None
    # Tolerate trailing 'Z' (UTC).
    s = ts.replace("Z", "+00:00") if ts.endswith("Z") else ts
    try:
        dt = datetime.fromisoformat(s)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid ISO timestamp: {ts!r}") from exc
    # DuckDB TIMESTAMP columns are tz-naive UTC. Convert any offset-aware
    # inputs to UTC first, then strip tzinfo. Using local time here shifts
    # windows by the machine offset and can make /profile appear empty.
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _parse_session_date(s: str | None) -> date | None:
    if s is None or s == "":
        return None
    try:
        return date.fromisoformat(s)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid session_date: {s!r}") from exc


def _resolve_window(
    con: duckdb.DuckDBPyConnection,
    from_: str | None,
    to: str | None,
    session_date: str | None,
    timeframe: str,
) -> tuple[datetime, datetime]:
    """Resolve the (lo, hi) TIMESTAMP window for the query.

    Phase 5: window resolution is scoped to `(session_date, timeframe)` so
    a 15m or 1h `session_date=` lookup returns that day's actual 15m / 1h
    range — not the wider 1m range — and the downstream BETWEEN clause
    works against the right number of bars.

    Precedence: `session_date` (if provided) > explicit (from, to). When
    `session_date` is given, we look up that day's actual min/max bar_time
    from the DB so the window is exactly the session's range. Returns a
    404 if `(session_date, timeframe)` has no rows.
    """
    if session_date:
        d = _parse_session_date(session_date)
        row = con.execute(
            "SELECT MIN(bar_time), MAX(bar_time) FROM bars "
            "WHERE session_date = ? AND timeframe = ?",
            [d, timeframe],
        ).fetchone()
        if row is None or row[0] is None:
            raise HTTPException(
                status_code=404,
                detail=f"No bars for session_date={session_date} timeframe={timeframe}",
            )
        return row[0], row[1]

    lo = _parse_iso(from_)
    hi = _parse_iso(to)
    if lo is None or hi is None:
        raise HTTPException(
            status_code=400,
            detail="Provide either ?session_date=YYYY-MM-DD or both ?from= and ?to= ISO timestamps.",
        )
    if lo > hi:
        raise HTTPException(status_code=400, detail="`from` must be <= `to`.")
    return lo, hi


def _parse_event_types_param(raw: str | None) -> list[str] | None:
    """Parse comma-separated event_type values for /events?types=.

    Returns None when omitted or empty → caller keeps all types.
    Raises HTTPException 400 on unknown tokens.
    """
    if raw is None or (isinstance(raw, str) and raw.strip() == ""):
        return None
    parts = [p.strip().lower() for p in raw.split(",") if p.strip()]
    if not parts:
        return None
    bad = [p for p in parts if p not in _EVENT_TYPES_ALLOWED]
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid types={raw!r}; each must be one of {sorted(_EVENT_TYPES_ALLOWED)}.",
        )
    # Dedupe preserving order
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _parse_cell_pairs(cells: list[str]) -> list[tuple[int, int]]:
    """Validate repeated `cell=v,d` query params.

    Each value must match `^[1-5],[1-5]$` (1-indexed v_rank, d_rank). Reject
    duplicates softly (dedupe), reject too many (>25 saturates the matrix
    and is almost certainly a programming error / DOS attempt). Returns the
    parsed (v, d) tuples for direct use in DuckDB tuple-IN bindings.
    """
    if not cells:
        return []
    if len(cells) > MAX_CELL_PAIRS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many cell= parameters ({len(cells)} > {MAX_CELL_PAIRS}).",
        )
    out: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    for c in cells:
        if not _CELL_RE.match(c):
            raise HTTPException(status_code=400, detail=f"Invalid cell={c!r}; expected 'v,d' with v,d in 1..5.")
        v_str, d_str = c.split(",")
        pair = (int(v_str), int(d_str))
        if pair not in seen:
            out.append(pair)
            seen.add(pair)
    return out


def _row_to_dict(cur: duckdb.DuckDBPyConnection) -> list[dict]:
    """Materialize the open cursor as list[dict] keyed on column names."""
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


# Phase 6: per-base-timeframe HTF projection list. Drives `_attach_htf_bias`
# for /bars, /events, /fires. Each tuple is (camelCase_json_key, db_column).
# 1m sees both 1h and 15m parents; 5m same as 1m; 15m only sees 1h; 1h has no parents.
HTF_LISTS_BY_BASE_TF: dict[str, tuple[tuple[str, str], ...]] = {
    "1m":  (("biasH1", "parent_1h_bias"), ("bias15m", "parent_15m_bias")),
    "5m":  (("biasH1", "parent_1h_bias"), ("bias15m", "parent_15m_bias")),
    "15m": (("biasH1", "parent_1h_bias"),),
    "1h":  (),
}


def _attach_htf_bias(row: dict, base_tf: str) -> dict:
    """Project denormalized parent_*_bias columns into camelCase JSON keys.

    The denormalization is performed by the writer (`cli.py
    _stamp_parent_bias`) at ingest time, so this helper is a pure
    projection — no read-time JOIN. The mapping per base timeframe lives
    in ``HTF_LISTS_BY_BASE_TF``.

    Returns a dict ready to be merged onto the bar / event / fire JSON
    shape; missing columns flow through as JSON null. For 1h rows the
    helper is a no-op (returns ``{}``) since 1h has no parents.
    """
    out: dict[str, str | None] = {}
    for json_key, db_col in HTF_LISTS_BY_BASE_TF.get(base_tf, ()):
        out[json_key] = row.get(db_col)
    return out


def _bar_to_json_shape(b: dict, tf: str = DEFAULT_TIMEFRAME) -> dict:
    """Coerce a DB row into the JSON-mode dashboard's bar shape.

    The API mode reuses every downstream JS module (priceChart, regime,
    canonical evaluators), so the shape MUST match what JSON-mode loads
    today: camelCase field names, ISO-Z timestamp, primitive number/null
    values. Phase-1 NULLs on rank columns flow through as JSON null.

    Phase 6 additions: ``vwap``, ``biasState`` (this bar's own bias on
    the active timeframe), ``barEndTime`` (exclusive end, from
    ``bars.bar_end_time``), and the projected HTF parent biases via
    ``_attach_htf_bias`` (``biasH1`` on 15m / 5m / 1m; ``bias15m`` on 5m / 1m only).
    """
    bt: datetime = b["bar_time"]
    shape = {
        "open":            b["open"],
        "high":            b["high"],
        "low":             b["low"],
        "close":           b["close"],
        "volume":          b["volume"],
        "delta":           b["delta"],
        "tradeCount":      b["trade_count"],
        "largePrintCount": b["large_print_count"],
        "avgTradeSize":    round(b["volume"] / b["trade_count"], 3) if b["trade_count"] else 0.0,
        "distinctPrices":  b["distinct_prices"],
        "vpt":             b["vpt"],
        "concentration":   b["concentration"],
        "rangePct":        b["range_pct"],
        "vRank":           b["v_rank"],
        "dRank":           b["d_rank"],
        "volScore":        b.get("vol_score"),
        "depthScore":      b.get("depth_score"),
        "vwap":            b.get("vwap"),
        "topCvd":          b.get("top_cvd"),
        "bottomCvd":       b.get("bottom_cvd"),
        "topCvdNorm":      b.get("top_cvd_norm"),
        "bottomCvdNorm":   b.get("bottom_cvd_norm"),
        "cvdImbalance":    b.get("cvd_imbalance"),
        "topBodyVolumeRatio": b.get("top_body_volume_ratio"),
        "bottomBodyVolumeRatio": b.get("bottom_body_volume_ratio"),
        "upperWickLiquidity": b.get("upper_wick_liquidity"),
        "lowerWickLiquidity": b.get("lower_wick_liquidity"),
        "upperWickTicks":   b.get("upper_wick_ticks"),
        "lowerWickTicks":   b.get("lower_wick_ticks"),
        "highBeforeLow":   b.get("high_before_low"),
        "rejectionSide":   b.get("rejection_side"),
        "rejectionStrength": b.get("rejection_strength"),
        "rejectionType":   b.get("rejection_type"),
        "biasState":       b.get("bias_state"),
        "sessionCvd":      b.get("session_cvd"),
        "aggressiveBuyCount": b.get("aggressive_buy_count"),
        "aggressiveSellCount": b.get("aggressive_sell_count"),
        "avgAggressiveBuySize": b.get("avg_aggressive_buy_size"),
        "avgAggressiveSellSize": b.get("avg_aggressive_sell_size"),
        "sizeImbalanceRatio": b.get("size_imbalance_ratio"),
        "time":            bt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "barEndTime": (
            b["bar_end_time"].strftime("%Y-%m-%dT%H:%M:%SZ")
            if b.get("bar_end_time") is not None
            else None
        ),
    }
    shape.update(_attach_htf_bias(b, tf))
    return shape


class BacktestRunRequest(BaseModel):
    """Broker numerics omitted from JSON use ``config/backtest_defaults.json`` (merge)."""

    model_config = ConfigDict(populate_by_name=True)

    timeframe: str | None = Field(default=None)
    from_: str = Field(alias="from")
    to: str
    initial_capital: float | None = None
    qty: int | None = None
    slippage_ticks: float | None = None
    commission_per_side: float | None = None
    tick_size: float | None = None
    point_value: float | None = None
    # Run-wide exit override in ticks (None => use strategy timeframe/watch defaults, or flip-only if those are None).
    stop_loss_ticks: float | None = None
    take_profit_ticks: float | None = None
    regime_exit_scale_enabled: bool | None = None
    regime_exit_scale_mode: str | None = None
    regime_sl_mult_min: float | None = None
    regime_sl_mult_max: float | None = None
    regime_tp_mult_min: float | None = None
    regime_tp_mult_max: float | None = None
    regime_sl_floor_ticks: float | None = None
    regime_v_rank_sl_mults: list[float] | None = None
    regime_v_rank_tp_mults: list[float] | None = None
    ignore_same_side_fire_when_open: bool | None = None
    flip_on_opposite_fire: bool | None = None
    exit_on_stop_loss: bool | None = None
    exit_on_take_profit: bool | None = None
    close_at_end_of_window: bool | None = None
    entry_next_bar_open: bool | None = None
    entry_gap_guard_max_ticks: float | None = None
    watch_ids: list[str] | None = None
    use_regime_filter: bool = True
    null_hypothesis: bool = False
    null_hypothesis_seed: int | None = None


# ───────────────────────────────────────────────────────────
# Endpoints
# ───────────────────────────────────────────────────────────


@app.get("/timeframes")
def get_timeframes() -> dict:
    """List timeframes actually present in the bars table.

    The dashboard's segmented control is populated from this response, so
    a partial rebuild that wrote only '1m' rows still produces a usable
    UI — the user just sees a single button. We always include '1m' in
    the fallback for `bars` table empty edge case so the selector exists
    on first paint.
    """
    con = _connect()
    try:
        rows = con.execute(
            "SELECT DISTINCT timeframe FROM bars ORDER BY 1"
        ).fetchall()
    finally:
        con.close()

    found = [r[0] for r in rows]
    if not found:
        return {"timeframes": [DEFAULT_TIMEFRAME]}
    # Order canonically (1m / 5m / 15m / 1h) regardless of DuckDB's lexical
    # sort, so the dashboard's selector buttons are stable across rebuilds.
    canonical = [tf for tf in SUPPORTED_TIMEFRAMES if tf in found]
    extras = [tf for tf in found if tf not in SUPPORTED_TIMEFRAMES]
    return {"timeframes": canonical + extras}


@app.get("/sessions")
def get_sessions() -> dict:
    """List every distinct session_date with its per-timeframe bar counts.

    Phase 5: `bar_counts` is a dict keyed on timeframe so one call
    populates the status banner regardless of which timeframe is
    currently active in the dashboard. `session_start` / `session_end`
    are taken across ALL timeframes for the date — they bound the
    underlying RTH session and are therefore timeframe-agnostic.

    Sorted ascending by date so the JS bootstrap concatenates timelines
    in chronological order without re-sorting on its side.
    """
    con = _connect()
    try:
        rows = con.execute(
            """
            SELECT session_date,
                   timeframe,
                   COUNT(*)         AS bar_count,
                   MIN(bar_time)    AS session_start,
                   MAX(bar_time)    AS session_end
            FROM bars
            GROUP BY session_date, timeframe
            ORDER BY session_date, timeframe
            """
        ).fetchall()
    finally:
        con.close()

    by_date: dict[Any, dict] = {}
    for d, tf, n, lo, hi in rows:
        key = d
        entry = by_date.get(key)
        if entry is None:
            entry = {
                "session_date":  d.isoformat() if isinstance(d, date) else str(d),
                "bar_counts":    {},
                "session_start": None,
                "session_end":   None,
            }
            by_date[key] = entry
        entry["bar_counts"][tf] = int(n)
        # Widen the start/end window across all timeframes so the dashboard
        # can use it as the day's RTH bounds regardless of active tf.
        lo_iso = lo.strftime("%Y-%m-%dT%H:%M:%SZ") if lo else None
        hi_iso = hi.strftime("%Y-%m-%dT%H:%M:%SZ") if hi else None
        if lo_iso and (entry["session_start"] is None or lo_iso < entry["session_start"]):
            entry["session_start"] = lo_iso
        if hi_iso and (entry["session_end"] is None or hi_iso > entry["session_end"]):
            entry["session_end"] = hi_iso

    sessions = sorted(by_date.values(), key=lambda s: s["session_date"])
    # Backward-compat: also publish a single `bar_count` derived from the
    # 1m timeframe (or the first available) so any caller that hasn't been
    # updated keeps getting a usable scalar.
    for s in sessions:
        bc: dict = s["bar_counts"]
        s["bar_count"] = int(bc.get(DEFAULT_TIMEFRAME, next(iter(bc.values()), 0)))
    return {"sessions": sessions}


@app.get("/date-range")
def get_date_range(timeframe: str | None = Query(default=None)) -> dict:
    """Min/max bar_time across all rows in `bars` for this timeframe."""
    tf = _validate_timeframe(timeframe)
    con = _connect()
    try:
        row = con.execute(
            "SELECT MIN(bar_time), MAX(bar_time) FROM bars WHERE timeframe = ?",
            [tf],
        ).fetchone()
    finally:
        con.close()
    if row is None or row[0] is None:
        return {"timeframe": tf, "min": None, "max": None}
    lo, hi = row[0], row[1]
    return {
        "timeframe": tf,
        "min": lo.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "max": hi.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


@app.get("/bars")
def get_bars(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    session_date: str | None = Query(default=None),
    timeframe: str | None = Query(default=None),
    cell: list[str] = Query(default=[]),
) -> dict:
    """Return bars in [from, to] (or for `session_date`), shaped like JSON mode.

    Phase 5: every query is scoped to `timeframe` (default '1m'). The
    composite index `idx_bars_tf_rank` on (timeframe, v_rank, d_rank)
    makes the tuple-IN cell brushing an index probe rather than a scan.
    """
    tf = _validate_timeframe(timeframe)
    con = _connect()
    try:
        lo, hi = _resolve_window(con, from_, to, session_date, tf)
        pairs = _parse_cell_pairs(cell)

        sql = "SELECT * FROM bars WHERE timeframe = ? AND bar_time BETWEEN ? AND ?"
        params: list[Any] = [tf, lo, hi]
        if pairs:
            placeholders = ",".join(["(?,?)"] * len(pairs))
            sql += f" AND (v_rank, d_rank) IN ({placeholders})"
            for p in pairs:
                params.extend(p)
        sql += " ORDER BY bar_time"

        rows = _row_to_dict(con.execute(sql, params))
    finally:
        con.close()
    return {
        "from":         lo.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "to":           hi.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_date": session_date,
        "timeframe":    tf,
        "cells":        [list(p) for p in pairs],
        "bars":         [_bar_to_json_shape(r, tf) for r in rows],
    }


@app.get("/events")
def get_events(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    timeframe: str | None = Query(default=None),
    bar_times: str | None = Query(default=None),
    types: str | None = Query(default=None),
) -> dict:
    """Return events in [from, to] OR at exact bar_times (comma-separated ISO).

    Phase 4a uses `bar_times=` to filter the event log to a brushed
    selection. Either filter mode is valid — they don't combine. Phase 5
    additionally scopes by `timeframe` so a brushed window at 15m doesn't
    pick up 1m events at the same instant.

    Optional ``types`` limits to ``event_type`` values: sweep, absorption,
    divergence, stoprun (DuckDB ``events.event_type``). Omit to return every type.
    """
    tf = _validate_timeframe(timeframe)
    type_filter = _parse_event_types_param(types)
    placeholders_types = ""
    type_params: list[Any] = []
    if type_filter is not None:
        ph = ",".join(["?"] * len(type_filter))
        placeholders_types = f" AND e.event_type IN ({ph})"
        type_params = list(type_filter)

    con = _connect()
    # Phase 6: LEFT JOIN to bars on the composite (timeframe, bar_time) key
    # to surface bias_state + parent_*_bias for every event. The JOIN is
    # an index probe via `idx_bars_tf_bartime`, so it adds negligible
    # latency over the simple SELECT.
    base_select = (
        "SELECT e.bar_time, e.event_type, e.direction, e.price, "
        "       b.bias_state, b.parent_1h_bias, b.parent_15m_bias "
        "FROM events e "
        "LEFT JOIN bars b ON b.bar_time = e.bar_time AND b.timeframe = e.timeframe "
    )
    try:
        if bar_times:
            ts_list = [_parse_iso(t.strip()) for t in bar_times.split(",") if t.strip()]
            if not ts_list:
                return {"events": [], "timeframe": tf}
            placeholders = ",".join(["?"] * len(ts_list))
            rows = _row_to_dict(con.execute(
                base_select +
                f"WHERE e.timeframe = ? AND e.bar_time IN ({placeholders})"
                f"{placeholders_types} ORDER BY e.bar_time",
                [tf, *ts_list, *type_params],
            ))
        else:
            lo = _parse_iso(from_)
            hi = _parse_iso(to)
            if lo is None or hi is None:
                raise HTTPException(status_code=400, detail="Provide ?from= and ?to= or ?bar_times=.")
            rows = _row_to_dict(con.execute(
                base_select +
                "WHERE e.timeframe = ? AND e.bar_time BETWEEN ? AND ?"
                f"{placeholders_types} ORDER BY e.bar_time",
                [tf, lo, hi, *type_params],
            ))
    finally:
        con.close()
    return {
        "timeframe": tf,
        "events": [
            {
                "time":      r["bar_time"].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "type":      r["event_type"],
                "dir":       r["direction"],
                "price":     r["price"],
                "biasState": r.get("bias_state"),
                **_attach_htf_bias(r, tf),
            }
            for r in rows
        ]
    }


@app.get("/swing-events")
def get_swing_events(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    timeframe: str | None = Query(default=None),
) -> dict:
    """Persisted fractal swings on price and session CVD (per pipeline ingest K)."""
    tf = _validate_timeframe(timeframe)
    con = _connect()
    try:
        lo = _parse_iso(from_)
        hi = _parse_iso(to)
        if lo is None or hi is None:
            raise HTTPException(status_code=400, detail="Provide ?from= and ?to=.")
        rows = _row_to_dict(
            con.execute(
                """
                SELECT session_date, bar_time, timeframe, series_type, swing_value, swing_lookback
                FROM swing_events
                WHERE timeframe = ? AND bar_time BETWEEN ? AND ?
                ORDER BY bar_time, series_type
                """,
                [tf, lo, hi],
            )
        )
    finally:
        con.close()
    out = []
    for r in rows:
        out.append(
            {
                "sessionDate": str(r["session_date"]),
                "time": r["bar_time"].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "seriesType": r["series_type"],
                "swingValue": r["swing_value"],
                "swingLookback": int(r["swing_lookback"]),
            }
        )
    return {"timeframe": tf, "swings": out}


@app.get("/divergence-events")
def get_divergence_events(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    timeframe: str | None = Query(default=None),
) -> dict:
    """Persisted CVD–price divergence rows (bearish / bullish) with ingest thresholds."""
    tf = _validate_timeframe(timeframe)
    con = _connect()
    try:
        lo = _parse_iso(from_)
        hi = _parse_iso(to)
        if lo is None or hi is None:
            raise HTTPException(status_code=400, detail="Provide ?from= and ?to=.")
        rows = _row_to_dict(
            con.execute(
                """
                SELECT session_date, timeframe, div_kind, earlier_bar_time, later_bar_time,
                       earlier_price, later_price, earlier_cvd, later_cvd, bars_between,
                       size_confirmation, swing_lookback, min_price_delta, min_cvd_delta,
                       max_swing_bar_distance, earlier_size_imbalance_ratio, later_size_imbalance_ratio
                FROM divergence_events
                WHERE timeframe = ?
                  AND later_bar_time BETWEEN ? AND ?
                ORDER BY later_bar_time
                """,
                [tf, lo, hi],
            )
        )
    finally:
        con.close()
    out = []
    for r in rows:
        out.append(
            {
                "sessionDate": str(r["session_date"]),
                "kind": r["div_kind"],
                "earlierTime": r["earlier_bar_time"].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "laterTime": r["later_bar_time"].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "earlierPrice": r["earlier_price"],
                "laterPrice": r["later_price"],
                "earlierCvd": r["earlier_cvd"],
                "laterCvd": r["later_cvd"],
                "barsBetween": r["bars_between"],
                "sizeConfirmation": bool(r["size_confirmation"]),
                "swingLookback": int(r["swing_lookback"]),
                "minPriceDelta": r["min_price_delta"],
                "minCvdDelta": int(r["min_cvd_delta"]),
                "maxSwingBarDistance": int(r["max_swing_bar_distance"]),
                "earlierSizeImbalanceRatio": r.get("earlier_size_imbalance_ratio"),
                "laterSizeImbalanceRatio": r.get("later_size_imbalance_ratio"),
            }
        )
    return {"timeframe": tf, "divergences": out}


@app.get("/fires")
def get_fires(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    timeframe: str | None = Query(default=None),
    include_diagnostics: int = Query(default=0, alias="includeDiagnostics"),
) -> dict:
    """Return fires in [from, to]. Mirrors the JS canonicalFires shape.

    Phase 5: scoped by `timeframe` so a 15m fire timeline isn't polluted
    with 1m fires at the same bar_time instant.
    """
    tf = _validate_timeframe(timeframe)
    con = _connect()
    try:
        lo = _parse_iso(from_)
        hi = _parse_iso(to)
        if lo is None or hi is None:
            raise HTTPException(status_code=400, detail="Provide ?from= and ?to=.")
        # Phase 6: LEFT JOIN bars for bias_state + parent_*_bias.
        diag_select = ", f.diagnostic_version, f.diagnostics_json" if include_diagnostics else ""
        rows = _row_to_dict(con.execute(
            "SELECT f.bar_time, f.watch_id, f.direction, f.price, f.outcome, f.outcome_resolved_at, "
            "       b.bias_state, b.parent_1h_bias, b.parent_15m_bias"
            + diag_select +
            " FROM fires f "
            "LEFT JOIN bars b ON b.bar_time = f.bar_time AND b.timeframe = f.timeframe "
            "WHERE f.timeframe = ? AND f.bar_time BETWEEN ? AND ? ORDER BY f.bar_time",
            [tf, lo, hi],
        ))
    finally:
        con.close()
    return {
        "timeframe": tf,
        "fires": [
            ({
                "barTime":   r["bar_time"].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "watchId":   r["watch_id"],
                "direction": r["direction"],
                "price":     r["price"],
                "outcome":   r["outcome"],
                "outcomeResolvedAt": (
                    r["outcome_resolved_at"].strftime("%Y-%m-%dT%H:%M:%SZ")
                    if r["outcome_resolved_at"] else None
                ),
                "biasState": r.get("bias_state"),
                **_attach_htf_bias(r, tf),
            } | (
                {
                    "diagnosticVersion": r.get("diagnostic_version"),
                    "diagnostics": (json.loads(r["diagnostics_json"]) if r.get("diagnostics_json") else None),
                }
                if include_diagnostics
                else {}
            ))
            for r in rows
        ]
    }


@app.get("/profile")
def get_profile(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    session_date: str | None = Query(default=None),
    timeframe: str | None = Query(default=None),
) -> dict:
    """True tick-level volume profile from `bar_volume_profile`.

    Phase 5: scoped to `timeframe` so the per-tick aggregation reflects
    the active timeframe's bar grid (1m / 5m / 15m / 1h all share bin-start
    instants but the per-bar volume profile rows are stored per-tf for
    composite-PK uniqueness). At the resolution of "all bars in window",
    the visual profile is dominated by total volume and looks similar
    across timeframes — but the per-tf scoping is correct semantically.
    """
    tf = _validate_timeframe(timeframe)
    con = _connect()
    try:
        lo, hi = _resolve_window(con, from_, to, session_date, tf)
        rows = con.execute(
            """
            SELECT price_tick, SUM(volume) AS volume, SUM(delta) AS delta
            FROM bar_volume_profile
            WHERE timeframe = ? AND bar_time BETWEEN ? AND ?
            GROUP BY price_tick
            ORDER BY price_tick
            """,
            [tf, lo, hi],
        ).fetchall()
    finally:
        con.close()

    if not rows:
        return {
            "from":          lo.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "to":            hi.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "session_date":  session_date,
            "timeframe":     tf,
            "ticks":         [],
            "total_volume":  0,
            "bins":          [],
            "binStep":       TICK_SIZE,
            "priceLo":       None,
            "priceHi":       None,
            "pocPrice":      None,
            "valPrice":      None,
            "vahPrice":      None,
            "maxBin":        0,
            "pocTick":       None,
            "vahTick":       None,
            "valTick":       None,
        }

    ticks_raw = [
        {"price_tick": int(t), "volume": int(v), "delta": int(d)}
        for (t, v, d) in rows
    ]
    lo_tick = ticks_raw[0]["price_tick"]
    hi_tick = ticks_raw[-1]["price_tick"]
    bin_count = hi_tick - lo_tick + 1
    bins = [0.0] * bin_count
    deltas = [0] * bin_count
    for r in ticks_raw:
        i = r["price_tick"] - lo_tick
        bins[i] = float(r["volume"])
        deltas[i] = r["delta"]

    total_volume = int(sum(r["volume"] for r in ticks_raw))

    poc_idx = 0
    for i in range(1, bin_count):
        if bins[i] > bins[poc_idx]:
            poc_idx = i
    poc_tick = lo_tick + poc_idx

    target = total_volume * VA_FRACTION
    acc = bins[poc_idx]
    lo_i = hi_i = poc_idx
    while acc < target and (lo_i > 0 or hi_i < bin_count - 1):
        up_next = bins[hi_i + 1] if hi_i < bin_count - 1 else -1.0
        dn_next = bins[lo_i - 1] if lo_i > 0 else -1.0
        if up_next >= dn_next and hi_i < bin_count - 1:
            hi_i += 1
            acc += bins[hi_i]
        elif lo_i > 0:
            lo_i -= 1
            acc += bins[lo_i]
        else:
            break

    val_tick = lo_tick + lo_i
    vah_tick = lo_tick + hi_i

    price_lo = lo_tick * TICK_SIZE
    price_hi = (hi_tick + 1) * TICK_SIZE

    return {
        "from":          lo.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "to":            hi.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_date":  session_date,
        "timeframe":     tf,
        "ticks":         ticks_raw,
        "total_volume":  total_volume,
        "bins":          bins,
        "deltas":        deltas,
        "binStep":       TICK_SIZE,
        "priceLo":       price_lo,
        "priceHi":       price_hi,
        "pocPrice":      poc_tick * TICK_SIZE + TICK_SIZE / 2,
        "valPrice":      val_tick * TICK_SIZE,
        "vahPrice":      (vah_tick + 1) * TICK_SIZE,
        "maxBin":        max(bins) if bins else 0.0,
        "pocTick":       poc_tick,
        "vahTick":       vah_tick,
        "valTick":       val_tick,
    }


@app.get("/occupancy")
def get_occupancy(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    session_date: str | None = Query(default=None),
    timeframe: str | None = Query(default=None),
) -> ORJSONResponse:
    """5x5 cell occupancy over the [from, to] (or session_date) window.

    Phase 5: filtered by `timeframe`. Uses the composite index
    `idx_bars_tf_rank` on (timeframe, v_rank, d_rank), which makes the
    GROUP BY an index probe.

    Cache-Control:
      - Fixed historical windows (`from` & `to` both provided) → `max-age=60`,
        because the underlying bars are immutable once a session is
        aggregated. Browser-cache hit serves repeat scrubs / range toggles
        instantly without re-hitting the API.
      - Cursor-driven windows (Last hour / Current session, where the
        client passes `session_date` or a moving `to`) ⇒ `no-cache`.
    """
    tf = _validate_timeframe(timeframe)
    con = _connect()
    try:
        lo, hi = _resolve_window(con, from_, to, session_date, tf)
        rows = con.execute(
            """
            SELECT v_rank, d_rank, COUNT(*) AS occupancy
            FROM bars
            WHERE timeframe = ?
              AND bar_time BETWEEN ? AND ?
              AND v_rank IS NOT NULL
              AND d_rank IS NOT NULL
            GROUP BY v_rank, d_rank
            """,
            [tf, lo, hi],
        ).fetchall()
    finally:
        con.close()

    cells = [
        {"v_rank": int(v), "d_rank": int(d), "occupancy": int(n)}
        for (v, d, n) in rows
    ]
    total = sum(c["occupancy"] for c in cells)

    body = {
        "from":         lo.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "to":           hi.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_date": session_date,
        "timeframe":    tf,
        "total_bars":   total,
        "cells":        cells,
    }
    headers = {
        "Cache-Control": "no-cache" if session_date else "public, max-age=60",
    }
    return ORJSONResponse(content=body, headers=headers)


@app.get("/api/backtest/defaults")
def get_backtest_defaults() -> ORJSONResponse:
    """Expose merged broker economics for dashboards and scripted clients."""

    from orderflow_pipeline.backtest_defaults import (
        effective_broker_defaults,
        effective_execution_policy_defaults,
        resolve_backtest_defaults_path_str,
    )

    return ORJSONResponse(
        content={
            "broker": effective_broker_defaults(),
            "execution": effective_execution_policy_defaults(),
            "resolvedPath": resolve_backtest_defaults_path_str(),
        },
        headers={"Cache-Control": "no-store, must-revalidate"},
    )


@app.post("/api/backtest/run")
def run_backtest(payload: BacktestRunRequest) -> dict:
    from orderflow_pipeline.backtest_defaults import (
        merged_broker_config_from_request_payload,
        merged_execution_policy_from_request_payload,
    )
    from orderflow_pipeline.backtest_engine import BacktestEngine
    from orderflow_pipeline.db import init_schema

    tf = _validate_timeframe(payload.timeframe)
    from_dt = _parse_iso(payload.from_)
    to_dt = _parse_iso(payload.to)
    if from_dt is None or to_dt is None:
        raise HTTPException(status_code=400, detail="Provide `from` and `to` ISO timestamps.")
    if from_dt > to_dt:
        raise HTTPException(status_code=400, detail="`from` must be <= `to`.")
    watch_ids = payload.watch_ids or []
    bad_watch = [w for w in watch_ids if w not in _WATCH_IDS_ALLOWED]
    if bad_watch:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid watch_ids={bad_watch}; allowed={sorted(_WATCH_IDS_ALLOWED)}",
        )
    if watch_ids and "orb" in watch_ids and tf != "5m":
        raise HTTPException(
            status_code=400,
            detail="watch_ids includes `orb`; timeframe must be 5m.",
        )

    con = _connect_rw()
    try:
        init_schema(con)
        engine = BacktestEngine(con)
        dumped = payload.model_dump(exclude_unset=True)
        broker_cfg = merged_broker_config_from_request_payload(dumped)
        exec_policy = merged_execution_policy_from_request_payload(dumped)
        try:
            exec_policy.validate()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if broker_cfg.stop_loss_ticks is not None and broker_cfg.stop_loss_ticks < 0:
            raise HTTPException(
                status_code=400,
                detail="stop_loss_ticks must be >= 0 (use a positive tick distance from entry on the "
                "adverse side, not a signed offset like some order tickets).",
            )
        if broker_cfg.take_profit_ticks is not None and broker_cfg.take_profit_ticks < 0:
            raise HTTPException(
                status_code=400,
                detail="take_profit_ticks must be >= 0 (positive tick distance to the profit target).",
            )

        mode_norm = (broker_cfg.regime_exit_scale_mode or "").strip().lower()
        if mode_norm not in ("range_pct", "v_rank"):
            raise HTTPException(
                status_code=400,
                detail="regime_exit_scale_mode must be 'range_pct' or 'v_rank'.",
            )
        if broker_cfg.regime_sl_mult_max < broker_cfg.regime_sl_mult_min:
            raise HTTPException(
                status_code=400,
                detail="regime_sl_mult_max must be >= regime_sl_mult_min.",
            )
        if broker_cfg.regime_tp_mult_max < broker_cfg.regime_tp_mult_min:
            raise HTTPException(
                status_code=400,
                detail="regime_tp_mult_max must be >= regime_tp_mult_min.",
            )
        if broker_cfg.regime_sl_floor_ticks is not None and broker_cfg.regime_sl_floor_ticks < 0:
            raise HTTPException(
                status_code=400,
                detail="regime_sl_floor_ticks must be >= 0 when set.",
            )

        if payload.null_hypothesis:
            if not payload.use_regime_filter:
                raise HTTPException(
                    status_code=400,
                    detail="null_hypothesis requires use_regime_filter=true (regime ON baseline).",
                )
            if len(watch_ids) != 1:
                raise HTTPException(
                    status_code=400,
                    detail="null_hypothesis requires exactly one watch in scope.",
                )
            if watch_ids and "orb" in watch_ids:
                raise HTTPException(
                    status_code=400,
                    detail="null_hypothesis is not supported for scope `orb`.",
                )

        summary = engine.run(
            timeframe=tf,
            from_time=from_dt,
            to_time=to_dt,
            config=broker_cfg,
            execution_policy=exec_policy,
            watch_ids=set(watch_ids) if watch_ids else None,
            use_regime_filter=bool(payload.use_regime_filter),
        )

        if not payload.null_hypothesis:
            return summary

        from orderflow_pipeline.null_hypothesis import (
            effective_seed_from_baseline_run_id,
            run_null_hypothesis_parity_loop,
        )
        from orderflow_pipeline.strategies.legacy_fallback_logic import config_for_timeframe

        n_trades = int(summary["tradeCount"])
        if n_trades == 0:
            return {
                **summary,
                "nullHypothesis": {"skipped": True, "reason": "baseline_zero_trades"},
            }

        bars = engine._load_bars(tf, from_dt, to_dt)
        strat_cfg = config_for_timeframe(tf, use_regime_filter=True)
        wid = watch_ids[0]
        eff_seed = effective_seed_from_baseline_run_id(
            summary["runId"], override=payload.null_hypothesis_seed
        )

        def simulate_trade_count(fires_by_time):
            closed, _, _ = engine._simulate(
                bars,
                fires_by_time,
                timeframe=tf,
                config=broker_cfg,
                policy=exec_policy,
            )
            return len(closed)

        try:
            nh_fires, nh_diag = run_null_hypothesis_parity_loop(
                bars=bars,
                cfg=strat_cfg,
                watch_id=wid,
                baseline_trade_count=n_trades,
                baseline_run_id=summary["runId"],
                effective_seed=eff_seed,
                cooldown_bars=strat_cfg.cooldown_bars,
                simulate_trade_count=simulate_trade_count,
                entry_next_bar_open=bool(exec_policy.entry_next_bar_open),
                tick_size=float(broker_cfg.tick_size),
                gap_max_ticks=exec_policy.entry_gap_guard_max_ticks,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        nh_meta_extra = {
            "is_null_hypothesis": True,
            "baseline_run_id": summary["runId"],
            "null_hypothesis_seed": eff_seed,
            "matched_trade_count": n_trades,
            "nh_scheduled_fire_count": nh_diag["nh_scheduled_fire_count"],
            "parity_iterations": nh_diag["parity_iterations"],
            "eligible_bar_count": nh_diag["eligible_bar_count"],
            "max_schedulable_fires": nh_diag["max_schedulable_fires"],
            "parity_variants_per_k": nh_diag["parity_variants_per_k"],
            "parity_placement_styles": nh_diag["parity_placement_styles"],
        }
        nh_summary = engine.run(
            timeframe=tf,
            from_time=from_dt,
            to_time=to_dt,
            config=broker_cfg,
            execution_policy=exec_policy,
            watch_ids={wid},
            use_regime_filter=True,
            fires_by_time=nh_fires,
            signal_source="null_hypothesis",
            metadata_extra=nh_meta_extra,
        )
        return {
            **summary,
            "nullHypothesis": {
                **nh_summary,
                "nullHypothesisSeed": eff_seed,
                "skipped": False,
            },
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        con.close()


@app.get("/api/backtest/stats")
def get_backtest_stats(run_id: str | None = Query(default=None, alias="runId")) -> dict:
    con = _connect()
    try:
        if run_id:
            row = con.execute(
                """
                SELECT run_id, created_at, timeframe, from_time, to_time, initial_capital,
                       trade_count, win_rate, sharpe, max_drawdown, net_pnl
                FROM backtest_runs
                WHERE run_id = ?
                """,
                [run_id],
            ).fetchone()
        else:
            row = con.execute(
                """
                SELECT run_id, created_at, timeframe, from_time, to_time, initial_capital,
                       trade_count, win_rate, sharpe, max_drawdown, net_pnl
                FROM backtest_runs
                ORDER BY created_at DESC
                LIMIT 1
                """
            ).fetchone()
    finally:
        con.close()
    if row is None:
        raise HTTPException(status_code=404, detail="No backtest runs found.")
    return {
        "runId": row[0],
        "createdAt": row[1].strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timeframe": row[2],
        "from": row[3].strftime("%Y-%m-%dT%H:%M:%SZ"),
        "to": row[4].strftime("%Y-%m-%dT%H:%M:%SZ"),
        "initialCapital": row[5],
        "tradeCount": row[6],
        "winRate": row[7],
        "sharpe": row[8],
        "maxDrawdown": row[9],
        "netPnl": row[10],
    }


@app.get("/api/backtest/equity")
def get_backtest_equity(run_id: str | None = Query(default=None, alias="runId")) -> dict:
    con = _connect()
    try:
        rid = run_id
        if rid is None:
            latest = con.execute(
                "SELECT run_id FROM backtest_runs ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            rid = latest[0] if latest else None
        if rid is None:
            raise HTTPException(status_code=404, detail="No backtest runs found.")
        rows = con.execute(
            """
            SELECT bar_time, equity, cash, unrealized_pnl, realized_pnl
            FROM backtest_equity
            WHERE run_id = ?
            ORDER BY bar_time
            """,
            [rid],
        ).fetchall()
        bench_rows = con.execute(
            """
            SELECT strategy, bar_time, equity
            FROM backtest_benchmarks
            WHERE run_id = ? AND strategy = 'buy_hold'
            ORDER BY bar_time
            """,
            [rid],
        ).fetchall()
    finally:
        con.close()
    return {
        "runId": rid,
        "points": [
            {
                "time": r[0].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "equity": r[1],
                "cash": r[2],
                "unrealizedPnl": r[3],
                "realizedPnl": r[4],
            }
            for r in rows
        ],
        "benchmark": {
            "strategy": "buy_hold",
            "points": [
                {
                    "time": r[1].strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "equity": r[2],
                }
                for r in bench_rows
            ],
        },
    }


@app.get("/api/backtest/trades")
def get_backtest_trades(run_id: str | None = Query(default=None, alias="runId")) -> dict:
    con = _connect()
    try:
        rid = run_id
        if rid is None:
            latest = con.execute(
                "SELECT run_id FROM backtest_runs ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            rid = latest[0] if latest else None
        if rid is None:
            raise HTTPException(status_code=404, detail="No backtest runs found.")
        rows = con.execute(
            """
            SELECT trade_id, watch_id, entry_time, exit_time, direction, qty,
                   entry_price, exit_price, gross_pnl, commission, net_pnl, bars_held,
                   exit_reason,
                   stop_loss_ticks_effective, take_profit_ticks_effective, slippage_to_stop_ratio
            FROM backtest_trades
            WHERE run_id = ?
            ORDER BY trade_id
            """,
            [rid],
        ).fetchall()
    finally:
        con.close()
    trades_out: list[dict] = []
    for r in rows:
        item = {
            "tradeId": r[0],
            "watchId": r[1],
            "entryTime": r[2].strftime("%Y-%m-%dT%H:%M:%SZ"),
            "exitTime": r[3].strftime("%Y-%m-%dT%H:%M:%SZ"),
            "entryEvent": "ENTRY",
            "exitEvent": "EXIT",
            "direction": r[4],
            "qty": r[5],
            "entryPrice": r[6],
            "exitPrice": r[7],
            "grossPnl": r[8],
            "commission": r[9],
            "netPnl": r[10],
            "barsHeld": r[11],
            "exitReason": r[12],
        }
        if r[13] is not None:
            item["stopLossTicksEffective"] = r[13]
        if r[14] is not None:
            item["takeProfitTicksEffective"] = r[14]
        if r[15] is not None:
            item["slippageToStopRatio"] = r[15]
        trades_out.append(item)
    return {"runId": rid, "trades": trades_out}


@app.get("/api/backtest/skipped-fires")
def get_backtest_skipped_fires(run_id: str | None = Query(default=None, alias="runId")) -> dict:
    con = _connect()
    try:
        rid = run_id
        if rid is None:
            latest = con.execute(
                "SELECT run_id FROM backtest_runs ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            rid = latest[0] if latest else None
        if rid is None:
            raise HTTPException(status_code=404, detail="No backtest runs found.")
        rows = con.execute(
            """
            SELECT bar_time, watch_id, direction, reason_code, price,
                   position_side_before, position_size_before, reason_detail_json
            FROM skipped_fires
            WHERE run_id = ?
            ORDER BY bar_time, watch_id
            """,
            [rid],
        ).fetchall()
    finally:
        con.close()
    summary: dict[str, int] = {}
    for r in rows:
        rc = str(r[3] or "unknown")
        summary[rc] = summary.get(rc, 0) + 1
    return {
        "runId": rid,
        "summary": summary,
        "rows": [
            {
                "barTime": r[0].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "watchId": r[1],
                "direction": r[2],
                "reasonCode": r[3],
                "price": r[4],
                "positionSideBefore": r[5],
                "positionSizeBefore": r[6],
                "reasonDetailJson": r[7],
            }
            for r in rows
        ],
    }


@app.get("/")
def root() -> dict:
    """Tiny health/discovery endpoint."""
    return {
        "service": "orderflow-api",
        "db_path": str(DB_PATH),
        "endpoints": [
            "/timeframes", "/sessions", "/date-range", "/bars", "/swing-events", "/divergence-events", "/events",
            "/fires", "/profile", "/occupancy",
            "/api/backtest/defaults", "/api/backtest/run", "/api/backtest/stats", "/api/backtest/equity",
            "/api/backtest/trades", "/api/backtest/skipped-fires",
        ],
        "supported_timeframes": list(SUPPORTED_TIMEFRAMES),
    }
