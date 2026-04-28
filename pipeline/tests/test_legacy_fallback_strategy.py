from __future__ import annotations

from datetime import datetime, timedelta

from orderflow_pipeline.backtest_engine import BacktestEngine
from orderflow_pipeline.strategies.legacy_fallback_logic import (
    LegacyFallbackConfig,
    config_for_timeframe,
    derive_fires_from_bars,
)


def _bars(n: int = 80) -> list[dict]:
    start = datetime(2026, 1, 26, 14, 30)
    out: list[dict] = []
    price = 7150.0
    for i in range(n):
        drift = 0.35 if (i % 11) < 6 else -0.28
        wiggle = ((i * 7) % 9 - 4) * 0.05
        open_ = price
        close = price + drift + wiggle
        high = max(open_, close) + 0.25 + ((i % 5) * 0.03)
        low = min(open_, close) - 0.25 - (((i + 2) % 4) * 0.03)
        vol = 120 + (i % 13) * 9 + (50 if i % 17 == 0 else 0)
        out.append(
            {
                "bar_time": start + timedelta(minutes=i),
                "open": round(open_, 6),
                "high": round(high, 6),
                "low": round(low, 6),
                "close": round(close, 6),
                "volume": float(vol),
            }
        )
        price = close
    return out


def test_legacy_strategy_matches_existing_fallback_regime_on() -> None:
    bars = _bars()
    legacy = derive_fires_from_bars(
        bars,
        watch_ids={"valueEdgeReject", "fade", "breakout", "absorptionWall"},
        config=LegacyFallbackConfig(use_regime_filter=True),
    )
    current = BacktestEngine._derive_fires_from_bars(
        bars,
        "1m",
        watch_ids={"valueEdgeReject", "fade", "breakout", "absorptionWall"},
        use_regime_filter=True,
    )
    assert legacy == current


def test_legacy_strategy_matches_existing_fallback_regime_off() -> None:
    bars = _bars()
    legacy = derive_fires_from_bars(
        bars,
        watch_ids={"valueEdgeReject"},
        config=LegacyFallbackConfig(use_regime_filter=False),
    )
    current = BacktestEngine._derive_fires_from_bars(
        bars,
        "1m",
        watch_ids={"valueEdgeReject"},
        use_regime_filter=False,
    )
    assert legacy == current


def test_timeframe_specific_config_generates_on_1h() -> None:
    bars = _bars(40)
    fires = derive_fires_from_bars(
        bars,
        watch_ids={"breakout", "fade", "absorptionWall", "valueEdgeReject"},
        config=config_for_timeframe("1h", use_regime_filter=True),
    )
    assert len(fires) > 0

