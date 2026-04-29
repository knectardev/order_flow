"""Shared configuration for locked legacy fallback strategies."""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from ..strategy_json import get_timeframe_overlay


@dataclass(frozen=True, slots=True)
class WatchExitTicks:
    """Per-watch SL/TP overrides; ``None`` on a field inherits timeframe defaults."""

    stop_loss_ticks: float | None = None
    take_profit_ticks: float | None = None


@dataclass(frozen=True, slots=True)
class LegacyFallbackConfig:
    use_regime_filter: bool = True
    cooldown_bars: int = 4
    min_bars: int = 20
    lookback_bars: int = 10
    warmup_start: int = 12
    # Backtest SL/TP defaults (ticks); None => flip-only unless BrokerConfig overrides.
    stop_loss_ticks: float | None = None
    take_profit_ticks: float | None = None
    watch_exit_ticks: tuple[tuple[str, WatchExitTicks], ...] = ()


def _opt_float(v: Any) -> float | None:
    if v is None:
        return None
    return float(v)


def _parse_watch_exit_ticks(obj: Any) -> tuple[tuple[str, WatchExitTicks], ...]:
    if not obj or not isinstance(obj, dict):
        return ()
    out: list[tuple[str, WatchExitTicks]] = []
    for wid, body in obj.items():
        if not isinstance(body, dict):
            continue
        out.append(
            (
                str(wid),
                WatchExitTicks(
                    stop_loss_ticks=_opt_float(body.get("stop_loss_ticks")),
                    take_profit_ticks=_opt_float(body.get("take_profit_ticks")),
                ),
            )
        )
    return tuple(out)


def _apply_timeframe_json_overlay(cfg: LegacyFallbackConfig, timeframe: str) -> LegacyFallbackConfig:
    """Merge ``config/strategy_defaults.json`` (or ``ORDERFLOW_STRATEGY_CONFIG``) per timeframe."""
    o = get_timeframe_overlay(timeframe)
    if not o:
        return cfg
    kwargs: dict[str, Any] = {}
    for k in ("cooldown_bars", "min_bars", "lookback_bars", "warmup_start"):
        if k in o:
            kwargs[k] = int(o[k])
    for k in ("stop_loss_ticks", "take_profit_ticks"):
        if k in o:
            v = o[k]
            kwargs[k] = None if v is None else float(v)
    if "watch_exit_ticks" in o:
        kwargs["watch_exit_ticks"] = _parse_watch_exit_ticks(o["watch_exit_ticks"])
    return replace(cfg, **kwargs) if kwargs else cfg


def _base_legacy_config(timeframe: str, *, use_regime_filter: bool) -> LegacyFallbackConfig:
    tf = (timeframe or "1m").strip()
    if tf == "15m":
        return LegacyFallbackConfig(
            use_regime_filter=use_regime_filter,
            cooldown_bars=2,
            min_bars=12,
            lookback_bars=6,
            warmup_start=8,
            stop_loss_ticks=None,
            take_profit_ticks=None,
            watch_exit_ticks=(),
        )
    if tf == "1h":
        return LegacyFallbackConfig(
            use_regime_filter=use_regime_filter,
            cooldown_bars=1,
            min_bars=4,
            lookback_bars=3,
            warmup_start=3,
            stop_loss_ticks=None,
            take_profit_ticks=None,
            watch_exit_ticks=(),
        )
    return LegacyFallbackConfig(use_regime_filter=use_regime_filter)


def config_for_timeframe(timeframe: str, *, use_regime_filter: bool = True) -> LegacyFallbackConfig:
    tf = (timeframe or "1m").strip()
    base = _base_legacy_config(tf, use_regime_filter=use_regime_filter)
    return _apply_timeframe_json_overlay(base, tf)
