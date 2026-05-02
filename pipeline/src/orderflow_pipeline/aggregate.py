"""Aggregate filtered Trade records into OHLCV+delta+microstructure bars at
a configurable bin width (1m / 15m / 1h — Phase 5).

Bar schema (matches `orderflow_dashboard.html`'s `generateBar` output plus
microstructure fields used by the depth-proxy and the data-driven regime
classifier (`vpt`, `concentration`, `distinct_prices`, plus the per-tick
volume/delta breakdown persisted to `bar_volume_profile`):

    {
        "open":            float,
        "high":            float,
        "low":             float,
        "close":           float,
        "volume":          int,    # sum of trade.size
        "delta":           int,    # signed-volume aggressor delta
        "tradeCount":      int,    # number of trades in the bin
        "largePrintCount": int,    # trades with size >= LARGE_PRINT_THRESHOLD
        "avgTradeSize":    float,  # volume / tradeCount
        "distinctPrices":  int,    # unique price *levels* (rounded to TICK_SIZE)
        "vpt":             float,  # volume / distinctPrices ("depth" — high = stacked)
        "concentration":   float,  # modal_volume / volume   ("friction" — high = brick wall)
        "time":            str     # ISO-8601 UTC, bin-start ("...:31:00Z")
        "barEnd":          str     # ISO-8601 UTC, exclusive bar end (half-open [start,end))
    }

Per-tick breakdown is exposed via Bar.iter_profile_rows() and routed to the
DuckDB `bar_volume_profile` table by the CLI.

Phase 5: a single `aggregate_trades` call now bins to one configurable
timeframe via the `bin_ns` parameter. The CLI invokes it three times per
session (1m / 15m / 1h), once per timeframe, re-binning from the raw trade
stream each time. VPT and concentration are NOT summable from 1-minute
bars; they require recomputation from raw trades per timeframe.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from typing import Iterable, Iterator
from zoneinfo import ZoneInfo

from .decode import Trade
from .phat import compute_phat_features


# Default cutoff for "large print" on ES (institutional/block-ish). The
# dashboard reads this from the JSON `tunings` block, so production tuning
# is data-side, not code-side.
DEFAULT_LARGE_PRINT_THRESHOLD = 50

NS_PER_MINUTE = 60 * 1_000_000_000

# Phase 5 bin widths. `bin_ns` is what `aggregate_trades` actually consumes;
# this dict is the canonical source of truth for the three supported
# timeframes the rest of the pipeline + dashboard agrees on.
BIN_NS_BY_TIMEFRAME: dict[str, int] = {
    "1m":  60 * 1_000_000_000,
    "15m": 15 * 60 * 1_000_000_000,
    "1h":  60 * 60 * 1_000_000_000,
}

ET = ZoneInfo("America/New_York")
UTC = timezone.utc

# Standard CME equity-index RTH session: 09:30 - 16:00 ET.
RTH_OPEN = time(9, 30)
RTH_CLOSE = time(16, 0)

# ES tick size. Used to quantize trade prices into integer bucket keys for
# the per-bar volume profile. Recover the price as `price_tick * TICK_SIZE`.
# Persisting the integer bucket (not the float price) keeps the
# `bar_volume_profile` PRIMARY KEY exact and the indexes cheap.
TICK_SIZE = 0.25


@dataclass(slots=True)
class Bar:
    open: float
    high: float
    low: float
    close: float
    volume: int = 0
    delta: int = 0
    trade_count: int = 0
    large_print_count: int = 0
    bin_start_ns: int = 0   # nanoseconds since epoch, bar open (inclusive)
    bar_end_ns: int = 0     # nanoseconds since epoch, bar close (exclusive); set after aggregation
    high_first_ns: int = 0
    low_first_ns: int = 0
    # Per-tick microstructure. Keyed on integer `round(price / TICK_SIZE)`;
    # not exposed to JSON (large + only meaningful in DB form), but
    # consumed by both `to_dict()` (for the bar-level vpt / concentration
    # scalars) and `iter_profile_rows()` (for the bar_volume_profile rows).
    price_volume: dict[int, int] = field(default_factory=dict)
    price_delta:  dict[int, int] = field(default_factory=dict)
    # Regime (Phase 5) classifier output. Populated only by regime.compute_ranks
    # (see _stamp_ranks in cli.py). v_rank/d_rank: smoothed integers 1..5.
    # vol_score/depth_score: scatter-only mid-rank track — open (1,5) for
    # typical multi-bar windows — never smoothed, never endpoint-only.
    # Do not assign from legacy endpoint-percentile scatter or np.clip stack.
    range_pct: float | None = None
    v_rank: int | None = None
    d_rank: int | None = None
    vol_score: float | None = None
    depth_score: float | None = None
    # Phase 6 VWAP-Anchor input. Running session VWAP at this bar's close,
    # computed once per session per timeframe in `_stamp_session_vwap`
    # using volume-weighted typical price. Empty bars carry forward the
    # previous bar's vwap; left None until the first non-zero-volume bar.
    vwap: float | None = None
    # PHAT candle features (Phase 7): body CVD split + wick-tip liquidity.
    top_cvd: float = 0.0
    bottom_cvd: float = 0.0
    top_cvd_norm: float = 0.0
    bottom_cvd_norm: float = 0.0
    cvd_imbalance: float = 0.0
    top_body_volume_ratio: float = 0.5
    bottom_body_volume_ratio: float = 0.5
    upper_wick_liquidity: float = 0.0
    lower_wick_liquidity: float = 0.0
    upper_wick_ticks: int = 0
    lower_wick_ticks: int = 0
    high_before_low: bool = True
    rejection_side: str = "none"
    rejection_strength: float = 0.0
    rejection_type: str = "none"
    # Session cumulative delta (contracts): stamped by `_stamp_session_cvd`.
    session_cvd: int = 0
    aggressive_buy_count: int = 0
    aggressive_sell_count: int = 0
    sum_aggressive_buy_size: int = 0
    sum_aggressive_sell_size: int = 0

    @property
    def distinct_prices(self) -> int:
        return len(self.price_volume)

    @property
    def modal_volume(self) -> int:
        return max(self.price_volume.values()) if self.price_volume else 0

    def _vpt_concentration(self) -> tuple[float, float]:
        """Compute (vpt, concentration) rounded to 6 decimals.

        Anti-jitter contract: both writers (JSON serializer and DuckDB
        writer) consume the same already-rounded scalar so the
        `verify_phase1.py` `1e-9` equality gate cannot fail on
        serialization noise — a mismatch there will only flag real
        aggregator drift.

        Falls back to (0.0, 0.0) for empty bars (volume == 0); zero-volume
        bars are still emitted (with an empty price_volume dict) so the
        bar grid stays contiguous, but their derived microstructure scalars
        are degenerate.
        """
        dp = self.distinct_prices
        if self.volume <= 0 or dp == 0:
            return (0.0, 0.0)
        vpt = self.volume / dp
        concentration = self.modal_volume / self.volume
        return (round(vpt, 6), round(concentration, 6))

    def _avg_trade_size(self) -> float:
        return self.volume / self.trade_count if self.trade_count else 0.0

    def _size_imbalance_ratio(self) -> float | None:
        if self.aggressive_buy_count == 0 or self.aggressive_sell_count == 0:
            return None
        avg_buy = self.sum_aggressive_buy_size / self.aggressive_buy_count
        avg_sell = self.sum_aggressive_sell_size / self.aggressive_sell_count
        if avg_sell == 0:
            return None
        return round(avg_buy / avg_sell, 6)

    def _iso_time(self) -> str:
        return datetime.fromtimestamp(self.bin_start_ns / 1e9, tz=UTC).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )

    def _iso_bar_end(self) -> str:
        return datetime.fromtimestamp(self.bar_end_ns / 1e9, tz=UTC).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )

    def to_json(self) -> dict:
        """JSON-mode serialization (dashboard via data/bars/*.json).

        Matches the original prototype shape PLUS the three microstructure
        fields the data-driven regime classifier needs (`distinctPrices`,
        `vpt`, `concentration`), plus the regime ranks (`range_pct`,
        `v_rank`, `d_rank`). Per-tick breakdown is intentionally omitted —
        the JSON dashboard uses an OHLC-distribution proxy.

        ``barEnd`` is the exclusive end instant (half-open bar window).

        `timeframe` is NOT included in the JSON shape today; JSON output is
        per-file (one file per (session, timeframe) future step), and the
        dashboard reads it from the API instead.
        """
        vpt, concentration = self._vpt_concentration()
        return {
            "open":            round(self.open, 4),
            "high":            round(self.high, 4),
            "low":             round(self.low, 4),
            "close":           round(self.close, 4),
            "volume":          self.volume,
            "delta":           self.delta,
            "tradeCount":      self.trade_count,
            "largePrintCount": self.large_print_count,
            "avgTradeSize":    round(self._avg_trade_size(), 3),
            "distinctPrices":  self.distinct_prices,
            "vpt":             vpt,
            "concentration":   concentration,
            "rangePct":        self.range_pct,
            "vRank":           self.v_rank,
            "dRank":           self.d_rank,
            "volScore":        round(self.vol_score, 6) if self.vol_score is not None else None,
            "depthScore":      round(self.depth_score, 6) if self.depth_score is not None else None,
            "vwap":            self.vwap,
            "topCvd":          self.top_cvd,
            "bottomCvd":       self.bottom_cvd,
            "topCvdNorm":      self.top_cvd_norm,
            "bottomCvdNorm":   self.bottom_cvd_norm,
            "cvdImbalance":    self.cvd_imbalance,
            "topBodyVolumeRatio": self.top_body_volume_ratio,
            "bottomBodyVolumeRatio": self.bottom_body_volume_ratio,
            "upperWickLiquidity": self.upper_wick_liquidity,
            "lowerWickLiquidity": self.lower_wick_liquidity,
            "highBeforeLow":   self.high_before_low,
            "rejectionSide":   self.rejection_side,
            "rejectionStrength": self.rejection_strength,
            "rejectionType":   self.rejection_type,
            "sessionCvd":      int(self.session_cvd),
            "aggressiveBuyCount": self.aggressive_buy_count,
            "aggressiveSellCount": self.aggressive_sell_count,
            "avgAggressiveBuySize": round(
                self.sum_aggressive_buy_size / self.aggressive_buy_count, 4
            ) if self.aggressive_buy_count else 0.0,
            "avgAggressiveSellSize": round(
                self.sum_aggressive_sell_size / self.aggressive_sell_count, 4
            ) if self.aggressive_sell_count else 0.0,
            "sizeImbalanceRatio": self._size_imbalance_ratio(),
            "time":            self._iso_time(),
            "barEnd":          self._iso_bar_end(),
        }

    def to_dict(self, session_date: date, timeframe: str) -> dict:
        """DuckDB-mode row dict (column names = bars table column names).

        Consumed by db.write_session(). `bar_time` / `bar_end_time` are
        stdlib UTC datetimes (tz stripped) so DuckDB ingest stays consistent
        with existing TIMESTAMP columns.

        `timeframe` is the canonical Phase 5 keying ('1m' / '15m' / '1h').
        It is stamped on every row for the active aggregation pass; the DB
        writer uses it to scope DELETE/INSERT to the active timeframe.
        """
        vpt, concentration = self._vpt_concentration()
        return {
            "session_date":      session_date,
            "bar_time":          datetime.fromtimestamp(self.bin_start_ns / 1e9, tz=UTC).replace(tzinfo=None),
            "bar_end_time":      datetime.fromtimestamp(self.bar_end_ns / 1e9, tz=UTC).replace(tzinfo=None),
            "timeframe":         timeframe,
            "open":              round(self.open, 4),
            "high":              round(self.high, 4),
            "low":               round(self.low, 4),
            "close":             round(self.close, 4),
            "volume":            int(self.volume),
            "delta":             int(self.delta),
            "trade_count":       int(self.trade_count),
            "large_print_count": int(self.large_print_count),
            "distinct_prices":   int(self.distinct_prices),
            "range_pct":         self.range_pct,
            "vpt":               vpt,
            "concentration":     concentration,
            "v_rank":            self.v_rank,
            "d_rank":            self.d_rank,
            "vol_score":         round(self.vol_score, 6) if self.vol_score is not None else None,
            "depth_score":       round(self.depth_score, 6) if self.depth_score is not None else None,
            "vwap":              self.vwap,
            "top_cvd":           self.top_cvd,
            "bottom_cvd":        self.bottom_cvd,
            "top_cvd_norm":      self.top_cvd_norm,
            "bottom_cvd_norm":   self.bottom_cvd_norm,
            "cvd_imbalance":     self.cvd_imbalance,
            "top_body_volume_ratio": self.top_body_volume_ratio,
            "bottom_body_volume_ratio": self.bottom_body_volume_ratio,
            "upper_wick_liquidity": self.upper_wick_liquidity,
            "lower_wick_liquidity": self.lower_wick_liquidity,
            "high_before_low":   self.high_before_low,
            "rejection_side":    self.rejection_side,
            "rejection_strength": self.rejection_strength,
            "rejection_type":    self.rejection_type,
            "session_cvd":       int(self.session_cvd),
            "aggressive_buy_count": int(self.aggressive_buy_count),
            "aggressive_sell_count": int(self.aggressive_sell_count),
            "avg_aggressive_buy_size": round(
                self.sum_aggressive_buy_size / self.aggressive_buy_count, 4
            ) if self.aggressive_buy_count else 0.0,
            "avg_aggressive_sell_size": round(
                self.sum_aggressive_sell_size / self.aggressive_sell_count, 4
            ) if self.aggressive_sell_count else 0.0,
            "size_imbalance_ratio": self._size_imbalance_ratio_db(),
        }

    def _size_imbalance_ratio_db(self) -> float | None:
        return self._size_imbalance_ratio()

    def iter_profile_rows(self, timeframe: str) -> Iterator[dict]:
        """Yield one row per (price_tick) for `bar_volume_profile` insertion.

        `timeframe` is stamped on every emitted row so the DB's composite
        PK `(bar_time, timeframe, price_tick)` resolves cleanly across
        timeframes. Session-anchored RTH grids align 1m/15m/1h bin starts
        where period boundaries coincide (not UTC-hour-driven for 1h).

        Skips ticks with zero volume (shouldn't happen in practice — every
        key in `price_volume` was created on a non-zero `size += t.size`).
        """
        bar_time = datetime.fromtimestamp(self.bin_start_ns / 1e9, tz=UTC).replace(
            tzinfo=None
        )
        for price_tick, vol in self.price_volume.items():
            if vol <= 0:
                continue
            yield {
                "bar_time":   bar_time,
                "timeframe":  timeframe,
                "price_tick": int(price_tick),
                "volume":     int(vol),
                "delta":      int(self.price_delta.get(price_tick, 0)),
            }


@dataclass(slots=True)
class AggregateResult:
    bars: list[Bar] = field(default_factory=list)
    front_month_id: int | None = None
    front_month_symbol: str | None = None
    session: str = "rth"
    session_date: date | None = None
    session_start_ns: int | None = None
    session_end_ns: int | None = None
    # Phase 5: bin width this result was aggregated at, and the canonical
    # timeframe key ('1m' / '15m' / '1h'). Both flow into every downstream
    # writer (DB, JSON path) so the active timeframe is unambiguous.
    bin_ns: int = NS_PER_MINUTE
    timeframe: str = "1m"


def session_bar_end_ns(
    bin_start_ns: int,
    bin_ns: int,
    *,
    session: str,
    rth_close_ns: int | None,
) -> int:
    """Exclusive end nanosecond for a bar's half-open window [bin_start, end).

    RTH caps the final bucket at ``rth_close_ns``. Globex uses nominal width.
    """
    if session == "rth" and rth_close_ns is not None:
        return min(bin_start_ns + bin_ns, rth_close_ns)
    return bin_start_ns + bin_ns


def _rth_window_ns(session_date: date) -> tuple[int, int]:
    """Return [open_ns, close_ns) for the RTH session of `session_date` in ET."""
    start_et = datetime.combine(session_date, RTH_OPEN, tzinfo=ET)
    end_et = datetime.combine(session_date, RTH_CLOSE, tzinfo=ET)
    return (
        int(start_et.astimezone(UTC).timestamp() * 1e9),
        int(end_et.astimezone(UTC).timestamp() * 1e9),
    )


def _signed_size(side: str, size: int) -> int:
    """A=+size, B=-size, N=0 (volume yes, delta no)."""
    if side == "A":
        return size
    if side == "B":
        return -size
    return 0


def _stamp_session_cvd(bars: list[Bar]) -> None:
    """Cumulative session delta at each bar close (sum of bar deltas in order)."""
    cum = 0
    for b in bars:
        cum += int(b.delta)
        b.session_cvd = cum


def _stamp_session_vwap(bars: list[Bar]) -> None:
    """Stamp running session VWAP on each bar in place (Phase 6).

    **Semantic invariance:** the recurrence below is unchanged across binning
    migrations; only which trades populate each ``Bar`` (bin boundaries /
    timestamps) changes. Same trades and ordering imply the same per-bar OHLC
    inputs within each bucket, hence VWAP tracks bin definitions—not a new
    formula.

    Runs after bars are finalized for the active session mode so it walks
    emitted bars in chronological order. Uses the standard VWAP formula with
    bar typical price as the unit-of-volume-weighting:

        cum_pv = sum_{0..i} typical[j] * volume[j]
        cum_v  = sum_{0..i} volume[j]
        vwap[i] = cum_pv / cum_v

    where typical[j] = (high[j] + low[j] + close[j]) / 3.

    Empty bars (zero volume) carry forward the previous bar's vwap so the
    column is never NULL once at least one in-session bar has traded; the
    first in-session bar's vwap equals its own typical price (N == 1 ->
    cum_pv == typical * volume, cum_v == volume).

    The bar-level approximation differs from a strict trade-level VWAP by
    at most a fraction of a tick (the typical-price drift); see
    `pipeline/tests/test_aggregate.py::test_session_vwap` for the
    convergence bound.
    """
    cum_pv = 0.0
    cum_v = 0
    last_vwap: float | None = None
    for b in bars:
        if b.volume <= 0:
            b.vwap = last_vwap
            continue
        typical = (b.high + b.low + b.close) / 3.0
        cum_pv += typical * b.volume
        cum_v += b.volume
        last_vwap = round(cum_pv / cum_v, 4)
        b.vwap = last_vwap


def _stamp_phat_features(bars: list[Bar]) -> None:
    """Compute PHAT candle features for each bar in place."""
    for b in bars:
        feats = compute_phat_features(
            open_price=b.open,
            close_price=b.close,
            high_price=b.high,
            low_price=b.low,
            tick_size=TICK_SIZE,
            price_volume=b.price_volume,
            price_delta=b.price_delta,
        )
        b.top_cvd = feats["top_cvd"]
        b.bottom_cvd = feats["bottom_cvd"]
        b.top_cvd_norm = feats["top_cvd_norm"]
        b.bottom_cvd_norm = feats["bottom_cvd_norm"]
        b.cvd_imbalance = feats["cvd_imbalance"]
        b.top_body_volume_ratio = feats["top_body_volume_ratio"]
        b.bottom_body_volume_ratio = feats["bottom_body_volume_ratio"]
        b.upper_wick_liquidity = feats["upper_wick_liquidity"]
        b.lower_wick_liquidity = feats["lower_wick_liquidity"]
        b.upper_wick_ticks = int(feats["upper_wick_ticks"])
        b.lower_wick_ticks = int(feats["lower_wick_ticks"])
        b.high_before_low = b.high_first_ns <= b.low_first_ns
        b.rejection_side = feats["rejection_side"]
        b.rejection_strength = feats["rejection_strength"]
        b.rejection_type = feats["rejection_type"]


def aggregate_trades(
    trades: Iterable[Trade],
    *,
    front_month_id: int,
    session_date: date,
    session: str = "rth",
    large_print_threshold: int = DEFAULT_LARGE_PRINT_THRESHOLD,
    bin_ns: int = NS_PER_MINUTE,
    timeframe: str = "1m",
) -> AggregateResult:
    """Bin a stream of trades into OHLCV+delta bars at the requested bin width.

    Phase 5: `bin_ns` selects the aggregation grid (60e9 = 1m, 900e9 = 15m,
    3600e9 = 1h). `timeframe` is a string key stamped on every output row
    for downstream DB/API/dashboard scoping. The two parameters are
    redundant on purpose — `bin_ns` is the math, `timeframe` is the label,
    and they're paired via `BIN_NS_BY_TIMEFRAME`.

    **RTH binning:** bins are **session-anchored** to ``rth_open_ns``::

        bin_start = rth_open_ns + floor((ts - rth_open_ns) / bin_ns) * bin_ns

    so the first bar of each timeframe starts at the cash open (09:30 ET).
    **Globex** keeps UTC-aligned ``floor(ts / bin_ns) * bin_ns``.

    **Trailing bucket (Strategy A):** when ``bin_ns`` does not evenly divide
    the RTH session (e.g. 1h), the final bar may span fewer than ``bin_ns``
    nanoseconds; ``Bar.bar_end_ns`` is ``min(bin_start + bin_ns, rth_close_ns)``
    (exclusive end).

    **VWAP:** `_stamp_session_vwap` uses the same cumulative typical-price
    formula as before; migration changes only trade-to-bar assignment, not
    the VWAP recurrence.

    - Drops any trade whose `instrument_id != front_month_id` (filters out
      spreads + back months).
    - If `session == 'rth'`, drops trades outside 09:30-16:00 ET on
      `session_date`.
    - Skips empty bins (no trades in the window) so the output bar grid
      contains only bins with at least one trade.
    - Routes every (price, size, side) tuple into a per-tick bucket
      (`price_volume` / `price_delta`) keyed on `round(price / TICK_SIZE)`.

    Full RTH coverage with one trade per minute yields 390 × 1m bars,
    26 × 15m bars, and 7 × 1h bars (including a 30-minute final hour bucket).
    """
    if session not in ("rth", "globex"):
        raise ValueError(f"Unknown session {session!r} (use 'rth' or 'globex').")
    if bin_ns <= 0:
        raise ValueError(f"bin_ns must be positive, got {bin_ns}")

    rth_open_ns, rth_close_ns = _rth_window_ns(session_date)

    bars: list[Bar] = []
    cur: Bar | None = None
    cur_bin_ns = -1

    for t in trades:
        if t.instrument_id != front_month_id:
            continue
        if session == "rth":
            if t.ts_event_ns < rth_open_ns or t.ts_event_ns >= rth_close_ns:
                continue
            bin_ns_start = rth_open_ns + (
                (t.ts_event_ns - rth_open_ns) // bin_ns
            ) * bin_ns
        else:
            bin_ns_start = (t.ts_event_ns // bin_ns) * bin_ns

        if bin_ns_start != cur_bin_ns:
            if cur is not None:
                bars.append(cur)
            cur = Bar(
                open=t.price, high=t.price, low=t.price, close=t.price,
                bin_start_ns=bin_ns_start,
                high_first_ns=t.ts_event_ns,
                low_first_ns=t.ts_event_ns,
            )
            cur_bin_ns = bin_ns_start

        # Update OHLCV
        cur.close = t.price
        if t.price > cur.high:
            cur.high = t.price
            cur.high_first_ns = t.ts_event_ns
        if t.price < cur.low:
            cur.low = t.price
            cur.low_first_ns = t.ts_event_ns
        cur.volume += t.size
        signed = _signed_size(t.side, t.size)
        cur.delta += signed
        cur.trade_count += 1
        if t.side == "A":
            cur.aggressive_buy_count += 1
            cur.sum_aggressive_buy_size += t.size
        elif t.side == "B":
            cur.aggressive_sell_count += 1
            cur.sum_aggressive_sell_size += t.size
        if t.size >= large_print_threshold:
            cur.large_print_count += 1

        # Per-tick accumulation. ES tick == 0.25, so round() against
        # TICK_SIZE collapses 4500.25 / 4500.50 / 4500.75 etc. into
        # successive integer buckets. The integer key is what we persist
        # in bar_volume_profile.price_tick — readers recover the price as
        # price_tick * TICK_SIZE.
        price_tick = round(t.price / TICK_SIZE)
        cur.price_volume[price_tick] = cur.price_volume.get(price_tick, 0) + t.size
        if signed != 0:
            cur.price_delta[price_tick] = cur.price_delta.get(price_tick, 0) + signed

    if cur is not None:
        bars.append(cur)

    rc = rth_close_ns if session == "rth" else None
    for b in bars:
        b.bar_end_ns = session_bar_end_ns(b.bin_start_ns, bin_ns, session=session, rth_close_ns=rc)

    # Phase 6: stamp running session VWAP after bars are finalized (trade
    # filtering already enforced RTH bounds).
    _stamp_session_vwap(bars)
    _stamp_session_cvd(bars)
    _stamp_phat_features(bars)

    return AggregateResult(
        bars=bars,
        front_month_id=front_month_id,
        session=session,
        session_date=session_date,
        session_start_ns=rth_open_ns if session == "rth" else None,
        session_end_ns=rth_close_ns if session == "rth" else None,
        bin_ns=bin_ns,
        timeframe=timeframe,
    )
