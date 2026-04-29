"""Optional JSON overrides for legacy fallback strategy parameters.

Resolved path (first hit):
1. Environment variable ``ORDERFLOW_STRATEGY_CONFIG`` (absolute or cwd-relative path)
2. ``<repo_root>/config/strategy_defaults.json``

``repo_root`` is three parents above this file
(``pipeline/src/orderflow_pipeline/strategy_json.py`` -> repository root).

Missing file => empty overlay (code defaults only). Contents are cached until
``clear_strategy_config_cache()`` is called (e.g. in tests).
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any


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
    return _load_document_cached(str(path.resolve()), int(st.st_mtime_ns))


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
