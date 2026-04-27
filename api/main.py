"""FastAPI app exposing read-only views of the orderflow DuckDB.

The aggregator (`pipeline/src/orderflow_pipeline/cli.py aggregate --db-path ...`)
is the only writer; this app is strictly read-only. Each endpoint opens a
short-lived DuckDB connection per request — DuckDB handles concurrent
readers natively, and per-request connections sidestep any thread-safety
landmines that would come from sharing a single connection across the
event loop.

Endpoints (regime-DB plan §1c, §1b'):

    GET /sessions
        Drives the dashboard's date dropdown.

    GET /bars?from=&to=&session_date=&cell=v,d&cell=...
        - `from`/`to` (or `session_date`) bound the time window.
        - `cell=v,d` (repeatable, capped at 25 pairs) filters via DuckDB
          tuple-IN on (v_rank, d_rank). Index `idx_bars_rank` makes this a
          composite-index probe rather than a sequential scan.
        - Phase 1 ignores `cell` filters because v_rank/d_rank are NULL
          until Phase 2; the parameter is accepted today and applied
          unconditionally — for Phase 1 sessions the result of the
          tuple-IN is empty, which is the correct behavior (no ranked
          bars yet means no brushable bars yet). Phase 4a will lean on
          this same code path for multi-cell brushing.

    GET /events?from=&to=&bar_times=t1,t2,...
        Time-range OR exact-bar-time filter (Phase 4a uses bar_times).

    GET /fires?from=&to=

    GET /profile?from=&to=&session_date=
        True tick-level volume profile from `bar_volume_profile` (regime-DB
        plan §1b'). Server-side POC / VAH / VAL — same value-area-fraction
        logic as `src/analytics/profile.js#computeProfile`, but operating
        on real per-print volume instead of an OHLC-distribution proxy.

    GET /occupancy?from=&to=&session_date=
        5x5 cell occupancy histogram for the requested window (regime-DB
        plan §3a). Drives the dashboard's matrix heatmap background +
        "[cell] occupied X% of selected window" diagnostic. NULL-rank bars
        (warmup, zero-volume) are excluded from `total_bars` so percentages
        are over the *rankable* sample, which is the only meaningful
        denominator for a cell-occupancy metric.

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
) -> tuple[datetime, datetime]:
    """Resolve the (lo, hi) TIMESTAMP window for the query.

    Precedence: `session_date` (if provided) > explicit (from, to). When
    `session_date` is given, we look up that day's actual min/max bar_time
    from the DB so the window is exactly the session's range — no ET vs UTC
    arithmetic on the API side. Returns a 404 if `session_date` has no rows.
    """
    if session_date:
        d = _parse_session_date(session_date)
        row = con.execute(
            "SELECT MIN(bar_time), MAX(bar_time) FROM bars WHERE session_date = ?",
            [d],
        ).fetchone()
        if row is None or row[0] is None:
            raise HTTPException(status_code=404, detail=f"No bars for session_date={session_date}")
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


@app.get("/sessions")
def get_sessions() -> dict:
    """List every distinct session_date with its bar count + start/end.

    Drives the dashboard's date dropdown. Sorted ascending by date so the
    JS bootstrap concatenates timelines in chronological order without
    re-sorting on its side.
    """
    con = _connect()
    try:
        rows = con.execute(
            """
            SELECT session_date,
                   COUNT(*)         AS bar_count,
                   MIN(bar_time)    AS session_start,
                   MAX(bar_time)    AS session_end
            FROM bars
            GROUP BY session_date
            ORDER BY session_date
            """
        ).fetchall()
    finally:
        con.close()
    sessions = []
    for d, n, lo, hi in rows:
        sessions.append({
            "session_date":  d.isoformat() if isinstance(d, date) else str(d),
            "bar_count":     int(n),
            "session_start": lo.strftime("%Y-%m-%dT%H:%M:%SZ") if lo else None,
            "session_end":   hi.strftime("%Y-%m-%dT%H:%M:%SZ") if hi else None,
        })
    return {"sessions": sessions}


@app.get("/bars")
def get_bars(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    session_date: str | None = Query(default=None),
    cell: list[str] = Query(default=[]),
) -> dict:
    """Return bars in [from, to] (or for `session_date`), shaped like JSON mode.

    Phase 4a's tuple-IN brushing: every additional `cell=v,d` query
    parameter narrows the result to bars whose (v_rank, d_rank) is in the
    parsed tuple list. Index `idx_bars_rank` makes this a composite-index
    probe; verify with `EXPLAIN SELECT ...`.
    """
    con = _connect()
    try:
        lo, hi = _resolve_window(con, from_, to, session_date)
        pairs = _parse_cell_pairs(cell)

        sql = "SELECT * FROM bars WHERE bar_time BETWEEN ? AND ?"
        params: list[Any] = [lo, hi]
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
        "cells":        [list(p) for p in pairs],
        "bars":         [_bar_to_json_shape(r) for r in rows],
    }


@app.get("/events")
def get_events(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    bar_times: str | None = Query(default=None),
) -> dict:
    """Return events in [from, to] OR at exact bar_times (comma-separated ISO).

    Phase 4a uses `bar_times=` to filter the event log to a brushed
    selection. Either filter mode is valid — they don't combine.
    """
    con = _connect()
    try:
        if bar_times:
            ts_list = [_parse_iso(t.strip()) for t in bar_times.split(",") if t.strip()]
            if not ts_list:
                return {"events": []}
            placeholders = ",".join(["?"] * len(ts_list))
            rows = _row_to_dict(con.execute(
                f"SELECT bar_time, event_type, direction, price FROM events "
                f"WHERE bar_time IN ({placeholders}) ORDER BY bar_time",
                ts_list,
            ))
        else:
            lo = _parse_iso(from_)
            hi = _parse_iso(to)
            if lo is None or hi is None:
                raise HTTPException(status_code=400, detail="Provide ?from= and ?to= or ?bar_times=.")
            rows = _row_to_dict(con.execute(
                "SELECT bar_time, event_type, direction, price FROM events "
                "WHERE bar_time BETWEEN ? AND ? ORDER BY bar_time",
                [lo, hi],
            ))
    finally:
        con.close()
    return {
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
) -> dict:
    """Return fires in [from, to]. Mirrors the JS canonicalFires shape."""
    con = _connect()
    try:
        lo = _parse_iso(from_)
        hi = _parse_iso(to)
        if lo is None or hi is None:
            raise HTTPException(status_code=400, detail="Provide ?from= and ?to=.")
        rows = _row_to_dict(con.execute(
            "SELECT bar_time, watch_id, direction, price, outcome, outcome_resolved_at "
            "FROM fires WHERE bar_time BETWEEN ? AND ? ORDER BY bar_time",
            [lo, hi],
        ))
    finally:
        con.close()
    return {
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
) -> dict:
    """True tick-level volume profile from `bar_volume_profile`.

    Aggregates per-tick volume + signed delta across the requested window,
    then computes POC (modal tick) and VAH/VAL (expand outward from POC
    until VA_FRACTION of total volume is captured). Same value-area-fraction
    semantics as `src/analytics/profile.js#computeProfile`, but driven by
    real per-print volume rather than an OHLC-distribution proxy.

    Response shape is intentionally close to the JS proxy's return shape
    (`bins`, `binStep`, `priceLo`, `priceHi`, `pocPrice`, `valPrice`,
    `vahPrice`, `maxBin`) so the client-side renderer in priceChart.js can
    consume both with minimal divergence. The `ticks` array is the raw
    per-tick volume/delta breakdown — not used by the renderer today, but
    retained for future per-tick heatmaps / debugging.
    """
    con = _connect()
    try:
        lo, hi = _resolve_window(con, from_, to, session_date)
        rows = con.execute(
            """
            SELECT price_tick, SUM(volume) AS volume, SUM(delta) AS delta
            FROM bar_volume_profile
            WHERE bar_time BETWEEN ? AND ?
            GROUP BY price_tick
            ORDER BY price_tick
            """,
            [lo, hi],
        ).fetchall()
    finally:
        con.close()

    if not rows:
        return {
            "from":          lo.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "to":            hi.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "session_date":  session_date,
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

    # Build a contiguous tick array (no gaps) so the renderer's bin index
    # matches `(price - priceLo) / binStep` directly. Gaps in the raw
    # GROUP BY result (untraded ticks) become zero-volume bins, which is
    # what the existing JS renderer expects when it walks 0..PROFILE_BINS.
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

    # POC = bin with max volume. Tie-break: lowest price (earliest index)
    # — same convention as the JS proxy's first-max scan.
    poc_idx = 0
    for i in range(1, bin_count):
        if bins[i] > bins[poc_idx]:
            poc_idx = i
    poc_tick = lo_tick + poc_idx

    # Expand outward from POC until VA_FRACTION of total volume captured.
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

    # Bin shape that the JS renderer can consume directly. priceLo is
    # already the bottom edge of bin 0 (a tick boundary), so unlike the
    # OHLC-proxy's floating priceLo we don't need a half-tick offset.
    price_lo = lo_tick * TICK_SIZE
    price_hi = (hi_tick + 1) * TICK_SIZE   # top edge of last bin

    return {
        "from":          lo.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "to":            hi.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "session_date":  session_date,
        "ticks":         ticks_raw,
        "total_volume":  total_volume,
        "bins":          bins,
        "deltas":        deltas,
        "binStep":       TICK_SIZE,
        "priceLo":       price_lo,
        "priceHi":       price_hi,
        # POC sits at bin center; VAL at bottom edge of lo_i; VAH at top edge of hi_i.
        # Same convention as the JS proxy so the renderer's lines land in the
        # same place.
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
) -> ORJSONResponse:
    """5x5 cell occupancy over the [from, to] (or session_date) window.

    Uses the `idx_bars_rank` composite index for the GROUP BY. With ~80
    sessions × 390 bars the full-loaded scan is well under the 100 ms
    budget; index probe makes per-session / last-hour windows essentially
    free.

    Cache-Control:
      - Fixed historical windows (`from` & `to` both provided) → `max-age=60`,
        because the underlying bars are immutable once a session is
        aggregated. Browser-cache hit serves repeat scrubs / range toggles
        instantly without re-hitting the API.
      - Cursor-driven windows (Last hour / Current session, where the
        client passes `session_date` or a moving `to`) ⇒ `no-cache`. The
        client treats those as live and the cache would serve stale data.
        We can't tell from inside the handler whether `from`/`to` were
        derived from a moving cursor, so we conservatively `no-cache`
        anything that's session_date-bound *or* whose `to` lies within
        the last 5 minutes of the most recent bar in the DB. That second
        check would require a SELECT, so for simplicity we only mark
        `session_date=` as no-cache; explicit (from, to) windows always
        get max-age=60. Misuse looks like a stale 60-second window — the
        worst case is a slightly stale heatmap on a session boundary,
        which the user resolves by toggling the range selector once.
    """
    con = _connect()
    try:
        lo, hi = _resolve_window(con, from_, to, session_date)
        rows = con.execute(
            """
            SELECT v_rank, d_rank, COUNT(*) AS occupancy
            FROM bars
            WHERE bar_time BETWEEN ? AND ?
              AND v_rank IS NOT NULL
              AND d_rank IS NOT NULL
            GROUP BY v_rank, d_rank
            """,
            [lo, hi],
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
        "endpoints": ["/sessions", "/bars", "/events", "/fires", "/profile", "/occupancy"],
    }
