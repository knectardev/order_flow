# Order Flow Dashboard — Requirements (Current)

> **Scope:** This document reflects the current implemented system (modular frontend + optional API/pipeline stack), replacing the older single-file-only prototype framing.

---

## 1) Product Overview

The dashboard is a market microstructure visualization and hypothesis tool with two operating modes:

- **Synthetic mode:** local simulation, no backend required.
- **API replay mode (`?source=api`):** real ES session playback backed by FastAPI + DuckDB with multi-timeframe support (`1m`, `15m`, `1h`).

Design intent remains unchanged:

1. Probabilistic regime framing (posterior distribution, not single hard labels).
2. Event-typed sparse markers rather than per-bar verdicts.
3. Contrasting canonical hypotheses (`★ Breakout`, `◆ Fade`, `🛡 Absorption Wall`) with explicit failure twins on the first two.
4. Order-flow context from profile + VWAP + event structure.
5. Optional PHAT candle rendering mode (asymmetric body shading + liquidity-tip wick markers) in API replay.

---

## 2) Architecture

### 2.1 Frontend

- Entry shell: `orderflow_dashboard.html`.
- Styling: `styles/dashboard.css`.
- Runtime: ES modules under `src/` (no bundler required).
- Core state model: single mutable singleton in `src/state.js`.

### 2.2 Data Pipeline and API

- Pipeline: `pipeline/src/orderflow_pipeline/*` computes bars, events, fires, regime ranks (`v_rank`, `d_rank`), session VWAP, directional bias states, and DB writes.
  - Aggregation contract supports `1m` / `15m` / `1h` bins.
  - DuckDB schema keys rows by `(bar_time, timeframe)` and keeps per-timeframe isolation for bars/events/fires/profile rows.
  - `bars` rows additionally carry `vwap`, PHAT features (`top_cvd`, `bottom_cvd`, `top_body_volume_ratio`, `bottom_body_volume_ratio`, `upper_wick_liquidity`, `lower_wick_liquidity`, `high_before_low`), and bias columns (`bias_state`, `parent_1h_bias`, `parent_15m_bias`).
  - Aggregation order is `1h → 15m → 1m` so lower timeframes can denormalize parent biases via a half-open interval join in `_stamp_parent_bias`.
- API: `api/main.py` exposes market-data read endpoints plus a backtest run endpoint:
  - `/timeframes`
  - `/sessions`
  - `/date-range` (MIN/MAX `bar_time` in `bars` for a `timeframe` — timeline bounds)
  - `/bars`
  - `/events` (optional `types=sweep,divergence,absorption,stoprun` comma list filters `events.event_type`)
  - `/fires`
  - `/profile`
  - `/occupancy`
  - `POST /api/backtest/run`
  - `GET /api/backtest/stats`
  - `GET /api/backtest/equity`
  - `GET /api/backtest/trades`
  - `GET /api/backtest/skipped-fires`
- API endpoints that return market rows are timeframe-aware (`timeframe` query parameter, default `1m`), and must not mix contexts across timeframes.
- `/bars`, `/events`, `/fires` payloads include `vwap`, PHAT fields (`topCvd`, `bottomCvd`, `topBodyVolumeRatio`, `bottomBodyVolumeRatio`, `upperWickLiquidity`, `lowerWickLiquidity`, `highBeforeLow`), and bias fields (`biasState`, `biasH1`, `bias15m`) projected from persisted columns via `_attach_htf_bias`.
- Storage: DuckDB (`data/orderflow.duckdb` by default).

### 2.3 Mode Loading

- App bootstraps synthetic first, then attempts replay bootstrap.
- Real mode is explicitly selected via query string (`?source=api`).
- Synthetic remains supported and is the fallback when API replay is unavailable.

In **API replay**, after the windowed **`/bars`** load completes, **`seek(allBars.length)`** runs so **`replay.cursor`** sits at the **end of the loaded timeline**. The chart shows the **most recent** **`MAX_BARS`** (subject to **`chartPanSlider`** / **`chartViewEnd`**) with default timeframe **`1m`** — not bar 0 at session start unless the user pans there.

### 2.4 Collapsible dashboard sections

- Every main-grid **`section`** under **`grid-main`** is collapsible **except** **`#mainChartSection`** (price · volume profile · events — the primary chart stays fully visible with no collapse control).
- Sections **`delta`**, **`glossary`**, **`performance`**, **`matrix`**, and **`eventLog`** default to **expanded**. Each header uses a fixed-width **collapse control on the right** (`src/ui/sectionCollapse.js`) so **section titles stay left-aligned** consistently; **`section-meta`** (counts, toggles, status) sits between title and collapse.
- Expanded/collapsed preference is persisted in the browser via **`localStorage`** key **`orderflow_dashboard_section_collapsed`** (JSON map of section keys to boolean **`true`** when collapsed).

---

## 3) State Model (Single Source of Truth)

All mutable runtime state is centralized in `src/state.js`:

- **Stream data:** `bars`, `formingBar`, `events`, `canonicalFires`, `trail`, `matrixScores`.
- **Watch state:** `breakoutWatch`, `fadeWatch`, `absorptionWallWatch`, `valueEdgeRejectWatch` with persistent `lastCanonical`, edge-trigger flags, and flip tracking.
- **Replay state:** `replay.mode`, **`replay.dateRange`** `{ min, max, minMs, maxMs }` (from **`GET /date-range`** or stubbed from first/last loaded bar after a windowed **`/bars?from&to`** load), session metadata (**internal**: VWAP resets, warmup, cooldown boundaries — **no session dropdown**), full loaded **`replay.allBars`**, **`replay.allEvents`**, **`replay.allFires`**, cursor, data-source flags (`apiBase`, etc.), and **`replay.pendingSeekPromise` / `replay.pendingSeekAbort`** (in-flight **`seekAsync`** coordination — a new **`_loadAllSessionsFromApi`** **`await`s** the prior promise before replacing bars; synchronous **`seek()`** aborts an in-flight **`seekAsync`**).
- **Glossary primitive selection:** **`state.activeEventTypes`** (`Set` of glossary keys such as **`sweep up`**, **`absorption`**). Default **empty** — no upfront full-timeline primitive scan/fetch for API replay; **`loadEventsForActiveTypes()`** runs **`GET /events?types=&from&to`** when keys are checked, or **`precomputeAllEvents()`** in synthetic mode when keys are checked. In **API replay**, **`drawPriceChart()`** filters **`viewedEvents`** to keys in this set **before** drawing primitive glyphs (`▲▼◉⚡⚠`) so live **`detectEvents`** output in **`state.events`** does not bypass the checklist. Synthetic mode draws all **`state.events`** from the simulator (no checklist filter on glyphs).
- **Canonical fire halo selection (API replay):** **`state.activeCanonicalFireTypes`** (`Set` of **`watchId`** strings: **`breakout`**, **`fade`**, …). Default **empty** — canonical ★/◆/🛡/🎯 chart halos are **off until the user opts in**. **`priceChart.js`** filters merged fire draws in real mode by this set. **Synthetic mode** ignores this set and draws **`state.canonicalFires`** halos as before (no glossary panel).
- **Timeframe state:** `activeTimeframe`, `availableTimeframes`, and timeframe-switch memory (`savedMatrixRangeBeforeTf1h`).
- **Chart view mode state:** `candleMode` (`standard` | `phat`) with PHAT availability inferred from loaded API bars.
- **Viewport state:** `chartViewEnd` for panned history vs live edge. The first time the user pans off the live edge while `replay.allFires` is still empty, `precomputeAllFires()` runs (saving and restoring `chartViewEnd` so the viewport is not reset). **When `replay.cursor` already equals `replay.allBars.length` (tape end), `precomputeAllFires()` snapshots `replay.allFires` from `canonicalFires` with no `seek()` — no redundant full replay.** When `precomputeAllFires` is triggered from `_loadAllSessionsFromApi` after the initial `seekAsync(length)` (see below), `allFires` is filled that way without an extra `seek` pass. Chart halos for ★/◆/🛡/🎯 in **API replay** merge `allFires` and `canonicalFires` (when panned) and filter by **`activeCanonicalFireTypes`**. Matching uses `watchId|bar_time_ms`. In real mode, anchored VWAP is drawn from the same cumulative `allBars[0..cursor)` series for both live and panned views (visible slice is windowed from that), avoiding a false straight↔curved change at pan boundaries.
- **Brushing/linking state:** `selection` (`kind`, selected cells, selected bar times, fire window bounds). A fire selection from the event log or chart (`selectFire`) also sets `chartViewEnd` so the fire bar and the 31-bar window sit in the current viewport, runs `_syncCurrentSession` and `_refreshMatrixForView` (so the panned path isn’t “all dim, marker off-screen”), and the price chart adds a teal focus ring on the active ◆/★/🛡.
- **Selection deep-linking (URL):** selection state is mirrored into query params and restored after API replay load. Supported params are `selection=fire|cells`, `selectionFireTime` (epoch ms), `selectionFireWatch` (`watchId`), and `selectionCells` (`r.c,r.c,...`). This allows copy/paste refresh-safe links to reopen the same brushed event window (or matrix-cell brush set). Timeframe switches clear these selection params because rank-cell coordinates are timeframe-specific.
- **Display-state deep-linking (URL):** glossary checkbox state is mirrored into `displayFires` (canonical `watchId` CSV) and `displayEvents` (primitive glossary-key CSV). On replay-ready bootstrap, these sets restore before selection replay so halos/markers are visible when a deep-linked fire/cell selection is applied.
- **Matrix UI state:** `matrixState` (`range`, `displayMode`, cached occupancy payload).
- **Warmup state:** `regimeWarmup` gate for rank-unavailable startup bars.
- **Bias filter state:** `biasFilterMode` (`'soft'` | `'hard'` | `'off'`, default `'soft'`) and `showSuppressed` (`boolean`, default `false`). Bootstrapped from `?biasFilter=` and `?showSuppressed=` URL params (Phase 6 — see §13).
- **Backtest state:** `backtest` stores run params (`scope`, `compareRegimeOff`, `initialCapital`, `commissionPerSide`, `slippageTicks`, `qty`, marker toggles), `lastRunScope` (scope string stamped after each successful run for the metrics row while results are shown), latest `runId`, latest `stats`, and fetched `equity` / `trades` payloads plus loading/error UI flags. After API replay load, the dashboard does **not** query or render the latest persisted DuckDB run; metrics, equity, and chart overlays stay empty until the user selects a **Backtest scope** and clicks **Run Backtest**.

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
- **Occupancy range selector:**
  - **Current RTH** (`range.kind === 'session'`) resolves the RTH window of the internal session containing the effective right-edge bar: index **`clamp((chartViewEnd ?? cursor) - 1, …)`** into **`replay.allBars`** (same effective edge as viewport / matrix).
  - Last hour
  - Last N sessions
  - All loaded
  - Custom datetime range

Heatmap rendering is backed by `/occupancy`; occupancy diagnostics must reflect the active range window.

---

## 7) Charting Requirements

### 7.1 Price Chart

`src/render/priceChart.js` must support:

- Candles + event markers + fire halos. When a **sweep** and **divergence** both fire on the same bar and the same side (e.g. both at the low), their glyphs are vertically separated: the sweep triangle stays farther from the candle body and the divergence warning is offset toward the body so the two do not overlap. Standalone sweeps/divergences keep their prior single-event offsets. Fire halos render the watch-type
  glyph: ★ above the bar high for breakout; ◆ above the high for fade; 🛡 for absorption wall at the **high** when `close >= open` and at the **low** otherwise. Fade and absorption-wall halos add a smaller (9px) directional arrow (`↑` / `↓`) to the *right* of the glyph. Breakout keeps no arrow (sweep direction is the primary read).
- Candle rendering mode toggle in replay row (`Standard` / `PHAT`). PHAT mode is enabled only when loaded bars expose PHAT features and otherwise falls back to standard candles.
- PHAT rendering contract follows the prototype: body half opacity is driven by `topCvdNorm`/`bottomCvdNorm` (reinforcing aggression darker), wick geometry is asymmetric by `highBeforeLow` with uniform thin wicks anchored to opposite body edges, and at most one rejection circle per candle when `rejectionStrength > 0` (`rejectionSide`, `rejectionStrength`, `rejectionType`). The marker is centered on the wick tip at the extreme price; radius scales from 2px to 5px with strength. `absorption` renders filled circles, `exhaustion` renders hollow circles (chart-background fill plus colored stroke). Pipeline rejection scoring (`phat.py`) uses slightly looser gates than the literal prototype step-count + 50% retreat because ingest counts distinct tick levels with volume, not per-trade steps; bars must be re-aggregated into DuckDB for updated rejection fields to appear in `/bars`.
- Session-anchored VWAP with reset by session boundaries (real mode).
- Profile overlays (POC/VAH/VAL).
- RTH session open dividers with **session date** labels at **top** of the candle pane. **Canvas strip below the volume band** (the black band above HTML “Chart view”): **UTC-based clock ticks** on the x-axis in **12-hour** form (**`h:mm AM`** / **`h:mm PM`**, no `Z` suffix). If the viewport spans **multiple UTC calendar days**, ticks after each UTC midnight show **`Mon DD`** before the time (e.g. `Apr 28 9:05 AM`). Tick sampling uses denser spacing on **`1m` / `1h`** than on **`15m`**: **`15m`** yields fewer ticks, a larger minimum pixel gap between bounding boxes when panning dense multi-day spans, so labels do not overlap **Mirrored bottom-row session calendar dates** (viewport-aware thinning, at most ~10) appear only when **≥2** session-open dividers are visible **and** the timeframe is not **`15m`** (where that row would collide with wider date+time labels) **and** the viewport is **not** already multi-day (clock ticks carry day prefixes). Single-session **`1m`/`1h`** windows do not duplicate the bottom date strip unless multiple session opens satisfy the guards above.
- Hover tooltip and hit-testing.
- `NOW` marker at live edge.
- `PANNED` hint when detached from live edge.
- `↺ Live` control to return viewport to live cursor.
- **Bias ribbon** rendered above the candle pane via `src/render/biasRibbon.js` (Phase 6). Layout is timeframe-aware:
  - `1m`: two strips (1h, then 15m).
  - `15m`: one strip (1h).
  - `1h`: one self-strip showing the active timeframe's own bias.

  Ribbon hit regions emit `kind === 'bias'` hover hits consumed by the chart tooltip.
- **Repeat cooldown (chart signals):** After `detectEvents` produces candidates for a settled bar, `filterNewEventsCooldown` in `src/analytics/events.js` drops primitives that match the same signature `(type, dir)` as a recently kept event when the bar index gap is smaller than `eventCooldownBars` (default **4** from `SYNTH_TUNINGS` / per-session replay tunings). Cooldown indices are resolved on `state.replay.allBars` in API replay (global bar index, aligned with `sessionStartIdx`), and on the rolling `state.bars` window in synthetic mode. Bar times are matched by epoch ms so `Date` vs serialized time never bypasses dedup. When `sessionStartIdx` is set, pool entries before that index are skipped as anchors (continue), not compared with `===` to ring-buffer indices. Synthetic **`precomputeAllEvents()`** (checklist-selected path) applies the same rule using `allBars[0..i]`. Canonical halos (★ / ◆ / 🛡 / 🎯): `handleWatchFire` uses the same index source + session rule in `isCanonicalFireRepeatTooSoon`. Suppressed near-duplicates are omitted from `state.canonicalFires` / `replay.allFires` (no banner row for that edge).

### 7.2 Interaction

- Mouse wheel and drag pan/scrub through loaded history.
- Brushing-and-linking:
  - Matrix cell click filters/tints matching bars.
  - Fire click highlights a fire-centered fixed window (fire bar + next 30 bars).

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
- **Timeframe row:** **`#replayRow`** — **Timeframe** label + segmented control only (`1m` / `15m` / `1h`). Placed **under the price chart profile legend** (right-aligned), not in the page header. There is **no** seek scrubber, step buttons, or playback time readout — **`replay.cursor`** is advanced by **stream** / **Reset** / internal **`seek()`** (e.g. jump-to-fire, resume-stream snap), not by a header timeline control.
- **Chart pan row:** full-width **`chartPanSlider`** below the price canvas — adjusts **`chartViewEnd`** (viewport right edge via **`_setViewEnd`**), **not** the underlying cursor index for history inspection. Bounds follow **`replay.dateRange`** / bar count (**`MAX_BARS`** window semantics unchanged).

**Pan vs playback:** dragging the chart pan slider scrolls the visible window along the loaded bars. **Start Stream** / **Resume** drives **`replay.cursor`** forward. **`↺ Live`** clears **`chartViewEnd`** lock.

**Jump to next (canonical modals):** **`jumpToNextFire(watchId)`** (`src/data/replay.js`) wires from **`modal.js`** (not only `controls.js`) so the button is not blocked by fragile ESM init order across modules. Canonical fires for each watch are **sorted by time**; lookup uses **`modalFireContext`** (“next strictly after clicked fire”), else “next fire at/after **`replay.cursor`**”, else **wrap** to the **earliest** same-watch fire in loaded data (`chain[0]`). **`_findClosestBarIndex`** tolerates **`barTime`** mismatches vs **`allBars[i].time`**. **`src/ui/modal.js`** also exposes **`resetModalPanelPosition`** and **`bindModalDrag`**: grab the **`modal-drag-handle`** (`#modalHead` strip) to move **`#modalPanel`** with **`position: fixed`**; resets when the overlay closes/opens.

Mode subtitle summarizes the calendar span and states that chart pan previews history while stream advances playback.

### 9.2 Layout (`orderflow_dashboard.html`)

- **`col-left`:** Header, stream controls, **Price · Volume Profile** block (canvas, chart pan, legend, **`#replayRow`** timeframe strip), **Delta Distribution**, **Signals & glossary**.
- **`col-right`:** **Regime Matrix** stack, then **Event Log** (scroll list + sync hint; glossary drives row filter) beneath it.

### 9.1 Timeframe Switching Contract

Timeframe changes in API mode must:

- Reload bars for all loaded sessions at the selected timeframe.
- Preserve user context by snapping cursor to the equivalent bar-time window in the new timeframe.
- Clear timeframe-specific brush selections and invalidate profile/occupancy caches.
- Auto-adjust matrix heatmap range when entering/leaving `1h` (switch to `All loaded` on enter, restore prior range on exit).
- Keep replay chrome labels (mode badge/subtitle, counts/readout) synchronized with the active timeframe.

---

## 10) Profile Source of Truth

In API mode:

- Profile should come from true tick-level data via `/profile`.
- Returned structure feeds POC/VAH/VAL and histogram rendering.

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
9. Preserve multi-timeframe parity across pipeline, DB, API, and replay UI (`1m` / `15m` / `1h`).
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
    2. **Slack fold (Y-range fit)** with hysteresis: profile prices are folded into the candle-driven `[lo, hi]` only when within slack of the candle bounds. To prevent edge oscillation a Schmitt-trigger replaces the single threshold — a previously-unfolded price must come well *inside* `slackFold = candleRange × 1.5` to refold; once folded it stays folded until it moves outside `slackKeep = candleRange × 3.0`. State is keyed by profile identity (`priceLo|binStep|binCount`) and reset on profile change so we don't carry decisions across session boundaries, pans, or timeframe switches.
    3. **Off-range fallback**: any rejected price falls through to the existing off-range arrow indicator in `_drawRefLine` (POC/VAH/VAL pinned to top/bottom edge with a price label and ↑/↓ marker).

    Rejected carry-overs fall through to the deterministic OHLC proxy (`computeProfile(profileBars)`) which is computed fresh from the current bars and is by construction candle-aligned. Higher timeframes (`15m`, `1h`) keep their candle-only Y-fit (`fitProfileToRange === false`).
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

`vwap_position(close, vwap, band_ticks) → {-1, 0, +1}` returns the sign of `close - vwap` outside a configurable tolerance band, `0` when inside the band or when inputs are NULL/NaN. `VWAP_BAND_TICKS_BY_TF = {1m: 4, 15m: 8, 1h: 16}` is the canonical configuration.

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
| `parent_1h_bias` | `VARCHAR` | `bias_state` of the containing 1h bar (1m + 15m rows only) |
| `parent_15m_bias` | `VARCHAR` | `bias_state` of the containing 15m bar (1m rows only) |

Index: `idx_bars_tf_bartime(timeframe, bar_time)` to support the half-open denormalization join. Migrations are additive (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`) so Phase 5 DBs can be upgraded in place; until a fresh `aggregate` runs from raw `.dbn.zst`, existing rows have NULL bias columns and renderers must fall back gracefully.

### 13.3 Denormalization Join

LTF rows pick up parent biases via the half-open interval predicate:

```
LTF.bar_time >= HTF.bar_time
AND LTF.bar_time < HTF.bar_time + INTERVAL <htf width>
```

Aggregation order is `1h → 15m → 1m`; `_stamp_parent_bias(con, session_date, ltf)` runs after each LTF write so the parent rows are guaranteed to exist.

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

### 14.1 Scope

- **Strategy defaults JSON:** Optional overrides live in [`config/strategy_defaults.json`](config/strategy_defaults.json). Full resolution order, allowed `watch_id` values, reload semantics, and **profiles** (`config/profiles/*.json` selected via `ORDERFLOW_STRATEGY_CONFIG`) are documented in [`docs/strategy-config.md`](docs/strategy-config.md). Values merge on top of code defaults in [`pipeline/src/orderflow_pipeline/strategies/config.py`](pipeline/src/orderflow_pipeline/strategies/config.py) per timeframe (`cooldown_bars`, `min_bars`, `lookback_bars`, `warmup_start`, `stop_loss_ticks`, `take_profit_ticks`, `watch_exit_ticks`). Missing JSON keys keep code defaults. Set **`ORDERFLOW_STRATEGY_CONFIG`** to an absolute or cwd-relative path to use a different file. Loader: [`pipeline/src/orderflow_pipeline/strategy_json.py`](pipeline/src/orderflow_pipeline/strategy_json.py); tests should call `clear_strategy_config_cache()` after swapping files or env. Validate locally with `python scripts/validate_strategy_config.py`. JSON Schema for editors: [`config/strategy_defaults.schema.json`](config/strategy_defaults.schema.json) (authoritative checks are [`validate_strategy_document`](pipeline/src/orderflow_pipeline/strategy_json.py) + tests). If `version` exceeds the loader’s supported version, a **warning** is emitted and unknown future keys may be ignored.
- The MVP backtester reuses persisted `fires` as strategy triggers (no new signal model).
- Backtest execution is DB-fire only in production mode; if scoped `fires` are absent in-window, the run fails fast with a clear error.
- Recovery path: `python -m orderflow_pipeline.cli recompute-fires --db-path <duckdb> --timeframe <tf>` regenerates canonical `fires` from persisted `bars` for the selected window/timeframe without requiring a raw-data rebuild.
- Compare-mode exception: the **Regime filter OFF** branch derives signals from the same bar window using the extracted legacy strategy with regime gates disabled (`signalSource=derived_no_regime`) so ON vs OFF remains a true A/B test.
- Execution is single-position and deterministic: one open position max, flatten at the window end. **Exits:** opposite-direction signal (**flip**), optional **stop-loss** / **take-profit** barriers evaluated each bar using OHLC (`stop_loss` / `take_profit` exit reasons), or **end-of-window** flatten if still open.
- When SL/TP tick distances are unset everywhere (**broker config null** and strategy timeframe/watch defaults null), behavior reduces to flip-only plus end flatten — backward-compatible with historical flip-only runs.
- SL/TP resolution: optional **`BrokerConfig.stop_loss_ticks` / `take_profit_ticks`** act as **run-wide overrides** when either is non-null; otherwise each new position inherits **`LegacyFallbackConfig`** timeframe defaults merged with optional **`watch_exit_ticks`** per canonical watch (`pipeline/src/orderflow_pipeline/strategies/config.py`, resolver `strategies/exit_ticks.py`).
- Intrabar ambiguity (same bar touches both SL and TP): **stop-loss is assumed first** (risk-first). After fires fill or flip on a bar, SL/TP is evaluated again so new positions can still be stopped out within the same bar if price breaches.
- **`scripts/value_edge_parity_check.py`** compares Sharpe + equity **exactly** to a baseline run — expected to fail once SL/TP changes outcomes vs an old flip-only baseline; use separate baseline run IDs or flip-only configs when parity checking signals alone.
- Fire mapping:
  - `breakout`: trade with fire direction.
  - `fade`, `valueEdgeReject`, `absorptionWall`: trade opposite fire direction (mean-reversion read).

### 14.2 DuckDB Contracts

- `backtest_runs` stores one summary row per run (`run_id`, params, aggregate metrics, net P&L).
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

- `POST /api/backtest/run` runs synchronously for a requested timeframe/window and returns run summary (`runId`, `tradeCount`, `winRate`, `sharpe`, `maxDrawdown`, `netPnl`, `endingEquity`).
- `POST /api/backtest/run` accepts optional run-wide **`stop_loss_ticks`** / **`take_profit_ticks`** (nullable floats); omitted/null preserves strategy-default / flip-only resolution.
- `POST /api/backtest/run` accepts optional `watch_ids` to scope execution to specific canonical watches (`breakout`, `fade`, `absorptionWall`, `valueEdgeReject`).
- `GET /api/backtest/stats`, `/api/backtest/equity`, `/api/backtest/trades`, `/api/backtest/skipped-fires` return latest run by default, or a specific run via `runId`.
- `GET /api/backtest/trades` trade objects include **`exitReason`** (`flip`, `stop_loss`, `take_profit`, `end_of_window`, or null for legacy rows).
- `GET /api/backtest/equity` includes strategy equity points plus a benchmark payload (`benchmark.strategy='buy_hold'`, `benchmark.points`).
- Dashboard `Performance` panel includes:
  - Explicit **Backtest scope** dropdown (run scope is user-selected, not inferred from glossary checkbox visibility or URL display params). The dropdown defaults to an unset placeholder; **Run Backtest** stays disabled until the user chooses a scope (including **All canonical watches** when explicitly selected).
  - Optional **two-variant comparison:** checkbox **Compare regime filter OFF (second run)** (default off). When unchecked, only **Regime filter ON** runs (single API call); orange equity curve, OFF legend, OFF trade markers, and OFF skipped-fire summary are omitted. When checked, each click runs ON and OFF in parallel as before:
    - **Regime filter ON** (teal): current strategy behavior.
    - **Regime filter OFF** (orange): same entry/exit logic with regime gating removed.
  - Metrics cards render both variant values only when a paired OFF run exists; otherwise a single teal column. The equity chart overlays the OFF curve only when paired; buy-and-hold benchmark remains pink when returned for the ON run.
  - Price chart overlays backtest executions for the visible window:
    - entry marker = triangle
    - exit marker = X
    - entry/exit markers include explicit `E` / `X` text labels
    - markers are offset from candle bodies with a dark halo for visual separation
    - teal markers = regime-filter ON run
    - orange markers = regime-filter OFF run (only when Compare OFF is enabled and that run exists)
    - marker visibility: `Show Regime ON markers` always available; `Show Regime OFF markers` is shown only when Compare OFF is enabled.
  - Backtest status line includes skipped-fire summary for ON always; adds OFF summary only when paired OFF run exists.
  - Inputs: capital, commission-per-side, slippage ticks.
  - Run action button.
  - Metric cards (Sharpe, max drawdown, win rate, net P&L, trade count).
  - Equity curve canvas rendered from `/api/backtest/equity`.

### 14.5 Skipped Fire Diagnostics

- `skipped_fires` stores one row per non-executed fire candidate keyed by `(run_id, bar_time, watch_id, direction, reason_code)`.
- Required fields: `reason_code`; optional diagnostics include `price`, `position_side_before`, `position_size_before`, `reason_detail_json`.
- `backtest_runs.metadata_json` includes a `skipped_fires` reason-count summary for fast run-level diagnostics.

## 15. API-First SSoT Diagnostics Contract

- In API/real mode, canonical fire emission is backend-owned. Frontend JS evaluators may still run for display fallback but must not emit or mutate API-mode fire streams.
- Pipeline fire generation and backtest compare derivation both use the same Python strategy function (`derive_fires_from_bars`) with timeframe-specific config via `config_for_timeframe`. Implementation splits each watch strategy into its own module under `pipeline/src/orderflow_pipeline/strategies/` (`breakout.py`, `fade.py`, `absorption_wall.py`, `value_edge_reject.py`, plus shared `config.py`), composed by `legacy_fallback_logic.py`.
- Pipeline fire writes include additive diagnostics fields on `fires`: `diagnostic_version` and `diagnostics_json` (JSON payload, current version `v1`).
- `GET /fires` remains backward compatible by default. Diagnostics are opt-in with `includeDiagnostics=1`; default response shape is unchanged.
- API-mode UI diagnostics consume backend diagnostics when present. Fallback to JS evaluators is allowed only when diagnostics fields are missing from the response; present-but-null is treated as backend-owned state.
- Unknown diagnostics versions in API responses must log a console warning and use display-only fallback behavior.
- Aggregation/recompute must generate canonical fires for all supported timeframes (`1m`, `15m`, `1h`) when bars exist, and backtest smoke checks must succeed at those timeframes.
- Synthetic mode is explicitly legacy and non-authoritative for API/backtest SSoT guarantees in this phase.
