"""Frequency-matched random-entry fires for null-hypothesis backtests."""
from __future__ import annotations

import hashlib
import math
import os
import random
from collections.abc import Callable
from datetime import datetime

from .backtest_engine import signal_bar_allows_next_bar_entry
from .strategies.config import LegacyFallbackConfig


def _parity_variants_per_k_from_env() -> int:
    raw = os.environ.get("ORDERFLOW_NH_PARITY_VARIANTS_PER_K", "48")
    try:
        v = int(raw)
    except ValueError:
        v = 48
    return max(1, min(v, 4096))


# Deterministic variants per scheduled-fire count `k` (each variant maps to placement_style % 3).
# Override via ORDERFLOW_NH_PARITY_VARIANTS_PER_K for stubborn parity (cost scales ~linearly).
NH_PARITY_VARIANTS_PER_K = _parity_variants_per_k_from_env()

_PLACEMENT_SHUFFLE_FWD = 0
_PLACEMENT_SORTED_FWD = 1
_PLACEMENT_SORTED_BACK = 2
_PLACEMENT_STYLE_COUNT = 3


def effective_seed_from_baseline_run_id(baseline_run_id: str, *, override: int | None) -> int:
    """63-bit positive deterministic seed from UUID string; optional client override."""
    if override is not None:
        return int(override) & ((1 << 63) - 1)
    digest = hashlib.sha256(baseline_run_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big", signed=False) & ((1 << 63) - 1)


def _sigma_mean_prev_closes(bars: list[dict], i: int, lookback: int) -> tuple[float, float]:
    prev = bars[i - lookback : i]
    closes = [float(x["close"]) for x in prev]
    mean_close = sum(closes) / len(closes)
    if len(closes) < 2:
        return mean_close, 0.0
    var = sum((x - mean_close) ** 2 for x in closes) / (len(closes) - 1)
    return mean_close, math.sqrt(var) if var > 0 else 0.0


def eligible_bar_indices(
    bars: list[dict],
    cfg: LegacyFallbackConfig,
    watch_id: str,
    *,
    entry_next_bar_open: bool = False,
    tick_size: float = 0.25,
    gap_max_ticks: float | None = None,
) -> list[int]:
    """Bars where the scoped watch passes the same regime / volatility gates as live derivation."""
    lb = cfg.lookback_bars
    out: list[int] = []
    for i in range(cfg.warmup_start, len(bars)):
        prev = bars[i - lb : i]
        avg_vol = sum(float(x["volume"]) for x in prev) / len(prev)
        vol = float(bars[i]["volume"])
        vol_ratio = vol / avg_vol if avg_vol > 0 else 1.0
        close = float(bars[i]["close"])
        high = float(bars[i]["high"])
        low = float(bars[i]["low"])
        rng = max(1e-9, high - low)

        if watch_id == "valueEdgeReject":
            normal_vol = 0.8 <= vol_ratio <= 1.2
            vol_ok = normal_vol if cfg.use_regime_filter else True
            if vol_ok:
                out.append(i)
        elif watch_id == "breakout":
            mult = 1.65 if cfg.use_regime_filter else 1.0
            if vol > avg_vol * mult:
                out.append(i)
        elif watch_id == "absorptionWall":
            recent_close_mean, sigma = _sigma_mean_prev_closes(bars, i, lb)
            near_mean = abs(close - recent_close_mean) <= (0.35 * max(0.25, sigma))
            vol_ok = vol > (avg_vol * (1.25 if cfg.use_regime_filter else 1.0))
            mean_ok = near_mean if cfg.use_regime_filter else True
            if vol_ok and mean_ok:
                out.append(i)
        elif watch_id == "fade":
            mean_close, sigma = _sigma_mean_prev_closes(bars, i, lb)
            if sigma <= 0:
                continue
            stretch = 1.0 if cfg.use_regime_filter else 0.6
            last3 = [float(bars[j]["close"]) for j in range(i - 2, i + 1)]
            prev_close = float(bars[i - 1]["close"])
            up_branch = all(x > mean_close + (stretch * sigma) for x in last3) and close < prev_close
            dn_branch = all(x < mean_close - (stretch * sigma) for x in last3) and close > prev_close
            if up_branch or dn_branch:
                out.append(i)
        else:
            raise ValueError(f"null hypothesis not implemented for watch_id={watch_id!r}")
    if not entry_next_bar_open:
        return out
    ts = float(tick_size) if tick_size and tick_size > 0 else 0.25
    filtered: list[int] = []
    for i in out:
        if signal_bar_allows_next_bar_entry(
            bars,
            i,
            entry_next_bar_open=True,
            tick_size=ts,
            gap_max_ticks=gap_max_ticks,
        ):
            filtered.append(i)
    return filtered


def greedy_cooldown_indices(
    sorted_candidate_pool: list[int],
    target_count: int,
    cooldown_bars: int,
) -> list[int]:
    """Greedy packing scanning pool in order: accept idx if idx >= last_accepted + cooldown (forward gap)."""
    chosen: list[int] = []
    last = -10**9
    cd = max(1, cooldown_bars)
    for idx in sorted_candidate_pool:
        if idx >= last + cd:
            chosen.append(idx)
            last = idx
            if len(chosen) >= target_count:
                break
    return chosen


def greedy_cooldown_indices_backward(
    pool_desc_by_index: list[int],
    target_count: int,
    cooldown_bars: int,
) -> list[int]:
    """Greedy packing scanning toward decreasing bar indices: accept idx if idx <= last_accepted - cooldown."""
    chosen: list[int] = []
    last = 10**18
    cd = max(1, cooldown_bars)
    for idx in pool_desc_by_index:
        if idx <= last - cd:
            chosen.append(idx)
            last = idx
            if len(chosen) >= target_count:
                break
    return sorted(chosen)


def max_cooldown_packed_fire_count(valid_indices: list[int], cooldown_bars: int) -> int:
    """Maximum fires placeable on eligible bar indices with global index spacing ≥ cooldown (sorted greedy)."""
    if not valid_indices:
        return 0
    cd = max(1, cooldown_bars)
    pool = sorted(valid_indices)
    return len(greedy_cooldown_indices(pool, len(pool), cd))


def fires_from_bar_indices(
    bars: list[dict],
    bar_indices: list[int],
    *,
    watch_id: str,
    rng: random.Random,
    baseline_run_id: str,
    seed_used: int,
) -> dict[datetime, list[dict]]:
    by_time: dict[datetime, list[dict]] = {}
    for idx in sorted(bar_indices):
        bar = bars[idx]
        ts = bar["bar_time"]
        direction = "up" if rng.random() < 0.5 else "down"
        price = round(float(bar["close"]), 6)
        by_time.setdefault(ts, []).append(
            {
                "bar_time": ts,
                "watch_id": watch_id,
                "direction": direction,
                "price": price,
                "diagnostics": {
                    "nullHypothesis": True,
                    "baseline_run_id": baseline_run_id,
                    "null_hypothesis_seed": seed_used,
                    "diagnosticVersion": "v1",
                },
            }
        )
    return by_time


def propose_greedy_fires_at_k_schedule(
    bars: list[dict],
    valid: list[int],
    *,
    k_schedule: int,
    cooldown_bars: int,
    watch_id: str,
    baseline_run_id: str,
    effective_seed: int,
    perm_digest: bytes,
    placement_style: int,
) -> dict[datetime, list[dict]] | None:
    """Try one deterministic greedy schedule of exactly k_schedule fires (or None if placement fails)."""
    cd = max(1, cooldown_bars)
    subseed = int.from_bytes(perm_digest[:8], "big", signed=False) & ((1 << 63) - 1)
    rng = random.Random(subseed)
    ps = int(placement_style) % _PLACEMENT_STYLE_COUNT
    if ps == _PLACEMENT_SHUFFLE_FWD:
        pool = valid.copy()
        rng.shuffle(pool)
        chosen = greedy_cooldown_indices(pool, k_schedule, cd)
    elif ps == _PLACEMENT_SORTED_FWD:
        pool = sorted(valid)
        chosen = greedy_cooldown_indices(pool, k_schedule, cd)
    else:
        pool = sorted(valid, reverse=True)
        chosen = greedy_cooldown_indices_backward(pool, k_schedule, cd)
    if len(chosen) < k_schedule:
        return None
    chosen = sorted(chosen[:k_schedule])
    dir_rng = random.Random(subseed ^ 0x9E3779B97F4A7C15 ^ (ps << 48))
    return fires_from_bar_indices(
        bars,
        chosen,
        watch_id=watch_id,
        rng=dir_rng,
        baseline_run_id=baseline_run_id,
        seed_used=effective_seed,
    )


def run_null_hypothesis_parity_loop(
    *,
    bars: list[dict],
    cfg: LegacyFallbackConfig,
    watch_id: str,
    baseline_trade_count: int,
    baseline_run_id: str,
    effective_seed: int,
    cooldown_bars: int,
    simulate_trade_count: Callable[[dict[datetime, list[dict]]], int],
    entry_next_bar_open: bool = False,
    tick_size: float = 0.25,
    gap_max_ticks: float | None = None,
) -> tuple[dict[datetime, list[dict]], dict]:
    """Raise ValueError with insufficient_eligible_bars / parity_unreachable messages on failure."""
    if baseline_trade_count < 0:
        raise ValueError("baseline_trade_count must be non-negative")
    if baseline_trade_count == 0:
        raise ValueError("null_hypothesis_skip_zero_trades")

    valid = eligible_bar_indices(
        bars,
        cfg,
        watch_id,
        entry_next_bar_open=entry_next_bar_open,
        tick_size=tick_size,
        gap_max_ticks=gap_max_ticks,
    )
    n_avail = len(valid)
    n_target = baseline_trade_count
    if n_avail < n_target:
        raise ValueError(
            f"insufficient_eligible_bars: eligible_bar_count={n_avail} required_trade_count={n_target}"
        )

    parity_iterations = 0
    cd = max(1, cooldown_bars)
    k_cap = max_cooldown_packed_fire_count(valid, cd)
    if n_target > k_cap:
        raise ValueError(
            f"insufficient_eligible_bars: cannot schedule required_trade_count={n_target} fires "
            f"under cooldown_bars={cd} (max_schedulable_fires={k_cap}, eligible_bar_count={n_avail})"
        )

    variants = max(1, int(NH_PARITY_VARIANTS_PER_K))
    for k_schedule in range(n_target, k_cap + 1):
        for variant in range(variants):
            placement_style = variant % _PLACEMENT_STYLE_COUNT
            perm_digest = hashlib.sha256(
                f"{effective_seed}:{k_schedule}:v{variant}".encode()
            ).digest()
            parity_iterations += 1
            proposed = propose_greedy_fires_at_k_schedule(
                bars,
                valid,
                k_schedule=k_schedule,
                cooldown_bars=cooldown_bars,
                watch_id=watch_id,
                baseline_run_id=baseline_run_id,
                effective_seed=effective_seed,
                perm_digest=perm_digest,
                placement_style=placement_style,
            )
            if proposed is None:
                continue
            tc = simulate_trade_count(proposed)
            if tc == n_target:
                return proposed, {
                    "nh_scheduled_fire_count": k_schedule,
                    "parity_iterations": parity_iterations,
                    "eligible_bar_count": n_avail,
                    "max_schedulable_fires": k_cap,
                    "parity_variants_per_k": variants,
                    "parity_placement_styles": _PLACEMENT_STYLE_COUNT,
                    "matched_trade_count": n_target,
                    "null_hypothesis_seed": effective_seed,
                }

    raise ValueError(
        f"parity_unreachable: baseline_trade_count={n_target} eligible_bar_count={n_avail} "
        f"cooldown_bars={cd} max_schedulable_fires={k_cap} variants_per_k={variants} "
        f"placement_styles={_PLACEMENT_STYLE_COUNT}. "
        f"Try ORDERFLOW_NH_PARITY_VARIANTS_PER_K=128 (or higher), narrow from/to, enable "
        f"flip_on_opposite_fire, or pass null_hypothesis_seed."
    )