"""Causal tercile regimes for velocity metrics (`pld_ratio`, `flip_rate`).

Trailing window: up to 200 prior bars with the **same** ``session_kind`` as the
current row (no mixing RTH vs globex). Percentiles are computed only from prior
rows (current bar excluded). Warmup rows emit NULL regime labels.

Conviction label is **inverted** vs flip percentile: low flip_rate ⇒ High
conviction (same convention as the original velocity-matrix spec).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    import duckdb

from .aggregate import Bar

UTC = timezone.utc

WINDOW = 200
# Minimum prior same-kind bars required before emitting non-NULL regime labels.
MIN_PRIOR_BARS = 30


def _midrank_percentile(window_vals: np.ndarray, current: float) -> float:
    """Empirical percentile rank of ``current`` within ``window_vals`` (mid-rank ties)."""
    if window_vals.size == 0:
        return float("nan")
    below = np.sum(window_vals < current)
    eq = np.sum(window_vals == current)
    return (below + 0.5 * eq) / float(window_vals.size)


def _label_tercile(pct: float, *, invert: bool = False) -> str | None:
    if np.isnan(pct):
        return None
    if invert:
        if pct < (1.0 / 3.0):
            return "High"
        if pct > (2.0 / 3.0):
            return "Low"
        return "Mid"
    if pct < (1.0 / 3.0):
        return "Low"
    if pct > (2.0 / 3.0):
        return "High"
    return "Mid"


def stamp_velocity_regimes(
    bars: list[Bar],
    *,
    timeframe: str,
    session_kind: str,
    con: "duckdb.DuckDBPyConnection | None",
) -> None:
    """Populate ``jitter_regime`` and ``conviction_regime`` on each bar in place.

    Reads prior history from ``bars`` in DuckDB (same ``timeframe`` and
    ``session_kind``) so the first bars of a session can still get regimes once
    enough history exists across prior sessions.
    """
    if not bars or con is None:
        return

    rows_cur: list[dict[str, Any]] = []
    for b in bars:
        bt = datetime.fromtimestamp(b.bin_start_ns / 1e9, tz=UTC).replace(tzinfo=None)
        rows_cur.append(
            {
                "bar_time": bt,
                "pld_ratio": b.pld_ratio,
                "flip_rate": b.flip_rate,
                "session_kind": session_kind,
            }
        )

    min_bt = min(r["bar_time"] for r in rows_cur)

    prior_rows = con.execute(
        """
        SELECT bar_time, pld_ratio, flip_rate, session_kind
        FROM bars
        WHERE timeframe = ? AND session_kind = ? AND bar_time < ?
        ORDER BY bar_time DESC
        LIMIT ?
        """,
        [timeframe, session_kind, min_bt, WINDOW + 5],
    ).fetchall()

    import pandas as pd

    prior_df = pd.DataFrame(
        prior_rows,
        columns=["bar_time", "pld_ratio", "flip_rate", "session_kind"],
    )
    prior_df = prior_df.iloc[::-1].reset_index(drop=True)

    cur_df = pd.DataFrame(rows_cur)
    cur_df["is_current"] = True
    if len(prior_df) > 0:
        prior_df["is_current"] = False
        combined = pd.concat([prior_df, cur_df], ignore_index=True)
    else:
        combined = cur_df

    combined = combined.sort_values("bar_time").reset_index(drop=True)

    n = len(combined)
    results: dict[datetime, tuple[str | None, str | None]] = {}

    for i in range(n):
        if not bool(combined["is_current"].iloc[i]):
            continue

        sk = combined["session_kind"].iloc[i]
        cur_pld = combined["pld_ratio"].iloc[i]
        cur_flip = combined["flip_rate"].iloc[i]
        cur_bt = combined["bar_time"].iloc[i]

        idxs: list[int] = []
        j = i - 1
        while j >= 0 and len(idxs) < WINDOW:
            if combined["session_kind"].iloc[j] == sk:
                idxs.append(j)
            j -= 1

        if len(idxs) < MIN_PRIOR_BARS:
            results[cur_bt] = (None, None)
            continue

        pld_series = combined["pld_ratio"].iloc[idxs]
        pld_vals = pld_series.dropna().to_numpy(dtype=float)

        flip_series = combined["flip_rate"].iloc[idxs]
        flip_vals = flip_series.dropna().to_numpy(dtype=float)

        if cur_pld is None or (isinstance(cur_pld, float) and np.isnan(cur_pld)):
            jitter = None
        elif pld_vals.size == 0:
            jitter = None
        else:
            pld_pct = _midrank_percentile(pld_vals, float(cur_pld))
            jitter = _label_tercile(pld_pct, invert=False)

        if cur_flip is None or (isinstance(cur_flip, float) and np.isnan(cur_flip)):
            conviction = None
        elif flip_vals.size == 0:
            conviction = None
        else:
            flip_pct = _midrank_percentile(flip_vals, float(cur_flip))
            conviction = _label_tercile(flip_pct, invert=True)

        results[cur_bt] = (jitter, conviction)

    for b in bars:
        bt = datetime.fromtimestamp(b.bin_start_ns / 1e9, tz=UTC).replace(tzinfo=None)
        jr, cr = results.get(bt, (None, None))
        b.jitter_regime = jr
        b.conviction_regime = cr


def trade_context_from_regimes(
    jitter_regime: str | None, conviction_regime: str | None
) -> str:
    """Composite trade-context label from stamped velocity regimes.

    Corners of the Low/Mid/High × Low/Mid/High grid map to ``favorable`` /
    ``avoid`` / ``watch``; every other combination (including NULL warmup)
    maps to ``neutral``.
    """
    j = jitter_regime
    c = conviction_regime
    if j == "Low" and c == "High":
        return "favorable"
    if j == "High" and c == "Low":
        return "avoid"
    if j == "High" and c == "High":
        return "watch"
    return "neutral"


def stamp_trade_context(bars: list[Bar]) -> None:
    """Populate ``trade_context`` on each bar from jitter + conviction."""
    for b in bars:
        b.trade_context = trade_context_from_regimes(
            b.jitter_regime, b.conviction_regime
        )
