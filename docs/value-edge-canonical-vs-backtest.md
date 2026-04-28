# Value Edge: Canonical Signals vs Backtest Trades

Date: 2026-04-28  
Scope: `valueEdgeReject` only

## Executive Summary

The observed discrepancy is primarily caused by **different signal-generation paths**:

- Canonical chart signals are produced in frontend analytics (`evaluateValueEdgeReject`).
- Backtest runs analyzed here used backend `signalSource = "fallback"` (not DB `fires` and not frontend canonical).
- Backtest then applies execution constraints (single-position, flips, end-of-window flatten), so not every fire becomes a distinct trade.

For the latest Value Edge pair, backtest entries are internally consistent with its own fire stream (every entry aligns to a fallback fire timestamp), but that stream is not the same as canonical.

## Latest Value Edge Run Comparison (Observed)

From the latest two `watch_ids = ['valueEdgeReject']` runs:

- `6e3ad981-9eec-4657-a0e8-7d5b9e18511f` (regime ON)
  - `signalSource`: `fallback`
  - `fires`: `1433`
  - `trades`: `670`
  - `entry_in_fires`: `670 / 670` (all entries match fallback fire timestamps)
  - `fires_unused`: `763`
- `b5cbcda2-47e1-4376-b9d1-ac02670258c4` (regime OFF)
  - `signalSource`: `fallback`
  - `fires`: `2602`
  - `trades`: `1163`
  - `entry_in_fires`: `1163 / 1163` (all entries match fallback fire timestamps)
  - `fires_unused`: `1439`

Interpretation:

1. Backtest marker placement is consistent with backtest signal input.
2. Regime OFF loosens gates and increases fallback signal density substantially.
3. Canonical-vs-backtest mismatch remains expected until both use a unified signal source.

## Relevant Code Samples

### 1) Backtest fallback Value Edge generation

`pipeline/src/orderflow_pipeline/backtest_engine.py`

```python
# Value Edge Reject proxy:
#   - probe prior 10-bar extreme
#   - close back inside prior range
#   - rejection wick shape
#   - normal (not spike) participation
if (watch_ids is None) or ("valueEdgeReject" in watch_ids):
    vol_ratio = vol / avg_vol if avg_vol > 0 else 1.0
    normal_vol = 0.8 <= vol_ratio <= 1.2
    close_inside = recent_low < close < recent_high
    upper_reject = (
        high >= recent_high and
        close_inside and
        (high - close) > max(0.0, close - open_)
    )
    lower_reject = (
        low <= recent_low and
        close_inside and
        (close - low) > max(0.0, open_ - close)
    )
    vol_ok = normal_vol if use_regime_filter else True
    if vol_ok and upper_reject:
        if can_emit("valueEdgeReject", "down", i):
            emit("valueEdgeReject", "down", close, i)
    elif vol_ok and lower_reject:
        if can_emit("valueEdgeReject", "up", i):
            emit("valueEdgeReject", "up", close, i)
```

### 2) Backtest direction mapping for Value Edge (mean reversion)

`pipeline/src/orderflow_pipeline/backtest_engine.py`

```python
@staticmethod
def _signal_side(watch_id: str, direction: str | None) -> int | None:
    if direction not in {"up", "down"}:
        return None
    if watch_id == "breakout":
        return 1 if direction == "up" else -1
    if watch_id in {"fade", "valueEdgeReject", "absorptionWall"}:
        return -1 if direction == "up" else 1
    return None
```

### 3) Backtest source selection + execution model

`pipeline/src/orderflow_pipeline/backtest_engine.py`

```python
fires_by_time = self._load_fires(timeframe, from_time, to_time, watch_ids=watch_ids)
used_fallback = False
if not fires_by_time:
    fires_by_time = self._derive_fires_from_bars(
        bars,
        watch_ids=watch_ids,
        use_regime_filter=use_regime_filter,
    )
    used_fallback = True

for idx, bar in enumerate(bars):
    ts = bar["bar_time"]
    fire_batch = fires_by_time.get(ts, [])
    for fire in fire_batch:
        side = self._signal_side(fire["watch_id"], fire.get("direction"))
        if side is None:
            continue
        if not broker.has_open_position():
            broker.open_position(ts, _safe_float(fire.get("price"), _safe_float(bar.get("close"))), side, fire["watch_id"], idx)
            continue
        if broker.position and broker.position.side != side:
            broker.close_position(ts, _safe_float(fire.get("price"), _safe_float(bar.get("close"))), "flip", idx)
            broker.open_position(ts, _safe_float(fire.get("price"), _safe_float(bar.get("close"))), side, fire["watch_id"], idx)
    broker.mark_to_market(ts, _safe_float(bar.get("close")))
```

### 4) Backtest metadata proving source + regime mode

`pipeline/src/orderflow_pipeline/backtest_engine.py`

```python
"metadata_json": json.dumps(
    {
        "bars": len(bars),
        "fires": sum(len(v) for v in fires_by_time.values()),
        "watch_ids": sorted(watch_ids) if watch_ids else ["all"],
        "fire_source": "fallback" if used_fallback else "db",
        "use_regime_filter": bool(use_regime_filter),
    }
),
```

### 5) Canonical Value Edge logic (frontend)

`src/analytics/canonical.js`

```javascript
function evaluateValueEdgeReject() {
  const checks = { regime: false, failedAtEdge: false, rejectionWick: false, volume: false, alignment: false };
  let direction = null;
  let edge = null; // 'vah' | 'val'

  if (state.regimeWarmup) {
    return { checks, passing: 0, total: 5, fired: false, direction: null, edge: null, anchorPrice: null,
             alignment: null, tag: null };
  }

  const t = getTunings();
  const vMinM = t.valueRejectVolMinMult ?? SYNTH_TUNINGS.valueRejectVolMinMult ?? 0.8;
  const vMaxM = t.valueRejectVolMaxMult ?? SYNTH_TUNINGS.valueRejectVolMaxMult ?? 1.2;

  checks.regime = isValueEdgeRejectRegime(state.sim.volState, state.sim.depthState);
  // ... VAH/VAL failed-edge tests, wick test, volume-band test ...
  const alignment = lastBar && direction
    ? buildAlignment(lastBar, direction, 'fade')
    : null;
  checks.alignment = !!alignment && alignment.vote_1h >= 0;

  const passing = Object.values(checks).filter(Boolean).length;
  const fired = passing === 5;
  return { checks, passing, total: 5, fired, direction, edge, anchorPrice, alignment, tag };
}
```

### 6) Canonical duplicate suppression/cooldown

`src/analytics/events.js`

```javascript
function isCanonicalFireRepeatTooSoon(watchId, direction, barTime, existingFires, indexSource, cooldownBars, sessionStartIdx = null) {
  if (cooldownBars <= 0 || direction == null) return false;
  const idx = _barIndexForTime(indexSource, barTime);
  if (idx < 0) return false;
  for (let i = existingFires.length - 1; i >= 0; i--) {
    const f = existingFires[i];
    if (f.watchId !== watchId || f.direction !== direction) continue;
    const pidx = _barIndexForTime(indexSource, f.barTime);
    if (pidx < 0) continue;
    if (sessionStartIdx != null && pidx < sessionStartIdx) continue;
    if (idx > pidx && idx - pidx < cooldownBars) return true;
    break;
  }
  return false;
}
```

## Bottom Line

For Value Edge, the large difference is currently expected and explainable:

- **Canonical fires** and **backtest fires** are not sourced from identical logic.
- The analyzed runs are **fallback-derived** on the backend.
- Backtest trade lifecycle further transforms signal counts into fewer executed trades.

To fully close the gap, both chart and backtest must consume the same persisted fire stream or the same shared signal engine.

## Execution engine (stop / take-profit)

The backtest broker can evaluate **stop-loss** and **take-profit** barriers on each bar (OHLC) in addition to signal flips. That path is independent of whether chart and fallback signal sources agree: it changes which equity path and Sharpe you should expect when comparing runs. Flip-only histories (no SL/TP ticks configured) remain the backward-compatible baseline for strict parity checks.
