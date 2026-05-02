import { priceCanvas } from '../util/dom.js';

/**
 * Horizontal layout for the candle pane and the stacked delta/CVD canvases.
 *
 * Must stay in lockstep with `drawPriceChart()` in `priceChart.js`:
 *   chartW = cssWidth - PROFILE_W - PAD.l - PAD.r - 8  →  cssWidth - PROFILE_W - 22
 *
 * If delta/CVD used different left padding (e.g. CVD previously used 42px for labels),
 * `slotW` differed and bar centers drifted across bars — visible as a cumulative crosshair
 * offset when panning.
 *
 * @param {number} cssWidth  Layout width in CSS pixels (use price chart width for alignment).
 * @param {number} barCount  Visible bar count (`viewedBars.length`).
 */
export function layoutViewportStrip(cssWidth, barCount) {
  const w = Math.max(1, cssWidth);
  const profileW = Math.min(110, w * 0.22);
  const padL = 6;
  const padR = profileW + 16;
  const chartW = w - padL - padR;
  const slotW = chartW / Math.max(barCount, 12);
  return { profileW, padL, padR, chartW, slotW };
}

/**
 * Subcharts should use the **price** canvas width when available so `slotW` matches the
 * candle strip even if `#flowChart` / `#cvdChart` differ by a sub-pixel from layout.
 */
export function layoutViewportStripForSubchart(localCssWidth, barCount) {
  const pw = priceCanvas?.getBoundingClientRect()?.width;
  const cssWidth =
    typeof pw === 'number' && pw > 0 ? pw : Math.max(1, localCssWidth);
  return layoutViewportStrip(cssWidth, barCount);
}
