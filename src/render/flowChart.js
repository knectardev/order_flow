import { state } from '../state.js';
import { _getViewedBars } from './priceChart.js';
import { fctx, flowCanvas, resizeCanvas } from '../util/dom.js';

function drawFlowChart() {
  const { w, h } = resizeCanvas(flowCanvas);
  fctx.clearRect(0, 0, w, h);
  fctx.fillStyle = '#0d1218';
  fctx.fillRect(0, 0, w, h);

  // Use the SAME viewed-state.bars window as the price chart so the delta
  // distribution + cumulative-delta sparkline scroll/update in lockstep
  // with the candles above. When the user pans the price chart back across
  // history, this panel now mirrors that slice instead of staying pinned to
  // the live-edge rolling `state.bars` array.
  const { viewedBars: allBars, isPanned } = _getViewedBars();
  if (allBars.length === 0) return;
  const PROFILE_W = Math.min(110, w * 0.22);
  const PAD = { l: 6, r: PROFILE_W + 16, t: 4, b: 4 };
  const chartW = w - PAD.l - PAD.r;
  const chartH = h - PAD.t - PAD.b;
  const slotW = chartW / Math.max(allBars.length, 12);

  // Find max abs delta for scaling
  let maxAbs = 1;
  for (const b of allBars) maxAbs = Math.max(maxAbs, Math.abs(b.delta));

  const midY = PAD.t + chartH / 2;

  // Zero line
  fctx.strokeStyle = 'rgba(138,146,166,0.25)';
  fctx.lineWidth = 1;
  fctx.beginPath();
  fctx.moveTo(PAD.l, midY);
  fctx.lineTo(PAD.l + chartW, midY);
  fctx.stroke();

  // Bars
  const candleW = Math.max(2, Math.min(slotW * 0.65, 14));
  for (let i = 0; i < allBars.length; i++) {
    const b = allBars[i];
    const xCenter = PAD.l + (i + 0.5) * slotW;
    const isForming = (b === state.formingBar);
    const barH = (Math.abs(b.delta) / maxAbs) * (chartH / 2 - 2);
    const isPos = b.delta >= 0;
    const color = isPos ? '#4ea674' : '#c95760';
    fctx.fillStyle = isForming
      ? (isPos ? 'rgba(78,166,116,0.35)' : 'rgba(201,87,96,0.35)')
      : color;
    if (isPos) fctx.fillRect(xCenter - candleW/2, midY - barH, candleW, barH);
    else        fctx.fillRect(xCenter - candleW/2, midY,         candleW, barH);

    if (isForming) {
      fctx.strokeStyle = isPos ? 'rgba(78,166,116,0.8)' : 'rgba(201,87,96,0.8)';
      fctx.setLineDash([2,2]);
      fctx.lineWidth = 1;
      const y = isPos ? midY - barH : midY;
      fctx.strokeRect(xCenter - candleW/2, y, candleW, barH);
      fctx.setLineDash([]);
    }
  }

  // Cumulative delta sparkline
  let cum = 0;
  const cumPts = allBars.map(b => { cum += b.delta; return cum; });
  const cumMax = Math.max(...cumPts.map(Math.abs), 1);
  fctx.strokeStyle = 'rgba(33,160,149,0.55)';
  fctx.lineWidth = 1.2;
  fctx.beginPath();
  for (let i = 0; i < cumPts.length; i++) {
    const x = PAD.l + (i + 0.5) * slotW;
    const y = midY - (cumPts[i] / cumMax) * (chartH / 2 - 2);
    if (i === 0) fctx.moveTo(x, y);
    else fctx.lineTo(x, y);
  }
  fctx.stroke();

  // Cumulative delta readout
  document.getElementById('cumDelta').textContent =
    'cum Δ ' + (cumPts[cumPts.length-1] >= 0 ? '+' : '') + Math.round(cumPts[cumPts.length-1]).toLocaleString();
}

export { drawFlowChart };
