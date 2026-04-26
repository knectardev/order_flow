"""Aggregate filtered Trade records into 1-minute OHLCV+delta+microstructure bars.

Bar schema (matches `orderflow_dashboard.html`'s `generateBar` output plus
three additive microstructure fields used by the depth-proxy in §4.5 of
the plan):

    {
        "open":            float,
        "high":            float,
        "low":             float,
        "close":            float,
        "volume":           int,    # sum of trade.size
        "delta":            int,    # signed-volume aggressor delta
        "tradeCount":       int,    # number of trades in the bin
        "largePrintCount":  int,    # trades with size >= LARGE_PRINT_THRESHOLD
        "avgTradeSize":     float,  # volume / tradeCount
        "time":             str     # ISO-8601 UTC, bin-start ("...:31:00Z")
    }

Plan refs: §3.1, §3.3, §3.4, §3.6.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from typing import Iterable
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

    def to_json(self) -> dict:
        ts = datetime.fromtimestamp(self.bin_start_ns / 1e9, tz=UTC)
        avg_size = self.volume / self.trade_count if self.trade_count else 0.0
        return {
            "open": round(self.open, 4),
            "high": round(self.high, 4),
            "low": round(self.low, 4),
            "close": round(self.close, 4),
            "volume": self.volume,
            "delta": self.delta,
            "tradeCount": self.trade_count,
            "largePrintCount": self.large_print_count,
            "avgTradeSize": round(avg_size, 3),
            "time": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
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
        cur.delta += _signed_size(t.side, t.size)
        cur.trade_count += 1
        if t.size >= large_print_threshold:
            cur.large_print_count += 1

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
