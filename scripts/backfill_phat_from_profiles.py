#!/usr/bin/env python3
"""Backfill PHAT columns in DuckDB from per-bar volume profile rows.

Useful when an older DB predates PHAT columns/values but already has
`bar_volume_profile` data. This recomputes PHAT features per
`(bar_time, timeframe)` directly from that timeframe's stored tick map.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PIPELINE_SRC = REPO_ROOT / "pipeline" / "src"
if str(PIPELINE_SRC) not in sys.path:
    sys.path.append(str(PIPELINE_SRC))

from orderflow_pipeline import db as db_module
from orderflow_pipeline.phat import compute_phat_features

DEFAULT_DB = REPO_ROOT / "data" / "orderflow.duckdb"
TICK_SIZE = 0.25


def _iter_rows(con, timeframe: str | None):
    sql = """
    SELECT
      b.bar_time,
      b.timeframe,
      b.open,
      b.high,
      b.low,
      b.close,
      b.high_before_low,
      p.price_tick,
      p.volume,
      p.delta
    FROM bars b
    LEFT JOIN bar_volume_profile p
      ON p.bar_time = b.bar_time
     AND p.timeframe = b.timeframe
    """
    params = []
    if timeframe:
        sql += " WHERE b.timeframe = ?"
        params.append(timeframe)
    sql += " ORDER BY b.timeframe, b.bar_time, p.price_tick"
    return con.execute(sql, params).fetchall()


def main() -> int:
    ap = argparse.ArgumentParser(description="Backfill PHAT values from bar_volume_profile")
    ap.add_argument("--db", type=Path, default=Path(os.environ.get("ORDERFLOW_DB_PATH", str(DEFAULT_DB))))
    ap.add_argument("--timeframe", choices=["1m", "15m", "1h"], default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"[FAIL] Missing DB: {args.db}", file=sys.stderr)
        return 1

    con = db_module.connect(args.db)
    db_module.init_schema(con)
    rows = _iter_rows(con, args.timeframe)
    if not rows:
        print("[WARN] No bars found to backfill.")
        con.close()
        return 0

    updates = []
    i = 0
    n = len(rows)
    while i < n:
        bar_time, tf, o, h, l, c, hbl, _, _, _ = rows[i]
        price_volume: dict[int, int] = {}
        price_delta: dict[int, int] = {}
        while i < n and rows[i][0] == bar_time and rows[i][1] == tf:
            _, _, _, _, _, _, _, price_tick, vol, dlt = rows[i]
            if price_tick is not None:
                price_volume[int(price_tick)] = int(vol or 0)
                price_delta[int(price_tick)] = int(dlt or 0)
            i += 1

        feats = compute_phat_features(
            open_price=float(o),
            close_price=float(c),
            high_price=float(h),
            low_price=float(l),
            tick_size=TICK_SIZE,
            price_volume=price_volume,
            price_delta=price_delta,
        )
        updates.append(
            (
                feats["top_cvd"],
                feats["bottom_cvd"],
                feats["top_cvd_norm"],
                feats["bottom_cvd_norm"],
                feats["cvd_imbalance"],
                feats["top_body_volume_ratio"],
                feats["bottom_body_volume_ratio"],
                feats["upper_wick_liquidity"],
                feats["lower_wick_liquidity"],
                feats["upper_wick_ticks"],
                feats["lower_wick_ticks"],
                bool(hbl) if hbl is not None else True,
                feats["rejection_side"],
                feats["rejection_strength"],
                feats["rejection_type"],
                bar_time,
                tf,
            )
        )

    print(f"[INFO] Prepared PHAT updates for {len(updates)} bars.")
    if args.dry_run:
        con.close()
        print("[OK] Dry-run complete.")
        return 0

    con.executemany(
        """
        UPDATE bars
        SET top_cvd = ?,
            bottom_cvd = ?,
            top_cvd_norm = ?,
            bottom_cvd_norm = ?,
            cvd_imbalance = ?,
            top_body_volume_ratio = ?,
            bottom_body_volume_ratio = ?,
            upper_wick_liquidity = ?,
            lower_wick_liquidity = ?,
            upper_wick_ticks = ?,
            lower_wick_ticks = ?,
            high_before_low = ?,
            rejection_side = ?,
            rejection_strength = ?,
            rejection_type = ?
        WHERE bar_time = ? AND timeframe = ?
        """,
        updates,
    )
    con.close()
    print("[OK] Backfill complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
