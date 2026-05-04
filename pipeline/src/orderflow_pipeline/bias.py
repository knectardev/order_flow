"""VWAP-Anchor Directional Bias engine — Phase 6.

Classifies each bar's `(v_rank, d_rank, vwap_position)` triple into a
7-level bias state used by the dashboard's Bias Ribbon and the 1m
canonical alignment scoring.

Alphabet (7 levels)
-------------------
- ``BULLISH_STRONG`` — confirmed markup: high volatility + deep book + above VWAP
- ``BULLISH_MILD``   — soft bull-leaning default outside band
- ``ACCUMULATION``   — Wyckoff anomaly / depth-leads-Location below VWAP
- ``NEUTRAL``        — warmup ranks OR price inside the VWAP tolerance band
- ``DISTRIBUTION``   — Wyckoff anomaly / depth-leads-Location above VWAP
- ``BEARISH_MILD``   — soft bear-leaning default outside band
- ``BEARISH_STRONG`` — confirmed markdown: high volatility + thin book + below VWAP

Mapping rules (applied in priority order)
-----------------------------------------
1. Warmup: any of ``v_rank``, ``d_rank`` is ``None`` -> ``NEUTRAL``.
2. Inside VWAP band: ``vwap_position == 0`` -> ``NEUTRAL`` regardless of ranks.
3. Wyckoff anomaly cells:
   - ``vwap_position < 0`` AND ``(v_rank, d_rank) == (5, 5)`` -> ``ACCUMULATION``
     (climactic + below VWAP = absorption / "High Friction")
   - ``vwap_position > 0`` AND ``(v_rank, d_rank) == (5, 1)`` -> ``DISTRIBUTION``
     (heavy/absorptive + above VWAP = supply unloaded into rallies)
4. Strong tier (high volatility + matching depth + matching VWAP side):
   - ``vwap_position > 0 and v_rank in {4,5} and d_rank in {4,5}`` -> ``BULLISH_STRONG``
   - ``vwap_position < 0 and v_rank in {4,5} and d_rank in {1,2}`` -> ``BEARISH_STRONG``
5. Depth-leads-Location (depth disagrees with VWAP, anywhere outside the
   explicit anomaly cells above):
   - ``vwap_position < 0 and d_rank in {4,5}`` -> ``ACCUMULATION``
   - ``vwap_position > 0 and d_rank in {1,2}`` -> ``DISTRIBUTION``
6. Mild default outside band:
   - ``vwap_position > 0`` -> ``BULLISH_MILD``
   - ``vwap_position < 0`` -> ``BEARISH_MILD``

VWAP-band configuration
-----------------------
``VWAP_BAND_TICKS_BY_TF`` controls the at-VWAP tolerance per timeframe in
ES tick units (1 tick = ``TICK_SIZE`` = 0.25 ES points). The band is
intentionally generous so the engine doesn't flicker between Mild-Bullish
and Mild-Bearish on every tick of pivot-noise; if Wyckoff "Location"
matters, it should matter beyond a few ticks.

Public API
----------
- ``vwap_position(close, vwap, band_ticks)`` -> ``int`` in ``{-1, 0, +1}``
- ``classify_bias(v_rank, d_rank, vwap_position)`` -> ``str``
- ``compute_bias_column(df, timeframe)`` -> mutated DataFrame with ``bias_state``
- ``VWAP_BAND_TICKS_BY_TF`` (canonical config)
- ``BIAS_LEVELS`` (the 7-level alphabet, exported for downstream tests)
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pandas as pd  # noqa: F401

from .aggregate import TICK_SIZE


# 7-level bias alphabet. Ordered from most-bullish to most-bearish so
# downstream consumers (event log, ribbon palette) can index by position
# if needed.
BIAS_LEVELS: tuple[str, ...] = (
    "BULLISH_STRONG",
    "BULLISH_MILD",
    "ACCUMULATION",
    "NEUTRAL",
    "DISTRIBUTION",
    "BEARISH_MILD",
    "BEARISH_STRONG",
)


# Per-timeframe at-VWAP tolerance in ES ticks. A close within
# ``band_ticks * TICK_SIZE`` of vwap collapses to vwap_position == 0.
# 1m  : 4 ticks = 1.00 ES points
# 5m  : 6 ticks = 1.50 ES points
# 15m : 8 ticks = 2.00 ES points
# 1h  : 16 ticks = 4.00 ES points (auto-scales with timeframe noise).
VWAP_BAND_TICKS_BY_TF: dict[str, int] = {
    "1m":  4,
    "5m":  6,
    "15m": 8,
    "1h":  16,
}


def vwap_position(
    close: float | None,
    vwap: float | None,
    band_ticks: int,
) -> int:
    """Return the band-clamped sign of ``close - vwap``.

    Returns ``+1`` if ``close > vwap + band``, ``-1`` if ``close < vwap - band``,
    and ``0`` otherwise (inside band or either input is None / NaN).

    The strict-inequality semantics mean a close exactly ``band`` above vwap
    is still inside the band (vwap_position == 0); only a close strictly
    farther than ``band`` away counts as outside. This is intentional —
    the band is the "at VWAP" zone, and the boundary itself counts as at-VWAP.
    """
    if close is None or vwap is None:
        return 0
    # Defend against NaN (pandas can sneak these in for empty bars).
    if close != close or vwap != vwap:  # NaN check
        return 0
    band = band_ticks * TICK_SIZE
    diff = close - vwap
    if diff > band:
        return 1
    if diff < -band:
        return -1
    return 0


def classify_bias(
    v_rank: int | None,
    d_rank: int | None,
    vwap_pos: int,
) -> str:
    """Classify a single bar into a 7-level bias state.

    See module docstring for the priority-ordered rules. Pure function;
    no I/O, no shared state.
    """
    # 1. Warmup
    if v_rank is None or d_rank is None:
        return "NEUTRAL"

    # 2. Inside VWAP band
    if vwap_pos == 0:
        return "NEUTRAL"

    # 3. Wyckoff anomaly cells
    if vwap_pos < 0 and v_rank == 5 and d_rank == 5:
        return "ACCUMULATION"
    if vwap_pos > 0 and v_rank == 5 and d_rank == 1:
        return "DISTRIBUTION"

    # 4. Strong tier
    if vwap_pos > 0 and v_rank in (4, 5) and d_rank in (4, 5):
        return "BULLISH_STRONG"
    if vwap_pos < 0 and v_rank in (4, 5) and d_rank in (1, 2):
        return "BEARISH_STRONG"

    # 5. Depth-leads-Location
    if vwap_pos < 0 and d_rank in (4, 5):
        return "ACCUMULATION"
    if vwap_pos > 0 and d_rank in (1, 2):
        return "DISTRIBUTION"

    # 6. Mild default outside band
    if vwap_pos > 0:
        return "BULLISH_MILD"
    return "BEARISH_MILD"


def compute_bias_column(
    bars_df: "pd.DataFrame",
    timeframe: str,
) -> "pd.DataFrame":
    """Stamp ``bias_state`` on every row of ``bars_df`` in place.

    Required input columns: ``close``, ``vwap``, ``v_rank``, ``d_rank``.
    The ``bias_state`` column is added (or overwritten) and ``bars_df``
    is returned for chaining. Empty input is a no-op (the column is
    still added so downstream writers don't KeyError).

    The ``timeframe`` argument selects the tolerance band from
    ``VWAP_BAND_TICKS_BY_TF``; pass the same string used by the
    aggregator and the regime classifier ('1m', '5m', '15m', or '1h').
    """
    import pandas as pd  # noqa: F811

    if "bias_state" not in bars_df.columns:
        bars_df["bias_state"] = pd.Series([""] * len(bars_df), dtype="object")

    if len(bars_df) == 0:
        return bars_df

    if timeframe not in VWAP_BAND_TICKS_BY_TF:
        raise ValueError(
            f"Unknown timeframe {timeframe!r}; expected one of {list(VWAP_BAND_TICKS_BY_TF)}"
        )
    band_ticks = VWAP_BAND_TICKS_BY_TF[timeframe]

    out: list[str] = []
    for close, vwap, v_rank, d_rank in zip(
        bars_df["close"].tolist(),
        bars_df["vwap"].tolist(),
        bars_df["v_rank"].tolist(),
        bars_df["d_rank"].tolist(),
    ):
        # Pandas may have promoted None -> float NaN for the rank columns
        # depending on dtype; treat both as warmup.
        v = None if v_rank is None or v_rank != v_rank else int(v_rank)
        d = None if d_rank is None or d_rank != d_rank else int(d_rank)
        # close / vwap may be NaN for zero-volume bars; vwap_position()
        # treats NaN as "no signal" -> position == 0 -> NEUTRAL.
        pos = vwap_position(
            close if close is None or close == close else None,
            vwap if vwap is None or vwap == vwap else None,
            band_ticks,
        )
        out.append(classify_bias(v, d, pos))

    bars_df["bias_state"] = pd.Series(out, index=bars_df.index, dtype="object")
    return bars_df
