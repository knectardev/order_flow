"""Velocity metrics: path length, within-bar flips, derived ratios."""
from __future__ import annotations

import pathlib
import sys
from datetime import date, datetime, timezone

from zoneinfo import ZoneInfo

import numpy as np
import pytest

_SRC = pathlib.Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from orderflow_pipeline.aggregate import (  # noqa: E402
    NS_PER_MINUTE,
    aggregate_trades,
)
from orderflow_pipeline.decode import Trade  # noqa: E402
from orderflow_pipeline.velocity_regime import (  # noqa: E402
    MIN_PRIOR_BARS,
    _midrank_percentile,
    stamp_trade_context,
    stamp_velocity_regimes,
    trade_context_from_regimes,
)


SESSION_DATE = date(2026, 4, 21)
FRONT_ID = 42140864
ET = ZoneInfo("America/New_York")
UTC = timezone.utc


def _ts_ns_at(
    et_hour: int, et_minute: int, et_second: int = 0, *, day: date = SESSION_DATE
) -> int:
    dt_et = datetime(day.year, day.month, day.day, et_hour, et_minute, et_second, tzinfo=ET)
    return int(dt_et.astimezone(UTC).timestamp() * 1e9)


def _trade(ts_ns: int, *, price: float, size: int, side: str) -> Trade:
    return Trade(
        ts_event_ns=ts_ns,
        instrument_id=FRONT_ID,
        price=price,
        size=size,
        side=side,
        flags=0,
    )


def test_velocity_first_trade_no_prior_path_segment():
    base_ns = _ts_ns_at(9, 30)
    trades = [
        _trade(base_ns + 1_000_000_000, price=4500.0, size=1, side="A"),
        _trade(base_ns + 2_000_000_000, price=4501.0, size=2, side="A"),
    ]
    res = aggregate_trades(
        trades,
        front_month_id=FRONT_ID,
        session_date=SESSION_DATE,
        timeframe="1m",
    )
    assert len(res.bars) == 1
    b = res.bars[0]
    assert b.path_length_ticks == 4
    assert b.flip_count == 0


def test_velocity_flip_within_bar_and_flip_rate():
    base_ns = _ts_ns_at(9, 30)
    trades = [
        _trade(base_ns + 1_000_000_000, price=4500.0, size=1, side="A"),
        _trade(base_ns + 2_000_000_000, price=4500.0, size=1, side="B"),
    ]
    res = aggregate_trades(
        trades,
        front_month_id=FRONT_ID,
        session_date=SESSION_DATE,
        timeframe="1m",
    )
    b = res.bars[0]
    assert b.flip_count == 1
    assert b.flip_rate == pytest.approx(1.0)
    assert b.trade_count == 2


def test_velocity_cross_bar_flip_not_counted_path_counts():
    base_ns = _ts_ns_at(9, 30)
    t0 = base_ns + 1_000_000_000
    t1 = base_ns + NS_PER_MINUTE + 1_000_000_000
    trades = [
        _trade(t0, price=4500.0, size=1, side="A"),
        _trade(t1, price=4501.0, size=1, side="B"),
    ]
    res = aggregate_trades(
        trades,
        front_month_id=FRONT_ID,
        session_date=SESSION_DATE,
        timeframe="1m",
    )
    assert len(res.bars) == 2
    assert res.bars[0].flip_count == 0
    assert res.bars[1].flip_count == 0
    assert res.bars[1].path_length_ticks == 4


def test_velocity_single_trade_flip_rate_null():
    base_ns = _ts_ns_at(9, 30)
    trades = [_trade(base_ns + 1_000_000_000, price=4500.0, size=3, side="A")]
    res = aggregate_trades(
        trades,
        front_month_id=FRONT_ID,
        session_date=SESSION_DATE,
        timeframe="1m",
    )
    assert res.bars[0].flip_rate is None


def test_pld_ratio_null_when_flat_bar():
    """Zero tick range -> NULL pld_ratio (degenerate OHLC)."""
    base_ns = _ts_ns_at(9, 30)
    trades = [
        _trade(base_ns + 1_000_000_000, price=4500.0, size=1, side="A"),
        _trade(base_ns + 2_000_000_000, price=4500.0, size=1, side="A"),
    ]
    res = aggregate_trades(
        trades,
        front_month_id=FRONT_ID,
        session_date=SESSION_DATE,
        timeframe="1m",
    )
    assert res.bars[0].pld_ratio is None


def test_pld_ratio_path_over_range_ticks():
    """path_length_ticks / (high_ticks - low_ticks); zigzag increases path vs range."""
    base_ns = _ts_ns_at(9, 30)
    trades = [
        _trade(base_ns + 1_000_000_000, price=4500.0, size=1, side="A"),
        _trade(base_ns + 2_000_000_000, price=4501.0, size=1, side="A"),
        _trade(base_ns + 3_000_000_000, price=4500.0, size=1, side="A"),
    ]
    res = aggregate_trades(
        trades,
        front_month_id=FRONT_ID,
        session_date=SESSION_DATE,
        timeframe="1m",
    )
    b = res.bars[0]
    assert b.path_length_ticks == 8
    assert b.pld_ratio == pytest.approx(2.0)


def test_jitter_midrank_log_matches_linear_for_positive_samples():
    """Midrank is rank-only; log is monotonic, so percentiles match on positive PLD.

    Ingest still uses ``log(pld_ratio)`` explicitly as the contract for jitter (plan);
    filtering to positive finite priors matches the ranking domain.
    """
    rng = np.random.default_rng(0)
    for _ in range(20):
        priors = rng.uniform(0.5, 200.0, size=40)
        current = float(rng.uniform(0.5, 200.0))
        lin = _midrank_percentile(priors, current)
        log_r = _midrank_percentile(np.log(priors), np.log(current))
        assert lin == pytest.approx(log_r)


def test_stamp_velocity_regimes_no_db_noop():
    base_ns = _ts_ns_at(9, 30)
    trades = [
        _trade(base_ns + 1e9, price=4500.0, size=1, side="A"),
        _trade(base_ns + 2e9, price=4501.0, size=1, side="B"),
    ]
    res = aggregate_trades(
        trades,
        front_month_id=FRONT_ID,
        session_date=SESSION_DATE,
        timeframe="1m",
    )
    stamp_velocity_regimes(res.bars, timeframe="1m", session_kind="rth", con=None)
    assert res.bars[0].jitter_regime is None


def test_min_prior_constant_documents_warmup():
    assert MIN_PRIOR_BARS == 30


def test_trade_context_from_regimes_matrix():
    assert trade_context_from_regimes("Low", "High") == "favorable"
    assert trade_context_from_regimes("High", "Low") == "avoid"
    assert trade_context_from_regimes("High", "High") == "watch"
    assert trade_context_from_regimes("Low", "Low") == "neutral"
    assert trade_context_from_regimes("Mid", "Mid") == "neutral"
    assert trade_context_from_regimes(None, "High") == "neutral"
    assert trade_context_from_regimes("Low", None) == "neutral"


def test_stamp_trade_context_sets_neutral_when_regimes_missing():
    base_ns = _ts_ns_at(9, 30)
    trades = [
        _trade(base_ns + 1e9, price=4500.0, size=1, side="A"),
        _trade(base_ns + 2e9, price=4501.0, size=1, side="B"),
    ]
    res = aggregate_trades(
        trades,
        front_month_id=FRONT_ID,
        session_date=SESSION_DATE,
        timeframe="1m",
    )
    stamp_velocity_regimes(res.bars, timeframe="1m", session_kind="rth", con=None)
    stamp_trade_context(res.bars)
    assert res.bars[0].trade_context == "neutral"


def test_bar_to_dict_includes_session_kind_and_velocity():
    base_ns = _ts_ns_at(9, 30)
    trades = [
        _trade(base_ns + 1e9, price=4500.0, size=1, side="A"),
        _trade(base_ns + 2e9, price=4501.0, size=1, side="B"),
    ]
    res = aggregate_trades(
        trades,
        front_month_id=FRONT_ID,
        session_date=SESSION_DATE,
        timeframe="1m",
    )
    stamp_trade_context(res.bars)
    row = res.bars[0].to_dict(SESSION_DATE, "1m", session_kind="rth")
    assert row["session_kind"] == "rth"
    assert row["trade_context"] == "neutral"
    assert row["path_length_ticks"] == 4
    assert row["flip_count"] == 1
    assert row["pld_ratio"] is not None
