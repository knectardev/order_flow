# Backtest broker defaults JSON

Persistent **simulated broker economics** and optional **execution-policy booleans** for `POST /api/backtest/run` live in [`config/backtest_defaults.json`](../config/backtest_defaults.json) (or an override file).

This file is separate from **`ORDERFLOW_STRATEGY_CONFIG`** / [`strategy_defaults.json`](strategy_defaults.json), which only overlays **legacy strategy** parameters (cooldown, lookback, SL/TP templates, etc.). See [`backtest-engine.md`](backtest-engine.md) for how broker vs execution vs strategy settings interact.

## Resolution order

1. Effective defaults = **`config/backtest_defaults.json`** merged onto Python [`BrokerConfig`](../pipeline/src/orderflow_pipeline/backtest_engine.py) fallbacks for numeric broker fields, and **`ExecutionPolicy`** fallbacks for execution-policy keys (`ORDERFLOW_BACKTEST_CONFIG` may point at another file — see below).
2. **`POST /api/backtest/run`** merges **explicit JSON body fields on top**. **Omitted** fields keep the defaults file/code merge; present fields override only those keys (`model_dump(exclude_unset=True)` semantics per domain).

## Paths and environment

| Mechanism | Path |
|-----------|------|
| Default | `<repo_root>/config/backtest_defaults.json` |
| Override | **`ORDERFLOW_BACKTEST_CONFIG`** — absolute path, or path relative to the process **current working directory** |

If **`ORDERFLOW_BACKTEST_CONFIG`** is set but the file is missing, a warning is emitted and the loader falls back to the repo default JSON if it exists; otherwise purely code defaults.

Repo root follows the pipeline package layout ([`backtest_defaults.py`](../pipeline/src/orderflow_pipeline/backtest_defaults.py)).

## Reload / cache

The loader **re-reads the JSON file from disk on every** merge path (`GET /api/backtest/defaults` and each `POST /api/backtest/run`). There is no in-process LRU keyed only by `mtime`, so rapid edits on Windows (where `mtime_ns` can fail to tick between saves) do not leave **some** broker or execution fields stale.

**`clear_backtest_defaults_cache()`** is retained as a **no-op** for tests that still call it after env swaps.

## Allowed fields

### Broker economics (`BrokerConfig`)

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
| `regime_exit_scale_enabled` | boolean | When **true** and both broker tick fields above are **`null`**, scale strategy template SL/TP per trade from the entry bar (`pipeline/src/orderflow_pipeline/strategies/regime_exit_scale.py`). |
| `regime_exit_scale_mode` | `"range_pct"` or `"v_rank"` | Volatility signal for scaling (defaults **`range_pct`**). |
| `regime_sl_mult_min` / `regime_sl_mult_max` | numbers | In **`range_pct`** mode, SL multiplier lerps between these as **`range_pct`** runs **0→1**. |
| `regime_tp_mult_min` / `regime_tp_mult_max` | numbers | Same for TP. |
| `regime_sl_floor_ticks` | number or `null` | Optional minimum SL ticks after scaling. |
| `regime_v_rank_sl_mults` / `regime_v_rank_tp_mults` | array of **5** numbers | Per-rank (1…5) multipliers for **`v_rank`** mode or **`range_pct`** fallback when continuous inputs are absent. |

The dashboard Performance panel (`orderflow_dashboard.html`) exposes **`regime_exit_scale_enabled`** as **Scale template SL/TP by regime (entry bar)** and **`regime_exit_scale_mode`** as the **Regime mode** select when the API/build includes the controls; advanced multiplier JSON remains API/file-only unless extended later.

### Execution policy (`ExecutionPolicy`)

Top-level booleans in the same JSON document (snake_case):

| Field | Type | Meaning |
|-------|------|--------|
| `ignore_same_side_fire_when_open` | boolean | Skip same-side fires when already positioned (`true` default; `false` rejected until pyramiding). |
| `flip_on_opposite_fire` | boolean | Allow opposing fire to close + reopen (`flip`). |
| `exit_on_stop_loss` | boolean | Honor stop barrier intrabar when `stop_price` is set. |
| `exit_on_take_profit` | boolean | Honor TP barrier intrabar when `take_profit_price` is set. |
| `close_at_end_of_window` | boolean | Flatten at last bar (`end_of_window`). |
| `entry_next_bar_open` | boolean | When **true**, **new** entries (flat opens and the **open** leg after a flip) fill at the **next bar’s open**; the signal is still attributed to the signal bar. Default **`false`** matches historical same-bar fills at signal/close. |
| `entry_gap_guard_max_ticks` | number or `null` | When **`entry_next_bar_open`** is on, optional maximum bar-to-bar gap (in **ticks**): if the absolute gap between the next bar open and the signal bar close exceeds this × `tick_size`, the deferred entry is **skipped** (`gap_guard_blocked`). **`null`** / omitted disables the guard. |

Missing execution keys in older JSON files inherit code defaults (policy booleans default as in `ExecutionPolicy`; gap guard defaults to **`null`**).

## Dashboard

On each load, [`replay.js`](../src/data/replay.js) pulls defaults via **`pullBacktestBrokerDefaultsIntoUi`** / **`fetchAndApplyRepoBacktestDefaults`** in [`backtestApi.js`](../src/data/backtestApi.js): it requests **`GET /api/backtest/defaults`** against `?apiBase=`, then `localStorage.orderflow_api_base`, then `http://127.0.0.1:8001`, and fills Performance inputs (broker + execution checkboxes) when the response succeeds. Repo JSON overlay merges **`broker`** and **`execution`** when the standard checked-in file applies. This runs in both **`?source=api`** chart mode and **synthetic** chart mode (use `?apiBase=` if your API is not on the default host/port). If the probe fails, inputs stay at HTML placeholders.

## Validation

- **Local:** `python scripts/validate_backtest_defaults.py` — checks the default repo file plus any **`ORDERFLOW_BACKTEST_CONFIG`** path if set.
- **Editor:** [`config/backtest_defaults.schema.json`](../config/backtest_defaults.schema.json).

## Related code

- Loader / merge: [`pipeline/src/orderflow_pipeline/backtest_defaults.py`](../pipeline/src/orderflow_pipeline/backtest_defaults.py)
- HTTP: [`api/main.py`](../api/main.py) (`GET /api/backtest/defaults`, `POST /api/backtest/run`)
