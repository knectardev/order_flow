#!/usr/bin/env python3
"""Phase 0 — PHAT field end-to-end diagnostic (DB → API shape).

Reads DuckDB `bars` PHAT columns and optionally compares to GET /bars JSON.
Exit 0 when coverage looks healthy; 1 on connection/query failure.

Usage:
  python scripts/diagnose_phat_fields.py
  python scripts/diagnose_phat_fields.py --api-base http://127.0.0.1:8001 --session-date 2026-04-21

Env:
  ORDERFLOW_DB_PATH — defaults to data/orderflow.duckdb (same as api.main).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = REPO_ROOT / "data" / "orderflow.duckdb"

PHAT_COLS = (
    "top_cvd",
    "bottom_cvd",
    "top_cvd_norm",
    "bottom_cvd_norm",
    "cvd_imbalance",
    "upper_wick_liquidity",
    "lower_wick_liquidity",
    "upper_wick_ticks",
    "lower_wick_ticks",
    "high_before_low",
    "rejection_side",
    "rejection_strength",
    "rejection_type",
)


def _pct_non_null(rows: list[dict], col: str) -> float:
    if not rows:
        return 0.0
    ok = sum(1 for r in rows if r.get(col) is not None)
    return 100.0 * ok / len(rows)


def _finite_norm_stats(rows: list[dict]) -> tuple[int, float, float]:
    """Count bars with finite top_cvd_norm and min/max of those values."""
    vals = []
    for r in rows:
        v = r.get("top_cvd_norm")
        if v is not None and isinstance(v, (int, float)):
            vals.append(float(v))
    if not vals:
        return 0, 0.0, 0.0
    return len(vals), min(vals), max(vals)


def main() -> int:
    ap = argparse.ArgumentParser(description="PHAT column coverage diagnostic")
    ap.add_argument("--db", type=Path, default=Path(os.environ.get("ORDERFLOW_DB_PATH", str(DEFAULT_DB))))
    ap.add_argument("--timeframe", default="1m")
    ap.add_argument("--limit", type=int, default=5000, help="max bars sampled from DB for stats")
    ap.add_argument("--api-base", default="", help="if set, fetch /bars and verify camelCase PHAT keys")
    ap.add_argument("--session-date", default="", help="session_date= for /bars (recommended with --api-base)")
    args = ap.parse_args()

    if not args.db.is_file():
        print(f"[FAIL] DuckDB not found: {args.db}", file=sys.stderr)
        return 1

    try:
        import duckdb
    except ImportError:
        print("[FAIL] duckdb package required (pip install duckdb)", file=sys.stderr)
        return 1

    con = duckdb.connect(str(args.db), read_only=True)
    try:
        q = f"""
        SELECT {", ".join(PHAT_COLS)}, bar_time, timeframe
        FROM bars
        WHERE timeframe = ?
        ORDER BY bar_time DESC
        LIMIT ?
        """
        try:
            cur = con.execute(q, [args.timeframe, args.limit])
        except Exception as e:
            err = str(e).lower()
            if "not found" in err or "binder" in type(e).__name__.lower():
                print(
                    "[FAIL] PHAT columns missing from `bars` — DB may predate PHAT schema.\n"
                    "       Re-run pipeline aggregate / ingest so bars carry PHAT fields.",
                    file=sys.stderr,
                )
                return 1
            raise
        rows = cur.fetchall()
        cols = [d[0] for d in cur.description]
        dict_rows = [dict(zip(cols, row)) for row in rows]
    finally:
        con.close()

    n = len(dict_rows)
    print(f"=== DuckDB sample: {n} bars (timeframe={args.timeframe}, limit={args.limit}) ===")
    if n == 0:
        print("[WARN] No bars — rebuild DB or pick another timeframe.")
        return 0

    for col in PHAT_COLS:
        p = _pct_non_null(dict_rows, col)
        print(f"  {col:26} non-null {p:6.2f}%")

    tc_n, tc_lo, tc_hi = _finite_norm_stats(dict_rows)
    print(f"  top_cvd_norm finite count: {tc_n}  range [{tc_lo:.4f}, {tc_hi:.4f}]")

    rej_any = sum(
        1
        for r in dict_rows
        if r.get("rejection_side") not in (None, "", "none")
    )
    print(f"  rejection_side != 'none': {rej_any} / {n}")

    if args.api_base:
        base = args.api_base.rstrip("/")
        params = {"timeframe": args.timeframe}
        if args.session_date:
            params["session_date"] = args.session_date
        url = f"{base}/bars?{urlencode(params)}"
        print(f"\n=== GET {url} ===")
        try:
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=15) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print(f"[FAIL] API request: {e}", file=sys.stderr)
            return 1

        bars = payload.get("bars") or []
        if not bars:
            print("[WARN] API returned zero bars for this query.")
            return 0

        keys_needed = (
            "topCvd",
            "bottomCvd",
            "topCvdNorm",
            "bottomCvdNorm",
            "cvdImbalance",
            "upperWickLiquidity",
            "lowerWickLiquidity",
            "upperWickTicks",
            "lowerWickTicks",
            "highBeforeLow",
            "rejectionSide",
            "rejectionStrength",
            "rejectionType",
        )
        sample = bars[0]
        missing = [k for k in keys_needed if k not in sample]
        if missing:
            print(f"[FAIL] Missing camelCase keys on first bar: {missing}")
            return 1
        print(f"[OK] First bar has PHAT keys; topCvdNorm={sample.get('topCvdNorm')!r}")

    print("\nDone. Interpret: PHAT columns should be mostly non-null after aggregate ingest.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
