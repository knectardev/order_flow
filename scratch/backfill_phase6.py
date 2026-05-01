"""One-shot backfill for the Phase 6 columns on a pre-Phase-6 DuckDB.

Recomputes (in this order):
  1. ``bars.vwap``            — session-anchored running VWAP via the
     same typical-price formula as ``_stamp_session_vwap`` in
     ``orderflow_pipeline/aggregate.py``.
  2. ``bars.bias_state``      — 7-level bias from
     ``orderflow_pipeline/bias.compute_bias_column`` using the
     freshly-stamped ``vwap`` plus the existing ``v_rank`` / ``d_rank``.
  3. ``bars.parent_1h_bias``  — denormalized 1h bias projected onto 15m
     and 1m rows via the same half-open ``[HTF.bar_time, HTF.bar_time +
     interval)`` JOIN that ``cli._stamp_parent_bias`` uses.
  4. ``bars.parent_15m_bias`` — same, 15m parent onto 1m rows.

Idempotent: safe to re-run. Each session × timeframe is recomputed
end-to-end and written back via UPDATE on the (bar_time, timeframe)
primary key. Sessions are processed HTF-first (1h → 15m → 1m) so the
parent-bias UPDATEs find populated HTF rows when they run.

Reads/writes the same DB the API uses (``data/orderflow.duckdb`` by
default; override with ``ORDERFLOW_DB_PATH`` env var or argv[1]).

Usage::

    python scratch/backfill_phase6.py            # default DB
    python scratch/backfill_phase6.py path/to.db # explicit path

After this completes, restart the API server (``uvicorn`` / equivalent)
so any cached bar reads pick up the new columns, then refresh the
dashboard. The bias ribbon should show colored cells and event-log
fires should start carrying non-zero alignment scores.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import duckdb
import pandas as pd

# Allow the script to import the pipeline package without a `pip install -e`
# step. Resolves to <repo>/pipeline/src on the import path.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "pipeline" / "src"))

from orderflow_pipeline.bias import compute_bias_column  # noqa: E402

DEFAULT_DB = Path(os.environ.get("ORDERFLOW_DB_PATH", "data/orderflow.duckdb"))

# Mirror cli.HTF_PARENTS_BY_LTF — duplicated here so this script doesn't
# require importing cli.py (which pulls in databento etc. via its
# transitive imports). The semantics must stay aligned with cli.py if
# that file changes.
HTF_PARENTS_BY_LTF: dict[str, tuple[tuple[str, str], ...]] = {
    "1m": (
        ("1h",  "parent_1h_bias"),
        ("15m", "parent_15m_bias"),
    ),
    "15m": (
        ("1h",  "parent_1h_bias"),
    ),
    "1h": (),
}

# HTF-first so the parent-bias JOIN lands on populated parent rows.
TIMEFRAMES_ORDERED: tuple[str, ...] = ("1h", "15m", "1m")


def _stamp_vwap_for_session(df: pd.DataFrame) -> pd.DataFrame:
    """Replicates aggregate._stamp_session_vwap for a single session
    DataFrame. Mutates a copy and returns it. Empty bars (volume <= 0)
    carry forward the previous bar's vwap.

    Input must be sorted by bar_time ascending and contain columns
    ``high``, ``low``, ``close``, ``volume``. Output adds/overwrites a
    ``vwap`` column.
    """
    out = df.copy()
    cum_pv = 0.0
    cum_v = 0
    last_vwap: float | None = None
    vwaps: list[float | None] = []
    for _, row in out.iterrows():
        vol = int(row["volume"]) if row["volume"] is not None else 0
        if vol <= 0:
            vwaps.append(last_vwap)
            continue
        typical = (float(row["high"]) + float(row["low"]) + float(row["close"])) / 3.0
        cum_pv += typical * vol
        cum_v += vol
        last_vwap = round(cum_pv / cum_v, 4)
        vwaps.append(last_vwap)
    out["vwap"] = vwaps
    return out


def _backfill_vwap_and_bias(con: duckdb.DuckDBPyConnection, tf: str) -> int:
    """Compute vwap + bias_state for every (session_date) of one
    timeframe and UPDATE the bars table in bulk. Returns the number of
    rows updated.
    """
    sessions = con.execute(
        "SELECT DISTINCT session_date FROM bars WHERE timeframe = ? ORDER BY session_date",
        [tf],
    ).fetchall()
    if not sessions:
        print(f"  [{tf}] no rows; skipping")
        return 0

    total = 0
    print(f"  [{tf}] backfilling {len(sessions)} session(s)...")
    for (session_date,) in sessions:
        df = con.execute(
            "SELECT bar_time, high, low, close, volume, v_rank, d_rank "
            "FROM bars "
            "WHERE timeframe = ? AND session_date = ? "
            "ORDER BY bar_time",
            [tf, session_date],
        ).fetchdf()
        if df.empty:
            continue

        df = _stamp_vwap_for_session(df)
        # Coerce DuckDB's nullable Int64 (pandas pd.NA) v_rank / d_rank to
        # plain Python None / int so compute_bias_column's NaN guards
        # (`x != x`) don't trip on pd.NA truthiness. The pipeline writer
        # path doesn't hit this because it builds the DataFrame from
        # plain dicts upstream.
        for col in ("v_rank", "d_rank"):
            df[col] = df[col].astype(object).where(df[col].notna(), None)
        df = compute_bias_column(df, tf)

        # DuckDB has no row-by-row UPDATE-from-DataFrame helper, so we
        # register the recomputed slice as a temp view and join on the
        # composite key. Single statement → atomic per session.
        update_df = df[["bar_time", "vwap", "bias_state"]]
        con.register("__phase6_update", update_df)
        con.execute(
            "UPDATE bars "
            "SET vwap = u.vwap, "
            "    bias_state = u.bias_state "
            "FROM __phase6_update AS u "
            "WHERE bars.timeframe = ? "
            "  AND bars.session_date = ? "
            "  AND bars.bar_time = u.bar_time",
            [tf, session_date],
        )
        con.unregister("__phase6_update")
        total += len(df)

    print(f"  [{tf}] updated vwap + bias_state on {total} rows")
    return total


def _backfill_parent_bias(con: duckdb.DuckDBPyConnection, ltf: str) -> int:
    """For every (htf, parent_col) registered against this LTF, run the
    same UPDATE that cli._stamp_parent_bias runs at write time (uses
    ``bars.bar_end_time``). Returns the total number of UPDATE statements
    issued (one per session × parent).
    """
    parents = HTF_PARENTS_BY_LTF.get(ltf, ())
    if not parents:
        return 0
    sessions = con.execute(
        "SELECT DISTINCT session_date FROM bars WHERE timeframe = ? ORDER BY session_date",
        [ltf],
    ).fetchall()
    if not sessions:
        return 0

    issued = 0
    print(f"  [{ltf}] stamping parent_*_bias across {len(sessions)} session(s)...")
    for (session_date,) in sessions:
        for htf, parent_col in parents:
            con.execute(
                f"""
                UPDATE bars AS LTF
                SET {parent_col} = HTF.bias_state
                FROM bars AS HTF
                WHERE LTF.timeframe = ?
                  AND LTF.session_date = ?
                  AND HTF.timeframe = ?
                  AND LTF.bar_time >= HTF.bar_time
                  AND LTF.bar_time < HTF.bar_end_time
                """,
                [ltf, session_date, htf],
            )
            issued += 1
    print(f"  [{ltf}] issued {issued} parent-bias UPDATE statement(s)")
    return issued


def main() -> int:
    db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DB
    if not db_path.exists():
        print(f"DB not found: {db_path}", file=sys.stderr)
        return 2
    print(f"DB: {db_path.resolve()}")
    con = duckdb.connect(str(db_path))

    print("\n[1/2] vwap + bias_state per timeframe")
    for tf in TIMEFRAMES_ORDERED:
        _backfill_vwap_and_bias(con, tf)

    print("\n[2/2] parent_*_bias on LTF rows (HTF-first so parents are populated)")
    for tf in TIMEFRAMES_ORDERED:
        _backfill_parent_bias(con, tf)

    print("\n--- post-backfill sanity (1m) ---")
    print(con.execute(
        "SELECT COUNT(*) AS n_total, "
        "       COUNT(vwap) AS n_vwap, "
        "       COUNT(bias_state) AS n_bias, "
        "       COUNT(parent_1h_bias) AS n_parent_1h, "
        "       COUNT(parent_15m_bias) AS n_parent_15m "
        "FROM bars WHERE timeframe='1m'"
    ).fetchdf().to_string(index=False))

    print("\n--- bias_state distribution (1m) ---")
    print(con.execute(
        "SELECT bias_state, COUNT(*) AS n FROM bars WHERE timeframe='1m' "
        "GROUP BY 1 ORDER BY n DESC"
    ).fetchdf().to_string(index=False))

    con.close()
    print("\nDone. Restart the API server, then refresh the dashboard.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
