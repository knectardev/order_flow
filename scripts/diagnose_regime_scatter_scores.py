#!/usr/bin/env python3
"""Histogram vol_score / depth_score after compute_ranks (regime matrix scatter diagnosis).

Prints bin counts and exact 1.0 / 5.0 spikes. Run per session (same contract as pipeline).

Expected under the current dual-track classifier (mid-rank scatter): eligible bars should
show **zero** counts at exactly 1.0 and 5.0; non-zero spikes indicate legacy endpoint-only
scatter or mixed DB semantics — run `cli rebuild` and verify `regime.compute_ranks`.

Usage:
  python scripts/diagnose_regime_scatter_scores.py
  python scripts/diagnose_regime_scatter_scores.py --db data/orderflow.duckdb --timeframe 1m --max-sessions 20
  python scripts/diagnose_regime_scatter_scores.py --synthetic --bars 5000

Env:
  ORDERFLOW_DB_PATH — default DuckDB path when --db omitted
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_DB = REPO_ROOT / "data" / "orderflow.duckdb"

_SRC = REPO_ROOT / "pipeline" / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from orderflow_pipeline import regime  # noqa: E402


def _eligible_mask(out: pd.DataFrame, warmup: int) -> np.ndarray:
    zv = out["volume"].to_numpy(dtype=float) <= 0
    wu = np.arange(len(out)) < warmup
    vr = out["v_rank"].tolist()
    bad_r = np.array([v is None for v in vr], dtype=bool)
    return ~(wu | zv | bad_r)


def _print_hist(name: str, vals: np.ndarray, bins: int = 20):
    if vals.size == 0:
        print(f"  {name}: no values")
        return
    hist, edges = np.histogram(vals, bins=bins, range=(1.0, 5.0))
    print(f"  {name}: n={vals.size} min={vals.min():.6f} max={vals.max():.6f}")
    for i, c in enumerate(hist):
        lo, hi = edges[i], edges[i + 1]
        print(f"    [{lo:.2f}, {hi:.2f}): {c}")
    n1 = int(np.sum(np.isclose(vals, 1.0, atol=1e-9)))
    n5 = int(np.sum(np.isclose(vals, 5.0, atol=1e-9)))
    print(f"    exact 1.0 (atol=1e-9): {n1}  |  exact 5.0: {n5}")


def _run_synthetic(n: int) -> None:
    rng = np.random.default_rng(42)
    df = pd.DataFrame({
        "high": rng.uniform(101.0, 105.0, n),
        "low": rng.uniform(99.0, 101.0, n),
        "volume": rng.integers(500, 5000, n),
        "vpt": rng.uniform(50.0, 200.0, n),
        "concentration": rng.uniform(0.05, 0.50, n),
    })
    out = regime.compute_ranks(df.copy(), timeframe="1m")
    warm = regime.REGIME_PARAMS["1m"]["warmup"]
    m = _eligible_mask(out, warm)
    def col_float(c: str) -> np.ndarray:
        s = out.loc[m, c].dropna()
        return np.array([float(x) for x in s], dtype=np.float64)
    print("=== Synthetic session ===")
    _print_hist("vol_score", col_float("vol_score"))
    _print_hist("depth_score", col_float("depth_score"))


def _run_db(db: Path, timeframe: str, max_sessions: int, limit_per_session: int) -> int:
    try:
        import duckdb
    except ImportError:
        print("[FAIL] pip install duckdb", file=sys.stderr)
        return 1
    if not db.is_file():
        print(f"[FAIL] missing {db}", file=sys.stderr)
        return 1
    con = duckdb.connect(str(db), read_only=True)
    try:
        sessions = con.execute(
            """
            SELECT DISTINCT session_date
            FROM bars
            WHERE timeframe = ?
            ORDER BY session_date DESC
            LIMIT ?
            """,
            [timeframe, max_sessions],
        ).fetchall()
    finally:
        con.close()
    if not sessions:
        print("[WARN] no sessions in bars for this timeframe")
        return 0
    all_v: list[float] = []
    all_d: list[float] = []
    warm = regime.REGIME_PARAMS.get(timeframe, regime.REGIME_PARAMS["1m"])["warmup"]
    con = duckdb.connect(str(db), read_only=True)
    try:
        for (sess,) in sessions:
            q = """
            SELECT high, low, volume, vpt, concentration
            FROM bars
            WHERE timeframe = ? AND session_date = ?
            ORDER BY bar_time
            LIMIT ?
            """
            rows = con.execute(q, [timeframe, sess, limit_per_session]).fetchdf()
            if len(rows) < warm + 5:
                continue
            out = regime.compute_ranks(rows.copy(), timeframe=timeframe)
            m = _eligible_mask(out, warm)
            for c, acc in (("vol_score", all_v), ("depth_score", all_d)):
                s = out.loc[m, c].dropna()
                acc.extend(float(x) for x in s if x is not None)
    finally:
        con.close()

    print(f"=== DuckDB {len(sessions)} session(s) sampled, timeframe={timeframe} ===")
    _print_hist("vol_score", np.array(all_v, dtype=np.float64))
    _print_hist("depth_score", np.array(all_d, dtype=np.float64))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Regime scatter score histograms")
    ap.add_argument("--db", type=Path, default=Path(os.environ.get("ORDERFLOW_DB_PATH", str(_DEFAULT_DB))))
    ap.add_argument("--timeframe", default="1m")
    ap.add_argument("--max-sessions", type=int, default=20)
    ap.add_argument("--limit-per-session", type=int, default=800, help="bars per session (cap for speed)")
    ap.add_argument("--synthetic", action="store_true", help="ignore DB; random single session")
    ap.add_argument("--bars", type=int, default=5000, help="with --synthetic, bar count")
    args = ap.parse_args()
    if args.synthetic:
        _run_synthetic(args.bars)
        return 0
    return _run_db(args.db, args.timeframe, args.max_sessions, args.limit_per_session)


if __name__ == "__main__":
    sys.exit(main())
