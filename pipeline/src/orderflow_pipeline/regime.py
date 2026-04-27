"""Data-driven regime classifier — multi-timeframe (Phase 5).

Replaces the synthetic / quintile-proxy classifier baked into the JS
dashboard's `src/analytics/regime.js` (`precomputeRegimeBreaks` +
`deriveRegimeState`). The classifier emits two integer ranks in [1, 5]
per bar:

    v_rank — volatility rank: where this bar's range sits in a rolling
             percentile window of `range / range_ema`.
    d_rank — depth rank: where this bar's combined depth score sits in
             a rolling percentile of (z(vpt) + z(concentration)).

Both ranks are smoothed with a 3-bar rolling mean before rounding/clipping
to [1, 5]. Zero-volume bars and the per-timeframe warmup window emit NULL
ranks ("warmup-NULL"). Window/smoothing parameters scale per timeframe via
the `REGIME_PARAMS` dict — see `notes.txt` §3.

Per-timeframe contract (Phase 5)
--------------------------------
- 1m:  100-bar percentile window, 20-bar range EMA, 30-bar warmup, NO
       cross-session seeding (per-session statistics, as before).
- 15m: 30-bar percentile window, 8-bar EMA, 10-bar warmup. Optional cross-
       session seed of last 3 sessions; first 15 bars of the current
       session are ranked against (seed + current), bars 16+ against
       current-session only.
- 1h:  24-bar percentile window, 8-bar EMA, 8-bar warmup. Optional cross-
       session seed of last 5 sessions; first 8 bars ranked against
       (seed + current), bars 9+ against current-session only.

Why hybrid (option c) at higher timeframes
------------------------------------------
RTH at 1h produces only 6 bars per session, fewer than even the 8-bar
warmup window. Without intervention, every 1h session would emit NULL
ranks for its entire duration. Cross-session seeding gives the rolling
statistics + percentile windows enough samples to emit ranks from bar 0
of session 2 onward (assuming `SEED_SESSIONS_BY_TF` worth of prior 1h
data exists in the DB). After K bars (~one full session at 1h), the
classifier transitions to current-session-only so end-of-session ranks
reflect today's distribution alone — a smooth handoff between "borrowed
context" and "today's regime".

Anti-jitter contract (regime-DB plan §1b/§1e)
---------------------------------------------
`range_pct` is rounded to 6 decimals before being written to either the
JSON file or the DuckDB row. `v_rank` / `d_rank` are integers — exact
equality required.

Output columns (added to the input DataFrame)
---------------------------------------------
- `range_pct`  : float | None  — already rounded to 6 decimals
- `v_rank`     : int   | None  — 1..5
- `d_rank`     : int   | None  — 1..5

Public API
----------
- compute_ranks(bars_df, timeframe='1m', seed_history_df=None)
- REGIME_PARAMS, SEED_SESSIONS_BY_TF (canonical config dicts)
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pandas as pd


# Per-timeframe parameter dict. Phase 5 starting values from notes.txt §3 —
# tuned for the bar density each timeframe produces during RTH.
#   pct_win           : trailing window length for percentile rank
#   ema_span          : EMA span for the volatility normalizer (range_ema)
#   depth_min_periods : min samples before rolling z-score emits non-NaN
#   warmup            : leading bars of the WORKING FRAME forced to NULL
#                       (seed bars count toward this window when seeded)
#   smooth            : 3-bar rolling mean smoother (uniform across TFs)
#   seed_transition_k : after this many bars of the CURRENT session, the
#                       classifier switches from seeded ranks to within-
#                       session-only ranks. 0 disables the hybrid path.
REGIME_PARAMS: dict[str, dict[str, int]] = {
    "1m":  {"pct_win": 100, "ema_span": 20, "depth_min_periods": 30, "warmup": 30, "smooth": 3, "seed_transition_k": 0},
    "15m": {"pct_win": 30,  "ema_span": 8,  "depth_min_periods": 10, "warmup": 10, "smooth": 3, "seed_transition_k": 15},
    "1h":  {"pct_win": 24,  "ema_span": 8,  "depth_min_periods": 8,  "warmup": 8,  "smooth": 3, "seed_transition_k": 8},
}

# How many prior sessions the CLI should pull from the DB to seed
# higher-timeframe rolling windows. 1m never seeds (synthesizes its own
# warmup within the session); 15m/1h pull a few sessions back.
SEED_SESSIONS_BY_TF: dict[str, int] = {
    "1m":  0,
    "15m": 3,
    "1h":  5,
}

ROUND_DECIMALS = 6        # range_pct anti-jitter rounding


def compute_ranks(
    bars_df: "pd.DataFrame",
    timeframe: str = "1m",
    seed_history_df: "pd.DataFrame | None" = None,
) -> "pd.DataFrame":
    """Compute per-bar v_rank/d_rank/range_pct for one (session, timeframe).

    Phase 5 hybrid warmup: when `seed_history_df` is provided (typically
    for 15m/1h), the first `seed_transition_k` current-session bars are
    ranked against `[seed | current]`, and remaining bars are ranked
    against current-session-only. `seed_history_df` rows are NEVER
    written back into the output; only `bars_df` rows receive ranks.

    Mutates and returns `bars_df` (caller passes in a single-session
    frame; we add three columns and hand it back). Empty input returns
    unchanged but with the columns present.

    Required input columns (all from `Bar.to_dict()` / aggregate.py):
        high, low, volume, vpt, concentration

    `seed_history_df`, if provided, must carry the same columns (extra
    columns are ignored).
    """
    import numpy as np
    import pandas as pd

    if timeframe not in REGIME_PARAMS:
        raise ValueError(
            f"Unknown timeframe {timeframe!r}; expected one of {list(REGIME_PARAMS)}"
        )
    params = REGIME_PARAMS[timeframe]

    # Always ensure the output columns exist so the empty-frame case
    # round-trips through downstream code without KeyError.
    if "range_pct" not in bars_df.columns:
        bars_df["range_pct"] = pd.Series([None] * len(bars_df), dtype="object")
    if "v_rank" not in bars_df.columns:
        bars_df["v_rank"] = pd.Series([None] * len(bars_df), dtype="object")
    if "d_rank" not in bars_df.columns:
        bars_df["d_rank"] = pd.Series([None] * len(bars_df), dtype="object")

    n_current = len(bars_df)
    if n_current == 0:
        return bars_df

    has_seed = (
        seed_history_df is not None
        and len(seed_history_df) > 0
        and timeframe in ("15m", "1h")
    )
    K = int(params.get("seed_transition_k", 0))

    # ── Pass 1: compute ranks on [seed | current] (or current alone) ──
    # When seeded, this gives "borrowed context" ranks for every current-
    # session bar. The seed rows themselves are computed and then dropped
    # before write-back.
    if has_seed:
        seed_only = _frame_for_calc(seed_history_df)
        current_only = _frame_for_calc(bars_df)
        work_df = pd.concat([seed_only, current_only], ignore_index=True)
        ranks_seeded = _compute_ranks_internal(work_df, params)
        seed_len = len(seed_only)
        # Slice to current-session rows
        seeded_range = ranks_seeded["range_pct"].iloc[seed_len:].reset_index(drop=True)
        seeded_v     = ranks_seeded["v_rank"].iloc[seed_len:].reset_index(drop=True)
        seeded_d     = ranks_seeded["d_rank"].iloc[seed_len:].reset_index(drop=True)
    else:
        # No seed available (1m, or first sessions of dataset for higher
        # TFs). Run the classifier directly on current-session bars.
        seeded_range = None
        seeded_v = None
        seeded_d = None

    # ── Pass 2: compute ranks on current-session-only ──
    # Used both as the (non-seeded) primary path and as the post-K
    # transition output when seeding is active.
    current_only_df = _frame_for_calc(bars_df)
    ranks_current = _compute_ranks_internal(current_only_df, params)
    current_range = ranks_current["range_pct"].reset_index(drop=True)
    current_v     = ranks_current["v_rank"].reset_index(drop=True)
    current_d     = ranks_current["d_rank"].reset_index(drop=True)

    # ── Stitch: pre-K = seeded, post-K = current-only (when seeded) ──
    if has_seed and K > 0:
        out_range = seeded_range.copy()
        out_v     = seeded_v.copy()
        out_d     = seeded_d.copy()
        # Replace positions K..end with current-only values. If the
        # current session is shorter than K, the entire output stays
        # seeded (no transition needed).
        if n_current > K:
            out_range.iloc[K:] = current_range.iloc[K:].values
            out_v.iloc[K:]     = current_v.iloc[K:].values
            out_d.iloc[K:]     = current_d.iloc[K:].values
    elif has_seed:
        # K=0 is a degenerate "always seeded" config; for completeness
        # but not used by any real timeframe.
        out_range, out_v, out_d = seeded_range, seeded_v, seeded_d
    else:
        out_range, out_v, out_d = current_range, current_v, current_d

    # Stamp results back onto bars_df. Convert numpy object arrays into
    # Python None for the JSON path's `int | None` typing literal.
    bars_df["range_pct"] = pd.Series(
        out_range.to_numpy(dtype="object"), index=bars_df.index, dtype="object"
    )
    bars_df["v_rank"] = pd.Series(
        out_v.to_numpy(dtype="object"), index=bars_df.index, dtype="object"
    )
    bars_df["d_rank"] = pd.Series(
        out_d.to_numpy(dtype="object"), index=bars_df.index, dtype="object"
    )
    return bars_df


def _frame_for_calc(src: "pd.DataFrame") -> "pd.DataFrame":
    """Project the columns the classifier needs, in a fresh frame.

    Decouples the working frame from the caller's `bars_df` (so we never
    accidentally mutate seed rows) and ensures the rolling math sees
    homogeneous float64 dtypes.
    """
    import pandas as pd

    return pd.DataFrame({
        "high":          src["high"].astype("float64"),
        "low":           src["low"].astype("float64"),
        "volume":        src["volume"].astype("float64"),
        "vpt":           src["vpt"].astype("float64"),
        "concentration": src["concentration"].astype("float64"),
    }).reset_index(drop=True)


def _compute_ranks_internal(
    bars_df: "pd.DataFrame",
    params: dict,
) -> "pd.DataFrame":
    """Core math: compute range_pct / v_rank / d_rank in place.

    Operates on a working frame produced by `_frame_for_calc`. Returns a
    new DataFrame with the three rank columns appended. Caller is
    responsible for stitching the result back into the original frame.
    """
    import numpy as np
    import pandas as pd

    n = len(bars_df)
    if n == 0:
        out = bars_df.copy()
        out["range_pct"] = pd.Series(dtype="object")
        out["v_rank"]    = pd.Series(dtype="object")
        out["d_rank"]    = pd.Series(dtype="object")
        return out

    ema_span         = params["ema_span"]
    pct_win          = params["pct_win"]
    depth_win        = params["pct_win"]   # depth z-score uses same trailing window
    depth_min_per    = params["depth_min_periods"]
    warmup           = params["warmup"]
    smooth_win       = params["smooth"]

    high = bars_df["high"].to_numpy()
    low  = bars_df["low"].to_numpy()
    vol  = bars_df["volume"].to_numpy()
    vpt_arr  = bars_df["vpt"].to_numpy()
    conc_arr = bars_df["concentration"].to_numpy()

    # ── Volatility input: range_pct = (high - low) / EMA(span)(high - low) ──
    rng = high - low
    rng_s = pd.Series(rng)
    range_ema = rng_s.ewm(span=ema_span, adjust=False).mean().to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        range_pct = np.where(range_ema > 0, rng / range_ema, np.nan)
    range_pct = np.round(range_pct, ROUND_DECIMALS)

    # ── Depth input: depth_score = z(vpt) + z(concentration) ──
    vpt_s  = pd.Series(vpt_arr)
    conc_s = pd.Series(conc_arr)
    z_vpt  = _rolling_z(vpt_s,  depth_win, depth_min_per)
    z_conc = _rolling_z(conc_s, depth_win, depth_min_per)
    depth_score = z_vpt + z_conc                 # NaN propagates through +

    # ── Percentile rank in a trailing window, then 1..5 bucket ──
    v_rank_raw = _rolling_pct_rank_to_bucket(pd.Series(range_pct),   pct_win, 1)
    d_rank_raw = _rolling_pct_rank_to_bucket(pd.Series(depth_score), pct_win, 1)

    # ── 3-bar smoothing → round → clip to [1, 5] ──
    v_rank = _smooth_round_clip(v_rank_raw, smooth_win)
    d_rank = _smooth_round_clip(d_rank_raw, smooth_win)

    # ── Warmup mask: first N bars OR zero-volume bars ⇒ NULL ranks ──
    warmup_mask = np.arange(n) < warmup
    zero_vol_mask = (vol <= 0)
    null_mask = (
        warmup_mask
        | zero_vol_mask
        | np.isnan(v_rank.astype("float64"))
        | np.isnan(d_rank.astype("float64"))
    )

    # range_pct is allowed to be non-NULL during warmup (it's bar-local,
    # not window-dependent), but we still NULL it where the range_ema
    # couldn't be computed (NaN row 0 only — EMA emits a value from bar 1
    # onwards) so the JSON/DB shape is uniformly {float|null}.
    range_pct_out = np.where(np.isnan(range_pct), None, range_pct)

    v_rank_out = np.where(null_mask, None, v_rank)
    d_rank_out = np.where(null_mask, None, d_rank)

    out = bars_df.copy()
    out["range_pct"] = pd.Series(range_pct_out, index=bars_df.index, dtype="object")
    out["v_rank"]    = pd.Series(v_rank_out,    index=bars_df.index, dtype="object")
    out["d_rank"]    = pd.Series(d_rank_out,    index=bars_df.index, dtype="object")
    return out


def _rolling_z(s: "pd.Series", win: int, min_periods: int) -> "pd.Series":
    """Trailing rolling z-score: (x - mean_w) / std_w with min_periods.

    NaN-out is the right "no signal" sentinel — it propagates through
    `z_vpt + z_conc` and into the percentile rank step, where pandas
    drops NaN rows.
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
    3-bar smoother can average before rounding.
    """
    import numpy as np

    def _last_pct(arr) -> float:
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
    return 1.0 + pct * 4.0


def _smooth_round_clip(raw, smooth_win: int):
    """N-bar rolling-mean smooth, round, clip to [1, 5]; preserves NaN.

    Returns a float ndarray; the warmup mask in `_compute_ranks_internal`
    is responsible for converting NaN positions to Python None for object-
    dtype storage. Doing the rounding here keeps the rounding contract in
    one place.
    """
    import numpy as np
    import pandas as pd

    s = pd.Series(raw)
    smooth = s.rolling(window=smooth_win, min_periods=1).mean()
    out = smooth.to_numpy(dtype="float64")
    nan_mask = np.isnan(out)
    out_int = np.where(nan_mask, np.nan, np.clip(np.round(out), 1, 5))
    return out_int
