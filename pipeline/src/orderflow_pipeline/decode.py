"""DBN.zst -> normalized trade-record iterator.

Wraps `databento.DBNStore.from_file` so the rest of the pipeline can stay
agnostic to the underlying record class. We yield plain dataclasses with
the small set of fields the aggregator actually needs (price as float,
ts_event as int ns UTC, side as single char, etc.).

Plan refs: §2 stage 1, §3.1, §3.2, §3.3.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import databento as db


# Databento Trades flag bits we want to filter out. The trades schema in
# MDP3 normally has flags == 0 on bookable trades. F_BAD_TS_RECV indicates
# a malformed ts_recv that we should skip rather than rely on. We do NOT
# filter F_LAST / F_TOB because those are informational and routine.
FLAG_BAD_TS_RECV = 0x08


@dataclass(slots=True)
class Trade:
    """A single normalized trade. All fields are JSON-friendly primitives."""

    ts_event_ns: int        # nanoseconds since UTC epoch (matching-engine timestamp)
    instrument_id: int
    price: float            # already converted from int64 * 1e-9
    size: int
    side: str               # 'A' (aggressor took offer), 'B' (hit bid), 'N' (none)
    flags: int


def iter_trades(path: Path | str) -> Iterator[Trade]:
    """Yield Trade records from a single .dbn.zst file.

    Filters:
        - action must be 'T' (trade) — the trades schema is supposed to be
          all 'T' but we guard anyway.
        - flags & FLAG_BAD_TS_RECV must be unset.
        - price > 0 (defensive against malformed records).

    Side normalization: databento's Side enum stringifies to 'A' / 'B' / 'N';
    we coerce to the single character so the aggregator never sees an enum.
    """
    store = db.DBNStore.from_file(str(path))
    if store.schema is None or str(store.schema) not in ("trades", "Schema.TRADES"):
        # Schema printed as "Schema.TRADES" in some versions; tolerate either.
        if "trade" not in str(store.schema).lower():
            raise ValueError(f"Expected trades schema, got {store.schema!r} for {path}")

    for r in store:
        # action is an enum/char; coerce to str either way
        action = getattr(r, "action", None)
        action_char = action.value if hasattr(action, "value") else str(action)
        if action_char != "T":
            continue

        flags = int(getattr(r, "flags", 0))
        if flags & FLAG_BAD_TS_RECV:
            continue

        # price is signed int64 with 1e-9 scale; pretty_price already does the
        # division but is a numpy float on some versions — explicit conversion
        # keeps the JSON serializer happy downstream.
        price_int = int(r.price)
        if price_int <= 0:
            continue
        price = price_int / 1_000_000_000.0

        side = getattr(r, "side", None)
        side_char = side.value if hasattr(side, "value") else str(side)
        if side_char not in ("A", "B", "N"):
            side_char = "N"

        yield Trade(
            ts_event_ns=int(r.ts_event),
            instrument_id=int(r.instrument_id),
            price=price,
            size=int(r.size),
            side=side_char,
            flags=flags,
        )


def load_symbology(path: Path | str) -> dict[int, str]:
    """Return {instrument_id: human_symbol} for the file's date.

    Used by symbology.resolve_front_month to map ids back to contract codes
    (e.g. 42140864 -> 'ESM6').
    """
    store = db.DBNStore.from_file(str(path))
    out: dict[int, str] = {}
    for sym, entries in store.symbology.get("mappings", {}).items():
        for e in entries:
            try:
                out[int(e["symbol"])] = sym
            except (KeyError, ValueError, TypeError):
                continue
    return out
