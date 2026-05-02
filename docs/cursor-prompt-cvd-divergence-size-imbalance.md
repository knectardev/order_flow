# Cursor Prompt: CVD Subchart + Size Imbalance Infrastructure

Read this prompt and produce a detailed implementation plan as `PLAN.md` before writing any code. This is empirical measurement infrastructure—not a feature whose interpretation has been validated yet. Treat it accordingly: surface clean primary observations, defer interpretive layers until backtesting can validate them.

## Context and intent

We are pivoting away from the wick rejection circle work (now shelved as unvalidated research). The replacement is more grounded:

- **Cumulative Volume Delta (CVD)** as a visualized time series alongside price.
- **Trade size imbalance** as a complementary measurement that captures *who* was being aggressive (large vs small participants), distinct from delta which captures *which side* was aggressive.
- **CVD divergence detection** as a well-established order flow concept with clear empirical hooks for backtesting later.

The framing throughout: build the measurement layer first, develop visual intuition, defer predictive claims until backtesting infrastructure exists. Avoid the wick-circle trap of polishing interpretations on top of unvalidated definitions.

## Phased deliverable

The plan should structure work into the following phases. Each phase is independently useful and should be implementable + shippable on its own. Don't bundle them.

### Phase 1: CVD subchart visualization (no detection)

A second panel below or above the price chart showing cumulative session delta as a line. Y-axis is delta units (net contracts), X-axis time-aligned with the price chart. CVD resets at session start.

Requirements:
- Per-bar CVD value computed in the pipeline (likely already available; if not, it's `cumsum(delta)` within session).
- Subchart renders the CVD line with appropriate styling (thin line, color that doesn't compete with price/PHAT encoding).
- Subchart is toggleable (show/hide via UI control).
- Tooltip on the CVD line shows the CVD value at hovered timestamp.
- Cross-hair sync: hovering the price chart highlights the corresponding CVD point and vice versa (reuse existing brushing infrastructure if applicable).

No detection, no annotations, no divergence work in this phase. Just see the CVD.

### Phase 2: Size imbalance computation in the pipeline (data layer only, no UI)

Add the following fields to the bar schema, computed during the existing trade aggregation pass (so no separate iteration over trades):

- `aggressive_buy_count` (int): number of trades classified as aggressive buys in the bar
- `aggressive_sell_count` (int): number of trades classified as aggressive sells
- `avg_aggressive_buy_size` (float): mean trade size of aggressive buys (0 if no aggressive buys)
- `avg_aggressive_sell_size` (float): mean trade size of aggressive sells (0 if no aggressive sells)
- `size_imbalance_ratio` (float): `avg_aggressive_buy_size / avg_aggressive_sell_size` with sensible handling of divide-by-zero (probably null when one side has zero trades)

These fields land in the `bars` table and the `/bars` API payload (camelCase: `aggressiveBuyCount`, `avgAggressiveBuySize`, etc.). No UI rendering in this phase. The data starts accumulating immediately so it's available for Phase 4 confirmation logic and any future analysis.

Schema migration: additive, follows the same pattern as the wick_ticks columns. Existing rows need backfill via the established re-aggregation flow.

Tests: verify size imbalance computation against a small synthetic trade fixture with known sizes.

### Phase 3: Swing point detection on price and CVD

Algorithmically identify swing highs and swing lows on both the price series and the CVD series, using a configurable lookback parameter (default 5 bars on each side).

A swing high at bar N requires: bar N's high is >= the highs of bars N-K through N-1 AND >= the highs of bars N+1 through N+K, where K is the lookback. Same logic for swing lows on lows. Apply the same rule to CVD (treating the CVD value at each bar as the relevant level).

Requirements:
- Swing detection runs in the pipeline, persisted as event records (not recomputed on every render).
- Per-timeframe (1m, 15m, 1h all get their own swing detection).
- Session-bounded: swings cannot span session boundaries.
- Configurable lookback parameter exposed in state (e.g., `swingLookbackBars`, default 5).
- Visualize swings as small markers on both panels (small triangles or dots at the swing points). This is the validation step—you want to see whether the algorithm's swing detection matches your visual intuition before building divergence detection on top of it.

Schema additions: a `swing_events` table or similar, with `bar_time`, `timeframe`, `series` (price or cvd), `direction` (high or low), and the relevant value at the swing point.

### Phase 4: CVD divergence detection with size imbalance confirmation

Detect divergences between price swings and CVD swings, with size imbalance as a confirmation layer.

Bearish divergence: price swing high #N is higher than swing high #N-1, BUT CVD swing high #N is lower than CVD swing high #N-1.

Bullish divergence: price swing low #N is lower than swing low #N-1, BUT CVD swing low #N is higher than CVD swing low #N-1.

For each detected divergence, compute size imbalance confirmation:
- At the two swing points being compared, look at the size imbalance ratio.
- If the size imbalance leans more in the contradicting direction at swing #N than at swing #N-1, mark `size_confirmation: true`.
- Otherwise mark `size_confirmation: false`.

Configurable parameters (state, with sensible defaults):
- Minimum price difference to qualify as a divergence (filter noise where prices are nearly equal).
- Minimum CVD difference to qualify.
- Maximum lookback distance between the two swings being compared.

Visual treatment:
- Confirmed divergences (size_confirmation: true) render with a solid connecting line on both panels (price chart line connecting the two price swings, CVD chart line connecting the two CVD swings, forming an X-shape across the panels).
- Unconfirmed divergences render with a dashed/muted connecting line.
- Color: bearish divergences use one color (e.g., red/warm), bullish use another (e.g., green/cool). Choose to match existing chart conventions.

Tooltip on a divergence line shows:
- Type (bearish or bullish)
- Price change between the two swings
- CVD change between the two swings
- Size imbalance at each swing point and whether confirmation passed
- Bars between the two swings

Persistence: divergence events go into a `divergence_events` table with all the relevant fields, including `size_confirmation`. This makes them queryable for future backtesting.

### Phase 5 (optional, deferred): Size-imbalance-only signal exploration

After Phases 1-4 are stable and have accumulated meaningful data, ask the empirical question: does size imbalance independently predict anything useful, separate from CVD divergence?

This phase is not in scope now. Mention it in the plan only as a future direction. Do not build size-imbalance-as-primary-signal detection until backtesting validates it has independent predictive value.

### Phase 6: Integration with existing systems

Once the divergence detection is in place:
- Tooltip integration on bars that are part of a divergence (mention the divergence in the bar's tooltip).
- Regime matrix correlation: when a divergence is selected, highlight the corresponding bars in the matrix point cloud so the user can see what regime cells the divergence spanned.
- Hooks for future backtest framework: divergence events should be queryable by type, size_confirmation, regime cell, etc.

## Architectural principles

**Pipeline computes, frontend renders.** All measurements (CVD, size imbalance, swings, divergences) are computed in the Python pipeline and persisted. The frontend reads pre-computed values and renders them. No on-the-fly computation in JS for these signals. Reasons: stability, backtestability, performance, and consistency between visualization and any future ML or backtest work.

**Don't combine signals into composite metrics in the data layer.** Keep delta, size imbalance, and any other measurements as separate fields. The analytical layer (divergence detection, future backtests, future ML) decides how to combine them. Composite "weighted delta" or similar is a temptation to resist—it conflates signals into one number that's harder to reason about.

**Configurable thresholds, sensible defaults.** Every threshold (swing lookback, minimum divergence magnitudes, size confirmation criteria) should be a state parameter with a documented default. The defaults are educated guesses, not validated truths. Surface them in the UI so users can iterate, similar to the conditional-formatting-style threshold work for the morphology encoding.

**Descriptive, not predictive.** All visual encodings and tooltips should describe what's measured, not what's predicted. A divergence is "price went up while CVD went down between these two swings"—it is NOT "this predicts a reversal." The interpretive claims wait for backtesting.

## Out of scope explicitly

- Backtesting infrastructure itself (separate effort).
- ML morphology classification work.
- Wick rejection circle refinement (shelved).
- Footprint chart mode (high effort, deferred).
- Order book imbalance from MBP-10 data (separate data subscription, not justified at this stage).
- Any predictive scoring panels (Reversal Detector, Continuation Detector, etc. from the old prototype). We earn the right to those by validating the underlying signals first.

## Deliverable

A `PLAN.md` covering:

1. Recap of the pivot from wick circles to CVD + size imbalance work, with the empirical-infrastructure framing.
2. Phase-by-phase implementation breakdown, each with concrete file lists, schema changes, test plans, and acceptance criteria.
3. Migration plan for schema additions in Phase 2 (size imbalance fields) and Phase 3 (swing events table) and Phase 4 (divergence events table).
4. Configurable parameter inventory: which thresholds are exposed, what their defaults are, and what their rationales are.
5. Open questions that need product input before implementation.

The plan should explicitly call out: this is measurement infrastructure for future empirical work, not a feature that claims predictive value. The architecture should preserve information at every layer (don't compress signals into composites prematurely) and expose interpretive thresholds as tunable parameters.

Once approved, implement Phase 1 first. Pause for review before starting Phase 2.
