"""Data-driven regime classifier (regime-DB plan §2a).

Replaces the synthetic / quintile-proxy classifier baked into the JS
dashboard's `src/analytics/regime.js` (`precomputeRegimeBreaks` +
`deriveRegimeState`). The classifier emits two integer ranks in [1, 5]
per bar:

    v_rank — volatility rank: where this bar's range sits in a rolling
             100-bar percentile window of `range / range_ema(20)`.
    d_rank — depth rank: where this bar's combined depth score sits in
             a rolling 100-bar percentile of (z(vpt) + z(concentration))
             over a 100-bar window with min_periods=30.

Both ranks are smoothed with a 3-bar rolling mean before rounding/clipping
to [1, 5]. The first 30 bars of every session and any zero-volume bar
emit NULL ranks (regime-DB plan §2a "warmup-NULL").

Per-session contract
--------------------
This function operates on one session's bars at a time — the CLI calls
it once per session, between `aggregate_trades` and `db.write_session`
(plan §2c). All rolling windows reset at session boundaries; we do NOT
seed buffers from the previous session. Rationale: each RTH session has
its own microstructure regime (overnight risk priced overnight, opening
auction prints reset depth, etc.), and re-using yesterday's depth-z mean
would systematically mis-rank the first ~30 bars of today. The 30-bar
warmup is the price we pay for clean per-session statistics.

Anti-jitter contract (regime-DB plan §1b/§1e)
---------------------------------------------
`range_pct` is rounded to 6 decimals before being written to either the
JSON file or the DuckDB row. This matches the rounding rule for `vpt`
and `concentration` in `aggregate.Bar._vpt_concentration()`, so the
Phase 1e equivalence gate (`abs_tol=1e-9`) cannot fail on serialization
noise. `v_rank` / `d_rank` are integers — exact equality required.

Output columns (added to the input DataFrame)
---------------------------------------------
- `range_pct`  : float | None  — already rounded to 6 decimals; NULL during warmup
- `v_rank`     : int   | None  — 1..5; NULL during warmup
- `d_rank`     : int   | None  — 1..5; NULL during warmup

Plan refs: regime-DB plan §2a, §2c-d, §2e.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pandas as pd


# Lookback / smoothing parameters. Promoted to module-level constants so
# tests in pipeline/tests/test_regime.py can pin against them.
EMA_SPAN = 20             # range_ema span (volatility normalizer)
DEPTH_WIN = 100           # rolling window for z-score + percentile rank
DEPTH_MIN_PERIODS = 30    # std stabilizes by 30; bumped from 20 (§2a "Why 30")
PCT_WIN = 100             # percentile-rank window for both ranks
SMOOTH_WIN = 3            # 3-bar rolling mean smoother
WARMUP_BARS = 30          # first N bars of each session emit NULL ranks
ROUND_DECIMALS = 6        # range_pct anti-jitter rounding


def compute_ranks(bars_df: "pd.DataFrame") -> "pd.DataFrame":
    """Compute per-bar v_rank/d_rank/range_pct for a single session.

    Mutates and returns the input DataFrame (caller passes in a single-
    session frame; we add three columns and hand it back). Empty input
    is returned unchanged but with the columns present, so downstream
    schema assumptions don't break on degenerate sessions.

    Required input columns (all from `Bar.to_dict()` / aggregate.py):
        high, low, volume, vpt, concentration

    The function is intentionally tolerant of dtype quirks coming out of
    `Bar.to_dict()`: vpt/concentration arrive as float64, volume as int64.
    Rolling stats run on float64 internally; we cast back to native ints
    for ranks before stamping them on the frame.
    """
    import numpy as np
    import pandas as pd

    # Always ensure the output columns exist so the empty-frame case
    # round-trips through downstream code without KeyError.
    if "range_pct" not in bars_df.columns:
        bars_df["range_pct"] = pd.Series([None] * len(bars_df), dtype="object")
    if "v_rank" not in bars_df.columns:
        bars_df["v_rank"] = pd.Series([None] * len(bars_df), dtype="object")
    if "d_rank" not in bars_df.columns:
        bars_df["d_rank"] = pd.Series([None] * len(bars_df), dtype="object")

    n = len(bars_df)
    if n == 0:
        return bars_df

    high = bars_df["high"].astype("float64").to_numpy()
    low  = bars_df["low"].astype("float64").to_numpy()
    vol  = bars_df["volume"].astype("float64").to_numpy()
    vpt_arr  = bars_df["vpt"].astype("float64").to_numpy()
    conc_arr = bars_df["concentration"].astype("float64").to_numpy()

    # ── Volatility input: range_pct = (high - low) / EMA(20)(high - low) ──
    rng = high - low
    rng_s = pd.Series(rng)
    range_ema = rng_s.ewm(span=EMA_SPAN, adjust=False).mean().to_numpy()
    # Guard against zero EMA (only possible when every prior bar had high == low,
    # i.e. truly degenerate data). NaN output is treated as missing in the rank
    # step downstream — it'll fall into the warmup NULL path.
    with np.errstate(divide="ignore", invalid="ignore"):
        range_pct = np.where(range_ema > 0, rng / range_ema, np.nan)
    range_pct = np.round(range_pct, ROUND_DECIMALS)

    # ── Depth input: depth_score = z(vpt) + z(concentration) ──
    # Rolling z = (x - rolling_mean) / rolling_std, with min_periods=30 so
    # the std denominator is stable before any rank is emitted (§2a "Why 30").
    vpt_s  = pd.Series(vpt_arr)
    conc_s = pd.Series(conc_arr)
    z_vpt  = _rolling_z(vpt_s,  DEPTH_WIN, DEPTH_MIN_PERIODS)
    z_conc = _rolling_z(conc_s, DEPTH_WIN, DEPTH_MIN_PERIODS)
    depth_score = z_vpt + z_conc                 # NaN propagates through +

    # ── Percentile rank in a 100-bar trailing window, then 1..5 bucket ──
    # min_periods=1 here is intentional. The plan's 30-bar requirement
    # lives in two places:
    #   (a) the rolling z-score's min_periods=30 (above), which keeps
    #       d_rank's depth_score NaN until sample 30+ — it then percentile-
    #       ranks against whatever non-NaN samples have accumulated.
    #   (b) the explicit warmup_mask `< WARMUP_BARS` (below), which NULLs
    #       any rank produced in the first 30 bars regardless of whether
    #       the rolling math could compute one.
    # If we ALSO required 30 non-NaN samples here for d_rank, we'd push
    # its first non-NULL emission to ~bar 60, doubling the warmup window
    # the plan explicitly limits to 30.
    v_rank_raw = _rolling_pct_rank_to_bucket(pd.Series(range_pct),   PCT_WIN, 1)
    d_rank_raw = _rolling_pct_rank_to_bucket(pd.Series(depth_score), PCT_WIN, 1)

    # ── 3-bar smoothing → round → clip to [1, 5] ──
    v_rank = _smooth_round_clip(v_rank_raw)
    d_rank = _smooth_round_clip(d_rank_raw)

    # ── Warmup mask: first 30 bars OR zero-volume bars ⇒ NULL ranks ──
    warmup_mask = np.arange(n) < WARMUP_BARS
    zero_vol_mask = (vol <= 0)
    null_mask = warmup_mask | zero_vol_mask | np.isnan(v_rank.astype("float64")) | np.isnan(d_rank.astype("float64"))

    # range_pct is allowed to be non-NULL during warmup (§2a step 1 is
    # bar-local, not window-dependent), but we still NULL it where the
    # range_ema couldn't be computed (NaN row 0 only — EMA emits a value
    # from bar 1 onwards) so the JSON/DB shape is uniformly {float|null}.
    range_pct_out = np.where(np.isnan(range_pct), None, range_pct)

    v_rank_out = np.where(null_mask, None, v_rank)
    d_rank_out = np.where(null_mask, None, d_rank)

    bars_df["range_pct"] = pd.Series(range_pct_out, index=bars_df.index, dtype="object")
    bars_df["v_rank"]    = pd.Series(v_rank_out,    index=bars_df.index, dtype="object")
    bars_df["d_rank"]    = pd.Series(d_rank_out,    index=bars_df.index, dtype="object")
    return bars_df


def _rolling_z(s: "pd.Series", win: int, min_periods: int) -> "pd.Series":
    """Trailing rolling z-score: (x - mean_w) / std_w with min_periods.

    `min_periods=30` means rolling stats are NaN until 30 valid samples
    have accumulated. NaN out is the right "no signal" sentinel — it
    propagates through `z_vpt + z_conc` and into the percentile rank
    step, where pandas.Series.rank() drops NaN rows (giving 0/total = 0
    or NaN), which the warmup mask then cleans up by overwriting with
    None. Effectively the warmup NULL is enforced in two places (mask +
    NaN propagation), which is intentional belt-and-suspenders.
    """
    r = s.rolling(window=win, min_periods=min_periods)
    mean = r.mean()
    std  = r.std(ddof=0)   # population std; matches rolling z conventions
    # Avoid /0 on identical-bar windows: where std == 0, output 0 (the
    # value sits exactly at the rolling mean). The percentile rank then
    # places this at the median (rank=0.5), which the bucketer maps to 3.
    z = (s - mean) / std.replace(0.0, float("nan"))
    return z.fillna(0.0).where(~mean.isna())   # mask: NaN where mean is NaN


def _rolling_pct_rank_to_bucket(s: "pd.Series", win: int, min_periods: int):
    """Trailing percentile rank ∈ [0, 1] mapped to a continuous 1..5 bucket.

    For each bar, look at the trailing `win` window of values (including
    self), compute s_today's percentile rank in that window, then linearly
    map [0, 1] → [1, 5]. The mapped value is left as float here so the
    3-bar smoother can average before rounding; `_smooth_round_clip()`
    finishes the job.

    pandas' `Series.rank(pct=True)` on a per-window basis is what
    `rolling.apply(lambda x: ...)` provides. The `raw=True` flag passes
    a NumPy array (faster); we use scipy-free arithmetic so this stays a
    plain pandas dependency.
    """
    import numpy as np
    import pandas as pd

    def _last_pct(arr: "np.ndarray") -> float:
        # Window slice including the trailing element; returns the
        # percentile rank of the last value among the window. Equivalent
        # to (count_le_last - 0.5) / n — Hyndman's R-7-style midrank.
        last = arr[-1]
        if np.isnan(last):
            return np.nan
        valid = arr[~np.isnan(arr)]
        n = valid.size
        if n == 0:
            return np.nan
        # Mid-rank to avoid 0 / 1 endpoints which would map to bucket 1 / 5
        # off a single sample. (count_lt + 0.5 * count_eq) / n keeps the
        # output in (0, 1).
        less = (valid < last).sum()
        eq   = (valid == last).sum()
        return (less + 0.5 * eq) / n

    pct = s.rolling(window=win, min_periods=min_periods).apply(_last_pct, raw=True)
    # Linear stretch [0, 1] → [1, 5]. Bucket boundaries land at quintile
    # cuts after rounding (0.0..0.1 → 1, 0.1..0.3 → 2, 0.3..0.5 → 3,
    # 0.5..0.7 → 4 only after smoothing+round; that's fine, the smoother
    # nudges the cut). The point is to expose a smooth float so smoothing
    # has something useful to average.
    return 1.0 + pct * 4.0


def _smooth_round_clip(raw):
    """3-bar rolling-mean smooth, round, clip to [1, 5]; preserves NaN.

    Returns a float ndarray; the warmup mask in `compute_ranks()` is
    responsible for converting NaN positions to Python None for object-
    dtype storage. Doing the rounding here keeps the rounding contract
    in one place.
    """
    import numpy as np
    import pandas as pd

    s = pd.Series(raw)
    smooth = s.rolling(window=SMOOTH_WIN, min_periods=1).mean()
    out = smooth.to_numpy(dtype="float64")
    nan_mask = np.isnan(out)
    out_int = np.where(nan_mask, np.nan, np.clip(np.round(out), 1, 5))
    return out_int
