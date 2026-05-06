#!/usr/bin/env python3
"""One-shot backfill: set bars.trade_context from jitter_regime + conviction_regime.

Use on existing DuckDB files where ingest predates ``trade_context``. Fresh
aggregate/rebuild runs stamp this column automatically — this script only
fills NULL legacy rows.

Example:
  python scripts/migrate_trade_context.py data/orderflow.duckdb
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
_PIPELINE_SRC = _REPO_ROOT / "pipeline" / "src"
if str(_PIPELINE_SRC) not in sys.path:
    sys.path.insert(0, str(_PIPELINE_SRC))

from orderflow_pipeline.db import connect, init_schema  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Backfill bars.trade_context from velocity regimes.")
    p.add_argument("duckdb_path", type=Path, help="Path to DuckDB file")
    args = p.parse_args()
    path = args.duckdb_path.expanduser().resolve()
    if not path.is_file():
        print(f"error: not a file: {path}", file=sys.stderr)
        return 2

    con = connect(path)
    init_schema(con)
    # Same semantics as orderflow_pipeline.velocity_regime.trade_context_from_regimes
    con.execute(
        """
        UPDATE bars
        SET trade_context = CASE
          WHEN jitter_regime = 'Low' AND conviction_regime = 'High' THEN 'favorable'
          WHEN jitter_regime = 'High' AND conviction_regime = 'Low' THEN 'avoid'
          WHEN jitter_regime = 'High' AND conviction_regime = 'High' THEN 'watch'
          ELSE 'neutral'
        END
        WHERE trade_context IS NULL
        """
    )
    con.close()
    print(f"OK: updated trade_context where NULL -- {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
