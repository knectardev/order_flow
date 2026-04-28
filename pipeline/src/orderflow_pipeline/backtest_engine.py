"""Simple fire-driven backtesting engine for API-triggered runs."""
from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from uuid import uuid4

import duckdb

from . import db as db_module
from .strategies.legacy_fallback_logic import config_for_timeframe, derive_fires_from_bars


def _safe_float(v: float | int | None, default: float = 0.0) -> float:
    if v is None:
        return default
    return float(v)


@dataclass(slots=True)
class BrokerConfig:
    initial_capital: float = 50_000.0
    qty: int = 1
    slippage_ticks: float = 1.0
    commission_per_side: float = 2.0
    tick_size: float = 0.25
    point_value: float = 50.0


@dataclass(slots=True)
class Position:
    side: int
    qty: int
    entry_time: datetime
    entry_price: float
    watch_id: str
    entry_commission: float
    entry_index: int


class SimulatedBroker:
    """Single-position futures broker with mark-to-market accounting."""

    def __init__(self, config: BrokerConfig) -> None:
        self.config = config
        self.cash = config.initial_capital
        self.realized_pnl = 0.0
        self.unrealized_pnl = 0.0
        self.position: Position | None = None
        self.trade_log: list[dict] = []
        self.equity_curve: list[dict] = []
        self._trade_id = 0

    def _fill_price(self, price: float, side: int) -> float:
        slip = self.config.slippage_ticks * self.config.tick_size
        return price + slip if side > 0 else price - slip

    def _pnl(self, entry: float, exit_: float, side: int, qty: int) -> float:
        points = (exit_ - entry) * side
        return points * self.config.point_value * qty

    def _mark(self, mark_price: float) -> None:
        if self.position is None:
            self.unrealized_pnl = 0.0
            return
        self.unrealized_pnl = self._pnl(
            self.position.entry_price,
            mark_price,
            self.position.side,
            self.position.qty,
        )

    def open_position(self, ts: datetime, px: float, side: int, watch_id: str, bar_idx: int) -> None:
        if self.position is not None:
            return
        fill = self._fill_price(px, side)
        commission = self.config.commission_per_side * self.config.qty
        self.cash -= commission
        self.position = Position(
            side=side,
            qty=self.config.qty,
            entry_time=ts,
            entry_price=fill,
            watch_id=watch_id,
            entry_commission=commission,
            entry_index=bar_idx,
        )
        self._mark(fill)

    def close_position(self, ts: datetime, px: float, reason: str, bar_idx: int) -> None:
        if self.position is None:
            return
        pos = self.position
        fill = self._fill_price(px, -pos.side)
        exit_commission = self.config.commission_per_side * pos.qty
        gross = self._pnl(pos.entry_price, fill, pos.side, pos.qty)
        net = gross - pos.entry_commission - exit_commission
        self.cash += gross - exit_commission
        self.realized_pnl += net
        self.unrealized_pnl = 0.0
        self._trade_id += 1
        self.trade_log.append(
            {
                "trade_id": self._trade_id,
                "watch_id": pos.watch_id,
                "entry_time": pos.entry_time,
                "exit_time": ts,
                "direction": "long" if pos.side > 0 else "short",
                "qty": pos.qty,
                "entry_price": round(pos.entry_price, 6),
                "exit_price": round(fill, 6),
                "gross_pnl": round(gross, 6),
                "commission": round(pos.entry_commission + exit_commission, 6),
                "net_pnl": round(net, 6),
                "bars_held": max(1, bar_idx - pos.entry_index),
                "exit_reason": reason,
            }
        )
        self.position = None

    def mark_to_market(self, ts: datetime, mark_price: float) -> None:
        self._mark(mark_price)
        equity = self.cash + self.unrealized_pnl
        self.equity_curve.append(
            {
                "bar_time": ts,
                "equity": round(equity, 6),
                "cash": round(self.cash, 6),
                "unrealized_pnl": round(self.unrealized_pnl, 6),
                "realized_pnl": round(self.realized_pnl, 6),
            }
        )

    def has_open_position(self) -> bool:
        return self.position is not None


class BacktestEngine:
    def __init__(self, con: duckdb.DuckDBPyConnection) -> None:
        self.con = con

    def _load_bars(self, timeframe: str, from_time: datetime, to_time: datetime) -> list[dict]:
        cur = self.con.execute(
            """
            SELECT bar_time, open, high, low, close, volume
            FROM bars
            WHERE timeframe = ? AND bar_time BETWEEN ? AND ?
            ORDER BY bar_time
            """,
            [timeframe, from_time, to_time],
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    def _load_fires(
        self,
        timeframe: str,
        from_time: datetime,
        to_time: datetime,
        watch_ids: set[str] | None = None,
    ) -> dict[datetime, list[dict]]:
        where_watch = ""
        params: list = [timeframe, from_time, to_time]
        if watch_ids:
            ph = ",".join(["?"] * len(watch_ids))
            where_watch = f" AND watch_id IN ({ph})"
            params.extend(sorted(watch_ids))
        cur = self.con.execute(
            """
            SELECT bar_time, watch_id, direction, price
            FROM fires
            WHERE timeframe = ? AND bar_time BETWEEN ? AND ?
            """
            + where_watch
            + """
            ORDER BY bar_time
            """,
            params,
        )
        cols = [d[0] for d in cur.description]
        by_time: dict[datetime, list[dict]] = {}
        for row in cur.fetchall():
            item = dict(zip(cols, row))
            by_time.setdefault(item["bar_time"], []).append(item)
        return by_time

    @staticmethod
    def _derive_fires_from_bars(
        bars: list[dict],
        timeframe: str,
        watch_ids: set[str] | None = None,
        use_regime_filter: bool = True,
    ) -> dict[datetime, list[dict]]:
        return derive_fires_from_bars(
            bars,
            watch_ids=watch_ids,
            config=config_for_timeframe(timeframe, use_regime_filter=use_regime_filter),
        )

    @staticmethod
    def _signal_side(watch_id: str, direction: str | None) -> int | None:
        if direction not in {"up", "down"}:
            return None
        if watch_id == "breakout":
            return 1 if direction == "up" else -1
        if watch_id in {"fade", "valueEdgeReject", "absorptionWall"}:
            return -1 if direction == "up" else 1
        return None

    @staticmethod
    def _max_drawdown(equity: list[dict]) -> float:
        peak = None
        max_dd = 0.0
        for p in equity:
            e = _safe_float(p.get("equity"))
            if peak is None or e > peak:
                peak = e
            if peak and peak > 0:
                dd = (peak - e) / peak
                if dd > max_dd:
                    max_dd = dd
        return max_dd

    @staticmethod
    def _simple_sharpe(equity: list[dict]) -> float | None:
        if len(equity) < 3:
            return None
        returns: list[float] = []
        prev = _safe_float(equity[0].get("equity"), 1.0)
        for pt in equity[1:]:
            cur = _safe_float(pt.get("equity"), prev)
            if prev != 0:
                returns.append((cur - prev) / prev)
            prev = cur
        if len(returns) < 2:
            return None
        mean = sum(returns) / len(returns)
        var = sum((x - mean) ** 2 for x in returns) / (len(returns) - 1)
        stdev = var ** 0.5
        if stdev == 0:
            return None
        return (mean / stdev) * (len(returns) ** 0.5)

    def run(
        self,
        *,
        timeframe: str,
        from_time: datetime,
        to_time: datetime,
        config: BrokerConfig,
        watch_ids: set[str] | None = None,
        use_regime_filter: bool = True,
    ) -> dict:
        bars = self._load_bars(timeframe, from_time, to_time)
        if not bars:
            raise ValueError("No bars in requested window.")
        signal_source = "db"
        if use_regime_filter:
            fires_by_time = self._load_fires(timeframe, from_time, to_time, watch_ids=watch_ids)
            if not fires_by_time:
                scope = sorted(watch_ids) if watch_ids else ["all"]
                raise ValueError(
                    "No DB fires in requested window/scope. Rebuild pipeline fires first "
                    f"(scope={scope}, timeframe={timeframe})."
                )
        else:
            # Compare-path behavior: run the exact extracted strategy logic
            # with regime gates disabled so ON/OFF produce genuinely distinct
            # fire streams while keeping the same bar inputs and broker logic.
            fires_by_time = self._derive_fires_from_bars(
                bars,
                timeframe,
                watch_ids=watch_ids,
                use_regime_filter=False,
            )
            signal_source = "derived_no_regime"
            if not fires_by_time:
                scope = sorted(watch_ids) if watch_ids else ["all"]
                raise ValueError(
                    "No derived fires in requested window/scope for regime-filter OFF "
                    f"(scope={scope}, timeframe={timeframe})."
                )
        broker = SimulatedBroker(config)
        skipped_fires: list[dict] = []

        def log_skip(fire: dict, reason_code: str, detail: dict | None = None) -> None:
            pos = broker.position
            skipped_fires.append(
                {
                    "bar_time": fire["bar_time"],
                    "watch_id": fire.get("watch_id") or "unknown",
                    "direction": fire.get("direction"),
                    "reason_code": reason_code,
                    "price": float(fire.get("price")) if fire.get("price") is not None else None,
                    "position_side_before": pos.side if pos else None,
                    "position_size_before": pos.qty if pos else None,
                    "reason_detail_json": json.dumps(detail or {}),
                }
            )

        for idx, bar in enumerate(bars):
            ts = bar["bar_time"]
            fire_batch = fires_by_time.get(ts, [])
            for fire in fire_batch:
                side = self._signal_side(fire["watch_id"], fire.get("direction"))
                if side is None:
                    log_skip(fire, "invalid_direction")
                    continue
                if not broker.has_open_position():
                    broker.open_position(ts, _safe_float(fire.get("price"), _safe_float(bar.get("close"))), side, fire["watch_id"], idx)
                    continue
                if broker.position and broker.position.side != side:
                    broker.close_position(ts, _safe_float(fire.get("price"), _safe_float(bar.get("close"))), "flip", idx)
                    broker.open_position(ts, _safe_float(fire.get("price"), _safe_float(bar.get("close"))), side, fire["watch_id"], idx)
                    continue
                log_skip(fire, "already_in_position_same_side")
            broker.mark_to_market(ts, _safe_float(bar.get("close")))

        last_bar = bars[-1]
        if broker.has_open_position():
            broker.close_position(last_bar["bar_time"], _safe_float(last_bar.get("close")), "end_of_window", len(bars))
            broker.mark_to_market(last_bar["bar_time"], _safe_float(last_bar.get("close")))

        closed = broker.trade_log
        wins = [t for t in closed if _safe_float(t.get("net_pnl")) > 0]
        win_rate = (len(wins) / len(closed)) if closed else None
        start_equity = config.initial_capital
        end_equity = _safe_float(broker.equity_curve[-1]["equity"] if broker.equity_curve else start_equity, start_equity)
        net_pnl = end_equity - start_equity
        sharpe = self._simple_sharpe(broker.equity_curve)
        max_dd = self._max_drawdown(broker.equity_curve)
        entry_px = _safe_float(bars[0].get("close"))
        benchmark_points = [
            {
                "bar_time": b["bar_time"],
                "strategy": "buy_hold",
                "equity": round(
                    config.initial_capital
                    + ((float(b["close"]) - entry_px) * config.point_value * config.qty),
                    6,
                ),
            }
            for b in bars
        ]

        run_id = str(uuid4())
        created_at = datetime.utcnow()
        skip_counts = Counter([s["reason_code"] for s in skipped_fires])

        run_row = {
            "run_id": run_id,
            "created_at": created_at,
            "timeframe": timeframe,
            "from_time": from_time,
            "to_time": to_time,
            "initial_capital": config.initial_capital,
            "qty": config.qty,
            "slippage_ticks": config.slippage_ticks,
            "commission_per_side": config.commission_per_side,
            "tick_size": config.tick_size,
            "point_value": config.point_value,
            "trade_count": len(closed),
            "win_rate": win_rate,
            "sharpe": sharpe,
            "max_drawdown": max_dd,
            "net_pnl": net_pnl,
            "metadata_json": json.dumps(
                {
                    "bars": len(bars),
                    "fires": sum(len(v) for v in fires_by_time.values()),
                    "watch_ids": sorted(watch_ids) if watch_ids else ["all"],
                    "fire_source": signal_source,
                    "use_regime_filter": bool(use_regime_filter),
                    "skipped_fires": dict(skip_counts),
                }
            ),
        }
        trade_rows = [{**t, "run_id": run_id} for t in closed]
        skipped_rows = [{**s, "run_id": run_id} for s in skipped_fires]
        benchmark_rows = [{**p, "run_id": run_id} for p in benchmark_points]
        # Guard against duplicate timestamps (e.g. final flatten + mark in same bar).
        eq_by_time: dict[datetime, dict] = {}
        for p in broker.equity_curve:
            eq_by_time[p["bar_time"]] = p
        equity_rows = [{**p, "run_id": run_id} for _, p in sorted(eq_by_time.items(), key=lambda kv: kv[0])]
        db_module.write_backtest_results(
            self.con,
            run_row,
            trade_rows,
            equity_rows,
            benchmark_points=benchmark_rows,
            skipped_fires=skipped_rows,
        )
        return {
            "runId": run_id,
            "timeframe": timeframe,
            "from": from_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "to": to_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tradeCount": len(closed),
            "winRate": win_rate,
            "sharpe": sharpe,
            "maxDrawdown": max_dd,
            "netPnl": net_pnl,
            "initialCapital": config.initial_capital,
            "endingEquity": end_equity,
            "scope": sorted(watch_ids) if watch_ids else ["all"],
            "signalSource": signal_source,
            "useRegimeFilter": bool(use_regime_filter),
            "skippedFires": dict(skip_counts),
        }
