"""One-shot Phase 5 verification probe.

Runs the SQL queries `notes.txt` §"Phase 5 verification" calls for, plus
a few sanity checks on rank emission, partial-bar counts, and EXPLAIN
output for the composite index. Intended to be run AFTER `rebuild` —
this is the verify step in the Phase 5 build plan.
"""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb


def main(db_path: str = "data/orderflow.duckdb") -> int:
    p = Path(db_path)
    if not p.exists():
        print(f"DB not found at {p}", file=sys.stderr)
        return 1
    con = duckdb.connect(str(p), read_only=True)

    print("=" * 70)
    print(f"  Phase 5 verification — {p}")
    print("=" * 70)

    # 1. Bar counts per timeframe.
    print("\n[1] Bar counts per timeframe:")
    rows = con.execute(
        "SELECT timeframe, COUNT(*) AS n_bars, COUNT(DISTINCT session_date) AS n_sessions "
        "FROM bars GROUP BY timeframe ORDER BY timeframe"
    ).fetchall()
    for tf, n_bars, n_sess in rows:
        per_session = n_bars / n_sess if n_sess else 0
        print(f"  {tf:>4}: {n_bars:>6} bars across {n_sess} sessions ({per_session:.2f}/session)")

    # 2. Available timeframes (drives /timeframes).
    print("\n[2] /timeframes endpoint contract — distinct timeframes in `bars`:")
    tfs = [r[0] for r in con.execute(
        "SELECT DISTINCT timeframe FROM bars ORDER BY timeframe"
    ).fetchall()]
    print(f"  {tfs}")

    # 3. Volume profile rows per timeframe.
    print("\n[3] bar_volume_profile rows per timeframe:")
    rows = con.execute(
        "SELECT timeframe, COUNT(*) FROM bar_volume_profile "
        "GROUP BY timeframe ORDER BY timeframe"
    ).fetchall()
    for tf, n in rows:
        print(f"  {tf:>4}: {n:>7} profile rows")

    # 4. Regime ranks emit per timeframe.
    # A bar with v_rank IS NULL is in the warmup window (or zero-volume).
    print("\n[4] Rank emission rate per timeframe:")
    rows = con.execute(
        """
        SELECT timeframe,
               COUNT(*) AS total,
               SUM(CASE WHEN v_rank IS NULL THEN 1 ELSE 0 END) AS null_v
        FROM bars
        GROUP BY timeframe
        ORDER BY timeframe
        """
    ).fetchall()
    for tf, total, null_v in rows:
        emit = total - null_v
        print(f"  {tf:>4}: {emit:>5}/{total} non-NULL ({100*emit/total:.1f}%); {null_v} NULL")

    # 5. Hybrid-warmup contract: with 1h warmup=8 and only 6 bars/session,
    # session 1 ranks are entirely NULL (no seed available). Session 2's
    # first bar still has only 6+1=7 bars in the working frame (< warmup),
    # so bar 0 is NULL. Bar 1 reaches 6+2=8 bars and emits. Session 3+
    # have enough seed for all bars.
    print("\n[5] 1h hybrid-warmup rank emission across sessions 1..3:")
    sessions_1h = [r[0] for r in con.execute(
        "SELECT DISTINCT session_date FROM bars WHERE timeframe='1h' "
        "ORDER BY session_date"
    ).fetchall()]
    for sd in sessions_1h[:3]:
        rows = con.execute(
            "SELECT bar_time, v_rank, d_rank FROM bars "
            "WHERE timeframe='1h' AND session_date=? "
            "ORDER BY bar_time",
            [sd],
        ).fetchall()
        for i, (bt, vr, dr) in enumerate(rows):
            print(f"  {sd} bar {i}: v_rank={vr}, d_rank={dr}")
        print()

    # 6. Partial-bar drop sanity: zero 1h bars should land at 09:00 ET
    # (the leading-partial bin we drop). 09:00 ET = 13:00 UTC (DST) or
    # 14:00 UTC (non-DST), so we check via "bar_time hour-of-day in
    # {13, 14} when extracted in UTC" — those are the dropped-leading
    # bin starts.
    print("\n[6] Leading 1h partial-bar drop sanity:")
    n_partials = con.execute(
        "SELECT COUNT(*) FROM bars WHERE timeframe='1h' AND "
        "EXTRACT(MINUTE FROM bar_time) <> 0"
    ).fetchone()[0]
    print(f"  1h bars NOT on top-of-hour: {n_partials} (expect 0)")
    # Also check no 1h bar starts at 09:00 ET (= 13:00 or 14:00 UTC depending on DST).
    bad_starts = con.execute(
        "SELECT COUNT(DISTINCT session_date) FROM bars "
        "WHERE timeframe='1h' AND EXTRACT(HOUR FROM bar_time) IN (13, 14) "
        "AND CAST(bar_time AS TIME) IN ('13:00:00', '14:00:00')"
    ).fetchone()[0]
    # Summary: every session has a 10:00 ET first 1h bar and no 09:00 ET partial.
    first_bars = con.execute(
        "SELECT bar_time, session_date FROM bars WHERE timeframe='1h' "
        "ORDER BY session_date, bar_time"
    ).fetchall()
    # Group by session and grab the first.
    seen = set()
    first_per_session = []
    for bt, sd in first_bars:
        if sd in seen:
            continue
        seen.add(sd)
        first_per_session.append((sd, bt))
    sample = first_per_session[:5] + first_per_session[-2:]
    print("  first 1h bar per session (sample):")
    for sd, bt in sample:
        print(f"    {sd}: {bt}")

    # 7. EXPLAIN on /bars cell-IN brushing — verify idx_bars_tf_rank used.
    print("\n[7] EXPLAIN /bars cell-IN probe (looking for idx_bars_tf_rank):")
    plan = con.execute(
        "EXPLAIN SELECT * FROM bars WHERE timeframe='15m' "
        "AND (v_rank, d_rank) IN ((3, 2), (4, 1))"
    ).fetchall()
    plan_text = "\n".join(r[1] if len(r) > 1 else r[0] for r in plan)
    # Ascii-fy DuckDB's box-drawing chars so cp1252 stdout doesn't blow up.
    plan_text_ascii = plan_text.encode("ascii", "replace").decode("ascii")
    # DuckDB plans show the index name in lowercase as part of the scan
    # node — look for 'idx_bars_tf_rank' or any 'INDEX_SCAN' / 'Filter'
    # path that uses one of our composite indexes.
    has_idx = (
        "idx_bars_tf_rank" in plan_text
        or "idx_bars_tf_session" in plan_text
        or "INDEX_SCAN" in plan_text.upper()
    )
    print(f"  uses tf composite index: {has_idx}")
    if not has_idx:
        for line in plan_text_ascii.splitlines()[:18]:
            print(f"    {line}")

    # 8. Per-session bar_counts shape (drives /sessions).
    print("\n[8] Per-session bar_counts (drives /sessions endpoint, sample):")
    rows = con.execute(
        """
        SELECT session_date,
               SUM(CASE WHEN timeframe='1m' THEN 1 ELSE 0 END) AS n1m,
               SUM(CASE WHEN timeframe='15m' THEN 1 ELSE 0 END) AS n15m,
               SUM(CASE WHEN timeframe='1h' THEN 1 ELSE 0 END) AS n1h
        FROM bars GROUP BY session_date ORDER BY session_date LIMIT 5
        """
    ).fetchall()
    for sd, n1m, n15m, n1h in rows:
        print(f"  {sd}: 1m={n1m:>3}, 15m={n15m:>2}, 1h={n1h}")

    con.close()
    print("\n" + "=" * 70)
    print("  Verification complete.")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "data/orderflow.duckdb"))
