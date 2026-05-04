# Backtest engine — technical reference

This document explains how the **API backtest path** works in code, and how **global (run / broker) settings** relate to **per-strategy (signal + exit) settings** that an operator configures. For strategy JSON see [`strategy-config.md`](strategy-config.md). For broker JSON (capital, commission, slippage, `tick_size`, `point_value`, etc.) see [`backtest-config.md`](backtest-config.md). Product contracts: [`requirements.md`](../requirements.md) §14.

---

## 1. Components and files

| Piece | Role | Primary code |
|-------|------|----------------|
| **Backtest engine** | Loads bars and fire candidates, steps bar-by-bar, drives a single-position broker | [`pipeline/src/orderflow_pipeline/backtest_engine.py`](../pipeline/src/orderflow_pipeline/backtest_engine.py) |
| **HTTP API** | Validates request, merges JSON defaults + body into `BrokerConfig`, runs engine | [`api/main.py`](../api/main.py) — `GET /api/backtest/defaults`, `POST /api/backtest/run` |
| **Broker defaults JSON** | Persistent simulated broker economics merge | [`pipeline/src/orderflow_pipeline/backtest_defaults.py`](../pipeline/src/orderflow_pipeline/backtest_defaults.py), [`config/backtest_defaults.json`](../config/backtest_defaults.json) |
| **Legacy strategy (signals)** | Derives canonical watch fires from OHLC + regime context | [`pipeline/src/orderflow_pipeline/strategies/`](../pipeline/src/orderflow_pipeline/strategies/) — composed by `legacy_fallback_logic.py` |
| **Strategy parameters** | Per-timeframe cooldown, lookback, warmup, and optional SL/TP templates | [`pipeline/src/orderflow_pipeline/strategies/config.py`](../pipeline/src/orderflow_pipeline/strategies/config.py) + JSON loader [`strategy_json.py`](../pipeline/src/orderflow_pipeline/strategy_json.py) |
| **Exit tick resolution** | Maps timeframe + watch + optional broker override → SL/TP distances in ticks | [`pipeline/src/orderflow_pipeline/strategies/exit_ticks.py`](../pipeline/src/orderflow_pipeline/strategies/exit_ticks.py) |
| **Persisted fires** | Rows in DuckDB `fires` written by the pipeline from the same derivation function | Ingest / `recompute-fires` in [`pipeline/src/orderflow_pipeline/cli.py`](../pipeline/src/orderflow_pipeline/cli.py) |

---

## 2. Execution flow (what happens on each run)

1. **Load bars** for `(timeframe, from, to)` from DuckDB `bars`, ordered by `bar_time`.
2. **Choose a fire stream** (this is the important split between “regime ON” and compare “OFF”):
   - **Regime filter ON** (default dashboard path): fires come from **`fires` table** — precomputed when the session was ingested or when you ran `recompute-fires`. The backtester does **not** re-run `derive_fires_from_bars` for this path.
   - **Regime filter OFF** (optional compare run): fires are **derived on the fly** from the same bar window using `derive_fires_from_bars` with `use_regime_filter=False`. Metadata records `fire_source: derived_no_regime`.
3. **Simulated broker** (`SimulatedBroker`): at most **one** open position; applies slippage and commission on entry/exit; marks equity each bar as `cash + unrealized_pnl`.
4. **Per bar**, in order:
   - Try **intrabar SL/TP** against current position using that bar’s high/low (risk-first if both hit).
   - For each fire at this timestamp: map `watch_id` + `direction` → long/short side; resolve SL/TP ticks (see §4); open, flip, or skip (e.g. already long and another long signal).
   - Run **intrabar SL/TP** again (so a position opened mid-bar can still be stopped the same bar).
   - Mark to market at bar close.
5. **End of window**: if a position remains, close at last bar’s close with reason `end_of_window`.
6. **Persist** summary, trades, equity, benchmark (`buy_hold`), and skipped-fire rows under a new `run_id`.

**Watch → direction convention** (mapping from fire to traded side):

- `breakout`: trade **with** the fire direction (`up` → long, `down` → short).
- `fade`, `valueEdgeReject`, `absorptionWall`: trade **against** the fire direction (mean-reversion read).

---

## 3. Global backtest configuration (broker / “run economics”)

These settings define **execution plumbing and P&L accounting**, not *which* fires exist. They are modeled as **`BrokerConfig`** in Python. The HTTP API merges **[`config/backtest_defaults.json`](../config/backtest_defaults.json)** (or **`ORDERFLOW_BACKTEST_CONFIG`**) onto code fallbacks first, then applies **explicit `POST /api/backtest/run` fields** for any keys the client sends (see [`backtest-config.md`](backtest-config.md)).

### 3.1 Fields

| Field | Meaning |
|-------|--------|
| `initial_capital` | Starting cash |
| `qty` | Contracts per position |
| `slippage_ticks` | Adverse slip in ticks on each fill |
| `commission_per_side` | Commission per fill side × `qty` |
| `tick_size` | Tick increment (price) |
| `point_value` | Dollar value per point per contract (`gross_pnl = price_diff * side * point_value * qty`) |
| `stop_loss_ticks` / `take_profit_ticks` | Optional **run-wide** exit grid: if **either** is non-null, **every** new position uses these distances for mechanical exits until the next run (§4). |

### 3.2 Where defaults come from

1. **Code fallback** — every field inherits [`BrokerConfig`](../pipeline/src/orderflow_pipeline/backtest_engine.py) defaults when no JSON is present.
2. **JSON overlay** — [`config/backtest_defaults.json`](../config/backtest_defaults.json), or a file from **`ORDERFLOW_BACKTEST_CONFIG`**, replaces those defaults per key.
3. **API request overlay** — each field on `POST /api/backtest/run` is optional; **omitted** keys keep the JSON/code merge, **present** keys override that key only.

**`GET /api/backtest/defaults`** returns the merged **(2)+(1)** object so the dashboard can pre-fill the Performance panel (`pullBacktestBrokerDefaultsIntoUi` in [`replay.js`](../src/data/replay.js)) after a best-effort probe to the API host (`?apiBase=` → `orderflow_api_base` → `127.0.0.1:8001`), including synthetic chart mode.

Treat **`POST … stop_loss_ticks` / `take_profit_ticks`** as an optional **run-wide** exit overlay; when both are null/absent, strategy JSON + `resolve_exit_ticks` govern mechanical exits (§4).

---

## 4. Strategy configuration (signals + SL/TP templates)

Strategy configuration mixes **hardcoded Python baselines**, **optional JSON overlays**, and the **persisted fire table**.

### 4.1 `LegacyFallbackConfig` (per timeframe)

[`config_for_timeframe`](../pipeline/src/orderflow_pipeline/strategies/config.py) returns a frozen **`LegacyFallbackConfig`**:

1. **`_base_legacy_config`** supplies per-timeframe defaults for `cooldown_bars`, `min_bars`, `lookback_bars`, `warmup_start`, default SL/TP (`null` = flip-only at that layer), etc.
2. **`_apply_timeframe_json_overlay`** merges `timeframes.<tf>` from the loaded strategy document (`ORDERFLOW_STRATEGY_CONFIG` or `config/strategy_defaults.json`). Omitted JSON keys leave Python bases in place.

Details and profiles live in [`strategy-config.md`](strategy-config.md).

### 4.2 When strategy parameters affect fires vs exits

| Concern | Regime ON (DB fires) | Regime OFF (derived fires) |
|--------|----------------------|----------------------------|
| **Which bars emit fires** (`min_bars`, `cooldown_bars`, `warmup_start`, gates inside each watch module) | Fixed at **pipeline write time** for rows already in `fires`. Changing JSON alone does **not** change historical stored fires. Re-run ingest or **`recompute-fires`** for the window you care about. | **Re-derived** each backtest using current `config_for_timeframe` (and `use_regime_filter=False` for emission paths inside strategies). |

| Concern | Every backtest |
|--------|----------------|
| **SL/TP tick distances for new positions** | Resolved via [`resolve_exit_ticks`](../pipeline/src/orderflow_pipeline/strategies/exit_ticks.py) on **every** open/flip unless broker run-wide overrides apply (below). Uses `config_for_timeframe(timeframe)` (strategy JSON + Python base); then optional **`watch_exit_ticks`** overrides for the matching `watch_id`. |

So: tuning **cooldown / lookbacks** requires **pipeline recomputation** to refresh `fires` for regime-ON parity with your JSON. Tuning **only SL/TP** (with null broker overrides) affects **fills and equity** immediately on the next API run **without** rewriting `fires`.

### 4.3 Exit tick resolution order (concise)

For each new position the engine asks `resolve_exit_ticks(timeframe, watch_id, broker_*)`:

1. If **`BrokerConfig.stop_loss_ticks`** or **`take_profit_ticks`** is set on the POST body → **both** sides of the tuple are exactly those broker values for the whole run (the API may send explicit nulls for unused side — see resolver).
2. Else → start from **`LegacyFallbackConfig.stop_loss_ticks` / `take_profit_ticks`** for that timeframe (after JSON merge).
3. If **`watch_exit_ticks`** defines the current `watch_id`, non-null fields override per watch.

**Null** SL and TP everywhere (and no broker override) ⇒ **flip + end-of-window only** — no barrier prices.

### 4.4 Intrabar ambiguity

If the same OHLC bar hits both SL and TP, **`intrabar_stop_take_hit`** resolves **stop first** (conservative).

---

## 5. Operator checklist: “what do I configure where?”

**Global / run economics (broker)**

- Prefer **consistent** capital, qty, slip, commission, tick size, and point value across runs you intend to compare.
- Use **`stop_loss_ticks` / `take_profit_ticks`** on the API **only when** you want a **single grid for every watch** in that run.

**Individual strategy logic (signals)**

- Adjust **`config/strategy_defaults.json`** or a profile file referenced by **`ORDERFLOW_STRATEGY_CONFIG`** (`config/profiles/*.json`).
- After changing **signal-related** keys (warmup, cooldown, bars, gates): **rebuild or `recompute-fires`** so DuckDB **`fires`** match, if you rely on regime-ON runs.
- Use **`watch_ids`** on the POST body (or dashboard scope) to constrain which watches participate.

**Mechanical exits per watch**

- Prefer **`watch_exit_ticks`** in strategy JSON when some watches stay flip-only and others use SL/TP, or grids differ by watch — see [`strategy-config.md`](strategy-config.md).

**Dashboard compare mode**

- “Compare regime filter OFF” runs a **second** backtest with **derived** fires (no regime gating). Use it to isolate regime gating vs the same broker and exit-resolution stack.

---

## 6. Run metadata (`metadata_json`)

Each run persists diagnostic fields including `watch_ids`, `fire_source`, `use_regime_filter`, skipped-fire counts, and whether exit ticks used **`run_wide_broker`** vs **`strategy_defaults`**. Inspect `backtest_runs.metadata_json` for reproducibility and debugging.

---

## 7. Related endpoints

| Endpoint | Use |
|---------|-----|
| `GET /api/backtest/defaults` | Merged broker economics for UI |
| `POST /api/backtest/run` | Execute backtest |
| `GET /api/backtest/stats` | Latest or `runId`-scoped summary |
| `GET /api/backtest/equity` | Equity + optional `buy_hold` benchmark points |
| `GET /api/backtest/trades` | Trades with `exit_reason` (`flip`, `stop_loss`, `take_profit`, `end_of_window`) |
| `GET /api/backtest/skipped-fires` | Fires skipped (e.g. same-side stacking) |

---

## 8. Further reading

- [`strategy-config.md`](strategy-config.md) — strategy JSON shape, profiles, validation.
- [`requirements.md`](../requirements.md) §14 — authoritative MVP behavioral contract for the product.
- [`value-edge-canonical-vs-backtest.md`](value-edge-canonical-vs-backtest.md) — nuances when reconciling canonical signal docs vs backtest execution.
