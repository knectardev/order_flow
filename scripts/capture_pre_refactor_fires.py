from __future__ import annotations

import json
from pathlib import Path

import duckdb


DB_PATH = Path("data/orderflow.duckdb")
OUT_PATH = Path("pipeline/tests/baseline/pre_refactor_fires.json")


def main() -> int:
    if not DB_PATH.exists():
        print(f"DB not found: {DB_PATH}")
        return 2
    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        rows = con.execute(
            """
            SELECT
                ROW_NUMBER() OVER (ORDER BY timeframe, bar_time, watch_id, direction, price) AS fire_id,
                bar_time,
                timeframe,
                watch_id,
                direction,
                price,
                NULL AS checks,
                NULL AS passing,
                NULL AS total,
                NULL AS alignment,
                NULL AS tag,
                NULL AS strategy_extras
            FROM fires
            ORDER BY timeframe, bar_time, watch_id, direction, price
            """
        ).fetchall()
    finally:
        con.close()

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = []
    for r in rows:
        payload.append(
            {
                "fire_id": int(r[0]),
                "timestamp": r[1].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "timeframe": r[2],
                "watch_id": r[3],
                "direction": r[4],
                "price": float(r[5]),
                "checks": r[6],
                "passing": r[7],
                "total": r[8],
                "alignment": r[9],
                "tag": r[10],
                "strategy_extras": r[11],
            }
        )
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote baseline fires snapshot: {OUT_PATH} ({len(payload)} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
