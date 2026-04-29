from __future__ import annotations

import pathlib
import sys


_SRC = pathlib.Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from orderflow_pipeline.phat import compute_phat_features  # noqa: E402


def test_compute_phat_features_splits_cvd_by_body_midpoint():
    feats = compute_phat_features(
        open_price=100.0,
        close_price=102.0,
        high_price=103.0,
        low_price=99.0,
        tick_size=1.0,
        price_volume={99: 10, 100: 20, 101: 20, 102: 20, 103: 10},
        price_delta={99: -5, 100: -4, 101: 8, 102: 10, 103: 6},
    )
    assert feats["top_cvd"] == 24.0
    assert feats["bottom_cvd"] == -9.0
    assert abs(feats["top_body_volume_ratio"] - 0.625) < 1e-9
    assert abs(feats["bottom_body_volume_ratio"] - 0.375) < 1e-9


def test_compute_phat_features_wick_liquidity_outer_half():
    feats = compute_phat_features(
        open_price=100.0,
        close_price=100.0,
        high_price=104.0,
        low_price=96.0,
        tick_size=1.0,
        price_volume={96: 5, 97: 5, 98: 5, 99: 5, 100: 10, 101: 5, 102: 5, 103: 10, 104: 20},
        price_delta={100: 0},
    )
    # upper wick ticks: 101..104 => outer half = 103,104 => (10+20)/(5+5+10+20) = 0.75
    assert abs(feats["upper_wick_liquidity"] - 0.75) < 1e-9
    # lower wick ticks: 99..96 => outer half = 97,96 => (5+5)/(5+5+5+5) = 0.5
    assert abs(feats["lower_wick_liquidity"] - 0.5) < 1e-9
    assert feats["top_body_volume_ratio"] > feats["bottom_body_volume_ratio"]


def test_compute_phat_features_handles_no_wicks():
    feats = compute_phat_features(
        open_price=100.0,
        close_price=101.0,
        high_price=101.0,
        low_price=100.0,
        tick_size=1.0,
        price_volume={100: 10, 101: 10},
        price_delta={100: 2, 101: 3},
    )
    assert feats["upper_wick_liquidity"] == 0.0
    assert feats["lower_wick_liquidity"] == 0.0
