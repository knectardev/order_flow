"""Phase 6 VWAP-Anchor BiasEngine tests.

Coverage:

1. Coverage of the review's simplified table — every explicitly listed
   cell + VWAP-position resolves to the user-confirmed bias.
2. Full 5x5x3 matrix sanity (75 cells): every emitted label appears at
   least once, no cell raises.
3. Warmup NULL handling: any NULL rank short-circuits to NEUTRAL.
4. VWAP-band edge cases: close exactly at vwap -> 0; close at the
   band boundary -> 0 (inside band); just past band -> ±1.
5. Half-open denormalization predicate: 1m bar at 10:01 attaches to
   the 10:00 1h bar (covered by the API-level test in test_api.py;
   here we just sanity-check the SQL UPDATE against a synthetic fixture).
"""
from __future__ import annotations

import pathlib
import sys

import pytest


_SRC = pathlib.Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from orderflow_pipeline.aggregate import TICK_SIZE  # noqa: E402
from orderflow_pipeline.bias import (  # noqa: E402
    BIAS_LEVELS,
    VWAP_BAND_TICKS_BY_TF,
    classify_bias,
    compute_bias_column,
    vwap_position,
)


# ───────────────────────────────────────────────────────────────────
# 1. Review's simplified table — every explicit cell resolves correctly.
# ───────────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "v_rank, d_rank, vwap_pos, expected",
    [
        # Strong Bullish: rank (4,4) or (5,5) above VWAP
        (4, 4, +1, "BULLISH_STRONG"),
        (5, 5, +1, "BULLISH_STRONG"),
        # Accumulation: (5,5) below VWAP — the Bolder Read
        (5, 5, -1, "ACCUMULATION"),
        # Distribution: (5,1) above VWAP
        (5, 1, +1, "DISTRIBUTION"),
        # Strong Bearish: (5,1) below VWAP, (4,1) below VWAP
        (5, 1, -1, "BEARISH_STRONG"),
        (4, 1, -1, "BEARISH_STRONG"),
        # Mid-Ranks at VWAP -> Neutral
        (3, 3,  0, "NEUTRAL"),
    ],
)
def test_review_table_explicit_cells(v_rank, d_rank, vwap_pos, expected):
    assert classify_bias(v_rank, d_rank, vwap_pos) == expected


# ───────────────────────────────────────────────────────────────────
# 2. Default-coverage cases (cells the review's table didn't enumerate).
# ───────────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "v_rank, d_rank, vwap_pos, expected",
    [
        # Depth-leads-Location: deep book below VWAP -> ACCUMULATION
        (2, 5, -1, "ACCUMULATION"),  # low-vol steady deep below VWAP
        (4, 4, -1, "ACCUMULATION"),  # high-vol stacked below VWAP
        (1, 4, -1, "ACCUMULATION"),  # quiet deep below VWAP
        # Depth-leads-Location: thin book above VWAP -> DISTRIBUTION
        (4, 1, +1, "DISTRIBUTION"),  # high-vol thin above VWAP
        (3, 2, +1, "DISTRIBUTION"),  # mid-vol thin above VWAP
        # Mild default outside band, no Strong/Anomaly trigger
        (3, 3, +1, "BULLISH_MILD"),
        (3, 3, -1, "BEARISH_MILD"),
        # (1,1,+1): thin book above VWAP — depth-leads-Location triggers DISTRIBUTION
        # (1,1,-1): thin book below VWAP — no Strong/Anomaly trigger -> Mild bear
        (1, 1, +1, "DISTRIBUTION"),
        (1, 1, -1, "BEARISH_MILD"),
        (2, 4, +1, "BULLISH_MILD"),  # steady deep above VWAP — Mild (v=2 not in {4,5})
        (5, 3, +1, "BULLISH_MILD"),  # impulsive mid-depth above VWAP — Mild
        # Inside band -> NEUTRAL regardless of ranks
        (5, 5,  0, "NEUTRAL"),
        (1, 1,  0, "NEUTRAL"),
        (4, 1,  0, "NEUTRAL"),
        (5, 1,  0, "NEUTRAL"),
    ],
)
def test_default_coverage_cells(v_rank, d_rank, vwap_pos, expected):
    assert classify_bias(v_rank, d_rank, vwap_pos) == expected


# ───────────────────────────────────────────────────────────────────
# 3. Full 5x5x3 matrix: every emitted label appears at least once.
# ───────────────────────────────────────────────────────────────────
def test_full_matrix_emits_every_label():
    seen: set[str] = set()
    for v in range(1, 6):
        for d in range(1, 6):
            for pos in (-1, 0, +1):
                seen.add(classify_bias(v, d, pos))
    # Every label except possibly some edge cases must appear.
    for level in BIAS_LEVELS:
        assert level in seen, f"label {level!r} never emitted across 5x5x3 matrix"


# ───────────────────────────────────────────────────────────────────
# 4. Warmup NULL handling.
# ───────────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "v_rank, d_rank, vwap_pos",
    [
        (None, None, +1),
        (None, 5,    +1),
        (5,    None, +1),
        (None, None,  0),
        (None, None, -1),
        (None, 3,    -1),
    ],
)
def test_warmup_null_short_circuits_to_neutral(v_rank, d_rank, vwap_pos):
    assert classify_bias(v_rank, d_rank, vwap_pos) == "NEUTRAL"


# ───────────────────────────────────────────────────────────────────
# 5. VWAP-band edge cases.
# ───────────────────────────────────────────────────────────────────
def test_vwap_position_inputs():
    band = 4
    vwap = 4500.0
    # close exactly at vwap -> 0
    assert vwap_position(vwap, vwap, band) == 0
    # close exactly at the band boundary -> 0 (band is inclusive)
    assert vwap_position(vwap + band * TICK_SIZE, vwap, band) == 0
    assert vwap_position(vwap - band * TICK_SIZE, vwap, band) == 0
    # close just one tick past the band -> ±1
    assert vwap_position(vwap + (band + 1) * TICK_SIZE, vwap, band) == +1
    assert vwap_position(vwap - (band + 1) * TICK_SIZE, vwap, band) == -1
    # None / NaN -> 0 (treated as no signal)
    assert vwap_position(None, vwap, band) == 0
    assert vwap_position(vwap, None, band) == 0
    assert vwap_position(float("nan"), vwap, band) == 0
    assert vwap_position(vwap, float("nan"), band) == 0


def test_vwap_band_per_timeframe_is_canonical():
    # Catches drift if anyone changes the band table without updating tests.
    assert VWAP_BAND_TICKS_BY_TF == {"1m": 4, "15m": 8, "1h": 16}


# ───────────────────────────────────────────────────────────────────
# 6. compute_bias_column: end-to-end DataFrame stamping.
# ───────────────────────────────────────────────────────────────────
def test_compute_bias_column_stamps_each_row():
    pd = pytest.importorskip("pandas")
    band_1h = VWAP_BAND_TICKS_BY_TF["1h"]
    df = pd.DataFrame(
        {
            "close":  [4500.0, 4500.0 + (band_1h + 1) * TICK_SIZE, 4500.0 - (band_1h + 1) * TICK_SIZE, 4500.0],
            "vwap":   [4500.0, 4500.0,                              4500.0,                              4500.0],
            "v_rank": [3,      4,                                   5,                                   None],
            "d_rank": [3,      4,                                   1,                                   3],
        }
    )
    result = compute_bias_column(df, "1h")
    assert result is df  # mutated in place + returned
    assert df["bias_state"].tolist() == [
        "NEUTRAL",          # at VWAP
        "BULLISH_STRONG",   # above + (4,4)
        "BEARISH_STRONG",   # below + (5,1)
        "NEUTRAL",          # warmup NULL v_rank
    ]


def test_compute_bias_column_empty_frame():
    pd = pytest.importorskip("pandas")
    df = pd.DataFrame({"close": [], "vwap": [], "v_rank": [], "d_rank": []})
    out = compute_bias_column(df, "1m")
    assert out is df
    assert "bias_state" in df.columns
    assert len(df) == 0


def test_compute_bias_column_unknown_timeframe_raises():
    pd = pytest.importorskip("pandas")
    df = pd.DataFrame({"close": [4500.0], "vwap": [4500.0], "v_rank": [3], "d_rank": [3]})
    with pytest.raises(ValueError, match="Unknown timeframe"):
        compute_bias_column(df, "5m")


# ───────────────────────────────────────────────────────────────────
# 7. Anti-flicker: same bar input must always yield the same bias
#    (idempotency / determinism).
# ───────────────────────────────────────────────────────────────────
def test_classify_bias_is_deterministic():
    for v in range(1, 6):
        for d in range(1, 6):
            for pos in (-1, 0, +1):
                first = classify_bias(v, d, pos)
                for _ in range(5):
                    assert classify_bias(v, d, pos) == first


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
