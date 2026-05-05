"""Optional JSON defaults for simulated broker economics (API backtests).

Resolution (first hit):

1. Environment variable ``ORDERFLOW_BACKTEST_CONFIG`` (absolute or cwd-relative path)
2. ``<repo_root>/config/backtest_defaults.json``

Missing optional file falls back to :class:`~.backtest_engine.BrokerConfig` code defaults.
The JSON file is re-read from disk on every ``effective_broker_defaults()`` /
``load_backtest_defaults_document()`` call (small document; avoids stale
in-process caches when file ``mtime_ns`` ties across rapid saves on Windows).
Tests may still call ``clear_backtest_defaults_cache()`` — it is retained as a
harmless no-op after env swaps.

See ``docs/backtest-config.md``.
"""
from __future__ import annotations

import json
import os
import warnings
from pathlib import Path
from typing import Any

from .backtest_engine import BrokerConfig, ExecutionPolicy

SUPPORTED_BACKTEST_DEFAULTS_VERSION = 1

ALLOWED_TOP_KEYS = frozenset({"version", "_doc", "$schema"})
BROKER_FIELD_KEYS = (
    "initial_capital",
    "qty",
    "slippage_ticks",
    "commission_per_side",
    "tick_size",
    "point_value",
    "stop_loss_ticks",
    "take_profit_ticks",
)
EXECUTION_POLICY_BOOL_KEYS = (
    "ignore_same_side_fire_when_open",
    "flip_on_opposite_fire",
    "exit_on_stop_loss",
    "exit_on_take_profit",
    "close_at_end_of_window",
    "entry_next_bar_open",
)
EXECUTION_POLICY_OPTIONAL_FLOAT_KEYS = ("entry_gap_guard_max_ticks",)
EXECUTION_POLICY_FIELD_KEYS = EXECUTION_POLICY_BOOL_KEYS + EXECUTION_POLICY_OPTIONAL_FLOAT_KEYS


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def default_backtest_defaults_path() -> Path:
    return _repo_root() / "config" / "backtest_defaults.json"


def resolve_backtest_defaults_path() -> Path | None:
    """Return readable JSON path, or ``None`` if only code defaults apply."""
    env = os.environ.get("ORDERFLOW_BACKTEST_CONFIG", "").strip()
    if env:
        p = Path(env)
        resolved = p if p.is_absolute() else (Path.cwd() / p).resolve()
        if resolved.is_file():
            return resolved
        warnings.warn(
            f"ORDERFLOW_BACKTEST_CONFIG file not found ({resolved}); falling back to repo "
            "config/backtest_defaults.json if present, else BrokerConfig defaults.",
            UserWarning,
            stacklevel=2,
        )
    p = default_backtest_defaults_path()
    return p if p.is_file() else None


def resolve_backtest_defaults_path_str() -> str | None:
    p = resolve_backtest_defaults_path()
    return str(p.resolve()) if p is not None else None


def _hardcoded_fallback_broker_dict() -> dict[str, Any]:
    bc = BrokerConfig()
    return {
        "initial_capital": bc.initial_capital,
        "qty": bc.qty,
        "slippage_ticks": bc.slippage_ticks,
        "commission_per_side": bc.commission_per_side,
        "tick_size": bc.tick_size,
        "point_value": bc.point_value,
        "stop_loss_ticks": bc.stop_loss_ticks,
        "take_profit_ticks": bc.take_profit_ticks,
    }


def _hardcoded_execution_policy_dict() -> dict[str, Any]:
    p = ExecutionPolicy()
    return {
        "ignore_same_side_fire_when_open": p.ignore_same_side_fire_when_open,
        "flip_on_opposite_fire": p.flip_on_opposite_fire,
        "exit_on_stop_loss": p.exit_on_stop_loss,
        "exit_on_take_profit": p.exit_on_take_profit,
        "close_at_end_of_window": p.close_at_end_of_window,
        "entry_next_bar_open": p.entry_next_bar_open,
        "entry_gap_guard_max_ticks": p.entry_gap_guard_max_ticks,
    }


def _warn_version(raw: dict[str, Any]) -> None:
    v = raw.get("version", 1)
    if not isinstance(v, int):
        warnings.warn(
            f"backtest defaults: version should be int, got {type(v).__name__}",
            UserWarning,
            stacklevel=3,
        )
        return
    if v > SUPPORTED_BACKTEST_DEFAULTS_VERSION:
        warnings.warn(
            f"backtest defaults: version={v} is newer than supported "
            f"{SUPPORTED_BACKTEST_DEFAULTS_VERSION}; unknown keys may be ignored.",
            UserWarning,
            stacklevel=3,
        )


def validate_backtest_defaults_document(doc: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    if not doc:
        return errs
    ver = doc.get("version", 1)
    if "version" in doc and not isinstance(ver, int):
        errs.append(f"version must be int, not {type(ver).__name__}")
    for k in doc:
        if k in ALLOWED_TOP_KEYS or (isinstance(k, str) and k.startswith("_")):
            continue
        if k in BROKER_FIELD_KEYS:
            continue
        if k in EXECUTION_POLICY_FIELD_KEYS:
            continue
        errs.append(f"unknown top-level key {k!r}")
    iv = doc.get("initial_capital")
    if iv is not None and (not isinstance(iv, (int, float)) or isinstance(iv, bool)):
        errs.append("initial_capital must be number or null")
    q = doc.get("qty")
    if q is not None and (not isinstance(q, int) or isinstance(q, bool)):
        errs.append("qty must be int or null")
    for fk in ("slippage_ticks", "commission_per_side", "tick_size", "point_value"):
        v = doc.get(fk)
        if v is not None and (
            not isinstance(v, (int, float))
            or isinstance(v, bool)
        ):
            errs.append(f"{fk} must be number or null")
    for fk in ("stop_loss_ticks", "take_profit_ticks"):
        v = doc.get(fk)
        if v is not None and (
            not isinstance(v, (int, float))
            or isinstance(v, bool)
        ):
            errs.append(f"{fk} must be number or null")
    for ek in EXECUTION_POLICY_BOOL_KEYS:
        v = doc.get(ek)
        if v is not None and not isinstance(v, bool):
            errs.append(f"{ek} must be boolean or null")
    for fk in EXECUTION_POLICY_OPTIONAL_FLOAT_KEYS:
        v = doc.get(fk)
        if v is not None and (
            not isinstance(v, (int, float))
            or isinstance(v, bool)
        ):
            errs.append(f"{fk} must be number or null")
    return errs


def _merge_doc_into_base(doc: dict[str, Any], base: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k in BROKER_FIELD_KEYS:
        if k not in doc:
            continue
        val = doc[k]
        if k == "qty":
            out[k] = int(val) if val is not None else base[k]
            continue
        if k in ("stop_loss_ticks", "take_profit_ticks"):
            if val is None:
                out[k] = None
            else:
                out[k] = float(val)
            continue
        if val is None:
            continue
        if k == "initial_capital":
            out[k] = float(val)
        else:
            out[k] = float(val)
    return out


def _merge_execution_doc_into_base(doc: dict[str, Any], base: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k in EXECUTION_POLICY_BOOL_KEYS:
        if k not in doc:
            continue
        val = doc[k]
        if val is None:
            continue
        out[k] = bool(val)
    for k in EXECUTION_POLICY_OPTIONAL_FLOAT_KEYS:
        if k not in doc:
            continue
        val = doc[k]
        if val is None:
            out[k] = None
        else:
            out[k] = float(val)
    return out


def load_backtest_defaults_document() -> dict[str, Any]:
    path = resolve_backtest_defaults_path()
    broker_base = _hardcoded_fallback_broker_dict()
    exec_base = _hardcoded_execution_policy_dict()
    if path is None:
        return {**broker_base, **exec_base}
    try:
        with open(path, encoding="utf-8") as f:
            parsed = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {**broker_base, **exec_base}
    raw = parsed if isinstance(parsed, dict) else {}
    _warn_version(raw)
    for err in validate_backtest_defaults_document(raw):
        warnings.warn(f"backtest defaults ({path}): {err}", UserWarning, stacklevel=2)
    merged_broker = _merge_doc_into_base(raw, broker_base)
    merged_exec = _merge_execution_doc_into_base(raw, exec_base)
    return {**merged_broker, **merged_exec}


def clear_backtest_defaults_cache() -> None:
    """Historical hook for tests/env swaps — defaults are uncached now (no-op)."""


def effective_broker_defaults() -> dict[str, Any]:
    """Broker-only fields after JSON overlay."""
    full = load_backtest_defaults_document()
    return {k: full[k] for k in BROKER_FIELD_KEYS}


def effective_execution_policy_defaults() -> dict[str, Any]:
    """Execution policy fields after JSON overlay."""
    full = load_backtest_defaults_document()
    return {k: full[k] for k in EXECUTION_POLICY_FIELD_KEYS}


def merge_request_broker_overlay(
    request_dump: dict[str, Any],
    *,
    overlay_keys_only: frozenset[str],
) -> dict[str, Any]:
    """Merge explicit request fields onto JSON/file defaults."""
    base = effective_broker_defaults()
    out = dict(base)
    for k in overlay_keys_only:
        if k not in request_dump:
            continue
        out[k] = request_dump[k]
    return out


def merge_request_execution_overlay(
    request_dump: dict[str, Any],
    *,
    overlay_keys_only: frozenset[str],
) -> dict[str, Any]:
    base = effective_execution_policy_defaults()
    out = dict(base)
    for k in overlay_keys_only:
        if k not in request_dump:
            continue
        out[k] = request_dump[k]
    return out


def _float_or_none(v: Any) -> float | None:
    if v is None:
        return None
    return float(v)


def merged_broker_config_from_request_payload(request_dump: dict[str, Any]) -> BrokerConfig:
    """Build ``BrokerConfig`` from ``model_dump(exclude_unset=True)`` overlay."""
    base_eff = effective_broker_defaults()
    keys = frozenset(BROKER_FIELD_KEYS)
    merged = merge_request_broker_overlay(request_dump, overlay_keys_only=keys)
    # Explicit null payloads should not degrade required broker numerics into None.
    for k in (
        "initial_capital",
        "qty",
        "slippage_ticks",
        "commission_per_side",
        "tick_size",
        "point_value",
    ):
        if merged.get(k) is None:
            merged[k] = base_eff[k]
    return BrokerConfig(
        initial_capital=float(merged["initial_capital"]),
        qty=int(merged["qty"]),
        slippage_ticks=float(merged["slippage_ticks"]),
        commission_per_side=float(merged["commission_per_side"]),
        tick_size=float(merged["tick_size"]),
        point_value=float(merged["point_value"]),
        stop_loss_ticks=_float_or_none(merged.get("stop_loss_ticks")),
        take_profit_ticks=_float_or_none(merged.get("take_profit_ticks")),
    )


def merged_execution_policy_from_request_payload(request_dump: dict[str, Any]) -> ExecutionPolicy:
    """Merge execution-policy fields from request overlay onto defaults."""
    keys = frozenset(EXECUTION_POLICY_FIELD_KEYS)
    merged = merge_request_execution_overlay(request_dump, overlay_keys_only=keys)
    return ExecutionPolicy(
        ignore_same_side_fire_when_open=bool(merged["ignore_same_side_fire_when_open"]),
        flip_on_opposite_fire=bool(merged["flip_on_opposite_fire"]),
        exit_on_stop_loss=bool(merged["exit_on_stop_loss"]),
        exit_on_take_profit=bool(merged["exit_on_take_profit"]),
        close_at_end_of_window=bool(merged["close_at_end_of_window"]),
        entry_next_bar_open=bool(merged["entry_next_bar_open"]),
        entry_gap_guard_max_ticks=_float_or_none(merged.get("entry_gap_guard_max_ticks")),
    )
