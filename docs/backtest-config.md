# Backtest broker defaults JSON

Persistent **simulated broker economics** for `POST /api/backtest/run` live in [`config/backtest_defaults.json`](../config/backtest_defaults.json) (or an override file).

This file is separate from **`ORDERFLOW_STRATEGY_CONFIG`** / [`strategy_defaults.json`](strategy_defaults.json), which only overlays **legacy strategy** parameters (cooldown, lookback, SL/TP templates, etc.). See [`backtest-engine.md`](backtest-engine.md) for how broker vs strategy settings interact.

## Resolution order

1. Effective defaults = **`config/backtest_defaults.json`** merged onto Python [`BrokerConfig`](../pipeline/src/orderflow_pipeline/backtest_engine.py) fallbacks (`ORDERFLOW_BACKTEST_CONFIG` may point at another file — see below).
2. **`POST /api/backtest/run`** merges **explicit JSON body fields on top**. **Omitted** fields keep the defaults file/code merge; present fields override only those keys (`model_dump(exclude_unset=True)`).

## Paths and environment

| Mechanism | Path |
|-----------|------|
| Default | `<repo_root>/config/backtest_defaults.json` |
| Override | **`ORDERFLOW_BACKTEST_CONFIG`** — absolute path, or path relative to the process **current working directory** |

If **`ORDERFLOW_BACKTEST_CONFIG`** is set but the file is missing, a warning is emitted and the loader falls back to the repo default JSON if it exists; otherwise purely code defaults.

Repo root follows the pipeline package layout ([`backtest_defaults.py`](../pipeline/src/orderflow_pipeline/backtest_defaults.py)).

## Reload / cache

The loader **re-reads the JSON file from disk on every** `effective_broker_defaults()` call (used by `GET /api/backtest/defaults` and each `POST /api/backtest/run` merge). There is no in-process LRU keyed only by `mtime`, so rapid edits on Windows (where `mtime_ns` can fail to tick between saves) do not leave **some** broker fields stale.

**`clear_backtest_defaults_cache()`** is retained as a **no-op** for tests that still call it after env swaps.

## Allowed fields

| Field | Type | Meaning |
|-------|------|--------|
| `initial_capital` | number | Starting cash |
| `qty` | integer ≥ 1 | Contracts per leg |
| `slippage_ticks` | number | Adverse slips per fill × `tick_size` |
| `commission_per_side` | number ≥ 0 | Cash fee per fill side × `qty` |
| `tick_size` | number > 0 | Price tick |
| `point_value` | number > 0 | $ per price point per contract (`gross_pnl`) |
| `stop_loss_ticks` | number or `null` | Run-wide SL ticks; `null` → strategy resolver |
| `take_profit_ticks` | number or `null` | Run-wide TP ticks; `null` → strategy resolver |

## Dashboard

On each load, [`replay.js`](../src/data/replay.js) calls **`pullBacktestBrokerDefaultsIntoUi`**: it requests **`GET /api/backtest/defaults`** against `?apiBase=`, then `localStorage.orderflow_api_base`, then `http://127.0.0.1:8001`, and fills Performance inputs when the response succeeds. This runs in both **`?source=api`** chart mode and **synthetic** chart mode (use `?apiBase=` if your API is not on the default host/port). If the probe fails, inputs stay at HTML placeholders.

## Validation

- **Local:** `python scripts/validate_backtest_defaults.py` — checks the default repo file plus any **`ORDERFLOW_BACKTEST_CONFIG`** path if set.
- **Editor:** [`config/backtest_defaults.schema.json`](../config/backtest_defaults.schema.json).

## Related code

- Loader / merge: [`pipeline/src/orderflow_pipeline/backtest_defaults.py`](../pipeline/src/orderflow_pipeline/backtest_defaults.py)
- HTTP: [`api/main.py`](../api/main.py) (`GET /api/backtest/defaults`, `POST /api/backtest/run`)
