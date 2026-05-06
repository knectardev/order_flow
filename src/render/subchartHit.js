import { layoutViewportStripForSubchart } from './chartStripLayout.js';
import { _getViewedBars } from './priceChart.js';

/** Map x-coordinate inside a delta/CVD subcanvas (CSS px) to hovered bar_time ms. Uses the same strip layout as price/delta/CVD draw passes. */
export function barTimeMsFromSubchartX(canvas, cssX) {
  const { viewedBars, viewportSlotCount } = _getViewedBars();
  if (!viewedBars.length || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const slots = viewportSlotCount ?? viewedBars.length;
  const { padL, slotW } = layoutViewportStripForSubchart(w, slots);
  const fi = (cssX - padL) / slotW - 0.5;
  const idx = Math.round(fi);
  if (idx < 0 || idx >= viewedBars.length) return null;
  const b = viewedBars[idx];
  return b.time instanceof Date ? b.time.getTime() : Date.parse(b.time);
}
