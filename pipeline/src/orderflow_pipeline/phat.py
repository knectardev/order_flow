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
    top_body_vol = 0
    bottom_body_vol = 0
    for tick, signed in price_delta.items():
        px = tick * tick_size
        if px >= body_mid:
            top_cvd += int(signed)
        else:
            bottom_cvd += int(signed)
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

    return {
        "top_cvd": float(top_cvd),
        "bottom_cvd": float(bottom_cvd),
        "top_body_volume_ratio": round(float(top_body_ratio), 6),
        "bottom_body_volume_ratio": round(float(bottom_body_ratio), 6),
        "upper_wick_liquidity": round(float(upper_wick_liq), 6),
        "lower_wick_liquidity": round(float(lower_wick_liq), 6),
    }
