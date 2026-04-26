"""Resolve the front-month outright instrument_id for a given DBN file.

The parent-symbol query (`ES.FUT`, `stype_in=parent`) returns trades on
*all* listed contracts plus calendar spreads. For dashboard purposes we
want only the front-month outright (ESM6, ESU6, ...).

Algorithm: count traded volume per instrument_id across the file, then
pick the single id with the highest volume whose human symbol is an
outright (no '-' separator). For ES this id wins by ~99.9% — the spread
and back-month tails are tiny.

A roll within a single day's file would be visible as two outright ids
each holding ~50% of volume; we warn loudly if that happens. The
2026-04-19 .. 2026-04-24 window is well clear of any quarterly roll
(ES rolls second Thursday of Mar/Jun/Sep/Dec), but the check is here for
forward compatibility.

Plan refs: §2 stage 2.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from .decode import iter_trades, load_symbology


@dataclass(slots=True)
class FrontMonth:
    instrument_id: int
    symbol: str
    volume: int
    trade_count: int
    share_of_volume: float


def resolve_front_month(path: Path | str, *, warn=print) -> FrontMonth:
    """Return the front-month outright for a single .dbn.zst file.

    Raises ValueError if no outright contract has any trades (malformed
    file). Warns (via the supplied callable) if the leader is a spread
    or if two outrights are within 5x of each other (possible roll day).
    """
    sym_map = load_symbology(path)
    vol = Counter()
    cnt = Counter()
    for t in iter_trades(path):
        vol[t.instrument_id] += t.size
        cnt[t.instrument_id] += 1

    if not vol:
        raise ValueError(f"No trades found in {path}")

    total_vol = sum(vol.values())

    outright_volumes: list[tuple[int, int, str]] = []
    for iid, v in vol.most_common():
        sym = sym_map.get(iid, f"id={iid}")
        if "-" in sym:
            continue  # calendar spread
        outright_volumes.append((iid, v, sym))

    if not outright_volumes:
        raise ValueError(f"No outright contracts found in {path} (only spreads?)")

    leader_id, leader_vol, leader_sym = outright_volumes[0]
    share = leader_vol / total_vol

    if len(outright_volumes) >= 2:
        runner_id, runner_vol, runner_sym = outright_volumes[1]
        if runner_vol > 0 and leader_vol / runner_vol < 5.0:
            warn(
                f"WARN: possible roll day in {Path(path).name}: "
                f"{leader_sym}={leader_vol} vs {runner_sym}={runner_vol}. "
                f"Picking {leader_sym}; bars will not span the roll."
            )

    return FrontMonth(
        instrument_id=leader_id,
        symbol=leader_sym,
        volume=leader_vol,
        trade_count=cnt[leader_id],
        share_of_volume=share,
    )
