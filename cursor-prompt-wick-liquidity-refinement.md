# Cursor Prompt: Wick Liquidity Metric Refinement Plan (Contingent)

**Read this only after the histogram analysis script has been run and we have empirical data on wick liquidity distribution.** This prompt is for producing a plan, not implementation, and the right plan depends on what the data shows.

## Context

The current wick liquidity metric (in `pipeline/src/orderflow_pipeline/phat.py`) is a volume share: fraction of wick-side volume in the outer half of the wick. It's used downstream to:

1. Classify rejection rings as filled vs hollow in the PHAT chart (threshold `state.phatExhaustionRingLiquidityThreshold`, default 0.55).
2. Modulate wick stroke width on the chart.
3. Surface in tooltips as a measurement.
4. Will eventually be used as a feature in the morphology classifier and base-rate detection work.

The suspected confound: short wicks (1–2 ticks) trivially produce liquidity = 1.00 because the "outer half" of a tiny wick contains all of its volume by definition. This entangles geometry (wick length in ticks) with the analytical signal (concentration of pressure at the extreme).

The histogram analysis from the prior script should have quantified how prevalent this artifact is.

## Goal

Produce a plan as `PLAN.md` that proposes a refinement to the wick liquidity metric, calibrated to what the histogram data showed. The plan should consider three response strategies and recommend one (or a combination) based on the empirical findings.

## Three candidate strategies for the plan to evaluate

**Strategy 1: Filter short wicks out of the metric.**
- Wicks below a minimum tick length (e.g., 3 ticks) get a null/neutral liquidity reading rather than a forced value.
- Downstream consumers (ring fill classification, ML features) treat null as "insufficient data to classify."
- Pros: Simplest fix. Preserves the existing metric definition for cases where it works. Minimal downstream code change—mostly handling nulls.
- Cons: Loses any information from short wicks entirely. If short wicks are common, this discards a lot of bars from the classification.

**Strategy 2: Reformulate the metric to be wick-length-aware.**
- Replace the current "outer-half share" with something like "weighted distance of wick volume from body, normalized by maximum possible distance for this wick length."
- Concretely: for each tick of wick volume, compute its distance from the body in ticks; divide the total by (wick length in ticks × total wick volume) to get a value in [0, 1] that means "average wick volume position as a fraction of wick length."
- Pros: Geometry-invariant by construction. A short wick and a long wick can produce the same liquidity reading if their pressure distributions are similar. Most analytically honest option.
- Cons: Larger pipeline change. Requires recomputing all PHAT data. Calibration of downstream thresholds (the 0.55 ring fill threshold) needs to be redone since the metric semantics change.

**Strategy 3: Surface wick length as a separate dimension and let consumers decide.**
- Keep the current liquidity metric unchanged. Add wick length (in ticks) as a separate field on each bar.
- Tooltip shows both: "liquidity 1.00, wick 1 tick" lets users interpret the geometry-driven case correctly. ML features can use both as inputs.
- Ring fill classification could be modified to require both liquidity ≥ threshold AND wick length ≥ minimum.
- Pros: Smallest change to underlying metric. Preserves existing data. Honest about the confound at the consumption layer rather than hiding it.
- Cons: Pushes complexity to every consumer. Easier for consumers to ignore the new dimension and inherit the artifact anyway.

## What the plan should include

1. **Reference to the histogram findings.** Quote the specific numbers that motivated the strategy choice. E.g., "Histogram showed 34% of bars produce liquidity = 1.00, of which 78% are short-wick artifacts. This makes Strategy X the right response because..."

2. **Recommended strategy** (one of the above, or a combination), with rationale grounded in the empirical data.

3. **For the recommended strategy, a detailed implementation plan covering:**
   - Files touched in the pipeline (`phat.py` and any related)
   - Schema changes if any (e.g., adding wick length column)
   - Downstream consumer impact: ring fill classification, tooltip display, requirements doc
   - Migration plan for cached data (likely a re-aggregation, similar to the session-anchored binning migration)
   - Test plan including a regression test that documents the new metric semantics

4. **Calibration step.** If the metric semantics change (Strategy 2 in particular), the existing 0.55 ring fill threshold may no longer mean what it meant before. The plan should include a calibration step: after refactor, examine the new distribution and pick a threshold that puts filled-circle classification at a sensible percentile (e.g., top 20–30% of clearly-not-artifact bars).

5. **Backwards compatibility consideration.** If existing analytical work or screenshots reference specific liquidity values under the old metric, those references will become stale. The plan should note what gets affected and how documentation should be updated.

## Out of scope for this plan

- ML morphology classifier work. That's downstream and depends on this metric being correct, but the classifier itself is a separate effort.
- Backtesting infrastructure for empirically validating threshold choices. That's a Phase 3 concern.
- Any UI redesign beyond what's needed to consume the refined metric (tooltip update, legend update).

## Deliverable

A `PLAN.md` that is implementable after my approval. The plan should be tight enough that I can read it in 5 minutes and either approve or push back with specific concerns.

If the histogram data turns out to show that the artifact isn't actually a significant problem (e.g., short-wick 1.00 readings are <5% of all bars), the plan should say so and recommend doing nothing rather than fabricating a fix for a non-problem. Honest "no change needed" is a valid output.
