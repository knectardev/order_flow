"""argparse entrypoint for the orderflow_pipeline package.

Subcommands:
    aggregate  - Decode a directory of .dbn.zst files and emit per-session
                 JSON bars + index.json (1m only). When `--db-path` is set,
                 every aggregated session is also persisted to DuckDB at
                 all three timeframes (1m / 15m / 1h, Phase 5).
    rebuild    - Drop the DuckDB file and re-run aggregate. Use after any
                 change to `regime.py` or aggregation logic; same flag set
                 as `aggregate`.
    calibrate  - Print bar-level distributions and side-by-side detection
                 counts for the multiplier / z-score / median+MAD rules.
                 1m JSON only; calibration is a per-timeframe follow-up.

Phase 5 multi-timeframe layout:
    The aggregate loop is `for session in files: for tf in TIMEFRAMES:`.
    Trades are decoded ONCE per session into a list and then re-binned at
    each timeframe (VPT/concentration are NOT summable from 1m bars).
    Higher-timeframe regime ranks borrow context from prior sessions via
    `regime.SEED_SESSIONS_BY_TF`-many days of seeded rolling windows.
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

from .aggregate import (
    BIN_NS_BY_TIMEFRAME,
    DEFAULT_LARGE_PRINT_THRESHOLD,
    aggregate_trades,
)
from .decode import iter_trades
from .serialize import DEFAULT_TUNINGS, write_index, write_session_json
from .symbology import resolve_front_month

# Phase 5: full timeframe set persisted to DuckDB. Order matters only
# inasmuch as 1m runs first so the JSON output (which is 1m only) is
# produced before anything else that could fail.
TIMEFRAMES = ("1m", "15m", "1h")


# raw filenames look like "glbx-mdp3-20260421.trades.dbn.zst"
DATE_RE = re.compile(r"glbx-mdp3-(\d{4})(\d{2})(\d{2})\.trades\.dbn\.zst$", re.IGNORECASE)


def _date_from_filename(p: Path) -> date | None:
    m = DATE_RE.search(p.name)
    if not m:
        return None
    y, mo, d = (int(x) for x in m.groups())
    return date(y, mo, d)


def cmd_aggregate(args: argparse.Namespace) -> int:
    raw_dir = Path(args.raw_dir)
    out_dir = Path(args.out_dir)
    if not raw_dir.is_dir():
        print(f"raw-dir {raw_dir} does not exist", file=sys.stderr)
        return 2

    files = sorted(raw_dir.glob("glbx-mdp3-*.trades.dbn.zst"))
    if not files:
        print(f"No .dbn.zst files found in {raw_dir}", file=sys.stderr)
        return 2

    tunings = dict(DEFAULT_TUNINGS)
    tunings["largePrintThreshold"] = args.large_print_threshold
    if args.sweep_vol_mult       is not None: tunings["sweepVolMult"]       = args.sweep_vol_mult
    if args.absorb_vol_mult      is not None: tunings["absorbVolMult"]      = args.absorb_vol_mult
    if args.absorb_range_mult    is not None: tunings["absorbRangeMult"]    = args.absorb_range_mult
    if args.divergence_flow_mult is not None: tunings["divergenceFlowMult"] = args.divergence_flow_mult

    # DuckDB writer is opt-in via --db-path. When set, every aggregated
    # session is also persisted to the DB (in the same loop, idempotently)
    # at all three timeframes. JSON output is unconditional and stays 1m-
    # only — JSON mode is the legacy fallback and the dashboard uses
    # ?source=api now anyway. Phase 5 multi-timeframe data is DB-only.
    db_con = None
    if args.db_path:
        # Import lazily so the calibrate subcommand still works on a fresh
        # checkout that hasn't `pip install -e pipeline/` after the duckdb
        # dependency was added.
        from . import db as db_module
        db_con = db_module.connect(Path(args.db_path))
        db_module.init_schema(db_con)

    sessions: list[dict] = []
    for path in files:
        session_date = _date_from_filename(path)
        if session_date is None:
            print(f"  skipping {path.name} (cannot parse date)", file=sys.stderr)
            continue

        print(f"\n[{session_date}] {path.name}")
        try:
            fm = resolve_front_month(path)
        except ValueError as e:
            print(f"  skipping: {e}", file=sys.stderr)
            continue
        print(
            f"  front-month: {fm.symbol} (id={fm.instrument_id}) "
            f"vol={fm.volume:,} share={fm.share_of_volume*100:.2f}%"
        )

        # Materialize trades once per session — we re-bin at three
        # different timeframes, so iterating the decoder three times would
        # do the dbn.zst decode work three times. One RTH session of ES
        # trades is on the order of low-millions of records → tens of MB
        # in memory, well within budget.
        trades_list = list(iter_trades(path))

        session_summary: dict | None = None
        for tf in TIMEFRAMES:
            bin_ns = BIN_NS_BY_TIMEFRAME[tf]
            result = aggregate_trades(
                trades_list,
                front_month_id=fm.instrument_id,
                session_date=session_date,
                session=args.session,
                large_print_threshold=args.large_print_threshold,
                bin_ns=bin_ns,
                timeframe=tf,
            )
            if not result.bars:
                if tf == "1m":
                    # If 1m produces nothing, the session is empty (likely
                    # weekend/holiday) — skip the rest of the timeframes
                    # for this session.
                    print(
                        f"  no bars produced (likely no {args.session.upper()} trades on this date — "
                        f"e.g. weekend/holiday)"
                    )
                    break
                else:
                    # Higher timeframes can in principle produce zero bars
                    # if the session is degenerate (every bar partial),
                    # but that doesn't happen during regular RTH.
                    print(f"  [{tf}] no bars produced")
                    continue

            # Stamp v_rank / d_rank / range_pct onto every Bar BEFORE
            # either writer runs, with optional cross-session seed
            # history loaded from DB for higher timeframes.
            seed_df = _load_seed_history(db_con, session_date, tf) if db_con is not None else None
            _stamp_ranks(result.bars, session_date, tf, seed_df)

            # JSON output is 1m only (legacy compat with verify_phase1 +
            # the JSON-mode fallback path; higher timeframes are DB-only).
            if tf == "1m":
                json_path = write_session_json(
                    result,
                    out_dir=out_dir,
                    symbol=args.symbol,
                    contract=fm.symbol,
                    tunings=tunings,
                )
                print(f"  [1m] wrote {json_path.name} ({len(result.bars)} bars)")
                session_summary = {
                    "file":         json_path.name,
                    "date":         session_date.isoformat(),
                    "symbol":       args.symbol,
                    "contract":     fm.symbol,
                    "session":      result.session,
                    "barCount":     len(result.bars),
                    "sessionStart": result.session_start_ns and _ns_iso(result.session_start_ns),
                    "sessionEnd":   result.session_end_ns and _ns_iso(result.session_end_ns),
                }

            if db_con is not None:
                _write_session_to_db(db_con, result, session_date, tf)
                print(f"  [{tf}] wrote duckdb session rows ({len(result.bars)} bars)")

        if session_summary is not None:
            sessions.append(session_summary)

    if sessions:
        idx = write_index(sessions, out_dir=out_dir)
        print(f"\nWrote {idx} ({len(sessions)} session(s))")
    else:
        print("\nNo sessions produced.", file=sys.stderr)
        return 1

    if db_con is not None:
        db_con.close()
    return 0


def _load_seed_history(con, session_date: date, timeframe: str):
    """Load prior-session bars from DuckDB to seed the regime classifier.

    For 15m/1h, RTH produces too few bars per session to fill the rolling
    percentile window even at the lower bar counts (24 at 1h, 30 at 15m).
    Without seeding, ranks would emit NULL for the entire first session
    of the dataset (and substantial portions of every subsequent session).

    Returns a DataFrame with the columns `regime.compute_ranks` requires
    (high, low, volume, vpt, concentration), or None if seeding is
    disabled (1m) or no prior sessions exist (first session of dataset).
    The caller is responsible for handling None gracefully.
    """
    from . import regime
    n_seed = regime.SEED_SESSIONS_BY_TF.get(timeframe, 0)
    if n_seed <= 0:
        return None

    rows_dates = con.execute(
        """
        SELECT DISTINCT session_date FROM bars
        WHERE timeframe = ? AND session_date < ?
        ORDER BY session_date DESC
        LIMIT ?
        """,
        [timeframe, session_date, n_seed],
    ).fetchall()
    if not rows_dates:
        return None

    seed_dates = [r[0] for r in rows_dates]
    placeholders = ",".join(["?"] * len(seed_dates))
    rows = con.execute(
        f"""
        SELECT high, low, volume, vpt, concentration
        FROM bars
        WHERE timeframe = ? AND session_date IN ({placeholders})
        ORDER BY bar_time
        """,
        [timeframe, *seed_dates],
    ).fetchall()
    if not rows:
        return None

    import pandas as pd
    return pd.DataFrame(
        rows,
        columns=["high", "low", "volume", "vpt", "concentration"],
    )


def _stamp_ranks(bars: list, session_date: date, timeframe: str, seed_df) -> None:
    """Run `regime.compute_ranks` on a session's bars and write back.

    Builds a small pandas DataFrame from the bar-level scalars the
    classifier needs (`high`, `low`, `volume`, `vpt`, `concentration`),
    delegates to `regime.compute_ranks`, then copies the resulting
    `range_pct` / `v_rank` / `d_rank` columns back onto each `Bar`
    instance. After this call returns, `Bar.to_json()` and
    `Bar.to_dict()` both expose the regime fields uniformly.

    Phase 5: passes the active timeframe + optional seed history so the
    classifier can use per-timeframe windows / hybrid warmup.
    """
    import pandas as pd

    from . import regime

    rows = [b.to_dict(session_date, timeframe) for b in bars]
    bars_df = pd.DataFrame(rows)
    bars_df = regime.compute_ranks(bars_df, timeframe=timeframe, seed_history_df=seed_df)

    range_pct_col = bars_df["range_pct"].tolist()
    v_rank_col    = bars_df["v_rank"].tolist()
    d_rank_col    = bars_df["d_rank"].tolist()

    for i, b in enumerate(bars):
        rp = range_pct_col[i]
        vr = v_rank_col[i]
        dr = d_rank_col[i]
        # pandas may emit numpy.float64; downcast to native float so
        # json.dumps doesn't write `NaN`. v_rank/d_rank are integers
        # (numpy.int64) which we cast to native int.
        b.range_pct = float(rp) if rp is not None else None
        b.v_rank    = int(vr) if vr is not None else None
        b.d_rank    = int(dr) if dr is not None else None


def _write_session_to_db(con, result, session_date: date, timeframe: str) -> None:
    """Build the four DataFrames the DB writer expects and dispatch.

    `range_pct` / `v_rank` / `d_rank` were stamped onto each Bar by
    `_stamp_ranks` before this call, so `to_dict()` rows already carry
    the regime classifier output (NULL only for warmup / zero-volume).
    `events_df` and `fires_df` are still empty here — events are computed
    client-side from bars today; the DB-side detection backfill is a
    separate task. The empty DataFrames still carry the right column
    names so write_session can issue SELECTs against them without
    column-name surprises.

    Phase 5: every row in every output frame carries the active
    `timeframe` so the DB's composite PKs scope cleanly.
    """
    import pandas as pd

    bar_rows = [b.to_dict(session_date, timeframe) for b in result.bars]
    bars_df = pd.DataFrame(bar_rows)

    profile_rows: list[dict] = []
    for b in result.bars:
        profile_rows.extend(b.iter_profile_rows(timeframe))
    profile_df = pd.DataFrame(
        profile_rows,
        columns=["bar_time", "timeframe", "price_tick", "volume", "delta"],
    )

    # Empty placeholders with the expected schema (DuckDB can SELECT from a
    # zero-row DataFrame as long as the column names line up).
    events_df = pd.DataFrame(
        columns=["bar_time", "timeframe", "event_type", "direction", "price"]
    )
    fires_df = pd.DataFrame(
        columns=[
            "bar_time", "timeframe", "watch_id", "direction", "price",
            "outcome", "outcome_resolved_at",
        ]
    )

    from . import db as db_module
    db_module.write_session(
        con, session_date, timeframe, bars_df, events_df, fires_df, profile_df
    )


def _ns_iso(ns: int) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def cmd_calibrate(args: argparse.Namespace) -> int:
    from .calibrate import calibrate_session
    return calibrate_session(
        bars_dir=Path(args.bars_dir),
        date_str=args.date,
        symbol=args.symbol,
        session=args.session,
    )


def cmd_rebuild(args: argparse.Namespace) -> int:
    """Drop the DuckDB file and rerun cmd_aggregate.

    Use after any change to `regime.py` or aggregation logic. Forwards
    every aggregate flag — `rebuild` is just `aggregate` with a
    guaranteed-fresh DB. JSON files are NOT deleted (cheap to overwrite,
    and useful as `verify_phase1.py` reference data).

    Phase 5: a single rebuild re-runs aggregation across all three
    timeframes for all raw files.
    """
    db_path = Path(args.db_path)
    if db_path.exists():
        db_path.unlink()
        print(f"removed {db_path}")
    return cmd_aggregate(args)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="orderflow_pipeline",
        description="Decode Databento DBN/Trades files and aggregate to multi-timeframe bars.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("aggregate", help="Decode raw .dbn.zst -> per-session JSON bars + DuckDB")
    _add_aggregate_args(a)
    a.set_defaults(func=cmd_aggregate)

    r = sub.add_parser(
        "rebuild",
        help="Drop --db-path and rerun aggregate (zero-friction iteration loop).",
    )
    _add_aggregate_args(r, db_path_required=True)
    r.set_defaults(func=cmd_rebuild)

    c = sub.add_parser("calibrate", help="Print distributions + side-by-side detection counts")
    c.add_argument("--bars-dir", required=True, help="Directory containing aggregated bars JSON")
    c.add_argument("--date",     required=True, help="Session date YYYY-MM-DD")
    c.add_argument("--symbol",   default="es",  help="Display symbol (default: es)")
    c.add_argument("--session",  default="rth", choices=["rth", "globex"])
    c.set_defaults(func=cmd_calibrate)

    return p


def _add_aggregate_args(a: argparse.ArgumentParser, *, db_path_required: bool = False) -> None:
    """Register the shared aggregate flag set on a subparser.

    `aggregate` and `rebuild` both run aggregation; `rebuild` additionally
    drops the DB file before invoking it.
    """
    a.add_argument("--raw-dir",  required=True, help="Directory containing glbx-mdp3-*.trades.dbn.zst")
    a.add_argument("--out-dir",  required=True, help="Output directory for bars/*.json + index.json")
    a.add_argument("--db-path",  required=db_path_required, default=None,
                   help="Optional DuckDB file path. When set, also persist every aggregated "
                        "session to the DB at all three timeframes (1m/15m/1h, idempotent).")
    a.add_argument("--symbol",   default="ES",  help="Display symbol (default: ES)")
    a.add_argument("--session",  default="rth", choices=["rth", "globex"],
                   help="Session window (default: rth = 09:30-16:00 ET)")
    a.add_argument("--large-print-threshold", type=int, default=DEFAULT_LARGE_PRINT_THRESHOLD,
                   help=f"size>=N counts as a 'large print' (default: {DEFAULT_LARGE_PRINT_THRESHOLD})")
    a.add_argument("--sweep-vol-mult",    type=float, default=None, help="Override tunings.sweepVolMult")
    a.add_argument("--absorb-vol-mult",   type=float, default=None, help="Override tunings.absorbVolMult")
    a.add_argument("--absorb-range-mult", type=float, default=None, help="Override tunings.absorbRangeMult")
    a.add_argument("--divergence-flow-mult", type=float, default=None, help="Override tunings.divergenceFlowMult")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
