from __future__ import annotations

import json
import warnings
from pathlib import Path

import pytest

from orderflow_pipeline.strategy_json import (
    SUPPORTED_STRATEGY_CONFIG_VERSION,
    clear_strategy_config_cache,
    load_strategy_document,
    validate_strategy_document,
)


def test_validate_default_repo_strategy_defaults() -> None:
    root = Path(__file__).resolve().parents[2]
    p = root / "config" / "strategy_defaults.json"
    if not p.exists():
        pytest.skip("config/strategy_defaults.json not present")
    doc = json.loads(p.read_text(encoding="utf-8"))
    assert validate_strategy_document(doc) == []


def test_validate_profile_files() -> None:
    root = Path(__file__).resolve().parents[2]
    prof = root / "config" / "profiles"
    if not prof.is_dir():
        pytest.skip("config/profiles not present")
    for path in sorted(prof.glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        assert validate_strategy_document(doc) == [], path


def test_validate_unknown_watch_id() -> None:
    doc = {
        "version": 1,
        "timeframes": {
            "1m": {
                "watch_exit_ticks": {
                    "notAWatch": {"stop_loss_ticks": 4},
                },
            },
        },
    }
    errs = validate_strategy_document(doc)
    assert any("unknown watch_id" in e for e in errs)


def test_validate_unknown_timeframe_key() -> None:
    doc = {"version": 1, "timeframes": {"5m": {}}}
    errs = validate_strategy_document(doc)
    assert any("unknown timeframe key" in e for e in errs)


def test_version_newer_than_supported_warns(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "v.json"
    p.write_text(
        json.dumps({"version": SUPPORTED_STRATEGY_CONFIG_VERSION + 9, "timeframes": {}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("ORDERFLOW_STRATEGY_CONFIG", str(p))
    clear_strategy_config_cache()
    try:
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            load_strategy_document()
        assert any("newer than supported" in str(x.message) for x in w)
    finally:
        monkeypatch.delenv("ORDERFLOW_STRATEGY_CONFIG", raising=False)
        clear_strategy_config_cache()
