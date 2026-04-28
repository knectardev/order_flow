from __future__ import annotations

from datetime import datetime
from pathlib import Path
import sys

import duckdb

ROOT = Path(__file__).resolve().parents[1]
PIPELINE_SRC = ROOT / "pipeline" / "src"
if str(PIPELINE_SRC) not in sys.path:
    sys.path.append(str(PIPELINE_SRC))

from orderflow_pipeline.backtest_engine import BacktestEngine, BrokerConfig
from orderflow_pipeline.db import init_schema


def main() -> int:
    con = duckdb.connect("data/orderflow.duckdb")
    init_schema(con)
    try:
        engine = BacktestEngine(con)
        for tf in ("1m", "15m", "1h"):
            lo, hi = con.execute(
                "SELECT MIN(bar_time), MAX(bar_time) FROM bars WHERE timeframe = ?",
                [tf],
            ).fetchone()
            if lo is None or hi is None:
                print(f"{tf}: skipped (no bars)")
                continue
            out = engine.run(
                timeframe=tf,
                from_time=lo if isinstance(lo, datetime) else datetime.fromisoformat(str(lo)),
                to_time=hi if isinstance(hi, datetime) else datetime.fromisoformat(str(hi)),
                config=BrokerConfig(),
                watch_ids={"valueEdgeReject"},
                use_regime_filter=True,
            )
            print(f"{tf}: ok runId={out['runId']} trades={out['tradeCount']} sharpe={out['sharpe']}")
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    raise SystemExit(main())
