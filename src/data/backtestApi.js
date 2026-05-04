import { state } from '../state.js';

function _apiBase() {
  return state.replay.apiBase || 'http://127.0.0.1:8001';
}

function _scopeToWatchIds(scope) {
  if (!scope || scope === 'all') return null;
  return [scope];
}

async function runBacktest({ from, to, timeframe, scope, initialCapital, commissionPerSide, slippageTicks, qty, useRegimeFilter = true }) {
  const watchIds = _scopeToWatchIds(scope);
  const res = await fetch(`${_apiBase()}/api/backtest/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      timeframe,
      initial_capital: initialCapital,
      commission_per_side: commissionPerSide,
      slippage_ticks: slippageTicks,
      qty,
      watch_ids: watchIds,
      use_regime_filter: !!useRegimeFilter,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.detail ? `: ${j.detail}` : '';
    } catch (_) { /* noop */ }
    throw new Error(`/api/backtest/run ${res.status}${detail}`);
  }
  return res.json();
}

async function fetchBacktestStats(runId = null) {
  const url = runId
    ? `${_apiBase()}/api/backtest/stats?runId=${encodeURIComponent(runId)}`
    : `${_apiBase()}/api/backtest/stats`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`/api/backtest/stats ${res.status}`);
  return res.json();
}

async function fetchBacktestEquity(runId = null) {
  const url = runId
    ? `${_apiBase()}/api/backtest/equity?runId=${encodeURIComponent(runId)}`
    : `${_apiBase()}/api/backtest/equity`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`/api/backtest/equity ${res.status}`);
  return res.json();
}

async function fetchBacktestTrades(runId = null) {
  const url = runId
    ? `${_apiBase()}/api/backtest/trades?runId=${encodeURIComponent(runId)}`
    : `${_apiBase()}/api/backtest/trades`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`/api/backtest/trades ${res.status}`);
  return res.json();
}

async function fetchBacktestSkippedFires(runId = null) {
  const url = runId
    ? `${_apiBase()}/api/backtest/skipped-fires?runId=${encodeURIComponent(runId)}`
    : `${_apiBase()}/api/backtest/skipped-fires`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`/api/backtest/skipped-fires ${res.status}`);
  return res.json();
}

export {
  runBacktest,
  fetchBacktestStats,
  fetchBacktestEquity,
  fetchBacktestTrades,
  fetchBacktestSkippedFires,
};
