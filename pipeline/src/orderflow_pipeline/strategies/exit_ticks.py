"""Resolve stop-loss / take-profit tick distances for backtest execution."""
from __future__ import annotations

from .config import config_for_timeframe


def resolve_exit_ticks(
    timeframe: str,
    watch_id: str,
    *,
    broker_stop_loss_ticks: float | None,
    broker_take_profit_ticks: float | None,
) -> tuple[float | None, float | None]:
    """Resolve SL/TP distances in ticks.

    If either broker-level tick field is non-None, treat ``BrokerConfig`` as a
    run-wide override (whole run uses exactly those tick distances).

    Otherwise merge timeframe defaults from ``config_for_timeframe`` with optional
    per-watch overrides on that config.
    """
    if broker_stop_loss_ticks is not None or broker_take_profit_ticks is not None:
        return broker_stop_loss_ticks, broker_take_profit_ticks

    cfg = config_for_timeframe(timeframe)
    sl = cfg.stop_loss_ticks
    tp = cfg.take_profit_ticks
    for wid, wt in cfg.watch_exit_ticks:
        if wid != watch_id:
            continue
        if wt.stop_loss_ticks is not None:
            sl = wt.stop_loss_ticks
        if wt.take_profit_ticks is not None:
            tp = wt.take_profit_ticks
        break
    return sl, tp
