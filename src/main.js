import { state } from './state.js';
import { evaluateAbsorptionWallCanonical, evaluateBreakoutCanonical, evaluateFadeCanonical, evaluateValueEdgeReject } from './analytics/canonical.js';
import { computeMatrixScores } from './analytics/regime.js';
import { bootstrapReplay, setActiveTimeframe } from './data/replay.js';
import { fetchBacktestEquity, fetchBacktestSkippedFires, fetchBacktestStats, fetchBacktestTrades, runBacktest } from './data/backtestApi.js';
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
function onChartPanSliderInput() {
  const sl = document.getElementById('chartPanSlider');
  if (!sl || state.replay.mode !== 'real') return;
  _setViewEnd(parseInt(sl.value, 10));
}
(() => {
  const panEl = document.getElementById('chartPanSlider');
  if (!panEl) return;
  panEl.addEventListener('input', onChartPanSliderInput);
  panEl.addEventListener('change', onChartPanSliderInput);
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

// The /occupancy fetch is async; when a fresh response lands we want to
// repaint the matrix (so the heatmap layer fills in) without coupling
// the matrix renderer to the replay/step loop. matrix.js fires this
// event from within renderMatrix() after kicking off a fetch, and the
// occupancy module resolves the cached read on the next render pass.
window.addEventListener('orderflow:matrix-repaint', () => repaintMatrix());
window.addEventListener('orderflow:replay-ready', async () => {
  await restoreDisplayStateFromUrl();
  restoreSelectionFromUrl();
  await refreshBacktestPanel();
});

async function refreshBacktestPanel(runId = null) {
  try {
    const stats = await fetchBacktestStats(runId);
    state.backtest.stats = stats;
    state.backtest.runId = stats.runId;
    const [equity, trades, skipped] = await Promise.all([
      fetchBacktestEquity(stats.runId),
      fetchBacktestTrades(stats.runId),
      fetchBacktestSkippedFires(stats.runId),
    ]);
    state.backtest.equity = equity.points || [];
    state.backtest.trades = trades.trades || [];
    state.backtest.compare.filtered = {
      runId: stats.runId,
      stats,
      equity: equity.points || [],
      benchmark: equity.benchmark?.points || [],
      trades: trades.trades || [],
      skipped: {
        summary: skipped.summary || {},
        rows: skipped.rows || [],
      },
    };
    state.backtest.compare.unfiltered = {
      runId: null, stats: null, equity: [], benchmark: [], trades: [], skipped: { summary: {}, rows: [] },
    };
    state.backtest.error = null;
  } catch (_) {
    // No prior run is a normal initial state.
  } finally {
    renderBacktestPanel();
  }
}

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

function bindBacktestUI() {
  const runBtn = document.getElementById('btRunBtn');
  const scopeInput = document.getElementById('btScope');
  const capInput = document.getElementById('btInitialCapital');
  const commInput = document.getElementById('btCommission');
  const slipInput = document.getElementById('btSlippage');
  const markersOnInput = document.getElementById('btShowMarkersOn');
  const markersOffInput = document.getElementById('btShowMarkersOff');
  if (!runBtn || !scopeInput || !capInput || !commInput || !slipInput || !markersOnInput || !markersOffInput) return;
  markersOnInput.checked = state.backtest.runParams.showMarkersOn !== false;
  markersOffInput.checked = state.backtest.runParams.showMarkersOff !== false;
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
    state.backtest.loading = true;
    state.backtest.error = null;
    state.backtest.runParams = {
      scope: String(scopeInput.value || 'all'),
      showMarkersOn: !!markersOnInput.checked,
      showMarkersOff: !!markersOffInput.checked,
      initialCapital: Number(capInput.value || 50000),
      commissionPerSide: Number(commInput.value || 2),
      slippageTicks: Number(slipInput.value || 1),
      qty: 1,
    };
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
      renderBacktestPanel();
    } catch (err) {
      state.backtest.error = err?.message || 'Backtest failed.';
      renderBacktestPanel();
    } finally {
      state.backtest.loading = false;
      renderBacktestPanel();
    }
  });
  renderBacktestPanel();
}
