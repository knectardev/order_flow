"""Aggregate filtered Trade records into 1-minute OHLCV+delta+microstructure bars.

Bar schema (matches `orderflow_dashboard.html`'s `generateBar` output plus
microstructure fields used by the depth-proxy in §4.5 of the original plan
AND the data-driven regime classifier introduced in the regime-DB plan
(`vpt`, `concentration`, `distinct_prices`, plus the per-tick volume/delta
breakdown persisted to `bar_volume_profile`):

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
    }

Per-tick breakdown is exposed via Bar.iter_profile_rows() and routed to the
DuckDB `bar_volume_profile` table by the CLI; it is NOT serialized to JSON
(the JSON-mode dashboard uses the OHLC-distribution proxy in
src/analytics/profile.js).

Plan refs:
    original integration plan §3.1, §3.3, §3.4, §3.6
    regime-DB plan §1b (price_tick keying, vpt/concentration anti-jitter rounding)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from typing import Iterable, Iterator
from zoneinfo import ZoneInfo

from .decode import Trade


# Default cutoff for "large print" on ES (institutional/block-ish). The
# dashboard reads this from the JSON `tunings` block, so production tuning
# is data-side, not code-side.
DEFAULT_LARGE_PRINT_THRESHOLD = 50

NS_PER_MINUTE = 60 * 1_000_000_000

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
    bin_start_ns: int = 0   # nanoseconds since epoch, bin-aligned
    # Per-tick microstructure. Keyed on integer `round(price / TICK_SIZE)`;
    # not exposed to JSON (large + only meaningful in DB form), but
    # consumed by both `to_dict()` (for the bar-level vpt / concentration
    # scalars) and `iter_profile_rows()` (for the bar_volume_profile rows).
    price_volume: dict[int, int] = field(default_factory=dict)
    price_delta:  dict[int, int] = field(default_factory=dict)
    # Phase 2 regime classifier output (regime-DB plan §2c). Populated by
    # `regime.compute_ranks` after aggregation completes; left as None for
    # the warmup window (first 30 bars per session) and zero-volume bars.
    # The same already-rounded values flow into both writers (JSON via
    # to_json; DuckDB via to_dict) so the Phase-1e equivalence gate run
    # with --phase 2 cannot fail on serialization noise.
    range_pct: float | None = None
    v_rank: int | None = None
    d_rank: int | None = None

    @property
    def distinct_prices(self) -> int:
        return len(self.price_volume)

    @property
    def modal_volume(self) -> int:
        return max(self.price_volume.values()) if self.price_volume else 0

    def _vpt_concentration(self) -> tuple[float, float]:
        """Compute (vpt, concentration) rounded to 6 decimals.

        Anti-jitter contract (regime-DB plan §1b/§1e): both writers (JSON
        serializer and DuckDB writer) consume the same already-rounded
        scalar so the Phase-1e `verify_phase1.py` `1e-9` equality gate
        cannot fail on serialization noise — a mismatch there will only
        flag real aggregator drift.

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

    def _iso_time(self) -> str:
        return datetime.fromtimestamp(self.bin_start_ns / 1e9, tz=UTC).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )

    def to_json(self) -> dict:
        """JSON-mode serialization (dashboard via data/bars/*.json).

        Matches the original prototype shape PLUS the three microstructure
        fields the data-driven regime classifier needs (`distinctPrices`,
        `vpt`, `concentration`), plus the Phase-2 regime ranks (`range_pct`,
        `v_rank`, `d_rank`) so the Phase-1e gate run with `--phase 2` has
        the same fields on both paths. Per-tick breakdown is intentionally
        omitted — the JSON dashboard uses an OHLC-distribution proxy until
        Phase 2f retires it.
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
            # rangePct is already rounded to 6 decimals in regime.py; pass
            # through unchanged so JSON and DuckDB ingest the same scalar.
            # vRank / dRank are integers in {1..5} or None during warmup.
            # camelCase matches the rest of the JSON shape (tradeCount,
            # largePrintCount, distinctPrices) and the API endpoint output;
            # `verify_phase1.py --phase 2` reads the camelCase keys.
            "rangePct":        self.range_pct,
            "vRank":           self.v_rank,
            "dRank":           self.d_rank,
            "time":            self._iso_time(),
        }

    def to_dict(self, session_date: date) -> dict:
        """DuckDB-mode row dict (column names = bars table column names).

        Returned by AggregateResult.bars_dataframe_rows() and consumed by
        db.write_session(). `bar_time` is a stdlib datetime so DuckDB's
        DataFrame zero-copy ingest preserves microsecond precision.

        `range_pct` / `v_rank` / `d_rank` are populated by
        `regime.compute_ranks` after aggregation; the CLI calls it once per
        session and stamps the results back onto each Bar before either
        writer fires (regime-DB plan §2c). Pre-rank dicts (i.e. when called
        before compute_ranks) carry the dataclass defaults (None).
        """
        vpt, concentration = self._vpt_concentration()
        return {
            "session_date":      session_date,
            "bar_time":          datetime.fromtimestamp(self.bin_start_ns / 1e9, tz=UTC).replace(tzinfo=None),
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
        }

    def iter_profile_rows(self) -> Iterator[dict]:
        """Yield one row per (price_tick) for `bar_volume_profile` insertion.

        Skips ticks with zero volume (shouldn't happen in practice — every
        key in `price_volume` was created on a non-zero `size += t.size`,
        so every bucket has volume >= 1). The signed-delta bucket is
        looked up by the same key; if a tick saw only `side='N'` trades,
        delta will be 0 (still emitted, since per-tick volume is real).
        """
        bar_time = datetime.fromtimestamp(self.bin_start_ns / 1e9, tz=UTC).replace(
            tzinfo=None
        )
        for price_tick, vol in self.price_volume.items():
            if vol <= 0:
                continue
            yield {
                "bar_time":   bar_time,
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


def _rth_window_ns(session_date: date) -> tuple[int, int]:
    """Return [open_ns, close_ns) for the RTH session of `session_date` in ET."""
    start_et = datetime.combine(session_date, RTH_OPEN, tzinfo=ET)
    end_et = datetime.combine(session_date, RTH_CLOSE, tzinfo=ET)
    return (
        int(start_et.astimezone(UTC).timestamp() * 1e9),
        int(end_et.astimezone(UTC).timestamp() * 1e9),
    )


def _signed_size(side: str, size: int) -> int:
    """Plan §3.1: A=+size, B=-size, N=0 (volume yes, delta no)."""
    if side == "A":
        return size
    if side == "B":
        return -size
    return 0


def aggregate_trades(
    trades: Iterable[Trade],
    *,
    front_month_id: int,
    session_date: date,
    session: str = "rth",
    large_print_threshold: int = DEFAULT_LARGE_PRINT_THRESHOLD,
) -> AggregateResult:
    """Bin a stream of trades into 1-minute bars for one session.

    - Drops any trade whose `instrument_id != front_month_id` (filters out
      spreads + back months).
    - If `session == 'rth'`, drops trades outside 09:30-16:00 ET on
      `session_date`.
    - Skips empty minutes per plan §3.4.
    - Routes every (price, size, side) tuple into a per-tick bucket
      (`price_volume` / `price_delta`) keyed on `round(price / TICK_SIZE)`.
      The bar-level OHLCV+delta loop is unchanged; per-tick accumulation is
      in the same loop iteration so we never re-walk the trade stream.
    """
    if session not in ("rth", "globex"):
        raise ValueError(f"Unknown session {session!r} (use 'rth' or 'globex').")

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

        bin_ns = (t.ts_event_ns // NS_PER_MINUTE) * NS_PER_MINUTE

        if bin_ns != cur_bin_ns:
            if cur is not None:
                bars.append(cur)
            cur = Bar(
                open=t.price, high=t.price, low=t.price, close=t.price,
                bin_start_ns=bin_ns,
            )
            cur_bin_ns = bin_ns

        # Update OHLCV
        cur.close = t.price
        if t.price > cur.high:
            cur.high = t.price
        if t.price < cur.low:
            cur.low = t.price
        cur.volume += t.size
        signed = _signed_size(t.side, t.size)
        cur.delta += signed
        cur.trade_count += 1
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

    return AggregateResult(
        bars=bars,
        front_month_id=front_month_id,
        session=session,
        session_date=session_date,
        session_start_ns=rth_open_ns if session == "rth" else None,
        session_end_ns=rth_close_ns if session == "rth" else None,
    )
