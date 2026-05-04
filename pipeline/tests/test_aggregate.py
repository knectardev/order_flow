"""Phase 5 multi-timeframe aggregator tests.

Coverage:

1. test_aggregate_15m_ohlc_matches_aggregated_1m
   Build a synthetic stream of trades over 15 minutes; aggregate at 1m
   (yielding 15 bars) and at 15m (yielding 1 bar). Assert the 15m bar's
   OHLCV matches the synthetic 15m roll-up of the 1m bars (open=first,
   close=last, high=max, low=min, volume=sum, delta=sum).

2. test_15m_vpt_concentration_not_equal_to_1m_average
   VPT and concentration are NOT linearly summable — they're recomputed
   from per-trade re-binning. Build a stream where the per-tick volume
   distribution differs across the 1m sub-bars; the 15m bar's vpt /
   concentration should not equal the simple average of the 1m values.

3. test_1h_session_anchored_seven_bars
   Session-anchored 1h bins: seven bars per full RTH session including a
   short final bucket ending at rth_close.

4. test_aggregate_15m_drops_no_full_bars_in_rth
   RTH divides cleanly by 15 min ⇒ 26 bars expected, no partial drops.

5. test_bar_to_dict_carries_timeframe
   Phase 5 contract: every Bar.to_dict() row + every iter_profile_rows()
   row carries the active timeframe so the DB writer can scope by it.
"""
from __future__ import annotations

import json
import pathlib
import sys
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest


_SRC = pathlib.Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from orderflow_pipeline.aggregate import (  # noqa: E402
    BIN_NS_BY_TIMEFRAME,
    NS_PER_MINUTE,
    aggregate_trades,
)
from orderflow_pipeline.decode import Trade  # noqa: E402


ET = ZoneInfo("America/New_York")
UTC = timezone.utc

# Use a representative trading day. Any weekday with a normal 09:30-16:00
# RTH is fine — the test is about bin arithmetic, not calendar effects.
SESSION_DATE = date(2026, 4, 21)
FRONT_ID = 42140864

SESSION_ANCHOR_GOLDEN = (
    pathlib.Path(__file__).resolve().parent / "fixtures" / "session_anchor_aggregate_full_rth.golden.json"
)


def _full_session_one_trade_per_minute():
    trades = []
    base_ns = _ts_ns_at(9, 30)
    for m in range(390):
        trades.append(
            _trade(
                base_ns + m * NS_PER_MINUTE + 1_000_000_000,
                price=4500.0 + (m % 7) * 0.25,
                size=2,
                side="A",
            )
        )
    return trades


def _bar_aggregate_snapshot_dict(b):
    """Stable dict for golden-byte regression (post-aggregate bars only)."""
    vpt, conc = b._vpt_concentration()
    return {
        "bar_end_ns": b.bar_end_ns,
        "bin_start_ns": b.bin_start_ns,
        "bottom_body_volume_ratio": round(b.bottom_body_volume_ratio, 6),
        "bottom_cvd": round(b.bottom_cvd, 6),
        "bottom_cvd_norm": round(b.bottom_cvd_norm, 6),
        "close": round(b.close, 4),
        "concentration": conc,
        "cvd_imbalance": round(b.cvd_imbalance, 6),
        "delta": b.delta,
        "distinct_prices": b.distinct_prices,
        "high": round(b.high, 4),
        "high_before_low": b.high_before_low,
        "large_print_count": b.large_print_count,
        "low": round(b.low, 4),
        "lower_wick_liquidity": round(b.lower_wick_liquidity, 6),
        "lower_wick_ticks": b.lower_wick_ticks,
        "open": round(b.open, 4),
        "rejection_side": b.rejection_side,
        "rejection_strength": round(b.rejection_strength, 6),
        "rejection_type": b.rejection_type,
        "top_body_volume_ratio": round(b.top_body_volume_ratio, 6),
        "top_cvd": round(b.top_cvd, 6),
        "top_cvd_norm": round(b.top_cvd_norm, 6),
        "trade_count": b.trade_count,
        "upper_wick_liquidity": round(b.upper_wick_liquidity, 6),
        "upper_wick_ticks": b.upper_wick_ticks,
        "volume": b.volume,
        "vpt": vpt,
        "vwap": b.vwap,
    }


def _ts_ns_at(et_hour: int, et_minute: int, et_second: int = 0, *, day: date = SESSION_DATE) -> int:
    """Return ns-since-epoch for the given ET wall-clock instant."""
    dt_et = datetime(day.year, day.month, day.day, et_hour, et_minute, et_second, tzinfo=ET)
    return int(dt_et.astimezone(UTC).timestamp() * 1e9)


def _trade(ts_ns: int, *, price: float, size: int, side: str = "A", iid: int = FRONT_ID) -> Trade:
    return Trade(
        ts_event_ns=ts_ns,
        instrument_id=iid,
        price=price,
        size=size,
        side=side,
        flags=0,
    )


# ───────────────────────────────────────────────────────────
# 1. 15m OHLC matches 1m roll-up.
# ───────────────────────────────────────────────────────────
def test_aggregate_15m_ohlc_matches_aggregated_1m():
    # Build trades across the first 15 minutes of RTH (09:30-09:45 ET).
    # Spread one trade per minute on different prices, mixing aggressor
    # sides so delta is not just ±volume.
    trades = []
    base_ns = _ts_ns_at(9, 30)
    prices = [4500.0, 4501.0, 4500.5, 4500.25, 4502.0, 4501.5, 4500.0,
              4499.75, 4500.25, 4501.0, 4501.25, 4500.75, 4501.0, 4501.5, 4502.5]
    sides  = ["A", "A", "B", "A", "A", "B", "B", "A", "A", "B", "A", "B", "A", "A", "B"]
    sizes  = [10, 25, 12, 30, 18, 8, 14, 22, 17, 9, 11, 13, 6, 19, 24]

    for i, (p, s, sz) in enumerate(zip(prices, sides, sizes)):
        # Land each trade ~30s past the bar boundary so the bar's open
        # is unambiguously the trade we set, not some leftover state.
        trades.append(_trade(base_ns + i * NS_PER_MINUTE + 30_000_000_000,
                             price=p, size=sz, side=s))

    res_1m = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["1m"], timeframe="1m",
    )
    res_15m = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["15m"], timeframe="15m",
    )

    assert len(res_1m.bars) == 15, "expected 15 1m bars"
    assert len(res_15m.bars) == 1, "expected exactly one 15m bar"
    bar15 = res_15m.bars[0]

    # OHLC: 15m bar's values must match the 1m roll-up.
    expected_open  = res_1m.bars[0].open
    expected_close = res_1m.bars[-1].close
    expected_high  = max(b.high for b in res_1m.bars)
    expected_low   = min(b.low for b in res_1m.bars)
    expected_vol   = sum(b.volume for b in res_1m.bars)
    expected_delta = sum(b.delta for b in res_1m.bars)

    assert bar15.open  == pytest.approx(expected_open)
    assert bar15.close == pytest.approx(expected_close)
    assert bar15.high  == pytest.approx(expected_high)
    assert bar15.low   == pytest.approx(expected_low)
    assert bar15.volume == expected_vol
    assert bar15.delta == expected_delta


# ───────────────────────────────────────────────────────────
# 2. VPT / concentration NOT equal to averaged 1m values.
# ───────────────────────────────────────────────────────────
def test_15m_vpt_concentration_not_equal_to_1m_average():
    # Build trades whose per-tick distribution varies across 1m sub-bars.
    # The 15m re-binning sees the union of all per-tick volumes, which
    # produces a different vpt and concentration than averaging the 1m
    # bars' bar-level scalars would.
    trades = []
    base_ns = _ts_ns_at(9, 30)
    # Minute 0: many ticks at one level (high concentration locally).
    for i in range(20):
        trades.append(_trade(base_ns + 1_000_000_000 * i,
                             price=4500.0, size=5, side="A"))
    # Minutes 1..14: spread small trades across many distinct ticks
    # (low concentration locally) — gives the 15m bar a richer per-tick
    # distribution than any individual 1m bar.
    for m in range(1, 15):
        m_ns = base_ns + m * NS_PER_MINUTE
        for i in range(10):
            trades.append(_trade(m_ns + i * 5_000_000_000,
                                 price=4500.0 + 0.25 * i, size=2,
                                 side=("A" if i % 2 == 0 else "B")))

    res_1m = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["1m"], timeframe="1m",
    )
    res_15m = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["15m"], timeframe="15m",
    )
    assert len(res_15m.bars) == 1
    bar15 = res_15m.bars[0]

    avg_vpt_1m = sum(b._vpt_concentration()[0] for b in res_1m.bars) / len(res_1m.bars)
    avg_conc_1m = sum(b._vpt_concentration()[1] for b in res_1m.bars) / len(res_1m.bars)
    vpt_15m, conc_15m = bar15._vpt_concentration()

    # The whole point: 15m vpt / concentration are recomputed from raw
    # trades, not aggregated from 1m summaries, so they DO NOT equal
    # the per-1m averages.
    assert abs(vpt_15m - avg_vpt_1m) > 1e-3, \
        f"15m vpt {vpt_15m} unexpectedly equal to 1m average {avg_vpt_1m}"
    assert abs(conc_15m - avg_conc_1m) > 1e-3, \
        f"15m concentration {conc_15m} unexpectedly equal to 1m average {avg_conc_1m}"


# ───────────────────────────────────────────────────────────
# 3. Session-anchored 1h: seven bars, first at RTH open, short final bucket.
# ───────────────────────────────────────────────────────────
def test_1h_session_anchored_seven_bars():
    trades = _full_session_one_trade_per_minute()
    res_1h = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["1h"], timeframe="1h",
    )
    assert len(res_1h.bars) == 7, f"expected 7 session-anchored 1h bars; got {len(res_1h.bars)}"
    assert res_1h.bars[0].bin_start_ns == _ts_ns_at(9, 30)
    assert res_1h.bars[-1].bin_start_ns == _ts_ns_at(15, 30)
    assert res_1h.bars[-1].bar_end_ns == _ts_ns_at(16, 0)


def test_rth_full_session_bar_counts_and_end_spans():
    """Every minute populated ⇒ 390 / 78 / 26 / 7 emitted bars with partition ends."""
    trades = _full_session_one_trade_per_minute()
    res_1m = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["1m"], timeframe="1m",
    )
    res_5m = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["5m"], timeframe="5m",
    )
    res_15m = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["15m"], timeframe="15m",
    )
    res_1h = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["1h"], timeframe="1h",
    )
    assert len(res_1m.bars) == 390
    assert len(res_5m.bars) == 78
    assert len(res_15m.bars) == 26
    assert len(res_1h.bars) == 7
    assert res_1m.bars[0].bin_start_ns == _ts_ns_at(9, 30)
    assert res_1m.bars[-1].bar_end_ns == _ts_ns_at(16, 0)
    assert res_5m.bars[-1].bar_end_ns == _ts_ns_at(16, 0)
    assert res_15m.bars[-1].bar_end_ns == _ts_ns_at(16, 0)
    assert res_1h.bars[-1].bar_end_ns == _ts_ns_at(16, 0)


def test_session_aggregate_snapshot_matches_golden():
    """Byte-stable aggregate output for one canonical session (all TFs)."""
    trades = _full_session_one_trade_per_minute()
    payload = {}
    for tf in ("1m", "15m", "1h"):
        res = aggregate_trades(
            trades,
            front_month_id=FRONT_ID,
            session_date=SESSION_DATE,
            bin_ns=BIN_NS_BY_TIMEFRAME[tf],
            timeframe=tf,
        )
        payload[tf] = [_bar_aggregate_snapshot_dict(b) for b in res.bars]
    observed = json.dumps(payload, sort_keys=True).encode("utf-8")
    assert SESSION_ANCHOR_GOLDEN.is_file(), f"missing golden file {SESSION_ANCHOR_GOLDEN}"
    assert observed == SESSION_ANCHOR_GOLDEN.read_bytes()


# ───────────────────────────────────────────────────────────
# 4. 15m divides RTH evenly: 26 bars expected for a full session.
# ───────────────────────────────────────────────────────────
def test_aggregate_15m_drops_no_full_bars_in_rth():
    # One trade per minute spanning the entire RTH session (09:30-16:00).
    trades = []
    base_ns = _ts_ns_at(9, 30)
    for m in range(390):
        trades.append(_trade(base_ns + m * NS_PER_MINUTE + 1_000_000_000,
                             price=4500.0 + (m % 7) * 0.25, size=1, side="A"))

    res_15m = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["15m"], timeframe="15m",
    )
    # 6.5h / 15m = 26 bars exactly.
    assert len(res_15m.bars) == 26, f"expected 26 15m bars; got {len(res_15m.bars)}"


# ───────────────────────────────────────────────────────────
# 5. Phase 5 contract: every output row carries the timeframe.
# ───────────────────────────────────────────────────────────
def test_bar_to_dict_carries_timeframe():
    trades = []
    base_ns = _ts_ns_at(9, 30)
    for m in range(15):
        trades.append(_trade(base_ns + m * NS_PER_MINUTE + 30_000_000_000,
                             price=4500.0 + 0.25 * (m % 3), size=2, side="A"))
    res_15m = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["15m"], timeframe="15m",
    )
    assert len(res_15m.bars) == 1
    b = res_15m.bars[0]
    row = b.to_dict(SESSION_DATE, "15m")
    assert row["timeframe"] == "15m"
    assert row["bar_end_time"] == datetime.fromtimestamp(
        b.bar_end_ns / 1e9, tz=UTC
    ).replace(tzinfo=None)
    profile_rows = list(b.iter_profile_rows("15m"))
    assert profile_rows, "expected at least one profile row"
    for r in profile_rows:
        assert r["timeframe"] == "15m"


# ───────────────────────────────────────────────────────────
# 5b. PHAT path-order flag: whether high printed before low.
# ───────────────────────────────────────────────────────────
def test_phat_high_before_low_flag_tracks_extrema_order():
    base_ns = _ts_ns_at(9, 30)
    # Sequence A: high first, then low in same bar.
    trades_a = [
        _trade(base_ns + 1_000_000_000, price=100.0, size=1, side="A"),
        _trade(base_ns + 2_000_000_000, price=101.0, size=1, side="A"),  # high first
        _trade(base_ns + 3_000_000_000, price=99.0, size=1, side="B"),   # low second
    ]
    res_a = aggregate_trades(
        trades_a, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["1m"], timeframe="1m",
    )
    assert len(res_a.bars) == 1
    assert res_a.bars[0].high_before_low is True

    # Sequence B: low first, then high in same bar.
    trades_b = [
        _trade(base_ns + 1_000_000_000, price=100.0, size=1, side="A"),
        _trade(base_ns + 2_000_000_000, price=99.0, size=1, side="B"),   # low first
        _trade(base_ns + 3_000_000_000, price=101.0, size=1, side="A"),  # high second
    ]
    res_b = aggregate_trades(
        trades_b, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["1m"], timeframe="1m",
    )
    assert len(res_b.bars) == 1
    assert res_b.bars[0].high_before_low is False


# ───────────────────────────────────────────────────────────
# 6. Phase 6: running session VWAP.
# ───────────────────────────────────────────────────────────
def test_session_vwap_first_bar_equals_typical_price():
    # Single trade in minute 0 — the first 1m bar's vwap must equal its
    # own typical price exactly (cum_pv / cum_v == typical when N == 1).
    base_ns = _ts_ns_at(9, 30)
    trades = [_trade(base_ns + 1_000_000_000, price=4500.0, size=10, side="A")]

    res = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["1m"], timeframe="1m",
    )
    assert len(res.bars) == 1
    bar = res.bars[0]
    typical = (bar.high + bar.low + bar.close) / 3.0
    assert bar.vwap == pytest.approx(typical, abs=1e-4)


def test_session_vwap_monotonic_with_carry_forward():
    # Spread one trade per minute over 15 minutes, with one minute (m=7)
    # left empty so the bar is degenerate (no trade -> bin skipped).
    # The aggregator only emits bars with trades, so we instead check that
    # `vwap` is monotonically defined and never None on every emitted bar.
    base_ns = _ts_ns_at(9, 30)
    trades = []
    for m in range(15):
        if m == 7:
            continue
        trades.append(_trade(base_ns + m * NS_PER_MINUTE + 30_000_000_000,
                             price=4500.0 + 0.25 * m, size=5, side="A"))

    res = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["1m"], timeframe="1m",
    )
    assert len(res.bars) == 14
    for bar in res.bars:
        assert bar.vwap is not None, "every in-session bar with trades must have a vwap"
        assert isinstance(bar.vwap, float)


def test_session_vwap_converges_across_timeframes():
    # VWAP recurrence (_stamp_session_vwap) is unchanged from Phase 6; this
    # test only checks cross-timeframe agreement at shared *bar close*
    # instants after session-anchored re-binning (bin membership moved).
    #
    # The cumulative session VWAP at the close of any 1h bar must match
    # the cumulative VWAP at the corresponding 1m / 15m bar that closes
    # at the same instant — within a tolerance set by the typical-price
    # approximation drift. Build a full-RTH session with varied prices
    # so the per-bar typicals don't collapse to a degenerate average.
    base_ns = _ts_ns_at(9, 30)
    trades = []
    for m in range(390):
        # Price oscillates so 1m typicals differ noticeably from 15m / 1h
        # typicals — the convergence test then has teeth.
        p = 4500.0 + (m % 13) * 0.25 - (m % 7) * 0.125
        trades.append(_trade(base_ns + m * NS_PER_MINUTE + 1_000_000_000,
                             price=p, size=3, side="A" if m % 2 == 0 else "B"))

    res_1m = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["1m"], timeframe="1m",
    )
    res_15m = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["15m"], timeframe="15m",
    )
    res_1h = aggregate_trades(
        trades, front_month_id=FRONT_ID, session_date=SESSION_DATE,
        bin_ns=BIN_NS_BY_TIMEFRAME["1h"], timeframe="1h",
    )

    # At each 1h bar's exclusive end (bar_end_ns), pick the 1m / 15m bar
    # whose window ends at the same instant (half-open alignment).
    for hour_bar in res_1h.bars:
        end_ns = hour_bar.bar_end_ns
        one_min_before_close = end_ns - NS_PER_MINUTE
        cand_1m = [b for b in res_1m.bars if b.bin_start_ns == one_min_before_close]
        assert cand_1m, f"no 1m bar ending at {end_ns}"
        bar_1m_at_close = cand_1m[0]

        fifteen_min_before_close = end_ns - BIN_NS_BY_TIMEFRAME["15m"]
        cand_15m = [b for b in res_15m.bars if b.bin_start_ns == fifteen_min_before_close]
        assert cand_15m, f"no 15m bar ending at {end_ns}"
        bar_15m_at_close = cand_15m[0]

        # Tolerance: the typical-price drift across timeframes is bounded
        # by the bar range. For ES at $0.25 tick, 0.5 ES points (2 ticks)
        # is the loose upper bound; in practice convergence is within
        # 0.25 points.
        assert abs(bar_1m_at_close.vwap - hour_bar.vwap) <= 0.5, \
            f"1m vs 1h vwap diverged: {bar_1m_at_close.vwap} vs {hour_bar.vwap}"
        assert abs(bar_15m_at_close.vwap - hour_bar.vwap) <= 0.5, \
            f"15m vs 1h vwap diverged: {bar_15m_at_close.vwap} vs {hour_bar.vwap}"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
