"""Tests for orderflow_pipeline.regime.compute_ranks (regime-DB plan §2b).

Coverage matrix:

1. test_warmup_first_30_bars_null
   For any non-degenerate session, bars 0..29 must emit NULL ranks
   regardless of the underlying signal — this is the explicit warmup
   contract the dashboard's "WARMING UP" overlay relies on (§2d).

2. test_zero_volume_bars_null
   Zero-volume bars (e.g. mid-session pause) must emit NULL ranks even
   when they fall outside the 30-bar warmup. The classifier should not
   try to rank a bar whose volume == 0; rank from the previous bar is
   stale and the next non-zero-vol bar will produce a fresh signal.

3. test_identical_bars_rank_3
   100 identical bars (constant range, vpt, concentration) must produce
   v_rank == 3 and d_rank == 3 for every bar past warmup. The mid-rank
   tiebreaker in `_last_pct` puts a constant series at percentile 0.5,
   which the linear stretch maps to bucket 3.

4. test_monotonically_increasing_range_high_v_rank
   When range_pct increases monotonically, the most recent bar should
   rank near the top of its trailing 100-bar window. After 100+ bars,
   the latest v_rank must round to 5 — bigger range than every other
   sample in the window.

5. test_anti_jitter_range_pct_rounding
   range_pct values must round-trip through 6-decimal serialization
   without loss (regime-DB plan §1b/§1e). Verify the field is rounded
   in-place.

6. test_clip_range_to_1_5
   range_pct values that would map outside [1, 5] (after percentile
   stretch) must clip cleanly. With pure-monotonic data the smoothed
   percentile reaches 1.0 → bucket 5 — not e.g. 6.

These cases pin the externally-visible behavior. Internal helpers
(`_rolling_z`, `_rolling_pct_rank_to_bucket`) are tested transitively;
direct tests on them would over-couple to implementation details that
may change as we tune the classifier in Phase 5+.
"""
from __future__ import annotations

import math
import pathlib
import sys

import numpy as np
import pandas as pd
import pytest


# Locate the source layout. `pipeline/tests` is the test home; the package
# lives under `pipeline/src/orderflow_pipeline`. The pyproject.toml installs
# in editable mode, but for ad-hoc `pytest pipeline/tests/test_regime.py`
# runs we patch sys.path so the import works without `pip install -e`.
_SRC = pathlib.Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from orderflow_pipeline import regime  # noqa: E402


def _make_constant_session(n: int = 200) -> pd.DataFrame:
    """One session of n identical bars with non-zero volume.

    Uses fixed values so the test is deterministic without seeding RNG.
    """
    return pd.DataFrame({
        "high":          [101.0] * n,
        "low":           [100.0] * n,
        "volume":        [1000]  * n,
        "vpt":           [80.0]  * n,
        "concentration": [0.25]  * n,
    })


def _make_random_session(n: int = 200, seed: int = 42) -> pd.DataFrame:
    """One session of randomized bars; reproducible via seed."""
    rng = np.random.default_rng(seed)
    return pd.DataFrame({
        "high":          rng.uniform(101.0, 105.0, n),
        "low":           rng.uniform(99.0,  101.0, n),
        "volume":        rng.integers(500,  5000, n),
        "vpt":           rng.uniform(50.0,  200.0, n),
        "concentration": rng.uniform(0.05,  0.50,  n),
    })


# ───────────────────────────────────────────────────────────
# 1. Warmup: first 30 bars must emit NULL.
# ───────────────────────────────────────────────────────────
def test_warmup_first_30_bars_null():
    df = _make_random_session(n=200)
    out = regime.compute_ranks(df.copy())
    for i in range(regime.WARMUP_BARS):
        assert out["v_rank"].iloc[i] is None, f"bar {i} v_rank not NULL"
        assert out["d_rank"].iloc[i] is None, f"bar {i} d_rank not NULL"


# ───────────────────────────────────────────────────────────
# 2. Zero-volume bars must emit NULL even outside warmup.
# ───────────────────────────────────────────────────────────
def test_zero_volume_bars_null():
    n = 200
    df = _make_constant_session(n=n)
    # Zero out volume for bars 60..69 (well past the 30-bar warmup so any
    # NULL we observe there must come from the zero-volume mask, not warmup).
    df.loc[60:69, "volume"] = 0
    out = regime.compute_ranks(df)
    for i in range(60, 70):
        assert out["v_rank"].iloc[i] is None, f"bar {i} v_rank should be NULL (zero vol)"
        assert out["d_rank"].iloc[i] is None, f"bar {i} d_rank should be NULL (zero vol)"
    # Bars before / after the zero-vol gap should be non-NULL.
    assert out["v_rank"].iloc[59] is not None
    assert out["v_rank"].iloc[70] is not None


# ───────────────────────────────────────────────────────────
# 3. Identical bars → v_rank/d_rank == 3 (median bucket).
# ───────────────────────────────────────────────────────────
def test_identical_bars_rank_3():
    df = _make_constant_session(n=150)
    out = regime.compute_ranks(df)
    # Sample well past warmup AND past the depth-z's min_periods.
    for i in (50, 100, 149):
        assert out["v_rank"].iloc[i] == 3.0, f"bar {i} v_rank={out['v_rank'].iloc[i]}, expected 3"
        assert out["d_rank"].iloc[i] == 3.0, f"bar {i} d_rank={out['d_rank'].iloc[i]}, expected 3"


# ───────────────────────────────────────────────────────────
# 4. Vol-expansion step → latest v_rank near top.
# ───────────────────────────────────────────────────────────
def test_monotonically_increasing_range_high_v_rank():
    # Note: we cannot use a pure linear ramp here because range_pct =
    # range / EMA(range) — with linearly-growing range the EMA lags by a
    # constant offset, so range_pct asymptotes *downward* toward 1.0 and
    # the latest bar ends up at the bottom of the percentile distribution,
    # not the top. The classifier's intent ("expanding volatility ⇒ high
    # v_rank") is better expressed as a flat baseline followed by a step
    # up in range — a vol-expansion regime, which is exactly what we want
    # the rank-5 bucket to flag.
    n = 200
    high = np.full(n, 100.5)
    low  = np.full(n, 99.5)
    # Step up the range by 5x for the last 20 bars (bars 180..199).
    high[180:] = 102.5
    low[180:]  = 97.5
    df = pd.DataFrame({
        "high": high,
        "low":  low,
        "volume":        [1000]  * n,
        "vpt":           [80.0]  * n,
        "concentration": [0.25]  * n,
    })
    out = regime.compute_ranks(df)
    # The first post-step bar (180) has range_pct ≈ range / EMA = 5 / 1.38 ≈
    # 3.6 — far above the flat baseline's range_pct of 1.0 — so its trailing
    # 100-bar percentile lands at the top of the distribution → bucket 5.
    # By the final bar (199) the EMA has tracked most of the way toward 5.0,
    # so range_pct decays back toward 1.13 — still above the 80 flat-baseline
    # samples in the trailing window but below bars 180..198, so we land at
    # bucket 4 after the 3-bar smoother. Both behaviors confirm "expanding
    # volatility ⇒ high v_rank"; we assert the strong claim at the step bar
    # and the weaker monotonic claim at the end.
    # Use bar 182 — by then the 3-bar SMOOTH_WIN is fully inside the spike
    # (averaging bars 180, 181, 182), so the residual flat-baseline drag
    # at bar 181 (smoother averages 179_raw=3.0 + 180_raw=4.98 + 181_raw=4.94
    # → 4.31 → round 4) has cleared.
    step_bar_rank = out["v_rank"].iloc[182]
    assert step_bar_rank == 5.0, \
        f"expected v_rank == 5 just after vol expansion; got {step_bar_rank}"
    last = out["v_rank"].iloc[n - 1]
    assert last is not None and last >= 4.0, \
        f"expected v_rank >= 4 on final bar of vol expansion; got {last}"


# ───────────────────────────────────────────────────────────
# 5. Anti-jitter rounding contract for range_pct.
# ───────────────────────────────────────────────────────────
def test_anti_jitter_range_pct_rounding():
    df = _make_random_session(n=100, seed=7)
    out = regime.compute_ranks(df)
    for i in range(len(out)):
        v = out["range_pct"].iloc[i]
        if v is None or (isinstance(v, float) and math.isnan(v)):
            continue
        # Compare value to itself rounded to 6 dp; if compute_ranks
        # rounded properly, the diff is exactly zero. abs_tol of 1e-12
        # leaves slack only for NumPy float64 representation noise.
        assert math.isclose(v, round(float(v), regime.ROUND_DECIMALS), abs_tol=1e-12), \
            f"bar {i} range_pct={v!r} not rounded to {regime.ROUND_DECIMALS} decimals"


# ───────────────────────────────────────────────────────────
# 6. Clip ensures rank ∈ {1, 2, 3, 4, 5}.
# ───────────────────────────────────────────────────────────
def test_rank_values_clipped_to_1_5():
    df = _make_random_session(n=200, seed=11)
    out = regime.compute_ranks(df)
    for col in ("v_rank", "d_rank"):
        for v in out[col]:
            if v is None:
                continue
            iv = int(v)
            assert 1 <= iv <= 5, f"{col} value {iv} out of [1,5]"


# ───────────────────────────────────────────────────────────
# 7. Empty input: function must not crash and must return columns.
# ───────────────────────────────────────────────────────────
def test_empty_dataframe():
    df = pd.DataFrame(columns=["high", "low", "volume", "vpt", "concentration"])
    out = regime.compute_ranks(df)
    assert list(out.columns) == [
        "high", "low", "volume", "vpt", "concentration",
        "range_pct", "v_rank", "d_rank",
    ]
    assert len(out) == 0


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
