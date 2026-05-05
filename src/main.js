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

function bindChartOverlayLegendToggles() {
  const buttons = Array.from(document.querySelectorAll('[data-overlay-toggle]'));
  if (!buttons.length) return;

  const syncButtonStates = () => {
    for (const btn of buttons) {
      const key = String(btn.getAttribute('data-overlay-toggle') || '');
      const on = state.chartOverlayVisibility[key] !== false;
      btn.classList.toggle('is-off', !on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const key = String(btn.getAttribute('data-overlay-toggle') || '');
      if (!(key in state.chartOverlayVisibility)) return;
      state.chartOverlayVisibility[key] = !(state.chartOverlayVisibility[key] !== false);
      syncButtonStates();
      drawPriceChart();
    });
  }

  syncButtonStates();
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

function _windowBoundsIso() {
  if (state.replay.mode === 'real' && state.replay.dateRange?.min && state.replay.dateRange?.max) {
    return { from: state.replay.dateRange.min, to: state.replay.dateRange.max };
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
  const ok = backtestScopeIsSingleWatch(String(scopeInput.value || ''));
  nhInput.disabled = !ok;
  nhLabel?.classList.toggle('bt-null-hypothesis--disabled', !ok);
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

/** Reflects compare-regime-OFF toggle: legend, OFF markers row, and stale OFF run data when disabled. */
function syncBacktestCompareRegimeOffUI() {
  const compareInput = document.getElementById('btCompareRegimeOff');
  const legendOff = document.getElementById('btLegendRegimeOff');
  const markersOffLabel = document.getElementById('btMarkersOffLabel');
  const markersOffInput = document.getElementById('btShowMarkersOff');
  if (!compareInput) return;
  const on = !!state.backtest.runParams.compareRegimeOff;
  compareInput.checked = on;
  if (legendOff) legendOff.hidden = !on;
  if (markersOffLabel) markersOffLabel.hidden = !on;
  if (markersOffInput) {
    markersOffInput.disabled = !on;
    markersOffInput.checked = on && state.backtest.runParams.showMarkersOff !== false;
  }
  if (!on) {
    state.backtest.runParams = {
      ...state.backtest.runParams,
      showMarkersOff: false,
    };
    state.backtest.compare.unfiltered = _emptyCompareUnfiltered();
  }
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
  const compareInput = document.getElementById('btCompareRegimeOff');
  const markersOnInput = document.getElementById('btShowMarkersOn');
  const markersOffInput = document.getElementById('btShowMarkersOff');
  const showBuyHoldInput = document.getElementById('btShowBuyHold');
  const nhInput = document.getElementById('btNullHypothesis');
  const execFlip = document.getElementById('btExecFlipOpposite');
  const execStop = document.getElementById('btExecStopLoss');
  const execTp = document.getElementById('btExecTakeProfit');
  const execEnd = document.getElementById('btExecEndWindow');
  const execNextBar = document.getElementById('btExecNextBarOpen');
  const gapGuardInput = document.getElementById('btEntryGapGuardTicks');
  if (!runBtn || !scopeInput || !capInput || !commInput || !slipInput || !qtyInput || !compareInput || !markersOnInput || !markersOffInput) return;

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
  markersOnInput.checked = state.backtest.runParams.showMarkersOn !== false;
  if (showBuyHoldInput) showBuyHoldInput.checked = state.backtest.runParams.showBuyHold !== false;
  if (nhInput) nhInput.checked = !!state.backtest.runParams.nullHypothesis;
  syncBacktestCompareRegimeOffUI();
  syncBacktestNullHypothesisEnabledUI();
  syncExecRunParamsFromDom();
  syncGapGuardInputEnabled();
  scopeInput.addEventListener('change', () => {
    state.backtest.runParams = {
      ...state.backtest.runParams,
      scope: String(scopeInput.value || ''),
    };
    syncBtRunButtonEnabled();
    syncBacktestNullHypothesisEnabledUI();
    renderBacktestPanel();
  });
  syncBtRunButtonEnabled();
  compareInput.addEventListener('change', () => {
    state.backtest.runParams = {
      ...state.backtest.runParams,
      compareRegimeOff: !!compareInput.checked,
    };
    syncBacktestCompareRegimeOffUI();
    drawPriceChart();
    renderBacktestPanel();
  });
  markersOnInput.addEventListener('change', () => {
    state.backtest.runParams = {
      ...state.backtest.runParams,
      showMarkersOn: !!markersOnInput.checked,
    };
    drawPriceChart();
    renderBacktestPanel();
  });
  markersOffInput.addEventListener('change', () => {
    state.backtest.runParams = {
      ...state.backtest.runParams,
      showMarkersOff: !!markersOffInput.checked,
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
    const slTicks = _optionalTicksFromInput(slTicksInput);
    const tpTicks = _optionalTicksFromInput(tpTicksInput);
    syncExecRunParamsFromDom();
    const flipOnOpposite = execFlip ? !!execFlip.checked : true;
    const exitStopLoss = execStop ? !!execStop.checked : true;
    const exitTakeProfit = execTp ? !!execTp.checked : true;
    const closeEndWin = execEnd ? !!execEnd.checked : true;
    const entryNextBarOpen = execNextBar ? !!execNextBar.checked : false;
    const gapGuardTicks = gapGuardInput ? _optionalTicksFromInput(gapGuardInput) : undefined;
    state.backtest.runParams = {
      scope: String(scopeInput.value || 'all'),
      compareRegimeOff: !!compareInput.checked,
      showMarkersOn: !!markersOnInput.checked,
      showMarkersOff: !!compareInput.checked && !!markersOffInput.checked,
      showBuyHold: showBuyHoldInput ? !!showBuyHoldInput.checked : true,
      nullHypothesis: nhInput ? !!nhInput.checked : false,
      initialCapital: Number(capInput.value || 50000),
      commissionPerSide: Number(commInput.value || 2),
      slippageTicks: Number(slipInput.value || 1),
      qty: Math.max(1, Math.floor(Number(qtyInput.value || state.backtest.runParams.qty || 1))),
      stopLossTicks: slTicks ?? null,
      takeProfitTicks: tpTicks ?? null,
      flipOnOppositeFire: flipOnOpposite,
      exitOnStopLoss: exitStopLoss,
      exitOnTakeProfit: exitTakeProfit,
      closeAtEndWindow: closeEndWin,
      entryNextBarOpen,
      entryGapGuardMaxTicks: gapGuardTicks !== undefined ? gapGuardTicks : null,
    };
    syncBacktestCompareRegimeOffUI();
    renderBacktestPanel();
    try {
      const { from, to } = _windowBoundsIso();
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
      };
      const doCompareOff = !!state.backtest.runParams.compareRegimeOff;
      const nhWant = !!(
        state.backtest.runParams.nullHypothesis && backtestScopeIsSingleWatch(state.backtest.runParams.scope)
      );
      if (!doCompareOff) {
        const filteredRun = await runBacktest({ ...common, useRegimeFilter: true, nullHypothesis: nhWant });
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
      } else {
        const [filteredRun, unfilteredRun] = await Promise.all([
          runBacktest({ ...common, useRegimeFilter: true, nullHypothesis: nhWant }),
          runBacktest({ ...common, useRegimeFilter: false, nullHypothesis: false }),
        ]);
        const [eqA, eqB, trA, trB, skA, skB] = await Promise.all([
          fetchBacktestEquity(filteredRun.runId),
          fetchBacktestEquity(unfilteredRun.runId),
          fetchBacktestTrades(filteredRun.runId),
          fetchBacktestTrades(unfilteredRun.runId),
          fetchBacktestSkippedFires(filteredRun.runId),
          fetchBacktestSkippedFires(unfilteredRun.runId),
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
        state.backtest.compare.unfiltered = {
          runId: unfilteredRun.runId,
          stats: unfilteredRun,
          equity: eqB.points || [],
          benchmark: eqB.benchmark?.points || [],
          trades: trB.trades || [],
          skipped: { summary: skB.summary || {}, rows: skB.rows || [] },
        };
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
      renderBacktestPanel();
    }
  });
  renderBacktestPanel();
}
