from __future__ import annotations

import json
from pathlib import Path

import pytest

from orderflow_pipeline.strategy_json import clear_strategy_config_cache
from orderflow_pipeline.strategies.config import config_for_timeframe


def test_json_overlay_overrides_cooldown(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "custom.json"
    p.write_text(
        json.dumps(
            {
                "version": 1,
                "timeframes": {
                    "1m": {
                        "cooldown_bars": 99,
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ORDERFLOW_STRATEGY_CONFIG", str(p))
    clear_strategy_config_cache()
    try:
        cfg = config_for_timeframe("1m", use_regime_filter=True)
        assert cfg.cooldown_bars == 99
        # Other fields still from code base
        assert cfg.min_bars == 20
    finally:
        monkeypatch.delenv("ORDERFLOW_STRATEGY_CONFIG", raising=False)
        clear_strategy_config_cache()
