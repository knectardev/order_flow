"""PHAT candle feature extraction from aggregated bar microstructure.

The PHAT form factor is encoded with four per-bar signals:

- ``top_cvd`` / ``bottom_cvd``: signed aggressor-volume split by the body
  midpoint. Positive means buyer-dominant, negative seller-dominant.
- ``upper_wick_liquidity`` / ``lower_wick_liquidity``: [0, 1] scores from
  volume concentration near the wick extremes. High values imply thick
  participation at the wick tip (filled ring); low values imply thin prints
  (hollow ring).

This module is intentionally pure and deterministic so the same function can
be used by ingest, backfill, and tests.
"""

from __future__ import annotations


def _clamp01(x: float) -> float:
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    return x


def _liquidity_ratio(
    *,
    price_volume: dict[int, int],
    body_edge_tick: int,
    wick_extreme_tick: int,
) -> float:
    """Return [0, 1] wick-liquidity share near the wick extreme.

    ``body_edge_tick`` is the body boundary on that side; ``wick_extreme_tick``
    is the wick tip. The ratio is:

        volume in outer half of wick / total wick-side volume

    and defaults to 0.0 when there is no wick-side volume.
    """
    if wick_extreme_tick == body_edge_tick:
        return 0.0

    step = 1 if wick_extreme_tick > body_edge_tick else -1
    ticks = list(range(body_edge_tick + step, wick_extreme_tick + step, step))
    if not ticks:
        return 0.0

    total = sum(int(price_volume.get(t, 0)) for t in ticks)
    if total <= 0:
        return 0.0

    outer_count = max(1, len(ticks) // 2)
    outer_ticks = ticks[-outer_count:]
    outer_total = sum(int(price_volume.get(t, 0)) for t in outer_ticks)
    return _clamp01(outer_total / total)


def compute_phat_features(
    *,
    open_price: float,
    close_price: float,
    high_price: float,
    low_price: float,
    tick_size: float,
    price_volume: dict[int, int],
    price_delta: dict[int, int],
) -> dict[str, float]:
    """Compute PHAT features for one bar.

    Inputs are the finalized OHLC and per-tick volume/delta maps from the same
    bar. Output keys are snake_case DB-ready field names.
    """
    if tick_size <= 0:
        raise ValueError(f"tick_size must be > 0, got {tick_size}")

    body_hi = max(open_price, close_price)
    body_lo = min(open_price, close_price)
    body_mid = (body_hi + body_lo) / 2.0

    top_cvd = 0
    bottom_cvd = 0
    top_abs_delta = 0.0
    bottom_abs_delta = 0.0
    top_body_vol = 0
    bottom_body_vol = 0
    for tick, signed in price_delta.items():
        px = tick * tick_size
        if px >= body_mid:
            top_cvd += int(signed)
            top_abs_delta += abs(float(signed))
        else:
            bottom_cvd += int(signed)
            bottom_abs_delta += abs(float(signed))
    for tick, vol in price_volume.items():
        px = tick * tick_size
        if px >= body_mid:
            top_body_vol += int(vol)
        else:
            bottom_body_vol += int(vol)

    top_body_tick = round(body_hi / tick_size)
    bot_body_tick = round(body_lo / tick_size)
    high_tick = round(high_price / tick_size)
    low_tick = round(low_price / tick_size)

    upper_wick_liq = _liquidity_ratio(
        price_volume=price_volume,
        body_edge_tick=top_body_tick,
        wick_extreme_tick=high_tick,
    )
    lower_wick_liq = _liquidity_ratio(
        price_volume=price_volume,
        body_edge_tick=bot_body_tick,
        wick_extreme_tick=low_tick,
    )

    body_total = top_body_vol + bottom_body_vol
    if body_total <= 0:
        top_body_ratio = 0.5
    else:
        top_body_ratio = _clamp01(top_body_vol / body_total)
    bottom_body_ratio = 1.0 - top_body_ratio

    top_cvd_norm = float(top_cvd) / top_abs_delta if top_abs_delta > 0 else 0.0
    bottom_cvd_norm = float(bottom_cvd) / bottom_abs_delta if bottom_abs_delta > 0 else 0.0
    cvd_imbalance = abs(float(top_cvd_norm) - float(bottom_cvd_norm))

    rng = max(high_price - low_price, 0.0)
    retreat_from_high = ((high_price - close_price) / rng) if rng > 0 else 0.0
    retreat_from_low = ((close_price - low_price) / rng) if rng > 0 else 0.0

    near_high_ticks = [t for t, v in price_volume.items() if v > 0 and t >= high_tick - 2]
    near_low_ticks = [t for t, v in price_volume.items() if v > 0 and t <= low_tick + 2]

    # Rejection *detection* vs `demo_files/candle_prototype.html`:
    # The prototype uses simulated intrabar steps (MIN_STEPS_NEAR=3, 50% retreat).
    # Here we only have per-tick aggregates — literal 50% + 3 levels yields almost no
    # markers on real 1m bars. Looser gates below match the same intent (dwell × retreat)
    # while keeping most bars unmarked. There is no separate "strict prototype" flag;
    # tune these constants if research needs closer parity to the HTML sim.
    reject_threshold = 0.28
    min_ticks_near = 2

    high_score = (
        (len(near_high_ticks) / 6.0) * retreat_from_high
        if len(near_high_ticks) >= min_ticks_near and retreat_from_high >= reject_threshold
        else 0.0
    )
    low_score = (
        (len(near_low_ticks) / 6.0) * retreat_from_low
        if len(near_low_ticks) >= min_ticks_near and retreat_from_low >= reject_threshold
        else 0.0
    )

    rejection_side = "none"
    rejection_strength = 0.0
    if high_score > low_score:
        rejection_side = "high"
        rejection_strength = min(1.0, high_score * 1.3)
    elif low_score > high_score:
        rejection_side = "low"
        rejection_strength = min(1.0, low_score * 1.3)

    rejection_type = "none"
    if rejection_side != "none":
        zone_ticks = near_high_ticks if rejection_side == "high" else near_low_ticks
        extreme_vol = [float(price_volume.get(t, 0)) for t in zone_ticks]
        all_nonzero_vol = [float(v) for v in price_volume.values() if v > 0]
        extreme_avg = (sum(extreme_vol) / len(extreme_vol)) if extreme_vol else 0.0
        overall_avg = (sum(all_nonzero_vol) / len(all_nonzero_vol)) if all_nonzero_vol else 0.0
        vol_ratio = (extreme_avg / overall_avg) if overall_avg > 0 else 1.0
        rejection_type = "absorption" if vol_ratio > 1.1 else "exhaustion"

    return {
        "top_cvd": float(top_cvd),
        "bottom_cvd": float(bottom_cvd),
        "top_cvd_norm": round(float(top_cvd_norm), 6),
        "bottom_cvd_norm": round(float(bottom_cvd_norm), 6),
        "cvd_imbalance": round(float(cvd_imbalance), 6),
        "top_body_volume_ratio": round(float(top_body_ratio), 6),
        "bottom_body_volume_ratio": round(float(bottom_body_ratio), 6),
        "upper_wick_liquidity": round(float(upper_wick_liq), 6),
        "lower_wick_liquidity": round(float(lower_wick_liq), 6),
        "rejection_side": rejection_side,
        "rejection_strength": round(float(rejection_strength), 6),
        "rejection_type": rejection_type,
    }
