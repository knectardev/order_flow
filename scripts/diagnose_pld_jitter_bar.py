#!/usr/bin/env python3
"""Spot-check PLD ratio vs jitter regime for one bar (matches ingest math).

Replicates ``velocity_regime.stamp_velocity_regimes`` prior-window selection and
``_midrank_percentile`` / ``_label_tercile`` for jitter on **log(pld_ratio)** for
strictly positive finite PLD (same filters as ingest).

Example:
  python scripts/diagnose_pld_jitter_bar.py data/orderflow.duckdb \\
    --timeframe 5m --session-kind rth --bar-time "2026-05-06 19:35:00"

``bar_time`` is interpreted as **UTC naive** matching DuckDB TIMESTAMP rows
(same convention as pipeline writers). Use your session's actual stored instant.

Also prints empirical 33rd/67th percentiles of the **prior** PLD sample (and log PLD)
for intuition (midrank label boundaries are not exactly these quantiles when ties
exist, but they usually align closely).

Tail sanity (after full rebuild on path/range PLD), DuckDB example::

  SELECT approx_quantile(pld_ratio, 0.99) AS p99 FROM bars WHERE timeframe='5m' AND session_kind='rth';
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

_REPO_ROOT = Path(__file__).resolve().parents[1]
_PIPELINE_SRC = _REPO_ROOT / "pipeline" / "src"
if str(_PIPELINE_SRC) not in sys.path:
    sys.path.insert(0, str(_PIPELINE_SRC))

from orderflow_pipeline.aggregate import TICK_SIZE  # noqa: E402
from orderflow_pipeline.db import connect  # noqa: E402
from orderflow_pipeline.velocity_regime import (  # noqa: E402
    MIN_PRIOR_BARS,
    WINDOW,
    _label_tercile,
    _midrank_percentile,
)


def main() -> int:
    p = argparse.ArgumentParser(description="Diagnose PLD ratio vs jitter regime for one bar.")
    p.add_argument("duckdb_path", type=Path, help="Path to DuckDB file")
    p.add_argument("--timeframe", default="5m")
    p.add_argument("--session-kind", default="rth")
    p.add_argument("--bar-time", required=True, help="Bar open time (UTC naive), e.g. 2026-05-06 19:35:00")
    args = p.parse_args()

    path = args.duckdb_path.expanduser().resolve()
    if not path.is_file():
        print(f"error: not a file: {path}", file=sys.stderr)
        return 2

    con = connect(path)
    tf = args.timeframe
    sk = args.session_kind
    bar_time = args.bar_time.strip()

    row = con.execute(
        """
        SELECT bar_time, pld_ratio, flip_rate, jitter_regime, conviction_regime,
               path_length_ticks, high, low
        FROM bars
        WHERE timeframe = ? AND session_kind = ? AND bar_time = ?::TIMESTAMP
        """,
        [tf, sk, bar_time],
    ).fetchone()
    if not row:
        print(f"No row for timeframe={tf} session_kind={sk} bar_time={bar_time}")
        con.close()
        return 1

    bt, cur_pld, cur_flip, jr_db, cr_db, plt, hi, lo = row
    hi_t = int(round(float(hi) / TICK_SIZE))
    lo_t = int(round(float(lo) / TICK_SIZE))
    range_ticks = max(hi_t - lo_t, 0)
    print(f"bar_time={bt} timeframe={tf} session_kind={sk}")
    print(f"DB jitter_regime={jr_db!r} conviction_regime={cr_db!r}")
    print(f"path_length_ticks={plt} range_ticks={range_ticks} (from high/low vs TICK_SIZE)")
    print(f"pld_ratio={cur_pld} flip_rate={cur_flip}")

    prior_rows = con.execute(
        """
        SELECT bar_time, pld_ratio, flip_rate, session_kind
        FROM bars
        WHERE timeframe = ? AND session_kind = ? AND bar_time < ?
        ORDER BY bar_time DESC
        LIMIT ?
        """,
        [tf, sk, bt, WINDOW + 5],
    ).fetchall()
    con.close()

    import pandas as pd

    prior_df = pd.DataFrame(
        prior_rows,
        columns=["bar_time", "pld_ratio", "flip_rate", "session_kind"],
    ).iloc[::-1].reset_index(drop=True)

    cur_df = pd.DataFrame(
        [{"bar_time": bt, "pld_ratio": cur_pld, "flip_rate": cur_flip, "session_kind": sk}]
    )
    cur_df["is_current"] = True
    if len(prior_df) > 0:
        prior_df["is_current"] = False
        combined = pd.concat([prior_df, cur_df], ignore_index=True)
    else:
        combined = cur_df

    combined = combined.sort_values("bar_time").reset_index(drop=True)
    i = combined.index[combined["is_current"]].tolist()[0]

    idxs: list[int] = []
    j = i - 1
    while j >= 0 and len(idxs) < WINDOW:
        if combined["session_kind"].iloc[j] == sk:
            idxs.append(j)
        j -= 1

    print(f"prior_same_kind_count={len(idxs)} (need {MIN_PRIOR_BARS} for non-NULL regimes)")
    if len(idxs) < MIN_PRIOR_BARS:
        print("Warmup: regimes should be NULL.")
        return 0

    pld_series = combined["pld_ratio"].iloc[idxs]
    pld_raw = pld_series.dropna().to_numpy(dtype=float)
    pld_vals = pld_raw[(pld_raw > 0) & np.isfinite(pld_raw)]

    print(f"prior_pld_positive_count={pld_vals.size}")
    if pld_vals.size == 0:
        print("No positive prior PLD values — jitter should be NULL.")
        return 0

    if cur_pld is None or (isinstance(cur_pld, float) and np.isnan(cur_pld)):
        print("Current PLD NULL — jitter NULL.")
        return 0

    cur_pld_f = float(cur_pld)
    if not np.isfinite(cur_pld_f) or cur_pld_f <= 0:
        print("Current PLD not positive — jitter NULL.")
        return 0

    log_vals = np.log(pld_vals)
    log_cur = np.log(cur_pld_f)
    pld_pct = _midrank_percentile(log_vals, log_cur)
    jitter = _label_tercile(pld_pct, invert=False)

    below = int(np.sum(pld_vals < cur_pld_f))
    eq = int(np.sum(pld_vals == cur_pld_f))
    above = int(np.sum(pld_vals > cur_pld_f))

    q33 = float(np.quantile(pld_vals, 1.0 / 3.0))
    q67 = float(np.quantile(pld_vals, 2.0 / 3.0))
    lq33 = float(np.quantile(log_vals, 1.0 / 3.0))
    lq67 = float(np.quantile(log_vals, 2.0 / 3.0))

    print("\n--- Midrank on log(PLD) (ingest contract) ---")
    print(f"midrank_percentile={pld_pct:.6f}  (Low if < {1/3:.6f}, High if > {2/3:.6f}, else Mid)")
    print(f"recomputed_jitter={jitter!r}  (DB jitter_regime={jr_db!r})")

    print("\n--- Prior PLD distribution (same session_kind window, positive only) ---")
    print(f"min={float(np.min(pld_vals)):.6f}  max={float(np.max(pld_vals)):.6f}")
    print(f"mean={float(np.mean(pld_vals)):.6f}  median={float(np.median(pld_vals)):.6f}")
    print(f"np.quantile PLD priors @ 1/3 ~ {q33:.6f}   @ 2/3 ~ {q67:.6f}")
    print(f"np.quantile log(PLD) priors @ 1/3 ~ {lq33:.6f}   @ 2/3 ~ {lq67:.6f}")
    print(f"count strictly below current PLD (linear): {below}")
    print(f"count equal to current PLD: {eq}")
    print(f"count strictly above current PLD (linear): {above}")

    print("\nInterpretation:")
    print(
        "Jitter is relative to prior bars only: Low means this bar's PLD ranks in the "
        "bottom third of those priors (midrank < 1/3), not necessarily small in absolute terms."
    )
    if jitter == "Low" and cur_pld_f > 15:
        print(
            f"A relatively large path/range PLD ({cur_pld_f:.2f}) can still be Low if the trailing "
            "window is dominated by even larger ratios."
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
