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
        Drives the dashboard's date dropdown. `bar_counts` is a per-
        timeframe dict so a single call populates the status banner for
        any active timeframe without re-querying.

    GET /bars?from=&to=&session_date=&timeframe=&cell=v,d&cell=...
        - `timeframe` (default '1m') scopes the query to one bin width.
        - `from`/`to` (or `session_date`) bound the time window. When
          `session_date` is provided, the resolved [lo, hi] window is
          taken from min/max bar_time at that (session_date, timeframe)
          pair so 15m / 1h sessions resolve to their own narrower window.
        - `cell=v,d` (repeatable, capped at 25 pairs) filters via DuckDB
          tuple-IN on (v_rank, d_rank). Composite index `idx_bars_tf_rank`
          on (timeframe, v_rank, d_rank) makes this an index probe.

    GET /events?from=&to=&timeframe=&bar_times=t1,t2,...
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
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

import duckdb
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse


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
SUPPORTED_TIMEFRAMES = ("1m", "15m", "1h")
DEFAULT_TIMEFRAME = "1m"


app = FastAPI(
    title="Order Flow API",
    default_response_class=ORJSONResponse,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET"],
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
    # DuckDB TIMESTAMP columns are tz-naive; strip any tz info.
    if dt.tzinfo is not None:
        dt = dt.astimezone(tz=None).replace(tzinfo=None)
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


def _bar_to_json_shape(b: dict) -> dict:
    """Coerce a DB row into the JSON-mode dashboard's bar shape.

    The API mode reuses every downstream JS module (priceChart, regime,
    canonical evaluators), so the shape MUST match what JSON-mode loads
    today: camelCase field names, ISO-Z timestamp, primitive number/null
    values. Phase-1 NULLs on rank columns flow through as JSON null.
    """
    bt: datetime = b["bar_time"]
    return {
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
        "time":            bt.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


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
    # Order canonically (1m / 15m / 1h) regardless of DuckDB's lexical
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
        "bars":         [_bar_to_json_shape(r) for r in rows],
    }


@app.get("/events")
def get_events(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    timeframe: str | None = Query(default=None),
    bar_times: str | None = Query(default=None),
) -> dict:
    """Return events in [from, to] OR at exact bar_times (comma-separated ISO).

    Phase 4a uses `bar_times=` to filter the event log to a brushed
    selection. Either filter mode is valid — they don't combine. Phase 5
    additionally scopes by `timeframe` so a brushed window at 15m doesn't
    pick up 1m events at the same instant.
    """
    tf = _validate_timeframe(timeframe)
    con = _connect()
    try:
        if bar_times:
            ts_list = [_parse_iso(t.strip()) for t in bar_times.split(",") if t.strip()]
            if not ts_list:
                return {"events": [], "timeframe": tf}
            placeholders = ",".join(["?"] * len(ts_list))
            rows = _row_to_dict(con.execute(
                f"SELECT bar_time, event_type, direction, price FROM events "
                f"WHERE timeframe = ? AND bar_time IN ({placeholders}) ORDER BY bar_time",
                [tf, *ts_list],
            ))
        else:
            lo = _parse_iso(from_)
            hi = _parse_iso(to)
            if lo is None or hi is None:
                raise HTTPException(status_code=400, detail="Provide ?from= and ?to= or ?bar_times=.")
            rows = _row_to_dict(con.execute(
                "SELECT bar_time, event_type, direction, price FROM events "
                "WHERE timeframe = ? AND bar_time BETWEEN ? AND ? ORDER BY bar_time",
                [tf, lo, hi],
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
            }
            for r in rows
        ]
    }


@app.get("/fires")
def get_fires(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    timeframe: str | None = Query(default=None),
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
        rows = _row_to_dict(con.execute(
            "SELECT bar_time, watch_id, direction, price, outcome, outcome_resolved_at "
            "FROM fires WHERE timeframe = ? AND bar_time BETWEEN ? AND ? ORDER BY bar_time",
            [tf, lo, hi],
        ))
    finally:
        con.close()
    return {
        "timeframe": tf,
        "fires": [
            {
                "barTime":   r["bar_time"].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "watchId":   r["watch_id"],
                "direction": r["direction"],
                "price":     r["price"],
                "outcome":   r["outcome"],
                "outcomeResolvedAt": (
                    r["outcome_resolved_at"].strftime("%Y-%m-%dT%H:%M:%SZ")
                    if r["outcome_resolved_at"] else None
                ),
            }
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
    the active timeframe's bar grid (1m / 15m / 1h all share bin-start
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


@app.get("/")
def root() -> dict:
    """Tiny health/discovery endpoint."""
    return {
        "service": "orderflow-api",
        "db_path": str(DB_PATH),
        "endpoints": [
            "/timeframes", "/sessions", "/bars", "/events",
            "/fires", "/profile", "/occupancy",
        ],
        "supported_timeframes": list(SUPPORTED_TIMEFRAMES),
    }
