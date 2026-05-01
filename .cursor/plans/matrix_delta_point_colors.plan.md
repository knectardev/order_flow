# Delta-colored regime matrix point cloud (revised)

## Overview

Color regime-matrix point fills by per-bar **aggressor delta** sign (green / red) and **winsorized magnitude**, while keeping **volume-based radius**. This revision pins **neutral visibility**, **explicit HSL anchors**, **shared percentile constants**, and **chart vs matrix encoding** so implementation is not guesswork.

---

## Relationship to the price chart (encoding divergence)

- **Chart candles** (standard mode): body/wick colors follow **OHLC direction** — typically **close vs open** (bullish vs bearish bar), consistent with the existing price canvas.
- **Matrix point cloud**: dot **fill** follows **signed delta** (buy vs sell aggressor imbalance), **not** candle direction.

Therefore **the same bar can show a green candle and a red matrix point** (or the reverse) when **price and flow disagree** — e.g. close up on net selling. **This is intentional:** it surfaces **flow vs price** disagreement; it is not a rendering bug.

**Requirements doc addition (verbatim intent):** Chart candles are colored by **close direction** (standard candle semantics); matrix points are colored by **aggressor delta**. **Divergences between the two are intentional** and highlight disagreement between price action and cumulative aggressor imbalance for that bar.

---

## Neutral state: visibility (explicit targets)

**Problem:** A muted mid-gray on a dark matrix background, combined with **age opacity** (`POINT_MIN_OPACITY` ≈ 0.18 … `POINT_MAX_OPACITY` ≈ 0.95), can make neutral dots disappear.

**Targets:**

1. **Fill (neutral, full-opacity reference):** **`hsl(210, 12%, 64%)`** — cool gray, **lightness 64%**, enough separation from a near-black matrix chrome (~luminance similar to or slightly above the previous teal dot `rgba(33,160,149)` hue-adjusted for gray).
2. **Stroke (neutral):** **`hsl(210, 12%, 46%)`** — darker ring so the disk remains **edge-defined** even when fill is soft.
3. **Age fade:** Keep existing age multiplier on the **whole dot opacity** unchanged; neutral palette is chosen so that at **`POINT_MIN_OPACITY`** the combination of **stroke + fill** still reads as **“there is a point here”** — i.e. not indistinguishable from background (use stroke as the visibility backstop).
4. **Acceptance check (manual):** At minimum opacity, neutral dots remain visible in the **corner cells** of the matrix (darkest surround); adjust **neutral L** by ±2–3% only if QA fails.

---

## Signed magnitude: explicit HSL anchors (not vague “muted → vivid”)

Interpolate in **HSL per sign** between fixed anchors (saturation + lightness tuned for dark UI; **do not** RGB-lerp teal → green).

**Positive delta (green family, hue fixed ~142°):**

| Winsorized magnitude `t` | Saturation | Lightness | Notes |
|--------------------------|------------|-----------|--------|
| **Low** (`t → 0`) | **38%** | **52%** | Softer but still clearly green-tinted |
| **High** (`t → 1`) | **92%** | **48%** | Vivid but not neon clipping |

**Implementation:** `hsl(142, lerp(38, 92, t)%, lerp(52, 48, t)%)` — slight **darkening** at high magnitude improves contrast on black.

**Negative delta (red family, hue fixed ~4°):**

| Winsorized magnitude `t` | Saturation | Lightness |
|--------------------------|------------|-----------|
| **Low** (`t → 0`) | **42%** | **56%** |
| **High** (`t → 1`) | **93%** | **52%** |

**Implementation:** `hsl(4, lerp(42, 93, t)%, lerp(56, 52, t)%)`.

**Zero / missing / non-finite delta:** use **neutral** HSL above (no sign interpolation).

**Why HSL:** Perceptual mid-tones for “low `t`” stay distinguishable from neutral gray without washing out; extremes hit strong saturation without muddy RGB midpoint blending.

**Stroke:** For non-pulse dots, derive stroke from fill: lower **L** by ~12–16 points or use semi-transparent white/black overlay consistent with current `POINT_STROKE_COLOR` intent — keep contrast similar to today’s teal + dark stroke.

---

## Winsorization: p5/p95, justification, and shared constants

**Choice:** Use the **same percentile cutoffs as the volume ladder** (**p5–p95**) on **`abs(delta)`** over the **same loaded timeframe universe** as `getLoadedBarsForMatrixVolumeLadder()`.

**Justification:**

- **Consistency:** Volume radius and delta color both answer “how extreme is this bar **within the currently loaded timeline**?”
- **Delta shape differs from volume:** Volume is strictly positive and often right-skewed; **`|delta|` can have heavier tails** (news, imbalances). **p5/p95** remains a **sensible default** that limits one-off spikes from dominating saturation; **many bars near zero delta** still spread across the lower half of `t`.
- **Risk:** Extreme imbalance bars may **pile up at `t = 1`** after winsorizing — **acceptable** for v1; if QA shows “everything max saturation,” loosen HI percentile or switch to log(abs(delta)) ladder later.

**Configurability:** Define **`MATRIX_LADDER_LO_PCT`** and **`MATRIX_LADDER_HI_PCT`** in **one module** (e.g. new **`src/analytics/matrixLadderConstants.js`**, or the top of **`matrixVolumeRadiusNorm.js`** re-exported for delta). **`matrixVolumeRadiusNorm.js`** and **`matrixDeltaColorNorm.js`** both import these — **no duplicated 0.05/0.95 literals**.

---

## Implementation outline (unchanged structurally)

1. **`matrixDeltaColorNorm.js`:** `computeMatrixAbsDeltaLadder(bars)` using shared **`MATRIX_LADDER_*`**; `matrixDeltaFillAndStroke(bar, ladder)` returning `{ fill, stroke }` as **`hsl(...)` or `rgba`** from the anchors above.
2. **`matrix.js`:** One ladder per `_renderPointCloud()` pass; pass into `resolvePointStyle`; pulse branches unchanged (steady state only).
3. **`requirements.md`:** Matrix bullet + **chart vs matrix encoding** paragraph (see above).

---

## Testing

- Visibility: neutral dots at **minimum age opacity** in dark matrix corners.
- Divergence: **document** green candle + red point case in requirements; optionally screenshot for internal notes.
- Optional: histogram sanity — if >15% of bars peg `t === 1`, consider tuning **`MATRIX_LADDER_HI_PCT`**.
