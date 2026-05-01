# Cursor Prompt: Regime Matrix Point Cloud + Bidirectional Brushing

Read this prompt and produce a detailed implementation plan as a markdown file (`PLAN.md`) before writing any code. Do not implement yet — just plan.

## Goal

Add a new visualization layer to the SPY Intraday Pattern Analyzer that plots each candle as a point on the existing 5×5 Regime Matrix (volatility × order book depth), enabling visual exploration of correlations between candle morphology and regime states.

The existing heatmap-style regime detector that runs in parallel to the price chart should remain untouched. This is an additive feature.

## Core requirements

1. **Point cloud overlay on the regime matrix**
   - For each candle in the current view, compute its (volatility, depth) coordinates and plot it as a point on the existing regime matrix (axes: volatility 1–5 Quiet→Climactic, depth 1–5 Thin→Stacked).
   - Decide on normalization strategy as part of the plan (continuous coordinates within the 5×5 grid vs. snapped to cells). Default: continuous, so points can land anywhere within the grid, not just on cell centers.
   - One point per candle at the current chart timeframe.

2. **Temporal opacity gradient**
   - More recent candles render at full opacity; older candles fade toward translucent.
   - Opacity is tied to time distance from the most recent visible candle, not from "now" — so when the user scrolls back in time, the older points come back into higher relief.

3. **Bidirectional brushing between chart and matrix**
   - Clicking a candle on the price chart highlights its corresponding point on the matrix.
   - Clicking a point on the matrix highlights the corresponding candle on the chart.
   - Hover states should preview the same correlation without committing selection.
   - Shared selection state between the two components.

4. **Future-ready hooks (plan only, do not implement)**
   - Leave a clean extension point for color-coding points by candle morphology classification (the fat candle taxonomy work). Plan should note where this hook goes but not build it yet.

## Out of scope for this build

- ML classification of candle shapes
- Options data integration
- Changes to the existing regime heatmap detector
- Changes to regime axis definitions

## Deliverable

A `PLAN.md` covering:
- Component architecture (which existing components are touched, which are new)
- Data flow: how candle data → vol/depth coords → point cloud
- Normalization decision and rationale
- Opacity formula and how it responds to scroll/pan
- Selection state model and the two click handlers
- Where the morphology color-coding hook should live
- Any open questions or decisions that need my input before implementation

Keep the plan tight. Once I approve it, you'll implement.
