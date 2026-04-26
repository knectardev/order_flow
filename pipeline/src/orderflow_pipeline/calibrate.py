"""Calibration mode — print bar-level distributions and a side-by-side
comparison of three competing detection rules on a session's bars.

The dashboard's detector currently uses *multiplier* thresholds:
    sweep      if  volume > sweepVolMult * avg10
    absorption if  volume > absorbVolMult * avg10  AND
                   range  < absorbRangeMult * avgRange10
    divergence if  new high/low AND |cumD8| > divergenceFlowMult * avgVol

Real markets have a strong volume smile (open/close vs lunch). A simple
multiplier off a 10-bar mean can over-fire during quiet stretches because
the local mean drops.  We compare three rules:

    multiplier    : the existing rule (1.65x avg10)
    z-score       : (vol - mean10) / std10  > 2.0
    median + MAD  : (vol - median10) / (1.4826 * MAD10) > 2.0   (robust)

Acceptance criteria from plan §6.6:
    target ~3-10 sweeps per RTH session
    target ~0-2 canonical fires per RTH session
    flag if a rule produces a "lunch tail" of low-absolute-volume sweeps

Plan refs: §6 (validation), §6.6 (calibration mandate from user feedback B).
"""
from __future__ import annotations

import json
import statistics
import sys
from datetime import datetime
from pathlib import Path

# Reasonable rolling-window for detection-rule comparisons. The dashboard
# itself uses a 10-bar window in §8.1 of requirements.md.
WIN = 10


def _percentiles(xs: list[float], qs=(0.05, 0.25, 0.5, 0.75, 0.95, 0.99)) -> list[float]:
    if not xs:
        return [0.0] * len(qs)
    s = sorted(xs)
    n = len(s)
    out = []
    for q in qs:
        i = min(n - 1, max(0, int(round(q * (n - 1)))))
        out.append(s[i])
    return out


def _hour_of(iso_ts: str) -> int:
    # ET hour-of-day for the bar — drives the volume-smile bucket.
    # We get UTC iso, convert to ET hour.
    from zoneinfo import ZoneInfo
    dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    return dt.astimezone(ZoneInfo("America/New_York")).hour


def _rolling_stats(xs: list[float], i: int) -> tuple[float, float, float, float]:
    """Return (mean, std, median, mad) over xs[max(0,i-WIN):i]."""
    win = xs[max(0, i - WIN):i]
    if len(win) < 2:
        return 0.0, 0.0, 0.0, 0.0
    m = statistics.fmean(win)
    s = statistics.pstdev(win)
    med = statistics.median(win)
    mad = statistics.median(abs(x - med) for x in win)
    return m, s, med, mad


def _detect(bars: list[dict], tunings: dict) -> dict:
    """Run all three sweep rules and return per-rule counts + per-hour buckets."""
    vols = [b["volume"] for b in bars]
    ranges = [b["high"] - b["low"] for b in bars]

    sweep_mult = tunings.get("sweepVolMult", 1.65)
    counts = {"multiplier": 0, "zscore": 0, "mad": 0}
    by_hour = {"multiplier": {}, "zscore": {}, "mad": {}}

    # Match the dashboard's gate: no events until at least 12 bars exist.
    LOOKBACK_GATE = 12

    for i, b in enumerate(bars):
        if i < LOOKBACK_GATE:
            continue
        vol = vols[i]
        rng = ranges[i]
        win_vols = vols[max(0, i - WIN):i]
        win_ranges = ranges[max(0, i - WIN):i]
        recent_high = max(b2["high"] for b2 in bars[max(0, i - WIN):i])
        recent_low = min(b2["low"] for b2 in bars[max(0, i - WIN):i])
        avg_vol = statistics.fmean(win_vols)
        std_vol = statistics.pstdev(win_vols) if len(win_vols) > 1 else 0.0
        med_vol = statistics.median(win_vols)
        mad_vol = statistics.median(abs(x - med_vol) for x in win_vols)

        is_extreme = b["high"] > recent_high or b["low"] < recent_low

        rules = {
            "multiplier": is_extreme and vol > avg_vol * sweep_mult,
            "zscore":     is_extreme and std_vol > 0 and (vol - avg_vol) / std_vol > 2.0,
            "mad":        is_extreme and mad_vol > 0 and (vol - med_vol) / (1.4826 * mad_vol) > 2.0,
        }
        h = _hour_of(b["time"])
        for name, hit in rules.items():
            if hit:
                counts[name] += 1
                by_hour[name][h] = by_hour[name].get(h, 0) + 1

    return {"counts": counts, "by_hour": by_hour}


def calibrate_session(
    *,
    bars_dir: Path,
    date_str: str,
    symbol: str = "es",
    session: str = "rth",
) -> int:
    fname = f"{symbol.lower()}_{date_str}_{session}.json"
    path = bars_dir / fname
    if not path.is_file():
        print(f"No such file: {path}", file=sys.stderr)
        return 2

    with path.open("r", encoding="utf-8") as f:
        payload = json.load(f)

    bars = payload["bars"]
    tunings = payload.get("tunings", {})

    if not bars:
        print(f"{path.name} has no bars.", file=sys.stderr)
        return 1

    print(f"=== {path.name} — {len(bars)} bars ===")
    print(f"contract: {payload.get('contract','?')}  "
          f"session:  {payload.get('session','?')}  "
          f"window:   {payload.get('sessionStart','?')} -> {payload.get('sessionEnd','?')}")

    # ---- bar-level distributions ----
    vols     = [b["volume"] for b in bars]
    ranges   = [b["high"] - b["low"] for b in bars]
    avg_size = [b.get("avgTradeSize", 0.0) for b in bars]
    lp_ratio = [
        (b.get("largePrintCount", 0) / b["tradeCount"]) if b.get("tradeCount") else 0.0
        for b in bars
    ]

    print("\n-- Bar distributions  (p05 / p25 / p50 / p75 / p95 / p99) --")
    print(f"  volume         : {_fmt(_percentiles(vols))}")
    print(f"  range ($)      : {_fmt(_percentiles(ranges))}")
    print(f"  avgTradeSize   : {_fmt(_percentiles(avg_size))}")
    print(f"  largePrintRatio: {_fmt(_percentiles(lp_ratio))}")

    # ---- volume smile by ET hour ----
    by_hour: dict[int, list[int]] = {}
    for b in bars:
        h = _hour_of(b["time"])
        by_hour.setdefault(h, []).append(b["volume"])
    print("\n-- Volume by ET hour --")
    for h in sorted(by_hour):
        v = by_hour[h]
        print(f"  {h:02d}:00  n={len(v):3d}  mean={statistics.fmean(v):8.0f}  "
              f"median={statistics.median(v):8.0f}  max={max(v):8d}")

    # ---- detection rule comparison ----
    res = _detect(bars, tunings)
    print("\n-- Sweep counts under three rules --")
    for name, n in res["counts"].items():
        print(f"  {name:11s}: {n} sweep(s)")
    print("\n-- Sweep counts by ET hour --")
    hours = sorted({h for d in res["by_hour"].values() for h in d})
    if hours:
        header = "  hour | " + " | ".join(f"{n:>11s}" for n in res["by_hour"])
        print(header)
        print("  " + "-" * (len(header) - 2))
        for h in hours:
            row = f"  {h:02d}:00 | " + " | ".join(
                f"{res['by_hour'][n].get(h, 0):11d}" for n in res["by_hour"]
            )
            print(row)
    else:
        print("  (no sweeps under any rule)")

    print("\nAcceptance band (per RTH session): 3-10 sweeps.")
    return 0


def _fmt(xs: list[float]) -> str:
    return "  ".join(f"{x:9.3f}" if x < 1000 else f"{x:9.0f}" for x in xs)
