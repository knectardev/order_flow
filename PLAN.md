# PHAT wick-length gate + ticks columns (implemented)

## Empirical anchor (1m sample, `data/phat_wick_liquidity_analysis.csv`)

| Finding | Numbers |
|--------|---------|
| Bars analyzed | **22,440** |
| Upper liquidity ~1.0 | **~17.8%** |
| 1-tick upper wicks | **100%** liquidity 1.0 in bucket |
| 2-tick upper | **~0%** at 1.0 |
| Proxy “filled exhaustion” (exhaustion + liq ≥ 0.55) | **~90%** rejection-side wick ≤ 2 ticks |

Short-wick geometry dominates bogus high liquidity and inflated filled exhaustion disks.

## Absorption pre-check (script §E) — outcome and “asymmetry”

Run `python scripts/phat_wick_liquidity_distribution.py`. Section **E** compares rejection-side wick length for **absorption** vs **exhaustion**. **Decision shipped:** with default `phatGateAbsorptionRingsByWickLength: true`, absorption uses the **same wick-length gate** as exhaustion for **fill vs hollow**, but **absorption still has no wick-liquidity threshold** (unlike exhaustion, which also needs `phatExhaustionRingLiquidityThreshold`). So screenshots that show **exhaustion · open ring** with **0.00** liquidity and **absorption · filled** with **0.09** liquidity and **2 ticks** are **consistent with the spec** — the wick gate passes (≥ **2**), and only exhaustion is liquidity-gated.

## Zero-wick guard (rejection side)

Rejection **detection** (retreat × prints near extreme) is independent of geometric wick length, so the pipeline could label **high** with **upper_wick_ticks == 0**. **Rule:** if the chosen side’s geometric wick span is **0** ticks, clear **`rejection_side` / strength / type** in `phat.py`. The chart mirrors this so OHLC-only payloads do not show a ring at the body edge with “0 ticks” copy.

## Defaults

| Setting | Value | Rationale |
|---------|-------|-----------|
| `phatMinWickTicksForRingFill` | **2** | Data breaks at **1-tick vs 2+**; N=2 removes 1-tick artifacts without dropping 2-tick bars. |
| `phatGateAbsorptionRingsByWickLength` | **true** | Symmetric gate when absorption shows parallel length skew (see §E). Set **false** only if pre-check shows materially fewer short-wick absorptions. |

## Behavior / UX

Filled rings **drop sharply** after deploy — mostly former **one-tick** false fills. **Not a regression:** classification unchanged; only fill-vs-hollow rendering tightened.

**Release blurb:** Filled **exhaustion** circles need side liquidity ≥ threshold **and** wick span ≥ **N**; filled **absorption** circles use **wick span ≥ N** only (when absorption gating is on), not liquidity. Many previously filled **exhaustion** rings were one-tick liquidity artifacts.

## Implementation map

- **Pipeline:** [`pipeline/src/orderflow_pipeline/phat.py`](pipeline/src/orderflow_pipeline/phat.py) — `upper_wick_ticks`, `lower_wick_ticks`; [`aggregate.py`](pipeline/src/orderflow_pipeline/aggregate.py); [`db.py`](pipeline/src/orderflow_pipeline/db.py) schema + insert; [`api/main.py`](api/main.py) camelCase.
- **UI:** [`src/state.js`](src/state.js); [`src/render/priceChart.js`](src/render/priceChart.js) `_phatRejectionRingFilled`; [`src/ui/tooltip.js`](src/ui/tooltip.js); [`orderflow_dashboard.html`](orderflow_dashboard.html) PHAT modal.
- **Diagnostics:** [`scripts/phat_wick_liquidity_distribution.py`](scripts/phat_wick_liquidity_distribution.py) §E; [`scripts/backfill_phat_from_profiles.py`](scripts/backfill_phat_from_profiles.py) updates tick columns.
- **Docs:** [`requirements.md`](requirements.md) §7.1.

## Migration

1. Deploy code + API.
2. Run **`init_schema`** (or app startup that calls it) so DuckDB gets **`upper_wick_ticks` / `lower_wick_ticks`** (`ALTER ... IF NOT EXISTS`).
3. **Re-aggregate** sessions or run **`scripts/backfill_phat_from_profiles.py`** so historical bars populate ticks (OHLC fallback works for live edge without DB columns, but stored bars should be backfilled for consistency).

## Tests

- [`pipeline/tests/test_phat.py`](pipeline/tests/test_phat.py)
- [`pipeline/tests/test_aggregate.py`](pipeline/tests/test_aggregate.py) golden snapshot regenerated.

## Calibration (optional)

After backfill, re-run the histogram script and tune **`phatMinWickTicksForRingFill`** or **`phatExhaustionRingLiquidityThreshold`** if fill density is too low.
