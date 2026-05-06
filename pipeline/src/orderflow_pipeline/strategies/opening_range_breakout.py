"""Opening range breakout (ORB) — runtime-derived 5m experiment watch (`orb`).

Hardcoded rules (not strategy_defaults.json):
- Session opening range = high/low over bars intersecting 09:30-09:45 ET.
- Entry model = break -> retest -> confirm.
  - Long: after a break above OR high, a later bar must retest OR high
    (low <= OR high) and close back above OR high.
  - Short symmetric around OR low.
- Signals emit at confirmation-bar close (not wick extreme).
- Pending breakouts expire if retest confirmation does not occur within N bars.
- Pending long (short) setup invalidates on meaningful breach of opposite OR side.
- Retest reclaim uses a 1-tick tolerance around OR boundary.
- Breakout search is limited to the first 18 five-minute bars after OR finalization (~90m).
- Confirmation must occur by 11:45 ET.
- Regime gate passes when either breakout bar or confirmation bar is in allowed cells.
- At most one ORB direction per session (first confirmed side locks session).
- No new signals when local bar time is 12:00 ET or later.

Backtest stop sizing: template ticks from JSON may be floored by structural distance
(below OR low for longs / above OR high for shorts) plus a small buffer — see
``backtest_engine._orb_structure_sl_floor_ticks``.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

_ET = ZoneInfo("America/New_York")

ORB_WATCH_ID = "orb"
ORB_ALLOWED_RANK_CELLS: frozenset[tuple[int, int]] = frozenset({(3, 2), (3, 3), (4, 2), (4, 3)})
_OR_START_MIN = 9 * 60 + 30
_OR_END_MIN = 9 * 60 + 45
_ORB_TICK_SIZE = 0.25
_RETEST_MAX_BARS = 6
_RECLAIM_TOL_TICKS = 1.0
_BREAK_SEARCH_MAX_BARS_AFTER_OR = 18
_CONFIRM_LAST_MIN = 11 * 60 + 45


def _session_key(bar: dict) -> date | None:
    sd = bar.get("session_date")
    if sd is None:
        bt = bar.get("bar_time")
        if isinstance(bt, datetime):
            return bt.date()
        return None
    if isinstance(sd, datetime):
        return sd.date()
    return sd


def _bar_time_et(bar_time: datetime) -> datetime:
    if bar_time.tzinfo is None:
        bar_time = bar_time.replace(tzinfo=timezone.utc)
    return bar_time.astimezone(_ET)


def _et_minutes(bar_time: datetime) -> int:
    et = _bar_time_et(bar_time)
    return int(et.hour) * 60 + int(et.minute)


def _bar_intersects_or_window(bar_time: datetime) -> bool:
    """True when [bar_open, bar_open+5m) intersects [09:30,09:45) ET."""
    t0 = _et_minutes(bar_time)
    dur_min = 5
    return t0 < _OR_END_MIN and (t0 + dur_min) > _OR_START_MIN


def orb_entry_allowed_by_time(bar_time: datetime) -> bool:
    """False when local ET wall clock is 12:00 or later."""
    et = _bar_time_et(bar_time)
    return et.hour < 12


def _confirm_allowed_by_time(bar_time: datetime) -> bool:
    """False when local ET wall clock is after 11:00 (ORB becomes stale)."""
    return _et_minutes(bar_time) <= _CONFIRM_LAST_MIN


def _rank_gate(bar: dict) -> bool:
    vr = bar.get("v_rank")
    dr = bar.get("d_rank")
    if vr is None or dr is None:
        return False
    try:
        cell = (int(vr), int(dr))
    except (TypeError, ValueError):
        return False
    return cell in ORB_ALLOWED_RANK_CELLS


def try_emit_opening_range_breakout(
    *,
    i: int,
    timeframe: str,
    watch_ids: set[str] | None,
    bars: list[dict],
    emit: Callable[..., None],
    orb_state: dict[Any, dict[str, Any]],
    use_regime_filter: bool = True,
) -> None:
    """Evaluate ORB on bar index ``i``; mutates ``orb_state`` per session key."""
    tf = (timeframe or "").strip()
    if tf != "5m":
        return
    if watch_ids is not None and ORB_WATCH_ID not in watch_ids:
        return

    bar = bars[i]
    session_date = _session_key(bar)
    if session_date is None:
        return

    bt = bar["bar_time"]
    if not isinstance(bt, datetime):
        return
    high = float(bar["high"])
    low = float(bar["low"])

    st = orb_state.get(session_date)
    if st is None:
        st = {
            "or_high": high if _bar_intersects_or_window(bt) else None,
            "or_low": low if _bar_intersects_or_window(bt) else None,
            "or_finalized": False,
            "or_last_idx": i if _bar_intersects_or_window(bt) else None,
            "long_break_idx": None,
            "long_break_rank_ok": False,
            "short_break_idx": None,
            "short_break_rank_ok": False,
            "direction_lock": None,
        }
        orb_state[session_date] = st
    elif not st["or_finalized"] and _bar_intersects_or_window(bt):
        st["or_high"] = high if st["or_high"] is None else max(float(st["or_high"]), high)
        st["or_low"] = low if st["or_low"] is None else min(float(st["or_low"]), low)
        st["or_last_idx"] = i

    # OR box is finalized on first bar that no longer intersects 9:30-9:45 ET.
    if not st["or_finalized"] and not _bar_intersects_or_window(bt):
        if st["or_high"] is not None and st["or_low"] is not None and st["or_last_idx"] is not None:
            st["or_finalized"] = True
        else:
            return

    if not st["or_finalized"]:
        return

    if st["direction_lock"] is not None:
        return

    or_high = float(st["or_high"])
    or_low = float(st["or_low"])
    tol_px = float(_RECLAIM_TOL_TICKS) * float(_ORB_TICK_SIZE)
    or_last_idx = int(st["or_last_idx"])
    if i <= or_last_idx:
        return

    if not orb_entry_allowed_by_time(bt):
        return
    if not _confirm_allowed_by_time(bt):
        return

    # Long side: break above OR high, then later retest-and-hold confirmation.
    long_break_idx = st["long_break_idx"]
    long_reset_this_bar = False
    if long_break_idx is not None:
        bars_since_break = int(i) - int(long_break_idx)
        # Stale setup: breakout did not retest/confirm quickly enough.
        if bars_since_break > _RETEST_MAX_BARS:
            st["long_break_idx"] = None
            st["long_break_rank_ok"] = False
            long_break_idx = None
            long_reset_this_bar = True
        # Opposite-side breach invalidates pending long setup.
        elif low <= (or_low - tol_px):
            st["long_break_idx"] = None
            st["long_break_rank_ok"] = False
            long_break_idx = None
            long_reset_this_bar = True
    if long_break_idx is None and not long_reset_this_bar and high > or_high:
        if (i - or_last_idx) > _BREAK_SEARCH_MAX_BARS_AFTER_OR:
            # Ignore late breakouts that are detached from the opening range narrative.
            pass
        else:
            st["long_break_idx"] = i
            st["long_break_rank_ok"] = _rank_gate(bar)
    elif long_break_idx is not None and i > int(long_break_idx):
        close = float(bar["close"])
        long_confirm = low <= (or_high + tol_px) and close >= (or_high - tol_px)
        rank_ok = (not use_regime_filter) or _rank_gate(bar) or bool(st.get("long_break_rank_ok"))
        if long_confirm and rank_ok:
            st["direction_lock"] = "up"
            emit(
                ORB_WATCH_ID,
                "up",
                close,
                i,
                diagnostics={
                    "strategy": "opening_range_breakout",
                    "session_date": session_date.isoformat(),
                    "or_high": or_high,
                    "or_low": or_low,
                    "breakout": "long",
                    "break_index": int(long_break_idx),
                    "confirm_index": i,
                    "entry_model": "break_retest_confirm",
                    "price_basis": "confirm_close",
                    "retest_max_bars": int(_RETEST_MAX_BARS),
                    "reclaim_tolerance_ticks": float(_RECLAIM_TOL_TICKS),
                    "diagnosticVersion": "v4",
                },
            )
            return

    # Short side: break below OR low, then later retest-and-fail confirmation.
    short_break_idx = st["short_break_idx"]
    short_reset_this_bar = False
    if short_break_idx is not None:
        bars_since_break = int(i) - int(short_break_idx)
        if bars_since_break > _RETEST_MAX_BARS:
            st["short_break_idx"] = None
            st["short_break_rank_ok"] = False
            short_break_idx = None
            short_reset_this_bar = True
        elif high >= (or_high + tol_px):
            st["short_break_idx"] = None
            st["short_break_rank_ok"] = False
            short_break_idx = None
            short_reset_this_bar = True
    if short_break_idx is None and not short_reset_this_bar and low < or_low:
        if (i - or_last_idx) > _BREAK_SEARCH_MAX_BARS_AFTER_OR:
            pass
        else:
            st["short_break_idx"] = i
            st["short_break_rank_ok"] = _rank_gate(bar)
    elif short_break_idx is not None and i > int(short_break_idx):
        close = float(bar["close"])
        short_confirm = high >= (or_low - tol_px) and close <= (or_low + tol_px)
        rank_ok = (not use_regime_filter) or _rank_gate(bar) or bool(st.get("short_break_rank_ok"))
        if short_confirm and rank_ok:
            st["direction_lock"] = "down"
            emit(
                ORB_WATCH_ID,
                "down",
                close,
                i,
                diagnostics={
                    "strategy": "opening_range_breakout",
                    "session_date": session_date.isoformat(),
                    "or_high": or_high,
                    "or_low": or_low,
                    "breakout": "short",
                    "break_index": int(short_break_idx),
                    "confirm_index": i,
                    "entry_model": "break_retest_confirm",
                    "price_basis": "confirm_close",
                    "retest_max_bars": int(_RETEST_MAX_BARS),
                    "reclaim_tolerance_ticks": float(_RECLAIM_TOL_TICKS),
                    "break_search_max_bars_after_or": int(_BREAK_SEARCH_MAX_BARS_AFTER_OR),
                    "confirm_last_min_et": int(_CONFIRM_LAST_MIN),
                    "diagnosticVersion": "v4",
                },
            )
