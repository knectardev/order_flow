"""Scale template SL/TP tick distances using persisted regime bar fields."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class RegimeExitScaleParams:
    """Subset of broker config used for regime scaling (no circular import to BrokerConfig)."""

    regime_exit_scale_enabled: bool = False
    regime_exit_scale_mode: str = "range_pct"
    regime_sl_mult_min: float = 0.75
    regime_sl_mult_max: float = 1.25
    regime_tp_mult_min: float = 0.75
    regime_tp_mult_max: float = 1.25
    regime_sl_floor_ticks: float | None = None
    regime_v_rank_sl_mults: tuple[float, float, float, float, float] = (
        0.85,
        0.92,
        1.0,
        1.08,
        1.15,
    )
    regime_v_rank_tp_mults: tuple[float, float, float, float, float] = (
        0.85,
        0.92,
        1.0,
        1.08,
        1.15,
    )


def should_apply_regime_exit_scaling(
    params: RegimeExitScaleParams,
    *,
    broker_stop_loss_ticks: float | None,
    broker_take_profit_ticks: float | None,
) -> bool:
    """Scaling applies only when enabled and broker run-wide SL/TP overrides are absent."""
    if not params.regime_exit_scale_enabled:
        return False
    if broker_stop_loss_ticks is not None or broker_take_profit_ticks is not None:
        return False
    return True


def _safe_float_regime_volatility(v: Any) -> float | None:
    """Parse range_pct (or similar); return None for invalid / non-finite / negative."""
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x) or math.isnan(x) or x < 0:
        return None
    return max(0.0, min(1.0, x))


def _v_rank_multiplier(rank: Any, table: tuple[float, ...]) -> float | None:
    if rank is None:
        return None
    try:
        r = int(rank)
    except (TypeError, ValueError):
        return None
    if r < 1 or r > 5 or len(table) != 5:
        return None
    m = float(table[r - 1])
    if not math.isfinite(m) or m <= 0:
        return None
    return m


def _lerp_mult(range_pct: float | None, mn: float, mx: float) -> float | None:
    if range_pct is None:
        return None
    if not math.isfinite(mn) or not math.isfinite(mx) or mx < mn:
        return None
    return mn + (mx - mn) * range_pct


def _resolve_multipliers(
    entry_bar: dict[str, Any],
    params: RegimeExitScaleParams,
) -> tuple[float | None, float | None]:
    """Return (sl_mult, tp_mult); None multiplier means neutral 1.0 in finalize."""
    mode = (params.regime_exit_scale_mode or "range_pct").strip().lower()
    if mode == "v_rank":
        sl_m = _v_rank_multiplier(entry_bar.get("v_rank"), params.regime_v_rank_sl_mults)
        tp_m = _v_rank_multiplier(entry_bar.get("v_rank"), params.regime_v_rank_tp_mults)
        return sl_m, tp_m

    rp = _safe_float_regime_volatility(entry_bar.get("range_pct"))
    sl_m = _lerp_mult(rp, params.regime_sl_mult_min, params.regime_sl_mult_max)
    if sl_m is None:
        sl_m = _v_rank_multiplier(entry_bar.get("v_rank"), params.regime_v_rank_sl_mults)
    tp_m = _lerp_mult(rp, params.regime_tp_mult_min, params.regime_tp_mult_max)
    if tp_m is None:
        tp_m = _v_rank_multiplier(entry_bar.get("v_rank"), params.regime_v_rank_tp_mults)
    return sl_m, tp_m


def _finalize_scaled_ticks(
    base: float | None,
    mult: float | None,
    *,
    floor_ticks: float | None,
    template: float | None,
) -> float | None:
    if base is None:
        return None
    if mult is None:
        mult = 1.0
    if not math.isfinite(mult) or mult <= 0:
        mult = 1.0
    scaled = base * mult
    out = round(scaled, 6)
    if template is not None and template > 0 and (not math.isfinite(out) or out <= 0):
        return round(float(template), 6)
    if floor_ticks is not None and out < floor_ticks:
        out = float(floor_ticks)
    if template is not None and template > 0 and 0 < out < 1.0:
        out = 1.0
    return round(out, 6)


def apply_regime_exit_scale(
    base_sl: float | None,
    base_tp: float | None,
    entry_bar: dict[str, Any],
    params: RegimeExitScaleParams,
    *,
    broker_stop_loss_ticks: float | None,
    broker_take_profit_ticks: float | None,
) -> tuple[float | None, float | None]:
    """Combine template ticks with entry-bar regime; barriers stay fixed after open."""
    if not should_apply_regime_exit_scaling(
        params,
        broker_stop_loss_ticks=broker_stop_loss_ticks,
        broker_take_profit_ticks=broker_take_profit_ticks,
    ):
        return base_sl, base_tp

    sl_m, tp_m = _resolve_multipliers(entry_bar, params)
    sl_eff = _finalize_scaled_ticks(
        base_sl,
        sl_m,
        floor_ticks=params.regime_sl_floor_ticks,
        template=base_sl,
    )
    tp_eff = _finalize_scaled_ticks(
        base_tp,
        tp_m,
        floor_ticks=None,
        template=base_tp,
    )
    return sl_eff, tp_eff
