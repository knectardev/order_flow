"""Phase 1e verification HARD GATE (regime-DB plan §1e).

Purpose
-------
Confirm that the API mode (DuckDB-backed) and the JSON mode (data/bars/*.json)
produce equivalent bars, with strict equality on integer fields and
abs_tol=1e-9 on floats.

This script is the gate that proves Phase 1's data path swap is purely a
plumbing change, not a behavior change. Any drift here will surface a real
aggregator bug — by Phase 1's contract, the JSON writer and the DuckDB
writer consume the same already-rounded scalars from `Bar.to_json()` /
`Bar.to_dict()`, so floats should be bit-identical, not just within tol.
The 1e-9 tolerance exists strictly to absorb DuckDB's float64 round-trip
noise (which is empirically zero today, but the test stays robust if e.g.
DuckDB's ORJSON serializer ever changes encoding precision).

Checks
------
A) For every JSON session under data/bars/*_<session>.json:
   1. Parse the JSON file and extract its bar list.
   2. Hit the API at /bars?session_date=<date> and extract its bar list.
   3. Assert bar count match.
   4. For each (json_bar, api_bar) pair, assert exact equality on int
      fields (volume, delta, tradeCount, largePrintCount, distinctPrices,
      time) and 1e-9 abs_tol equality on floats (open, high, low, close,
      vpt, concentration, avgTradeSize). Phase 2+ adds rangePct/vRank/dRank.

B) DuckDB self-consistency:
   For every bar in `bars`, the sum of its `bar_volume_profile.volume`
   rows must equal `bars.volume`, and the sum of its `bar_volume_profile.delta`
   rows must equal `bars.delta`. This catches any per-tick accumulation bug
   in the aggregator (e.g. forgetting to update `price_delta` for `side='N'`
   trades).

Phases
------
- Default (Phase 1): rangePct, vRank, dRank are NULL on the API side and
  not present in JSON; we assert the API field is None and skip JSON-side
  comparison for those columns.
- `--phase 2`: rangePct/vRank/dRank are populated by `regime.compute_ranks`.
  We require both API and JSON to expose them with the same numeric values
  (within tol for the float, exact for the int ranks). JSON-side support is
  added by serialize.py in Phase 2c-d; if those fields are missing the
  script reports it as a FAIL rather than skipping silently.

Exit code: 0 on success, 1 on any FAIL. CI / `orderflow_pipeline rebuild`
should chain into this script and abort the loop if it returns non-zero.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_API_BASE = "http://127.0.0.1:8001"
DEFAULT_BARS_DIR = REPO_ROOT / "data" / "bars"
DEFAULT_DB_PATH = REPO_ROOT / "data" / "orderflow.duckdb"

ABS_TOL = 1e-9

# Fields and their type-class. Used to drive equality checks generically.
INT_FIELDS_PHASE1 = (
    "volume",
    "delta",
    "tradeCount",
    "largePrintCount",
    "distinctPrices",
)
FLOAT_FIELDS_PHASE1 = (
    "open",
    "high",
    "low",
    "close",
    "avgTradeSize",
    "vpt",
    "concentration",
)
INT_FIELDS_PHASE2 = ("vRank", "dRank")
FLOAT_FIELDS_PHASE2 = ("rangePct",)


def _get_json(url: str) -> dict:
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def _close_enough(a: float | None, b: float | None) -> bool:
    """True if a and b match exactly (incl. both None) or within ABS_TOL."""
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if math.isnan(a) and math.isnan(b):
        return True
    return math.isclose(a, b, abs_tol=ABS_TOL, rel_tol=0.0)


def _compare_bar(json_bar: dict, api_bar: dict, idx: int, phase: int) -> list[str]:
    """Return a list of mismatch descriptions for one bar pair (empty == ok)."""
    errors: list[str] = []

    # `time` must be exact ISO string equality.
    if json_bar.get("time") != api_bar.get("time"):
        errors.append(
            f"  bar #{idx}: time {json_bar.get('time')!r} (JSON) != {api_bar.get('time')!r} (API)"
        )

    for f in INT_FIELDS_PHASE1:
        jv = json_bar.get(f)
        av = api_bar.get(f)
        if jv != av:
            errors.append(f"  bar #{idx}: int field {f!r} {jv!r} (JSON) != {av!r} (API)")

    for f in FLOAT_FIELDS_PHASE1:
        jv = json_bar.get(f)
        av = api_bar.get(f)
        # `distinctPrices`/`vpt`/`concentration` were ADDED to JSON in
        # Phase 1b. Older JSON dumps won't have them — that's fine for the
        # transition window, but once the user has run `orderflow_pipeline
        # rebuild` (which re-emits JSON via the new serializer), the field
        # MUST be present on both sides.
        if jv is None and av is None:
            continue
        if not _close_enough(jv, av):
            errors.append(
                f"  bar #{idx}: float field {f!r} {jv!r} (JSON) != {av!r} (API) "
                f"(diff={None if jv is None or av is None else abs(jv - av):.3e})"
            )

    if phase >= 2:
        for f in INT_FIELDS_PHASE2:
            jv = json_bar.get(f)
            av = api_bar.get(f)
            if jv != av:
                errors.append(f"  bar #{idx}: phase-2 int {f!r} {jv!r} (JSON) != {av!r} (API)")
        for f in FLOAT_FIELDS_PHASE2:
            jv = json_bar.get(f)
            av = api_bar.get(f)
            if not _close_enough(jv, av):
                errors.append(f"  bar #{idx}: phase-2 float {f!r} {jv!r} (JSON) != {av!r} (API)")
    else:
        # Phase 1: rank columns must be NULL in the API response. JSON
        # serializer doesn't emit them yet, so JSON side is "missing" =
        # treated as None for this check.
        for f in ("rangePct", "vRank", "dRank"):
            av = api_bar.get(f)
            if av is not None:
                errors.append(
                    f"  bar #{idx}: phase-1 expected {f!r} == None on API side; got {av!r}"
                )

    return errors


def _verify_session(json_path: Path, api_base: str, phase: int) -> tuple[int, list[str]]:
    """Returns (n_bars_compared, errors)."""
    with json_path.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    json_bars = payload.get("bars", [])
    session_date = payload.get("date")
    if not session_date:
        return (0, [f"{json_path.name}: missing 'date' in JSON payload"])

    api_url = f"{api_base}/bars?{urlencode({'session_date': session_date})}"
    try:
        api = _get_json(api_url)
    except Exception as exc:
        return (0, [f"{json_path.name}: API GET {api_url} failed: {exc}"])
    api_bars = api.get("bars", [])

    if len(json_bars) != len(api_bars):
        return (0, [
            f"{json_path.name}: bar count mismatch JSON={len(json_bars)} API={len(api_bars)}"
        ])

    errors: list[str] = []
    for i, (jb, ab) in enumerate(zip(json_bars, api_bars)):
        errors.extend(_compare_bar(jb, ab, i, phase))
        # Cap the per-session error list so a runaway aggregator bug doesn't
        # produce 100k lines of output. The first ~10 are usually enough to
        # diagnose drift.
        if len(errors) > 10:
            errors.append(f"  ... (more errors; truncated at 10)")
            break

    if errors:
        errors.insert(0, f"{json_path.name} (session_date={session_date}): {len(errors)} mismatch(es)")
    return (len(json_bars), errors)


def _verify_db_self_consistency(db_path: Path) -> list[str]:
    """Check: SUM(bar_volume_profile.volume) == bars.volume per bar_time, and
    SUM(bar_volume_profile.delta) == bars.delta per bar_time."""
    try:
        import duckdb
    except ImportError:
        return ["duckdb python module not installed; pip install duckdb"]
    if not db_path.exists():
        return [f"DuckDB file not found at {db_path}"]
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        rows = con.execute(
            """
            WITH p AS (
                SELECT bar_time,
                       SUM(volume) AS vol_sum,
                       SUM(delta)  AS delta_sum
                FROM bar_volume_profile
                GROUP BY bar_time
            )
            SELECT b.bar_time, b.volume, COALESCE(p.vol_sum, 0),
                   b.delta,  COALESCE(p.delta_sum, 0)
            FROM bars b
            LEFT JOIN p USING (bar_time)
            WHERE COALESCE(p.vol_sum, 0)   <> b.volume
               OR COALESCE(p.delta_sum, 0) <> b.delta
            LIMIT 10
            """
        ).fetchall()
    finally:
        con.close()
    if not rows:
        return []
    out = [f"bar_volume_profile self-consistency FAILED: {len(rows)} bar(s) drifted (showing up to 10)"]
    for bt, bv, pv, bd, pd in rows:
        out.append(f"  bar_time={bt} bars.volume={bv} profile.sum={pv}; bars.delta={bd} profile.sum={pd}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase 1e API↔JSON equivalence verifier.")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE,
                        help=f"FastAPI base URL (default: {DEFAULT_API_BASE})")
    parser.add_argument("--bars-dir", default=str(DEFAULT_BARS_DIR),
                        help=f"Directory containing per-session JSON files (default: {DEFAULT_BARS_DIR})")
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH),
                        help=f"DuckDB file (default: {DEFAULT_DB_PATH})")
    parser.add_argument("--phase", type=int, default=1, choices=(1, 2),
                        help="1=skip rank fields, 2=require rank-field parity (default: 1)")
    parser.add_argument("--limit", type=int, default=None,
                        help="If set, only verify the first N session JSONs (smoke check)")
    args = parser.parse_args()

    bars_dir = Path(args.bars_dir)
    if not bars_dir.exists():
        print(f"FAIL: bars-dir {bars_dir} not found", file=sys.stderr)
        return 1

    # Sort so output is deterministic and progress reports are intuitive.
    # Skip index.json (it's a manifest, not a per-session payload).
    sessions = sorted(p for p in bars_dir.glob("*.json") if p.name != "index.json")
    if args.limit is not None:
        sessions = sessions[: args.limit]
    if not sessions:
        print(f"FAIL: no session JSON files in {bars_dir}", file=sys.stderr)
        return 1

    print(f"Phase {args.phase} verify: {len(sessions)} session(s) under {bars_dir}")
    print(f"  API base: {args.api_base}")
    print(f"  DB path:  {args.db_path}")

    total_bars = 0
    total_errors: list[str] = []
    for sp in sessions:
        n, errs = _verify_session(sp, args.api_base, args.phase)
        total_bars += n
        if errs:
            for line in errs:
                print(line)
            total_errors.extend(errs)
        else:
            print(f"  OK  {sp.name} ({n} bars)")

    print(f"\nDB self-consistency check on {args.db_path} ...")
    db_errs = _verify_db_self_consistency(Path(args.db_path))
    if db_errs:
        for line in db_errs:
            print(line)
        total_errors.extend(db_errs)
    else:
        print("  OK  bar_volume_profile sums match bars.volume / bars.delta")

    print(f"\nTotal: {total_bars} bars across {len(sessions)} sessions; "
          f"{len(total_errors)} error line(s).")
    if total_errors:
        print("RESULT: FAIL")
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
