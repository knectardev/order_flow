# Strategy defaults JSON

This document describes how [`config/strategy_defaults.json`](../config/strategy_defaults.json) (or a replacement file) configures **legacy fallback** strategy parameters used by the pipeline and backtester. **Broker economics** (capital, fees, slippage, `tick_size`, `point_value`) are configured separately — see [`backtest-config.md`](backtest-config.md).

## Resolution order (SL / TP ticks)

For each new position, exit tick distances resolve in this order:

1. **Python base** — [`config_for_timeframe`](../pipeline/src/orderflow_pipeline/strategies/config.py) builds a [`LegacyFallbackConfig`](../pipeline/src/orderflow_pipeline/strategies/config.py) from hardcoded per-timeframe defaults.
2. **JSON overlay** — Keys present under `timeframes.<tf>` in the loaded document merge on top (same file or path from `ORDERFLOW_STRATEGY_CONFIG`). Omitted keys keep the Python base.
3. **Broker / API run-wide override** — If [`POST /api/backtest/run`](../api/main.py) sets `stop_loss_ticks` or `take_profit_ticks` on [`BrokerConfig`](../pipeline/src/orderflow_pipeline/backtest_engine.py), those values apply to **every** new position for that run and **replace** JSON-derived ticks for SL/TP resolution ([`resolve_exit_ticks`](../pipeline/src/orderflow_pipeline/strategies/exit_ticks.py)).

Intrabar exit behavior (risk-first stop vs take-profit on the same bar) is documented in [`requirements.md`](../requirements.md) §14.

## File location and environment

| Mechanism | Path |
|-----------|------|
| Default | `<repo_root>/config/strategy_defaults.json` |
| Override | Set **`ORDERFLOW_STRATEGY_CONFIG`** to an absolute path, or a path relative to the **current working directory** of the process. |

Repo root is inferred from the pipeline package layout ([`strategy_json.py`](../pipeline/src/orderflow_pipeline/strategy_json.py)).

## Reload / cache

The loader caches file contents keyed by path and file **mtime**. In practice:

- **Restart the API** (or any long-lived worker) after editing JSON so configuration is predictable.
- **`uvicorn --reload`** may not watch the `config/` directory depending on how it is started; do not rely on hot reload for this file alone.
- In **tests**, call **`clear_strategy_config_cache()`** after changing env or files on disk ([`strategy_json.py`](../pipeline/src/orderflow_pipeline/strategy_json.py)).

## `timeframes` shape

Top-level `timeframes` is an object keyed by timeframe string. Supported keys today:

- `1m`
- `5m`
- `15m`
- `1h`

Under each key, optional fields (all override the Python base when present):

| Field | Type | Meaning |
|-------|------|---------|
| `cooldown_bars` | integer | Minimum bars between same-direction emits for a watch. |
| `min_bars` | integer | Minimum bars in series before strategy runs. |
| `lookback_bars` | integer | Lookback window for indicators. |
| `warmup_start` | integer | First bar index where emission is allowed. |
| `stop_loss_ticks` | number or `null` | Default SL distance in ticks for this TF; `null` = no default SL from JSON (flip-only unless watch or broker supplies ticks). |
| `take_profit_ticks` | number or `null` | Default TP distance in ticks. |
| `watch_exit_ticks` | object | Per-watch overrides (see below). |

## `watch_exit_ticks`

Object keys are **`watch_id`** strings. Allowed values match backtest / API scope:

- `breakout`
- `fade`
- `absorptionWall`
- `valueEdgeReject`
- `orb` (runtime-derived on `5m`; exit templates still resolve through this JSON path)

Each value is an object with optional `stop_loss_ticks` and `take_profit_ticks` (number or `null`). For a matching watch, each **non-null** field overrides the timeframe-level default for that field only; the other field can still inherit from the timeframe defaults ([`exit_ticks.py`](../pipeline/src/orderflow_pipeline/strategies/exit_ticks.py)).

**Design tip:** Use **timeframe-level** `stop_loss_ticks` / `take_profit_ticks` when all watches in that TF share one grid. Use **`watch_exit_ticks` only** when only some watches should have mechanical exits and others should stay flip-only at the TF level (`null` at TF, numbers under specific watches). Setting both TF defaults and per-watch values is valid when one watch needs a different grid than the rest.

## `version`

Integer schema version. The loader supports **`version` ≤ 1**. If `version` is a **newer** integer than the loader understands, a **warning** is emitted and loading continues (forward compatibility).

## Profiles (A/B configs)

Reproducible presets live under [`config/profiles/`](../config/profiles/). Point `ORDERFLOW_STRATEGY_CONFIG` at a profile file, for example:

```text
ORDERFLOW_STRATEGY_CONFIG=config/profiles/hardened_1m.json
```

(Resolve path from your process cwd, or use an absolute path.)

- [`config/profiles/flip_only.json`](../config/profiles/flip_only.json) — leaves exits to flips / end-of-window (no JSON SL/TP).
- [`config/profiles/hardened_1m.json`](../config/profiles/hardened_1m.json) — example tighter 1m exits for experimentation.

## Validation

- **CI / local:** `python scripts/validate_strategy_config.py` validates the default file and all files under `config/profiles/` using the same rules as [`validate_strategy_document`](../pipeline/src/orderflow_pipeline/strategy_json.py).
- **Editor:** [`config/strategy_defaults.schema.json`](../config/strategy_defaults.schema.json) is a JSON Schema draft for autocomplete; the Python validator is authoritative if they differ.

## Related code

- Loader: [`pipeline/src/orderflow_pipeline/strategy_json.py`](../pipeline/src/orderflow_pipeline/strategy_json.py)
- Merge into dataclass: [`pipeline/src/orderflow_pipeline/strategies/config.py`](../pipeline/src/orderflow_pipeline/strategies/config.py)
- SL/TP resolution for positions: [`pipeline/src/orderflow_pipeline/strategies/exit_ticks.py`](../pipeline/src/orderflow_pipeline/strategies/exit_ticks.py)
