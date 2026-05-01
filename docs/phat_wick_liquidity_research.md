# PHAT wick liquidity: definition, clamp, ring fill, and empirical follow-ups

Research brief derived from the codebase. For histograms on your DuckDB, run:

`python scripts/phat_wick_liquidity_distribution.py` (see `docs/cursor-prompt-wick-liquidity-histogram.md` for the full spec; default DB `data/orderflow.duckdb`, optional `--max-rows` to sample).

---

## 1. What “wick liquidity” is (and the clamp)

In `pipeline/src/orderflow_pipeline/phat.py`, liquidity is **not** a trade-count metric. It is a **volume share** on the wick side of the body.

The ratio is:

**volume in the outer half of the wick (toward the extreme) / total wick-side volume**

It defaults to `0.0` when there is no wick-side volume.

There **is** an explicit **`min(x, 1.0)`** (and floor at 0) via `_clamp01`:

```python
def _clamp01(x: float) -> float:
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    return x
```

**Natural range of the ratio before clamp:** It is `outer_total / total` on wick ticks, so it lies in **[0, 1]** whenever `total > 0`. It should not exceed 1; the clamp is defensive and for floating-point edge cases.

**Practical interpretation:**

- **Histogram pile-up at 1.00** is expected when **all** wick-side volume sits in the **outer half** of wick ticks (including the case of a **very short wick**: few tick levels, so the “outer half” captures everything).
- **Single-tick wicks:** If the wick spans a single tick, the outer half is that tick → `outer_total == total` → ratio **1.0** whenever there is volume there.

So “liquidity = 1” often reflects **wick geometry** (narrow wick in ticks), not necessarily “huge participation at the tip.”

---

## 2. What controls filled vs hollow rejection rings (ring fill)

Ring fill is **not** “liquidity > threshold” in isolation. In `src/render/priceChart.js`, `_phatRejectionRingFilled` does the following:

- **`rejectionType === 'absorption'`** → **always filled**
- **`rejectionType === 'exhaustion'`** → **filled only if** wick liquidity **on the rejection side** is **≥** `state.phatExhaustionRingLiquidityThreshold` (default **0.55** in `state.js`); otherwise **hollow** (background fill + colored stroke)

`rejection_type` in the pipeline is driven by **average volume near the extreme** vs **overall average bar volume** (not by liquidity alone): if `vol_ratio > 1.1` at the zone near the wick tip, the type is **absorption**, else **exhaustion**.

Tightening **ring fill** in the UI is usually about **`phatExhaustionRingLiquidityThreshold`** and/or changing absorption/exhaustion classification in Python—not the wick line thickness (which uses liquidity to modulate stroke width on the chart).

---

## 3. Empirical questions: what code already answers vs what needs data

| Question | From code | Needs data |
|----------|-----------|------------|
| Histogram of wick liquidity — pile-up at 1.00? | Expect **yes** for many bars with **short wicks** (often **1.0**). | **Histogram** from DB/API on `upper_wick_liquidity` / `lower_wick_liquidity` over a long sample. |
| For liquidity = 1.00, distribution of **wick trade counts** | Liquidity is a **volume ratio**, not trade count; the **bars** PHAT columns don’t carry per-wick trade counts. | Recompute from **tick/profile** payloads if stored, or use a proxy (e.g. wick span in ticks). |
| `min(x, 1)` clamp and natural range | **Yes** — `_clamp01`; ratio ∈ **[0, 1]** by construction. | Still useful to plot the empirical distribution **below** 1 to see mass near 0 vs mid vs 1. |

---

## 4. Practical way to get histograms (outside the app)

Use the same DuckDB as `scripts/diagnose_phat_fields.py` (`ORDERFLOW_DB_PATH`, default `data/orderflow.duckdb`). Example aggregation shape:

```sql
SELECT
  ROUND(upper_wick_liquidity::DOUBLE, 2) AS bin,
  COUNT(*) AS n
FROM bars
WHERE timeframe = '1m' AND upper_wick_liquidity IS NOT NULL
GROUP BY 1
ORDER BY 1;
```

For bars with liquidity ≈ 1.0, filter with `upper_wick_liquidity >= 0.999` (or exact equality allowing float noise) and join to tick/trade detail if you have it.

**Script:** `scripts/phat_wick_liquidity_distribution.py` (read-only) prints the tabular report + optional CSV; not part of the web app.

---

## 5. Bottom line

- There **is** a **`min(x, 1.0)`** clamp via `_clamp01`.
- The underlying ratio is already a **proportion in [0, 1]**; **mass at exactly 1.0** is structurally likely for **thin wicks**.
- **Filled exhaustion rings** require side liquidity **≥ default 0.55** **and** exhaustion classification; absorption fills regardless at default thresholds.

See also: `phat-candle-research-plan.md` at repo root and requirements §7.1 for UI contract language.
