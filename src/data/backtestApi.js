import { state } from '../state.js';

function _apiBase() {
  return state.replay.apiBase || 'http://127.0.0.1:8001';
}

function _normalizeApiBase(apiBase) {
  return String(apiBase || _apiBase() || '').replace(/\/+$/, '');
}

async function fetchBacktestDefaults(apiBase) {
  const base = _normalizeApiBase(apiBase);
  const res = await fetch(`${base}/api/backtest/defaults`);
  if (!res.ok) throw new Error(`/api/backtest/defaults ${res.status}`);
  return res.json();
}

/** Persist GET /api/backtest/defaults `broker` and fill Performance inputs (API mode bootstrap). */
export function applyBacktestBrokerDefaultsToDomAndState(payload) {
  const b = payload?.broker;
  if (!b || typeof b !== 'object') return;
  state.backtest.brokerDefaultsFromApi = b;
  const cap = document.getElementById('btInitialCapital');
  const comm = document.getElementById('btCommission');
  const slip = document.getElementById('btSlippage');
  const qty = document.getElementById('btQty');
  if (cap != null && Number.isFinite(Number(b.initial_capital))) {
    cap.value = String(Number(b.initial_capital));
    state.backtest.runParams.initialCapital = Number(b.initial_capital);
  }
  if (comm != null && Number.isFinite(Number(b.commission_per_side))) {
    comm.value = String(Number(b.commission_per_side));
    state.backtest.runParams.commissionPerSide = Number(b.commission_per_side);
  }
  if (slip != null && Number.isFinite(Number(b.slippage_ticks))) {
    slip.value = String(Number(b.slippage_ticks));
    state.backtest.runParams.slippageTicks = Number(b.slippage_ticks);
  }
  if (qty != null && Number.isFinite(Number(b.qty)) && Number(b.qty) >= 1) {
    qty.value = String(Math.floor(Number(b.qty)));
    state.backtest.runParams.qty = Math.floor(Number(b.qty));
  }
}

function _scopeToWatchIds(scope) {
  if (!scope || scope === 'all') return null;
  return [scope];
}

async function runBacktest({
  from,
  to,
  timeframe,
  scope,
  initialCapital,
  commissionPerSide,
  slippageTicks,
  qty,
  tickSize,
  pointValue,
  useRegimeFilter = true,
}) {
  const watchIds = _scopeToWatchIds(scope);
  const ts = Number(tickSize);
  const pv = Number(pointValue);
  const payload = {
    from,
    to,
    timeframe,
    initial_capital: initialCapital,
    commission_per_side: commissionPerSide,
    slippage_ticks: slippageTicks,
    qty,
    watch_ids: watchIds,
    use_regime_filter: !!useRegimeFilter,
  };
  if (Number.isFinite(ts) && ts > 0) payload.tick_size = ts;
  if (Number.isFinite(pv) && pv > 0) payload.point_value = pv;
  const res = await fetch(`${_apiBase()}/api/backtest/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
  fetchBacktestDefaults,
  runBacktest,
  fetchBacktestStats,
  fetchBacktestEquity,
  fetchBacktestTrades,
  fetchBacktestSkippedFires,
};
