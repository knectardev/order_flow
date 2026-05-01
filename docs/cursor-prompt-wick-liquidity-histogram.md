# Cursor Prompt: PHAT Wick Liquidity Distribution Analysis

Read this prompt and produce a small standalone analysis script. This is a diagnostic, not a feature—the goal is to characterize the empirical distribution of wick liquidity readings in the existing dataset so we can decide whether (and how) to refine the metric.

## Background

The wick liquidity metric (defined in `pipeline/src/orderflow_pipeline/phat.py`) is a volume share: the fraction of wick-side volume that occurs in the outer half of the wick (toward the extreme) versus the inner half (toward the body). It's clamped to [0, 1] via `_clamp01`.

There's a suspected geometry artifact: short wicks (1–2 ticks) will trivially produce liquidity = 1.00 because the "outer half" contains all of the wick volume by definition. This makes the 1.00 reading meaningless for short wicks but meaningful for long ones, and the current encoding doesn't distinguish the two cases. Before designing fixes, we need to know how prevalent the artifact actually is.

## Goal

Build a script that produces a clear empirical picture of:

1. The overall distribution of wick liquidity readings across a representative sample of bars.
2. The relationship between wick length (in ticks) and liquidity reading.
3. The fraction of liquidity = 1.00 readings that are attributable to short-wick geometry vs long-wick concentration.

## Deliverable

A new script at `scripts/phat_wick_liquidity_distribution.py`, runnable from the repo root, that:

1. Connects to the DuckDB at `ORDERFLOW_DB_PATH` (default `data/orderflow.duckdb`).
2. Reads bars with non-null `upper_wick_liquidity` or `lower_wick_liquidity` from the `bars` table. Default to `timeframe='1m'` but allow timeframe as a CLI argument.
3. Computes wick length in ticks per bar. The pipeline should already have what it needs to derive this—high minus close (or open) for upper wick, lower wick analogously, divided by tick size. If wick length isn't directly stored, compute from OHLC. Use the symbol's tick size from configuration.
4. Outputs four things to stdout in a clean tabular format:

   **A. Overall liquidity distribution.** Histogram with 20 bins from 0 to 1, showing count and percentage per bin. Show upper and lower wick liquidity separately. Include explicit counts at exactly 0.0 and exactly 1.0 since those endpoints are analytically interesting.

   **B. Wick length distribution.** Histogram of wick lengths in ticks, separately for upper and lower wicks. Truncate at, say, 20 ticks with an "20+" overflow bucket.

   **C. Conditional distribution: liquidity given wick length.** A 2D table showing, for each wick-length bucket (1 tick, 2 ticks, 3–5 ticks, 6–10 ticks, 11+ ticks), the distribution of liquidity readings (mean, median, % at exactly 1.0, % above 0.55 threshold). This is the core diagnostic—it should immediately reveal whether short-wick bars are responsible for most 1.00 readings.

   **D. Summary statistics.** Total bars analyzed; fraction of bars with liquidity = 1.0; of those, fraction that are short-wick (≤2 ticks); fraction of bars currently classified as filled-circle exhaustion (liquidity ≥ 0.55) that are short-wick artifacts.

5. Optional but recommended: write a CSV alongside stdout output (e.g., `data/phat_wick_liquidity_analysis.csv`) so we can inspect or chart later.

## CLI signature

```
python scripts/phat_wick_liquidity_distribution.py \
  [--db-path data/orderflow.duckdb] \
  [--timeframe 1m] \
  [--symbol ES] \
  [--session-date YYYY-MM-DD or "all"] \
  [--csv-out data/phat_wick_liquidity_analysis.csv]
```

Default to all sessions, all symbols if not specified.

## Constraints

- Read-only against the DB. Never write to `bars` or any aggregation table.
- No new pipeline code, no schema changes, no UI changes. This is purely a diagnostic script.
- Should run in well under a minute on a typical session-week of 1m data. If it's slow, sample rather than processing every bar.
- Output should be readable in a terminal—use simple ASCII tables or aligned columns, not graphical histograms.

## Out of scope

- Any fix or reformulation of the wick liquidity metric. That's a separate decision after we see the data.
- Filtering, capping, or reweighting the metric. Pure observation only.
- UI changes or tooltip changes.

## Deliverable format

Just the script. No plan needed for this one—it's small enough to implement directly. If you encounter ambiguity about how wick length should be derived from the existing schema, ask before proceeding rather than guessing.

Once the script is built and I've run it, we'll review the output and decide on next steps (which may include a follow-up plan for metric refinement).

---

## Implementation status

Delivered as `scripts/phat_wick_liquidity_distribution.py`. The `bars` table has no `symbol` column; `--symbol` is accepted but ignored with a stderr note. Wick length uses `round(price/tick_size)` for body high/low and high/low (same convention as `phat.py`).
