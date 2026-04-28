from __future__ import annotations

import json
from pathlib import Path

import duckdb


BASELINE_PATH = Path("pipeline/tests/baseline/pre_refactor_fires.json")
REPORT_PATH = Path("docs/ssot-refactor-parity-report.md")
DB_PATH = Path("data/orderflow.duckdb")


def _key(row: dict) -> tuple[str, str, str]:
    return (row["timestamp"], row["watch_id"], row["direction"] or "")


def main() -> int:
    if not BASELINE_PATH.exists():
        print(f"Missing baseline: {BASELINE_PATH}")
        return 2
    if not DB_PATH.exists():
        print(f"Missing DB: {DB_PATH}")
        return 2
    baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        rows = con.execute(
            """
            SELECT
              strftime(bar_time, '%Y-%m-%dT%H:%M:%SZ') AS timestamp,
              watch_id,
              direction,
              diagnostic_version,
              diagnostics_json
            FROM fires
            WHERE timeframe = '1m'
            ORDER BY bar_time, watch_id, direction
            """
        ).fetchall()
    finally:
        con.close()

    current = [
        {
            "timestamp": r[0],
            "watch_id": r[1],
            "direction": r[2],
            "diagnostic_version": r[3],
            "diagnostics_json": r[4],
        }
        for r in rows
    ]
    base_keys = {_key(r) for r in baseline if r.get("timeframe") == "1m"}
    curr_keys = {_key(r) for r in current}
    missing = sorted(base_keys - curr_keys)
    added = sorted(curr_keys - base_keys)
    with_diag = sum(1 for r in current if r["diagnostic_version"] and r["diagnostics_json"])

    report = [
        "# SSoT Refactor Parity Report",
        "",
        "## Baseline",
        f"- Baseline file: `{BASELINE_PATH}`",
        f"- Baseline fires (1m): {len(base_keys)}",
        "",
        "## Current",
        f"- Current fires (1m): {len(curr_keys)}",
        f"- Current fires with diagnostics payload: {with_diag}",
        "",
        "## Identity Parity",
        f"- Missing vs baseline: {len(missing)}",
        f"- Added vs baseline: {len(added)}",
        "",
        "## Disposition",
    ]
    if not missing and not added:
        report.append("- PASS: 1m fire identity parity is exact.")
    else:
        report.append("- FAIL: fire identity drift detected; review missing/added keys below.")
    if missing:
        report.append("")
        report.append("### Missing Keys")
        report.extend([f"- {k}" for k in missing[:50]])
    if added:
        report.append("")
        report.append("### Added Keys")
        report.extend([f"- {k}" for k in added[:50]])
    REPORT_PATH.write_text("\n".join(report) + "\n", encoding="utf-8")
    print(f"Wrote report: {REPORT_PATH}")
    return 0 if not missing and not added else 1


if __name__ == "__main__":
    raise SystemExit(main())
