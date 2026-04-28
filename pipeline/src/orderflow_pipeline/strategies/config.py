"""Shared configuration for locked legacy fallback strategies."""
from __future__ import annotations

from dataclasses import dataclass


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


def config_for_timeframe(timeframe: str, *, use_regime_filter: bool = True) -> LegacyFallbackConfig:
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
