import { state } from '../state.js';
import { DEFAULT_TIMEFRAME, TIMEFRAMES } from '../config/constants.js';

const _BT_TF_LABEL = { '1m': '1 minute', '5m': '5 minutes', '15m': '15 minutes', '1h': '1 hour' };

/** Populate `#btTimeframe` from DB-available TFs and mirror `state.activeTimeframe`. */
export function syncBacktestTimeframeSelect() {
  const sel = document.getElementById('btTimeframe');
  if (!sel) return;
  const available = new Set(state.availableTimeframes?.length ? state.availableTimeframes : TIMEFRAMES);
  const prev = sel.value;
  sel.innerHTML = '';
  for (const tf of TIMEFRAMES) {
    if (!available.has(tf)) continue;
    const opt = document.createElement('option');
    opt.value = tf;
    opt.textContent = _BT_TF_LABEL[tf] || tf;
    sel.appendChild(opt);
  }
  const active = state.activeTimeframe || DEFAULT_TIMEFRAME;
  if (available.has(active)) sel.value = active;
  else if (sel.options.length) sel.value = sel.options[0].value;
  else sel.value = prev;
}

/** Keep Run Backtest in sync with scope + loading (call on every panel render). */
export function syncBacktestRunButtonFromState() {
  const runBtn = document.getElementById('btRunBtn');
  const scopeInput = document.getElementById('btScope');
  if (!runBtn || !scopeInput) return;
  const scopeOk = !!String(scopeInput.value || '').trim();
  runBtn.disabled = !scopeOk || state.backtest.loading;
}

function _fmtNum(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number(v).toFixed(digits);
}

/** Normalize NH summary blob from POST `nullHypothesis` (camelCase + snake_case). */
function _nhMetricsFromStats(raw) {
  if (!raw || typeof raw !== 'object' || raw.skipped === true) return null;
  return {
    runId: raw.runId ?? raw.run_id,
    tradeCount: raw.tradeCount ?? raw.trade_count,
    winRate: raw.winRate ?? raw.win_rate,
    sharpe: raw.sharpe,
    maxDrawdown: raw.maxDrawdown ?? raw.max_drawdown,
    netPnl: raw.netPnl ?? raw.net_pnl,
    scope: raw.scope,
  };
}

function _fmtNhScope(scope) {
  if (scope == null) return '—';
  if (Array.isArray(scope)) return scope.filter(Boolean).join(', ') || '—';
  return String(scope);
}

function _nhSpan(text) {
  return `<span class="bt-val nh">${text}</span>`;
}

/** Primary row: teal ON (+ orange OFF when comparing); optional second row for NH (green). */
function _setMetricCardStacked(id, primaryInnerHtml, nhActive, nhInnerHtml) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!nhActive || !nhInnerHtml) {
    el.innerHTML = primaryInnerHtml;
    return;
  }
  el.innerHTML = `<span class="bt-stat-primary">${primaryInnerHtml}</span><span class="bt-stat-nh">${nhInnerHtml}</span>`;
}

function _drawEquity({
  pointsOn,
  pointsOff,
  benchmarkPoints,
  pointsNH,
  showCompareOffLine,
  showBuyHold,
  includeNH,
}) {
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

  const pA = pointsOn || [];
  const pB = pointsOff || [];
  const pBench = benchmarkPoints || [];
  const pNH = pointsNH || [];
  const pBscale = showCompareOffLine ? pB : [];
  const drawBench = showBuyHold && pBench.length >= 2;
  const drawNH = includeNH && pNH.length >= 2;
  const hasLine =
    pA.length >= 2 ||
    pBscale.length >= 2 ||
    drawNH ||
    drawBench;
  if (!hasLine) return;

  const ys = [];
  for (const p of pA) ys.push(Number(p.equity || 0));
  for (const p of pBscale) ys.push(Number(p.equity || 0));
  if (drawNH) for (const p of pNH) ys.push(Number(p.equity || 0));
  if (drawBench) for (const p of pBench) ys.push(Number(p.equity || 0));
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
  if (showCompareOffLine) drawLine(pB, '#d39145', 1.8);
  if (drawNH) drawLine(pNH, '#2ecc71', 1.8);
  if (drawBench) drawLine(pBench, 'rgba(255, 79, 163, 0.35)', 0.7);
}

function renderBacktestPanel() {
  syncBacktestTimeframeSelect();
  const f = state.backtest.compare?.filtered || { stats: null, equity: [] };
  const u = state.backtest.compare?.unfiltered || { stats: null, equity: [] };
  const showCompareOff =
    state.backtest.runParams?.compareRegimeOff === true && !!u.runId;

  const nhState = state.backtest.nullHypothesis;
  const nhM = nhState?.runId ? _nhMetricsFromStats(nhState.stats) : null;
  const nhActive = !!nhM;

  const scopeLabel = f.stats
    ? state.backtest.lastRunScope || '—'
    : state.backtest.runParams?.scope || '—';

  const scopeEl = document.getElementById('btStatScope');
  if (scopeEl) {
    if (!nhActive) {
      scopeEl.textContent = scopeLabel;
    } else {
      scopeEl.innerHTML = `<span class="bt-stat-primary">${scopeLabel}</span><span class="bt-stat-nh">${_nhSpan(_fmtNhScope(nhM.scope))}</span>`;
    }
  }

  const dualInner = (onVal, offVal, fmt) =>
    `<span class="bt-val teal">${fmt(onVal)}</span><span class="bt-val orange">${fmt(offVal)}</span>`;
  const singleInner = (onVal, fmt) =>
    `<span class="bt-val teal">${fmt(onVal)}</span>`;

  if (showCompareOff) {
    _setMetricCardStacked(
      'btStatRunId',
      dualInner(f.runId, u.runId, (v) => (v ? String(v).slice(0, 8) : '—')),
      nhActive,
      nhActive ? _nhSpan(nhM.runId ? String(nhM.runId).slice(0, 8) : '—') : '',
    );
    _setMetricCardStacked(
      'btStatTrades',
      dualInner(f.stats, u.stats, (s) => (s ? String(s.tradeCount ?? '—') : '—')),
      nhActive,
      nhActive ? _nhSpan(nhM.tradeCount != null ? String(nhM.tradeCount) : '—') : '',
    );
    _setMetricCardStacked(
      'btStatWinRate',
      dualInner(f.stats, u.stats, (s) => ((s && s.winRate != null) ? `${(s.winRate * 100).toFixed(1)}%` : '—')),
      nhActive,
      nhActive ? _nhSpan(nhM.winRate != null ? `${(nhM.winRate * 100).toFixed(1)}%` : '—') : '',
    );
    _setMetricCardStacked(
      'btStatSharpe',
      dualInner(f.stats, u.stats, (s) => (s ? _fmtNum(s.sharpe, 3) : '—')),
      nhActive,
      nhActive ? _nhSpan(_fmtNum(nhM.sharpe, 3)) : '',
    );
    _setMetricCardStacked(
      'btStatMaxDd',
      dualInner(f.stats, u.stats, (s) => ((s && s.maxDrawdown != null) ? `${(s.maxDrawdown * 100).toFixed(2)}%` : '—')),
      nhActive,
      nhActive ? _nhSpan(nhM.maxDrawdown != null ? `${(nhM.maxDrawdown * 100).toFixed(2)}%` : '—') : '',
    );
    _setMetricCardStacked(
      'btStatNetPnl',
      dualInner(f.stats, u.stats, (s) => (s ? _fmtNum(s.netPnl, 2) : '—')),
      nhActive,
      nhActive ? _nhSpan(_fmtNum(nhM.netPnl, 2)) : '',
    );
    _setMetricCardStacked(
      'btStatEqPoints',
      dualInner(f.equity, u.equity, (p) => String((p || []).length || 0)),
      nhActive,
      nhActive ? _nhSpan(String((nhState.equity || []).length || 0)) : '',
    );
  } else {
    _setMetricCardStacked(
      'btStatRunId',
      singleInner(f.runId, (v) => (v ? String(v).slice(0, 8) : '—')),
      nhActive,
      nhActive ? _nhSpan(nhM.runId ? String(nhM.runId).slice(0, 8) : '—') : '',
    );
    _setMetricCardStacked(
      'btStatTrades',
      singleInner(f.stats, (s) => (s ? String(s.tradeCount ?? '—') : '—')),
      nhActive,
      nhActive ? _nhSpan(nhM.tradeCount != null ? String(nhM.tradeCount) : '—') : '',
    );
    _setMetricCardStacked(
      'btStatWinRate',
      singleInner(f.stats, (s) => ((s && s.winRate != null) ? `${(s.winRate * 100).toFixed(1)}%` : '—')),
      nhActive,
      nhActive ? _nhSpan(nhM.winRate != null ? `${(nhM.winRate * 100).toFixed(1)}%` : '—') : '',
    );
    _setMetricCardStacked(
      'btStatSharpe',
      singleInner(f.stats, (s) => (s ? _fmtNum(s.sharpe, 3) : '—')),
      nhActive,
      nhActive ? _nhSpan(_fmtNum(nhM.sharpe, 3)) : '',
    );
    _setMetricCardStacked(
      'btStatMaxDd',
      singleInner(f.stats, (s) => ((s && s.maxDrawdown != null) ? `${(s.maxDrawdown * 100).toFixed(2)}%` : '—')),
      nhActive,
      nhActive ? _nhSpan(nhM.maxDrawdown != null ? `${(nhM.maxDrawdown * 100).toFixed(2)}%` : '—') : '',
    );
    _setMetricCardStacked(
      'btStatNetPnl',
      singleInner(f.stats, (s) => (s ? _fmtNum(s.netPnl, 2) : '—')),
      nhActive,
      nhActive ? _nhSpan(_fmtNum(nhM.netPnl, 2)) : '',
    );
    _setMetricCardStacked(
      'btStatEqPoints',
      singleInner(f.equity, (p) => String((p || []).length || 0)),
      nhActive,
      nhActive ? _nhSpan(String((nhState.equity || []).length || 0)) : '',
    );
  }
  const statusEl = document.getElementById('backtestStatus');
  if (statusEl) {
    if (state.backtest.loading) {
      const rp = state.backtest.runParams || {};
      const nhSlow =
        !!rp.nullHypothesis && !!rp.scope && String(rp.scope).trim() && rp.scope !== 'all';
      statusEl.textContent = nhSlow
        ? 'Running backtest… null-hypothesis parity replays the window many times (large ranges can take tens of minutes).'
        : 'Running backtest…';
    }
    else if (state.backtest.error) statusEl.textContent = state.backtest.error;
    else if (!f.runId && !f.stats) {
      statusEl.textContent = 'Select backtest scope, then Run Backtest';
    }     else {
      const summarize = (summary) => {
        const entries = Object.entries(summary || {});
        if (!entries.length) return '0';
        const total = entries.reduce((s, [, n]) => s + Number(n || 0), 0);
        const top = entries.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
        return `${total} skipped (top: ${top[0]})`;
      };
      let msg = showCompareOff
        ? `Ready · ON ${summarize(f.skipped?.summary)} · OFF ${summarize(u.skipped?.summary)}`
        : `Ready · ON ${summarize(f.skipped?.summary)}`;
      if (nhState?.skipped === true) msg += ` · NH skipped (${nhState.reason})`;
      else if (nhState?.runId) msg += ` · NH ${summarize(nhState.skipped?.summary)}`;
      const em = f.stats?.entryMode;
      if (em) {
        msg += ` · entry: ${em}`;
        const gt = f.stats?.entryGapGuardMaxTicks;
        if (gt != null && Number.isFinite(Number(gt))) msg += ` · gap≤${gt} ticks`;
      }
      const rp = state.backtest.runParams || {};
      if (rp.regimeExitScaleEnabled) {
        msg += ` · regime SL/TP: ${rp.regimeExitScaleMode === 'v_rank' ? 'v_rank' : 'range_pct'}`;
      }
      statusEl.textContent = msg;
    }
  }
  const includeNH = !!(nhState?.runId && (nhState.equity || []).length >= 2);
  const nhLegend = document.getElementById('btLegendNullHypothesis');
  if (nhLegend) nhLegend.hidden = !nhState?.runId;
  _drawEquity({
    pointsOn: f.equity || [],
    pointsOff: u.equity || [],
    benchmarkPoints: f.benchmark || [],
    pointsNH: nhState?.equity || [],
    showCompareOffLine: showCompareOff,
    showBuyHold: state.backtest.runParams?.showBuyHold !== false,
    includeNH,
  });
  syncBacktestRunButtonFromState();
}

export { renderBacktestPanel };
