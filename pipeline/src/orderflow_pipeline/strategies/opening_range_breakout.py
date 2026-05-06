"""Opening range breakout (ORB) — runtime-derived 5m experiment watch (`orb`).

Hardcoded rules (not strategy_defaults.json):
- Session opening range = high/low of the **first** bar of each ``session_date``.
- Long: first **later** bar (not the OR bar) with ``high > or_high``; Short symmetric with ``low < or_low``.
- At most one long and one short signal per session (first touch wins each side).
- Regime-style **rank gate** on the **signal bar** when ``use_regime_filter`` is **true** (from ``derive_fires_from_bars`` / backtest ``use_regime_filter``): ``(v_rank, d_rank)`` must be in {(3,2),(3,3),(4,2),(4,3)}. When **false**, the gate is skipped so compare **Regime filter OFF** can emit more ORB candidates from the same bar columns.
- No new signals when bar time is **12:00 ET or later** (America/New_York wall clock on ``bar_time``, UTC assumed if naive).
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

_ET = ZoneInfo("America/New_York")

ORB_WATCH_ID = "orb"
ORB_ALLOWED_RANK_CELLS: frozenset[tuple[int, int]] = frozenset({(3, 2), (3, 3), (4, 2), (4, 3)})


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


def orb_entry_allowed_by_time(bar_time: datetime) -> bool:
    """False when local ET wall clock is 12:00 or later."""
    et = _bar_time_et(bar_time)
    return et.hour < 12


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
        orb_state[session_date] = {
            "first_idx": i,
            "or_high": high,
            "or_low": low,
            "long_emitted": False,
            "short_emitted": False,
        }
        return

    first_idx = int(st["first_idx"])
    if i <= first_idx:
        return

    if not orb_entry_allowed_by_time(bt):
        return

    if use_regime_filter and not _rank_gate(bar):
        return

    or_high = float(st["or_high"])
    or_low = float(st["or_low"])

    if not st["long_emitted"] and high > or_high:
        st["long_emitted"] = True
        emit(
            ORB_WATCH_ID,
            "up",
            high,
            i,
            diagnostics={
                "strategy": "opening_range_breakout",
                "session_date": session_date.isoformat(),
                "or_high": or_high,
                "or_low": or_low,
                "breakout": "long",
                "bar_index": i,
                "diagnosticVersion": "v1",
            },
        )

    if not st["short_emitted"] and low < or_low:
        st["short_emitted"] = True
        emit(
            ORB_WATCH_ID,
            "down",
            low,
            i,
            diagnostics={
                "strategy": "opening_range_breakout",
                "session_date": session_date.isoformat(),
                "or_high": or_high,
                "or_low": or_low,
                "breakout": "short",
                "bar_index": i,
                "diagnosticVersion": "v1",
            },
        )
