#!/usr/bin/env python3
"""Empirical distribution helper for Phase 3b / Phase 4 divergence thresholds.

Reads swing_events from DuckDB and prints quantiles of consecutive-swing
price and CVD deltas (per series). Use after a full ingest with swings
populated. Does not write defaults into code — human picks CLI values.

Usage:
  python scripts/calibrate_divergence_thresholds.py --db data/orderflow.duckdb --timeframe 1m
"""
from __future__ import annotations

import argparse
from pathlib import Path

import duckdb
import numpy as np


def main() -> int:
    p = argparse.ArgumentParser(description="Summarize swing spacing for divergence calibration.")
    p.add_argument("--db", type=Path, required=True)
    p.add_argument("--timeframe", default="1m")
    args = p.parse_args()

    con = duckdb.connect(str(args.db))
    try:
        swings = con.execute(
            """
            SELECT series_type, bar_time, swing_value, session_date
            FROM swing_events
            WHERE timeframe = ?
            ORDER BY bar_time
            """,
            [args.timeframe],
        ).fetchdf()
    finally:
        con.close()

    if swings.empty:
        print("No swing_events rows for timeframe=", args.timeframe)
        return 1

    for series in ("price_high", "price_low", "cvd_high", "cvd_low"):
        sub = swings[swings["series_type"] == series].sort_values("bar_time")
        if len(sub) < 2:
            print(f"\n[{series}] insufficient swings ({len(sub)})")
            continue
        vals = sub["swing_value"].to_numpy(dtype=float)
        d = np.abs(np.diff(vals))
        print(f"\n[{series}] pairs={len(d)}")
        for q in (0.5, 0.75, 0.9, 0.95):
            print(f"  |delta| quantile {q:.2f}: {float(np.quantile(d, q)):.6g}")

    print("\nReview CLI --div-min-price / --div-min-cvd against quantiles above.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
