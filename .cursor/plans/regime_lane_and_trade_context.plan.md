---
name: Regime lane and trade context
overview: Replace candle-based velocity encoding with a fixed-height two-row regime lane, ingest-time trade_context, composite dots using a single locked teal/amber/violet palette (no candle collision), tooltip-first inspection for dev cell index, explicit glyph vertical stack, one-shot SQL backfill script, and requirements updates per pre-implementation resolutions.
todos:
  - id: pipeline-trade-context
    content: Add bars.trade_context; stamp after stamp_velocity_regimes on every aggregate/rebuild; Bar/API/DB; tests; verify fresh aggregate fills column without migration script
    status: pending
  - id: backfill-script
    content: One-shot migration UPDATE trade_context WHERE NULL; same label function as ingest; for existing DBs only
    status: pending
  - id: chart-lane-dots
    content: "priceChart: 17px lane; dot colors; OVERLAY_STACK_STEP; implement explicit paint phases; post-impl verify z-order vs tall wicks"
    status: pending
  - id: event-glyphs-stack-followup
    content: "Follow-up (not this PR): move priceChart event/primitive glyph Y to tier 2 (yHigh-12) to end transitional collision with composite dots"
    status: pending
  - id: tooltip-regime-fields
    content: Extend bar hover tooltip with pldRatio, flipRate, jitterRegime, convictionRegime, tradeContext; dev cell 1–9 tooltip-only when toggle on
    status: pending
  - id: legend-state-html
    content: Legend swatches + toggles; dev matrix note uses is-off styling when toggle off; sync on toggle like other overlay buttons
    status: pending
  - id: requirements-sync
    content: requirements.md — palette, stack, z-order phases, ingest+backfill, deferred glyph work, legend behavior
    status: pending
isProject: false
---

# Regime lane, trade context, and chart UX (from notes.txt)

## Goals (from notes)

- Move jitter + conviction **off the candle bodies** into a **dedicated horizontal lane** (two stacked rows, one color cell per bar per regime).
- **Locked palette (teal / amber / violet)** for regime visuals and composite dots — **never** reuse candle bull/bear greens/reds for regime encoding or composite markers.
- Legend: **Low / Mid / High** swatches per regime row + composite dot swatches.
- **Default:** composite `trade_context` dots; **default OFF:** old full-chart tint and candle borders.
- **Dev:** optional **tooltip-only** matrix cell **1–9** (no persistent per-bar labels — avoids clutter and lane pixel fights).

---

## Locked visual system (spec — not left to implementation time)

### Composite dot colors (distinct from bull/bear candles)

All dots are **filled circles** (~3–4px radius), same hue family as the lane (muted variants in lane, saturated for dots):

| `tradeContext` | Role | Dot fill (commit these) |
|----------------|------|-------------------------|
| `favorable` | Low jitter + High conviction | **Teal-leaning green** `rgb(45, 212, 191)` / `#2dd4bf` at **α ≈ 0.95** |
| `avoid` | High jitter + Low conviction | **Amber** `rgb(245, 158, 11)` / `#f59e0b` at **α ≈ 0.95** — **never** candle `CHART_CANDLE_DOWN` red |
| `watch` | High jitter + High conviction | **Violet** `rgb(167, 139, 250)` / `#a78bfa` at **α ≈ 0.95** |
| `neutral` / missing | No strong composite | **No dot** |

Lane row fills use **muted** tints in the **same three hues** (teal / amber / violet families) plus a neutral gray for Mid — exact muted RGBAs live next to the constants in code and are duplicated in legend swatches.

### Regime lane geometry (fixed)

- **Total lane height: 17px** — **row1 = 8px**, **separator = 1px**, **row2 = 8px**.
- Constants: e.g. `REGIME_ROW_PX = 8`, `REGIME_SEP_PX = 1`, `REGIME_LANE_TOTAL = 17`.
- Lane sits **between** the price pane and the volume band; candle pane height shrinks by **17px + small gap** (same gap pattern as existing `VOL_BAND_GAP`).

### Vertical glyph stack (fixed convention)

Document in [`requirements.md`](requirements.md) so future overlays do not collide ad hoc. Use **`priceChart` CSS pixels**, **y decreasing upward**:

1. **Price / wick top** — baseline reference `yHigh = yScale(bar.high)`.
2. **Composite `tradeContext` dot** — center at **`yHigh - OVERLAY_STACK_STEP`** where **`OVERLAY_STACK_STEP = 6`** px (first anchor above the wick tip).
3. **Event / primitive glyphs** (existing chart markers) — **target** anchor at **`yHigh - 2 * OVERLAY_STACK_STEP`** (i.e. **12px**). **This PR does not move event glyphs** — they may keep ad hoc Y until a follow-up. Expect a **transitional period** where composite dots and some event markers can still overlap; track as **follow-up todo** `event-glyphs-stack-followup` (not a blocker for shipping lane + dots).
4. **Further overlays** (e.g. trendlines, extra badges) — **`yHigh - 3 * OVERLAY_STACK_STEP`** or higher tiers as needed; new features must extend this ladder, not invent ad hoc offsets.

**Z-order (commit to code structure, then verify):** implement as **explicit paint phases** in [`drawPriceChart`](src/render/priceChart.js) (comments or a short internal ordered list). **Intended order:**

1. Background / grid  
2. Session dividers (if any)  
3. Candles + wicks (price pane)  
4. **Regime lane** (17px band between price and volume)  
5. Volume histogram  
6. **Composite dots** (last among bar markings so dots are not occluded by wicks — if a phase must merge, dots draw **after** candle bodies/wicks for that bar’s column)

**Post-implementation verification:** manually check a **tall green bar** and a **long upper wick** — composite dot must remain visible (adjust phase if dot disappears behind ink). Document the final draw sequence in `requirements.md` to match the code.

**Deferred:** align existing event glyph **y** to tier 2 in a separate change — see todo `event-glyphs-stack-followup`.

---

## 1) Persisted composite: `trade_context`

**Schema:** nullable `trade_context` VARCHAR on [`bars`](pipeline/src/orderflow_pipeline/db.py).

**Semantics** (stable tokens):

| Condition | `trade_context` |
|-----------|------------------|
| `jitter_regime == Low` AND `conviction_regime == High` | `favorable` |
| `jitter_regime == High` AND `conviction_regime == Low` | `avoid` |
| `jitter_regime == High` AND `conviction_regime == High` | `watch` |
| Else | `neutral` |

**NULL / warmup handling (explicit):**

- Any **NULL** `jitter_regime` or `conviction_regime` falls through to **`neutral`**.
- **Conflation (accepted):** `neutral` includes both (a) true mid/mid regime grid and (b) warmup / insufficient history. **No separate DB value** for “unknown vs mid” — **no dot** is the right non-actionable signal for both. Document this limitation in `requirements.md` (one sentence).

Implement stamping **after** [`stamp_velocity_regimes`](pipeline/src/orderflow_pipeline/velocity_regime.py) in CLI on **every** `aggregate` / `rebuild` run — **not** only in the migration script. New rows must get `trade_context` from ingest without a manual migration step.

**Acceptance check:** after this lands, run `aggregate` on a **small** raw sample (one session) and confirm `trade_context` is **non-null** for expected rows in DuckDB **before** running the one-shot backfill (backfill is for **existing** historical rows only).

Update [`Bar`](pipeline/src/orderflow_pipeline/aggregate.py), [`write_session`](pipeline/src/orderflow_pipeline/db.py), [`api/main.py`](api/main.py) `_bar_to_json_shape` with **`tradeContext`**.

**Tests:** mapping matrix + NULL → neutral.

---

## 2) Chart: lane + dots + remove full-height tint

In [`src/render/priceChart.js`](src/render/priceChart.js):

- Remove **full-height** `velocityJitterTint` strip (or gate it fully off / delete path).
- Reserve **17px** regime lane; draw jitter row + conviction row with locked palette.
- Draw composite dots using **exact** dot colors above; **`OVERLAY_STACK_STEP = 6`** for dot placement vs `yScale(high)`.
- **Do not** relocate event glyphs in this PR unless scope expands — follow-up `event-glyphs-stack-followup`.

Shared constants: prefer [`src/config/constants.js`](src/config/constants.js) for colors + stack step so legend HTML can reference the same tokens (or duplicate hex in legend once).

---

## 3) Tooltip (required — not ambiguous)

When hovering a bar (existing tooltip path in [`src/ui/tooltip.js`](src/ui/tooltip.js) / payload from [`priceChart.js`](src/render/priceChart.js) hit payload):

- Always show (when present on bar): **`pldRatio`**, **`flipRate`**, **`jitterRegime`**, **`convictionRegime`**, **`tradeContext`**.
- When **`velocityMatrixDev`** (or equivalent) toggle is **ON**, append **matrix cell `1–9`** computed client-side from `jitterRegime` + `convictionRegime` (same ordering as notes matrix). **No on-chart persistent 1–9 labels.**

---

## 4) Toggles and defaults

[`src/state.js`](src/state.js) / [`orderflow_dashboard.html`](orderflow_dashboard.html):

- **OFF default:** `velocityJitterTint`, `velocityConvictionBorder`.
- **ON default:** `velocityRegimeLane`, `tradeContextDots`.
- **OFF default:** `velocityMatrixDev` — affects **tooltip-only** cell index + a **legend hint line** (e.g. “Dev: matrix cell # in tooltip when hovering bars”). That hint must **respect toggle state**: use the same pattern as other overlay buttons — when **off**, apply **`is-off`** / muted styling so the line reads disabled; when **on**, full legend text color so users see the toggle does something (reuse `bindChartOverlayLegendToggles` / `syncButtonStates` behavior from [`src/main.js`](src/main.js)).

---

## 5) Legend

- Two swatch rows **Jitter Low/Mid/High** + **Conviction Low/Mid/High** using lane muted colors.
- One row for **composite dots** (three colored dots + “no marker = neutral”).
- **Dev matrix** explanatory text tied to `velocityMatrixDev` toggle + visual **on/off** state (see §4).
- Update/remove old velocity tint/border buttons per clutter preference (optional: label “Advanced”).

---

## 6) Backfill (committed path)

1. **Ship a one-shot migration** (e.g. [`scripts/migrate_trade_context.py`](scripts/migrate_trade_context.py) or `pipeline` CLI `migrate-trade-context`) that runs:

   `UPDATE bars SET trade_context = <computed from jitter_regime, conviction_regime> WHERE trade_context IS NULL`

   Use the **same** labeling function as ingest (import from pipeline package or duplicate CASE in SQL — single source of truth preferred).

2. **Full `aggregate`/`rebuild`** remains for **fresh** ingests or full recomputation; **not** required for existing DBs once migration runs.

**Separation:** ingest path **always** stamps `trade_context`; migration **only** backfills legacy NULLs.

---

## 7) Documentation

[`requirements.md`](requirements.md): tokens, NULL/neutral conflation, palette table, `OVERLAY_STACK_STEP`, lane 17px, **numbered paint phases** (must match code), tooltip fields, dev tooltip-only, **legend hint styling** for dev toggle, migration script path, **follow-up** item for event glyph tier-2 alignment, transitional collision note until follow-up lands.
