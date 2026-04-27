// Phase 6 directional-bias ribbon.
//
// Two thin colored strips drawn above the candle pane that visualize the
// higher-timeframe bias context behind every visible 1m / 15m bar:
//
//   ┌────────────────────────────────────────────┐
//   │ 1h-bias strip   (full width, top)          │  <- biasH1 per slot
//   │ 15m-bias strip  (full width, bottom)       │  <- bias15m per slot
//   ├────────────────────────────────────────────┤
//   │   ... candles + volume profile ...         │
//
// On 1h timeframe the ribbon collapses to a single 1h strip (the bar's
// own bias_state) since 1h has no parents. On 15m the bottom strip is
// elided (only biasH1 is meaningful). On 1m both strips render.
//
// Color palette (matches the BIAS_VOTE table in canonical.js):
//   BULLISH_STRONG : deep green     +2
//   BULLISH_MILD   : light green    +1
//   ACCUMULATION   : teal/mint      +1 (Wyckoff anomaly bull side)
//   NEUTRAL        : neutral grey    0
//   DISTRIBUTION   : amber          -1 (Wyckoff anomaly bear side)
//   BEARISH_MILD   : light red      -1
//   BEARISH_STRONG : deep red       -2
//   <missing/null> : transparent (renders as background)
//
// The ribbon is purely informational — `state.biasFilterMode` controls
// whether 1h-opposes fires get suppressed; the ribbon always paints so
// the user can read HTF context at a glance regardless of mode.

const BIAS_PALETTE = {
  BULLISH_STRONG: '#0e7d4f',
  BULLISH_MILD:   '#3aa776',
  ACCUMULATION:   '#3fb6a3',
  NEUTRAL:        '#5b6470',
  DISTRIBUTION:   '#d39145',
  BEARISH_MILD:   '#c45a5a',
  BEARISH_STRONG: '#933030',
};

function _colorFor(bias) {
  if (!bias) return null;
  return BIAS_PALETTE[bias] || null;
}

// Public draw entrypoint. Caller (priceChart.js) supplies geometry that
// matches the candle pane so each slot column maps 1:1 to a candle:
//
//   ctx       - 2D canvas context (priceCanvas's pctx)
//   bars      - viewedBars array (same array used to draw candles)
//   geom      - { x: leftEdge, slotW, top, height, activeTimeframe }
//
// `top` is the y-coord of the top of the upper strip; `height` is the
// total ribbon height (split evenly between the two strips when both
// are drawn). `activeTimeframe` selects the rows-to-draw layout.
//
// Returns the chartHits-style entries for hover support (one per
// drawn slot per strip): callers can concat them onto state.chartHits
// so the existing tooltip subsystem picks them up. We return rather
// than mutate so the caller controls list ownership.
function drawBiasRibbon(ctx, bars, geom) {
  const hits = [];
  if (!bars || bars.length === 0) return hits;
  const { x, slotW, top, height } = geom;
  const tf = geom.activeTimeframe || '1m';

  // Layout:
  //   1m  -> two strips: biasH1 (top), bias15m (bottom)
  //   15m -> single strip: biasH1 (full height)
  //   1h  -> single strip: biasState  (the 1h bar's own bias)
  let stripPlan;
  if (tf === '1m') {
    const h2 = Math.max(2, Math.floor(height / 2) - 1);
    stripPlan = [
      { y: top,                     h: h2, key: 'biasH1',    label: '1h'  },
      { y: top + h2 + 1,            h: h2, key: 'bias15m',   label: '15m' },
    ];
  } else if (tf === '15m') {
    stripPlan = [
      { y: top, h: height, key: 'biasH1', label: '1h' },
    ];
  } else if (tf === '1h') {
    stripPlan = [
      { y: top, h: height, key: 'biasState', label: '1h (self)' },
    ];
  } else {
    stripPlan = [
      { y: top, h: height, key: 'biasH1', label: '1h' },
    ];
  }

  // Background washes for each strip — even when most slots are
  // transparent (warmup rows), the strip's footprint stays visible so
  // the user can see "the ribbon is here, just empty right now".
  ctx.save();
  for (const strip of stripPlan) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(x, strip.y, slotW * bars.length, strip.h);
  }

  // Per-slot fills. Each bar's biasH1 / bias15m / biasState produces
  // exactly one rectangle per strip; null biases skip the fill so the
  // background wash shows through.
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const slotX = x + i * slotW;
    for (const strip of stripPlan) {
      const bias = b ? b[strip.key] : null;
      const color = _colorFor(bias);
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(slotX, strip.y, slotW, strip.h);
      // Hover hit (centered horizontally over the slot, vertically in
      // the middle of the strip).
      hits.push({
        x: slotX + slotW / 2,
        y: strip.y + strip.h / 2,
        r: Math.max(slotW, strip.h) / 2,
        kind: 'bias',
        payload: { strip: strip.label, bias, barTime: b.time },
      });
    }
  }
  ctx.restore();
  return hits;
}

export { drawBiasRibbon, BIAS_PALETTE };
