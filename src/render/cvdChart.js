import { CHART_CANVAS_BG } from '../config/constants.js';
import { state } from '../state.js';
import { layoutViewportStripForSubchart } from './chartStripLayout.js';
import { _getViewedBars } from './priceChart.js';
import { cvdCanvas, cvdCtx, resizeCanvas } from '../util/dom.js';

/** Visible-window session CVD fallback when API bars lack sessionCvd (legacy payloads). */
function _sessionCvdForBar(b, idx, viewedBars) {
  const v = b.sessionCvd;
  if (v !== undefined && v !== null && Number.isFinite(Number(v))) return Number(v);
  let cum = 0;
  for (let i = 0; i <= idx; i++) cum += viewedBars[i].delta ?? 0;
  return cum;
}

function drawCvdChart() {
  if (!cvdCanvas || !cvdCtx) return;
  if (!state.chartUi.showCvdPanel) {
    state.cvdSwingHits = [];
    const { w, h } = resizeCanvas(cvdCanvas);
    cvdCtx.clearRect(0, 0, w, h);
    cvdCtx.fillStyle = CHART_CANVAS_BG;
    cvdCtx.fillRect(0, 0, w, h);
    const meta = document.getElementById('sessionCvdMeta');
    if (meta) meta.textContent = 'session CVD —';
    return;
  }

  const { w, h } = resizeCanvas(cvdCanvas);
  state.cvdSwingHits = [];
  cvdCtx.clearRect(0, 0, w, h);
  cvdCtx.fillStyle = CHART_CANVAS_BG;
  cvdCtx.fillRect(0, 0, w, h);

  const { viewedBars: allBars } = _getViewedBars();
  const meta = document.getElementById('sessionCvdMeta');

  if (allBars.length === 0) {
    if (meta) meta.textContent = 'session CVD —';
    return;
  }

  const PAD = { t: 6, b: 18 };
  const { padL: PAD_L, chartW, slotW } = layoutViewportStripForSubchart(w, allBars.length);
  const chartH = h - PAD.t - PAD.b;

  const pts = allBars.map((b, i) => ({
    x: PAD_L + (i + 0.5) * slotW,
    cvd: _sessionCvdForBar(b, i, allBars),
  }));

  let cvdLo = pts[0].cvd;
  let cvdHi = pts[0].cvd;
  for (const p of pts) {
    cvdLo = Math.min(cvdLo, p.cvd);
    cvdHi = Math.max(cvdHi, p.cvd);
  }
  if (cvdLo === cvdHi) {
    cvdLo -= 1;
    cvdHi += 1;
  }

  const yScale = v => PAD.t + chartH - ((v - cvdLo) / (cvdHi - cvdLo)) * chartH;

  cvdCtx.strokeStyle = 'rgba(138,146,166,0.35)';
  cvdCtx.lineWidth = 1;
  cvdCtx.beginPath();
  const zeroY = yScale(0);
  cvdCtx.moveTo(PAD_L, zeroY);
  cvdCtx.lineTo(PAD_L + chartW, zeroY);
  cvdCtx.stroke();

  cvdCtx.strokeStyle = 'rgba(110, 124, 160, 0.85)';
  cvdCtx.lineWidth = 1.15;
  cvdCtx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const { x, cvd } = pts[i];
    const y = yScale(cvd);
    if (i === 0) cvdCtx.moveTo(x, y);
    else cvdCtx.lineTo(x, y);
  }
  cvdCtx.stroke();

  const last = allBars[allBars.length - 1];
  const lastCvd = _sessionCvdForBar(last, allBars.length - 1, allBars);
  if (meta) {
    meta.textContent = `session CVD ${lastCvd >= 0 ? '+' : ''}${Math.round(lastCvd).toLocaleString()}`
      + (state.replay.allSwings?.length
        ? ` · swings K=${state.replay.swingLookbackDisplay ?? '—'}`
        : '');
  }

  // Swing markers on CVD series (API replay)
  const swings = state.replay.mode === 'real' ? (state.replay.allSwings || []) : [];
  const winLo = allBars[0].time instanceof Date ? allBars[0].time.getTime() : Date.parse(allBars[0].time);
  const winHi = last.time instanceof Date ? last.time.getTime() : Date.parse(last.time);
  for (const sw of swings) {
    if (!sw.seriesType?.startsWith('cvd_')) continue;
    const tms = sw.barTimeMs ?? Date.parse(sw.time);
    if (!Number.isFinite(tms) || tms < winLo || tms > winHi) continue;
    const idx = allBars.findIndex(b => {
      const bt = b.time instanceof Date ? b.time.getTime() : Date.parse(b.time);
      return bt === tms;
    });
    if (idx < 0) continue;
    const x = PAD_L + (idx + 0.5) * slotW;
    const y = yScale(sw.swingValue ?? pts[idx].cvd);
    cvdCtx.fillStyle = sw.seriesType === 'cvd_high' ? 'rgba(239,83,80,0.9)' : 'rgba(38,166,154,0.9)';
    cvdCtx.beginPath();
    if (sw.seriesType === 'cvd_high') {
      cvdCtx.moveTo(x, y - 5);
      cvdCtx.lineTo(x - 4, y + 3);
      cvdCtx.lineTo(x + 4, y + 3);
    } else {
      cvdCtx.moveTo(x, y + 5);
      cvdCtx.lineTo(x - 4, y - 3);
      cvdCtx.lineTo(x + 4, y - 3);
    }
    cvdCtx.closePath();
    cvdCtx.fill();
    const cy = sw.seriesType === 'cvd_high' ? y + 1 / 3 : y - 1 / 3;
    const K = Number(sw.swingLookback);
    state.cvdSwingHits.push({
      x,
      y: cy,
      r: 10,
      seriesType: sw.seriesType,
      swingValue: Number(sw.swingValue ?? pts[idx].cvd),
      barTimeMs: tms,
      swingLookback: Number.isFinite(K) ? K : null,
    });
  }

  // CVD divergence connectors (same panel — line between CVD swing points)
  const divs = state.replay.mode === 'real' ? (state.replay.allDivergences || []) : [];
  for (const d of divs) {
    const t0 = Date.parse(d.earlierTime);
    const t1 = Date.parse(d.laterTime);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    if (t1 < winLo || t0 > winHi) continue;
    const i0 = allBars.findIndex(b => (b.time instanceof Date ? b.time.getTime() : Date.parse(b.time)) === t0);
    const i1 = allBars.findIndex(b => (b.time instanceof Date ? b.time.getTime() : Date.parse(b.time)) === t1);
    if (i0 < 0 || i1 < 0) continue;
    const x0 = PAD_L + (i0 + 0.5) * slotW;
    const x1 = PAD_L + (i1 + 0.5) * slotW;
    const y0 = yScale(typeof d.earlierCvd === 'number' ? d.earlierCvd : pts[i0].cvd);
    const y1 = yScale(typeof d.laterCvd === 'number' ? d.laterCvd : pts[i1].cvd);
    cvdCtx.strokeStyle = d.kind === 'bearish' ? 'rgba(239,83,80,0.55)' : 'rgba(38,166,154,0.55)';
    cvdCtx.setLineDash(d.sizeConfirmation ? [] : [4, 4]);
    cvdCtx.lineWidth = d.sizeConfirmation ? 1.5 : 1;
    cvdCtx.beginPath();
    cvdCtx.moveTo(x0, y0);
    cvdCtx.lineTo(x1, y1);
    cvdCtx.stroke();
    cvdCtx.setLineDash([]);
  }

  const hb = state.selection.hoverBarTime;
  if (hb != null) {
    const barIdx = allBars.findIndex(b => {
      const bt = b.time instanceof Date ? b.time.getTime() : Date.parse(b.time);
      return bt === hb;
    });
    if (barIdx >= 0) {
      const xh = PAD_L + (barIdx + 0.5) * slotW;
      cvdCtx.strokeStyle = 'rgba(0,191,165,0.45)';
      cvdCtx.lineWidth = 1;
      cvdCtx.beginPath();
      cvdCtx.moveTo(xh, PAD.t);
      cvdCtx.lineTo(xh, PAD.t + chartH);
      cvdCtx.stroke();
    }
  }

  cvdCtx.fillStyle = 'rgba(160,168,184,0.85)';
  cvdCtx.font = '10px system-ui, sans-serif';
  cvdCtx.textAlign = 'right';
  const axisX = PAD_L + chartW - 4;
  cvdCtx.fillText(String(Math.round(cvdHi)), axisX, PAD.t + 12);
  cvdCtx.fillText(String(Math.round(cvdLo)), axisX, PAD.t + chartH - 4);
  cvdCtx.textAlign = 'start';
}

export { drawCvdChart };
