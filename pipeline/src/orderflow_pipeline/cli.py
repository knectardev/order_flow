"""argparse entrypoint for the orderflow_pipeline package.

Subcommands:
    aggregate  - Decode a directory of .dbn.zst files and emit per-session
                 JSON bars + index.json.
    calibrate  - Print bar-level distributions and side-by-side detection
                 counts for the multiplier / z-score / median+MAD rules.

Plan refs: §2 (pipeline orchestration), §6.6 (calibrate).
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

from .aggregate import aggregate_trades, DEFAULT_LARGE_PRINT_THRESHOLD
from .decode import iter_trades
from .serialize import DEFAULT_TUNINGS, write_index, write_session_json
from .symbology import resolve_front_month


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

        result = aggregate_trades(
            iter_trades(path),
            front_month_id=fm.instrument_id,
            session_date=session_date,
            session=args.session,
            large_print_threshold=args.large_print_threshold,
        )
        if not result.bars:
            print(
                f"  no bars produced (likely no {args.session.upper()} trades on this date — "
                f"e.g. weekend/holiday)"
            )
            continue

        json_path = write_session_json(
            result,
            out_dir=out_dir,
            symbol=args.symbol,
            contract=fm.symbol,
            tunings=tunings,
        )
        print(f"  wrote {json_path.name} ({len(result.bars)} bars)")

        sessions.append({
            "file":         json_path.name,
            "date":         session_date.isoformat(),
            "symbol":       args.symbol,
            "contract":     fm.symbol,
            "session":      result.session,
            "barCount":     len(result.bars),
            "sessionStart": result.session_start_ns and _ns_iso(result.session_start_ns),
            "sessionEnd":   result.session_end_ns and _ns_iso(result.session_end_ns),
        })

    if sessions:
        idx = write_index(sessions, out_dir=out_dir)
        print(f"\nWrote {idx} ({len(sessions)} session(s))")
    else:
        print("\nNo sessions produced.", file=sys.stderr)
        return 1
    return 0


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


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="orderflow_pipeline",
        description="Decode Databento DBN/Trades files and aggregate to 1-min bars.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("aggregate", help="Decode raw .dbn.zst -> per-session JSON bars")
    a.add_argument("--raw-dir",  required=True, help="Directory containing glbx-mdp3-*.trades.dbn.zst")
    a.add_argument("--out-dir",  required=True, help="Output directory for bars/*.json + index.json")
    a.add_argument("--symbol",   default="ES",  help="Display symbol (default: ES)")
    a.add_argument("--session",  default="rth", choices=["rth", "globex"],
                   help="Session window (default: rth = 09:30-16:00 ET)")
    a.add_argument("--large-print-threshold", type=int, default=DEFAULT_LARGE_PRINT_THRESHOLD,
                   help=f"size>=N counts as a 'large print' (default: {DEFAULT_LARGE_PRINT_THRESHOLD})")
    a.add_argument("--sweep-vol-mult",    type=float, default=None, help="Override tunings.sweepVolMult")
    a.add_argument("--absorb-vol-mult",   type=float, default=None, help="Override tunings.absorbVolMult")
    a.add_argument("--absorb-range-mult", type=float, default=None, help="Override tunings.absorbRangeMult")
    a.add_argument("--divergence-flow-mult", type=float, default=None, help="Override tunings.divergenceFlowMult")
    a.set_defaults(func=cmd_aggregate)

    c = sub.add_parser("calibrate", help="Print distributions + side-by-side detection counts")
    c.add_argument("--bars-dir", required=True, help="Directory containing aggregated bars JSON")
    c.add_argument("--date",     required=True, help="Session date YYYY-MM-DD")
    c.add_argument("--symbol",   default="es",  help="Display symbol (default: es)")
    c.add_argument("--session",  default="rth", choices=["rth", "globex"])
    c.set_defaults(func=cmd_calibrate)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
