"""One-shot diagnostic: verify whether the Phase 6 bias columns are
populated in the DuckDB this dashboard is reading. Prints (a) row counts
of bias_state per timeframe, (b) parent_*_bias coverage on the LTF rows,
and (c) the most recent few 1m rows so we can see what's actually stored
for the bars the dashboard just rendered.

Usage: python scratch/inspect_bias.py [path_to_duckdb]
"""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb

DEFAULT_DB = Path("data/orderflow.duckdb")


def main() -> int:
    db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DB
    if not db_path.exists():
        print(f"DB not found: {db_path}", file=sys.stderr)
        return 2
    print(f"DB: {db_path.resolve()}")
    con = duckdb.connect(str(db_path), read_only=True)

    print("\n--- bias_state coverage by timeframe ---")
    print(con.execute(
        "SELECT timeframe, "
        "       COUNT(*)            AS n_total, "
        "       COUNT(bias_state)   AS n_bias, "
        "       COUNT(*) FILTER (WHERE bias_state IS NULL) AS n_null "
        "FROM bars GROUP BY 1 ORDER BY 1"
    ).fetchdf().to_string(index=False))

    print("\n--- parent_*_bias coverage (LTF rows only) ---")
    print(con.execute(
        "SELECT timeframe, "
        "       COUNT(*) AS n_total, "
        "       COUNT(parent_1h_bias)  AS n_parent_1h, "
        "       COUNT(parent_15m_bias) AS n_parent_15m "
        "FROM bars "
        "WHERE timeframe IN ('1m','15m') "
        "GROUP BY 1 ORDER BY 1"
    ).fetchdf().to_string(index=False))

    print("\n--- distribution of parent_1h_bias values on 1m ---")
    print(con.execute(
        "SELECT COALESCE(parent_1h_bias, '<NULL>') AS parent_1h_bias, "
        "       COUNT(*) AS n "
        "FROM bars WHERE timeframe='1m' "
        "GROUP BY 1 ORDER BY n DESC"
    ).fetchdf().to_string(index=False))

    print("\n--- last 5 1m rows (newest sessions) ---")
    print(con.execute(
        "SELECT bar_time, session_date, v_rank, d_rank, vwap, "
        "       bias_state, parent_1h_bias, parent_15m_bias "
        "FROM bars WHERE timeframe='1m' "
        "ORDER BY bar_time DESC LIMIT 5"
    ).fetchdf().to_string(index=False))

    print("\n--- vwap coverage by timeframe ---")
    print(con.execute(
        "SELECT timeframe, "
        "       COUNT(*) AS n_total, "
        "       COUNT(vwap) AS n_vwap_notnull, "
        "       SUM(CASE WHEN vwap IS NULL OR isnan(vwap) THEN 1 ELSE 0 END) AS n_vwap_missing "
        "FROM bars GROUP BY 1 ORDER BY 1"
    ).fetchdf().to_string(index=False))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
