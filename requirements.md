# Order Flow Dashboard — Requirements (Current)

> **Scope:** This document reflects the current implemented system (modular frontend + optional API/pipeline stack), replacing the older single-file-only prototype framing.

---

## 1) Product Overview

The dashboard is a market microstructure visualization and hypothesis tool with two operating modes:

- **Synthetic mode:** local simulation, no backend required.
- **API replay mode (`?source=api`):** real ES session playback backed by FastAPI + DuckDB with multi-timeframe support (`1m`, `5m`, `15m`, `1h`).

Design intent remains unchanged:

1. Probabilistic regime framing (posterior distribution, not single hard labels).
2. Event-typed sparse markers rather than per-bar verdicts.
3. Contrasting canonical hypotheses (`★ Breakout`, `◆ Fade`, `🛡 Absorption Wall`) with explicit failure twins on the first two.
4. Order-flow context from profile + VWAP + event structure.
5. Optional PHAT candle rendering mode (asymmetric body shading + wicks; liquidity-modulated stroke **off** by default; wick-tip disk markers shelved by default) in API replay.

---

## 2) Architecture

### 2.1 Frontend

- Entry shell: `orderflow_dashboard.html`.
- Styling: `styles/dashboard.css`.
- Runtime: ES modules under `src/` (no bundler required).
- Core state model: single mutable singleton in `src/state.js`.

### 2.2 Data Pipeline and API

- Pipeline: `pipeline/src/orderflow_pipeline/*` computes bars, events, fires, regime **integer ranks** (`v_rank`, `d_rank`, 3-bar smoothed rounded 1–5 from an **endpoint** trailing-window percentile (`(n−1)` stretch, window midpoint → bucket 3)), **continuous scatter coordinates** **`vol_score`** / **`depth_score`** (same window computed in **one rolling pass**: mid-rank / average-rank percentile → values strictly in **(1, 5)** when the window has more than one valid sample — avoids artificial mass on **exactly 1.0 / 5.0**), session VWAP, directional bias states, and DB writes. **Implementer constraints (imports, ETL, no legacy scatter):** §4.3. **Contract change:** after updating this classifier, run a **full** **`python -m orderflow_pipeline.cli rebuild`** (same as other persisted-bar semantics changes) so DuckDB / JSON shards do not mix pre-change and post-change `vol_score`/`depth_score`. Downstream code does not treat **`volScore === 3`** as “window median”; only the **integer** rank path preserves the midpoint→3 mapping.
  - Aggregation contract supports `1m` / `5m` / `15m` / `1h` bins.
  - **RTH binning** is **session-anchored** to the cash open (`09:30` America/New_York): `bin_start = rth_open + floor((ts - rth_open) / bin_ns) * bin_ns`, so the first bar of each timeframe starts at RTH open. **Globex** remains UTC-aligned `floor(ts / bin_ns) * bin_ns`. When `bin_ns` does not evenly divide the RTH window, the **final bar** is shorter (Strategy A); `bars.bar_end_time` stores the **exclusive** end instant `min(bin_start + bin_ns, rth_close)` in UTC (naive TIMESTAMP). **`bar_time`** remains inclusive bin start.
  - Running session **VWAP** (`aggregate._stamp_session_vwap`) uses the same cumulative typical-price formula as before; binning migrations change only trade-to-bar assignment, not the VWAP recurrence.
  - Phase 6 **parent HTF bias** denormalization joins each LTF row to its covering HTF bar with `LTF.bar_time >= HTF.bar_time AND LTF.bar_time < HTF.bar_end_time` (no fixed `INTERVAL '1 hour'` predicate).
  - CLI DB ingest (`cli.py` `_write_session_to_db`): a session **must** produce at least one canonical fire at **`1m`** (dense bars); at **`5m`** / **`15m`** / **`1h`** it may produce **zero** fires for that session+timeframe (quiet regime-filtered window) — bars and related rows still write; **`fires`** for that slice stays empty.
  - DuckDB schema keys rows by `(bar_time, timeframe)` and keeps per-timeframe isolation for bars/events/fires/profile rows.
  - `bars` rows additionally carry **session CVD** (`session_cvd` BIGINT — cumulative session delta at each bar), **aggressor size stats** (`aggressive_buy_count`, `aggressive_sell_count`, `avg_aggressive_buy_size`, `avg_aggressive_sell_size`, `size_imbalance_ratio`), `vwap`, PHAT features (`top_cvd`, `bottom_cvd`, `top_cvd_norm`, `bottom_cvd_norm`, `cvd_imbalance`, `top_body_volume_ratio`, `bottom_body_volume_ratio`, `upper_wick_liquidity`, `lower_wick_liquidity`, `upper_wick_ticks`, `lower_wick_ticks`, `high_before_low`, `rejection_side`, `rejection_strength`, `rejection_type`), and bias columns (`bias_state`, `parent_1h_bias`, `parent_15m_bias`). Tables **`swing_events`** (fractal swings on price + session CVD, with `swing_lookback` on every row) and **`divergence_events`** (CVD–price divergences with ingest thresholds and `size_confirmation`) are written in the same session transaction as bars when using DB ingest.
  - Aggregation order is `1h → 15m → 5m → 1m` so lower timeframes can denormalize parent biases via a half-open interval join in `_stamp_parent_bias`.
  - **`data/bars/`** (session JSON shards + `index.json`) is **gitignored** as local pipeline output (often large after full rebuilds); fresh clones rely on **`rebuild`** / **`aggregate`** or API+DuckDB rather than committed JSON.
- API: `api/main.py` exposes market-data read endpoints plus a backtest run endpoint:
  - `/timeframes`
  - `/sessions`
  - `/date-range` (MIN/MAX `bar_time` in `bars` for a `timeframe` — timeline bounds)
  - `/bars`
  - `/swing-events` (fractal swings: `swingLookback` on each row)
  - `/divergence-events` (CVD–price divergences; includes ingest threshold fields). Offline backtests filter **`divergence_events`** / **`swing_events`** by **`div_kind`** / swing series, **`size_confirmation`**, **`swing_lookback`**, and stamped thresholds (`min_price_delta`, `min_cvd_delta`, `max_swing_bar_distance`) — the same columns persisted per row and mirrored in JSON — joining to **`bars`** on **`timeframe`** + **`bar_time`** as needed.
  - `/events` (optional `types=sweep,divergence,absorption,stoprun` comma list filters `events.event_type` — **not** the same as `divergence_events` CVD table)
  - `/fires`
  - `/profile`
  - `/occupancy`
  - `POST /api/backtest/run`
  - `GET /api/backtest/stats`
  - `GET /api/backtest/equity`
  - `GET /api/backtest/trades`
  - `GET /api/backtest/skipped-fires`
- API endpoints that return market rows are timeframe-aware (`timeframe` query parameter, default `1m`), and must not mix contexts across timeframes.
- `/bars`, `/events`, `/fires` payloads include `vwap`, `barEndTime` (exclusive bar end, ISO-Z), `sessionCvd` (session cumulative delta), aggressor fields (`aggressiveBuyCount`, `aggressiveSellCount`, `avgAggressiveBuySize`, `avgAggressiveSellSize`, `sizeImbalanceRatio`), continuous regime coordinates `volScore` / `depthScore` (open-interval **(1, 5)** after warmup for typical multi-bar windows — JSON null in warmup / zero-volume like `vRank`/`dRank`), PHAT fields (`topCvd`, `bottomCvd`, `topCvdNorm`, `bottomCvdNorm`, `cvdImbalance`, `topBodyVolumeRatio`, `bottomBodyVolumeRatio`, `upperWickLiquidity`, `lowerWickLiquidity`, `upperWickTicks`, `lowerWickTicks`, `highBeforeLow`, `rejectionSide`, `rejectionStrength`, `rejectionType`), and bias fields (`biasState`, `biasH1`, `bias15m`) projected from persisted columns via `_attach_htf_bias`.
- Storage: DuckDB (`data/orderflow.duckdb` by default). **`data/**/*.bak`** copies and **`data/rebuild_log.txt`** are **gitignored** local artifacts (often large).
- **Local API + dashboard:** Run `python -m uvicorn api.main:app --host 127.0.0.1 --port <port>` from the repo root (or set env **`ORDERFLOW_DB_PATH`** to an absolute DuckDB path). **`GET /`** returns **`db_path`** for verification. Stop the API process before running **`python -m orderflow_pipeline.cli rebuild`** so the DB file is not locked on Windows. Serve static assets from the repo root. On Windows, **`python -m http.server 8000`** alone often logs **`Serving HTTP on :: port 8000`**; browsers using **`http://localhost:8000`** (IPv4) may then get a blank page, **connection reset**, or **empty reply** because nothing is accepting IPv4 on that port. Prefer **`python -m http.server 8000 --bind 127.0.0.1`** or run **`serve_dashboard.cmd`** from the repo root, then open **`http://127.0.0.1:8000/orderflow_dashboard.html?source=api`**. **API origin resolution (`src/data/replay.js`):** bootstrap probes **`GET /api/backtest/defaults`** (does not require DuckDB) across `?apiBase=` (when it parses), optional **`localStorage`** key **`orderflow_api_base`**, **`http://127.0.0.1:8001`** (default FastAPI fallback), then the **current page origin**, and uses the first origin that responds 200 — so **`http.server` on `:8000`** plus **`uvicorn` on `:8001`** does not hit static `:8000` first (avoids spurious **`GET /api/backtest/defaults` 404** in the console). **`uvicorn`** serving **both** the dashboard and API on **`8000`** is still discovered when nothing answers on **`8001`**. Overrides: query **`apiBase`** (when valid **`http:/https:`**) still wins ordering; **`orderflow_api_base`** applies when `apiBase` is absent or unparsable. If bars load but **`/swing-events`** data looks missing (no triangles), another process may be bound to **8001** while the real Order Flow API runs on a different port — use **`&apiBase=`** or **`orderflow_api_base`** so all fetches hit the same server/DB.
- **CVD divergence ingest thresholds:** CLI flags **`--div-min-price`**, **`--div-min-cvd`**, **`--div-max-bars`**, **`--swing-lookback`** are persisted on each **`divergence_events`** row at ingest time. To **recompute divergences alone** (seconds-scale, no decode or swing re-detection), use **`python -m orderflow_pipeline.cli recompute-divergences`**: supply **`--db-path`** and **`--timeframe`** (`1m` / `5m` / `15m` / `1h`, required); optional **`--from`** / **`--to`** UTC ISO bounds on **`bar_time`** (same pairing rule as **`recompute-fires`** — both or neither); optional divergence knobs (**`--div-min-price`** default **0.25**, **`--div-min-cvd`** default **1**, **`--div-max-bars`** default **240**); optional **`--swing-lookback`** (otherwise one **`DISTINCT swing_lookback`** per session is taken from **`swing_events`** — mixed values in a session exit non-zero unless **`--swing-lookback`** is passed); **`--preview`** runs detection and prints stable **`session … bearish= … bullish= … size_confirmed= … total= …`** lines plus **`total … rows= …`** without **`DELETE`/`INSERT`**. Session scope is **`DISTINCT session_date`** from **`swing_events`** whose **`bar_time`** falls in the window (empty swings ⇒ exit **0** with a short message — no fallback from **`bars`** alone). Non-preview runs **`DELETE`** then **`INSERT`** only **`divergence_events`** for each **`(timeframe, session_date)`** in that list; **`bars`**, **`swing_events`**, fires, profiles, regime columns, and **`events`** are untouched. **`size_confirmation`** uses **`Bar._size_imbalance_ratio`** fed by aggressor sums reconstructed as **`round(avg_aggressive_*_size × count)`** from persisted columns; sampled parity matches ingest-equivalent **`Bar`** sums on fixtures (**`tests/test_recompute_divergences.py`**), but rounded persisted averages can still drift vs a full decode replay in edge cases — optional future **`bars`** **`sum_aggressive_*`** columns would remove that ambiguity. **`--divergence-flow-mult`** applies to synthetic/client tunings only, **not** to **`detect_divergences`** (documented on the subcommand **`--help`**).

### 2.3 Mode Loading

- **`src/main.js`** awaits **`bootstrapReplay()`** before the first **`drawPriceChart` / `drawFlowChart` / `drawCvdChart`** pass so **`?source=api`** does not paint an empty main chart while **`replay.mode`** is still non-real and **`state.bars`** is empty.
- Real mode is explicitly selected via query string (`?source=api`).
- Synthetic remains supported and is the fallback when API replay is unavailable.
- Synthetic replay charts **`1m`** only; **`5m` / `15m` / `1h`** timeframe buttons stay **disabled** until API real mode loads (`src/data/replay.js` **`_syncTimeframeSelectorUI`**); **`bootstrapReplay`** resets **`activeTimeframe`** to **`1m`** on synthetic bootstrap (and normalizes on API bootstrap failure).
- **`chartUi.showDeltaPanel` / `chartUi.showCvdPanel`** mirror the **Delta & session CVD** dashboard section expand/collapse (`data-section-key="delta"`): when that section is collapsed, both flags are **false** (delta histogram + CVD line canvases do not draw; **CVD–price divergence connector segments on the price chart** are omitted; Prev/Next divergence nav disables — see §2.4). **Deferred UX:** dedicated toggles separate from section collapse; matrix interaction for CVD divergences (**hover-span** emphasis vs explicit selection) remains a product choice.

In **API replay**, after the windowed **`/bars`** load completes, **`seek(allBars.length)`** runs so **`replay.cursor`** sits at the **end of the loaded timeline**. The chart shows the **most recent** bars up to **`chartVisibleBars`** (horizontal zoom), while committed streaming/history handling still uses the **`MAX_BARS`** ring buffer (subject to **`chartPanSlider`** / **`chartViewEnd`**) with default timeframe **`1m`** — not bar 0 at session start unless the user pans there.

### 2.4 Collapsible dashboard sections

- Every main-grid **`section`** under **`grid-main`** is collapsible **except** **`#mainChartSection`** (price · volume profile · events — the primary chart stays fully visible with no collapse control).
- Sections **`delta`** (per-bar delta histogram **`flowChart`** + separate session CVD line **`cvdChart`** — distinct Y-axes; section meta shows ΣΔ for the visible window and session CVD at the viewport edge; in-panel **legend** under the canvases explains CVD–price **connector** colors (bearish **red** / bullish **teal** per `cvdChart.js`), **solid vs dotted** stroke (**`sizeConfirmation`** on the stored row vs thresholds-only), and a **threshold stamp** line derived from loaded **`/divergence-events`** (first row in the window, with a note when stamps differ across rows); **Prev / Next** controls jump the shared chart viewport to the previous or next **pipeline** divergence row from **`replay.allDivergences`**, ordered by **`laterTime`**, centering the **later swing** bar — `src/ui/divergenceNav.js`; buttons disable when not in API mode, when no rows load, when the delta section is **collapsed**, or when no earlier/later divergence exists relative to the **viewport center bar**). While **`delta`** is **collapsed**, pipeline **divergence connector lines** are hidden on both the **price** canvas (`priceChart.js`, gated by **`chartUi.showCvdPanel`**) and the **session CVD** canvas (`cvdChart.js` early-return when **`showCvdPanel`** is false). **`glossary`**, **`performance`**, **`matrix`**, and **`eventLog`** default to **expanded**. Each header uses a fixed-width **collapse control on the right** (`src/ui/sectionCollapse.js`) so **section titles stay left-aligned** consistently; **`section-meta`** (counts, toggles, status) sits between title and collapse. Collapse toggles dispatch **`orderflow:section-collapse`** with **`detail.sectionKey`** so **`main.js`** can resync **`chartUi`** and redraw charts.
- Expanded/collapsed preference is persisted in the browser via **`localStorage`** key **`orderflow_dashboard_section_collapsed`** (JSON map of section keys to boolean **`true`** when collapsed).

---

## 3) State Model (Single Source of Truth)

All mutable runtime state is centralized in `src/state.js`:

- **Stream data:** `bars`, `formingBar`, `events`, `canonicalFires`, `trail`, `matrixScores`.
- **Watch state:** `breakoutWatch`, `fadeWatch`, `absorptionWallWatch`, `valueEdgeRejectWatch` with persistent `lastCanonical`, edge-trigger flags, and flip tracking.
- **Replay state:** `replay.mode`, **`replay.dateRange`** `{ min, max, minMs, maxMs }` (from **`GET /date-range`** or stubbed from first/last loaded bar after a windowed **`/bars?from&to`** load), session metadata (**internal**: VWAP resets, warmup, cooldown boundaries — **no session dropdown**), full loaded **`replay.allBars`**, **`replay.allEvents`**, **`replay.allFires`**, **`replay.allSwings`** / **`replay.allDivergences`** (from **`/swing-events`** / **`/divergence-events`** after bars load), **`replay.swingLookbackDisplay`** (metadata from first swing row), cursor, data-source flags (`apiBase`, etc.), and **`replay.pendingSeekPromise` / `replay.pendingSeekAbort`** (in-flight **`seekAsync`** coordination — a new **`_loadAllSessionsFromApi`** **`await`s** the prior promise before replacing bars; synchronous **`seek()`** aborts an in-flight **`seekAsync`**).
- **Glossary primitive selection:** **`state.activeEventTypes`** (`Set` of glossary keys such as **`sweep up`**, **`absorption`**). Default **empty** — no upfront full-timeline primitive scan/fetch for API replay; **`loadEventsForActiveTypes()`** runs **`GET /events?types=&from&to`** when keys are checked, or **`precomputeAllEvents()`** in synthetic mode when keys are checked. In **API replay**, **`drawPriceChart()`** filters **`viewedEvents`** to keys in this set **before** drawing primitive glyphs (`▲▼◉⚡⚠`) so live **`detectEvents`** output in **`state.events`** does not bypass the checklist. Synthetic mode draws all **`state.events`** from the simulator (no checklist filter on glyphs).
- **Canonical fire halo selection (API replay):** **`state.activeCanonicalFireTypes`** (`Set` of **`watchId`** strings: **`breakout`**, **`fade`**, …). Default **empty** — canonical ★/◆/🛡/🎯 chart halos are **off until the user opts in**. **`priceChart.js`** filters merged fire draws in real mode by this set. **Synthetic mode** ignores this set and draws **`state.canonicalFires`** halos as before (no glossary panel).
- **Timeframe state:** `activeTimeframe`, `availableTimeframes`, and timeframe-switch memory (`savedMatrixRangeBeforeTf1h`).
- **Chart view mode state:** `candleMode` (`standard` | `phat`) with PHAT availability inferred from loaded API bars; `phatBodyImbalanceThreshold` (default **0.30**) gates P/b body shading; `phatShowWickLiquidityStrokeScaling` (default **false**) gates PHAT **wick segment stroke scaling from liquidity** (uniform **1px** wicks when **false**; **~1–1.85px** per segment when **true**, in **`priceChart.js`**); `phatShowWickRejectionRings` (default **false**) gates **wick-tip circle** drawing on the chart and detailed **Rejection** rows in the PHAT hover tooltip — hover payload still includes full rejection fields (§7.1); ring tuning: `phatExhaustionRingLiquidityThreshold` (default **0.55**), `phatMinWickTicksForRingFill` (default **2**), `phatGateAbsorptionRingsByWickLength` (default **true**) — used to compute `rejectionRingFilled` in the payload whenever rings are off or on (§7.1).
- **Chart UI:** `chartUi.showDeltaPanel` / `chartUi.showCvdPanel` — default **true**; kept in sync with whether the **`delta`** collapsible section (`orderflow_dashboard_section_collapsed` / DOM **`is-collapsed`**) is expanded, via **`syncDeltaSectionPanelsFromCollapse()`** in `sectionCollapse.js` (runs after **`initSectionCollapse()`** on boot and on **`orderflow:section-collapse`** for **`sectionKey === 'delta'`**).
- **Viewport state:** `chartViewEnd` for panned history vs live edge; **`chartVisibleBars`** (wheel-driven horizontal zoom — how many candles are mapped across the chart width, clamped per loaded/cursor bounds). The first time the user pans off the live edge while `replay.allFires` is still empty, `precomputeAllFires()` runs (saving and restoring `chartViewEnd` so the viewport is not reset). **When `replay.cursor` already equals `replay.allBars.length` (tape end), `precomputeAllFires()` snapshots `replay.allFires` from `canonicalFires` with no `seek()` — no redundant full replay.** When `precomputeAllFires` is triggered from `_loadAllSessionsFromApi` after the initial `seekAsync(length)` (see below), `allFires` is filled that way without an extra `seek` pass. Chart halos for ★/◆/🛡/🎯 in **API replay** merge `allFires` and `canonicalFires` (when panned) and filter by **`activeCanonicalFireTypes`**. Matching uses `watchId|bar_time_ms`. In real mode, anchored VWAP is drawn from the same cumulative `allBars[0..cursor)` series for both live and panned views (visible slice is windowed from that), avoiding a false straight↔curved change at pan boundaries.
- **Brushing/linking state:** `selection` (`kind`, selected cells, selected bar times, fire window bounds). A fire selection from the event log or chart (`selectFire`) also sets `chartViewEnd` so the fire bar and the 31-bar window sit in the current viewport, runs `_syncCurrentSession` and `_refreshMatrixForView` (so the panned path isn’t “all dim, marker off-screen”), and the price chart adds a teal focus ring on the active ◆/★/🛡.
- **Selection deep-linking (URL):** selection state is mirrored into query params and restored after API replay load. Supported params are `selection=fire|cells`, `selectionFireTime` (epoch ms), `selectionFireWatch` (`watchId`), and `selectionCells` (`r.c,r.c,...`). This allows copy/paste refresh-safe links to reopen the same brushed event window (or matrix-cell brush set). Timeframe switches clear these selection params because rank-cell coordinates are timeframe-specific.
- **Display-state deep-linking (URL):** glossary checkbox state is mirrored into `displayFires` (canonical `watchId` CSV) and `displayEvents` (primitive glossary-key CSV). On replay-ready bootstrap, these sets restore before selection replay so halos/markers are visible when a deep-linked fire/cell selection is applied.
- **Matrix UI state:** `matrixState` (`range`, `displayMode`, cached occupancy payload).
- **Warmup state:** `regimeWarmup` gate for rank-unavailable startup bars.
- **Bias filter state:** `biasFilterMode` (`'soft'` | `'hard'` | `'off'`, default `'soft'`) and `showSuppressed` (`boolean`, default `false`). Bootstrapped from `?biasFilter=` and `?showSuppressed=` URL params (Phase 6 — see §13).
- **Backtest state:** `backtest` stores run params (`scope`, `compareRegimeOff`, `initialCapital`, `commissionPerSide`, `slippageTicks`, `qty`, optional `stopLossTicks` / `takeProfitTicks`, **`entryNextBarOpen`** / **`entryGapGuardMaxTicks`** (next-bar integrity execution and optional gap guard), snapshots after Run Backtest, marker toggles), `lastRunScope` (scope string stamped after each successful run for the metrics row while results are shown), latest `runId`, latest `stats`, and fetched `equity` / `trades` payloads plus loading/error UI flags. After API replay load, the dashboard does **not** query or render the latest persisted DuckDB run; metrics, equity, and chart overlays stay empty until the user selects a **Backtest scope** and clicks **Run Backtest**.

---

## 4) Regime and Warmup Behavior

### 4.1 Regime Sources

- **Synthetic mode:** ranks derive from simulator state/proxy logic.
- **API mode:** ranks come from persisted v2 data-driven classifier output (`v_rank`, `d_rank`) from pipeline/DB.

### 4.2 Warmup Contract

For each session’s first rank-unavailable segment (typically first 30 bars):

- Matrix shows a centered **`WARMING UP`** overlay.
- Matrix visuals are dimmed; current/watched emphasis is suppressed.
- Canonical fire logic is suppressed (no fires while warmup is active).
- Event log shows a sticky SYSTEM warmup row until ranked bars begin.

This behavior is required to prevent false certainty and false trigger events while ranks are unavailable.

### 4.3 Regime scatter coordinates (`vol_score` / `depth_score`)

**Single source of truth:** [`pipeline/src/orderflow_pipeline/regime.py`](pipeline/src/orderflow_pipeline/regime.py) **`compute_ranks`** only. Production bars receive these fields through **`_stamp_ranks`** in [`cli.py`](pipeline/src/orderflow_pipeline/cli.py) before JSON and DuckDB writes. **Do not** hand-compute or overwrite them in import scripts, migrations, or alternate aggregators without going through the same function on a per-session frame (correct **`timeframe`**, optional **`seed_history_df`** for hybrid 15m/1h).

**Dual-track math (do not collapse back to one formula):**

- **`v_rank` / `d_rank`:** Raw bucket uses the **endpoint** trailing percentile **`(less + 0.5×eq − 0.5) / (n − 1)`**, then **3-bar rolling mean → round → clip to 1..5**. Window midpoint maps to bucket **3** (integer semantics for matrix cells, `/bars?cell=`, occupancy).
- **`vol_score` / `depth_score`:** Same rolling window, **single** rolling pass per input series, but scatter uses **average-rank** **`(less + 0.5×eq) / n`** mapped to **(1, 5)** — **not** 3-bar smoothed, **not** `np.clip`’d to endpoints. This removes artificial mass **exactly** at **1.0** and **5.0** on the regime-matrix scatter. See module docstring and `_rolling_dual_pct_to_buckets` / `_dual_last_packed` in `regime.py`.

**Forbidden / legacy pitfalls:**

- Second `rolling().apply` on the same `range_pct` / depth series just to derive scatter scores (double cost; use one pass with packed dual outputs).
- Using the **endpoint** percentile for **`vol_score`/`depth_score`** (reintroduces scatter rectangle edge pile-up).
- Setting scatter scores from **smoothed** `v_rank` or from **`v_rank`/`d_rank` alone** (wrong contract).
- Bulk **SQL or ETL** that copies old rows without recomputing ranks after a classifier change — mixed semantics; run **`python -m orderflow_pipeline.cli rebuild ...`** (§2.2).

**Checks:** [`scripts/diagnose_regime_scatter_scores.py`](scripts/diagnose_regime_scatter_scores.py) (histograms + exact 1.0/5.0 counts); [`pipeline/tests/test_regime.py`](pipeline/tests/test_regime.py) (`test_rank_integer_and_scatter_ranges`, `test_scatter_scores_avoid_exact_endpoints`).

---

## 5) Canonical Watches

Four canonical watches run continuously with edge-trigger fire behavior:

- `★ Breakout` at `[Impulsive · Light]` (`watchId: 'breakout'`).
- `◆ Fade` at `[Active · Normal]` (`watchId: 'fade'`).
- `🛡 Absorption Wall` (`watchId: 'absorptionWall'`) — primary **label** lens `[Climactic · Stacked]`; `isAbsorptionWallRegime` allows **`depthState >= 3` (Deep or Stacked)** and **`volState >= 2` (Active through Climactic)** — the **right-hand two** depth columns × three vol rows = **6/25** matrix cells, so the watch is not locked to a single Stacked column. Stall = contested **range** plus (tight **close vs prior** or small **open→close** body). Level includes **POC**; default band is **15** ticks. `getTunings()` **merges** `SYNTH_TUNINGS` with per-session 1m JSON. **Primitive** `type: 'absorption'` in `events.js` remains a separate concept.
- `🎯 Value Edge Rejection` (`watchId: 'valueEdgeReject'`) — regime **`isValueEdgeRejectRegime`:** **`volState` 2 or 3** and **`depthState` 2 or 3** (the **2×2 middle** of the 5×5: Active/Steady × Normal/Deep). **Failed edge:** for **VAH**, `high` probes **at or through** `vahPrice` (with small epsilon) and `close` is **strictly inside** `(val, vah)`; for **VAL**, `low` probes **at or through** `val` and the same `close` band holds. If both sides qualify on one bar, the **larger** of the two edge-side wicks (upper at VAH vs. lower at VAL) picks the edge. **Rejection wick:** at VAH, `(high − close) > (close − open)`; at VAL, `(close − low) > (open − close)` (same wick shape as the original spec). **Volume** must lie in **\[0.8, 1.2\]×** the mean volume of **up to 10** prior bars (≥2 settled bars, same short-session rule as other watches). **Direction** is always **toward POC** (`'down'` after VAH probe, `'up'` after VAL). `buildAlignment(lastBar, direction, 'fade')` and **gating** `alignment.vote_1h >= 0` (same as Fade). Tuning keys: `valueRejectVolMinMult` / `valueRejectVolMaxMult` (defaults **0.8** / **1.2**). Fires may carry `edge: 'vah' | 'val'` and `anchorPrice` for chart glyph placement at the value line.

### 5.1 Fade Criteria Update

Fade watch now evaluates **six** criteria. The five technical gates plus an HTF-alignment gate (Phase 6 follow-up — see §5.4):

- `balanced`
- `cell`
- `stretchPOC`
- `stretchVWAP`
- `noMomentum`
- `alignment` (1h bias not opposing trade direction)

Breakout watch likewise evaluates **five** criteria: `cell`, `sweep`, `flow`, `clean`, plus the same `alignment` gate.

**Absorption Wall** evaluates **five** criteria: `cell` (`isAbsorptionWallRegime`: **`depthState >= 3`** and **`volState >= 2`** — **Active·Deep** through **Climactic·Stacked**), `stall`, `volume` (current volume > `absorptionWallVolMult` × mean volume of **up to 10** settled bars **before** the current bar — with ≥2 settled bars so a one-bar prior mean exists, including **early session**), `level` (min distance to VAH, VAL, **POC**, or last anchored VWAP ≤ `absorptionWallLevelTicks × ES_MIN_TICK`), and `alignment`. **Stall:** when ≥11 prior bars, `(high − low) > absorptionWallStallMinRangeMult ×` mean prior-10 range **and** (|close − prior close| < `absorptionWallStallTicks × ES_MIN_TICK` **or** |close − open| < `absorptionWallStallBodyTicks × ES_MIN_TICK`); if mean prior range is 0, `stall` is false. With &lt;11 bars, the range part is skipped; only the close-vs-prior or in-bar body checks apply.

**Fires and chart glyphs** use `direction` as **mean reversion** off the bar: `close >= open` → `down`, else `up`. **HTF `alignment` votes** use the bar **impulse** the same way as Breakout’s sweep direction: `dir1m =` `close >= open` → `up`, else `down` (push into the level). `buildAlignment(lastBar, impulseDir, 'absorption')` — same anchor-priority tag **base** as `breakout` (no fade Wyckoff overlay).

Tuning keys (higher **hit rate** vs earlier builds): `absorptionWallVolMult` (default **1.15**; raise toward **1.3+** if RTH is too chatty), `absorptionWallStallTicks` (4.5), `absorptionWallStallBodyTicks` (3.5), `absorptionWallStallMinRangeMult` (0.25), `absorptionWallLevelTicks` (15). For 1m, `getTunings()` returns `{ ...SYNTH_TUNINGS, ...session.tunings }` so per-session **keys** override; missing keys keep dashboard defaults. See `getTunings()` in `state.js` for the merge.

All watch diagnostics and flip tracking must remain persistent across modal open/close cycles.

### 5.1a Canonical fire log rows (chart & event log)

Each row pushed to `state.canonicalFires` (and the full pre-scan `state.replay.allFires` in real mode) must include, in addition to `watchId`, `barTime`, `direction`, `price`, and optional `tag` / `alignment`:

- `checks` — shallow copy of the watch’s `canonical.checks` at commit time
- `passing` and `total` — same as the evaluator’s `passing` / `total` at that bar
- (Value Edge) optional `edge` and `anchorPrice` for halo/glyph Y placement on VAH/VAL

**Watch modal (★ / ◆ / 🛡 / 🎯) behavior**

- **Glossary (no fire context):** the modal uses live `evaluateBreakoutCanonical()` / `evaluateFadeCanonical()` / `evaluateAbsorptionWallCanonical()` / `evaluateValueEdgeReject()` for the current bar.
- **Shift+click a chart fire halo** (or **Details** on the post-fire banner after a pause): if the log row has `checks`, the modal shows that **frozen** gate list and a short “snapshot” note; the flip-tick / `lastCanonical` path is skipped for that one paint so live tracking is not clobbered. Rows recorded before this contract (no `checks`) show the same note and fall back to live evaluation.
- **Plain click on a chart fire** still only brushes the bar window; the chart tooltip hint documents Shift+click vs. click.

### 5.2 Force Controls in Real Mode

In API replay mode, force buttons are repurposed:

- Legacy synthetic labels `Force ★/◆/🛡` become jump actions (next fire navigation behavior) for matching `watchId`.

### 5.3 Anchor-Priority Tagging (Phase 6)

Each canonical evaluation that produces a fire also computes an `alignment` block and an `anchor-priority tag` from the latest bar's `biasH1` and `bias15m` (see §13):

- `alignment.score` ∈ `[-4, +4]` (sum of 1h + 15m votes against `dir1m`).
- `tag` ∈ `{HIGH_CONVICTION, STANDARD, LOW_CONVICTION, SUPPRESSED}`.
- During regime warmup `alignment` and `tag` are `null`; downstream renderers must handle null gracefully (no tint, no glyph).
- `tag === 'SUPPRESSED'` is only emitted when `state.biasFilterMode === 'hard'` and the 1h bias opposes `dir1m`. Suppressed fires are still persisted to `state.canonicalFires` (so they can be audited under `state.showSuppressed === true`) but must skip the canonical-fire banner and auto-pause.

### 5.4 Alignment as a Gating Check

`alignment` is also a **first-class criterion** in `evaluateBreakoutCanonical`, `evaluateFadeCanonical`, `evaluateAbsorptionWallCanonical`, and `evaluateValueEdgeReject`:

- `checks.alignment` — 1h vote on `dir1m`: for **breakout**, **fade**, and **value edge** (MR toward POC), `(alignment.vote_1h >= 0)` (no opposing 1h trend to the play). For **absorption wall** only, **`alignment.vote_1h >= -1`** (vetoes strong 1h disagreement only) while `dir1m` remains the **bar impulse**, not the MR `direction` on the fire record.
- The check evaluates `true` when biases are NULL (`vote_1h` defaults to `0` via `vote(null, dir)`) and when `biasFilterMode === 'off'`, preserving synthetic-mode and warmup behavior.
- `fired = passing === total` continues to be the gate, with `total = 5` for breakout, absorption wall, and value edge and `total = 6` for fade.
- Practical effect: in `soft` mode, an opposing 1h bias produces a `LOW_CONVICTION` tag **and** fails the `alignment` check, so the fire no longer triggers — the tag is purely diagnostic. The watch panel still surfaces partial `passing/total` and tag tints so the user can see "would-be" fires that the alignment gate filtered out.

### 5.5 Fade-Specific Wyckoff Overrides

For `evaluateFadeCanonical` and `evaluateValueEdgeReject`, `buildAlignment(lastBar, dir1m, 'fade')` applies a Wyckoff overlay on top of the base anchor-priority tag (same `watchKind` for MR plays):

| `dir1m` | `biasH1` | Effect |
| --- | --- | --- |
| `up`   | `ACCUMULATION`   | Upgrade tag to `HIGH_CONVICTION`, `reason = 'wyckoff_spring'` |
| `down` | `DISTRIBUTION`   | Upgrade tag to `HIGH_CONVICTION`, `reason = 'wyckoff_upthrust'` |
| `up`   | `BEARISH_STRONG` | Annotate `reason = 'falling_knife'` (tag remains LOW/SUPPRESSED from base rule) |
| `down` | `BULLISH_STRONG` | Annotate `reason = 'falling_knife'` (tag remains LOW/SUPPRESSED from base rule) |

`score`, `vote_1h`, `vote_15m` are never modified by the overlay — only `tag` (and `reason`) — so score-tinted UI remains consistent with the raw vote sum.

The breakout evaluator uses the default `watchKind = 'breakout'`; the absorption-wall evaluator passes `watchKind: 'absorption'`, which shares the same base tag path as `breakout` (no Wyckoff overrides). Both use continuation-style / impulse `dir1m` for the vote (breakout: sweep direction; absorption: bar impulse). Pass-through name `'absorption'` is explicit so the contract is not confused with the MR `direction` on the fire record.

---

## 6) Matrix Panel Enhancements

Watched cells: breakout (amber stripe), fade (blue), absorption wall (indigo `--indigo-fire` stripe) on the **six** cells with **Deep or Stacked** book and **Active+** vol (`isAbsorptionWallRegime`), value edge (teal `--value-edge` stripe) on the **four** middle cells with **`volState` 2–3** and **`depthState` 2–3** (`isValueEdgeRejectRegime`). Right column also includes matrix controls beyond posterior view:

- **Display mode toggle:** `Posterior` / `Heatmap`.
- **Occupancy range selector:** Pills are ordered **Last hour**, **Current RTH**, **Last N sessions**, **Custom**; initial dashboard default is **Last hour** (`range.kind === 'lastHour'`).
  - **Last hour** (`range.kind === 'lastHour'`) resolves a rolling **60-minute** window ending at the effective right-edge bar’s bar time (UTC ISO from `replay.allBars`).
  - **Current RTH** (`range.kind === 'session'`) resolves the RTH window of the internal session containing the effective right-edge bar: index **`clamp((chartViewEnd ?? cursor) - 1, …)`** into **`replay.allBars`** (same effective edge as viewport / matrix).
  - Last N sessions
  - Custom datetime range  
  (An unbounded **All loaded** matrix window was removed — full-span occupancy was too heavy for typical machines.)

Heatmap rendering is backed by `/occupancy`; occupancy diagnostics must reflect the active range window.

### 6.1 Regime Matrix Scatter Plot (Candle Overlay)

- The matrix renders a **continuum scatter** on **`#matrixScatterCanvas`** inside **`.matrix-point-layer`** (**one plotted sample per eligible bar**, no coordinate dedup). Raster pass uses **`globalCompositeOperation = 'lighter'`** so stacked semi-transparent disks add luminance like a density pile-up. **`hover`/selected disks are omitted from that pass** and repainted **`source-over`** with the exact **chart-candle** hue (`_matrixScatterCandleFillAndStroke` uses **`CHART_CANDLE_UP`** / **`CHART_CANDLE_DOWN`**) so hue does not drift from **`lighter`** underlap when the hover radius grows. Hit targets for hover/selection are accumulated each paint in **`state.matrixScatterHits`** (CSS-pixel `x,y,r,barTimeMs`); **`pickMatrixScatterBarTime(clientX, clientY)`** in `src/render/matrix.js` walks hits newest-first.

- Bar source: **`range.kind === 'session'`** uses **`replay.allBars.slice(session.startIdx, session.endIdx)`** — same session span as `resolveOccupancyWindow()`’s session pick (index-based, not client session-start/end ISO strings). Other ranges use **time filtering**; when **`state.matrixState.occupancy`** is loaded, **`occupancy.from` / `occupancy.to`** (server-resolved, matching `/occupancy`) take precedence over `resolveOccupancyWindow().from/.to` so the scatter matches **`total_bars`**. The **live forming** bar is appended when its time lies in that window. Synthetic mode or missing windows fall back to **chart-viewport-visible** bars.

- **`bindSelectionUI`** (`selection.js`): `mousemove`/`mouseleave` on **`#matrixPointLayer`** drives linked hover via **`pickMatrixScatterBarTime`**. **Click on the scatter canvas** stops propagation so delegated **`#matrixGrid`** cell clicks do not run (the canvas sits above cells). **Hit on a dot** → `pickMatrixScatterBarTime` → single-bar selection. **Click on the canvas but not on any dot** → **`pickMatrixCellFromScatterCanvas`** maps the pixel to the underlying **5×5 cell** and calls **`selectCell`** (same **`/bars?cell=`** brushing as clicking the `.matrix-cell` chrome). Shift-click still toggles multi-cell selection. Clicks on the grid outside the canvas (e.g. row/column labels) still use `.matrix-cell` directly.

- **Warmup / null-coordinate bars** are excluded (no drawable sample when ranks and continuous scores are both unusable).

- Opacity anchoring uses chronological order within the plotted bar list; the newest bar trends to **`POINT_MAX_OPACITY`**, oldest toward **`POINT_MIN_OPACITY`**.

- **Scatter coordinates (fills the plotted frame):** each bar supplies **`vol`/`depth`** (continuous **`volScore`/`depthScore`** when present — **strictly inside (1, 5)** for multi-sample rolling windows under the mid-rank scatter track — else rank jitter in **`[rank−0.5, rank+0.5]`** via `_stableUnitPair`, still clipped to **`[1,5]`**). Rendering maps the **active batch’s empirical min/max** on **each axis** to canvas **[0,1]** with **no artificial padding** (`depth` → X, **`vol`** inverted so higher vol is toward the top). If variance on one axis collapses (**span &lt; 1e−6`), that axis falls back to **`(depth−1)/4`** or **`(5−vol)/4`**. Pipeline: **`v_rank`/`d_rank`** use a 3-bar-smoothed **endpoint** percentile (midpoint of the window → bucket 3); **`vol_score`/`depth_score`** use the **same rolling window with one pass** but an **average-rank** percentile for scatter so points do not pile on **exactly 1.0 / 5.0**. **`scripts/diagnose_regime_scatter_scores.py`** prints histograms (including exact endpoint counts) for diagnosis.

- **Volume → dot size (decoupled from chart viewport):** base radius scales with **`sqrt(volume)`** winsorized at **p5–p95** on sorted sqrt volumes over the **loaded timeframe bar set** (`replay.allBars` in API replay; rolling `state.bars` in synthetic). Percentile cutoffs are **`MATRIX_LADDER_LO_PCT` / `MATRIX_LADDER_HI_PCT`** in `src/analytics/matrixLadderConstants.js` (shared naming with ladders used elsewhere). Mapping runs through `src/analytics/matrixVolumeRadiusNorm.js` into a band around **`POINT_RADIUS_PX`** (defaults **0.65×–1.35×**). Tail clamping keeps one-off spikes from dominating the ladder; spike-heavy sessions compress extremes vs widening to **p1–p99** (future tunable). The ladder recomputes when that loaded set changes (reload / TF switch), **not** when the chart pans within the same load — so panning does not rescale dots for cross-slice comparison on the regime surface.
- **Candle OHLC → dot fill:** scatter disk **fills** track the **same rule as chart candle bodies**: **`close < open`** → **`CHART_CANDLE_DOWN`** (**`#ff3b30`**), **`close ≥ open`** → **`CHART_CANDLE_UP`** (**`#00c087`**); non-finite open/close → neutral gray (`hsl(210, 12%, …)`). **Delta is not encoded in hue** — only OHLC-linked green/red (+ neutral when OHLC unavailable). Idle (non-hover) disk edge uses a slightly subdued ring (`rgba(..., 0.55)`).
- **Hover / selection:** radii multiply the volume-derived base (**`MATRIX_POINT_HOVER_RADIUS_MULT` ~1.3**, **`MATRIX_POINT_SELECTED_RADIUS_MULT` ~1.5** in `matrix.js`) so interaction does not flatten relative volume ordering; hover/selection strokes remain **highlight white**. In API replay, when **`hoverBarTime`** falls inside a loaded **CVD divergence** interval (**`earlierTime`–`laterTime`** from **`replay.allDivergences`**), **every** scatter point whose bar lies in that interval receives the same hover emphasis (not only the bar under the cursor). When **`selection.kind === 'cells'`**, scatter **selected** (white) stroke requires both membership in **`selection.barTimes`** (from **`/bars?cell=`** on integer **`v_rank`/`d_rank`**) **and** that the dot’s pixel lies in the same **5×5 grid cell** as one of **`selection.cells`** (`_matrixCellFromScatterPixel` in **`matrix.js`**) — continuous **`volScore`/`depthScore`** placement can otherwise paint a bar outside its rank cell while the bar still belongs to the brushed rank set; the **price chart** tint/halo still uses **`barTimes`** alone for the full brushed cohort.
- Default visual tokens are centralized in `src/render/matrix.js` constants (`POINT_MIN_OPACITY`, `POINT_MAX_OPACITY`, `POINT_RADIUS_PX`, hover/selected multipliers, stroke width). Volume ladder tuning remains in **`matrixLadderConstants.js`** / **`matrixVolumeRadiusNorm.js`**. (**`matrixDeltaColorNorm.js`** remains available for diagnostics or future encodings — it does not drive the scatter hue anymore.)
- Morphology colorization is a hook only: **`resolvePointStyle(bar, opts)`** can later map `bar.morphologyClass` without changing scatter data plumbing.

---

## 7) Charting Requirements

### 7.1 Price Chart

`src/render/priceChart.js` must support:

- **Layout / theme:** **`#priceChart`** lives in **`.chart-canvas-stack`** at fixed stack height **465px** with **`#chartDrawOverlay`** absolutely stacked over it (**`z-index: 3`**); overlay **`pointer-events: none`** until **`chart-wrap-annotations-active`** on **`#priceChartWrap`**. **`#flowChart`** (per-bar delta histogram) and **`#cvdChart`** (session CVD line) each use CSS height **128px** so the CVD sparkline has enough vertical range. The price canvas and `.price-wrap` use **`#000000`** background; OHLC + volume sub-band candles use **Webull-style** greens/reds (`CHART_CANDLE_UP` **`#00c087`**, **`CHART_CANDLE_DOWN`** **`#ff3b30`** from `src/config/constants.js`, also mirrored in CSS **`--up` / `--down`**). The delta lane canvas matches the same **black** + palette.
- **Session annotations (no persistence):** The **✎** control to the **right** of the HTF bias **`i`** legend (`orderflow_dashboard.html`) toggles a toolbar (**Select**, **Pen**, **Text**, **`input[type=color]`**, delete). **`src/ui/chartDrawOverlay.js`** stores freehand paths and text labels **only in memory** for the browser session. **Pen** captures pointer-drawn polylines; **Text** uses **`prompt()`** then anchors **`IBM Plex Mono`** labels at the click. **Select** picks the top-most object (polyline proximity ~10px; text bounding box); drag translates; **⌫** / **Delete** / **Backspace** removes selection; **Escape** exits annotation mode. Color changes apply to the selection or the next stroke/text. Wheel over the overlay invokes **`handlePriceChartWheelZoom`** (`pan.js`) so candle zoom still runs; horizontal pan drag stays on **`#priceChart`** — turn annotations **off** for unobstructed chart interaction.
- Candles + event markers + fire halos. When a **sweep** and **divergence** both fire on the same bar and the same side (e.g. both at the low), their glyphs are vertically separated: the sweep triangle stays farther from the candle body and the divergence warning is offset toward the body so the two do not overlap. Standalone sweeps/divergences keep their prior single-event offsets. Fire halos render the watch-type
  glyph: ★ above the bar high for breakout; ◆ above the high for fade; 🛡 for absorption wall at the **high** when `close >= open` and at the **low** otherwise. Fade and absorption-wall halos add a smaller (9px) directional arrow (`↑` / `↓`) to the *right* of the glyph. Breakout keeps no arrow (sweep direction is the primary read).
- Candle rendering mode toggle in replay row (`Standard` / `PHAT`). PHAT mode is enabled only when loaded bars expose PHAT features and otherwise falls back to standard candles.
- When PHAT mode is active, an **`i`** control beside the Candle selector (**click**) opens a **centered modal** (`#phatLegendModalOverlay` / `src/ui/phatLegendModal.js`) over a dimmed backdrop — **not** the HTF bias ribbon hover popover. Close with the **×** control, **Escape**, or a **backdrop click**. While open, **`Escape`** must not also clear brush selection (`selection.js` gates on `isPhatLegendModalOpen()`). The dialog summarizes **neutral** (side-by-side translucent green/red swatches, **disagreement** copy) vs **P-shape** vs **b-shape**, **body width vs volume** (narrow/wide mini-candles + viewport-relative scaling copy), **Wicks** (positive copy only: uniform stroke from body to high/low; asymmetric body attachment from sweep/extreme order), a **What the chart renders** footer for imbalance threshold and matrix cross-reference (**§6.1**), and a compact **PHAT fields & docs** note linking **`requirements.md §7.1`** and **`docs/phat_wick_liquidity_research.md`**. Layout: `orderflow_dashboard.html` + `styles/dashboard.css` (wide panel, scrollable).
- **PHAT reference:** `demo_files/candle_prototype.html` is the authoritative base form (asymmetric wicks, body-width tiering; prototype includes rejection rings). The **dashboard defaults** hide wick-tip circles (`phatShowWickRejectionRings`); body shading intentionally diverges to the threshold-gated model from `notes.txt`.
- **Blocking data check (all chart timeframes):** run `python scripts/diagnose_phat_fields.py --timeframe 1m --api-base ... --session-date ...`, `--timeframe 5m`, `--timeframe 15m`, and `--timeframe 1h` before PHAT UI validation. PHAT work is blocked until DB + `/bars` checks pass on all four.
- **Optional PHAT research (not blocking UI):** `python scripts/phat_wick_liquidity_distribution.py` reads DuckDB `bars` read-only and prints wick-liquidity / wick-length histograms, absorption-vs-exhaustion breakdown by wick length (section **E**), plus CSV under `data/` by default (`docs/cursor-prompt-wick-liquidity-histogram.md`).
- **PHAT rendering contract:** Body shading is threshold-gated, not continuous gradient. Compute `imbalance = abs(topCvdNorm - bottomCvdNorm)` and compare to `state.phatBodyImbalanceThreshold` (default **0.30**). If below threshold, render a neutral flat body. If above threshold and **directionally agreeing**, render **P** shading for up bars (top-heavy) and **b** shading for down bars (bottom-heavy). **Disagreement is locked to neutral-only** (Option A). Wick geometry is asymmetric by `highBeforeLow`; each wick segment uses **uniform 1px** stroke width when **`phatShowWickLiquidityStrokeScaling`** is **false** (default), and scales from **1px** to **~1.85px** with **`upperWickLiquidity`** / **`lowerWickLiquidity`** per segment when the flag is **true**. Non-forming PHAT bodies draw a thin outline in the wick/candle color so wick segments visually connect to the body edge (prototype-style continuity). **Body width:** still tiers off `maxBodyW = min(slotWidth × 0.6, 30px)` with **`× 0.7`** when the body is **≤ 1 tick** (`|close − open| / ES_MIN_TICK`), else **`× 1.0`** — then maps bar **`volume`** linearly between **`minCap`** and that tier cap **`maxCap`**, where **`minCap = maxCap × PHAT_WIDTH_VOLUME_MIN_CAP_FRAC`** (default **`0.20`**) using **`volumeNorm01Linear`** over **visible** bars (`computeViewportVolumeRange` / `viewportVolumeNorm.js`). Final width keeps at least **2px**. Chart encoding is **viewport-relative** for legibility (pan/zoom rescales widths); regime matrix dot sizing stays **decoupled** (§6.1). Optional future refinement: widen the viewport min/max volume window by ±**N** adjacent bars to reduce width jitter while panning (not implemented yet).
- **PHAT wick liquidity vs wick-tip disks (Option A + shelving):** `upperWickLiquidity` / `lowerWickLiquidity` on **`/bars`** feed rejection **ring-fill** eligibility, hover/research payloads, and (when **`phatShowWickLiquidityStrokeScaling`** is **true**) optional **wick stroke width** scaling (**1–~1.85px** per segment — default **`phatShowWickLiquidityStrokeScaling`** is **false**, uniform **1px** wicks). Stroke scaling is **orthogonal** to wick-tip disk visibility (**`phatShowWickRejectionRings`**). **Wick-tip rejection classification** (absorption vs exhaustion, `rejectionSide`, `rejectionStrength`, `rejectionType`) is still computed in [`pipeline/src/orderflow_pipeline/phat.py`](pipeline/src/orderflow_pipeline/phat.py) and returned on **`/bars`** with wick tick columns — for research/backtest, not validated for predictive utility as a **primary** UI signal. **Default:** wick-tip **filled/hollow circles are not drawn** (`state.phatShowWickRejectionRings` **false**). **Hover payload (data layer):** [`src/render/priceChart.js`](src/render/priceChart.js) `_buildPhatHoverPayload` **always** includes `rejection`, `rejectionRingFilled`, and `rejectionSideWickTicks` regardless of `phatShowWickRejectionRings` — only **canvas** ring drawing and **tooltip/legend presentation** gate on the flag, so re-enabling circles does not require rediscovering payload shape. **When circles are enabled:** at most one ring when `rejectionStrength > 0`; radius 2–5px from strength. **Eligibility:** rejection is cleared in `phat.py` when the chosen side has **no geometric wick**; the chart classifier mirrors zero-span wicks. **Ring fill** when drawn: rejection-side wick span **`>= phatMinWickTicksForRingFill`** (default **2**); **exhaustion** also needs side liquidity **`>= phatExhaustionRingLiquidityThreshold`**; **absorption** uses the wick gate when `phatGateAbsorptionRingsByWickLength` is **true** without a liquidity fill threshold. Dimmed/brushed bars: ring fill and stroke use **×0.45** alpha when rings are shown. Histogram / empirical notes: [`docs/phat_wick_liquidity_research.md`](docs/phat_wick_liquidity_research.md), `scripts/phat_wick_liquidity_distribution.py`.
- **PHAT hover classification tooltip:** in PHAT mode, hovering a candle body emits a `phatCandle` hit ([`src/ui/tooltip.js`](src/ui/tooltip.js)). **Visual hierarchy:** compact **header**; **gestalt line** (quoted italic); optional **⚠** when **disagreement** (high imbalance vs bar direction, neutral body); **measurements** grid (Vol. (view), imbalance vs gate **G**, delta). **`_buildPhatHoverPayload`** includes **`isUp`** (OHLC) so tooltip copy aligns **scatter disk hue with chart candles** beside the Delta row (**`scatter green/red · matches chart OHLC`**). User-facing copy avoids internal design labels (e.g. “Option A”) and uses “detected” rather than trader jargon “printed” for wick-level rejection. When `phatShowWickRejectionRings` is **false** (default), the **Rejection** row shows **none** and gestalt wording uses the **no wick-level rejection** branch even though the payload still carries rejection fields. When the flag is **true** and the bar has rejection, **rejection** uses two lines — summary (`Upper wick · exhaustion · open ring`, etc.) plus sub-line with liquidity, wick span in ticks, exhaustion threshold context, strength. **Footer:** “PHAT read is descriptive, not predictive”. Payload from `_buildPhatHoverPayload`. Strength buckets: `weak` / `moderate` / `strong` from `rejectionStrength`.
  - Hover conflict rule: `event` / `fire` / `bias` hits have higher priority than `phatCandle` when regions overlap; nearest-hit applies within a priority tier.
- **PHAT rejection detection (`pipeline/src/orderflow_pipeline/phat.py`):** Uses looser numeric gates than the prototype’s simulated step-count + 50% retreat so real bars still get sparse markers; there is no alternate strict mode in code.
- **Timeframe-computation constraint:** 15m/1h PHAT fields must not be rolled up from 1m PHAT columns. They must be computed from each timeframe bin’s own trade/tick window during that timeframe aggregation pass.
- Session-anchored VWAP with reset by session boundaries (real mode).
- Profile overlays (POC/VAH/VAL).
- RTH session open dividers with **session date** labels at **top** of the candle pane. **Canvas strip below the volume band** (the black band above HTML “Chart view”): **US Eastern** (`America/New_York`, DST-aware) **12-hour** clock ticks on the x-axis, each suffixed **`ET`** (e.g. `2:30 PM ET`). `bar_time` in the DB remains UTC; only the **display** is converted. If the viewport spans **multiple Eastern calendar days**, ticks after a day change show **`Mon DD`** before the time (e.g. `Apr 28 9:05 AM ET`). Tick sampling uses denser spacing on **`1m` / `1h`** than on **`5m` / `15m`**: **`5m` / `15m`** yield fewer ticks, a larger minimum pixel gap between bounding boxes when panning dense multi-day spans, so labels do not overlap **Mirrored bottom-row session calendar dates** (viewport-aware thinning, at most ~10) appear only when **≥2** session-open dividers are visible **and** the timeframe is not **`5m` / `15m`** (where that row would collide with wider date+time labels) **and** the viewport is **not** already multi-day (clock ticks carry day prefixes). Single-session **`1m`/`1h`** windows do not duplicate the bottom date strip unless multiple session opens satisfy the guards above.
- Hover tooltip and hit-testing.
- `NOW` marker at live edge.
- `PANNED` hint when detached from live edge (right-edge bar time in **Eastern**, `… ET`, same as the x-axis).
- `↺ Live` control to return viewport to live cursor.
- **Bias ribbon** rendered above the candle pane via `src/render/biasRibbon.js` (Phase 6). Layout is timeframe-aware:
  - `1m` / `5m`: two strips (1h, then 15m).
  - `15m`: one strip (1h).
  - `1h`: one self-strip showing the active timeframe's own bias.

  Ribbon hit regions emit `kind === 'bias'` hover hits consumed by the chart tooltip.
- **Repeat cooldown (chart signals):** After `detectEvents` produces candidates for a settled bar, `filterNewEventsCooldown` in `src/analytics/events.js` drops primitives that match the same signature `(type, dir)` as a recently kept event when the bar index gap is smaller than `eventCooldownBars` (default **4** from `SYNTH_TUNINGS` / per-session replay tunings). Cooldown indices are resolved on `state.replay.allBars` in API replay (global bar index, aligned with `sessionStartIdx`), and on the rolling `state.bars` window in synthetic mode. Bar times are matched by epoch ms so `Date` vs serialized time never bypasses dedup. When `sessionStartIdx` is set, pool entries before that index are skipped as anchors (continue), not compared with `===` to ring-buffer indices. Synthetic **`precomputeAllEvents()`** (checklist-selected path) applies the same rule using `allBars[0..i]`. Canonical halos (★ / ◆ / 🛡 / 🎯): `handleWatchFire` uses the same index source + session rule in `isCanonicalFireRepeatTooSoon`. Suppressed near-duplicates are omitted from `state.canonicalFires` / `replay.allFires` (no banner row for that edge).

### 7.2 Interaction

- **Mouse wheel** over the price canvas (**or over `#chartDrawOverlay`** while annotations are active — same **`handlePriceChartWheelZoom`** path) adjusts **`chartVisibleBars`** (horizontal zoom — wider vs narrower candles). **Drag** (real mode, enough loaded history) pans along time via **`chartViewEnd`** / **`_setViewEnd`** (same as **chart pan** slider scrub). With the pointer over the price canvas, **ArrowLeft** / **ArrowRight** step the same viewport along the loaded timeline (3 bars per key repeat; no-op when a modal is open, when focus is in a form control, or when pan is unavailable).
- The lower **profile legend** row describes candles/volume in plain language (**OHLC for the selected timeframe** — `1m` / `5m` / `15m` / `1h`; volume **per candle**) and acts as a visibility toggle for chart overlays: clicking **POC**, **VAH / VAL**, or **VWAP** toggles the associated lines/labels on the price chart and profile sidebar without changing bar data, profile fetch behavior, or replay state.
- Brushing-and-linking:
  - Matrix cell click filters/tints matching bars.
  - Fire click highlights a fire-centered fixed window (fire bar + next 30 bars).
  - Candle click (standard or PHAT) selects that exact bar and highlights its scatter marker.
  - Scatter-canvas hit on a disk (`pickMatrixScatterBarTime`) selects that exact candle on the chart; a canvas click that **misses** all disks maps to the cell under the pointer (`pickMatrixCellFromScatterCanvas`) and runs the same **matrix cell brush** (`selectCell` + `/bars?cell=`) as a direct `.matrix-cell` click.
  - Hovering either a candle body (or PHAT body) or a scatter disk previews linked highlighting via transient shared hover state.
  - `Escape` or clicking empty chart/matrix areas clears active selection as before.

---

## 8) Event Log Requirements

Event log (`src/render/eventLog.js`) must:

- Interleave chronological rows from **events + fires**.
- Include selection context banner while brush filters are active.
- Keep warmup SYSTEM row sticky while warmup is active.
- Support clickable fire rows that trigger fire-window selection.
- Show clear empty states for both unfiltered and filtered contexts.
- In the Event Log header meta (`#eventCount`), disclose the total number of rows currently shown after filters/selections (no hidden latest-only cap). In API replay, counts reflect **glossary-driven filtering** (`activeEventTypes` + `activeCanonicalFireTypes`), not a separate log-only control.
- Render an **Align column** (Phase 6) between the fire label and price, displaying the anchor-priority glyph (`✓✓` / `·` / `⚠` / `⊘`) and signed alignment score for fires; events render an empty placeholder cell so the grid stays consistent.
- Apply a low-alpha row tint driven by the fire's `tag` and `|score|`:
  - `HIGH_CONVICTION` → green
  - `LOW_CONVICTION` → amber
  - `SUPPRESSED` → red
  - `STANDARD` → near-transparent green/red leaning in the direction of `score` sign.
- Filter `SUPPRESSED` fires from the visible rows unless `state.showSuppressed === true`.
- In API replay, chart markers **and** **`replay.allEvents`** for the inventory reflect **`loadEventsForActiveTypes()`** when glossary checkboxes are selected; otherwise **`replay.allEvents`** may be empty at rest. Fires still use **`replay.allFires`** after **`precomputeAllFires()`**. Synthetic mode continues to use **`state.events`** live + **`canonicalFires`** when not using the deferred primitive path.
- In API replay with `apiBase` present, frontend canonical evaluators remain available for watch diagnostics, but they must not emit/append frontend canonical fire rows; plotted canonical fires are sourced from backend `/fires` only.
- **No separate Type dropdown:** the log is filtered by the same **`activeEventTypes`** / **`activeCanonicalFireTypes`** sets as **Signals & glossary** (see `src/render/eventLog.js` `_checklistPassesRow`). API replay: if both sets are empty, the log stays empty with a hint to check types in the glossary. Synthetic: when both sets are empty, the full interleaved timeline shows (glossary panel isn’t populated for inventory).
- **Column sort:** header buttons on **Time**, **Align** (canonical alignment score; primitive rows sort after fires), and **Price** toggle asc/desc. State: **`state.eventLogSort`** `{ column, dir }` (`src/state.js`).

### 8.1 Signals & glossary (full load, single table)

After bars load, **`precomputeAllFires()`** still builds **`replay.allFires`** for canonical jump-to/halos (`src/data/replay.js`). **`replay.allEvents`** is **not** fully precomputed at API bootstrap anymore.

**API load / timeframe reload:** the first full commit to the tape end uses **`seekAsync(allBars.length)`** (batched yields so the main thread can paint progress), not synchronous **`seek`**. A **`#chartSeekLoading`** overlay on the price chart shows **“Replaying bars… N / total”** while work runs; **`drawPriceChart()`** and the rest of the seek tail (**`renderMatrix`**, flow chart, chrome) run **once** when that async pass completes — not every batch. Synchronous **`seek()`** remains for scrubber, jump-to-fire, **`precomputeAllFires`** slow path, and timeframe snap after load. Before each **`_loadAllSessionsFromApi`**, the client **`await`s** any pending **`seekAsync`** so bar arrays are not replaced mid-replay.

The **Signals & glossary** section (`#signalGlossarySection`) contains one **`#eventInventory`** table (`src/render/eventInventory.js`) that replaces separate glossary and inventory lists:

- **Canonical entries:** short definitions (from the old glossary), full-load counts, **modal** links (`data-modal` on name buttons), and a **checkbox per `watchId`** (default **unchecked**) that toggles **`state.activeCanonicalFireTypes`** and repaints chart halos + summary (no HTTP refetch).
- **Flow primitives:** short definitions, full-load counts, modal links, and a **checkbox** per primitive key (default **unchecked**). Checked keys populate **`state.activeEventTypes`** and trigger **`loadEventsForActiveTypes()`**, which fetches **`GET /events`** with **`types=`**, **`from`/`to`** from **`replay.dateRange`**, and the active **`timeframe`**. **Synthetic** mode runs **`precomputeAllEvents()`** only when at least one key is checked (same cooldown rules; no HTTP).
- Horizontal share bars use one **max** across both groups; counts for primitives reflect **whatever is loaded into** **`replay.allEvents`** given the checklist; fire counts remain from full **`precomputeAllFires`**.

The summary line states the timeframe, loaded bar count, primitive total + active primitive keys, fire total + active halo keys (`(none)` when empty).

---

## 9) Replay Controls

When real data is loaded, show:

- **`seek` vs `seekAsync`:** **`seek()`** remains synchronous for step/jump, **`precomputeAllFires`** slow path, post-load timeframe snap, etc. Initial full-timeline commit after **`/bars`** fetch uses **`seekAsync()`** (`src/data/replay.js`) only from **`_loadAllSessionsFromApi`**, with **`#chartSeekLoading`** progress overlay; another load or TF switch **`await`s** the in-flight **`seekAsync`** before replacing **`replay.allBars`**.
- **Dashboard header playback strip:** **`#streamBtn`**, **`#resetBtn`**, and **`#speedSlider`** / **`#speedValue`** live in **`.header-playback`** (upper-right of **`.header`**, compact inline layout in **`orderflow_dashboard.html`** / **`styles/dashboard.css`**), not as separate full-width rows below the title.
- **Timeframe + candle row:** **`#replayRow`** — **Timeframe** (`1m` / `5m` / `15m` / `1h`) and **Candle** (**Standard** / **PHAT**) segmented controls. Placed in the **upper-right** of the **Price · Volume Profile · Events** section head (same row as the section title), replacing the retired **`barCount`** status text (`Tf bars · N shown · …`). There is **no** seek scrubber, step buttons, or playback time readout — **`replay.cursor`** is advanced by **stream** / **Reset** / internal **`seek()`** (e.g. jump-to-fire, resume-stream snap), not by a header timeline control.
- **Chart pan row:** full-width **`chartPanSlider`** below the price canvas — adjusts **`chartViewEnd`** (viewport right edge via **`_setViewEnd`**), **not** the underlying cursor index for history inspection. Slider minimum/maximum follow **`replay.dateRange`** / bar count and **`chartVisibleBars`** (how many bars fit in the viewport width). While hovering/dragging/focusing the slider, a thumb-follow tooltip shows the right-edge bar time at that position in **US Eastern** (`Mon DD h:mm AM/PM ET`) so the scrub position is date-addressable. **`MAX_BARS`** remains the rolling-buffer size for streaming commits, distinct from **`chartVisibleBars`**.

**Pan vs playback:** dragging the chart pan slider scrolls the visible window along the loaded bars. **Start Stream** / **Resume** drives **`replay.cursor`** forward. **`↺ Live`** clears **`chartViewEnd`** lock.

**Delta Distribution vs viewport:** **`drawFlowChart()`** (`src/render/flowChart.js`) slices bars with **`_getViewedBars()`** — the same window as the price chart. It is invoked whenever that window changes: **`_setViewEnd`** (slider + drag-pan), **`returnToLiveEdge`**, wheel zoom on the price canvas, **`seek`**/**`step`** pipelines, **`resize`**, and selection **`_repaint`** paths that jump **`chartViewEnd`** (e.g. jump-to-fire). **`layoutViewportStripForSubchart()`** (`src/render/chartStripLayout.js`) computes **`slotW`** / **`padL`** from the **price** canvas CSS width when available (matching the candle strip: **`chartW = width − PROFILE_W − 22`**). **`drawCvdChart()`**, **`barTimeMsFromSubchartX()`**, and the delta panel share that layout so hover crosshairs and bar centers do not drift across bars when panning (previously the CVD panel used a wider left pad and a smaller **`chartW`**, which skewed **`slotW`** relative to the histogram and main chart).

**Swing triangle tooltips (API replay):** Fractal swing markers on the price chart (**`price_high`** / **`price_low`**) and on the session CVD line (**`cvd_high`** / **`cvd_low`**) show interpretive hover tooltips in **`src/ui/tooltip.js`**: hit targets are registered in **`drawPriceChart()`** (**`chartHits`**, **`kind: 'priceSwing'`**) and **`drawCvdChart()`** (**`state.cvdSwingHits`**). Copy explains the **K**-bar pivot rule, shows **K** from the row or the Δ-section header when uniform, and lists the pivot value (session CVD or bar H/L) plus bar time (US/Eastern). The shared **`#chartTooltip`** is **`position: fixed`** when opened from **`#cvdChart`** so it is not clipped under **`.price-wrap`**.

**CVD divergence spans (API replay):** For each bar whose **`bar_time_ms`** lies in **[`earlierTime`, `laterTime`]** (inclusive) of a loaded **`replay.allDivergences`** row, the **standard** and **PHAT** candle tooltips append pipeline divergence lines: kind (**`bearish`** / **`bullish`**), **Δprice** and **Δsession CVD** (later minus earlier anchors), **bars between** swing anchors, and **size confirmation** (matches dashed vs solid connector stroke). **`drawPriceChart()`** registers **`chartHits`** entries with **`hitShape: 'segment'`** / **`kind: 'divergenceSegment'`** along each price-panel connector; **`drawCvdChart()`** fills **`state.cvdDivergenceHits`** for the CVD-line connectors. Hovering within a few pixels of a segment shows a **`divergenceSegment`** tooltip (same facts, **`position: fixed`** from **`#cvdChart`**). Hit priority keeps **swing triangles** above connector segments at shared endpoints (**`_hitTestChart`** in **`tooltip.js`**). The delta section header **◀ / ▶** buttons re-use the same rows to pan **`chartViewEnd`** via **`_setViewEnd`** (same path as chart pan / zoom) so price, delta, and CVD stay aligned; **`orderflow:chart-view`** fires from **`_renderReplayChrome()`** so button disabled state tracks the viewport.

**Linked hover crosshair:** When **`selection.hoverBarTime`** is set from the price canvas, delta histogram, session CVD panel, or matrix hover, **`drawFlowChart()`** / **`drawCvdChart()`** draw a teal vertical line at that bar; **`drawPriceChart()`** draws the same line from the ribbon through the candle pane and the in-canvas volume strip (**`PAD.t` → `volTop + volBandH`**, same horizontal layout as the subcharts via **`layoutViewportStripForSubchart`**).

**Jump to next (canonical modals):** **`jumpToNextFire(watchId)`** (`src/data/replay.js`) wires from **`modal.js`** (not only `controls.js`) so the button is not blocked by fragile ESM init order across modules. Canonical fires for each watch are **sorted by time**; lookup uses **`modalFireContext`** (“next strictly after clicked fire”), else “next fire at/after **`replay.cursor`**”, else **wrap** to the **earliest** same-watch fire in loaded data (`chain[0]`). **`_findClosestBarIndex`** tolerates **`barTime`** mismatches vs **`allBars[i].time`**. **`src/ui/modal.js`** also exposes **`resetModalPanelPosition`** and **`bindModalDrag`**: grab the **`modal-drag-handle`** (`#modalHead` strip) to move **`#modalPanel`** with **`position: fixed`**; resets when the overlay closes/opens.

Mode subtitle summarizes the calendar span and states that chart pan previews history while stream advances playback.

### 9.2 Layout (`orderflow_dashboard.html`)

- **Shell:** The main **`container`** uses the full browser width (no centered **`max-width`** gutters). From **`1100px`** viewport width up, **`grid-main`** is **`minmax(0, 1fr)`** for **`col-left`** and a fixed **`col-right`** width (**`--dashboard-sidebar-width`**, default **400px** in **`styles/dashboard.css`**). Below **`1100px`**, columns stack in one column as before.
- **Above `grid-main`:** **`header.header`** — title + mode subtitle (**`.header-main`**) left; compact playback (**`.header-playback`**: stream, reset, speed) upper-right.
- **`col-left`:** **Price · Volume Profile** block (section head with **`#replayRow`** timeframe + candle controls, canvas, chart pan, legend), **Delta Distribution**, **Signals & glossary**.
- **`col-right`:** **Regime Matrix** stack, then **Event Log** (scroll list + sync hint; glossary drives row filter) beneath it.

### 9.1 Timeframe Switching Contract

Timeframe changes in API mode must:

- Reload bars for all loaded sessions at the selected timeframe.
- Preserve user context by snapping cursor to the equivalent bar-time window in the new timeframe.
- Clear timeframe-specific brush selections and invalidate profile/occupancy caches.
- Auto-adjust matrix heatmap range when entering/leaving `1h` (switch to **Last 5 sessions** on enter, restore prior range on exit; if nothing was saved for exit, reset to **Last hour** to match the default pill).
- Keep replay chrome labels (mode badge/subtitle, counts/readout) synchronized with the active timeframe.

---

## 10) Profile Source of Truth

In API mode:

- Profile should come from true tick-level data via `/profile`.
- Returned structure feeds POC/VAH/VAL and histogram rendering.
- In `src/render/priceChart.js`, right-sidebar profile-bin widths are normalized by precedence: (1) 97th percentile of bin volumes whose rectangles overlap the visible chart pane in pixels, (2) max bin volume inside `[VAL, VAH]`, (3) profile `maxBin` fallback. Bar widths are clamped to sidebar width. This prevents one-bin spikes from collapsing visible histogram widths during small pans.
- In panned windows where profile source is proxy fallback, width normalization is VA-centric (`[VAL, VAH]` percentile/max) to avoid proxy-driven visible-range spikes flattening the histogram on one-key moves.
- API ISO-window parsing in `api/main.py` must interpret `Z`/offset timestamps as UTC before stripping tzinfo for DuckDB TIMESTAMP comparison. Converting to local time before stripping tzinfo is a regression: it shifts `/profile` (and other windowed endpoints) by machine offset, can return empty/null profile payloads, and forces the chart into proxy fallback while panned.
- In panned mode, when the exact `(from,to)` profile key is unresolved, chart profile selection reuses API carry-over only when compatibility/session/window guards pass; otherwise it falls back to deterministic OHLC proxy for continuity until the API window resolves.

Fallback behavior:

- If `/profile` is unavailable or unresolved, client may use the OHLC-distribution proxy in `src/analytics/profile.js`.
- Synthetic mode continues to use local proxy profile logic.

---

## 11) Hard Requirements (Do Not Regress)

1. Preserve dual-mode operation (`synthetic` and `api`) with explicit source semantics.
2. Keep warmup suppression semantics for matrix confidence and canonical fires.
3. Maintain unified singleton state model; avoid split competing stores.
4. Preserve session-aware VWAP anchoring in replay mode.
5. Keep occupancy controls wired to `/occupancy` and matrix display mode.
6. Keep brush-and-link consistency across matrix, chart, and event log.
7. Keep event log interleaving and clickable fire-row selection.
8. Keep `/profile` as primary profile source in API mode with safe fallback path.
9. Preserve multi-timeframe parity across pipeline, DB, API, and replay UI (`1m` / `5m` / `15m` / `1h`).
10. Keep timeframe isolation strict (queries and writes always scoped by `timeframe`).
11. Keep timeframe-switch UX deterministic (cursor snap, range handoff, cache/selection reset).
12. Preserve the VWAP-anchor bias contract end-to-end: `bias_state` always derived from `(v_rank, d_rank, vwap_position)` via `pipeline.bias.classify_bias`; LTF bars must carry denormalized `parent_1h_bias` / `parent_15m_bias` populated by the half-open join in `_stamp_parent_bias`.
13. Preserve the anchor-priority tag contract: 1h bias gates conviction, both-aligned ⇒ `HIGH_CONVICTION`, 1h-opposes ⇒ `SUPPRESSED` only in hard mode (else `LOW_CONVICTION`). Warmup ⇒ `null` tag/alignment.
14. Bias ribbon must remain visible above the candle pane on every timeframe and fall back gracefully (background-only strip) when bias columns are NULL.
15. The `?biasFilter=` and `?showSuppressed=` URL params are public surface for replay deep-linking — bootstrap behavior in `src/data/replay.js` must remain stable.
16. Detection thresholds in `events.js` (`sweepVolMult`, `divergenceFlowMult`) are bias-scaled by the bar's denormalized 1h parent (`biasH1`) via `_biasScale(biasH1, dir)` — the ×0.8 / ×1.0 / ×1.2 family. Null `biasH1` (synthetic / warmup / non-API) must fall back to ×1.0 so synthetic-mode behavior is preserved bit-for-bit. `absorbVolMult` and `absorbRangeMult` are intentionally not scaled (small-range absorption is a structural signal, not a momentum one).
17. `alignment` is a required first-class criterion in all four canonical evaluators (see §5.4). Bumping `total` for any watch without simultaneously updating the matching `BREAKOUT_LABELS` / `FADE_LABELS` / `ABSORPTION_WALL_LABELS` / `VALUE_EDGE_REJECT_LABELS`, `criterionKeys` arrays in `src/render/watch.js`, the `flipTicks` initializer in `src/state.js`, every `flipTicks = { ... }` reset in `src/data/replay.js` and `src/ui/controls.js`, and the modal `<li class="criterion">` rows in `src/ui/modal.js` is a regression — these surfaces are coupled by `data-key`. Absorption wall uses `total = 5` and keys `cell`, `stall`, `volume`, `level`, `alignment`. Value Edge uses `total = 5` and keys `regime`, `failedAtEdge`, `rejectionWick`, `volume`, `alignment`.
18. Fade-specific Wyckoff overrides in `buildAlignment` must never modify `score`, `vote_1h`, or `vote_15m`; only `tag` and (optionally) `reason`. Score-tinted UI assumes the raw vote sum.
19. The 1m price chart's Y-axis must not compress candles into a thin band when the profile's price extent diverges from the visible candles (e.g. a stale `_lastApiProfile` carry-over from a prior session) **and** must not visibly oscillate between two scales when the profile's POC/VAH/VAL hovers at the inclusion threshold during playback. Three layered guards in `src/render/priceChart.js` enforce this:
    1. **Carry-over compatibility** (`_isApiProfileCompatibleWith()`) rejects the API-profile carry-over when (a) its price range is disjoint from the candle range (cross-session staleness) or (b) it fails to cover the candle range within `max(candleRange × 0.5, 2 ticks)` on either side. The 50%-of-range tolerance is intentionally loose: the live edge shifts the rolling 60-bar window by a tick or two each settle, which historically blew through a tighter (5%) tolerance on every frame and caused the renderer to flap between the API profile and the OHLC proxy mid-stream. Both methods compute POC differently, so flapping shows up as a multi-point POC jump. Cross-session detection is preserved by the disjoint check (a), which doesn't depend on the tolerance.
    2. **Slack fold (Y-range fit)** with hysteresis: profile prices are folded into the candle-driven `[lo, hi]` only when within slack of the candle bounds. To prevent edge oscillation at the live edge, a Schmitt-trigger replaces the single threshold — a previously-unfolded price must come well *inside* `slackFold = candleRange × 1.5` to refold; once folded it stays folded until it moves outside `slackKeep = candleRange × 3.0`. While **panned**, the fold check is intentionally stateless (strict `slackFold` only) so slight viewport shifts cannot carry over stale fold state and compress the chart scale. Live-edge hysteresis state is keyed by profile identity (`priceLo|binStep|binCount`) and reset on profile change.
    3. **Off-range fallback**: any rejected price falls through to the existing off-range arrow indicator in `_drawRefLine` (POC/VAH/VAL pinned to top/bottom edge with a price label and ↑/↓ marker).

    Rejected carry-overs fall through to the deterministic OHLC proxy (`computeProfile(profileBars)`) which is computed fresh from the current bars and is by construction candle-aligned. Higher timeframes (`5m`, `15m`, `1h`) keep their candle-only Y-fit (`fitProfileToRange === false`).
20. **Signal repeat cooldown** must remain wired end-to-end: `eventCooldownBars` / `fireCooldownBars` in effective tunings (`getTunings()`), `filterNewEventsCooldown` on `state.events` at synthetic + replay commit, the same helper in **`precomputeAllEvents`** (synthetic checklist path), API **`/events`** rows as loaded (server-side aggregation), and `isCanonicalFireRepeatTooSoon` inside `handleWatchFire` (see §7.1).

---

## 12) Primary Files and Ownership

- Shell and static layout: `orderflow_dashboard.html`
- Styling and responsive behavior: `styles/dashboard.css`
- App bootstrapping and wiring: `src/main.js`
- Runtime state contract: `src/state.js`
- Replay and seek behavior: `src/data/replay.js`
- Timeframe controls and mode chrome wiring: `src/main.js`, `src/ui/controls.js`, `src/data/replay.js`
- PHAT feature extraction: `pipeline/src/orderflow_pipeline/phat.py`
- Matrix rendering and occupancy integration: `src/render/matrix.js`, `src/ui/matrixRange.js`, `src/data/occupancyApi.js`
- Price chart and profile integration: `src/render/priceChart.js`, `src/data/profileApi.js`
- Bias ribbon rendering: `src/render/biasRibbon.js`
- Canonical alignment / anchor-priority tagging: `src/analytics/canonical.js`, `src/sim/step.js`, `src/render/watch.js`
- Event log and interactions: `src/render/eventLog.js`, `src/ui/selection.js`
- Full-load signal inventory (histogram): `src/render/eventInventory.js`
- Tooltip routing (events, fires, bias hovers): `src/ui/tooltip.js`
- Backend API: `api/main.py`
- Pipeline/ranking logic: `pipeline/src/orderflow_pipeline/*`
- Bias engine (VWAP-anchor classifier): `pipeline/src/orderflow_pipeline/bias.py`
- Session VWAP stamping: `pipeline/src/orderflow_pipeline/aggregate.py`
- Cross-timeframe denormalization: `pipeline/src/orderflow_pipeline/cli.py` (`_stamp_parent_bias`)

---

## 13) Directional Bias & Cross-Timeframe Filtering (Phase 6)

### 13.1 Bias Engine (VWAP-Anchor Model)

`pipeline/src/orderflow_pipeline/bias.py` defines a 7-level bias alphabet computed per bar from `(v_rank, d_rank, vwap_position)`:

- `BULLISH_STRONG`, `BULLISH_MILD`, `ACCUMULATION`, `NEUTRAL`, `DISTRIBUTION`, `BEARISH_MILD`, `BEARISH_STRONG`.

`vwap_position(close, vwap, band_ticks) → {-1, 0, +1}` returns the sign of `close - vwap` outside a configurable tolerance band, `0` when inside the band or when inputs are NULL/NaN. `VWAP_BAND_TICKS_BY_TF = {1m: 4, 5m: 6, 15m: 8, 1h: 16}` is the canonical configuration.

`classify_bias` rule precedence:

1. Warmup (any rank NULL) → `NEUTRAL`.
2. Inside band (`vwap_pos === 0`) → `NEUTRAL`, with `(5,5)` upgraded to `ACCUMULATION` (Wyckoff bolder-read).
3. Wyckoff anomalies above band: `(5,5)` → `BULLISH_STRONG`; `(5,1)` → `DISTRIBUTION`.
4. Wyckoff anomalies below band: `(5,5)` → `ACCUMULATION`; `(4,1)` / `(5,1)` → `BEARISH_STRONG`.
5. Strong tier: `(4,4)` above band → `BULLISH_STRONG`; `(4,1)` below band → `BEARISH_STRONG`.
6. Depth-leads-location: `vwap_pos > 0` and `d_rank ≤ 2` → `DISTRIBUTION`; symmetric below.
7. Mild default: sign by `vwap_pos`, intensity `MILD`.

Coverage requirement: every cell of the `5 × 5 × 3` matrix maps to one of the 7 levels (validated by `pipeline/tests/test_bias.py`).

### 13.2 Schema Additions (`bars`)

| column | type | meaning |
| --- | --- | --- |
| `vwap` | `DOUBLE` | session-anchored running VWAP using typical price `(h+l+c)/3` |
| `bias_state` | `VARCHAR` | output of `classify_bias` for this bar |
| `parent_1h_bias` | `VARCHAR` | `bias_state` of the containing 1h bar (1m / 5m / 15m rows) |
| `parent_15m_bias` | `VARCHAR` | `bias_state` of the containing 15m bar (1m / 5m rows) |

Index: `idx_bars_tf_bartime(timeframe, bar_time)` to support the half-open denormalization join. Migrations are additive (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`) so Phase 5 DBs can be upgraded in place; until a fresh `aggregate` runs from raw `.dbn.zst`, existing rows have NULL bias columns and renderers must fall back gracefully.

### 13.3 Denormalization Join

LTF rows pick up parent biases via the half-open interval predicate:

```
LTF.bar_time >= HTF.bar_time
AND LTF.bar_time < HTF.bar_time + INTERVAL <htf width>
```

Aggregation order is `1h → 15m → 5m → 1m`; `_stamp_parent_bias(con, session_date, ltf)` runs after each LTF write so the parent rows are guaranteed to exist.

### 13.4 Alignment Score & Anchor-Priority Tag

`src/analytics/canonical.js`:

- `BIAS_VOTE` maps each of the 7 bias levels to a directional vote `{-2, -1, 0, +1, +2}`.
- `vote(biasState, dir1m)` returns `+v` when the bias agrees with `dir1m`, `-v` when it opposes, `0` for neutral.
- `buildAlignment(lastBar, dir1m, watchKind = 'breakout')` returns `{score, vote_1h, vote_15m, tag, biasH1, bias15m}` (and optionally `reason` when fade overrides apply) where `score = vote_1h + vote_15m ∈ [-4, +4]`. `watchKind === 'fade'` enables the Wyckoff overlay documented in §5.5. `watchKind === 'absorption'` uses the same **base** tag path as `breakout` (no extra overlay; distinct name so `dir1m` semantics stay documented — impulse for absorption wall, see §5.1).

Tag rule (anchor-priority — the 1h vote dominates):

| 1h | 15m | tag |
| --- | --- | --- |
| opposes | any | `SUPPRESSED` (hard) / `LOW_CONVICTION` (soft, off) |
| agrees | opposes | `LOW_CONVICTION` |
| neutral | any | `STANDARD` |
| agrees | neutral | `STANDARD` |
| agrees | agrees | `HIGH_CONVICTION` |

### 13.5 Bias Filter Modes

- `state.biasFilterMode === 'soft'` (default): no fires are dropped by the tag rule; tags are surfaced as visual hints in the watch panel and event log. The **alignment** gate in §5.4 still blocks `fired === true` when 1h votes fail the per-watch rule (e.g. breakout `vote_1h < 0`; absorption wall `vote_1h < -1`) even in soft mode.
- `state.biasFilterMode === 'hard'`: 1h-opposes fires are tagged `SUPPRESSED`; banner + auto-pause are skipped, but the fire is still recorded so it can be reviewed.
- `state.biasFilterMode === 'off'`: alignment is still computed for diagnostic purposes but tags never escalate beyond `STANDARD`. The `alignment` gating check is also force-passed (`vote_1h = 0` ⇒ `vote_1h >= 0`), so `'off'` truly disables HTF filtering at every layer.
- `state.showSuppressed === true` reveals SUPPRESSED rows in the event log; default is hidden.

### 13.6 Verification Rules

- A 1m fire with `bar_time < 10:30 ET` may legitimately have `tag === null` (1m regime warmup not yet complete). At or after 10:30 ET a null tag indicates a denormalization bug and should be investigated against `_stamp_parent_bias` join coverage.
- Fire-count protocol for documenting filter impact lives in `notes.txt` (Phase 6 section).

### 13.7 Bias-Adaptive Detection Multipliers

`src/analytics/events.js` exports `_biasScale(biasH1, dir)`, which scales `sweepVolMult` and `divergenceFlowMult` by the bar's 1h parent bias. The shape captures "easier to confirm trend continuation, harder to confirm against-trend":

| `biasH1` | `dir = 'up'` | `dir = 'down'` |
| --- | --- | --- |
| `BULLISH_STRONG` | 0.8 | 1.2 |
| `BULLISH_MILD`   | 0.9 | 1.1 |
| `ACCUMULATION` / `NEUTRAL` / `DISTRIBUTION` / `null` | 1.0 | 1.0 |
| `BEARISH_MILD`   | 1.1 | 0.9 |
| `BEARISH_STRONG` | 1.2 | 0.8 |

Application:

- **Sweeps**: the up-extreme branch uses `_biasScale(biasH1, 'up')`; the down-extreme branch uses `_biasScale(biasH1, 'down')`. A bullish trend lowers the bar for up-sweeps and raises it for down-sweeps (and symmetric).
- **Divergences**: convention is to type the event by the *price extreme* direction, but the *signal* points against it. So the up-extreme divergence branch (price up, delta down — failed rally) is scaled by `_biasScale(biasH1, 'down')` because it confirms markdown continuation; the down-extreme branch is scaled by `_biasScale(biasH1, 'up')`.
- **Absorption** (`absorbVolMult`, `absorbRangeMult`) is **not** scaled. Absorption is a structural signal about depth-vs-flow asymmetry rather than a directional momentum signal, and the existing 1.75× threshold was tuned against the watched cell's small-wick state.
- `ACCUMULATION` and `DISTRIBUTION` are intentionally neutral at the threshold layer (they're depth-leads-Location *anomalies*, not directional trends). The fade Wyckoff overrides in §5.5 pick them up at the tag layer instead.

### 13.8 Phase 2 — Weighted Conviction Score (deferred)

The current model is binary: `fired = passing === total` (5 for breakout, 6 for fade). A future migration will replace this with a normalized `convictionScore ∈ [0, 1]` weighted 30 / 30 / 40 across core technicals / regime cell match / HTF alignment respectively, firing at `convictionScore >= 0.70` (threshold to be calibrated). `SUPPRESSED` would still hard-veto regardless of score. This phase is documented but not yet implemented; the binary gate above is the current contract.

---

## 14) Backtesting MVP (Existing Fires)

Technical deep dive (engine flow, regime ON vs OFF fire sources, broker vs strategy config for operators): [`docs/backtest-engine.md`](docs/backtest-engine.md).

### 14.1 Scope

- **Strategy defaults JSON:** Optional overrides live in [`config/strategy_defaults.json`](config/strategy_defaults.json). Full resolution order, allowed `watch_id` values, reload semantics, and **profiles** (`config/profiles/*.json` selected via `ORDERFLOW_STRATEGY_CONFIG`) are documented in [`docs/strategy-config.md`](docs/strategy-config.md). Values merge on top of code defaults in [`pipeline/src/orderflow_pipeline/strategies/config.py`](pipeline/src/orderflow_pipeline/strategies/config.py) per timeframe (`cooldown_bars`, `min_bars`, `lookback_bars`, `warmup_start`, `stop_loss_ticks`, `take_profit_ticks`, `watch_exit_ticks`). Missing JSON keys keep code defaults. Set **`ORDERFLOW_STRATEGY_CONFIG`** to an absolute or cwd-relative path to use a different file. Loader: [`pipeline/src/orderflow_pipeline/strategy_json.py`](pipeline/src/orderflow_pipeline/strategy_json.py); tests should call `clear_strategy_config_cache()` after swapping files or env. Validate locally with `python scripts/validate_strategy_config.py`. JSON Schema for editors: [`config/strategy_defaults.schema.json`](config/strategy_defaults.schema.json) (authoritative checks are [`validate_strategy_document`](pipeline/src/orderflow_pipeline/strategy_json.py) + tests). If `version` exceeds the loader’s supported version, a **warning** is emitted and unknown future keys may be ignored.
- **Broker defaults JSON:** Simulated broker economics for `POST /api/backtest/run` live in [`config/backtest_defaults.json`](config/backtest_defaults.json) (override path: **`ORDERFLOW_BACKTEST_CONFIG`**). The server merges this file onto [`BrokerConfig`](pipeline/src/orderflow_pipeline/backtest_engine.py) code defaults, then merges optional `POST` body fields on top (omitted body keys keep the JSON merge). The same JSON document may also supply **execution-policy** booleans at the top level (same merge surface; see §14.6). Documented in [`docs/backtest-config.md`](docs/backtest-config.md). Loader: [`pipeline/src/orderflow_pipeline/backtest_defaults.py`](pipeline/src/orderflow_pipeline/backtest_defaults.py) — the JSON is read from disk on each `GET /api/backtest/defaults` / merge (no in-process LRU keyed only by mtime, so rapid saves do not leave `slippage_ticks` etc. stale while other keys look fresh). **`clear_backtest_defaults_cache()`** remains a harmless no-op for tests. Validate locally with `python scripts/validate_backtest_defaults.py`. **`GET /api/backtest/defaults`** returns **`{ broker, execution, resolvedPath }`** with **`Cache-Control: no-store`** for dashboards.
- The MVP backtester reuses persisted `fires` as strategy triggers (no new signal model).
- Backtest execution is DB-fire only in production mode; if scoped `fires` are absent in-window, the run fails fast with a clear error.
- Recovery path: `python -m orderflow_pipeline.cli recompute-fires --db-path <duckdb> --timeframe <tf>` regenerates canonical `fires` from persisted `bars` for the selected window/timeframe without requiring a raw-data rebuild.
- Compare-mode exception: the **Regime filter OFF** branch derives signals from the same bar window using the extracted legacy strategy with regime gates disabled (`signalSource=derived_no_regime`) so ON vs OFF remains a true A/B test.
- Execution is single-position and deterministic: one open position max; optional **`ExecutionPolicy`** (§14.6) can disable flip, intrabar mechanical exits, or end flatten independently — defaults preserve legacy behavior (flip + barriers when configured + end flatten). **Typical exits:** opposite-direction signal (**flip**), optional **stop-loss** / **take-profit** barriers evaluated intrabar using OHLC (`stop_loss` / `take_profit` exit reasons), or **end-of-window** flatten if still open and **`close_at_end_of_window`** is true.
- When SL/TP tick distances are unset everywhere (**broker config null** and strategy timeframe/watch defaults null), behavior reduces to flip-only plus end flatten — backward-compatible with historical flip-only runs.
- SL/TP resolution: optional **`BrokerConfig.stop_loss_ticks` / `take_profit_ticks`** act as **run-wide overrides** when either is non-null; otherwise each new position inherits **`LegacyFallbackConfig`** timeframe defaults merged with optional **`watch_exit_ticks`** per canonical watch (`pipeline/src/orderflow_pipeline/strategies/config.py`, resolver `strategies/exit_ticks.py`).
- **SL/TP tick convention (not signed tickets):** distances are **≥ 0** ticks from the fill — adverse magnitude for stop, favorable for target (long: stop below fill, TP above). They are **not** Webull-style **signed** bracket inputs (e.g. `-25` under entry for a long). **`POST`** rejects negative tick fields (**HTTP 400**); the dashboard blocks negatives before POST and omits invalid fields so users are not silently shifted into “TP-only” runs. When the broker override path is active with **only one** side set (e.g. only **`take_profit_ticks`**), the other side is **`null`** → **no mechanical barrier** on that side for the run.
- Intrabar ambiguity (same bar touches both SL and TP): **stop-loss is assumed first** (risk-first). After fires fill or flip on a bar, SL/TP is evaluated again so new positions can still be stopped out within the same bar if price breaches.
- **`scripts/value_edge_parity_check.py`** compares Sharpe + equity **exactly** to a baseline run — expected to fail once SL/TP changes outcomes vs an old flip-only baseline; use separate baseline run IDs or flip-only configs when parity checking signals alone.
- Fire mapping:
  - `breakout`: trade with fire direction.
  - `fade`, `valueEdgeReject`, `absorptionWall`: trade opposite fire direction (mean-reversion read).

### 14.2 DuckDB Contracts

- `backtest_runs` stores one summary row per run (`run_id`, params, aggregate metrics, net P&L).
- Rows representing **null-hypothesis** companion runs include **`metadata_json.is_null_hypothesis: true`** (see companion **`signal_source`** in [`docs/backtest-engine.md`](docs/backtest-engine.md)).
- `backtest_trades` stores closed-trade records (`entry_time`, `exit_time`, direction, prices, gross/net P&L, bars held, optional `exit_reason`, source watch).
- `backtest_equity` stores the mark-to-market equity series by bar timestamp.
- `backtest_benchmarks` stores per-run benchmark curves keyed by `(run_id, strategy, bar_time)`; MVP strategy is `buy_hold`.
- Writes are transactional and keyed by `run_id`; re-writing an existing `run_id` replaces that run's rows in all backtest tables.

### 14.3 Broker / Accounting

- `SimulatedBroker` applies adverse slippage per side (`slippage_ticks * tick_size`) and per-side commission.
- SL/TP exits fill at the barrier price with exit-side slip applied via `_fill_price`. Flip exits continue to use the fire’s quoted price (fallback bar close).
- P&L uses futures point value (`point_value`) and quantity (`qty`):
  - `gross_pnl = (exit - entry) * side * point_value * qty`
  - `net_pnl = gross_pnl - entry_commission - exit_commission`
- Equity is mark-to-market per bar: `equity = cash + unrealized_pnl`.

### 14.4 API and UI Contracts

- `GET /api/backtest/defaults` returns **`{ broker, execution, resolvedPath }`** — merged broker economics and execution-policy fields (booleans plus optional **`entry_gap_guard_max_ticks`**) from [`config/backtest_defaults.json`](config/backtest_defaults.json) (or **`ORDERFLOW_BACKTEST_CONFIG`**) plus code fallbacks, **before** any `POST` overrides.
- `POST /api/backtest/run` runs synchronously for a requested timeframe/window and returns run summary (`runId`, `tradeCount`, `winRate`, `sharpe`, `maxDrawdown`, `netPnl`, `endingEquity`, plus **`entryMode`** (`signal_bar_close` | `next_bar_open`) and **`entryGapGuardMaxTicks`** (`number` | `null`) echoing the merged execution policy). After merging defaults + body into **`BrokerConfig`** and **`ExecutionPolicy`**, the server runs **`ExecutionPolicy.validate()`**; invalid combinations yield **HTTP 400** with a clear message (see §14.6 deadlock rule). The dashboard mirrors the deadlock rule client-side before POST and shows **`entry:`** / optional **`gap≤`** in the Performance status line after a run.
- `POST /api/backtest/run` broker fields (`initial_capital`, `qty`, `slippage_ticks`, `commission_per_side`, `tick_size`, `point_value`, `stop_loss_ticks`, `take_profit_ticks`) are **optional**: omitted keys use the broker defaults JSON merge; present keys override individually (explicit JSON `null` on the tick fields clears a file-provided value for that field).
- `POST /api/backtest/run` execution-policy fields (`ignore_same_side_fire_when_open`, `flip_on_opposite_fire`, `exit_on_stop_loss`, `exit_on_take_profit`, `close_at_end_of_window`, **`entry_next_bar_open`**, **`entry_gap_guard_max_ticks`**) are **optional**: omitted keys keep the merged execution defaults from JSON + code; present keys override individually. **`ignore_same_side_fire_when_open=false`** is rejected (**HTTP 400**) until multi-leg sizing exists. When **`entry_next_bar_open`** is **true**, new entries (including the open leg after a flip) fill at the **next bar’s open**; optional **`entry_gap_guard_max_ticks`** skips a deferred entry when the absolute gap between the next open and the signal bar close exceeds that many ticks × **`tick_size`** (see §14.6). Persisted run **`metadata_json`** includes top-level **`entry_mode`** (`signal_bar_close` | `next_bar_open`) and **`entry_gap_guard_max_ticks`** for post-hoc comparison alongside the serialized **`execution_policy`** object.
- `POST /api/backtest/run` accepts optional `watch_ids` to scope execution to specific canonical watches (`breakout`, `fade`, `absorptionWall`, `valueEdgeReject`).
- Optional **`null_hypothesis`** / **`null_hypothesis_seed`** on `POST /api/backtest/run`: when **`null_hypothesis`** is **true**, the server requires **`use_regime_filter=true`**, exactly **one** watch in **`watch_ids`**, runs the usual baseline persist first, then builds a deterministic random-fire schedule on regime-aligned eligible bars (mirroring legacy warmup/volume gating for that scope). When the baseline uses **`entry_next_bar_open`**, eligible signal indices exclude bars without a legal next bar for deferred entry (at minimum the **last** bar of the window) and honor the same optional gap guard as **`BacktestEngine._simulate`**, adjusts until **`len(closed_trades)`** matches baseline **`tradeCount`**, and persists a **second** run. **`null_hypothesis_seed`** is optional — omitted seeds derive deterministically from the baseline **`runId`** digest so reruns reproduce without passing the seed. The HTTP JSON response stays **backward-compatible**: existing top-level fields summarize **baseline**; **`nullHypothesis`** carries the companion summary (**`runId`**, metrics, **`nullHypothesisSeed`**, **`skipped`** when baseline trade count is zero). Second-run **`metadata_json`** includes **`is_null_hypothesis: true`** (canonical filter for excluding NH rows from strategy analytics), plus audit fields including **`max_schedulable_fires`**, **`parity_variants_per_k`**, **`parity_placement_styles`** (number of greedy placement modes rotated across variants). Failure modes (**HTTP 400**): **`insufficient_eligible_bars`** when **`len(eligible_indices) < baseline_trade_count`** or when **`baseline_trade_count`** exceeds **`max_schedulable_fires`** under **`cooldown_bars`** packing on eligible indices, **`parity_unreachable`** when parity cannot be reached after scanning scheduled-fire counts **N…max_schedulable_fires** with **`parity_variants_per_k`** hash-seeded variants per **k** (default **48**, override **`ORDERFLOW_NH_PARITY_VARIANTS_PER_K`** clamped **1…4096** in [`null_hypothesis.py`](pipeline/src/orderflow_pipeline/null_hypothesis.py); compute scales roughly with variants × (**max_schedulable_fires** − **N** + 1) × **`BacktestEngine._simulate`** calls — stubborn cases may need a higher env value, a narrower **`from`/`to`**, **`flip_on_opposite_fire=true`**, or an explicit **`null_hypothesis_seed`**); **`null_hypothesis`** validation errors when regime/compare scope rules are violated.
- `GET /api/backtest/stats`, `/api/backtest/equity`, `/api/backtest/trades`, `/api/backtest/skipped-fires` return latest run by default, or a specific run via `runId`.
- `GET /api/backtest/trades` trade objects include **`exitReason`** (`flip`, `stop_loss`, `take_profit`, `end_of_window`, or null for legacy rows).
- `GET /api/backtest/equity` includes strategy equity points plus a benchmark payload (`benchmark.strategy='buy_hold'`, `benchmark.points`).
- Dashboard `Performance` panel includes:
  - Explicit **Backtest scope** dropdown (run scope is user-selected, not inferred from glossary checkbox visibility or URL display params). The dropdown defaults to an unset placeholder; **Run Backtest** stays disabled until the user chooses a scope (including **All canonical watches** when explicitly selected). While a run is in flight, **Run Backtest** stays disabled and is styled as inactive (not the primary accent fill).
  - **Backtest timeframe** dropdown in the Performance inputs column: lists timeframes that exist in DuckDB (subset of **1m / 5m / 15m / 1h**). It mirrors **`state.activeTimeframe`** and **`POST /api/backtest/run`** `timeframe`; changing it in **API / real** mode triggers the same bar reload path as the top-chart timeframe pills (**`setActiveTimeframe`**). In synthetic mode it updates the active timeframe for the POST without reloading multi-TF history.
  - Optional **two-variant comparison:** checkbox **Compare regime filter OFF (second run)** (default off). When unchecked, only **Regime filter ON** runs (single API call); orange equity curve, OFF legend, OFF trade markers, and OFF skipped-fire summary are omitted. When checked, each click runs ON and OFF in parallel as before:
    - **Regime filter ON** (teal): current strategy behavior.
    - **Regime filter OFF** (orange): same entry/exit logic with regime gating removed.
  - Optional **Show buy & hold benchmark**: hides/show the pink benchmark overlay on the equity chart client-side only (benchmark points are omitted from Y-axis scaling when hidden).
  - Optional **Null hypothesis (frequency-matched random)** (green label): when **exactly one watch** is selected in Backtest scope, the dashboard attaches **`null_hypothesis`** to the **Regime filter ON** POST only (compare OFF runs do **not** request NH). Checkbox state persists in **`runParams`**; the control is disabled for **All canonical watches** / unset scope. While NH is requested, the Performance status line explains that parity search can take **many minutes** on wide windows (single synchronous **`POST /api/backtest/run`** — no progress meter). Legend visibility uses **`hidden`** on the NH legend row with CSS so **`display: inline-flex`** on legend items cannot leave the green dot visible when no NH payload exists; if NH is checked but **`POST /api/backtest/run`** returns no **`nullHypothesis`** object (e.g. stale API process), the browser console warns.
  - Metrics cards render both variant values only when a paired OFF run exists; otherwise a single teal column. When a **Null hypothesis** companion run is present (`nullHypothesis.runId` in the POST response and hydrated client-side), each metric card shows a **second row** in **green** (`#2ecc71`) under the baseline row with NH **scope**, **run id** (8-char), **trade count**, **win rate**, **Sharpe**, **max drawdown**, **net P&L**, and **equity point count** so NH sits beside regime ON (and OFF) like the orange/teal split but vertically stacked. The equity chart overlays the OFF curve only when paired; the buy-and-hold benchmark is pink when **Show buy & hold benchmark** is on; **Null hypothesis** equity (when returned) is drawn green.
  - Price chart overlays backtest executions for the visible window:
    - entry marker = triangle
    - exit marker = X
    - entry/exit markers include explicit `E` / `X` text labels
    - markers are offset from candle bodies with a dark halo for visual separation
    - teal markers = regime-filter ON run
    - orange markers = regime-filter OFF run (only when Compare OFF is enabled and that run exists)
    - marker visibility: `Show Regime ON markers` always available; `Show Regime OFF markers` is shown only when Compare OFF is enabled.
  - Backtest status line includes skipped-fire summary for ON always; adds OFF summary only when paired OFF run exists; appends **Null hypothesis** skipped summary or **`NH skipped (reason)`** when that companion path ran.
  - Inputs: capital, commission-per-side (USD per contract per fill side), qty, slippage ticks, optional **stop loss (ticks)** and **take profit (ticks)** for run-wide mechanical exits; plus **execution policy** checkboxes (flip on opposite fire, honor SL intrabar, honor TP intrabar, flatten at end of window, **entry next bar open (integrity)**), optional **gap guard (ticks)** when next-bar mode is on (blank omits the key). Same-side stacking remains unsupported — UI copy explains skips when already long/short on that side; **`ignore_same_side_fire_when_open=false`** is rejected by server validation until pyramiding exists. Blank SL/TP inputs omit those keys from `POST /api/backtest/run` so the server keeps the merged broker defaults (`config/backtest_defaults.json` plus code fallbacks); numeric values override per key (same semantics as other optional broker fields). Execution-policy keys follow the same pattern: omitted keys keep merged defaults; present booleans override. On load, the client fills broker and execution fields from **`GET /api/backtest/defaults`** once the resolved **`apiBase`** is known (see §2.2 origin probe). When **`resolvedPath`** is empty or ends with **`config/backtest_defaults.json`** (standard repo file), **`GET /api/backtest/defaults`** is followed by **`GET /config/backtest_defaults.json`** (same origin, `cache: no-store`), and **`{ ...apiBroker, ...repoBroker }`** plus **`{ ...apiExecution, ...repoExecution }`** are applied — so sliders and execution toggles match the checked-in JSON even if the FastAPI process uses another cwd/env copy or an older read. When **`ORDERFLOW_BACKTEST_CONFIG`** resolves to a **different** filename, that overlay is skipped (server broker and execution are shown). When the GET fails, the client falls back to repo JSON only. With **`?source=api`**, repo JSON is also applied **optimistically** at boot (before `/sessions`). **`tick_size`** / **`point_value`** in **`POST`** use the final merged broker blob (or DOM where applicable).
  - Includes a **Pop Out** action that opens the dashboard in a dedicated `?view=backtest` window. In this mode, non-backtest panels are hidden and the equity chart is rendered taller for detail review, while the Performance controls/behavior remain the same as in the full dashboard.
  - Popout layout uses a denser top row: numeric broker inputs on the **left**, checkbox options (execution policy, compare regime OFF, marker toggles) in a **center** panel, and metric summary cards on the **right** in a **two-column** grid (chart below). The `Open Full Dashboard` control is hidden in popout mode to preserve space.
  - Run action button.
  - Metric cards (Sharpe, max drawdown, win rate, net P&L, trade count).
  - Equity curve canvas rendered from `/api/backtest/equity`.

### 14.5 Skipped Fire Diagnostics

- `skipped_fires` stores one row per non-executed fire candidate keyed by `(run_id, bar_time, watch_id, direction, reason_code)`.
- Required fields: `reason_code`; optional diagnostics include `price`, `position_side_before`, `position_size_before`, `reason_detail_json`.
- `backtest_runs.metadata_json` includes a `skipped_fires` reason-count summary for fast run-level diagnostics.
- When **`flip_on_opposite_fire`** is false and an opposing fire would have flipped the position, the engine logs a skip with reason **`flip_disabled`** (same persistence path as other skips).

### 14.6 Execution policy (`ExecutionPolicy`)

Run-level booleans control how persisted fires are executed around the single-position broker. Defaults match historical behavior (all “on” except same-side ignore). Keys use snake_case on **`POST`** and in [`config/backtest_defaults.json`](config/backtest_defaults.json) (flat merge alongside broker fields):

| Key | Default | Behavior |
|-----|---------|----------|
| `ignore_same_side_fire_when_open` | `true` | Same-direction fire while already on that side → skip (`already_in_position_same_side`). **`false`** is invalid until pyramiding exists. |
| `flip_on_opposite_fire` | `true` | Opposing fire closes then opens the new side (`flip`). When false, opposing fires are skipped with **`flip_disabled`**. |
| `exit_on_stop_loss` | `true` | Honor stop barrier intrabar when a stop price is set on the position. When false, intrabar evaluation **ignores** the stop but **`stop_price`** remains stored for diagnostics. |
| `exit_on_take_profit` | `true` | Same for take-profit barrier vs **`take_profit_price`**. |
| `close_at_end_of_window` | `true` | Flatten remaining position at last bar with **`end_of_window`**. When false, no forced close at window end (must remain valid per deadlock rule below). |
| `entry_next_bar_open` | `false` | When **true**, schedule **new** entries at the **next bar’s open** (signal bar unchanged); the **close** leg of a flip still executes on the signal bar. When **false**, entries use historical same-bar semantics (fire price / bar close). |
| `entry_gap_guard_max_ticks` | `null` | When **`entry_next_bar_open`** is on, optional max gap in **ticks**: if **abs(next_open − signal_close) > entry_gap_guard_max_ticks × tick_size**, the deferred entry is skipped (**`gap_guard_blocked`**). **`null`** or non-positive effective guard disables the check. |

**Deadlock validation (policy-only):** reject configs where **`flip_on_opposite_fire`** is false **and** both **`exit_on_stop_loss`** and **`exit_on_take_profit`** are false **and** **`close_at_end_of_window`** is false — there would be no policy-level exit path. Run-level validation cannot guarantee every trade has barriers; “mechanical allowed” means flags permit honoring barriers **when present**.

**Double intrabar calls:** the engine invokes **`SimulatedBroker.try_intrabar_exit`** twice per bar (before and after processing fires). Mechanical honoring is gated **inside** the broker using the stored **`ExecutionPolicy`** so both calls stay consistent without duplicating conditionals.

**Metadata:** `backtest_runs.metadata_json` includes a serialized **`execution_policy`** object for reproducibility, plus top-level **`entry_mode`** (`signal_bar_close` | `next_bar_open`) and **`entry_gap_guard_max_ticks`** (number or `null`) so runs are comparable without ambiguity.

## 15. API-First SSoT Diagnostics Contract

- In API/real mode, canonical fire emission is backend-owned. Frontend JS evaluators may still run for display fallback but must not emit or mutate API-mode fire streams.
- Pipeline fire generation and backtest compare derivation both use the same Python strategy function (`derive_fires_from_bars`) with timeframe-specific config via `config_for_timeframe`. Implementation splits each watch strategy into its own module under `pipeline/src/orderflow_pipeline/strategies/` (`breakout.py`, `fade.py`, `absorption_wall.py`, `value_edge_reject.py`, plus shared `config.py`), composed by `legacy_fallback_logic.py`.
- Pipeline fire writes include additive diagnostics fields on `fires`: `diagnostic_version` and `diagnostics_json` (JSON payload, current version `v1`).
- `GET /fires` remains backward compatible by default. Diagnostics are opt-in with `includeDiagnostics=1`; default response shape is unchanged.
- API-mode UI diagnostics consume backend diagnostics when present. Fallback to JS evaluators is allowed only when diagnostics fields are missing from the response; present-but-null is treated as backend-owned state.
- Unknown diagnostics versions in API responses must log a console warning and use display-only fallback behavior.
- Aggregation/recompute must generate canonical fires for all supported timeframes (`1m`, `5m`, `15m`, `1h`) when bars exist, and backtest smoke checks must succeed at those timeframes.
- Synthetic mode is explicitly legacy and non-authoritative for API/backtest SSoT guarantees in this phase.
