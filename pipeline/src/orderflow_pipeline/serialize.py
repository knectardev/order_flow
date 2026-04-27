"""Serialize aggregated bars into per-session JSON files + an index.json manifest.

Per-session JSON shape (consumed by the dashboard's `loadSessionFromUrl`):

    {
      "symbol":       "ES",
      "contract":     "ESM6",
      "date":         "2026-04-21",
      "session":      "rth",
      "sessionStart": "2026-04-21T13:30:00Z",
      "sessionEnd":   "2026-04-21T20:00:00Z",
      "tunings":      { ... see DEFAULT_TUNINGS ... },
      "bars":         [ ...AggregateResult.bars, each via Bar.to_json()... ]
    }

Plan refs: §3.6, §3.7, §5 (file layout).
"""
from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .aggregate import AggregateResult


# Defaults match the synthetic dashboard's hardcoded constants exactly so
# downstream behavior is identical until calibration overrides them.
DEFAULT_TUNINGS = {
    "sweepVolMult":         1.65,
    "absorbVolMult":        1.75,
    "absorbRangeMult":      0.55,
    "divergenceFlowMult":   0.6,
    "largePrintThreshold":  50,
    "depthBucketing":       "session-quintiles",
}


def _ns_to_iso(ns: int | None) -> str | None:
    if ns is None:
        return None
    return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def write_session_json(
    result: AggregateResult,
    *,
    out_dir: Path,
    symbol: str,
    contract: str,
    tunings: dict | None = None,
) -> Path:
    """Write one session's bars to <out_dir>/<symbol>_<date>_<session>.json.

    Returns the written path.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    if result.session_date is None:
        raise ValueError("AggregateResult.session_date is required for serialization")

    fname = f"{symbol.lower()}_{result.session_date.isoformat()}_{result.session}.json"
    path = out_dir / fname

    payload = {
        "symbol":        symbol,
        "contract":      contract,
        "date":          result.session_date.isoformat(),
        "session":       result.session,
        "sessionStart":  _ns_to_iso(result.session_start_ns),
        "sessionEnd":    _ns_to_iso(result.session_end_ns),
        "tunings":       tunings or DEFAULT_TUNINGS,
        "bars":          [b.to_json() for b in result.bars],
    }

    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
        f.write("\n")
    return path


def write_index(
    sessions: list[dict],
    *,
    out_dir: Path,
    merge_existing: bool = True,
) -> Path:
    """Write data/bars/index.json listing all session files in chronological order.

    `sessions` items shape:
        {"file": "es_2026-04-21_rth.json", "date": "2026-04-21",
         "symbol": "ES", "contract": "ESM6", "session": "rth",
         "barCount": 390, "sessionStart": "...", "sessionEnd": "..."}

    When `merge_existing` is True (default) and an `index.json` already exists at
    `out_dir`, its entries are merged with the new ones — keyed by (date, session,
    symbol). New entries from this run replace existing entries with the same
    key, so re-aggregating a date refreshes its row but does not blow away
    sessions produced by earlier runs (e.g. a different raw_dir batch).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "index.json"

    merged: dict[tuple[str, str, str], dict] = {}
    if merge_existing and path.exists():
        try:
            with path.open("r", encoding="utf-8") as f:
                prev = json.load(f)
            for s in prev.get("sessions", []):
                key = (s.get("date", ""), s.get("session", ""), s.get("symbol", ""))
                merged[key] = s
        except (OSError, json.JSONDecodeError):
            # Corrupt or unreadable index — fall back to a clean rewrite.
            merged = {}

    for s in sessions:
        key = (s.get("date", ""), s.get("session", ""), s.get("symbol", ""))
        merged[key] = s

    sessions_sorted = sorted(
        merged.values(), key=lambda s: (s["date"], s.get("session", ""))
    )

    payload = {
        "version":  1,
        "sessions": sessions_sorted,
    }
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    return path
