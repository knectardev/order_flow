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

function _drawEquity(points) {
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

  if (!points || points.length < 2) return;
  const ys = points.map(p => Number(p.equity || 0));
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = Math.max(1e-6, hi - lo);

  ctx.strokeStyle = '#21a095';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = (i / (points.length - 1)) * (w - 1);
    const y = h - ((Number(p.equity || 0) - lo) / span) * (h - 8) - 4;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function renderBacktestPanel() {
  const stats = state.backtest.stats;
  const points = state.backtest.equity || [];
  _setStat('btStatRunId', state.backtest.runId || '—');
  _setStat('btStatScope', state.backtest.runParams?.scope || 'all');
  _setStat('btStatTrades', stats ? String(stats.tradeCount ?? '—') : '—');
  _setStat('btStatWinRate', stats && stats.winRate != null ? `${(stats.winRate * 100).toFixed(1)}%` : '—');
  _setStat('btStatSharpe', stats ? _fmtNum(stats.sharpe, 3) : '—');
  _setStat('btStatMaxDd', stats && stats.maxDrawdown != null ? `${(stats.maxDrawdown * 100).toFixed(2)}%` : '—');
  _setStat('btStatNetPnl', stats ? _fmtNum(stats.netPnl, 2) : '—');
  _setStat('btStatEqPoints', String(points.length || 0));
  const statusEl = document.getElementById('backtestStatus');
  if (statusEl) {
    if (state.backtest.loading) statusEl.textContent = 'Running backtest...';
    else if (state.backtest.error) statusEl.textContent = state.backtest.error;
    else statusEl.textContent = 'Ready';
  }
  _drawEquity(points);
}

export { renderBacktestPanel };
