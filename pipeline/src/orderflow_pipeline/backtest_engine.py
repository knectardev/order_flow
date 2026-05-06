"""Simple fire-driven backtesting engine for API-triggered runs."""
from __future__ import annotations

import json
from collections import Counter
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any
from datetime import datetime
from uuid import uuid4

import duckdb

from . import db as db_module
from .strategies.exit_ticks import resolve_exit_ticks
from .strategies.legacy_fallback_logic import config_for_timeframe, derive_fires_from_bars
from .strategies.opening_range_breakout import ORB_WATCH_ID, _rank_gate
from .strategies.regime_exit_scale import RegimeExitScaleParams, apply_regime_exit_scale

RUNTIME_DERIVED_WATCH_IDS = frozenset({"orb"})

_BUY_HOLD_CACHE_MAX = 24
_BUY_HOLD_CACHE: "OrderedDict[tuple, list[dict]]" = OrderedDict()


def _safe_float(v: float | int | None, default: float = 0.0) -> float:
    if v is None:
        return default
    return float(v)


def gap_blocks_next_bar_entry(
    bars: list[dict],
    signal_idx: int,
    tick_size: float,
    gap_max_ticks: float | None,
) -> bool:
    """True when gap guard rejects a fill deferred from signal bar to next bar open."""
    if gap_max_ticks is None or gap_max_ticks <= 0:
        return False
    if signal_idx + 1 >= len(bars):
        return True
    close_sig = _safe_float(bars[signal_idx].get("close"))
    open_next = _safe_float(bars[signal_idx + 1].get("open"))
    return abs(open_next - close_sig) > float(gap_max_ticks) * tick_size


def signal_bar_allows_next_bar_entry(
    bars: list[dict],
    signal_idx: int,
    *,
    entry_next_bar_open: bool,
    tick_size: float,
    gap_max_ticks: float | None,
) -> bool:
    """Whether a fire on signal_idx can complete a deferred entry (NH eligibility vs _simulate)."""
    if not entry_next_bar_open:
        return True
    if signal_idx + 1 >= len(bars):
        return False
    return not gap_blocks_next_bar_entry(bars, signal_idx, tick_size, gap_max_ticks)


_ORB_STRUCTURE_SL_BUFFER_TICKS = 4.0


def filter_fires_by_entry_gates(
    fires_by_time: dict[datetime, list[dict]],
    bars_by_time: dict[datetime, dict],
    *,
    rank_gate_enabled: bool,
    trade_context_gate_enabled: bool,
    trade_context_allowed: frozenset[str],
) -> dict[datetime, list[dict]]:
    """Drop DB-originated fires whose signal bar fails rank / trade_context gates (ORB rank applies only to `orb`)."""
    if not rank_gate_enabled and not trade_context_gate_enabled:
        return fires_by_time
    out: dict[datetime, list[dict]] = {}
    for ts, batch in fires_by_time.items():
        kept: list[dict] = []
        bar = bars_by_time.get(ts)
        for fire in batch:
            wid = str(fire.get("watch_id") or "")
            if rank_gate_enabled and wid == ORB_WATCH_ID:
                if bar is None or not _rank_gate(bar):
                    continue
            if trade_context_gate_enabled:
                if bar is None:
                    continue
                tc = bar.get("trade_context")
                if tc is None or str(tc) not in trade_context_allowed:
                    continue
            kept.append(fire)
        if kept:
            out[ts] = kept
    return out


def _entry_trade_context_from_bar(bar: dict | None) -> str | None:
    if not bar:
        return None
    tc = bar.get("trade_context")
    if tc is None or tc == "":
        return None
    return str(tc)


def _orb_structure_sl_floor_ticks(
    fire: dict,
    side: int,
    eff_sl_ticks: float | None,
    *,
    broker_stop_loss_ticks: float | None,
    tick_size: float,
) -> float | None:
    """Floor simulated ORB stop distance so protective stop can sit beyond opposite OR extreme.

    Without this, a fixed template (e.g. 20 ticks) tags stops mid-structure when entries occur
    well inside extension above/below the opening range — realistic pullback shakes out before trend.

    Skipped when the operator sets a run-wide broker SL override.
    """
    if broker_stop_loss_ticks is not None:
        return eff_sl_ticks
    if eff_sl_ticks is None:
        return None
    if str(fire.get("watch_id")) != "orb":
        return eff_sl_ticks
    diag = fire.get("diagnostics")
    if not isinstance(diag, dict):
        return eff_sl_ticks
    px = fire.get("price")
    if px is None:
        return eff_sl_ticks
    try:
        entry = float(px)
    except (TypeError, ValueError):
        return eff_sl_ticks
    if tick_size <= 0:
        return eff_sl_ticks
    buf = float(_ORB_STRUCTURE_SL_BUFFER_TICKS)
    try:
        if side > 0:
            ol = diag.get("or_low")
            if ol is None:
                return eff_sl_ticks
            structural = (float(entry) - float(ol)) / tick_size + buf
        else:
            oh = diag.get("or_high")
            if oh is None:
                return eff_sl_ticks
            structural = (float(oh) - float(entry)) / tick_size + buf
    except (TypeError, ValueError):
        return eff_sl_ticks
    structural = max(0.0, structural)
    return max(float(eff_sl_ticks), structural)


def barrier_prices_from_ticks(
    entry_fill: float,
    side: int,
    tick_size: float,
    stop_ticks: float | None,
    tp_ticks: float | None,
) -> tuple[float | None, float | None]:
    """Absolute barrier prices from entry fill and tick distances (after entry slip)."""
    if stop_ticks is None and tp_ticks is None:
        return None, None
    if side > 0:
        stop_px = entry_fill - stop_ticks * tick_size if stop_ticks is not None else None
        tp_px = entry_fill + tp_ticks * tick_size if tp_ticks is not None else None
        return stop_px, tp_px
    stop_px = entry_fill + stop_ticks * tick_size if stop_ticks is not None else None
    tp_px = entry_fill - tp_ticks * tick_size if tp_ticks is not None else None
    return stop_px, tp_px


def intrabar_stop_take_hit(
    *,
    side: int,
    high: float,
    low: float,
    stop_px: float | None,
    tp_px: float | None,
) -> tuple[str | None, float | None]:
    """Return ``(exit_reason, exit_barrier_price)`` if OHLC triggers SL/TP.

    Risk-first: if both barriers trade through within the same bar, assume the
    stop triggers first (conservative vs taking profit).
    """
    if side > 0:
        hit_stop = stop_px is not None and low <= stop_px
        hit_tp = tp_px is not None and high >= tp_px
        if hit_stop and hit_tp:
            return "stop_loss", stop_px
        if hit_stop:
            return "stop_loss", stop_px
        if hit_tp:
            return "take_profit", tp_px
        return None, None
    hit_stop = stop_px is not None and high >= stop_px
    hit_tp = tp_px is not None and low <= tp_px
    if hit_stop and hit_tp:
        return "stop_loss", stop_px
    if hit_stop:
        return "stop_loss", stop_px
    if hit_tp:
        return "take_profit", tp_px
    return None, None


@dataclass(slots=True)
class BrokerConfig:
    initial_capital: float = 50_000.0
    qty: int = 1
    slippage_ticks: float = 1.0
    commission_per_side: float = 2.0
    tick_size: float = 0.25
    point_value: float = 50.0
    # Run-wide SL/TP in ticks; if either is set, applies to every new position for the run.
    stop_loss_ticks: float | None = None
    take_profit_ticks: float | None = None
    # Optional regime-based scaling of strategy template ticks (ignored when broker SL/TP override set).
    regime_exit_scale_enabled: bool = False
    regime_exit_scale_mode: str = "range_pct"  # "range_pct" | "v_rank"
    regime_sl_mult_min: float = 0.75
    regime_sl_mult_max: float = 1.25
    regime_tp_mult_min: float = 0.75
    regime_tp_mult_max: float = 1.25
    regime_sl_floor_ticks: float | None = None
    regime_v_rank_sl_mults: tuple[float, float, float, float, float] = (
        0.85,
        0.92,
        1.0,
        1.08,
        1.15,
    )
    regime_v_rank_tp_mults: tuple[float, float, float, float, float] = (
        0.85,
        0.92,
        1.0,
        1.08,
        1.15,
    )


def regime_exit_params_from_config(config: BrokerConfig) -> RegimeExitScaleParams:
    return RegimeExitScaleParams(
        regime_exit_scale_enabled=config.regime_exit_scale_enabled,
        regime_exit_scale_mode=config.regime_exit_scale_mode,
        regime_sl_mult_min=config.regime_sl_mult_min,
        regime_sl_mult_max=config.regime_sl_mult_max,
        regime_tp_mult_min=config.regime_tp_mult_min,
        regime_tp_mult_max=config.regime_tp_mult_max,
        regime_sl_floor_ticks=config.regime_sl_floor_ticks,
        regime_v_rank_sl_mults=config.regime_v_rank_sl_mults,
        regime_v_rank_tp_mults=config.regime_v_rank_tp_mults,
    )


@dataclass(frozen=True, slots=True)
class ExecutionPolicy:
    """Configurable exit / flip semantics for the simulated single-position broker."""

    ignore_same_side_fire_when_open: bool = True
    flip_on_opposite_fire: bool = True
    exit_on_stop_loss: bool = True
    exit_on_take_profit: bool = True
    close_at_end_of_window: bool = True
    # Integrity: fill new entries at next bar open (signal still on signal bar).
    entry_next_bar_open: bool = False
    # When set with entry_next_bar_open, skip deferred entry if |open(next)-close(signal)| exceeds this (ticks).
    entry_gap_guard_max_ticks: float | None = None

    def validate(self) -> None:
        """Raise ValueError when policy rules cannot produce any exit path."""
        if not self.ignore_same_side_fire_when_open:
            raise ValueError(
                "ignore_same_side_fire_when_open=false is not supported (single-position broker; "
                "pyramiding not implemented)"
            )
        mechanical_allowed = self.exit_on_stop_loss or self.exit_on_take_profit
        if (
            not self.flip_on_opposite_fire
            and not mechanical_allowed
            and not self.close_at_end_of_window
        ):
            raise ValueError(
                "execution policy deadlock: enable flip_on_opposite_fire, exit_on_stop_loss / "
                "exit_on_take_profit, or close_at_end_of_window"
            )
        if self.entry_gap_guard_max_ticks is not None and self.entry_gap_guard_max_ticks < 0:
            raise ValueError("entry_gap_guard_max_ticks must be non-negative when set")

    def to_metadata_dict(self) -> dict[str, Any]:
        return {
            "ignore_same_side_fire_when_open": self.ignore_same_side_fire_when_open,
            "flip_on_opposite_fire": self.flip_on_opposite_fire,
            "exit_on_stop_loss": self.exit_on_stop_loss,
            "exit_on_take_profit": self.exit_on_take_profit,
            "close_at_end_of_window": self.close_at_end_of_window,
            "entry_next_bar_open": self.entry_next_bar_open,
            "entry_gap_guard_max_ticks": self.entry_gap_guard_max_ticks,
        }


@dataclass(slots=True)
class Position:
    side: int
    qty: int
    entry_time: datetime
    entry_price: float
    watch_id: str
    entry_commission: float
    entry_index: int
    stop_price: float | None = None
    take_profit_price: float | None = None
    stop_ticks_effective: float | None = None
    take_profit_ticks_effective: float | None = None
    entry_trade_context: str | None = None


class SimulatedBroker:
    """Single-position futures broker with mark-to-market accounting."""

    def __init__(self, config: BrokerConfig, execution_policy: ExecutionPolicy | None = None) -> None:
        self.config = config
        self.execution_policy = execution_policy or ExecutionPolicy()
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

    def open_position(
        self,
        ts: datetime,
        px: float,
        side: int,
        watch_id: str,
        bar_idx: int,
        *,
        stop_ticks: float | None = None,
        take_profit_ticks: float | None = None,
        entry_trade_context: str | None = None,
    ) -> None:
        if self.position is not None:
            return
        fill = self._fill_price(px, side)
        commission = self.config.commission_per_side * self.config.qty
        self.cash -= commission
        stop_px, tp_px = barrier_prices_from_ticks(
            fill, side, self.config.tick_size, stop_ticks, take_profit_ticks
        )
        self.position = Position(
            side=side,
            qty=self.config.qty,
            entry_time=ts,
            entry_price=fill,
            watch_id=watch_id,
            entry_commission=commission,
            entry_index=bar_idx,
            stop_price=stop_px,
            take_profit_price=tp_px,
            stop_ticks_effective=stop_ticks,
            take_profit_ticks_effective=take_profit_ticks,
            entry_trade_context=entry_trade_context,
        )
        self._mark(fill)

    def try_intrabar_exit(self, ts: datetime, bar_idx: int, high: float, low: float) -> bool:
        """Close position at SL/TP barrier if OHLC breaches a level; returns True if closed."""
        pos = self.position
        if pos is None:
            return False
        pol = self.execution_policy
        eff_stop = pos.stop_price if pol.exit_on_stop_loss else None
        eff_tp = pos.take_profit_price if pol.exit_on_take_profit else None
        reason, barrier_px = intrabar_stop_take_hit(
            side=pos.side,
            high=high,
            low=low,
            stop_px=eff_stop,
            tp_px=eff_tp,
        )
        if reason is None or barrier_px is None:
            return False
        self.close_position(ts, barrier_px, reason, bar_idx)
        return True

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
        eff_sl = pos.stop_ticks_effective
        slip_ratio = None
        if eff_sl is not None and eff_sl > 0:
            slip_ratio = round(float(self.config.slippage_ticks) / float(eff_sl), 6)
        row = {
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
            "stop_loss_ticks_effective": eff_sl,
            "take_profit_ticks_effective": pos.take_profit_ticks_effective,
            "slippage_to_stop_ratio": slip_ratio,
        }
        if pos.entry_trade_context is not None:
            row["entry_trade_context"] = pos.entry_trade_context
        self.trade_log.append(row)
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
            SELECT bar_time, open, high, low, close, volume,
                   session_date, v_rank, d_rank, range_pct, trade_context
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
        *,
        rank_gate_enabled: bool | None = None,
        trade_context_gate_enabled: bool = False,
        trade_context_allowed: frozenset[str] | None = None,
    ) -> dict[datetime, list[dict]]:
        return derive_fires_from_bars(
            bars,
            watch_ids=watch_ids,
            config=config_for_timeframe(timeframe, use_regime_filter=use_regime_filter),
            timeframe=timeframe,
            rank_gate_enabled=rank_gate_enabled,
            trade_context_gate_enabled=trade_context_gate_enabled,
            trade_context_allowed=trade_context_allowed,
        )

    @staticmethod
    def _signal_side(watch_id: str, direction: str | None) -> int | None:
        if direction not in {"up", "down"}:
            return None
        if watch_id in {"breakout", "orb"}:
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

    @staticmethod
    def _buy_hold_equity_points(
        bars: list[dict],
        config: BrokerConfig,
        *,
        timeframe: str,
        from_time: datetime,
        to_time: datetime,
        use_cache: bool,
    ) -> tuple[list[dict], bool]:
        """Return (benchmark_points_without_run_id, cached_flag)."""
        if not use_cache:
            entry_px = _safe_float(bars[0].get("close"))
            return (
                [
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
                ],
                False,
            )
        cache_key = (
            timeframe,
            from_time,
            to_time,
            round(config.initial_capital, 6),
            int(config.qty),
            round(config.point_value, 6),
            len(bars),
        )
        cached = _BUY_HOLD_CACHE.get(cache_key)
        if cached is not None:
            _BUY_HOLD_CACHE.move_to_end(cache_key)
            return [dict(p) for p in cached], True
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
        _BUY_HOLD_CACHE[cache_key] = benchmark_points
        if len(_BUY_HOLD_CACHE) > _BUY_HOLD_CACHE_MAX:
            _BUY_HOLD_CACHE.popitem(last=False)
        return benchmark_points, False

    def _simulate(
        self,
        bars: list[dict],
        fires_by_time: dict[datetime, list[dict]],
        *,
        timeframe: str,
        config: BrokerConfig,
        policy: ExecutionPolicy,
    ) -> tuple[list[dict], list[dict], list[dict]]:
        """Run bar loop; return (trade_log, equity_rows_deduped, skipped_fires)."""
        broker = SimulatedBroker(config, execution_policy=policy)
        skipped_fires: list[dict] = []
        pending: list[dict[str, Any]] = []
        regime_params = regime_exit_params_from_config(config)

        def finalize_exit_ticks(
            tpl_sl: float | None,
            tpl_tp: float | None,
            entry_bar_idx: int,
        ) -> tuple[float | None, float | None]:
            return apply_regime_exit_scale(
                tpl_sl,
                tpl_tp,
                bars[entry_bar_idx],
                regime_params,
                broker_stop_loss_ticks=config.stop_loss_ticks,
                broker_take_profit_ticks=config.take_profit_ticks,
            )

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

        def flush_pending_at_bar_start(entry_bar_idx: int) -> None:
            nonlocal pending
            next_pending: list[dict[str, Any]] = []
            for pend in pending:
                if pend["target_idx"] != entry_bar_idx:
                    next_pending.append(pend)
                    continue
                fire = pend["fire"]
                if broker.has_open_position():
                    log_skip(fire, "already_in_position_same_side")
                    continue
                sig_idx = int(pend["signal_idx"])
                if gap_blocks_next_bar_entry(
                    bars, sig_idx, config.tick_size, policy.entry_gap_guard_max_ticks
                ):
                    close_sig = _safe_float(bars[sig_idx].get("close"))
                    open_px = _safe_float(bars[entry_bar_idx].get("open"))
                    gap_px = abs(open_px - close_sig)
                    tick = config.tick_size if config.tick_size > 0 else 1e-9
                    log_skip(
                        fire,
                        "gap_guard_blocked",
                        {
                            "signal_bar_index": sig_idx,
                            "entry_bar_index": entry_bar_idx,
                            "close_signal": close_sig,
                            "open_next": open_px,
                            "gap_ticks_effective": round(gap_px / tick, 6),
                        },
                    )
                    continue
                entry_bar = bars[entry_bar_idx]
                entry_ts = entry_bar["bar_time"]
                px_open = _safe_float(entry_bar.get("open"))
                eff_sl, eff_tp = finalize_exit_ticks(
                    pend["tpl_sl"], pend["tpl_tp"], entry_bar_idx
                )
                eff_sl = _orb_structure_sl_floor_ticks(
                    pend["fire"],
                    int(pend["side"]),
                    eff_sl,
                    broker_stop_loss_ticks=config.stop_loss_ticks,
                    tick_size=config.tick_size,
                )
                broker.open_position(
                    entry_ts,
                    px_open,
                    int(pend["side"]),
                    str(pend["watch_id"]),
                    entry_bar_idx,
                    stop_ticks=eff_sl,
                    take_profit_ticks=eff_tp,
                    entry_trade_context=_entry_trade_context_from_bar(entry_bar),
                )
            pending = next_pending

        def _orb_skip_intrabar_sl_tp_this_bar(bar_idx: int) -> bool:
            """ORB fills at the breakout extreme; same-bar OHLC would tag tight stops.
            Skip mechanical SL/TP on the entry bar only (flip still uses fire prices).
            """
            pos = broker.position
            return (
                pos is not None
                and str(pos.watch_id) == "orb"
                and int(pos.entry_index) == int(bar_idx)
            )

        def schedule_next_bar_open(
            fire: dict,
            signal_idx: int,
            side: int,
            sl_ticks: float | None,
            tp_ticks: float | None,
        ) -> None:
            if signal_idx + 1 >= len(bars):
                log_skip(
                    fire,
                    "entry_deferred_no_next_bar",
                    {"signal_bar_index": signal_idx},
                )
                return
            pending.append(
                {
                    "target_idx": signal_idx + 1,
                    "signal_idx": signal_idx,
                    "side": side,
                    "watch_id": fire["watch_id"],
                    "tpl_sl": sl_ticks,
                    "tpl_tp": tp_ticks,
                    "fire": fire,
                }
            )

        for idx, bar in enumerate(bars):
            flush_pending_at_bar_start(idx)

            ts = bar["bar_time"]
            high = float(bar["high"])
            low = float(bar["low"])
            if not _orb_skip_intrabar_sl_tp_this_bar(idx):
                broker.try_intrabar_exit(ts, idx, high, low)

            fire_batch = fires_by_time.get(ts, [])
            for fire in fire_batch:
                side = self._signal_side(fire["watch_id"], fire.get("direction"))
                if side is None:
                    log_skip(fire, "invalid_direction")
                    continue
                px_fire = _safe_float(fire.get("price"), _safe_float(bar.get("close")))
                tpl_sl, tpl_tp = resolve_exit_ticks(
                    timeframe,
                    fire["watch_id"],
                    broker_stop_loss_ticks=config.stop_loss_ticks,
                    broker_take_profit_ticks=config.take_profit_ticks,
                )
                if not broker.has_open_position():
                    if policy.entry_next_bar_open:
                        schedule_next_bar_open(fire, idx, side, tpl_sl, tpl_tp)
                    else:
                        eff_sl, eff_tp = finalize_exit_ticks(tpl_sl, tpl_tp, idx)
                        eff_sl = _orb_structure_sl_floor_ticks(
                            fire,
                            side,
                            eff_sl,
                            broker_stop_loss_ticks=config.stop_loss_ticks,
                            tick_size=config.tick_size,
                        )
                        broker.open_position(
                            ts,
                            px_fire,
                            side,
                            fire["watch_id"],
                            idx,
                            stop_ticks=eff_sl,
                            take_profit_ticks=eff_tp,
                            entry_trade_context=_entry_trade_context_from_bar(bar),
                        )
                    continue
                if broker.position and broker.position.side != side:
                    if not policy.flip_on_opposite_fire:
                        log_skip(
                            fire,
                            "flip_disabled",
                            {"incoming_side": side, "position_side": broker.position.side},
                        )
                        continue
                    broker.close_position(ts, px_fire, "flip", idx)
                    if policy.entry_next_bar_open:
                        schedule_next_bar_open(fire, idx, side, tpl_sl, tpl_tp)
                    else:
                        eff_sl, eff_tp = finalize_exit_ticks(tpl_sl, tpl_tp, idx)
                        eff_sl = _orb_structure_sl_floor_ticks(
                            fire,
                            side,
                            eff_sl,
                            broker_stop_loss_ticks=config.stop_loss_ticks,
                            tick_size=config.tick_size,
                        )
                        broker.open_position(
                            ts,
                            px_fire,
                            side,
                            fire["watch_id"],
                            idx,
                            stop_ticks=eff_sl,
                            take_profit_ticks=eff_tp,
                            entry_trade_context=_entry_trade_context_from_bar(bar),
                        )
                    continue
                log_skip(fire, "already_in_position_same_side")

            if not _orb_skip_intrabar_sl_tp_this_bar(idx):
                broker.try_intrabar_exit(ts, idx, high, low)
            broker.mark_to_market(ts, _safe_float(bar.get("close")))

        last_bar = bars[-1]
        if broker.has_open_position():
            if policy.close_at_end_of_window:
                broker.close_position(
                    last_bar["bar_time"],
                    _safe_float(last_bar.get("close")),
                    "end_of_window",
                    len(bars),
                )
            broker.mark_to_market(last_bar["bar_time"], _safe_float(last_bar.get("close")))

        eq_by_time: dict[datetime, dict] = {}
        for p in broker.equity_curve:
            eq_by_time[p["bar_time"]] = p
        equity_rows = [dict(p) for _, p in sorted(eq_by_time.items(), key=lambda kv: kv[0])]
        return broker.trade_log, equity_rows, skipped_fires

    def run(
        self,
        *,
        timeframe: str,
        from_time: datetime,
        to_time: datetime,
        config: BrokerConfig,
        execution_policy: ExecutionPolicy | None = None,
        watch_ids: set[str] | None = None,
        use_regime_filter: bool = True,
        rank_gate_enabled: bool = False,
        trade_context_gate_enabled: bool = False,
        trade_context_allowed: list[str] | None = None,
        fires_by_time: dict[datetime, list[dict]] | None = None,
        signal_source: str | None = None,
        metadata_extra: dict | None = None,
        benchmark_points: list[dict] | None = None,
    ) -> dict:
        policy = execution_policy or ExecutionPolicy()
        policy.validate()
        if watch_ids and "orb" in watch_ids and timeframe.strip() != "5m":
            raise ValueError(
                "Opening range breakout (`orb`) requires timeframe='5m'."
            )
        bars = self._load_bars(timeframe, from_time, to_time)
        if not bars:
            raise ValueError("No bars in requested window.")

        allowed_src = trade_context_allowed if trade_context_allowed is not None else ["favorable"]
        trade_context_allowed_frozen = frozenset(
            str(x).strip() for x in allowed_src if str(x).strip()
        )
        if trade_context_gate_enabled and not trade_context_allowed_frozen:
            raise ValueError(
                "trade_context_allowed must list at least one trade_context when "
                "trade_context_gate_enabled is true."
            )

        if fires_by_time is None:
            sig = "db"
            derived_runtime = (
                watch_ids is not None
                and len(watch_ids) > 0
                and watch_ids.issubset(RUNTIME_DERIVED_WATCH_IDS)
            )
            if derived_runtime:
                fires_by_time = self._derive_fires_from_bars(
                    bars,
                    timeframe,
                    watch_ids=watch_ids,
                    use_regime_filter=use_regime_filter,
                    rank_gate_enabled=rank_gate_enabled,
                    trade_context_gate_enabled=trade_context_gate_enabled,
                    trade_context_allowed=trade_context_allowed_frozen,
                )
                sig = "derived_runtime"
                # Empty derived fires are allowed (narrow windows / regime gate): finish as zero-trade run.
            elif use_regime_filter:
                fires_by_time = self._load_fires(timeframe, from_time, to_time, watch_ids=watch_ids)
                if not fires_by_time:
                    scope = sorted(watch_ids) if watch_ids else ["all"]
                    raise ValueError(
                        "No DB fires in requested window/scope. Rebuild pipeline fires first "
                        f"(scope={scope}, timeframe={timeframe})."
                    )
            else:
                fires_by_time = self._derive_fires_from_bars(
                    bars,
                    timeframe,
                    watch_ids=watch_ids,
                    use_regime_filter=False,
                    rank_gate_enabled=rank_gate_enabled,
                    trade_context_gate_enabled=trade_context_gate_enabled,
                    trade_context_allowed=trade_context_allowed_frozen,
                )
                sig = "derived_no_regime"
                if not fires_by_time:
                    scope = sorted(watch_ids) if watch_ids else ["all"]
                    raise ValueError(
                        "No derived fires in requested window/scope for regime-filter OFF "
                        f"(scope={scope}, timeframe={timeframe})."
                    )
            signal_source = sig
        else:
            signal_source = signal_source or "custom"

        bars_by_time = {b["bar_time"]: b for b in bars}
        fires_by_time = filter_fires_by_entry_gates(
            fires_by_time,
            bars_by_time,
            rank_gate_enabled=rank_gate_enabled,
            trade_context_gate_enabled=trade_context_gate_enabled,
            trade_context_allowed=trade_context_allowed_frozen,
        )

        closed, equity_rows, skipped_fires = self._simulate(
            bars,
            fires_by_time,
            timeframe=timeframe,
            config=config,
            policy=policy,
        )

        wins = [t for t in closed if _safe_float(t.get("net_pnl")) > 0]
        win_rate = (len(wins) / len(closed)) if closed else None
        slip_ratios = [
            float(t["slippage_to_stop_ratio"])
            for t in closed
            if t.get("slippage_to_stop_ratio") is not None
        ]
        mean_slippage_to_stop_ratio = (
            round(sum(slip_ratios) / len(slip_ratios), 6) if slip_ratios else None
        )
        start_equity = config.initial_capital
        end_equity = _safe_float(
            equity_rows[-1]["equity"] if equity_rows else start_equity, start_equity
        )
        net_pnl = end_equity - start_equity
        sharpe = self._simple_sharpe(equity_rows)
        max_dd = self._max_drawdown(equity_rows)

        if benchmark_points is not None:
            benchmark_points_final = [dict(p) for p in benchmark_points]
            benchmark_cached = False
        elif use_regime_filter:
            benchmark_points_final, benchmark_cached = self._buy_hold_equity_points(
                bars,
                config,
                timeframe=timeframe,
                from_time=from_time,
                to_time=to_time,
                use_cache=True,
            )
        else:
            benchmark_points_final, benchmark_cached = self._buy_hold_equity_points(
                bars,
                config,
                timeframe=timeframe,
                from_time=from_time,
                to_time=to_time,
                use_cache=False,
            )

        run_id = str(uuid4())
        created_at = datetime.utcnow()
        skip_counts = Counter([s["reason_code"] for s in skipped_fires])
        entry_mode = "next_bar_open" if policy.entry_next_bar_open else "signal_bar_close"

        meta_core = {
            "bars": len(bars),
            "fires": sum(len(v) for v in fires_by_time.values()),
            "watch_ids": sorted(watch_ids) if watch_ids else ["all"],
            "fire_source": signal_source,
            "use_regime_filter": bool(use_regime_filter),
            "rank_gate_enabled": bool(rank_gate_enabled),
            "trade_context_gate_enabled": bool(trade_context_gate_enabled),
            "trade_context_allowed": sorted(trade_context_allowed_frozen),
            "skipped_fires": dict(skip_counts),
            "buy_hold_cached": bool(benchmark_cached),
            "exit_ticks_broker_stop_loss": config.stop_loss_ticks,
            "exit_ticks_broker_take_profit": config.take_profit_ticks,
            "exit_ticks_resolution": (
                "run_wide_broker"
                if (
                    config.stop_loss_ticks is not None
                    or config.take_profit_ticks is not None
                )
                else (
                    "strategy_defaults_regime_scaled"
                    if config.regime_exit_scale_enabled
                    else "strategy_defaults"
                )
            ),
            "regime_exit_scale_enabled": bool(config.regime_exit_scale_enabled),
            "regime_exit_scale_mode": config.regime_exit_scale_mode
            if config.regime_exit_scale_enabled
            else None,
            "mean_slippage_to_stop_ratio": mean_slippage_to_stop_ratio,
            "execution_policy": policy.to_metadata_dict(),
            "entry_mode": entry_mode,
            "entry_gap_guard_max_ticks": policy.entry_gap_guard_max_ticks,
        }
        if metadata_extra:
            meta_core.update(metadata_extra)

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
            "metadata_json": json.dumps(meta_core),
        }
        trade_rows = [{**t, "run_id": run_id} for t in closed]
        skipped_rows = [{**s, "run_id": run_id} for s in skipped_fires]
        benchmark_rows = [{**p, "run_id": run_id} for p in benchmark_points_final]
        equity_rows_out = [{**p, "run_id": run_id} for p in equity_rows]
        db_module.write_backtest_results(
            self.con,
            run_row,
            trade_rows,
            equity_rows_out,
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
            "rankGateEnabled": bool(rank_gate_enabled),
            "tradeContextGateEnabled": bool(trade_context_gate_enabled),
            "tradeContextAllowed": sorted(trade_context_allowed_frozen),
            "skippedFires": dict(skip_counts),
            "entryMode": entry_mode,
            "entryGapGuardMaxTicks": policy.entry_gap_guard_max_ticks,
        }
