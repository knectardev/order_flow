# PHAT Candle Research Plan

A staged roadmap from current prototype to first descriptive cluster analysis, with development checkpoints sized for individual Cursor sessions.

## Scope

This plan covers eight phases from UI integration through first HDBSCAN contingency results. It deliberately stops short of:

- Sequence (n-gram) analysis over cluster labels
- Forward-return / predictive modeling
- Reverse direction (candle → regime) classification
- UI integration of cluster analysis results

Those are downstream of having descriptive cluster results in hand. Re-evaluate scope after Phase 8.

## Architectural Principles

A few decisions that span every phase:

- **Log everything, derive nothing prematurely.** Every candle gets full features stored regardless of whether it looks "interesting." Filtering is an analysis-time decision.
- **Single-candle is the atomic unit.** Sequences are derived at query time via window functions, never materialized as their own rows.
- **Storage holds raw features.** Normalization (ATR-scaling, z-scoring, etc.) is an analysis decision applied at query time, not baked into storage.
- **Each phase produces an independently inspectable artifact.** Don't build phase N before phase N-1's output looks right.
- **Offline analysis lives in version-controlled notebooks.** Methodology must be auditable and reproducible.

---

## Phase 1 — PHAT Candle Rendering Mode (UI)

**Goal:** Toggleable PHAT candle visualization in the existing chart, alongside standard candlesticks.

### Checkpoint 1.1 — Feature extraction function

Pure function, no side effects: given a candle's underlying trades (and order book state if needed for liquidity weighting), return a feature dict.

- Inputs: list of trades for the candle window, optional order book snapshots
- Outputs: `{top_cvd, bottom_cvd, upper_wick_liquidity, lower_wick_liquidity, body_size, total_volume, ...}`
- Unit tests against synthetic trade sequences with known expected outputs

**Done when:** function passes unit tests covering edge cases (empty trades, all-buy, all-sell, single-print bars).

### Checkpoint 1.2 — Wire features into chart data pipeline

Compute PHAT features alongside OHLCV in whatever pipeline currently feeds the chart.

**Done when:** every rendered candle has feature data attached and visible in dev tools / logs.

### Checkpoint 1.3 — PHAT rendering component

The visual itself: split-body shading driven by top/bottom CVD, circle wick tips driven by liquidity weighting.

- Match the prototype design (`IMG_1875.jpeg` reference)
- Filled vs hollow circle convention for liquidity met vs thin
- Render against existing chart axes / scaling

**Done when:** PHAT candles render correctly in isolation on a static dataset.

### Checkpoint 1.4 — Mode toggle integration

State management for "standard candles" vs "PHAT candles" mode, toggle UI control, persistence of preference.

- Toggle placement: alongside the existing 1m / 15m / 1h timeframe selector
- All existing overlays (POC, VAH, VAL, VWAP, event markers) continue to function in PHAT mode

**Done when:** user can flip between modes mid-session without page reload, all overlays intact.

### Checkpoint 1.5 — Density and contrast calibration

Visual stress-test at 1m (390 RTH bars), 15m, and 1h zoom levels.

- Calibrate split-shade contrast: readable but not louder than green/red direction
- Decide level-of-detail behavior if PHAT becomes unreadable at high density (fallback to standard, or reduced detail PHAT)
- Verify wick-tip circles don't visually collide

**Done when:** PHAT mode is comfortably readable at every supported timeframe.

---

## Phase 2 — Offline Feature Extraction Pipeline

**Goal:** Populate `phat_candles` table in DuckDB with historical features.

### Checkpoint 2.1 — DuckDB schema

Create the `phat_candles` table with the full feature schema.

```
phat_candles (
  timestamp        TIMESTAMP,
  symbol           VARCHAR,
  timeframe        VARCHAR,
  open, high, low, close, volume,
  top_cvd, bottom_cvd,
  upper_wick_ratio, lower_wick_ratio,
  upper_wick_liquidity, lower_wick_liquidity,
  body_size, total_volume,
  -- additional raw features as defined in 1.1
  PRIMARY KEY (symbol, timeframe, timestamp)
)
```

**Done when:** schema is created, indexed, and documented.

### Checkpoint 2.2 — Databento ingestion script

Pull historical trades for the chosen scope (recommend: ES 1m, RTH only, 1–3 months).

- Use trades feed (sufficient for CVD); decide whether MBO is needed for liquidity weighting based on Phase 1 implementation
- Store raw trades in a staging table or Parquet for reuse

**Done when:** ingestion completes for the target window and trade counts match Databento's expected volumes for ES.

### Checkpoint 2.3 — Batch feature extraction

Run the Phase 1 feature extraction function in batch mode over the ingested trades, populating `phat_candles`.

- Reuse the *same* function from Checkpoint 1.1 — do not reimplement
- Process in chunks to keep memory bounded

**Done when:** `phat_candles` table is populated for the target window with no nulls in feature columns.

### Checkpoint 2.4 — Validation against live chart

Spot-check ~20 candles: pull from `phat_candles`, compare to what the live chart renders for the same timestamps.

**Done when:** offline and online feature values match within floating-point tolerance.

---

## Phase 3 — Regime Label Persistence

**Goal:** Historical regime labels stored in a queryable table.

### Checkpoint 3.1 — Regimes table schema

```
regimes (
  timestamp        TIMESTAMP,
  symbol           VARCHAR,
  timeframe        VARCHAR,
  volatility_bucket  VARCHAR,  -- Quiet, Steady, Active, Impulsive, Climactic
  depth_bucket       VARCHAR,  -- Thin, Light, Normal, Deep, Stacked
  certainty         FLOAT,
  detector_version  VARCHAR,
  PRIMARY KEY (symbol, timeframe, timestamp, detector_version)
)
```

The `detector_version` column matters — when the regime detector evolves, you want to preserve old labels for backtest integrity.

**Done when:** schema is created and detector version conventions are documented.

### Checkpoint 3.2 — Detector → table adapter

Wrap the existing regime detector so it can run in batch mode and write to the `regimes` table.

**Done when:** running the detector against historical candles produces correctly populated regime rows.

### Checkpoint 3.3 — Backfill

Run the adapter over the same historical window as Phase 2.

**Done when:** every candle in `phat_candles` has a corresponding row in `regimes` for the same timestamp.

---

## Phase 4 — Observation Table

**Goal:** Single queryable surface joining candles and regimes.

### Checkpoint 4.1 — Join definition

Decide between materialized table vs view. Recommend materialized for analysis speed and to lock in regime labels at a specific detector version.

```
phat_candle_observations (
  timestamp, symbol, timeframe,
  -- all phat_candles feature columns
  -- all regimes columns
  PRIMARY KEY (symbol, timeframe, timestamp, detector_version)
)
```

**Done when:** schema is defined and the materialization query is written.

### Checkpoint 4.2 — Populate observations table

Run the join, materialize the result.

**Done when:** observations table has expected row count (matches `phat_candles` row count for the chosen detector version).

### Checkpoint 4.3 — Integrity checks

- No orphan candles (every candle has a regime label)
- No duplicate (timestamp, symbol, timeframe, detector_version) rows
- Certainty distribution looks reasonable (not all 1.0, not all 0.0)
- Regime bucket distribution looks reasonable (not all in one cell)

**Done when:** all integrity checks pass and results are documented in a notebook.

---

## Phase 5 — Marginal Distribution Sanity Check

**Goal:** Confirm that PHAT features actually vary across regimes before committing to clustering.

### Checkpoint 5.1 — Global feature distributions

Notebook with histograms of each feature over all observations. Check for sensible ranges, expected skew, no surprise null clusters or saturation at boundaries.

**Done when:** every feature has been visually inspected and any anomalies are documented.

### Checkpoint 5.2 — Per-regime small multiples

For each feature, produce a 5×5 grid of histograms (one per regime cell). Twenty-five panels per feature.

**Done when:** small-multiples grids exist for every feature and have been visually inspected.

### Checkpoint 5.3 — Variation decision document

Short writeup: which features show meaningful variation across regimes, which don't, and what that implies for clustering. If a feature looks identical across all 25 cells, flag it for deprioritization.

**Done when:** decisions are documented and ready to inform Phase 6.

**Stop and reconsider** if most features show no variation — that's a sign the regime detector and the candle features are looking at orthogonal dimensions of the data, or that something is broken upstream. Don't proceed to clustering on a flat feature space.

---

## Phase 6 — Normalization Decisions

**Goal:** Strip out trivial scaling effects so clusters are defined by *shape*, not size.

### Checkpoint 6.1 — ATR computation

Compute ATR (or equivalent realized volatility measure) per candle and join to the observations table.

**Done when:** every observation row has an ATR value for the relevant lookback.

### Checkpoint 6.2 — Normalized feature columns

Add normalized variants:

- Body size / ATR
- Wick lengths / ATR
- CVD splits as fractions of total volume rather than raw values
- Other normalizations as the marginals suggest

Store these as additional columns rather than overwriting raw features.

**Done when:** normalized columns exist and are documented.

### Checkpoint 6.3 — Re-run marginals

Repeat Phase 5 with normalized features. Variation across regimes should now reflect *shape* differences rather than mechanical size differences.

**Done when:** normalized marginals are inspected and the feature set for clustering is finalized.

---

## Phase 7 — First HDBSCAN Pass

**Goal:** Initial cluster discovery on the normalized feature space.

### Checkpoint 7.1 — Feature matrix preparation

Build a numpy array of normalized features for clustering. Document which features are included and any further preprocessing (z-scoring, etc.).

**Done when:** the feature matrix is built, shape is verified, and there are no nulls.

### Checkpoint 7.2 — Initial run

Run HDBSCAN with default-ish parameters (`min_cluster_size=50` or so, scaled to dataset size). Inspect cluster count, cluster size distribution, noise point fraction.

**Done when:** HDBSCAN runs to completion and produces a sensible-looking cluster distribution (not 1 cluster, not 1000 clusters, noise fraction reasonable).

### Checkpoint 7.3 — Cluster visualization

PCA or UMAP projection of the feature space, colored by cluster label. Visual sanity check that clusters look like clusters.

**Done when:** the projection plot exists and clusters are visually plausible.

### Checkpoint 7.4 — Hyperparameter sweep

Vary `min_cluster_size` and `min_samples` across a small grid. Pick a configuration that produces interpretable cluster counts (rough target: 8–20 clusters for an initial pass).

**Done when:** chosen hyperparameters are documented with rationale.

---

## Phase 8 — Cluster × Regime Contingency

**Goal:** First descriptive result — which candle clusters appear disproportionately in which regimes.

### Checkpoint 8.1 — Contingency table

Build the cluster × regime cross-tabulation. Both raw counts and row-normalized / column-normalized variants.

**Done when:** the contingency table exists and is reviewable.

### Checkpoint 8.2 — Statistical residuals

Compute standardized residuals per cell to identify over- and under-representation relative to base rates. Optionally a chi-squared test for overall independence.

**Done when:** residuals are computed and the most-deviating (cluster, regime) cells are identified.

### Checkpoint 8.3 — Results writeup

Short notebook: which clusters are regime-distinctive, which are diffuse across regimes, and what the cluster centroids look like in human-readable terms ("cluster 7 is high-CVD-top, long-upper-wick, thin-upper-liquidity").

Also include the orthogonality check we discussed: residual variance after partialing out volatility and depth from the candle features. This tells you how much independent information the candles carry beyond the regime axes.

**Done when:** writeup exists and the descriptive picture is clear enough to decide whether sequence and predictive analysis are worth pursuing.

---

## Re-Evaluate After Phase 8

If clusters show meaningful regime conditionality and carry independent information beyond volatility/depth, proceed to sequence analysis and forward-return modeling. If they don't, the foundation is still valuable — it tells you what *not* to build, and the PHAT candle visualization mode stands on its own.
