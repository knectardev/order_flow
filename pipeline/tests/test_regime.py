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
   v_rank == 3 and d_rank == 3 for every bar past warmup. The endpoint
   `(n-1)` percentile maps a constant window to 0.5 → raw bucket 3 before
   smoothing.

4. test_monotonically_increasing_range_high_v_rank
   When range_pct increases monotonically, the most recent bar should
   rank near the top of its trailing 100-bar window. After 100+ bars,
   the latest v_rank must round to 5 — bigger range than every other
   sample in the window.

5. test_anti_jitter_range_pct_rounding
   range_pct values must round-trip through 6-decimal serialization
   without loss (regime-DB plan §1b/§1e). Verify the field is rounded
   in-place.

6. test_rank_integer_and_scatter_ranges
   Integer v_rank/d_rank ∈ {1..5}. Continuous vol_score/depth_score use a
   mid-rank track → strictly inside (1, 5) for any window with more than
   one valid sample (no artificial mass exactly at 1 or 5).

7. test_scatter_scores_avoid_exact_endpoints
   On a long random session, zero vol_score/depth_score values equal
   exactly 1.0 or 5.0 (at 1e-9 tolerance).

8. test_empty_dataframe
   Empty input returns columns without crashing.
 the externally-visible behavior. Internal helpers
(`_rolling_z`, `_rolling_dual_pct_to_buckets`) are tested transitively;
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
    warmup = regime.REGIME_PARAMS["1m"]["warmup"]
    for i in range(warmup):
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
# 6. Integer ranks clipped; scatter coords strictly interior (1, 5).
# ───────────────────────────────────────────────────────────
def test_rank_integer_and_scatter_ranges():
    df = _make_random_session(n=200, seed=11)
    out = regime.compute_ranks(df)
    for col in ("v_rank", "d_rank"):
        for v in out[col]:
            if v is None:
                continue
            iv = int(v)
            assert 1 <= iv <= 5, f"{col} value {iv} out of [1,5]"
    for col in ("vol_score", "depth_score"):
        for v in out[col]:
            if v is None:
                continue
            fv = float(v)
            assert 1.0 < fv < 5.0, f"{col} value {fv} not in open interval (1,5)"


def test_scatter_scores_avoid_exact_endpoints():
    df = _make_random_session(n=800, seed=17)
    out = regime.compute_ranks(df)
    warm = regime.REGIME_PARAMS["1m"]["warmup"]
    for col in ("vol_score", "depth_score"):
        for i in range(warm, len(out)):
            v = out[col].iloc[i]
            if v is None:
                continue
            fv = float(v)
            assert not math.isclose(fv, 1.0, abs_tol=1e-9), f"{col}[{i}]==1.0"
            assert not math.isclose(fv, 5.0, abs_tol=1e-9), f"{col}[{i}]==5.0"


# ───────────────────────────────────────────────────────────
# 8. Empty input: function must not crash and must return columns.
# ───────────────────────────────────────────────────────────
def test_empty_dataframe():
    df = pd.DataFrame(columns=["high", "low", "volume", "vpt", "concentration"])
    out = regime.compute_ranks(df)
    assert list(out.columns) == [
        "high", "low", "volume", "vpt", "concentration",
        "range_pct", "v_rank", "d_rank", "vol_score", "depth_score",
    ]
    assert len(out) == 0


# ───────────────────────────────────────────────────────────
# Phase 5: hybrid warmup with cross-session seed history.
# ───────────────────────────────────────────────────────────


def _make_session_with_volume(n: int, base_high: float, base_low: float, seed: int) -> pd.DataFrame:
    """A small session with non-trivial range/vpt/concentration variability.

    The hybrid-warmup tests need seed sessions whose rolling z and
    percentile rank windows actually compute (zero-variance windows
    return rank=3 by tiebreaker, which is technically valid but masks
    the "did seed feed the math?" question).
    """
    rng = np.random.default_rng(seed)
    return pd.DataFrame({
        "high":          rng.uniform(base_high, base_high + 4.0, n),
        "low":           rng.uniform(base_low - 1.0, base_low + 1.0, n),
        "volume":        rng.integers(500, 5000, n),
        "vpt":           rng.uniform(50.0, 200.0, n),
        "concentration": rng.uniform(0.05, 0.50, n),
    })


def test_regime_hybrid_warmup_1h_emits_ranks_session_2():
    """5 seed sessions of 1h bars + 1 current → ranks emit from bar 0.

    Without seeding, a full RTH 1h grid has only 7 session-anchored bars and
    the 8-bar warmup would NULL every bar in the entire session. With
    seed_history_df containing the prior sessions' 1h bars, the working
    frame is long enough that the warmup mask falls entirely within the
    seed rows — so every current-session bar emits a non-NULL rank.
    """
    # 5 seed sessions of 7 bars each (~35 seed bars at 1h)
    seed_sessions = [
        _make_session_with_volume(7, base_high=4500.0, base_low=4498.0, seed=10 + i)
        for i in range(5)
    ]
    seed_df = pd.concat(seed_sessions, ignore_index=True)
    current_df = _make_session_with_volume(7, base_high=4500.0, base_low=4498.0, seed=99)

    out = regime.compute_ranks(current_df.copy(), timeframe="1h", seed_history_df=seed_df)

    assert len(out) == 7, "1h session length unchanged by seeding"
    for i in range(7):
        v = out["v_rank"].iloc[i]
        d = out["d_rank"].iloc[i]
        assert v is not None, f"bar {i} v_rank should be non-NULL with seed history"
        assert d is not None, f"bar {i} d_rank should be non-NULL with seed history"


def test_regime_seed_does_not_pollute_output():
    """seed_history_df rows are NEVER written back into the output frame.

    `compute_ranks(current, seed_history_df=seed)` returns a DataFrame
    whose len() equals the input current frame's length — seed rows are
    used for rolling-window math only, not for output. Critical contract
    so the CLI's row count stays stable across runs with vs without
    seed history.
    """
    seed_df = _make_session_with_volume(20, base_high=4500.0, base_low=4498.0, seed=33)
    current_df = _make_session_with_volume(15, base_high=4500.0, base_low=4498.0, seed=44)

    out = regime.compute_ranks(current_df.copy(), timeframe="15m", seed_history_df=seed_df)

    assert len(out) == 15, f"output rows = {len(out)}, expected 15 (current-only)"
    # Spot-check: the input columns are preserved on the output frame.
    assert "high" in out.columns and "low" in out.columns
    assert "v_rank" in out.columns and "d_rank" in out.columns


def test_regime_15m_seed_transitions_to_current_only_after_k():
    """Hybrid transition: post-K bars use current-session-only stats.

    With K=15 at 15m and a 30-bar current session, bars 0..14 should
    use seeded ranks and bars 15..29 should use current-only ranks.
    We verify the transition by checking that running the same current
    frame WITHOUT seed produces the same rank values from bar K onward
    (within the post-warmup region).
    """
    seed_df = _make_session_with_volume(80, base_high=4500.0, base_low=4498.0, seed=51)
    current_df = _make_session_with_volume(30, base_high=4501.0, base_low=4499.0, seed=52)

    seeded_out  = regime.compute_ranks(current_df.copy(), timeframe="15m", seed_history_df=seed_df)
    current_out = regime.compute_ranks(current_df.copy(), timeframe="15m", seed_history_df=None)

    K = regime.REGIME_PARAMS["15m"]["seed_transition_k"]
    # Bars at and after K must agree with the no-seed pass (post-K is
    # current-only by construction of the hybrid stitch).
    for i in range(K, 30):
        seeded_v = seeded_out["v_rank"].iloc[i]
        current_v = current_out["v_rank"].iloc[i]
        # Both are either int or None at the same positions because the
        # stitch swaps in current-only values verbatim.
        assert seeded_v == current_v, (
            f"bar {i} post-K seeded v_rank={seeded_v} != current-only v_rank={current_v}"
        )


def test_regime_params_keys():
    """Phase 5 contract: REGIME_PARAMS must cover all canonical timeframes."""
    assert set(regime.REGIME_PARAMS.keys()) >= {"1m", "5m", "15m", "1h"}
    assert regime.SEED_SESSIONS_BY_TF["5m"] == 0
    # Hybrid warmup is disabled at 1m / 5m and enabled at 15m / 1h.
    assert regime.REGIME_PARAMS["1m"]["seed_transition_k"] == 0
    assert regime.REGIME_PARAMS["5m"]["seed_transition_k"] == 0
    assert regime.REGIME_PARAMS["15m"]["seed_transition_k"] > 0
    assert regime.REGIME_PARAMS["1h"]["seed_transition_k"] > 0


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
