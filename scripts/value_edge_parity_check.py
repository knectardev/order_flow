"""Strict Value Edge parity checker.

Compares a baseline run (legacy high-Sharpe reference) against a candidate
unified run using exact equality for Sharpe and equity points.

Note: Runs that enable broker-level SL/TP (`stop_loss_ticks` / `take_profit_ticks`)
will diverge from legacy flip-only baselines — use flip-only configs when parity
checking signal plumbing; capture a new baseline when validating risk-adjusted runs.
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import duckdb


def _fetch_run(con: duckdb.DuckDBPyConnection, run_id: str) -> tuple[float | None, list[tuple]]:
    row = con.execute(
        "SELECT sharpe FROM backtest_runs WHERE run_id = ?",
        [run_id],
    ).fetchone()
    if row is None:
        raise ValueError(f"run_id={run_id} not found in backtest_runs")
    sharpe = row[0]
    points = con.execute(
        """
        SELECT bar_time, equity, cash, unrealized_pnl, realized_pnl
        FROM backtest_equity
        WHERE run_id = ?
        ORDER BY bar_time
        """,
        [run_id],
    ).fetchall()
    return sharpe, points


def _eq_or_both_none(a: float | None, b: float | None) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return a == b and not (math.isnan(a) or math.isnan(b))


def main() -> int:
    p = argparse.ArgumentParser(description="Validate strict Value Edge run parity.")
    p.add_argument("--db-path", default="data/orderflow.duckdb")
    p.add_argument("--baseline-run-id", required=True)
    p.add_argument("--candidate-run-id", required=True)
    args = p.parse_args()

    db_path = Path(args.db_path)
    if not db_path.exists():
        raise SystemExit(f"DB not found: {db_path}")

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        base_sharpe, base_pts = _fetch_run(con, args.baseline_run_id)
        cand_sharpe, cand_pts = _fetch_run(con, args.candidate_run_id)
    finally:
        con.close()

    ok_sharpe = _eq_or_both_none(base_sharpe, cand_sharpe)
    ok_len = len(base_pts) == len(cand_pts)
    ok_points = ok_len and base_pts == cand_pts

    print(f"baseline_run_id={args.baseline_run_id}")
    print(f"candidate_run_id={args.candidate_run_id}")
    print(f"sharpe_equal={ok_sharpe} baseline={base_sharpe} candidate={cand_sharpe}")
    print(f"equity_len_equal={ok_len} baseline={len(base_pts)} candidate={len(cand_pts)}")
    print(f"equity_points_equal={ok_points}")

    if not (ok_sharpe and ok_points):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

