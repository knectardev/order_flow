#!/usr/bin/env python3
"""Quick DuckDB checks after PLD rebuild (path/range metric)."""
from __future__ import annotations

import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_PIPELINE_SRC = _REPO / "pipeline" / "src"
if str(_PIPELINE_SRC) not in sys.path:
    sys.path.insert(0, str(_PIPELINE_SRC))

import duckdb  # noqa: E402


def main() -> int:
    db = Path(sys.argv[1]) if len(sys.argv) > 1 else _REPO / "data" / "orderflow.duckdb"
    if not db.is_file():
        print(f"error: not found: {db}", file=sys.stderr)
        return 2
    con = duckdb.connect(str(db), read_only=True)
    print("=== COUNT near legacy cap (~100) ===")
    q1 = """
        SELECT COUNT(*) AS near_old_cap
        FROM bars
        WHERE pld_ratio IS NOT NULL AND ABS(pld_ratio - 100) < 1e-6
    """
    print(con.execute(q1).fetchall())
    print()
    print("=== approx_quantile by timeframe, session_kind ===")
    q2 = """
        SELECT timeframe, session_kind,
               approx_quantile(pld_ratio, 0.50) AS p50,
               approx_quantile(pld_ratio, 0.99) AS p99,
               MAX(pld_ratio) AS mx
        FROM bars
        WHERE pld_ratio IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1, 2
    """
    print(con.execute(q2).fetchdf().to_string(index=False))
    print()
    print("=== NULL pld_ratio counts ===")
    q3 = """
        SELECT timeframe, session_kind,
               SUM(CASE WHEN pld_ratio IS NULL THEN 1 ELSE 0 END) AS null_pld,
               COUNT(*) AS n
        FROM bars
        GROUP BY 1, 2
        ORDER BY 1, 2
    """
    print(con.execute(q3).fetchdf().to_string(index=False))
    con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
