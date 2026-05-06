from __future__ import annotations

from datetime import datetime

from orderflow_pipeline.backtest_engine import filter_fires_by_entry_gates


def test_filter_fires_rank_gate_drops_bad_orb_cell() -> None:
    ts = datetime(2026, 1, 26, 14, 35)
    fires = {ts: [{"bar_time": ts, "watch_id": "orb", "direction": "up", "price": 100.0}]}
    bars = {ts: {"bar_time": ts, "v_rank": 1, "d_rank": 1, "trade_context": "favorable"}}
    out = filter_fires_by_entry_gates(
        fires,
        bars,
        rank_gate_enabled=True,
        trade_context_gate_enabled=False,
        trade_context_allowed=frozenset(),
    )
    assert ts not in out


def test_filter_fires_trade_context_requires_membership() -> None:
    ts = datetime(2026, 1, 26, 14, 35)
    fires = {
        ts: [{"bar_time": ts, "watch_id": "breakout", "direction": "up", "price": 100.0}],
    }
    bars = {ts: {"bar_time": ts, "v_rank": 3, "d_rank": 3, "trade_context": "avoid"}}
    out = filter_fires_by_entry_gates(
        fires,
        bars,
        rank_gate_enabled=False,
        trade_context_gate_enabled=True,
        trade_context_allowed=frozenset({"favorable"}),
    )
    assert ts not in out


def test_filter_fires_passes_when_gates_off() -> None:
    ts = datetime(2026, 1, 26, 14, 35)
    batch = [{"bar_time": ts, "watch_id": "breakout", "direction": "up", "price": 100.0}]
    fires = {ts: batch}
    bars = {ts: {"bar_time": ts, "trade_context": "avoid"}}
    out = filter_fires_by_entry_gates(
        fires,
        bars,
        rank_gate_enabled=False,
        trade_context_gate_enabled=False,
        trade_context_allowed=frozenset({"favorable"}),
    )
    assert out == fires
