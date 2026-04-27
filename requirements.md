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
3. Contrasting canonical hypotheses (`★ Breakout` vs `◆ Fade`) with explicit failure twins.
4. Order-flow context from profile + VWAP + event structure.

---

## 2) Architecture

### 2.1 Frontend

- Entry shell: `orderflow_dashboard.html`.
- Styling: `styles/dashboard.css`.
- Runtime: ES modules under `src/` (no bundler required).
- Core state model: single mutable singleton in `src/state.js`.

### 2.2 Data Pipeline and API

- Pipeline: `pipeline/src/orderflow_pipeline/*` computes bars, events, fires, regime ranks (`v_rank`, `d_rank`), and DB writes.
  - Aggregation contract supports `1m` / `15m` / `1h` bins.
  - DuckDB schema keys rows by `(bar_time, timeframe)` and keeps per-timeframe isolation for bars/events/fires/profile rows.
- API: `api/main.py` exposes read-only endpoints:
  - `/timeframes`
  - `/sessions`
  - `/bars`
  - `/events`
  - `/fires`
  - `/profile`
  - `/occupancy`
- API endpoints that return market rows are timeframe-aware (`timeframe` query parameter, default `1m`), and must not mix contexts across timeframes.
- Storage: DuckDB (`data/orderflow.duckdb` by default).

### 2.3 Mode Loading

- App bootstraps synthetic first, then attempts replay bootstrap.
- Real mode is explicitly selected via query string (`?source=api`).
- Synthetic remains supported and is the fallback when API replay is unavailable.

---

## 3) State Model (Single Source of Truth)

All mutable runtime state is centralized in `src/state.js`:

- **Stream data:** `bars`, `formingBar`, `events`, `canonicalFires`, `trail`, `matrixScores`.
- **Watch state:** `breakoutWatch`, `fadeWatch` with persistent `lastCanonical`, edge-trigger flags, and flip tracking.
- **Replay state:** `replay.mode`, session metadata, full loaded bars/events/fires, cursor, data source flags.
- **Timeframe state:** `activeTimeframe`, `availableTimeframes`, and timeframe-switch memory (`savedMatrixRangeBeforeTf1h`).
- **Viewport state:** `chartViewEnd` for panned history vs live edge.
- **Brushing/linking state:** `selection` (`kind`, selected cells, selected bar times, fire window bounds).
- **Matrix UI state:** `matrixState` (`range`, `displayMode`, cached occupancy payload).
- **Warmup state:** `regimeWarmup` gate for rank-unavailable startup bars.

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

Two canonical watches continue to run continuously with edge-trigger fire behavior:

- `★ Breakout` at `[Impulsive · Light]`.
- `◆ Fade` at `[Active · Normal]`.

### 5.1 Fade Criteria Update

Fade watch now evaluates **five** criteria (not four), including the new `balanced` gate in addition to:

- `cell`
- `stretchPOC`
- `stretchVWAP`
- `noMomentum`

All watch diagnostics and flip tracking must remain persistent across modal open/close cycles.

### 5.2 Force Controls in Real Mode

In API replay mode, force buttons are repurposed:

- Legacy synthetic labels `Force ★/◆` become jump actions (next fire navigation behavior).

---

## 6) Matrix Panel Enhancements

Right column now includes matrix controls beyond posterior view:

- **Display mode toggle:** `Posterior` / `Heatmap`.
- **Occupancy range selector:**
  - Current session
  - Last hour
  - Last N sessions
  - All loaded
  - Custom datetime range

Heatmap rendering is backed by `/occupancy`; occupancy diagnostics must reflect the active range window.

---

## 7) Charting Requirements

### 7.1 Price Chart

`src/render/priceChart.js` must support:

- Candles + event markers + fire halos.
- Session-anchored VWAP with reset by session boundaries (real mode).
- Profile overlays (POC/VAH/VAL).
- RTH session open dividers and date labeling in replay timelines.
- Hover tooltip and hit-testing.
- `NOW` marker at live edge.
- `PANNED` hint when detached from live edge.
- `↺ Live` control to return viewport to live cursor.

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

---

## 9) Replay Controls

When sessions are loaded (real mode), show replay row with:

- Session selector.
- Timeframe selector (`1m` / `15m` / `1h`) with disabled states for unavailable DB timeframes.
- Step backward / forward buttons.
- Scrubber slider.
- Time readout.

Seeking must keep matrix/charts/log in sync and maintain deterministic selection behavior.

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

---

## 12) Primary Files and Ownership

- Shell and static layout: `orderflow_dashboard.html`
- Styling and responsive behavior: `styles/dashboard.css`
- App bootstrapping and wiring: `src/main.js`
- Runtime state contract: `src/state.js`
- Replay and seek behavior: `src/data/replay.js`
- Timeframe controls and mode chrome wiring: `src/main.js`, `src/ui/controls.js`, `src/data/replay.js`
- Matrix rendering and occupancy integration: `src/render/matrix.js`, `src/ui/matrixRange.js`, `src/data/occupancyApi.js`
- Price chart and profile integration: `src/render/priceChart.js`, `src/data/profileApi.js`
- Event log and interactions: `src/render/eventLog.js`, `src/ui/selection.js`
- Backend API: `api/main.py`
- Pipeline/ranking logic: `pipeline/src/orderflow_pipeline/*`
