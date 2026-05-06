# Backtest engine — technical reference

This document explains how the **API backtest path** works in code, and how **global (run / broker) settings** relate to **per-strategy (signal + exit) settings** that an operator configures. For strategy JSON see [`strategy-config.md`](strategy-config.md). For broker JSON (capital, commission, slippage, `tick_size`, `point_value`, etc.) see [`backtest-config.md`](backtest-config.md). Product contracts: [`requirements.md`](../requirements.md) §14.

---

## 1. Components and files

| Piece | Role | Primary code |
|-------|------|----------------|
| **Backtest engine** | Loads bars and fire candidates, steps bar-by-bar, drives a single-position broker | [`pipeline/src/orderflow_pipeline/backtest_engine.py`](../pipeline/src/orderflow_pipeline/backtest_engine.py) |
| **HTTP API** | Validates request, merges JSON defaults + body into `BrokerConfig` and **`ExecutionPolicy`**, runs engine | [`api/main.py`](../api/main.py) — `GET /api/backtest/defaults`, `POST /api/backtest/run` |
| **Broker defaults JSON** | Persistent simulated broker economics merge | [`pipeline/src/orderflow_pipeline/backtest_defaults.py`](../pipeline/src/orderflow_pipeline/backtest_defaults.py), [`config/backtest_defaults.json`](../config/backtest_defaults.json) |
| **Legacy strategy (signals)** | Derives canonical watch fires from OHLC + regime context; **`opening_range_breakout`** (**`orb`**) composes alongside breakout/fade/wall/VER | [`pipeline/src/orderflow_pipeline/strategies/`](../pipeline/src/orderflow_pipeline/strategies/) — composed by `legacy_fallback_logic.py` |
| **Strategy parameters** | Per-timeframe cooldown, lookback, warmup, and optional SL/TP templates | [`pipeline/src/orderflow_pipeline/strategies/config.py`](../pipeline/src/orderflow_pipeline/strategies/config.py) + JSON loader [`strategy_json.py`](../pipeline/src/orderflow_pipeline/strategy_json.py) |
| **Exit tick resolution** | Maps timeframe + watch + optional broker override → SL/TP distances in ticks | [`pipeline/src/orderflow_pipeline/strategies/exit_ticks.py`](../pipeline/src/orderflow_pipeline/strategies/exit_ticks.py) |
| **Persisted fires** | Rows in DuckDB `fires` written by the pipeline from the same derivation function | Ingest / `recompute-fires` in [`pipeline/src/orderflow_pipeline/cli.py`](../pipeline/src/orderflow_pipeline/cli.py) |

---

## 2. Execution flow (what happens on each run)

1. **Load bars** for `(timeframe, from, to)` from DuckDB `bars`, ordered by `bar_time` (columns include **`session_date`**, **`v_rank`**, **`d_rank`**, **`range_pct`** for regime-aware tooling and optional SL/TP scaling).
2. **Choose a fire stream** (split among persisted canonical watches, runtime-derived **`orb`**, and compare OFF):
   - **Regime filter ON — persisted canonical watches** (`breakout`, `fade`, `absorptionWall`, `valueEdgeReject`): fires come from **`fires`** — precomputed at ingest / `recompute-fires`. The backtester does **not** re-run full derivation for this path.
   - **Regime filter ON — `orb` only**: **`fires`** is **not** consulted even though **`use_regime_filter`** may still be **true**. Signals come from **`derive_fires_from_bars`** (module [**`opening_range_breakout.py`**](../pipeline/src/orderflow_pipeline/strategies/opening_range_breakout.py)), **`timeframe` must be `5m`**, and metadata records **`fire_source: derived_runtime`**.
   - **Regime filter OFF** (optional compare run): fires are **derived on the fly** from the same bar window using `derive_fires_from_bars` with `use_regime_filter=False`. Metadata records **`fire_source: derived_no_regime`** for canonical-watch scopes. **`orb`** only: both ON and OFF runs use **`fire_source: derived_runtime`**; **`use_regime_filter=false`** skips the ORB **(v_rank, d_rank)** entry gate only (opening-range rules unchanged). The dashboard compare-OFF control applies to **`orb`** as well.
3. **Simulated broker** (`SimulatedBroker`): at most **one** open position; holds **`ExecutionPolicy`** for intrabar mechanical gates; applies slippage and commission on entry/exit; marks equity each bar as `cash + unrealized_pnl`.
4. **Per bar**, in order:
   - Try **intrabar SL/TP** against the current position using that bar’s high/low (risk-first if both hit and both mechanical honors are on — see §4.4), **unless** the position is **`orb`** opened **this same bar** (entry bar skips mechanical SL/TP only — see **`orb`** note in §2). **`exit_on_stop_loss` / `exit_on_take_profit`** are enforced **inside** `try_intrabar_exit` so the two intrabar passes stay consistent; stored **`stop_price` / `take_profit_price`** on `Position` are **not** cleared when a flag is off.
   - For each fire at this timestamp: map `watch_id` + `direction` → long/short side; resolve SL/TP ticks (see §4); open, **flip** (unless `flip_on_opposite_fire` is false → skip `flip_disabled`), or skip (e.g. same-side when `ignore_same_side_fire_when_open`).
   - Run **intrabar SL/TP** again (same policy gates and the same **`orb`** entry-bar skip).
   - Mark to market at bar close.
5. **End of window**: if a position remains and **`close_at_end_of_window`** is true, close at last bar’s close with reason `end_of_window`; otherwise leave the position open through the synthetic window boundary (deadlock validation prevents configs with no other exit path).
6. **Persist** summary, trades, equity, benchmark (`buy_hold`), and skipped-fire rows under a new `run_id`.

### Null hypothesis (optional companion run)

When `POST /api/backtest/run` sets **`null_hypothesis=true`** alongside **`use_regime_filter=true`** and exactly one `watch_id`, the handler completes steps **1–6** for the **baseline** DB-fire run, takes **`tradeCount`** as **N**, derives an effective RNG seed from the persisted **`run_id`** unless **`null_hypothesis_seed`** is supplied, builds random **`fires_by_time`** with **`cooldown_bars`** spacing sampled only from bars eligible under the same legacy warmup/volume/regime gates as the scoped watch, and runs **`BacktestEngine._simulate`** in a parity loop until **`len(closed_trades)==N`**. Candidate scheduled-fire counts **k** run from **N** through **`max_schedulable_fires`** (maximum placements possible on eligible indices with sorted greedy cooldown spacing — avoids scanning impossible **k** values); for each **k** it tries **`NH_PARITY_VARIANTS_PER_K`** hash-seeded variants (default **48**, **`ORDERFLOW_NH_PARITY_VARIANTS_PER_K`** env override clamped **1…4096**) cycling three greedy **placement** modes (shuffle-forward vs sorted forward/backward index walks) because flip-disabled / barrier-heavy policies often need many schedules before closed-trade parity hits **N**. It then persists **another** run with **`fires_by_time`** injected (`signal_source: null_hypothesis`, **`metadata_json.is_null_hypothesis: true`** plus audit fields such as **`baseline_run_id`**, **`null_hypothesis_seed`**, **`nh_scheduled_fire_count`**, **`parity_iterations`**, **`max_schedulable_fires`**, **`parity_variants_per_k`**, **`parity_placement_styles`**). The HTTP JSON keeps baseline summary keys unchanged and adds **`nullHypothesis`** for the companion (`skipped` when **N=0`). NH benchmarks reuse baseline **`buy_hold`** attachment semantics wired by `api/main.py`. If parity never lands on **N**, the API returns **HTTP 400** `parity_unreachable` with counts and suggests raising **`ORDERFLOW_NH_PARITY_VARIANTS_PER_K`**, narrowing the window, enabling **`flip_on_opposite_fire`**, or passing **`null_hypothesis_seed`**.

**Watch → direction convention** (mapping from fire to traded side):

- `breakout`, **`orb`**: trade **with** the fire direction (`up` → long, `down` → short).
- `fade`, `valueEdgeReject`, `absorptionWall`: trade **against** the fire direction (mean-reversion read).

**`orb` (Opening Range Breakout, learning experiment):** Hardcoded **5m** session logic — opening range is the aggregated high/low of bars whose 5m interval intersects **09:30-09:45 America/New_York**; after that window, ORB requires **break -> retest -> confirm** on a later bar. Long path: break above OR high, then a later bar with `low <= or_high` and `close > or_high`; short is symmetric around OR low. With **`use_regime_filter=true`**, the ORB **(v_rank, d_rank)** gate {(3,2),(3,3),(4,2),(4,3)} is applied on the **confirmation bar** (entry bar), not the initial break probe; with filter OFF, that gate is skipped. Signals emit at **confirmation-bar close** (`price_basis=confirm_close`), no signals are created at/after **12:00 America/New_York**, and ORB locks to **one direction per session** after first confirmation. Not written to **`fires`** by aggregation by default; exit templates resolve via **`strategy_defaults.json`** **`watch_exit_ticks.orb`**. After regime scaling of template ticks (when enabled), unless a **run-wide** broker **`stop_loss_ticks`** override is set, the simulator **floors** the effective stop distance so the protective stop can reach **beyond the opposite OR extreme** (longs: below **`or_low`**; shorts: above **`or_high`**) plus a small tick buffer — avoiding fixed-template stops stranded **inside** the opening-range structure on late confirmations. **`SimulatedBroker.try_intrabar_exit`** is **not** invoked on the **ORB entry bar** for mechanical SL/TP (both passes in step 4), so a tight template stop is not forced to “re-hit” the same candle’s full range immediately after that fill; mechanical barriers apply from the **next** bar onward. **Flip** and other fire-driven closes on the entry bar are unchanged.

---

## 3. Global backtest configuration (broker / “run economics”)

These settings define **execution plumbing and P&L accounting**, not *which* fires exist. They are modeled as **`BrokerConfig`** in Python. Run-level **execution policy** (flip, mechanical honors, end flatten, same-side ignore) is **`ExecutionPolicy`** in [`backtest_engine.py`](../pipeline/src/orderflow_pipeline/backtest_engine.py) — merged from the same JSON file and optional POST fields as broker economics (see [`backtest-config.md`](backtest-config.md)). The HTTP API merges **[`config/backtest_defaults.json`](../config/backtest_defaults.json)** (or **`ORDERFLOW_BACKTEST_CONFIG`**) onto code fallbacks first, then applies **explicit `POST /api/backtest/run` fields** for any keys the client sends (see [`backtest-config.md`](backtest-config.md)). **`ExecutionPolicy.validate()`** runs before the engine; invalid configs return **HTTP 400**.

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
3. **API request overlay** — each field on `POST /api/backtest/run` is optional; **omitted** keys keep the JSON/code merge, **present** keys override that key only. Applies separately to **broker** numeric fields and **execution-policy** booleans.

### 3.3 Execution policy (run behavior)

| Field | Default | Meaning |
|-------|---------|--------|
| `ignore_same_side_fire_when_open` | `true` | Skip same-direction fires when already on that side. **`false`** is rejected by validation until pyramiding exists. |
| `flip_on_opposite_fire` | `true` | Opposing fire closes and re-opens (`flip`). If false → **`flip_disabled`** skip row in `skipped_fires`. |
| `exit_on_stop_loss` | `true` | Honor `stop_price` intrabar; if false, barrier stays on `Position` but is ignored intrabar. |
| `exit_on_take_profit` | `true` | Honor `take_profit_price` intrabar; if false, same pattern as SL. |
| `close_at_end_of_window` | `true` | Force `end_of_window` exit on last bar if still open. |

**Deadlock rule:** not (flip off ∧ both mechanical honors off ∧ end off). Server (`ExecutionPolicy.validate`) and client mirror return **HTTP 400** / block POST respectively.

**`GET /api/backtest/defaults`** returns **`{ broker, execution, resolvedPath }`** — merged **(2)+(1)** for both broker economics and execution policy — so the dashboard can pre-fill the Performance panel (`pullBacktestBrokerDefaultsIntoUi` / execution hydration in [`backtestApi.js`](../src/data/backtestApi.js), invoked from [`replay.js`](../src/data/replay.js)) after a best-effort probe to the API host (`?apiBase=` → `orderflow_api_base` → `127.0.0.1:8001`), including synthetic chart mode.

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
| **SL/TP tick distances for new positions** | Resolved via [`resolve_exit_ticks`](../pipeline/src/orderflow_pipeline/strategies/exit_ticks.py) on **every** open/flip unless broker run-wide overrides apply (below). Uses `config_for_timeframe(timeframe)` (strategy JSON + Python base); then optional **`watch_exit_ticks`** overrides for the matching `watch_id`. When **`regime_exit_scale_enabled`** is **true** on the merged [`BrokerConfig`](../pipeline/src/orderflow_pipeline/backtest_engine.py) **and** broker run-wide SL/TP are **both unset**, template ticks are scaled per trade using [`apply_regime_exit_scale`](../pipeline/src/orderflow_pipeline/strategies/regime_exit_scale.py) from the **entry bar** (`range_pct` / `v_rank` on that bar row). With **`entry_next_bar_open`**, the entry bar is the deferred fill bar (not the signal bar). Barriers are fixed for the life of the trade (no intrabar regime updates). |

So: tuning **cooldown / lookbacks** requires **pipeline recomputation** to refresh `fires` for regime-ON parity with your JSON. Tuning **only SL/TP** (with null broker overrides) affects **fills and equity** immediately on the next API run **without** rewriting `fires`.

### 4.3 Exit tick resolution order (concise)

For each new position the engine asks `resolve_exit_ticks(timeframe, watch_id, broker_*)`:

1. If **`BrokerConfig.stop_loss_ticks`** or **`take_profit_ticks`** is set (non-null on the merged `BrokerConfig`, including from JSON) → the resolver returns **that pair as-is** for the whole run: any side that stayed **`null`** has **no mechanical barrier**. (Omitting a key in the POST usually keeps the merged JSON default for that side — often **`null`**.) Values must be **≥ 0** ticks as **unsigned distances** from the fill (not signed bracket offsets like some live order tickets). Negative ticks are rejected (**HTTP 400**).
2. Else → start from **`LegacyFallbackConfig.stop_loss_ticks` / `take_profit_ticks`** for that timeframe (after JSON merge).
3. If **`watch_exit_ticks`** defines the current `watch_id`, non-null fields override per watch.

**Null** SL and TP everywhere (and no broker override) ⇒ **flip + optional end flatten** by default — no barrier prices unless **`ExecutionPolicy`** disables flip/end (must remain deadlock-valid).

**Regime scaling (optional):** After steps 1–3 yield template ticks, if **`regime_exit_scale_enabled`** is **true** and neither **`BrokerConfig.stop_loss_ticks`** nor **`take_profit_ticks`** is set, multiply distances by multipliers derived from the entry bar (`regime_exit_scale_mode`: **`range_pct`** / **`v_rank`**). Invalid or missing regime inputs fall back to **unscaled** template ticks (same as treating multipliers as **1.0**). **`exit_ticks_resolution`** in run metadata is **`strategy_defaults_regime_scaled`** when scaling is active; **`run_wide_broker`** still wins whenever either broker tick field is set.

**Slippage vs tight stops:** Each closed trade may record **`slippage_to_stop_ratio`** (`slippage_ticks / stop_loss_ticks_effective`) when an SL distance was in effect; run metadata includes **`mean_slippage_to_stop_ratio`** across trades with SL. Very tight dynamic stops make fixed slip a larger fraction of risk — interpret low-vol outcomes accordingly.

### 4.4 Intrabar ambiguity

If the same OHLC bar hits both SL and TP **and both mechanical honors are enabled**, **`intrabar_stop_take_hit`** resolves **stop first** (conservative).

---

## 5. Operator checklist: “what do I configure where?”

**Global / run economics (broker)**

- Prefer **consistent** capital, qty, slip, commission, tick size, and point value across runs you intend to compare.
- Use **`stop_loss_ticks` / `take_profit_ticks`** on the API **only when** you want a **single grid for every watch** in that run.

**Execution policy (Performance checkboxes / POST booleans)**

- Use flip / honor SL / honor TP / end flatten toggles to stress-test execution paths; invalid combinations are rejected before the run. Opposing fires when flip is off appear as **`flip_disabled`** in skipped-fire diagnostics.

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

Each run persists diagnostic fields including `watch_ids`, `fire_source`, `use_regime_filter`, **`execution_policy`** (serialized policy fields), top-level **`entry_mode`** (`signal_bar_close` vs `next_bar_open`) and **`entry_gap_guard_max_ticks`** when relevant, skipped-fire counts, **`exit_ticks_resolution`** (`run_wide_broker` \| **`strategy_defaults`** \| **`strategy_defaults_regime_scaled`**), **`regime_exit_scale_enabled`** / **`regime_exit_scale_mode`** when scaling is configured, **`mean_slippage_to_stop_ratio`** when applicable, and broker exit-tick provenance keys. Inspect `backtest_runs.metadata_json` for reproducibility and debugging.

---

## 7. Related endpoints

| Endpoint | Use |
|---------|-----|
| `GET /api/backtest/defaults` | Merged broker economics + execution policy for UI |
| `POST /api/backtest/run` | Execute backtest |
| `GET /api/backtest/stats` | Latest or `runId`-scoped summary |
| `GET /api/backtest/equity` | Equity + optional `buy_hold` benchmark points |
| `GET /api/backtest/trades` | Trades with `exit_reason` (`flip`, `stop_loss`, `take_profit`, `end_of_window`); optional **`stopLossTicksEffective`**, **`takeProfitTicksEffective`**, **`slippageToStopRatio`** when persisted |
| `GET /api/backtest/skipped-fires` | Fires skipped (`already_in_position_same_side`, **`flip_disabled`**, etc.) |

---

## 8. Further reading

- [`strategy-config.md`](strategy-config.md) — strategy JSON shape, profiles, validation.
- [`requirements.md`](../requirements.md) §14 — authoritative MVP behavioral contract for the product.
- [`value-edge-canonical-vs-backtest.md`](value-edge-canonical-vs-backtest.md) — nuances when reconciling canonical signal docs vs backtest execution.
