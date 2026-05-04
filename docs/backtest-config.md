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

The loader LRU-caches contents keyed by resolved path **mtime**. **Restart uvicorn** (or bump file mtime) after edits for predictable reads in long-lived servers.

Tests should call **`clear_backtest_defaults_cache()`** ([`backtest_defaults.py`](../pipeline/src/orderflow_pipeline/backtest_defaults.py)) after swapping env vars or replacing files.

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

When the page loads in **`?source=api`** mode, [`bootstrapFromApi`](../src/data/replay.js) fetches **`GET /api/backtest/defaults`** and fills Performance inputs (`Capital`, `Commission/side`, `Slippage`, `Qty`) from the **`broker`** object so you don’t need to type them each session unless you intentionally change overrides in the UI.

## Validation

- **Local:** `python scripts/validate_backtest_defaults.py` — checks the default repo file plus any **`ORDERFLOW_BACKTEST_CONFIG`** path if set.
- **Editor:** [`config/backtest_defaults.schema.json`](../config/backtest_defaults.schema.json).

## Related code

- Loader / merge: [`pipeline/src/orderflow_pipeline/backtest_defaults.py`](../pipeline/src/orderflow_pipeline/backtest_defaults.py)
- HTTP: [`api/main.py`](../api/main.py) (`GET /api/backtest/defaults`, `POST /api/backtest/run`)
