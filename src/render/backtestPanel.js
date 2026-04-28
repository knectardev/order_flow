import { state } from '../state.js';

function _fmtNum(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number(v).toFixed(digits);
}

function _setStat(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
}

function _setDualStat(id, filtered, unfiltered, formatter) {
  const el = document.getElementById(id);
  if (!el) return;
  const a = formatter(filtered);
  const b = formatter(unfiltered);
  el.innerHTML = `<span class="bt-val teal">${a}</span><span class="bt-val orange">${b}</span>`;
}

function _drawEquity(pointsA, pointsB, benchmarkPoints) {
  const cv = document.getElementById('backtestEquityChart');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 500;
  const h = cv.clientHeight || 140;
  cv.width = Math.floor(w * dpr);
  cv.height = Math.floor(h * dpr);
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = '#2a3142';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(w, h - 0.5);
  ctx.stroke();

  const pA = pointsA || [];
  const pB = pointsB || [];
  const pBench = benchmarkPoints || [];
  if (pA.length < 2 && pB.length < 2 && pBench.length < 2) return;
  const ys = [...pA, ...pB, ...pBench].map(p => Number(p.equity || 0));
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = Math.max(1e-6, hi - lo);

  const drawLine = (pts, color, lineWidth = 1.8) => {
    if (!pts || pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (i / (pts.length - 1)) * (w - 1);
      const y = h - ((Number(p.equity || 0) - lo) / span) * (h - 8) - 4;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  drawLine(pA, '#21a095', 1.8);
  drawLine(pB, '#d39145', 1.8);
  drawLine(pBench, 'rgba(255, 79, 163, 0.35)', 0.7);
}

function renderBacktestPanel() {
  const f = state.backtest.compare?.filtered || { stats: null, equity: [] };
  const u = state.backtest.compare?.unfiltered || { stats: null, equity: [] };
  _setStat('btStatRunId', state.backtest.runId || '—');
  _setStat('btStatScope', state.backtest.runParams?.scope || 'all');
  _setDualStat('btStatRunId', f.runId, u.runId, (v) => v ? String(v).slice(0, 8) : '—');
  _setDualStat('btStatTrades', f.stats, u.stats, (s) => s ? String(s.tradeCount ?? '—') : '—');
  _setDualStat('btStatWinRate', f.stats, u.stats, (s) => (s && s.winRate != null) ? `${(s.winRate * 100).toFixed(1)}%` : '—');
  _setDualStat('btStatSharpe', f.stats, u.stats, (s) => s ? _fmtNum(s.sharpe, 3) : '—');
  _setDualStat('btStatMaxDd', f.stats, u.stats, (s) => (s && s.maxDrawdown != null) ? `${(s.maxDrawdown * 100).toFixed(2)}%` : '—');
  _setDualStat('btStatNetPnl', f.stats, u.stats, (s) => s ? _fmtNum(s.netPnl, 2) : '—');
  _setDualStat('btStatEqPoints', f.equity, u.equity, (p) => String((p || []).length || 0));
  const statusEl = document.getElementById('backtestStatus');
  if (statusEl) {
    if (state.backtest.loading) statusEl.textContent = 'Running backtest...';
    else if (state.backtest.error) statusEl.textContent = state.backtest.error;
    else {
      const summarize = (summary) => {
        const entries = Object.entries(summary || {});
        if (!entries.length) return '0';
        const total = entries.reduce((s, [, n]) => s + Number(n || 0), 0);
        const top = entries.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
        return `${total} skipped (top: ${top[0]})`;
      };
      statusEl.textContent = `Ready · ON ${summarize(f.skipped?.summary)} · OFF ${summarize(u.skipped?.summary)}`;
    }
  }
  _drawEquity(f.equity || [], u.equity || [], f.benchmark || []);
}

export { renderBacktestPanel };
