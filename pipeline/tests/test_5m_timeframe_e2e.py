"""5m timeframe: aggregate → regime stamps → DuckDB → FastAPI GET /bars.

Requires ``fastapi`` (see ``api/requirements.txt``); skipped otherwise so
pipeline-only installs keep passing ``pytest pipeline/tests/test_aggregate.py``.
"""
from __future__ import annotations

import importlib
import sys
from datetime import date, datetime, time as dtime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

_PIPELINE_TESTS_DIR = Path(__file__).resolve().parent
_PIPELINE_SRC = _PIPELINE_TESTS_DIR.parent / "src"
_REPO_ROOT = _PIPELINE_TESTS_DIR.parent.parent

for _p in (_PIPELINE_SRC, _REPO_ROOT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from orderflow_pipeline import db as db_module  # noqa: E402
from orderflow_pipeline.aggregate import BIN_NS_BY_TIMEFRAME, aggregate_trades  # noqa: E402
from orderflow_pipeline.cli import _stamp_parent_bias, _stamp_ranks, _write_session_to_db  # noqa: E402
from orderflow_pipeline.decode import Trade  # noqa: E402

SESSION_DATE = date(2026, 4, 21)
FRONT_ID = 42140864
ET = ZoneInfo("America/New_York")
UTC = timezone.utc


def _ts_ns_at(hour: int, minute: int, *, sd: date = SESSION_DATE) -> int:
    dt_et = datetime.combine(sd, dtime(hour, minute), tzinfo=ET)
    return int(dt_et.astimezone(UTC).timestamp() * 1e9)


def _trade(ts_ns: int, *, price: float, size: int, side: str = "A") -> Trade:
    return Trade(
        ts_event_ns=ts_ns,
        instrument_id=FRONT_ID,
        price=price,
        size=size,
        side=side,
        flags=0,
    )


def _full_session_one_trade_per_minute() -> list[Trade]:
    """Mirror ``test_aggregate._full_session_one_trade_per_minute`` for regime density."""
    trades = []
    base_ns = _ts_ns_at(9, 30)
    ns_per_minute = 60 * 10**9
    for m in range(390):
        trades.append(
            _trade(
                base_ns + m * ns_per_minute + 1_000_000_000,
                price=4500.0 + (m % 7) * 0.25,
                size=2,
                side="A",
            )
        )
    return trades


def test_5m_aggregate_regime_api_bars(monkeypatch, tmp_path):
    db_file = tmp_path / "five.duckdb"
    monkeypatch.setenv("ORDERFLOW_DB_PATH", str(db_file.resolve()))

    import api.main as api_main

    importlib.reload(api_main)

    trades = _full_session_one_trade_per_minute()
    bin_ns = BIN_NS_BY_TIMEFRAME["5m"]
    result = aggregate_trades(
        trades,
        front_month_id=FRONT_ID,
        session_date=SESSION_DATE,
        bin_ns=bin_ns,
        timeframe="5m",
    )
    n_bins = len(result.bars)
    assert n_bins == 78

    con = db_module.connect(db_file)
    db_module.init_schema(con)
    try:
        _stamp_ranks(result.bars, SESSION_DATE, "5m", None)
        _write_session_to_db(
            con,
            result,
            SESSION_DATE,
            "5m",
            swing_lookback=5,
            divergence_enabled=False,
        )
        _stamp_parent_bias(con, SESSION_DATE, "5m")
    finally:
        con.close()

    client = TestClient(api_main.app)
    res = client.get(
        "/bars",
        params={
            "timeframe": "5m",
            "from": "2026-04-21T13:30:00Z",
            "to": "2026-04-21T21:00:00Z",
        },
    )
    assert res.status_code == 200, res.text
    payload = res.json()
    assert payload["timeframe"] == "5m"
    bars = payload["bars"]
    assert len(bars) == n_bins
    ranked = [b for b in bars if b.get("vRank") is not None]
    assert ranked, "expected at least one bar with vRank past warmup"
    last = bars[-1]
    assert "biasH1" in last and "bias15m" in last
    assert last.get("volScore") is not None or last.get("vRank") is not None

    bad = client.get(
        "/bars",
        params={
            "timeframe": "9m",
            "from": "2026-04-21T13:30:00Z",
            "to": "2026-04-21T21:00:00Z",
        },
    )
    assert bad.status_code == 400
