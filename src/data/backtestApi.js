import { state } from '../state.js';

function _apiBase() {
  return state.replay.apiBase || 'http://127.0.0.1:8001';
}

function _normalizeApiBase(apiBase) {
  return String(apiBase || _apiBase() || '').replace(/\/+$/, '');
}

async function fetchBacktestDefaults(apiBase) {
  const base = _normalizeApiBase(apiBase);
  const res = await fetch(`${base}/api/backtest/defaults`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`/api/backtest/defaults ${res.status}`);
  return res.json();
}

function _commissionInputDisplay(brokerNum) {
  const n = Number(brokerNum);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  let s = n.toFixed(4);
  s = s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.$/, '');
  return s;
}

/** Normalize `config/backtest_defaults.json` (flat BrokerConfig-aligned keys + metadata) → API `{ broker }` shape. */
function _brokerPayloadFromRepoDefaultsRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.broker && typeof raw.broker === 'object') return raw;
  const skip = new Set(['$schema', '_doc', 'version']);
  const b = {};
  for (const [k, v] of Object.entries(raw)) {
    if (skip.has(k)) continue;
    b[k] = v;
  }
  return Object.keys(b).length ? { broker: b } : null;
}

/**
 * True when the server's resolved defaults file is (or is absent for) the repo-standard
 * `config/backtest_defaults.json`. We may then overlay same-origin `config/backtest_defaults.json`
 * so the Performance inputs match the editor; skip when `ORDERFLOW_BACKTEST_CONFIG` points at
 * another filename (server is authoritative for that path).
 */
function _isStandardRepoBacktestDefaultsPath(resolvedPath) {
  if (resolvedPath == null || resolvedPath === '') return true;
  const norm = String(resolvedPath).replace(/\\/g, '/').toLowerCase();
  return norm.endsWith('/config/backtest_defaults.json');
}

async function _fetchRepoDefaultsPayload() {
  try {
    const url = new URL('../../config/backtest_defaults.json', import.meta.url);
    const res = await fetch(url.href, { cache: 'no-store' });
    if (!res.ok) return null;
    const raw = await res.json();
    return _brokerPayloadFromRepoDefaultsRaw(raw);
  } catch {
    return null;
  }
}

async function overlaySameOriginRepoDefaultsOverApi(apiPayload) {
  if (!apiPayload?.broker || typeof apiPayload.broker !== 'object') return;
  if (!_isStandardRepoBacktestDefaultsPath(apiPayload.resolvedPath)) return;
  const repo = await _fetchRepoDefaultsPayload();
  if (!repo?.broker || typeof repo.broker !== 'object') return;
  applyBacktestBrokerDefaultsToDomAndState({
    broker: { ...apiPayload.broker, ...repo.broker },
  });
}

async function fetchAndApplyRepoBacktestDefaults() {
  const payload = await _fetchRepoDefaultsPayload();
  if (!payload) return false;
  applyBacktestBrokerDefaultsToDomAndState(payload);
  return true;
}

/** Persist GET /api/backtest/defaults `broker` and fill Performance inputs (API mode bootstrap). */
function applyBacktestBrokerDefaultsToDomAndState(payload) {
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
    comm.value = _commissionInputDisplay(b.commission_per_side);
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

/** Best-effort: fill Performance broker inputs from FastAPI defaults (survives synthetic mode). */
async function pullBacktestBrokerDefaultsIntoUi(apiBase) {
  const base = _normalizeApiBase(apiBase);
  if (base) {
    try {
      const payload = await fetchBacktestDefaults(apiBase);
      applyBacktestBrokerDefaultsToDomAndState(payload);
      await overlaySameOriginRepoDefaultsOverApi(payload);
      return true;
    } catch (_) { /* Fall through — static repo JSON when API unreachable. */ }
  }
  return fetchAndApplyRepoBacktestDefaults();
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
  applyBacktestBrokerDefaultsToDomAndState,
  fetchAndApplyRepoBacktestDefaults,
  fetchBacktestDefaults,
  pullBacktestBrokerDefaultsIntoUi,
  runBacktest,
  fetchBacktestStats,
  fetchBacktestEquity,
  fetchBacktestTrades,
  fetchBacktestSkippedFires,
};
