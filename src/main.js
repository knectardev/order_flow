import { TIMEFRAMES } from './config/constants.js';
import { state } from './state.js';
import { evaluateAbsorptionWallCanonical, evaluateBreakoutCanonical, evaluateFadeCanonical, evaluateValueEdgeReject } from './analytics/canonical.js';
import { computeMatrixScores } from './analytics/regime.js';
import {
  _syncCandleModeSelectorUI,
  _syncTimeframeSelectorUI,
  bootstrapReplay,
  setActiveTimeframe,
} from './data/replay.js';
import {
  backtestScopeIsSingleWatch,
  fetchBacktestEquity,
  fetchBacktestSkippedFires,
  fetchBacktestTrades,
  runBacktest,
  syncRegimeExitScaleControlsMutualExclusion,
} from './data/backtestApi.js';
import { drawFlowChart } from './render/flowChart.js';
import { drawCvdChart } from './render/cvdChart.js';
import { buildMatrix, renderMatrix } from './render/matrix.js';
import { restoreDisplayStateFromUrl } from './render/eventInventory.js';
import { drawPriceChart } from './render/priceChart.js';
import {
  renderBacktestPanel,
  syncBacktestRunButtonFromState,
  syncBacktestTimeframeSelect,
} from './render/backtestPanel.js';
import { renderAbsorptionWallWatch, renderBreakoutWatch, renderFadeWatch, renderValueEdgeRejectWatch } from './render/watch.js';
import { bindPlaybackHotkeys, onSpeedChange, resetStream, toggleStream } from './ui/controls.js';
import { dismissFire, openFireDetails } from './ui/fireBanner.js';
import { bindMatrixRangeUI, repaintMatrix } from './ui/matrixRange.js';
import { bindModalDrag, closeModal, onOverlayClick, openModal } from './ui/modal.js';
import { bindPhatLegendModal } from './ui/phatLegendModal.js';
import { bindChartDrawUI, redrawChartDrawOverlay } from './ui/chartDrawOverlay.js';
import { returnToLiveEdge, _setViewEnd } from './ui/pan.js';
import { bindSelectionUI, restoreSelectionFromUrl } from './ui/selection.js';
import { bindEventLogClicks } from './render/eventLog.js';
import { initSectionCollapse, syncDeltaSectionPanelsFromCollapse } from './ui/sectionCollapse.js';
import { bindDivergenceNavUI, syncDivergenceNavButtons } from './ui/divergenceNav.js';
import { updateCvdDivergenceLegend } from './ui/cvdDivergenceLegend.js';

function _isBacktestPopoutMode() {
  try {
    const mode = new URLSearchParams(window.location.search).get('view');
    return String(mode || '').toLowerCase() === 'backtest';
  } catch (_) {
    return false;
  }
}

function _setBacktestPopoutParam(urlLike, enabled) {
  const url = new URL(urlLike, window.location.href);
  if (enabled) url.searchParams.set('view', 'backtest');
  else url.searchParams.delete('view');
  return url.toString();
}

function applyBacktestPopoutLayout() {
  if (!_isBacktestPopoutMode()) return;
  document.body.classList.add('backtest-popout-mode');
  document.title = 'Order Flow Dashboard — Backtest Focus';
}

// ───────────────────────────────────────────────────────────
buildMatrix();
state.matrixScores = computeMatrixScores();
const initialBreakout = evaluateBreakoutCanonical();
const initialFade     = evaluateFadeCanonical();
const initialAbsorptionWall = evaluateAbsorptionWallCanonical();
const initialValueEdgeReject = evaluateValueEdgeReject();
renderMatrix(initialBreakout, initialFade, initialAbsorptionWall, initialValueEdgeReject);
renderBreakoutWatch(initialBreakout);
renderFadeWatch(initialFade);
renderAbsorptionWallWatch(initialAbsorptionWall);
renderValueEdgeRejectWatch(initialValueEdgeReject);
initSectionCollapse();
syncDeltaSectionPanelsFromCollapse();
applyBacktestPopoutLayout();

window.addEventListener('resize', () => {
  drawPriceChart();
  drawFlowChart();
  drawCvdChart();
  redrawChartDrawOverlay();
});

// Try to load real-data sessions from the FastAPI/DuckDB stack; falls
// back to synthetic mode silently when the page is opened without
// `?source=api` (regime-DB plan §2f retired the JSON-manifest fallback).
// Draw charts only after bootstrap: `?source=api` leaves `replay.mode`
// non-real with empty `state.bars` until `/bars` loads — an early
// `drawPriceChart()` would paint an empty canvas (black main chart).
(async function bootstrapThenPaint() {
  try {
    await bootstrapReplay();
  } catch (e) {
    console.error('[orderflow] bootstrapReplay failed:', e);
  }
  drawPriceChart();
  drawFlowChart();
  drawCvdChart();
  updateCvdDivergenceLegend();
})();
bindModalDrag();
bindPhatLegendModal();
bindChartDrawUI();

// ───────────────────────────────────────────────────────────
// DOM event wiring (replaces inline on*= handlers stripped from HTML).
// Kept at the bottom of the file so all referenced functions are defined.
// ───────────────────────────────────────────────────────────
// Phase 5 timeframe selector. Click → switch active timeframe (refetch
// bars + cursor-snap + heatmap auto-bump). Buttons present unconditionally
// in the HTML; their disabled state is driven by /timeframes from
// _syncTimeframeSelectorUI() once API bootstrap completes.
document.querySelectorAll('#timeframeSelect .tf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    setActiveTimeframe(btn.dataset.tf);
  });
});
document.querySelectorAll('#candleModeSelect .tf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    state.candleMode = btn.dataset.candleMode === 'phat' ? 'phat' : 'standard';
    _syncCandleModeSelectorUI();
    drawPriceChart();
  });
});
const _chartPanTooltipEt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function _chartPanTooltipText(sliderValue) {
  if (state.replay.mode !== 'real') return '';
  const end = Number.parseInt(sliderValue, 10);
  if (!Number.isFinite(end) || end <= 0 || !state.replay.allBars.length) return '';
  const bar = state.replay.allBars[Math.min(end - 1, state.replay.allBars.length - 1)];
  if (!bar?.time) return '';
  const dt = bar.time instanceof Date ? bar.time : new Date(bar.time);
  return `${_chartPanTooltipEt.format(dt)} ET`;
}

function _positionChartPanTooltip(sliderEl, tooltipEl) {
  const min = Number(sliderEl.min) || 0;
  const max = Number(sliderEl.max) || 1;
  const val = Number(sliderEl.value) || min;
  const range = Math.max(max - min, 1);
  const pct = Math.max(0, Math.min(1, (val - min) / range));
  const width = sliderEl.clientWidth || 0;
  const pad = sliderEl.offsetLeft;
  const x = pct * width;
  tooltipEl.style.left = `${pad + x}px`;
}

function _updateChartPanTooltip(visible = true) {
  const sliderEl = document.getElementById('chartPanSlider');
  const tooltipEl = document.getElementById('chartPanThumbDateTooltip');
  if (!sliderEl || !tooltipEl || state.replay.mode !== 'real') return;
  const text = _chartPanTooltipText(sliderEl.value);
  if (!text) {
    tooltipEl.classList.remove('visible');
    tooltipEl.setAttribute('aria-hidden', 'true');
    return;
  }
  tooltipEl.textContent = text;
  _positionChartPanTooltip(sliderEl, tooltipEl);
  if (visible) {
    tooltipEl.classList.add('visible');
    tooltipEl.setAttribute('aria-hidden', 'false');
  }
}

function _hideChartPanTooltip() {
  const tooltipEl = document.getElementById('chartPanThumbDateTooltip');
  if (!tooltipEl) return;
  tooltipEl.classList.remove('visible');
  tooltipEl.setAttribute('aria-hidden', 'true');
}

const OVERLAY_VIS_STORAGE_KEY = 'orderflow_dashboard_chart_overlay_visibility';

function _loadChartOverlayVisibilityPrefs() {
  try {
    const raw = localStorage.getItem(OVERLAY_VIS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function _saveChartOverlayVisibilityPrefs() {
  try {
    localStorage.setItem(
      OVERLAY_VIS_STORAGE_KEY,
      JSON.stringify(state.chartOverlayVisibility || {}),
    );
  } catch (_) {
    // localStorage unavailable/quota exceeded/private mode: ignore.
  }
}

function bindChartOverlayLegendToggles() {
  const buttons = Array.from(document.querySelectorAll('[data-overlay-toggle]'));
  if (!buttons.length) return;
  const validKeys = new Set(Object.keys(state.chartOverlayVisibility || {}));
  const saved = _loadChartOverlayVisibilityPrefs();
  if (saved) {
    for (const [key, value] of Object.entries(saved)) {
      if (!validKeys.has(key) || typeof value !== 'boolean') continue;
      state.chartOverlayVisibility[key] = value;
    }
  }

  const syncButtonStates = () => {
    for (const btn of buttons) {
      const key = String(btn.getAttribute('data-overlay-toggle') || '');
      const on = state.chartOverlayVisibility[key] !== false;
      btn.classList.toggle('is-off', !on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    for (const el of document.querySelectorAll('[data-overlay-hint-for]')) {
      const key = String(el.getAttribute('data-overlay-hint-for') || '');
      if (!(key in state.chartOverlayVisibility)) continue;
      const on = state.chartOverlayVisibility[key] !== false;
      el.classList.toggle('is-off', !on);
    }
  };

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const key = String(btn.getAttribute('data-overlay-toggle') || '');
      if (!(key in state.chartOverlayVisibility)) return;
      state.chartOverlayVisibility[key] = !(state.chartOverlayVisibility[key] !== false);
      _saveChartOverlayVisibilityPrefs();
      syncButtonStates();
      drawPriceChart();
    });
  }

  syncButtonStates();
}

function bindVelocityLegendExplainers() {
  const legend = document.querySelector('.profile-legend');
  if (!legend) return;
  const explainerTargets = Array.from(legend.querySelectorAll('[data-explainer-key]'));
  if (!explainerTargets.length) return;
  const tooltip = document.getElementById('velocityLegendExplainerTooltip');
  if (!tooltip) return;

  const explainers = {
    'regime-lane': {
      title: 'Regime lane',
      body: [
        'Top row = jitter regime (price geometry: chop vs directional).',
        'Bottom row = conviction regime (order flow: sustained pressure vs flipping).',
        'Read top-down: what is price doing, then what is flow doing.',
        'Computed from rolling 200-bar percentile buckets (Low/Mid/High terciles).',
      ],
    },
    'trade-dots': {
      title: 'Trade dots',
      body: [
        '<span class="velocity-inline-dot velocity-inline-dot--fav"></span> favorable (clean trend context).',
        '<span class="velocity-inline-dot velocity-inline-dot--avoid"></span> avoid (high jitter + low conviction, chop/no edge).',
        '<span class="velocity-inline-dot velocity-inline-dot--watch"></span> watch (high jitter + high conviction, one-sided pressure).',
        'No dot does not mean missing data; most bars are intentionally unmarked.',
      ],
    },
  };

  // Disable legacy native browser tooltips (`title`) on explainer targets;
  // they visually collide with our custom hover/click explainers.
  for (const target of explainerTargets) {
    const title = target.getAttribute('title');
    if (title) {
      if (!target.getAttribute('aria-label')) target.setAttribute('aria-label', title);
      target.removeAttribute('title');
    }
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const renderExplainer = (key) => {
    const ex = explainers[key];
    if (!ex) return '';
    return `<div class="velocity-explainer-block"><div class="velocity-explainer-title">${esc(ex.title)}</div>${ex.body.map((row) => `<div class="velocity-explainer-row">${row}</div>`).join('')}</div>`;
  };

  let pinnedKey = null;
  let pinnedTarget = null;

  const placeTooltipNear = (target) => {
    const rect = target.getBoundingClientRect();
    const ttW = tooltip.offsetWidth || 320;
    const ttH = tooltip.offsetHeight || 140;
    const pad = 10;
    let left = rect.right + 12;
    let top = rect.top - 4;
    if (left + ttW > window.innerWidth - 8) left = rect.left - ttW - 12;
    if (left < 8) left = 8;
    if (top + ttH > window.innerHeight - 8) top = window.innerHeight - ttH - 8;
    if (top < 8) top = 8;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.transform = 'none';
    tooltip.style.position = 'fixed';
  };

  const showTooltip = (target, key, { pin = false } = {}) => {
    const html = renderExplainer(key);
    if (!html) return;
    tooltip.innerHTML = html;
    tooltip.classList.add('visible');
    tooltip.setAttribute('aria-hidden', 'false');
    placeTooltipNear(target);
    if (pin) {
      pinnedKey = key;
      pinnedTarget = target;
      tooltip.classList.add('is-pinned');
    }
  };

  const hideTooltip = () => {
    pinnedKey = null;
    pinnedTarget = null;
    tooltip.classList.remove('visible', 'is-pinned');
    tooltip.setAttribute('aria-hidden', 'true');
    tooltip.innerHTML = '';
  };

  const syncPinnedTooltip = () => {
    if (!pinnedKey || !pinnedTarget || !document.contains(pinnedTarget)) return;
    showTooltip(pinnedTarget, pinnedKey, { pin: true });
  };

  for (const target of explainerTargets) {
    target.addEventListener('mouseenter', () => {
      const key = String(target.getAttribute('data-explainer-key') || '');
      if (!key || pinnedKey) return;
      showTooltip(target, key, { pin: false });
    });
    target.addEventListener('mouseleave', () => {
      if (pinnedKey) return;
      hideTooltip();
    });
    target.addEventListener('focus', () => {
      const key = String(target.getAttribute('data-explainer-key') || '');
      if (!key || pinnedKey) return;
      showTooltip(target, key, { pin: false });
    });
    target.addEventListener('blur', () => {
      if (pinnedKey) return;
      hideTooltip();
    });
    target.addEventListener('click', (e) => {
      const key = String(target.getAttribute('data-explainer-key') || '');
      if (!key) return;
      if (pinnedKey === key && pinnedTarget === target) {
        hideTooltip();
      } else {
        showTooltip(target, key, { pin: true });
      }
      e.stopPropagation();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (pinnedKey) hideTooltip();
    }
  });
  document.addEventListener('click', (e) => {
    if (pinnedKey && !tooltip.contains(e.target) && !explainerTargets.some((el) => el.contains(e.target))) {
      hideTooltip();
    }
  });
  window.addEventListener('resize', () => {
    syncPinnedTooltip();
  });
}

function onChartPanSliderInput() {
  const sl = document.getElementById('chartPanSlider');
  if (!sl || state.replay.mode !== 'real') return;
  _setViewEnd(parseInt(sl.value, 10));
  _updateChartPanTooltip(true);
}
(() => {
  const panEl = document.getElementById('chartPanSlider');
  if (!panEl) return;
  panEl.addEventListener('input', onChartPanSliderInput);
  panEl.addEventListener('change', onChartPanSliderInput);
  panEl.addEventListener('pointerdown', () => _updateChartPanTooltip(true));
  panEl.addEventListener('mousemove', () => _updateChartPanTooltip(true));
  panEl.addEventListener('mouseenter', () => _updateChartPanTooltip(true));
  panEl.addEventListener('focus', () => _updateChartPanTooltip(true));
  panEl.addEventListener('blur', _hideChartPanTooltip);
  panEl.addEventListener('mouseleave', () => {
    if (document.activeElement !== panEl) _hideChartPanTooltip();
  });
  window.addEventListener('pointerup', () => {
    if (document.activeElement !== panEl) _hideChartPanTooltip();
  });
  window.addEventListener('resize', () => _updateChartPanTooltip(false));
})();
document.getElementById('streamBtn').addEventListener('click', toggleStream);
document.getElementById('resetBtn').addEventListener('click', resetStream);
document.getElementById('speedSlider').addEventListener('input', onSpeedChange);
document.getElementById('fireDetailsBtn').addEventListener('click', openFireDetails);
document.getElementById('fireDismissBtn').addEventListener('click', dismissFire);
document.getElementById('liveEdgeBtn').addEventListener('click', returnToLiveEdge);
{
  const signalGlossarySection = document.getElementById('signalGlossarySection');
  if (signalGlossarySection) {
    signalGlossarySection.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-modal]');
      if (!btn || !signalGlossarySection.contains(btn)) return;
      const key = btn.getAttribute('data-modal');
      if (key) openModal(key);
    });
  }
}
document.getElementById('modalOverlay').addEventListener('click', onOverlayClick);
document.getElementById('modalPanel').addEventListener('click', (e) => e.stopPropagation());
document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
bindPlaybackHotkeys();

// Regime-DB plan §3b/§3c: matrix range selector + Heatmap|Posterior
// toggle. Wired here (and not inside buildMatrix) because the buttons
// live in static HTML — buildMatrix only owns the 5x5 cell grid.
bindMatrixRangeUI();

// Regime-DB plan §4b/§4c-d: brushing-and-linking handlers.
//   - matrix cell clicks  → state.selection.cells
//   - event-log fire rows → state.selection (kind=fire)
//   - Esc                 → clear selection
bindSelectionUI();
bindEventLogClicks();
bindBacktestUI();
bindChartOverlayLegendToggles();
bindVelocityLegendExplainers();
bindDivergenceNavUI();

document.addEventListener('orderflow:section-collapse', (ev) => {
  if (ev.detail?.sectionKey !== 'delta') return;
  syncDeltaSectionPanelsFromCollapse();
  drawPriceChart();
  drawFlowChart();
  drawCvdChart();
  redrawChartDrawOverlay();
  syncDivergenceNavButtons();
});

// The /occupancy fetch is async; when a fresh response lands we want to
// repaint the matrix (so the heatmap layer fills in) without coupling
// the matrix renderer to the replay/step loop. matrix.js fires this
// event from within renderMatrix() after kicking off a fetch, and the
// occupancy module resolves the cached read on the next render pass.
window.addEventListener('orderflow:matrix-repaint', () => repaintMatrix());
window.addEventListener('orderflow:chart-view', () => syncDivergenceNavButtons());
window.addEventListener('orderflow:replay-ready', async () => {
  await restoreDisplayStateFromUrl();
  restoreSelectionFromUrl();
  renderBacktestPanel();
  syncDivergenceNavButtons();
});

/**
 * Bounds POST /api/backtest/run sends as `from`/`to`.
 * Prefer replay.dateRange after successful API bar load; if missing (race before replay-ready,
 * or stale gate), fall back to GET /date-range for this timeframe so historical DuckDB windows
 * are used instead of a bogus rolling last-24h clock slice.
 */
async function _resolveBacktestWindowIso(timeframe) {
  const dr = state.replay.dateRange;
  if (dr?.min && dr?.max) {
    return { from: dr.min, to: dr.max };
  }
  const base = String(state.replay.apiBase || '').replace(/\/+$/, '');
  if (base) {
    try {
      const tf = timeframe || state.activeTimeframe || '1m';
      const r = await fetch(
        `${base}/date-range?timeframe=${encodeURIComponent(tf)}`,
        { cache: 'no-store' },
      );
      if (r.ok) {
        const j = await r.json();
        if (j.min && j.max) return { from: j.min, to: j.max };
      }
    } catch (_) { /* noop */ }
  }
  const now = new Date();
  const from = new Date(now.getTime() - (24 * 60 * 60 * 1000));
  return {
    from: from.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    to: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function _emptyCompareUnfiltered() {
  return {
    runId: null,
    stats: null,
    equity: [],
    benchmark: [],
    trades: [],
    skipped: { summary: {}, rows: [] },
  };
}

async function _hydrateNullHypothesisFromFilteredRun(filteredRun) {
  state.backtest.nullHypothesis = null;
  const requested = !!state.backtest.runParams.nullHypothesis;
  const raw =
    filteredRun?.nullHypothesis ??
    filteredRun?.null_hypothesis ??
    null;
  if (!raw || typeof raw !== 'object') {
    if (requested) {
      console.warn(
        '[orderflow] Null hypothesis was checked but POST /api/backtest/run returned no nullHypothesis block. Use an API build that includes null_hypothesis handling, or confirm the request body sends null_hypothesis: true.',
      );
    }
    return;
  }
  if (raw.skipped === true) {
    state.backtest.nullHypothesis = { skipped: true, reason: raw.reason || 'unknown' };
    return;
  }
  const nhRunId = raw.runId ?? raw.run_id;
  if (!nhRunId) {
    if (requested) console.warn('[orderflow] nullHypothesis block missing runId/run_id:', raw);
    return;
  }
  const [eqNh, skNh] = await Promise.all([
    fetchBacktestEquity(nhRunId),
    fetchBacktestSkippedFires(nhRunId),
  ]);
  const pts = eqNh.points ?? eqNh.equityPoints ?? [];
  if (requested && (!Array.isArray(pts) || pts.length < 2)) {
    console.warn(
      '[orderflow] Null hypothesis run',
      nhRunId,
      'returned fewer than 2 equity points; green curve will not render. GET /api/backtest/equity shape:',
      eqNh && typeof eqNh === 'object' ? Object.keys(eqNh) : eqNh,
    );
  }
  state.backtest.nullHypothesis = {
    runId: nhRunId,
    stats: raw,
    equity: Array.isArray(pts) ? pts : [],
    benchmark: eqNh.benchmark?.points || [],
    skipped: { summary: skNh.summary || {}, rows: skNh.rows || [] },
  };
}

function syncBacktestNullHypothesisEnabledUI() {
  const nhInput = document.getElementById('btNullHypothesis');
  const nhLabel = document.getElementById('btNullHypothesisLabel');
  const scopeInput = document.getElementById('btScope');
  if (!nhInput || !scopeInput) return;
  const scopeVal = String(scopeInput.value || '');
  const orbScope = scopeVal === 'orb';
  const ok = backtestScopeIsSingleWatch(scopeVal) && !orbScope;
  nhInput.disabled = !ok;
  nhLabel?.classList.toggle('bt-null-hypothesis--disabled', !ok);
}

function syncBacktestOrbScopeUI() {
  const gateSel = document.getElementById('btGateProfile');
  const scopeInput = document.getElementById('btScope');
  if (!gateSel || !scopeInput) return;
  const orbScope = String(scopeInput.value || '') === 'orb';
  gateSel.title = orbScope
    ? 'ORB uses 5m bars; rank gate uses ORB matrix cells when enabled.'
    : '';
}

/** Maps dashboard gate profile → API booleans. */
function gatesFromProfile(profile) {
  const p = String(profile || 'both').toLowerCase();
  if (p === 'none') return { rankGateEnabled: false, tradeContextGateEnabled: false };
  if (p === 'rank_only') return { rankGateEnabled: true, tradeContextGateEnabled: false };
  if (p === 'trade_context_only') return { rankGateEnabled: false, tradeContextGateEnabled: true };
  return { rankGateEnabled: true, tradeContextGateEnabled: true };
}

function parseTradeContextAllowedStr(str) {
  const raw = String(str ?? '').trim();
  if (!raw) return ['favorable'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function syncBacktestCompareFourLegend() {
  const leg = document.getElementById('btLegendCompareFour');
  if (!leg) return;
  leg.hidden = !state.backtest.compareFour?.runs?.length;
}

/** Non-negative finite ticks from Performance input, or `undefined` when blank (omit from POST → defaults merge). */
function _optionalTicksFromInput(el) {
  if (!el) return undefined;
  const s = String(el.value ?? '').trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** If user typed a negative value, return an error string (Webull-style "-25" is not valid here). */
function _negativeBacktestTicksError(slEl, tpEl, gapEl) {
  const check = (el, label) => {
    if (!el) return null;
    const s = String(el.value ?? '').trim();
    if (s === '') return null;
    const n = Number(s);
    if (Number.isFinite(n) && n < 0) {
      return (
        `${label} cannot be negative. This backtest uses positive tick distances from the fill (adverse for stop, favorable for target), not signed order-ticket offsets. Example: 25 in Stop loss = 25 ticks against the position.`
      );
    }
    return null;
  };
  return check(slEl, 'Stop loss (ticks)') || check(tpEl, 'Take profit (ticks)') || check(gapEl, 'Gap guard (ticks)');
}

function bindBacktestUI() {
  const runBtn = document.getElementById('btRunBtn');
  const popoutBtn = document.getElementById('btPopoutBtn');
  const scopeInput = document.getElementById('btScope');
  const capInput = document.getElementById('btInitialCapital');
  const commInput = document.getElementById('btCommission');
  const slipInput = document.getElementById('btSlippage');
  const qtyInput = document.getElementById('btQty');
  const slTicksInput = document.getElementById('btStopLossTicks');
  const tpTicksInput = document.getElementById('btTakeProfitTicks');
  const gateProfileInput = document.getElementById('btGateProfile');
  const legacyStrictInput = document.getElementById('btLegacyStrictThresholds');
  const tcAllowedInput = document.getElementById('btTradeContextAllowed');
  const compareFourInput = document.getElementById('btCompareFourModes');
  const markersOnInput = document.getElementById('btShowMarkersOn');
  const showBuyHoldInput = document.getElementById('btShowBuyHold');
  const nhInput = document.getElementById('btNullHypothesis');
  const execFlip = document.getElementById('btExecFlipOpposite');
  const execStop = document.getElementById('btExecStopLoss');
  const execTp = document.getElementById('btExecTakeProfit');
  const execEnd = document.getElementById('btExecEndWindow');
  const execNextBar = document.getElementById('btExecNextBarOpen');
  const gapGuardInput = document.getElementById('btEntryGapGuardTicks');
  const regimeScaleInput = document.getElementById('btRegimeExitScale');
  const regimeModeInput = document.getElementById('btRegimeExitScaleMode');
  if (!runBtn || !scopeInput || !capInput || !commInput || !slipInput || !qtyInput || !markersOnInput) return;

  function syncRegimeRunParamsFromDom() {
    if (!regimeScaleInput || !regimeModeInput) return;
    state.backtest.runParams = {
      ...state.backtest.runParams,
      regimeExitScaleEnabled: !!regimeScaleInput.checked && !regimeScaleInput.disabled,
      regimeExitScaleMode:
        String(regimeModeInput.value || 'range_pct').trim().toLowerCase() === 'v_rank'
          ? 'v_rank'
          : 'range_pct',
    };
  }

  function syncGapGuardInputEnabled() {
    if (!gapGuardInput || !execNextBar) return;
    gapGuardInput.disabled = !execNextBar.checked;
  }

  function syncExecRunParamsFromDom() {
    const gapTicks = gapGuardInput ? _optionalTicksFromInput(gapGuardInput) : undefined;
    state.backtest.runParams = {
      ...state.backtest.runParams,
      flipOnOppositeFire: execFlip ? !!execFlip.checked : true,
      exitOnStopLoss: execStop ? !!execStop.checked : true,
      exitOnTakeProfit: execTp ? !!execTp.checked : true,
      closeAtEndWindow: execEnd ? !!execEnd.checked : true,
      entryNextBarOpen: execNextBar ? !!execNextBar.checked : false,
      entryGapGuardMaxTicks: gapTicks !== undefined ? gapTicks : null,
    };
  }
  if (popoutBtn) {
    const popoutMode = _isBacktestPopoutMode();
    popoutBtn.textContent = popoutMode ? 'Open Full Dashboard' : 'Pop Out';
    popoutBtn.title = popoutMode
      ? 'Open this dashboard without backtest-focus mode'
      : 'Open backtest panel in a larger dedicated window';
    popoutBtn.addEventListener('click', () => {
      if (popoutMode) {
        window.location.href = _setBacktestPopoutParam(window.location.href, false);
        return;
      }
      const targetUrl = _setBacktestPopoutParam(window.location.href, true);
      window.open(targetUrl, 'orderflow-backtest-popout', 'popup=yes,width=1540,height=920,resizable=yes,scrollbars=yes');
    });
  }
  function syncBtRunButtonEnabled() {
    syncBacktestRunButtonFromState();
  }
  state.backtest.runParams = {
    ...state.backtest.runParams,
    scope: String(scopeInput.value || ''),
  };
  if (gateProfileInput && state.backtest.runParams.gateProfile) {
    gateProfileInput.value = state.backtest.runParams.gateProfile;
  }
  if (legacyStrictInput) legacyStrictInput.checked = state.backtest.runParams.legacyStrictThresholds !== false;
  if (tcAllowedInput && state.backtest.runParams.tradeContextAllowedStr != null) {
    tcAllowedInput.value = state.backtest.runParams.tradeContextAllowedStr;
  }
  if (compareFourInput) compareFourInput.checked = !!state.backtest.runParams.compareFourModes;
  markersOnInput.checked = state.backtest.runParams.showMarkersOn !== false;
  if (showBuyHoldInput) showBuyHoldInput.checked = state.backtest.runParams.showBuyHold !== false;
  if (nhInput) nhInput.checked = !!state.backtest.runParams.nullHypothesis;
  syncBacktestOrbScopeUI();
  syncBacktestCompareFourLegend();
  syncBacktestNullHypothesisEnabledUI();
  syncExecRunParamsFromDom();
  syncGapGuardInputEnabled();
  syncRegimeExitScaleControlsMutualExclusion();
  syncRegimeRunParamsFromDom();
  function onSlTpOrRegimeChange() {
    syncRegimeExitScaleControlsMutualExclusion();
    syncRegimeRunParamsFromDom();
    renderBacktestPanel();
  }
  if (slTicksInput) {
    slTicksInput.addEventListener('input', onSlTpOrRegimeChange);
    slTicksInput.addEventListener('change', onSlTpOrRegimeChange);
  }
  if (tpTicksInput) {
    tpTicksInput.addEventListener('input', onSlTpOrRegimeChange);
    tpTicksInput.addEventListener('change', onSlTpOrRegimeChange);
  }
  if (regimeScaleInput) {
    regimeScaleInput.addEventListener('change', () => {
      syncRegimeExitScaleControlsMutualExclusion();
      syncRegimeRunParamsFromDom();
      renderBacktestPanel();
    });
  }
  if (regimeModeInput) {
    regimeModeInput.addEventListener('change', () => {
      syncRegimeRunParamsFromDom();
      renderBacktestPanel();
    });
  }
  scopeInput.addEventListener('change', () => {
    state.backtest.runParams = {
      ...state.backtest.runParams,
      scope: String(scopeInput.value || ''),
    };
    syncBtRunButtonEnabled();
    syncBacktestOrbScopeUI();
    syncBacktestNullHypothesisEnabledUI();
    renderBacktestPanel();
  });
  syncBtRunButtonEnabled();
  if (gateProfileInput) {
    gateProfileInput.addEventListener('change', () => {
      state.backtest.runParams = {
        ...state.backtest.runParams,
        gateProfile: String(gateProfileInput.value || 'both'),
      };
      syncBacktestOrbScopeUI();
      renderBacktestPanel();
    });
  }
  if (legacyStrictInput) {
    legacyStrictInput.addEventListener('change', () => {
      state.backtest.runParams = {
        ...state.backtest.runParams,
        legacyStrictThresholds: !!legacyStrictInput.checked,
      };
      renderBacktestPanel();
    });
  }
  if (tcAllowedInput) {
    tcAllowedInput.addEventListener('change', () => {
      state.backtest.runParams = {
        ...state.backtest.runParams,
        tradeContextAllowedStr: String(tcAllowedInput.value || ''),
      };
      renderBacktestPanel();
    });
  }
  if (compareFourInput) {
    compareFourInput.addEventListener('change', () => {
      state.backtest.runParams = {
        ...state.backtest.runParams,
        compareFourModes: !!compareFourInput.checked,
      };
      renderBacktestPanel();
    });
  }
  markersOnInput.addEventListener('change', () => {
    state.backtest.runParams = {
      ...state.backtest.runParams,
      showMarkersOn: !!markersOnInput.checked,
    };
    drawPriceChart();
    renderBacktestPanel();
  });
  if (showBuyHoldInput) {
    showBuyHoldInput.addEventListener('change', () => {
      state.backtest.runParams = {
        ...state.backtest.runParams,
        showBuyHold: !!showBuyHoldInput.checked,
      };
      renderBacktestPanel();
    });
  }
  if (nhInput) {
    nhInput.addEventListener('change', () => {
      state.backtest.runParams = {
        ...state.backtest.runParams,
        nullHypothesis: !!nhInput.checked,
      };
      renderBacktestPanel();
    });
  }
  const execInputs = [execFlip, execStop, execTp, execEnd, execNextBar].filter(Boolean);
  for (const el of execInputs) {
    el.addEventListener('change', () => {
      if (el === execNextBar) syncGapGuardInputEnabled();
      syncExecRunParamsFromDom();
      renderBacktestPanel();
    });
  }
  if (gapGuardInput) {
    gapGuardInput.addEventListener('change', () => {
      syncExecRunParamsFromDom();
      renderBacktestPanel();
    });
  }

  const btTfSel = document.getElementById('btTimeframe');
  if (btTfSel) {
    btTfSel.addEventListener('change', async () => {
      const tf = btTfSel.value;
      if (!TIMEFRAMES.includes(tf)) return;
      const avail = new Set(state.availableTimeframes?.length ? state.availableTimeframes : TIMEFRAMES);
      if (!avail.has(tf)) return;
      if (state.replay.mode === 'real' && state.replay.apiBase) {
        await setActiveTimeframe(tf);
      } else {
        state.activeTimeframe = tf;
        _syncTimeframeSelectorUI();
        drawPriceChart();
        syncBacktestTimeframeSelect();
      }
      renderBacktestPanel();
    });
  }

  runBtn.addEventListener('click', async () => {
    if (state.backtest.loading) return;
    if (!String(scopeInput.value || '').trim()) return;
    const negErr = _negativeBacktestTicksError(slTicksInput, tpTicksInput, gapGuardInput);
    if (negErr) {
      state.backtest.error = negErr;
      renderBacktestPanel();
      return;
    }
    state.backtest.loading = true;
    syncBtRunButtonEnabled();
    state.backtest.error = null;
    state.backtest.nullHypothesis = null;
    state.backtest.compareFour = null;
    const slTicks = _optionalTicksFromInput(slTicksInput);
    const tpTicks = _optionalTicksFromInput(tpTicksInput);
    syncExecRunParamsFromDom();
    const flipOnOpposite = execFlip ? !!execFlip.checked : true;
    const exitStopLoss = execStop ? !!execStop.checked : true;
    const exitTakeProfit = execTp ? !!execTp.checked : true;
    const closeEndWin = execEnd ? !!execEnd.checked : true;
    const entryNextBarOpen = execNextBar ? !!execNextBar.checked : false;
    const gapGuardTicks = gapGuardInput ? _optionalTicksFromInput(gapGuardInput) : undefined;
    syncRegimeExitScaleControlsMutualExclusion();
    const regimeScaleEl = document.getElementById('btRegimeExitScale');
    const regimeModeEl = document.getElementById('btRegimeExitScaleMode');
    const regimeScaleActive =
      regimeScaleEl && regimeScaleEl.checked && !regimeScaleEl.disabled;
    const regimeMode =
      regimeModeEl && String(regimeModeEl.value || 'range_pct').trim().toLowerCase() === 'v_rank'
        ? 'v_rank'
        : 'range_pct';
    state.backtest.runParams = {
      scope: String(scopeInput.value || 'all'),
      gateProfile: gateProfileInput ? String(gateProfileInput.value || 'both') : 'both',
      legacyStrictThresholds: legacyStrictInput ? !!legacyStrictInput.checked : true,
      tradeContextAllowedStr: tcAllowedInput ? String(tcAllowedInput.value || '') : 'favorable',
      compareFourModes: compareFourInput ? !!compareFourInput.checked : false,
      showMarkersOn: !!markersOnInput.checked,
      showBuyHold: showBuyHoldInput ? !!showBuyHoldInput.checked : true,
      nullHypothesis: nhInput ? !!nhInput.checked : false,
      initialCapital: Number(capInput.value || 50000),
      commissionPerSide: Number(commInput.value || 2),
      slippageTicks: Number(slipInput.value || 1),
      qty: Math.max(1, Math.floor(Number(qtyInput.value || state.backtest.runParams.qty || 1))),
      stopLossTicks: slTicks ?? null,
      takeProfitTicks: tpTicks ?? null,
      regimeExitScaleEnabled: !!regimeScaleActive,
      regimeExitScaleMode: regimeMode,
      flipOnOppositeFire: flipOnOpposite,
      exitOnStopLoss: exitStopLoss,
      exitOnTakeProfit: exitTakeProfit,
      closeAtEndWindow: closeEndWin,
      entryNextBarOpen,
      entryGapGuardMaxTicks: gapGuardTicks !== undefined ? gapGuardTicks : null,
    };
    syncBacktestCompareFourLegend();
    renderBacktestPanel();
    try {
      const defs = state.backtest.brokerDefaultsFromApi || {};
      const tickSize = Number.isFinite(Number(defs.tick_size)) && Number(defs.tick_size) > 0
        ? Number(defs.tick_size)
        : 0.25;
      const pointValue = Number.isFinite(Number(defs.point_value)) && Number(defs.point_value) > 0
        ? Number(defs.point_value)
        : 50;
      const btTfEl = document.getElementById('btTimeframe');
      const timeframe =
        btTfEl && btTfEl.value && TIMEFRAMES.includes(btTfEl.value)
          ? btTfEl.value
          : state.activeTimeframe || '1m';

      const { from, to } = await _resolveBacktestWindowIso(timeframe);

      const common = {
        from,
        to,
        timeframe,
        scope: state.backtest.runParams.scope,
        initialCapital: state.backtest.runParams.initialCapital,
        commissionPerSide: state.backtest.runParams.commissionPerSide,
        slippageTicks: state.backtest.runParams.slippageTicks,
        qty: state.backtest.runParams.qty,
        stopLossTicks: slTicks,
        takeProfitTicks: tpTicks,
        flipOnOppositeFire: flipOnOpposite,
        exitOnStopLoss: exitStopLoss,
        exitOnTakeProfit: exitTakeProfit,
        closeAtEndWindow: closeEndWin,
        entryNextBarOpen,
        entryGapGuardMaxTicks: entryNextBarOpen ? gapGuardTicks : undefined,
        tickSize,
        pointValue,
        ...(regimeScaleActive
          ? { regimeExitScaleEnabled: true, regimeExitScaleMode: regimeMode }
          : {}),
      };
      const legacyStrict = state.backtest.runParams.legacyStrictThresholds !== false;
      const tcList = parseTradeContextAllowedStr(tcAllowedInput?.value);
      const compareFourWant = !!state.backtest.runParams.compareFourModes;
      const nhWant = !!(
        state.backtest.runParams.nullHypothesis && backtestScopeIsSingleWatch(state.backtest.runParams.scope)
      );
      if (compareFourWant && nhWant) {
        throw new Error('Turn off “Compare all four gate modes” before running null hypothesis.');
      }
      const profileKey = state.backtest.runParams.gateProfile || 'both';
      const profileGates = gatesFromProfile(profileKey);
      if (nhWant && !profileGates.rankGateEnabled && !profileGates.tradeContextGateEnabled) {
        throw new Error(
          'Null hypothesis requires at least one entry gate — choose a gate profile other than “None”, ' +
            'or enable rank / trade context.',
        );
      }
      if (compareFourWant) {
        const MODE_ORDER = ['none', 'rank_only', 'trade_context_only', 'both'];
        const MODE_LABEL = {
          none: 'None',
          rank_only: 'Rank only',
          trade_context_only: 'Trade context only',
          both: 'Both',
        };
        const runs = await Promise.all(
          MODE_ORDER.map((key) => {
            const g = gatesFromProfile(key);
            return runBacktest({
              ...common,
              useRegimeFilter: legacyStrict,
              rankGateEnabled: g.rankGateEnabled,
              tradeContextGateEnabled: g.tradeContextGateEnabled,
              tradeContextAllowed: tcList,
              nullHypothesis: false,
            });
          }),
        );
        const eqRuns = await Promise.all(runs.map((r) => fetchBacktestEquity(r.runId)));
        const trRuns = await Promise.all(runs.map((r) => fetchBacktestTrades(r.runId)));
        const skRuns = await Promise.all(runs.map((r) => fetchBacktestSkippedFires(r.runId)));
        const packed = MODE_ORDER.map((key, i) => ({
          key,
          label: MODE_LABEL[key],
          runId: runs[i].runId,
          stats: runs[i],
          equity: eqRuns[i].points || [],
          trades: trRuns[i].trades || [],
          skipped: { summary: skRuns[i].summary || {}, rows: skRuns[i].rows || [] },
        }));
        state.backtest.compareFour = { runs: packed };
        const pi = Math.max(0, MODE_ORDER.indexOf(profileKey));
        const primary = packed.find((p) => p.key === profileKey) || packed[packed.length - 1];
        state.backtest.runId = primary.runId;
        state.backtest.stats = primary.stats;
        state.backtest.equity = primary.equity;
        state.backtest.trades = primary.trades;
        state.backtest.compare.filtered = {
          runId: primary.runId,
          stats: primary.stats,
          equity: primary.equity,
          benchmark: eqRuns[pi]?.benchmark?.points || [],
          trades: primary.trades,
          skipped: primary.skipped,
        };
        state.backtest.compare.unfiltered = _emptyCompareUnfiltered();
        state.backtest.error = null;
        state.backtest.lastRunScope = state.backtest.runParams.scope || null;
        syncBacktestCompareFourLegend();
        renderBacktestPanel();
      } else {
        const filteredRun = await runBacktest({
          ...common,
          useRegimeFilter: legacyStrict,
          rankGateEnabled: profileGates.rankGateEnabled,
          tradeContextGateEnabled: profileGates.tradeContextGateEnabled,
          tradeContextAllowed: tcList,
          nullHypothesis: nhWant,
        });
        const [eqA, trA, skA] = await Promise.all([
          fetchBacktestEquity(filteredRun.runId),
          fetchBacktestTrades(filteredRun.runId),
          fetchBacktestSkippedFires(filteredRun.runId),
          _hydrateNullHypothesisFromFilteredRun(filteredRun),
        ]);
        state.backtest.runId = filteredRun.runId;
        state.backtest.stats = filteredRun;
        state.backtest.equity = eqA.points || [];
        state.backtest.trades = trA.trades || [];
        state.backtest.compare.filtered = {
          runId: filteredRun.runId,
          stats: filteredRun,
          equity: eqA.points || [],
          benchmark: eqA.benchmark?.points || [],
          trades: trA.trades || [],
          skipped: { summary: skA.summary || {}, rows: skA.rows || [] },
        };
        state.backtest.compare.unfiltered = _emptyCompareUnfiltered();
        state.backtest.error = null;
        state.backtest.lastRunScope = state.backtest.runParams.scope || null;
        renderBacktestPanel();
      }
    } catch (err) {
      state.backtest.error = err?.message || 'Backtest failed.';
      renderBacktestPanel();
    } finally {
      state.backtest.loading = false;
      syncBtRunButtonEnabled();
      syncBacktestCompareFourLegend();
      renderBacktestPanel();
      // Trades land in `state.backtest.compare` but `renderBacktestPanel` does not
      // repaint the price canvas — refresh so E/X + entry–exit connectors show.
      drawPriceChart();
    }
  });
  renderBacktestPanel();
}
