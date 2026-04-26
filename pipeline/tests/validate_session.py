"""Quick-and-dirty session validation script.

Prints OHLC spot-check candidates + cumulative-delta sanity. Use to
compare against TradingView ESM6 1-min bars or any broker chart.

Usage:
    python pipeline/tests/validate_session.py data/bars/es_2026-04-21_rth.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <path-to-session-json>")
        return 2
    p = Path(argv[1])
    d = json.loads(p.read_text())
    bars = d["bars"]

    print(f"=== {p.name} ===")
    print(f"symbol={d['symbol']} contract={d['contract']} bars={len(bars)}")
    print(f"sessionStart={d['sessionStart']} sessionEnd={d['sessionEnd']}")

    print("\n-- First 3 RTH bars (compare to broker) --")
    for b in bars[:3]:
        print(f"  {b['time']}  O={b['open']:>8.2f} H={b['high']:>8.2f} "
              f"L={b['low']:>8.2f} C={b['close']:>8.2f}  V={b['volume']:>6}  d={b['delta']:>+6}")
    print("-- Last RTH bar --")
    b = bars[-1]
    print(f"  {b['time']}  O={b['open']:>8.2f} H={b['high']:>8.2f} "
          f"L={b['low']:>8.2f} C={b['close']:>8.2f}  V={b['volume']:>6}  d={b['delta']:>+6}")

    so = bars[0]["open"]
    sc = bars[-1]["close"]
    sh = max(x["high"] for x in bars)
    sl = min(x["low"] for x in bars)
    sv = sum(x["volume"] for x in bars)
    sd = sum(x["delta"] for x in bars)

    print(f"\nSession O/H/L/C: {so:.2f} / {sh:.2f} / {sl:.2f} / {sc:.2f}  "
          f"range={sh - sl:.2f} ({(sh - sl)/0.25:.0f} ticks)")
    print(f"Session volume:  {sv:,}    change={sc - so:+.2f}  ({(sc - so)/so*100:+.2f}%)")

    print(f"\nCumulative delta end-of-day: {sd:+,}")
    print(f"|cumD| / volume = {abs(sd)/sv*100:.2f}% (red flag if >40%)")

    first60_pos = all(x["delta"] > 0 for x in bars[:60])
    first60_neg = all(x["delta"] < 0 for x in bars[:60])
    print(f"first-60 bars all positive delta? {first60_pos}; all negative? {first60_neg} "
          f"(both should be False)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
