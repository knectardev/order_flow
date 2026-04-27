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

- Pipeline: `pipeline/src/orderflow_pipeline/*` computes bars, events, fires, regime ranks (`v_rank`, `d_rank`), session VWAP, directional bias states, and DB writes.
  - Aggregation contract supports `1m` / `15m` / `1h` bins.
  - DuckDB schema keys rows by `(bar_time, timeframe)` and keeps per-timeframe isolation for bars/events/fires/profile rows.
  - `bars` rows additionally carry `vwap`, `bias_state`, `parent_1h_bias`, `parent_15m_bias` columns (Phase 6 — see §13).
  - Aggregation order is `1h → 15m → 1m` so lower timeframes can denormalize parent biases via a half-open interval join in `_stamp_parent_bias`.
- API: `api/main.py` exposes read-only endpoints:
  - `/timeframes`
  - `/sessions`
  - `/bars`
  - `/events`
  - `/fires`
  - `/profile`
  - `/occupancy`
- API endpoints that return market rows are timeframe-aware (`timeframe` query parameter, default `1m`), and must not mix contexts across timeframes.
- `/bars`, `/events`, `/fires` payloads include `vwap`, `biasState`, `biasH1`, `bias15m` (camelCase) projected from the persisted columns via `_attach_htf_bias`.
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
- **Viewport state:** `chartViewEnd` for panned history vs live edge. The first time the user pans off the live edge while `replay.allFires` is still empty, `precomputeAllFires()` runs (saving and restoring `chartViewEnd` so the viewport is not reset). Chart halos for ★/◆ merge `allFires` and `canonicalFires` and match `bar` times by epoch ms so a Date/string mismatch does not drop markers. In real mode, anchored VWAP is drawn from the same cumulative `allBars[0..cursor)` series for both live and panned views (visible slice is windowed from that), avoiding a false straight↔curved change at pan boundaries.
- **Brushing/linking state:** `selection` (`kind`, selected cells, selected bar times, fire window bounds). A fire selection from the event log or chart (`selectFire`) also sets `chartViewEnd` so the fire bar and the 31-bar window sit in the current viewport, runs `_syncCurrentSession` and `_refreshMatrixForView` (so the panned path isn’t “all dim, marker off-screen”), and the price chart adds a teal focus ring on the active ◆/★.
- **Matrix UI state:** `matrixState` (`range`, `displayMode`, cached occupancy payload).
- **Warmup state:** `regimeWarmup` gate for rank-unavailable startup bars.
- **Bias filter state:** `biasFilterMode` (`'soft'` | `'hard'` | `'off'`, default `'soft'`) and `showSuppressed` (`boolean`, default `false`). Bootstrapped from `?biasFilter=` and `?showSuppressed=` URL params (Phase 6 — see §13).

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

Fade watch now evaluates **six** criteria. The five technical gates plus an HTF-alignment gate (Phase 6 follow-up — see §5.4):

- `balanced`
- `cell`
- `stretchPOC`
- `stretchVWAP`
- `noMomentum`
- `alignment` (1h bias not opposing trade direction)

Breakout watch likewise evaluates **five** criteria: `cell`, `sweep`, `flow`, `clean`, plus the same `alignment` gate.

All watch diagnostics and flip tracking must remain persistent across modal open/close cycles.

### 5.1a Canonical fire log rows (chart & event log)

Each row pushed to `state.canonicalFires` (and the full pre-scan `state.replay.allFires` in real mode) must include, in addition to `watchId`, `barTime`, `direction`, `price`, and optional `tag` / `alignment`:

- `checks` — shallow copy of the watch’s `canonical.checks` at commit time
- `passing` and `total` — same as the evaluator’s `passing` / `total` at that bar

**Watch modal (★ / ◆) behavior**

- **Glossary (no fire context):** the modal uses live `evaluateBreakoutCanonical()` / `evaluateFadeCanonical()` for the current bar.
- **Shift+click a chart fire halo** (or **Details** on the post-fire banner after a pause): if the log row has `checks`, the modal shows that **frozen** gate list and a short “snapshot” note; the flip-tick / `lastCanonical` path is skipped for that one paint so live tracking is not clobbered. Rows recorded before this contract (no `checks`) show the same note and fall back to live evaluation.
- **Plain click on a chart fire** still only brushes the bar window; the chart tooltip hint documents Shift+click vs. click.

### 5.2 Force Controls in Real Mode

In API replay mode, force buttons are repurposed:

- Legacy synthetic labels `Force ★/◆` become jump actions (next fire navigation behavior).

### 5.3 Anchor-Priority Tagging (Phase 6)

Each canonical evaluation that produces a fire also computes an `alignment` block and an `anchor-priority tag` from the latest bar's `biasH1` and `bias15m` (see §13):

- `alignment.score` ∈ `[-4, +4]` (sum of 1h + 15m votes against `dir1m`).
- `tag` ∈ `{HIGH_CONVICTION, STANDARD, LOW_CONVICTION, SUPPRESSED}`.
- During regime warmup `alignment` and `tag` are `null`; downstream renderers must handle null gracefully (no tint, no glyph).
- `tag === 'SUPPRESSED'` is only emitted when `state.biasFilterMode === 'hard'` and the 1h bias opposes `dir1m`. Suppressed fires are still persisted to `state.canonicalFires` (so they can be audited under `state.showSuppressed === true`) but must skip the canonical-fire banner and auto-pause.

### 5.4 Alignment as a Gating Check

`alignment` is also a **first-class criterion** in both `evaluateBreakoutCanonical` and `evaluateFadeCanonical`:

- `checks.alignment = (lastBar exists) && (alignment.vote_1h >= 0)` — i.e., the 1h bias must not oppose `direction`.
- The check evaluates `true` when biases are NULL (`vote_1h` defaults to `0` via `vote(null, dir)`) and when `biasFilterMode === 'off'`, preserving synthetic-mode and warmup behavior.
- `fired = passing === total` continues to be the gate, with `total = 5` for breakout and `total = 6` for fade.
- Practical effect: in `soft` mode, an opposing 1h bias produces a `LOW_CONVICTION` tag **and** fails the `alignment` check, so the fire no longer triggers — the tag is purely diagnostic. The watch panel still surfaces partial `passing/total` and tag tints so the user can see "would-be" fires that the alignment gate filtered out.

### 5.5 Fade-Specific Wyckoff Overrides

For `evaluateFadeCanonical`, `buildAlignment(lastBar, dir1m, 'fade')` applies a Wyckoff overlay on top of the base anchor-priority tag:

| `dir1m` | `biasH1` | Effect |
| --- | --- | --- |
| `up`   | `ACCUMULATION`   | Upgrade tag to `HIGH_CONVICTION`, `reason = 'wyckoff_spring'` |
| `down` | `DISTRIBUTION`   | Upgrade tag to `HIGH_CONVICTION`, `reason = 'wyckoff_upthrust'` |
| `up`   | `BEARISH_STRONG` | Annotate `reason = 'falling_knife'` (tag remains LOW/SUPPRESSED from base rule) |
| `down` | `BULLISH_STRONG` | Annotate `reason = 'falling_knife'` (tag remains LOW/SUPPRESSED from base rule) |

`score`, `vote_1h`, `vote_15m` are never modified by the overlay — only `tag` (and `reason`) — so score-tinted UI remains consistent with the raw vote sum.

The breakout evaluator continues to use the default `watchKind = 'breakout'` (no overrides).

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

- Candles + event markers + fire halos. When a **sweep** and **divergence** both fire on the same bar and the same side (e.g. both at the low), their glyphs are vertically separated: the sweep triangle stays farther from the candle body and the divergence warning is offset toward the body so the two do not overlap. Standalone sweeps/divergences keep their prior single-event offsets. Fire halos render the watch-type
  glyph above the bar high (★ for breakout, ◆ for fade). The fade diamond
  is drawn first at its tuned position (centered on the bar, alphabetic
  baseline, 11px), then a smaller (9px) directional arrow (`↑` / `↓`)
  is layered to the *right* of the diamond reflecting `fire.direction`.
  The arrow is additive — the diamond's render path is unchanged from
  the pre-tail implementation — so legacy fires with `direction == null`
  and breakout fires both render exactly as before. The tail is fade-only
  because breakout direction trivially follows the underlying sweep.
- Session-anchored VWAP with reset by session boundaries (real mode).
- Profile overlays (POC/VAH/VAL).
- RTH session open dividers and date labeling in replay timelines.
- Hover tooltip and hit-testing.
- `NOW` marker at live edge.
- `PANNED` hint when detached from live edge.
- `↺ Live` control to return viewport to live cursor.
- **Bias ribbon** rendered above the candle pane via `src/render/biasRibbon.js` (Phase 6). Layout is timeframe-aware:
  - `1m`: two strips (1h, then 15m).
  - `15m`: one strip (1h).
  - `1h`: one self-strip showing the active timeframe's own bias.

  Ribbon hit regions emit `kind === 'bias'` hover hits consumed by the chart tooltip.
- **Repeat cooldown (chart signals):** After `detectEvents` produces candidates for a settled bar, `filterNewEventsCooldown` in `src/analytics/events.js` drops primitives that match the same signature `(type, dir)` as a recently kept event when the bar index gap in the current `bars` slice is smaller than `eventCooldownBars` (default **4** from `SYNTH_TUNINGS` / per-session replay tunings). For `1m` replay, cooldown does not reach backward across a session start when comparing against prior events (session `startIdx` gate). `precomputeAllEvents()` applies the same rule to `replay.allEvents` using `allBars[0..i]` indices. Canonical chart halos (★ / ◆): `handleWatchFire` skips appending when `isCanonicalFireRepeatTooSoon` finds the same `(watchId, direction)` within `fireCooldownBars` (default equals `eventCooldownBars` unless tunings set `fireCooldownBars` separately). Suppressed near-duplicates are omitted from `state.canonicalFires` / `replay.allFires` (no banner row for that edge).

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
- Render an **Align column** (Phase 6) between the fire label and price, displaying the anchor-priority glyph (`✓✓` / `·` / `⚠` / `⊘`) and signed alignment score for fires; events render an empty placeholder cell so the grid stays consistent.
- Apply a low-alpha row tint driven by the fire's `tag` and `|score|`:
  - `HIGH_CONVICTION` → green
  - `LOW_CONVICTION` → amber
  - `SUPPRESSED` → red
  - `STANDARD` → near-transparent green/red leaning in the direction of `score` sign.
- Filter `SUPPRESSED` fires from the visible rows unless `state.showSuppressed === true`.

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
12. Preserve the VWAP-anchor bias contract end-to-end: `bias_state` always derived from `(v_rank, d_rank, vwap_position)` via `pipeline.bias.classify_bias`; LTF bars must carry denormalized `parent_1h_bias` / `parent_15m_bias` populated by the half-open join in `_stamp_parent_bias`.
13. Preserve the anchor-priority tag contract: 1h bias gates conviction, both-aligned ⇒ `HIGH_CONVICTION`, 1h-opposes ⇒ `SUPPRESSED` only in hard mode (else `LOW_CONVICTION`). Warmup ⇒ `null` tag/alignment.
14. Bias ribbon must remain visible above the candle pane on every timeframe and fall back gracefully (background-only strip) when bias columns are NULL.
15. The `?biasFilter=` and `?showSuppressed=` URL params are public surface for replay deep-linking — bootstrap behavior in `src/data/replay.js` must remain stable.
16. Detection thresholds in `events.js` (`sweepVolMult`, `divergenceFlowMult`) are bias-scaled by the bar's denormalized 1h parent (`biasH1`) via `_biasScale(biasH1, dir)` — the ×0.8 / ×1.0 / ×1.2 family. Null `biasH1` (synthetic / warmup / non-API) must fall back to ×1.0 so synthetic-mode behavior is preserved bit-for-bit. `absorbVolMult` and `absorbRangeMult` are intentionally not scaled (small-range absorption is a structural signal, not a momentum one).
17. `alignment` is a required first-class criterion in both canonical evaluators (see §5.4). Bumping `total` past `5` (breakout) / `6` (fade) without simultaneously updating `BREAKOUT_LABELS` / `FADE_LABELS`, `criterionKeys` arrays in `src/render/watch.js`, the `flipTicks` initializer in `src/state.js`, every `flipTicks = { ... }` reset in `src/data/replay.js` and `src/ui/controls.js`, and the modal `<li class="criterion">` rows in `src/ui/modal.js` is a regression — these surfaces are coupled by `data-key`.
18. Fade-specific Wyckoff overrides in `buildAlignment` must never modify `score`, `vote_1h`, or `vote_15m`; only `tag` and (optionally) `reason`. Score-tinted UI assumes the raw vote sum.
19. The 1m price chart's Y-axis must not compress candles into a thin band when the profile's price extent diverges from the visible candles (e.g. a stale `_lastApiProfile` carry-over from a prior session) **and** must not visibly oscillate between two scales when the profile's POC/VAH/VAL hovers at the inclusion threshold during playback. Three layered guards in `src/render/priceChart.js` enforce this:
    1. **Carry-over compatibility** (`_isApiProfileCompatibleWith()`) rejects the API-profile carry-over when (a) its price range is disjoint from the candle range (cross-session staleness) or (b) it fails to cover the candle range within `max(candleRange × 0.5, 2 ticks)` on either side. The 50%-of-range tolerance is intentionally loose: the live edge shifts the rolling 60-bar window by a tick or two each settle, which historically blew through a tighter (5%) tolerance on every frame and caused the renderer to flap between the API profile and the OHLC proxy mid-stream. Both methods compute POC differently, so flapping shows up as a multi-point POC jump. Cross-session detection is preserved by the disjoint check (a), which doesn't depend on the tolerance.
    2. **Slack fold (Y-range fit)** with hysteresis: profile prices are folded into the candle-driven `[lo, hi]` only when within slack of the candle bounds. To prevent edge oscillation a Schmitt-trigger replaces the single threshold — a previously-unfolded price must come well *inside* `slackFold = candleRange × 1.5` to refold; once folded it stays folded until it moves outside `slackKeep = candleRange × 3.0`. State is keyed by profile identity (`priceLo|binStep|binCount`) and reset on profile change so we don't carry decisions across session boundaries, pans, or timeframe switches.
    3. **Off-range fallback**: any rejected price falls through to the existing off-range arrow indicator in `_drawRefLine` (POC/VAH/VAL pinned to top/bottom edge with a price label and ↑/↓ marker).

    Rejected carry-overs fall through to the deterministic OHLC proxy (`computeProfile(profileBars)`) which is computed fresh from the current bars and is by construction candle-aligned. Higher timeframes (`15m`, `1h`) keep their candle-only Y-fit (`fitProfileToRange === false`).
20. **Signal repeat cooldown** must remain wired end-to-end: `eventCooldownBars` / `fireCooldownBars` in effective tunings (`getTunings()`), `filterNewEventsCooldown` on `state.events` at synthetic + replay commit, the same helper in `precomputeAllEvents`, and `isCanonicalFireRepeatTooSoon` inside `handleWatchFire` (see §7.1).

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
- Bias ribbon rendering: `src/render/biasRibbon.js`
- Canonical alignment / anchor-priority tagging: `src/analytics/canonical.js`, `src/sim/step.js`, `src/render/watch.js`
- Event log and interactions: `src/render/eventLog.js`, `src/ui/selection.js`
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
- `buildAlignment(lastBar, dir1m, watchKind = 'breakout')` returns `{score, vote_1h, vote_15m, tag, biasH1, bias15m}` (and optionally `reason` when fade overrides apply) where `score = vote_1h + vote_15m ∈ [-4, +4]`. `watchKind === 'fade'` enables the Wyckoff overlay documented in §5.5.

Tag rule (anchor-priority — the 1h vote dominates):

| 1h | 15m | tag |
| --- | --- | --- |
| opposes | any | `SUPPRESSED` (hard) / `LOW_CONVICTION` (soft, off) |
| agrees | opposes | `LOW_CONVICTION` |
| neutral | any | `STANDARD` |
| agrees | neutral | `STANDARD` |
| agrees | agrees | `HIGH_CONVICTION` |

### 13.5 Bias Filter Modes

- `state.biasFilterMode === 'soft'` (default): no fires are dropped by the tag rule; tags are surfaced as visual hints in the watch panel and event log. Note: the `alignment` gating check in §5.4 still applies — soft-mode `LOW_CONVICTION` fires that have `vote_1h < 0` will fail `checks.alignment` and therefore not reach `fired === true`, even though their tag is not `SUPPRESSED`.
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
