import { layoutViewportStripForSubchart } from './chartStripLayout.js';
import { _getViewedBars } from './priceChart.js';

/** Map x-coordinate inside a delta/CVD subcanvas (CSS px) to hovered bar_time ms. Uses the same strip layout as price/delta/CVD draw passes. */
export function barTimeMsFromSubchartX(canvas, cssX) {
  const { viewedBars } = _getViewedBars();
  if (!viewedBars.length || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const { padL, slotW } = layoutViewportStripForSubchart(w, viewedBars.length);
  const fi = (cssX - padL) / slotW - 0.5;
  const idx = Math.max(0, Math.min(viewedBars.length - 1, Math.round(fi)));
  const b = viewedBars[idx];
  return b.time instanceof Date ? b.time.getTime() : Date.parse(b.time);
}
