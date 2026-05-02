import {
  CHART_CANVAS_BG,
  CHART_CANDLE_DOWN,
  CHART_CANDLE_DOWN_RGB,
  CHART_CANDLE_UP,
  CHART_CANDLE_UP_RGB,
} from '../config/constants.js';
import { state } from '../state.js';
import { layoutViewportStripForSubchart } from './chartStripLayout.js';
import { _getViewedBars } from './priceChart.js';
import { fctx, flowCanvas, resizeCanvas } from '../util/dom.js';

function drawFlowChart() {
  const { w, h } = resizeCanvas(flowCanvas);
  fctx.clearRect(0, 0, w, h);
  fctx.fillStyle = CHART_CANVAS_BG;
  fctx.fillRect(0, 0, w, h);

  if (!state.chartUi.showDeltaPanel) {
    const sumEl = document.getElementById('deltaWindowSum');
    if (sumEl) sumEl.textContent = 'ΣΔ —';
    return;
  }

  const { viewedBars: allBars } = _getViewedBars();
  if (allBars.length === 0) {
    const sumEl = document.getElementById('deltaWindowSum');
    if (sumEl) sumEl.textContent = 'ΣΔ —';
    return;
  }

  const PAD = { t: 4, b: 4 };
  const { padL: PAD_L, chartW, slotW } = layoutViewportStripForSubchart(w, allBars.length);
  const chartH = h - PAD.t - PAD.b;

  let maxAbs = 1;
  for (const b of allBars) maxAbs = Math.max(maxAbs, Math.abs(b.delta));

  const midY = PAD.t + chartH / 2;

  fctx.strokeStyle = 'rgba(138,146,166,0.25)';
  fctx.lineWidth = 1;
  fctx.beginPath();
  fctx.moveTo(PAD_L, midY);
  fctx.lineTo(PAD_L + chartW, midY);
  fctx.stroke();

  const candleW = Math.max(2, Math.min(slotW * 0.65, 14));
  for (let i = 0; i < allBars.length; i++) {
    const b = allBars[i];
    const xCenter = PAD_L + (i + 0.5) * slotW;
    const isForming = (b === state.formingBar);
    const barH = (Math.abs(b.delta) / maxAbs) * (chartH / 2 - 2);
    const isPos = b.delta >= 0;
    const color = isPos ? CHART_CANDLE_UP : CHART_CANDLE_DOWN;
    const [ru, gu, bu] = CHART_CANDLE_UP_RGB;
    const [rd, gd, bd] = CHART_CANDLE_DOWN_RGB;
    fctx.fillStyle = isForming
      ? (isPos ? `rgba(${ru},${gu},${bu},0.35)` : `rgba(${rd},${gd},${bd},0.35)`)
      : color;
    if (isPos) fctx.fillRect(xCenter - candleW/2, midY - barH, candleW, barH);
    else        fctx.fillRect(xCenter - candleW/2, midY,         candleW, barH);

    if (isForming) {
      fctx.strokeStyle = isPos
        ? `rgba(${CHART_CANDLE_UP_RGB[0]},${CHART_CANDLE_UP_RGB[1]},${CHART_CANDLE_UP_RGB[2]},0.8)`
        : `rgba(${CHART_CANDLE_DOWN_RGB[0]},${CHART_CANDLE_DOWN_RGB[1]},${CHART_CANDLE_DOWN_RGB[2]},0.8)`;
      fctx.setLineDash([2,2]);
      fctx.lineWidth = 1;
      const y = isPos ? midY - barH : midY;
      fctx.strokeRect(xCenter - candleW/2, y, candleW, barH);
      fctx.setLineDash([]);
    }
  }

  const winSum = allBars.reduce((s, b) => s + (b.delta ?? 0), 0);
  const sumEl = document.getElementById('deltaWindowSum');
  if (sumEl) {
    sumEl.textContent = `ΣΔ ${winSum >= 0 ? '+' : ''}${Math.round(winSum).toLocaleString()} (window)`;
  }

  const hb = state.selection.hoverBarTime;
  if (hb != null) {
    const hi = allBars.findIndex(b => {
      const bt = b.time instanceof Date ? b.time.getTime() : Date.parse(b.time);
      return bt === hb;
    });
    if (hi >= 0) {
      const xh = PAD_L + (hi + 0.5) * slotW;
      fctx.strokeStyle = 'rgba(0,191,165,0.45)';
      fctx.lineWidth = 1;
      fctx.beginPath();
      fctx.moveTo(xh, PAD.t);
      fctx.lineTo(xh, PAD.t + chartH);
      fctx.stroke();
    }
  }
}

export { drawFlowChart };
