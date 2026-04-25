# Order Flow Dashboard — Requirements

> **Source:** Inferred entirely from `orderflow_dashboard.html` (single-file synthetic prototype). Where the code's inline comments and design notes state intent explicitly, this document reproduces that intent verbatim or in close paraphrase. Where intent had to be deduced from behavior, that is called out as **(inferred)**.

---

## 1. Product Overview

### 1.1 Purpose
A single-page, self-contained **pedagogical prototype** for visualizing market microstructure ("order flow") in a way that resists over-classification. The dashboard is explicitly labeled "Synthetic" — it does not consume real market data; it generates a probabilistic stream from an internal simulator and reasons over that stream the same way it would reason over real data.

### 1.2 Design Philosophy (verbatim/paraphrased from in-code design notes)
The dashboard is opinionated. The following principles are baked into the UI and must be preserved:

1. **Probabilistic, not single-cell.** The regime matrix is score-weighted. When confidence is low, multiple cells share illumination. This "resists the 'we have classified it, full stop' framing of single-highlight UIs."
2. **Per-bar Δ as a distribution, not a verdict.** Aggressor delta is shown as a histogram per bar rather than collapsed into a single classification. "Aggressor flow is mechanics, not intent — same print could be conviction, a stop, or a hedge. Distribution preserves what a single tag throws away."
3. **Sparse, event-typed markers.** Chart markers fire only on specific microstructural patterns. A bar with no marker is the default. "This keeps the eye on what's structurally meaningful rather than restating candle direction."
4. **Two entries, contrasting predictions.** The same matrix, event vocabulary, and VWAP/profile structure produce two canonical entries (`★ Breakout` and `◆ Fade`) that predict **opposite** price moves under different cell + condition combinations. This contrast is "the matrix earning its place."
5. **Failure twins.** Each canonical entry has a documented "failure twin" — the *same* candle / setup in an *adjacent* depth-axis cell predicts the opposite outcome. The depth axis carries the prediction.

### 1.3 Single-File Constraint
The entire dashboard ships as one HTML file with inline `<style>` and `<script>`. No build step, no external dependencies, no network calls. It must work by double-clicking the file.

---

## 2. Display Layout

### 2.1 Top-Level Structure
```
┌─────────────────────────────────────────────────────┐
│ Header: title · "Synthetic" badge · subtitle        │
├─────────────────────────────────────────────────────┤
│ Controls: [Start/Pause Stream] [Reset]              │
│ Speed slider: 1.0× … 8.0× (step 0.5)                │
├─────────────────────────────────────────────────────┤
│ Fire Banner (hidden by default)                     │
├─────────────────────────────────────────────────────┤
│ Two-column grid (≥1100px viewport) / single-column  │
│  LEFT                          │ RIGHT              │
│  ─────────────────────────────│ ───────────────────│
│  Price · Volume Profile · Evt │ Regime Matrix      │
│  Delta Distribution           │ Breakout Watch ★   │
│  Event Glossary               │ Fade Watch ◆       │
│  Event Log                    │                    │
└─────────────────────────────────────────────────────┘
```

### 2.2 Responsive Breakpoints
- **< 1100px:** Single column, sections stack vertically.
- **1100–1499px:** Two-column grid, left:right ≈ 1.55 : 1, container max 1280px.
- **≥ 1500px:** Two-column grid, left:right ≈ 1.7 : 1, container max 1440px.
- **< 480px (mobile):** Reduced padding, smaller matrix label column (44px vs 56px), smaller event-row time/price columns.

### 2.3 Color/Typography System
- Dark theme. Background `#0a0e14`, panels `#141923`, borders `#1f2734`.
- Monospace stack: `'IBM Plex Mono', 'JetBrains Mono', Monaco, monospace`.
- Semantic colors:
  - `--accent` teal `#21a095` — POC, primary actions, "current cell" highlight
  - `--up` green `#4ea674` / `--down` red `#c95760` — bullish / bearish bars and deltas
  - `--warn` amber `#d4a04a` — Breakout watch, divergence events, watched-cell stripe
  - `--absorb` blue `#6b8cce` — Absorption events, Fade watch
  - `--sweep` purple `#b07ac9` — Sweep events
  - `--stop` orange `#d4634a` — Stop-run events
  - `--muted` / `--muted-2` — secondary text, axis labels

---

## 3. Data Model

### 3.1 Bar (OHLCV + Δ)
Each bar carries:
| Field | Type | Description |
|---|---|---|
| `open` | number | Open price |
| `high`, `low`, `close` | number | OHLC |
| `volume` | int | Synthetic volume |
| `delta` | int | Synthetic aggressor delta (signed) |
| `time` | Date | Per-bar timestamp (1-minute increments from `Date.now()` at start) |

A bar is either **forming** (in-progress, drawn dashed/translucent) or **settled** (committed to history, drawn solid).

### 3.2 Event
Sparse markers attached to specific bars:
| Field | Type | Description |
|---|---|---|
| `type` | `'sweep' \| 'absorption' \| 'stoprun' \| 'divergence'` | Event class |
| `dir` | `'up' \| 'down'` (where applicable) | Directional sign |
| `price` | number | Where the marker is anchored (typically the bar's high/low/close) |
| `time` | Date | Matches the bar it belongs to |
| `_reviewed` | bool (internal) | Stop-run dedup flag on sweep events |

### 3.3 Canonical Fire
Records when one of the two canonical-entry watches has all 4 criteria true:
| Field | Description |
|---|---|
| `watchId` | `'breakout'` or `'fade'` |
| `barTime` | Time of the firing bar |
| `direction` | Predicted *trade* direction (`'up'` or `'down'`) |
| `price` | Bar close at fire |

### 3.4 Sliding Windows / Caps
- Settled bars: rolling window of `MAX_BARS = 60`. Older bars are shifted off.
- Events: capped at the most recent 80; older trimmed.
- Canonical fires: capped at 20.
- Trail (recent matrix path): last `TRAIL_LEN = 5` distinct cells.

---

## 4. Synthetic Simulation (Source of Truth for Demo)

### 4.1 Tick / Bar Cadence
- A simulation **step** runs every `BASE_TICK_MS / speedMultiplier` ms. Default `BASE_TICK_MS = 850ms`, speed `1×–8×`.
- A bar takes `FORMING_STEPS = 3` ticks to form. The first tick generates the bar; subsequent ticks **wiggle** its close, expand high/low, accumulate volume, and recompute delta. After 3 ticks the bar settles into history.
- Bar `time` is `Date.now() + sim.tick * 60_000` — i.e. each tick advances the synthetic clock by one minute.

### 4.2 Latent State
The simulator carries two integer state variables that drive bar character:
- `volState` ∈ `[0..4]` — volatility regime (mapped to matrix col).
- `depthState` ∈ `[0..4]` — book-depth regime (mapped to matrix row inversely; see §7).

State transitions per bar (when no scenario lock is active):
- `volState` flips ±1 with probability **0.08** per bar.
- `depthState` flips ±1 with probability **0.06** per bar.
- `bias` (directional drift sign, ±1) flips with probability **0.09** per bar.

The 0.08/0.06 figures are *intentionally slow* — the inline comment notes they were tuned from 0.18/0.14 down to 0.08/0.06 so that "state now persists ~12-17 bars per axis on average, which keeps the current-cell criterion aligned with recent sweep events long enough for the canonical entry window to converge." **This is a hard requirement** — if state churns too fast the canonical entries effectively never fire.

### 4.3 Bar Generation
For each new forming bar:
- `volMag = 0.35 + volState * 0.55`
- `drift = bias * volMag * U(0.05, 0.25)`
- `noise = (rand - 0.5) * volMag * 1.6`
- `close = open + drift + noise`
- `wickMag = volMag * (0.3 + depthState * 0.18)`
- `high = max(open, close) + rand() * wickMag`, mirrored for `low`
- `baseVol = 800 + volState * 400`
- 10% chance of a **volume spike**: multiplier `U(1.6, 2.6)`
- `volume = round(baseVol * U(0.7, 1.3) * spike)`
- `closePos = (close - low) / range` ∈ [0,1]
- `delta = round(volume * (closePos - 0.5) * 2 * U(0.3, 0.85))` — synthetic aggressor sign weighted by where close lands within the range, with random magnitude

### 4.4 Scenario Forcer (Demo Buttons)
Two buttons drive deterministic demo paths:

**Force ★ Breakout (`forceBreakoutScenario`)**
- Locks state to `[Impulsive · Light]` for 12 bars (`scenarioLockBars=12`, `scenarioLockCell=BREAKOUT_CELL`).
- Sets `primeNextSweep = true` — next generated bar is forced to exceed the prior 10-bar high/low by ≥0.6, with `spike = 2.2`, in the current bias direction.
- Picks a random ±1 bias.
- If stream is paused, starts it.

**Force ◆ Fade (`forceFadeScenario`)**
- Locks state to `[Active · Normal]` for 14 bars.
- Sets `primedDisplacement = 4` — next 4 bars get strong directional drift (`±0.55` per bar) **with `spike` explicitly forced to 1**, so no sweep events fire during the displacement. The comment is explicit: this is so the price can stretch from POC/VWAP without contaminating criterion 4.
- Picks a random ±1 direction.
- If stream is paused, starts it.

While a lock is active, `evolveSimState()` is short-circuited and state is pinned each bar.

---

## 5. Volume Profile (1σ Value Area)

### 5.1 Constants
- `PROFILE_BINS = 36` — fixed bin count regardless of price range.
- `VA_FRACTION = 0.68` — value area target (1σ, ≈68% of total volume).

### 5.2 Computation (`computeProfile`)
Computed from **settled bars only** (forming bar is excluded from profile).
1. Find global `lo`/`hi` across all bars. Fall back to `lo + 0.001` if range is degenerate.
2. Bin width = `(hi - lo) / PROFILE_BINS`.
3. For each bar, distribute its `volume` across the bins it spans, **weighted triangularly toward the close**: `w = 1 / (1 + dist * 0.6)` where `dist` is bin distance to the close-bin. Weights are normalized by span.
4. **POC** = bin index with maximum accumulated volume.
5. **Value area** = expand outward from POC, always grabbing the larger of `bins[hi+1]` vs `bins[lo-1]`, until accumulated ≥ `VA_FRACTION * sumBins`.
6. Return:
   - `bins`, `binStep`, `priceLo`, `priceHi`
   - `pocPrice` = midpoint of POC bin
   - `valPrice` = lower edge of expanded value-area window
   - `vahPrice` = upper edge of expanded value-area window
   - `maxBin` (for normalizing horizontal width on chart)

### 5.3 Display
- VAH and VAL drawn as horizontal **dashed** muted lines across the chart.
- POC drawn as a **solid teal** line (`rgba(33,160,149,0.55)`, slightly thicker).
- Profile histogram drawn on the right side of the price chart in a column ≤ 110px wide:
  - POC bin: solid teal `rgba(33,160,149,0.85)`
  - Bins inside VA: translucent teal `rgba(33,160,149,0.32)`
  - Bins outside VA: dim muted `rgba(138,146,166,0.18)`
- Labels printed next to profile column: `VAH x.xx`, `POC x.xx`, `VAL x.xx`.

Profile is only drawn when `bars.length > 2`.

---

## 6. Anchored VWAP

### 6.1 Computation (`computeAnchoredVWAP`)
- Anchored at the **oldest bar in the current rolling window**. Comment is explicit: as the window scrolls, the anchor moves forward — this is "session-VWAP-like for a fixed-length view." A real implementation would anchor to a session open or significant event; this approximation is **acceptable for the prototype's pedagogical purpose**.
- Standard formula: cumulative `sum(typical_price * volume) / sum(volume)`, where typical price = `(high + low + close) / 3`.
- Returns one `{time, vwap}` point per bar.

### 6.2 Display
- Drawn as a **dashed yellow line** (`rgba(220, 200, 90, 0.72)`, dash pattern `[4,3]`) over the price candles.
- Inline label `VWAP x.xx` printed at the right edge of the line.
- Only drawn when `bars.length >= 2`. Settled bars only (forming bar excluded).

---

## 7. Regime Matrix (5 × 5, Probabilistic)

### 7.1 Axes
- **Y axis (rows, top→bottom):** Volatility — `Climactic, Impulsive, Active, Steady, Quiet`. Index `0` is at the top (Climactic = highest vol).
- **X axis (cols, left→right):** Depth — `Thin, Light, Normal, Deep, Stacked`. Index `0` is at the left (Thin = least depth).
- Row labels include a small numeric index `5..1` (top→bottom).
- Column labels include a small numeric index `1..5` (left→right).

### 7.2 State → Cell Mapping
- Matrix row `r = 4 - sim.volState` (so the highest `volState` = topmost row = "Climactic").
- Matrix col `c = sim.depthState` (so the highest `depthState` = rightmost col = "Stacked").

### 7.3 Scoring (`computeMatrixScores`)
Posterior over the 25 cells, recomputed every tick:
- Centered on `(rTarget, cTarget)` derived from current sim state.
- Gaussian-ish kernel with `sigma = 0.85`: `w = exp(-d² / (2σ²))`.
- Each cell adds **uniform noise** in `[0.05, 0.10]` to prevent a hard winner.
- Normalize so all cells sum to 1.

### 7.4 Confidence (`computeConfidence`)
- Confidence = ratio of top score to second-best score, mapped sigmoidally: `clamp((ratio - 1) / 2, 0, 1)`.
- Display: confidence bar with three-stop gradient (red → amber → green) and numeric value (2 decimals).

### 7.5 Cell Visuals
Each cell is a square (1:1 aspect ratio) carrying multiple stacked indicators:
- **Score fill** — full-cell teal overlay, `opacity = (norm * 0.45)`. Brighter = higher posterior.
- **Trail dot** — small dot in bottom-right corner of cells visited in last `TRAIL_LEN=5` distinct steps. Opacity 0.55.
- **Current cell** — accent-color border + outer ring (`::after` glow) on the highest-scoring cell.
- **Watched-cell stripe** — persistent 2px top stripe + small `◢` corner mark:
  - **Amber** on the Breakout cell `[Impulsive · Light]` = `(r=1, c=1)`.
  - **Blue** on the Fade cell `[Active · Normal]` = `(r=2, c=2)`.
- **Fired pulse** — when a watch fires, the corresponding watched cell pulses (`firepulse` for breakout amber, `firepulse-fade` for fade blue) at 1.4s intervals.

### 7.6 Status Block (below matrix)
Two stat blocks side-by-side:
- **Most likely:** name of `top[0]` cell + `score 0.xxx · cell [vol#,depth#]`.
- **2nd alternative:** same for `top[1]`, in muted color.

---

## 8. Event Detection (Sparse, Multi-Criteria)

### 8.1 Lookback Requirement
No events fire until `history.length >= 12` bars exist. Detection uses a rolling window of the **last 10 settled bars** to compute:
- `recentHigh`, `recentLow` (highest high / lowest low)
- `avgVol` (mean volume)
- `avgRange` (mean of `high - low`)

### 8.2 Sweep
- **Up sweep:** `newBar.high > recentHigh` AND `newBar.volume > avgVol * 1.65`.
- **Down sweep:** `newBar.low < recentLow` AND `newBar.volume > avgVol * 1.65`.
- Glossary text says "1.8× avg" — the implementation uses **1.65×**. **(noted discrepancy — likely the threshold was loosened for the prototype; glossary copy is approximate.)**

### 8.3 Absorption
- `newBar.volume > avgVol * 1.75` AND `(newBar.high - newBar.low) < avgRange * 0.55`.
- Threshold history (per inline comment): originally 1.45×, **tightened to 1.75×** because `[Impulsive · Light]` naturally produces small-wick bars and was over-firing absorption, which self-poisoned the breakout watch's "no contradictions" criterion. **This tightening is a hard requirement** — undoing it breaks the demo path.

### 8.4 Divergence
Computed against cumulative delta over the last 8 bars + the new bar:
- **Up divergence:** `newBar.high > recentHigh` AND `cumD < -avgVol * 0.6`. (New high not confirmed by flow.)
- **Down divergence:** `newBar.low < recentLow` AND `cumD > avgVol * 0.6`.

### 8.5 Stop Run (post-hoc)
Re-evaluated each tick by `detectStopRun()`:
- For the most recent sweep event that has not yet been `_reviewed`, look at the bar **immediately after** the sweep bar.
- **Up stop-run:** sweep was up AND `next.close < sweepBar.open` (full reversal back through the open).
- **Down stop-run:** sweep was down AND `next.close > sweepBar.open`.
- Mark the source sweep `_reviewed = true` so it's not re-evaluated.
- The new event is timestamped to the *reversal* bar, not the sweep bar.

### 8.6 Glossary (User-Facing Definitions — live in HTML)
| Glyph | Name | Definition |
|---|---|---|
| ▲▼ | SWEEP | Bar exceeds prior N-bar high/low with volume > 1.8× avg. ▲ above bar = up-sweep, ▼ below = down-sweep. |
| ◉ | ABSORPTION | High volume + small range. Flow met liquidity, liquidity won. |
| ⚡ | STOP RUN | Sweep that fully reverses next bar. Often "last buyers/sellers in." |
| ⚠ | DIVERGENCE | New price extreme not confirmed by cumulative Δ over lookback. |
| ★ | BREAKOUT FIRE | All 4 criteria met for [Impulsive · Light] entry — predicts directional travel. |
| ◆ | FADE FIRE | All 4 criteria met for [Active · Normal] entry — predicts mean-reversion to POC. |

### 8.7 Display
- Sweep markers placed above (up) or below (down) the bar by ~0.7 font-size.
- Absorption ◉ at the bar's close.
- Stop-run ⚡ at the swept price level on the reversal bar.
- Divergence ⚠ at the new extreme, offset half a font-size away from the bar.
- Glyphs are rendered as **the same Unicode characters used in the legend** (no path-vs-glyph drift). This is a hard requirement called out in the code comment: "chart icons and legend icons are visually identical."
- Marker font size scales with bar slot width: `max(9, min(slotW * 0.95, 14))`.

---

## 9. Canonical Watches

Two watches run in parallel each tick. Each has its own state struct: `lastCanonical`, `firedThisCycle`, and per-criterion `flipTicks` (the sim-tick at which each criterion last went TRUE → FALSE).

### 9.1 Breakout Watch — `★ [Impulsive · Light]`

**Watching for:** sweep into thin book with cumulative-Δ confirmation.
**Predicts:** directional travel toward next structural level (opposite VAH/VAL, prior session extreme) within ~15 bars after entry.
**Failure twin:** identical pattern in `[Impulsive · Stacked]` predicts absorption + reversal — same candle shape, opposite outcome.

Cell coordinates: `r=1, c=1`, i.e. `(volState=3, depthState=1)`.

| # | Key | Test |
|---|---|---|
| 1 | `cell` | `sim.volState === 3 AND sim.depthState === 1` |
| 2 | `sweep` | At least one **sweep** event timestamp is in the last 3 settled bars |
| 3 | `flow` | Cumulative Δ over last 5 settled bars has the same sign as the most recent in-window sweep direction |
| 4 | `clean` | In the last 8 settled bars, **no absorption** event AND **no divergence in the same direction** as the sweep |

Fires when all 4 criteria are true. `direction` = sweep direction.

### 9.2 Fade Watch — `◆ [Active · Normal]`

**Watching for:** price stretched ≥1σ from POC for 3+ bars, confirmed by anchored VWAP, with no fresh momentum in the stretch direction.
**Predicts:** drift back toward POC within ~25–40 bars (slower, longer horizon than breakout).
**Failure twin:** identical stretch in `[Active · Thin]` predicts continuation, not reversion. Thin book lets stretch run; normal/deep book pulls it back.

Cell coordinates: `r=2, c=2`, i.e. `(volState=2, depthState=2)`.

| # | Key | Test |
|---|---|---|
| 1 | `cell` | `sim.volState === 2 AND sim.depthState === 2` |
| 2 | `stretchPOC` | The last 3 settled bars **all close** > `pocPrice + σ` (up stretch) or all < `pocPrice - σ` (down stretch), where `σ = (vahPrice - valPrice) / 2` |
| 3 | `stretchVWAP` | Most recent bar's close is on the same side of the anchored VWAP as the POC stretch, by at least `σ * 0.4` |
| 4 | `noMomentum` | No **sweep** event in the last 5 settled bars in the *stretch* direction |

Fires when all 4 criteria are true. `direction` = predicted **trade** direction = **opposite** of stretch direction.

> **IMPORTANT** (from code comment): `direction` for the fade watch is the *trade* direction, which is the **opposite** of the stretch direction. Stretch up → fade short → `direction='down'`.

### 9.3 Watch Panel UI (per watch)
Each watch panel contains:

1. **Header** — title + colored match score `N / 4`.
   - Breakout panel: amber accents, title prefix `★`.
   - Fade panel: blue accents, title prefix `◆`.
2. **Summary blurb** — one paragraph describing what is being watched and what it predicts.
3. **Criteria list** — 4 rows. Each shows `○` (unmet) or `✓` (met, in green); met rows brighten the text.
4. **Diagnostic line** — "last to break: <criterion name> · N tick(s) ago".
   - Computed from `flipTicks`: among criteria currently FALSE that were previously TRUE, the one with the most recent flip wins.
   - When all 4 are true: `"all 4 criteria met — fire armed"`, with green-accent border-left.
   - When none have ever been true: `"no criteria yet met"`.
   - When some are true but none have flipped from prior true: `"N/4 — none broken from prior true state"`.
5. **Controls row**
   - Auto-pause checkbox (default ON, scoped per watch).
   - Force button — `Force ★` or `Force ◆`.
6. **Failure-twin footer** — one line naming the adjacent cell that produces the opposite outcome.

### 9.4 Fire Behavior (`handleWatchFire`)
- Edge-triggered per watch via `firedThisCycle` flag — fires exactly once per arming cycle, resets to false the next time `canonical.fired` is false.
- On fire:
  1. Push a fire record onto `canonicalFires` with `watchId`, `barTime`, `direction`, `price`. Cap at 20.
  2. If that watch's auto-pause checkbox is checked AND the stream is currently running, call `pauseForFire()`.

### 9.5 Auto-Pause Banner (`pauseForFire`)
- Stops the simulation interval, updates the Stream button to `"Resume Stream"`.
- Shows the fire banner with copy:
  - **Breakout:** icon `⚡`, headline "Breakout canonical fired · stream paused", detail `"[Impulsive · Light] · sweep ↑/↓ · all 4 criteria met. Predicts upward/downward travel toward next structural level within ~15 bars."`
  - **Fade:** icon `◆`, headline "Fade canonical fired · stream paused", detail `"[Active · Normal] · stretch ↑/↓ from POC + VWAP · all 4 criteria met. Predicts upward/downward drift back toward POC within ~25-40 bars."`
- Banner color theming matches the watch (amber for breakout, blue for fade).
- `Resume` button on the banner: dismisses the banner and resumes the stream.

### 9.6 Fire Halo on Chart
Each fire record draws a halo on the price chart on the bar where it fired:
- Outer ring radius `max(10, slotW * 0.7)`.
- Color matches watch (amber for breakout, blue for fade).
- Glyph (`★` or `◆`) above the bar's high.
- Drawn **underneath** event markers so the SWEEP/etc. glyph sits on top — explicit Z-order requirement from a code comment.

---

## 10. Charts

### 10.1 Price Chart (`#priceChart`, height 240px)
Layout per render:
- Right-hand profile column ≤ 110px wide (or 22% of width, whichever is smaller).
- Padding `{l:6, r:8, t:10, b:14}`.
- Y-scale fits all bars (settled + forming) plus 5% top/bottom padding.
- Slot width = `chartW / max(totalBars, 12)` — at least 12 slots' worth of horizontal space is reserved so a fresh chart doesn't draw bars too wide.
- Candle width = `max(2, min(slotW * 0.65, 14))`.

Render order (back-to-front):
1. Background `#0d1218`.
2. VAH/VAL dashed lines (full chart width).
3. POC solid teal line.
4. Candles. Forming bar uses translucent fill + dashed border.
5. Anchored VWAP dashed yellow line + label.
6. Canonical fire halos (rings + glyph above bar).
7. Event markers (drawn on top of halos).
8. Volume profile column on the right.
9. Last-price tag at the right edge of the last close, colored by direction.

### 10.2 Delta Distribution Chart (`#flowChart`, height 64px)
Per-bar delta histogram in the same horizontal alignment as the price chart (so columns line up):
- Right padding reserves the same profile column width so bar columns align with price candles above.
- Zero line drawn through the middle.
- Each bar's delta scaled against the max absolute delta in the window.
- Positive deltas extend up from midline (green); negative extend down (red).
- Forming bar drawn translucent + dashed.
- **Cumulative delta sparkline** overlaid in teal.
- Section header shows live readout `cum Δ ±N` (right-aligned, formatted with thousands separators).

---

## 11. Event Log

- Below the Event Glossary on the left column.
- Shows the last 10 events in reverse chronological order.
- Empty state: `"no events yet — events fire only on specific microstructural patterns, not every bar"` (italic, muted).
- Header meta shows `"N event(s)"`.
- Each row: `time | glyph | label | price`.
  - Time format: `HH:MM` (24h or locale default).
  - Color of the glyph matches event class (sweep purple, absorb blue, stop orange, divergence amber).
  - Labels:
    - Sweep: `"Sweep ↑/↓ cleared prior high/low"`
    - Absorption: `"Absorption — high vol, compressed range"`
    - Stop run: `"Stop run — sweep ↑/↓ reversed"`
    - Divergence: `"Divergence — new high/low, Δ disagrees"`
- Max height 138px with vertical scroll.

---

## 12. Controls

| Control | Behavior |
|---|---|
| `Start Stream` / `Pause Stream` / `Resume Stream` | Toggles `setInterval(step, getTickMs())`. On start, runs one immediate `step()` so the user sees movement instantly. On pause, button text is `"Resume Stream"`; on first start ever or after reset, it is `"Start Stream"`. |
| `Reset` | Clears bars, events, trail, fires, watch state, scenario locks. Resets sim to defaults (`price=4500, volState=2, depthState=2, bias=1, tick=0`). Re-renders empty matrix and watches. |
| Speed slider | Min 1, max 8, step 0.5. Live label `"X.X×"`. If running, the interval is restarted with the new tick interval. |
| `Force ★` (in Breakout panel) | See §4.4. |
| `Force ◆` (in Fade panel) | See §4.4. |
| Auto-pause checkbox (one per watch) | Default checked. When checked AND that watch's canonical fires AND the stream is running, the stream auto-pauses and the fire banner appears. |
| Fire banner `Resume` button | Hides banner and resumes the stream (calls `toggleStream()`). |

---

## 13. Initialization & Lifecycle

On load (`init` block at end of script):
1. `buildMatrix()` — generates the 5×5 grid DOM with row labels, cells, x-axis row.
2. Compute initial `matrixScores` from default sim state.
3. Run `evaluateBreakoutCanonical` and `evaluateFadeCanonical` once (both will be all-false, no bars).
4. `renderMatrix`, `renderBreakoutWatch`, `renderFadeWatch`, `drawPriceChart`, `drawFlowChart`.
5. Attach `resize` listener that redraws both canvases.

Stream is **not** auto-started — the user must click `Start Stream`.

---

## 14. Canvas Scaling
Both canvases use `devicePixelRatio` scaling: the canvas backing store is sized in physical pixels, the 2D context is scaled by `dpr` so all drawing math is in CSS pixels. `resizeCanvas` is called at the top of every draw call so resizing the window or DPI changes are picked up.

---

## 15. Hard Constraints (Do Not Break)

These are constraints called out explicitly in inline comments or implied by the demo's correctness:

1. **State persistence ~12–17 bars.** Don't raise `volState`/`depthState` flip probabilities above 0.08 / 0.06 — the canonical-entry windows depend on state being sticky enough to align with sweep/stretch criteria.
2. **Absorption threshold 1.75× avg vol with range < 0.55× avg range.** Loosening this re-introduces the over-firing that self-poisoned the breakout `clean` criterion.
3. **Fade displacement priming must suppress volume spikes** (`spike = 1`). Otherwise the priming creates sweeps that violate criterion 4 (`noMomentum`).
4. **Chart event glyphs and legend glyphs must use the same Unicode characters.** No path-drawn arrow heads — the glossary and the chart must show identical icons.
5. **Fire halos draw under event markers**, not over.
6. **Profile uses settled bars only.** The forming bar must not contribute to POC/VAH/VAL.
7. **VWAP uses settled bars only** for the same reason.
8. **Auto-pause is per-watch.** The two checkboxes are independent.
9. **`firedThisCycle` is edge-triggered per watch** so a sustained 4/4 state doesn't re-fire/re-pause every tick.
10. **The "Synthetic" badge stays in the header** — this prototype must never be mistaken for a live data feed.

---

## 16. Glossary of Internal Terms

| Term | Meaning |
|---|---|
| Forming bar | The current in-progress bar. Drawn dashed/translucent. Excluded from profile, VWAP, and event detection until it settles. |
| Settled bar | A committed historical bar in the rolling 60-bar window. |
| Cell | One of 25 squares in the regime matrix, indexed `(row, col)` = `(volatility, depth)`. |
| Watched cell | The two cells (`Impulsive · Light`, `Active · Normal`) that have persistent stripe + corner mark; one per canonical watch. |
| Trail | The last 5 *distinct* cells visited by the simulator, shown as small corner dots. |
| Posterior / score | The cell's weighted probability of being the current regime, summing to 1 across the matrix. |
| Confidence | Top score / second score, sigmoidally mapped to [0,1]. |
| Fire | A canonical watch reaching 4/4 criteria simultaneously, edge-triggered. |
| Failure twin | An adjacent cell on the depth axis where the same setup predicts the opposite outcome. |
| Stretch direction | Which side of POC/VWAP price is displaced toward (fade watch). |
| Trade direction | The *predicted* direction of price travel after a fire — opposite of stretch for fade, same as sweep for breakout. |
