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

function _ticksInputDisplay(v) {
  if (v == null) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  let s = n.toFixed(4);
  s = s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.$/, '');
  return s;
}

function _commissionInputDisplay(brokerNum) {
  const n = Number(brokerNum);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  let s = n.toFixed(4);
  s = s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.$/, '');
  return s;
}

/** Same semantics as main.js `_optionalTicksFromInput` — blank → undefined (omit from POST). */
function _optionalTicksFromBrokerInput(el) {
  if (!el) return undefined;
  const s = String(el.value ?? '').trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Disable regime scaling when run-wide SL/TP inputs are set; sync mode select enabled state.
 * Exported for main.js after SL/TP input events.
 */
function syncRegimeExitScaleControlsMutualExclusion() {
  const slEl = document.getElementById('btStopLossTicks');
  const tpEl = document.getElementById('btTakeProfitTicks');
  const regEn = document.getElementById('btRegimeExitScale');
  const regMode = document.getElementById('btRegimeExitScaleMode');
  if (!regEn || !regMode) return;
  const blocked =
    _optionalTicksFromBrokerInput(slEl) !== undefined ||
    _optionalTicksFromBrokerInput(tpEl) !== undefined;
  regEn.disabled = blocked;
  regMode.disabled = blocked || !regEn.checked;
  regEn.title = blocked
    ? 'Run-wide Stop loss / Take profit ticks disable regime scaling (server contract). Clear those fields to enable.'
    : 'Scale strategy template SL/TP using range_pct / v_rank on the entry bar.';
  if (blocked && regEn.checked) {
    regEn.checked = false;
    state.backtest.runParams.regimeExitScaleEnabled = false;
  }
}

const _EXECUTION_POLICY_KEYS = new Set([
  'ignore_same_side_fire_when_open',
  'flip_on_opposite_fire',
  'exit_on_stop_loss',
  'exit_on_take_profit',
  'close_at_end_of_window',
  'entry_next_bar_open',
  'entry_gap_guard_max_ticks',
]);

/** Normalize flat `config/backtest_defaults.json` → `{ broker, execution }`. */
function _brokerPayloadFromRepoDefaultsRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.broker && typeof raw.broker === 'object') {
    const out = { broker: raw.broker };
    if (raw.execution && typeof raw.execution === 'object') out.execution = raw.execution;
    return out;
  }
  const skip = new Set(['$schema', '_doc', 'version']);
  const b = {};
  const e = {};
  for (const [k, v] of Object.entries(raw)) {
    if (skip.has(k)) continue;
    if (_EXECUTION_POLICY_KEYS.has(k)) e[k] = v;
    else b[k] = v;
  }
  const out = {};
  if (Object.keys(b).length) out.broker = b;
  if (Object.keys(e).length) out.execution = e;
  return Object.keys(out).length ? out : null;
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
  if (!_isStandardRepoBacktestDefaultsPath(apiPayload.resolvedPath)) return;
  const repo = await _fetchRepoDefaultsPayload();
  if (!repo) return;
  const hasBroker = repo.broker && typeof repo.broker === 'object';
  const hasExec = repo.execution && typeof repo.execution === 'object';
  if (!hasBroker && !hasExec) return;
  const merged = {
    ...(hasBroker ? { broker: { ...(apiPayload.broker || {}), ...repo.broker } } : {}),
    ...(hasExec ? { execution: { ...(apiPayload.execution || {}), ...repo.execution } } : {}),
  };
  applyBacktestBrokerDefaultsToDomAndState(merged);
}

async function fetchAndApplyRepoBacktestDefaults() {
  const payload = await _fetchRepoDefaultsPayload();
  if (!payload) return false;
  applyBacktestBrokerDefaultsToDomAndState(payload);
  return true;
}

function applyExecutionPolicyDefaultsToDom(ex) {
  if (!ex || typeof ex !== 'object') return;
  const map = [
    ['flip_on_opposite_fire', 'btExecFlipOpposite', 'flipOnOppositeFire'],
    ['exit_on_stop_loss', 'btExecStopLoss', 'exitOnStopLoss'],
    ['exit_on_take_profit', 'btExecTakeProfit', 'exitOnTakeProfit'],
    ['close_at_end_of_window', 'btExecEndWindow', 'closeAtEndWindow'],
    ['entry_next_bar_open', 'btExecNextBarOpen', 'entryNextBarOpen'],
  ];
  for (const [jsonKey, domId, stateKey] of map) {
    if (typeof ex[jsonKey] !== 'boolean') continue;
    const el = document.getElementById(domId);
    if (el != null) el.checked = ex[jsonKey];
    state.backtest.runParams[stateKey] = ex[jsonKey];
  }
  const gapEl = document.getElementById('btEntryGapGuardTicks');
  const g = ex.entry_gap_guard_max_ticks;
  if (gapEl != null) {
    if (g != null && Number.isFinite(Number(g)) && Number(g) >= 0) {
      gapEl.value = _ticksInputDisplay(g);
      state.backtest.runParams.entryGapGuardMaxTicks = Number(g);
    } else {
      gapEl.value = '';
      state.backtest.runParams.entryGapGuardMaxTicks = null;
    }
  }
}

/** Persist GET /api/backtest/defaults `broker` / `execution` and fill Performance inputs. */
function applyBacktestBrokerDefaultsToDomAndState(payload) {
  const b = payload?.broker;
  const ex = payload?.execution;
  if ((!b || typeof b !== 'object') && (!ex || typeof ex !== 'object')) return;
  if (b && typeof b === 'object') {
    state.backtest.brokerDefaultsFromApi = b;
    const cap = document.getElementById('btInitialCapital');
  const comm = document.getElementById('btCommission');
  const slip = document.getElementById('btSlippage');
  const qty = document.getElementById('btQty');
  const slTicksEl = document.getElementById('btStopLossTicks');
  const tpTicksEl = document.getElementById('btTakeProfitTicks');
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
  if (slTicksEl != null) {
    const sl = b.stop_loss_ticks;
    if (sl != null && Number.isFinite(Number(sl)) && Number(sl) >= 0) {
      slTicksEl.value = _ticksInputDisplay(sl);
      state.backtest.runParams.stopLossTicks = Number(sl);
    } else {
      slTicksEl.value = '';
      state.backtest.runParams.stopLossTicks = null;
    }
  }
  if (tpTicksEl != null) {
    const tp = b.take_profit_ticks;
    if (tp != null && Number.isFinite(Number(tp)) && Number(tp) >= 0) {
      tpTicksEl.value = _ticksInputDisplay(tp);
      state.backtest.runParams.takeProfitTicks = Number(tp);
    } else {
      tpTicksEl.value = '';
      state.backtest.runParams.takeProfitTicks = null;
    }
  }
  const regEn = document.getElementById('btRegimeExitScale');
  const regMode = document.getElementById('btRegimeExitScaleMode');
  if (regEn != null && typeof b.regime_exit_scale_enabled === 'boolean') {
    regEn.checked = b.regime_exit_scale_enabled;
    state.backtest.runParams.regimeExitScaleEnabled = b.regime_exit_scale_enabled;
  }
  if (regMode != null && b.regime_exit_scale_mode != null) {
    const m = String(b.regime_exit_scale_mode).trim().toLowerCase();
    if (m === 'range_pct' || m === 'v_rank') {
      regMode.value = m;
      state.backtest.runParams.regimeExitScaleMode = m;
    }
  }
  syncRegimeExitScaleControlsMutualExclusion();
  }
  if (ex && typeof ex === 'object') {
    state.backtest.executionDefaultsFromApi = ex;
    applyExecutionPolicyDefaultsToDom(ex);
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

/** True when Performance scope is exactly one canonical watch (not “all” / unset). */
function backtestScopeIsSingleWatch(scope) {
  const ids = _scopeToWatchIds(scope);
  return Array.isArray(ids) && ids.length === 1;
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
  stopLossTicks,
  takeProfitTicks,
  flipOnOppositeFire,
  exitOnStopLoss,
  exitOnTakeProfit,
  closeAtEndWindow,
  entryNextBarOpen = false,
  entryGapGuardMaxTicks = undefined,
  tickSize,
  pointValue,
  useRegimeFilter = true,
  rankGateEnabled = false,
  tradeContextGateEnabled = false,
  tradeContextAllowed = undefined,
  nullHypothesis = false,
  nullHypothesisSeed = undefined,
  regimeExitScaleEnabled = undefined,
  regimeExitScaleMode = undefined,
}) {
  const nh = !!nullHypothesis;
  if (nh && !backtestScopeIsSingleWatch(scope)) {
    throw new Error('Null hypothesis requires a single-watch scope (pick one watch, not “All canonical watches”).');
  }
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
    rank_gate_enabled: !!rankGateEnabled,
    trade_context_gate_enabled: !!tradeContextGateEnabled,
  };
  if (Array.isArray(tradeContextAllowed) && tradeContextAllowed.length > 0) {
    payload.trade_context_allowed = tradeContextAllowed;
  }
  if (nh) {
    payload.null_hypothesis = true;
    const seed = nullHypothesisSeed == null ? null : Number(nullHypothesisSeed);
    if (seed != null && Number.isFinite(seed)) payload.null_hypothesis_seed = Math.trunc(seed);
  }
  if (Number.isFinite(ts) && ts > 0) payload.tick_size = ts;
  if (Number.isFinite(pv) && pv > 0) payload.point_value = pv;
  if (stopLossTicks !== undefined && stopLossTicks !== null && Number.isFinite(Number(stopLossTicks))) {
    const sl = Number(stopLossTicks);
    if (sl < 0) {
      throw new Error(
        'stop_loss_ticks must be >= 0 (positive adverse distance in ticks, not a signed ticket offset like -25).',
      );
    }
    payload.stop_loss_ticks = sl;
  }
  if (takeProfitTicks !== undefined && takeProfitTicks !== null && Number.isFinite(Number(takeProfitTicks))) {
    const tp = Number(takeProfitTicks);
    if (tp < 0) {
      throw new Error('take_profit_ticks must be >= 0.');
    }
    payload.take_profit_ticks = tp;
  }
  const flip = !!flipOnOppositeFire;
  const stopOk = !!exitOnStopLoss;
  const tpOk = !!exitOnTakeProfit;
  const endOk = !!closeAtEndWindow;
  if (!flip && !stopOk && !tpOk && !endOk) {
    throw new Error(
      'Execution policy deadlock: enable flip on opposite signal, honor stop/target, or close at end of window.'
    );
  }
  payload.flip_on_opposite_fire = flip;
  payload.exit_on_stop_loss = stopOk;
  payload.exit_on_take_profit = tpOk;
  payload.close_at_end_of_window = endOk;
  payload.entry_next_bar_open = !!entryNextBarOpen;
  if (entryNextBarOpen) {
    const g = entryGapGuardMaxTicks;
    if (g !== undefined && g !== null && Number.isFinite(Number(g)) && Number(g) >= 0) {
      payload.entry_gap_guard_max_ticks = Number(g);
    }
  }
  if (regimeExitScaleEnabled === true) {
    payload.regime_exit_scale_enabled = true;
    const mode = String(regimeExitScaleMode || 'range_pct').trim().toLowerCase();
    payload.regime_exit_scale_mode = mode === 'v_rank' ? 'v_rank' : 'range_pct';
  }
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
  applyExecutionPolicyDefaultsToDom,
  fetchAndApplyRepoBacktestDefaults,
  fetchBacktestDefaults,
  pullBacktestBrokerDefaultsIntoUi,
  syncRegimeExitScaleControlsMutualExclusion,
  runBacktest,
  fetchBacktestStats,
  fetchBacktestEquity,
  fetchBacktestTrades,
  fetchBacktestSkippedFires,
  backtestScopeIsSingleWatch,
};
