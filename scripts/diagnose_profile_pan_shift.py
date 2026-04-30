"""Capture and compare /profile responses for two panned windows.

This script mirrors the 1m profile-window selection path in priceChart:
  - visible bars: allBars[max(0, end-visible):end]
  - 1m scope: keep only bars from the right-edge bar's session_date
  - fetch /profile?timeframe=...&from=...&to=...

Usage example:
  python scripts/diagnose_profile_pan_shift.py --end-a 1800 --end-b 1803
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen

import duckdb


def _iso_z(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


@dataclass
class Window:
    end: int
    start: int
    session_date: str
    from_iso: str
    to_iso: str


def _load_bars(db_path: Path, timeframe: str) -> list[dict[str, Any]]:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        rows = con.execute(
            """
            SELECT bar_time, session_date, open, high, low, close
            FROM bars
            WHERE timeframe = ?
            ORDER BY bar_time
            """,
            [timeframe],
        ).fetchall()
    finally:
        con.close()
    out: list[dict[str, Any]] = []
    for bt, sd, o, h, l, c in rows:
        out.append(
            {
                "bar_time": bt,
                "session_date": sd.isoformat() if sd is not None else "",
                "open": float(o),
                "high": float(h),
                "low": float(l),
                "close": float(c),
            }
        )
    return out


def _window_for_end(bars: list[dict[str, Any]], end: int, visible_bars: int) -> Window:
    n = len(bars)
    if n == 0:
        raise ValueError("No bars found for timeframe.")
    if end < 1 or end > n:
        raise ValueError(f"end must be in [1, {n}], got {end}")
    start = max(0, end - visible_bars)
    viewed = bars[start:end]
    right = bars[end - 1]
    sess = right["session_date"]
    # 1m behavior in priceChart.js: scope profile bars to right-edge session.
    scoped = [b for b in viewed if b["session_date"] == sess]
    if not scoped:
        scoped = viewed
    return Window(
        end=end,
        start=start,
        session_date=sess,
        from_iso=_iso_z(scoped[0]["bar_time"]),
        to_iso=_iso_z(scoped[-1]["bar_time"]),
    )


def _fetch_profile(api_base: str, timeframe: str, from_iso: str, to_iso: str) -> dict[str, Any]:
    q = urlencode({"timeframe": timeframe, "from": from_iso, "to": to_iso})
    url = f"{api_base.rstrip('/')}/profile?{q}"
    with urlopen(url) as resp:  # nosec B310 - local/dev endpoint
        raw = resp.read().decode("utf-8")
    data = json.loads(raw)
    data["_url"] = url
    return data


def _summary(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "from": payload.get("from"),
        "to": payload.get("to"),
        "pocPrice": payload.get("pocPrice"),
        "vahPrice": payload.get("vahPrice"),
        "valPrice": payload.get("valPrice"),
        "priceLo": payload.get("priceLo"),
        "priceHi": payload.get("priceHi"),
        "binsLen": len(payload.get("bins", []) or []),
        "maxBin": payload.get("maxBin"),
        "totalVolume": payload.get("total_volume"),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-path", default="data/orderflow.duckdb")
    ap.add_argument("--api-base", default="http://127.0.0.1:8001")
    ap.add_argument("--timeframe", default="1m")
    ap.add_argument("--visible-bars", type=int, default=60)
    ap.add_argument("--end-a", type=int, required=True)
    ap.add_argument("--end-b", type=int, required=True)
    ap.add_argument("--out-dir", default="tmp/profile_pan_shift")
    args = ap.parse_args()

    bars = _load_bars(Path(args.db_path), args.timeframe)
    wa = _window_for_end(bars, args.end_a, args.visible_bars)
    wb = _window_for_end(bars, args.end_b, args.visible_bars)

    pa = _fetch_profile(args.api_base, args.timeframe, wa.from_iso, wa.to_iso)
    pb = _fetch_profile(args.api_base, args.timeframe, wb.from_iso, wb.to_iso)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    fa = out_dir / f"profile_end_{wa.end}.json"
    fb = out_dir / f"profile_end_{wb.end}.json"
    fa.write_text(json.dumps(pa, indent=2), encoding="utf-8")
    fb.write_text(json.dumps(pb, indent=2), encoding="utf-8")

    sa = _summary(pa)
    sb = _summary(pb)
    diff = {
        k: {"a": sa.get(k), "b": sb.get(k)}
        for k in sa
        if sa.get(k) != sb.get(k)
    }

    print("Window A:", wa)
    print("Window B:", wb)
    print("URL A:", pa["_url"])
    print("URL B:", pb["_url"])
    print("Summary A:", json.dumps(sa, indent=2))
    print("Summary B:", json.dumps(sb, indent=2))
    print("Diff:", json.dumps(diff, indent=2))
    print("Saved:", fa)
    print("Saved:", fb)


if __name__ == "__main__":
    main()

