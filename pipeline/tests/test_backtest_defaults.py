from __future__ import annotations

import json
from pathlib import Path

import pytest

from orderflow_pipeline.backtest_defaults import (
    clear_backtest_defaults_cache,
    merged_broker_config_from_request_payload,
)
from orderflow_pipeline.backtest_engine import BrokerConfig


def test_merged_overlay_respects_exclude_unset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Explicit body fields beat JSON; omitted fields keep JSON/custom file values."""

    monkeypatch.chdir(tmp_path)

    cfg = {
        "version": 1,
        "initial_capital": 111111,
        "qty": 9,
        "slippage_ticks": 9,
        "commission_per_side": 9,
        "tick_size": 0.31,
        "point_value": 49,
        "stop_loss_ticks": None,
        "take_profit_ticks": None,
    }
    bespoke = tmp_path / "bt.json"
    bespoke.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setenv("ORDERFLOW_BACKTEST_CONFIG", str(bespoke))
    clear_backtest_defaults_cache()

    only_commission = merged_broker_config_from_request_payload(
        {"commission_per_side": 2.75},
    )
    assert only_commission == BrokerConfig(
        initial_capital=float(cfg["initial_capital"]),
        qty=int(cfg["qty"]),
        slippage_ticks=float(cfg["slippage_ticks"]),
        commission_per_side=2.75,
        tick_size=float(cfg["tick_size"]),
        point_value=float(cfg["point_value"]),
        stop_loss_ticks=None,
        take_profit_ticks=None,
    )

    clear_backtest_defaults_cache()
    monkeypatch.delenv("ORDERFLOW_BACKTEST_CONFIG", raising=False)


def test_explicit_null_fee_fields_do_not_wipe_optional_sl_tp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    bespoke = tmp_path / "bt.json"
    bespoke.write_text(
        json.dumps(
            {
                "version": 1,
                "initial_capital": 50000,
                "qty": 1,
                "slippage_ticks": 1,
                "commission_per_side": 1,
                "tick_size": 0.25,
                "point_value": 50,
                "stop_loss_ticks": None,
                "take_profit_ticks": None,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ORDERFLOW_BACKTEST_CONFIG", str(bespoke))
    clear_backtest_defaults_cache()

    overlay = merged_broker_config_from_request_payload(
        {
            "initial_capital": None,
            "stop_loss_ticks": 4,
            "take_profit_ticks": None,
        }
    )

    assert overlay.initial_capital == 50000.0
    assert overlay.stop_loss_ticks == 4.0
    assert overlay.take_profit_ticks is None

    clear_backtest_defaults_cache()