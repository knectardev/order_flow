"""Optional JSON overrides for legacy fallback strategy parameters.

Resolved path (first hit):
1. Environment variable ``ORDERFLOW_STRATEGY_CONFIG`` (absolute or cwd-relative path)
2. ``<repo_root>/config/strategy_defaults.json``

``repo_root`` is three parents above this file
(``pipeline/src/orderflow_pipeline/strategy_json.py`` -> repository root).

Missing file => empty overlay (code defaults only). Contents are cached until
``clear_strategy_config_cache()`` is called (e.g. in tests).

See ``docs/strategy-config.md`` for resolution order, allowed keys, and profiles.
"""
from __future__ import annotations

import json
import os
import warnings
from functools import lru_cache
from pathlib import Path
from typing import Any

SUPPORTED_STRATEGY_CONFIG_VERSION = 1

ALLOWED_TOP_LEVEL_KEYS = frozenset({"version", "_doc", "timeframes", "$schema"})
ALLOWED_TIMEFRAMES = frozenset({"1m", "15m", "1h"})
ALLOWED_TIMEFRAME_FIELD_KEYS = frozenset(
    {
        "cooldown_bars",
        "min_bars",
        "lookback_bars",
        "warmup_start",
        "stop_loss_ticks",
        "take_profit_ticks",
        "watch_exit_ticks",
    }
)
ALLOWED_WATCH_IDS = frozenset({"breakout", "fade", "absorptionWall", "valueEdgeReject"})
ALLOWED_WATCH_EXIT_FIELD_KEYS = frozenset({"stop_loss_ticks", "take_profit_ticks"})


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def default_strategy_config_path() -> Path:
    return _repo_root() / "config" / "strategy_defaults.json"


def resolve_strategy_config_path() -> Path | None:
    env = os.environ.get("ORDERFLOW_STRATEGY_CONFIG", "").strip()
    if env:
        p = Path(env)
        return p if p.is_absolute() else (Path.cwd() / p).resolve()
    p = default_strategy_config_path()
    return p if p.exists() else None


def _warn_on_version(raw: dict[str, Any]) -> None:
    v = raw.get("version", 1)
    if not isinstance(v, int):
        warnings.warn(
            f"strategy config: version should be int, got {type(v).__name__}",
            UserWarning,
            stacklevel=3,
        )
        return
    if v > SUPPORTED_STRATEGY_CONFIG_VERSION:
        warnings.warn(
            f"strategy config: version={v} is newer than supported "
            f"{SUPPORTED_STRATEGY_CONFIG_VERSION}; unknown keys may be ignored.",
            UserWarning,
            stacklevel=3,
        )


def _opt_number(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, bool):
        return False
    return isinstance(v, (int, float))


def validate_strategy_document(doc: dict[str, Any]) -> list[str]:
    """Return human-readable issues; empty list means no problems detected."""
    errs: list[str] = []
    if not doc:
        return errs
    for k in doc:
        if k in ALLOWED_TOP_LEVEL_KEYS or (isinstance(k, str) and k.startswith("_")):
            continue
        errs.append(f"unknown top-level key {k!r}")
    ver = doc.get("version", 1)
    if "version" in doc and not isinstance(ver, int):
        errs.append(f"version must be int, not {type(ver).__name__}")
    tfs = doc.get("timeframes")
    if tfs is None:
        return errs
    if not isinstance(tfs, dict):
        errs.append("timeframes must be an object")
        return errs
    for tf_key, block in tfs.items():
        if tf_key not in ALLOWED_TIMEFRAMES:
            errs.append(f"timeframes: unknown timeframe key {tf_key!r}")
            continue
        if not isinstance(block, dict):
            errs.append(f"timeframes.{tf_key} must be an object")
            continue
        for fk, fv in block.items():
            if isinstance(fk, str) and fk.startswith("_"):
                continue
            if fk not in ALLOWED_TIMEFRAME_FIELD_KEYS:
                errs.append(f"timeframes.{tf_key}: unknown field {fk!r}")
                continue
            if fk == "watch_exit_ticks":
                if fv is None:
                    continue
                if not isinstance(fv, dict):
                    errs.append(f"timeframes.{tf_key}.watch_exit_ticks must be object or null")
                    continue
                for wid, wbody in fv.items():
                    if not isinstance(wbody, dict):
                        errs.append(
                            f"timeframes.{tf_key}.watch_exit_ticks.{wid!r} must be an object"
                        )
                        continue
                    if wid not in ALLOWED_WATCH_IDS:
                        errs.append(
                            f"timeframes.{tf_key}.watch_exit_ticks: unknown watch_id {wid!r}"
                        )
                    for wk, wv in wbody.items():
                        if wk not in ALLOWED_WATCH_EXIT_FIELD_KEYS:
                            errs.append(
                                f"timeframes.{tf_key}.watch_exit_ticks.{wid}: unknown field {wk!r}"
                            )
                        elif not _opt_number(wv):
                            errs.append(
                                f"timeframes.{tf_key}.watch_exit_ticks.{wid}.{wk} must be number or null"
                            )
            elif fk in {"cooldown_bars", "min_bars", "lookback_bars", "warmup_start"}:
                if not isinstance(fv, int) or isinstance(fv, bool):
                    errs.append(f"timeframes.{tf_key}.{fk} must be a non-boolean int")
            elif fk in {"stop_loss_ticks", "take_profit_ticks"}:
                if not _opt_number(fv):
                    errs.append(f"timeframes.{tf_key}.{fk} must be number or null")
    return errs


@lru_cache(maxsize=4)
def _load_document_cached(path_str: str, mtime_ns: int) -> dict[str, Any]:
    del mtime_ns  # cache bust when file changes
    with open(path_str, encoding="utf-8") as f:
        raw = json.load(f)
    return raw if isinstance(raw, dict) else {}


def load_strategy_document() -> dict[str, Any]:
    path = resolve_strategy_config_path()
    if path is None:
        return {}
    try:
        st = path.stat()
    except OSError:
        return {}
    raw = _load_document_cached(str(path.resolve()), int(st.st_mtime_ns))
    _warn_on_version(raw)
    for err in validate_strategy_document(raw):
        warnings.warn(f"strategy config ({path}): {err}", UserWarning, stacklevel=2)
    return raw


def clear_strategy_config_cache() -> None:
    """Invalidate cached JSON (tests or hot-reload after file edit)."""
    _load_document_cached.cache_clear()


def normalize_timeframe_key(timeframe: str) -> str:
    return (timeframe or "1m").strip() or "1m"


def get_timeframe_overlay(timeframe: str) -> dict[str, Any]:
    """Return the ``timeframes.<tf>`` object from JSON, or {}."""
    doc = load_strategy_document()
    tfs = doc.get("timeframes")
    if not isinstance(tfs, dict):
        return {}
    key = normalize_timeframe_key(timeframe)
    block = tfs.get(key)
    return block if isinstance(block, dict) else {}
