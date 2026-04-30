import { state } from './state.js';
import { evaluateAbsorptionWallCanonical, evaluateBreakoutCanonical, evaluateFadeCanonical, evaluateValueEdgeReject } from './analytics/canonical.js';
import { computeMatrixScores } from './analytics/regime.js';
import { _syncCandleModeSelectorUI, bootstrapReplay, setActiveTimeframe } from './data/replay.js';
import { fetchBacktestEquity, fetchBacktestSkippedFires, fetchBacktestTrades, runBacktest } from './data/backtestApi.js';
import { drawFlowChart } from './render/flowChart.js';
import { buildMatrix, renderMatrix } from './render/matrix.js';
import { restoreDisplayStateFromUrl } from './render/eventInventory.js';
import { drawPriceChart } from './render/priceChart.js';
import { renderBacktestPanel } from './render/backtestPanel.js';
import { renderAbsorptionWallWatch, renderBreakoutWatch, renderFadeWatch, renderValueEdgeRejectWatch } from './render/watch.js';
import { bindPlaybackHotkeys, onSpeedChange, resetStream, toggleStream } from './ui/controls.js';
import { dismissFire, openFireDetails } from './ui/fireBanner.js';
import { bindMatrixRangeUI, repaintMatrix } from './ui/matrixRange.js';
import { bindModalDrag, closeModal, onOverlayClick, openModal } from './ui/modal.js';
import { returnToLiveEdge, _setViewEnd } from './ui/pan.js';
import { bindSelectionUI, restoreSelectionFromUrl } from './ui/selection.js';
import { bindEventLogClicks } from './render/eventLog.js';
import { initSectionCollapse } from './ui/sectionCollapse.js';

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
drawPriceChart();
drawFlowChart();

window.addEventListener('resize', () => {
  drawPriceChart();
  drawFlowChart();
});

// Try to load real-data sessions from the FastAPI/DuckDB stack; falls
// back to synthetic mode silently when the page is opened without
// `?source=api` (regime-DB plan §2f retired the JSON-manifest fallback).
bootstrapReplay();
bindModalDrag();

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
initSectionCollapse();

// The /occupancy fetch is async; when a fresh response lands we want to
// repaint the matrix (so the heatmap layer fills in) without coupling
// the matrix renderer to the replay/step loop. matrix.js fires this
// event from within renderMatrix() after kicking off a fetch, and the
// occupancy module resolves the cached read on the next render pass.
window.addEventListener('orderflow:matrix-repaint', () => repaintMatrix());
window.addEventListener('orderflow:replay-ready', async () => {
  await restoreDisplayStateFromUrl();
  restoreSelectionFromUrl();
  renderBacktestPanel();
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
  const scopeInput = document.getElementById('btScope');
  const capInput = document.getElementById('btInitialCapital');
  const commInput = document.getElementById('btCommission');
  const slipInput = document.getElementById('btSlippage');
  const compareInput = document.getElementById('btCompareRegimeOff');
  const markersOnInput = document.getElementById('btShowMarkersOn');
  const markersOffInput = document.getElementById('btShowMarkersOff');
  if (!runBtn || !scopeInput || !capInput || !commInput || !slipInput || !compareInput || !markersOnInput || !markersOffInput) return;
  function syncBtRunButtonEnabled() {
    const scopeOk = !!String(scopeInput.value || '').trim();
    runBtn.disabled = !scopeOk || state.backtest.loading;
  }
  state.backtest.runParams = {
    ...state.backtest.runParams,
    scope: String(scopeInput.value || ''),
  };
  markersOnInput.checked = state.backtest.runParams.showMarkersOn !== false;
  syncBacktestCompareRegimeOffUI();
  scopeInput.addEventListener('change', () => {
    state.backtest.runParams = {
      ...state.backtest.runParams,
      scope: String(scopeInput.value || ''),
    };
    syncBtRunButtonEnabled();
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

  runBtn.addEventListener('click', async () => {
    if (state.backtest.loading) return;
    if (!String(scopeInput.value || '').trim()) return;
    state.backtest.loading = true;
    syncBtRunButtonEnabled();
    state.backtest.error = null;
    state.backtest.runParams = {
      scope: String(scopeInput.value || 'all'),
      compareRegimeOff: !!compareInput.checked,
      showMarkersOn: !!markersOnInput.checked,
      showMarkersOff: !!compareInput.checked && !!markersOffInput.checked,
      initialCapital: Number(capInput.value || 50000),
      commissionPerSide: Number(commInput.value || 2),
      slippageTicks: Number(slipInput.value || 1),
      qty: 1,
    };
    syncBacktestCompareRegimeOffUI();
    renderBacktestPanel();
    try {
      const { from, to } = _windowBoundsIso();
      const common = {
        from,
        to,
        timeframe: state.activeTimeframe || '1m',
        scope: state.backtest.runParams.scope,
        initialCapital: state.backtest.runParams.initialCapital,
        commissionPerSide: state.backtest.runParams.commissionPerSide,
        slippageTicks: state.backtest.runParams.slippageTicks,
        qty: state.backtest.runParams.qty,
      };
      const doCompareOff = !!state.backtest.runParams.compareRegimeOff;
      if (!doCompareOff) {
        const filteredRun = await runBacktest({ ...common, useRegimeFilter: true });
        const [eqA, trA, skA] = await Promise.all([
          fetchBacktestEquity(filteredRun.runId),
          fetchBacktestTrades(filteredRun.runId),
          fetchBacktestSkippedFires(filteredRun.runId),
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
          runBacktest({ ...common, useRegimeFilter: true }),
          runBacktest({ ...common, useRegimeFilter: false }),
        ]);
        const [eqA, eqB, trA, trB, skA, skB] = await Promise.all([
          fetchBacktestEquity(filteredRun.runId),
          fetchBacktestEquity(unfilteredRun.runId),
          fetchBacktestTrades(filteredRun.runId),
          fetchBacktestTrades(unfilteredRun.runId),
          fetchBacktestSkippedFires(filteredRun.runId),
          fetchBacktestSkippedFires(unfilteredRun.runId),
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
