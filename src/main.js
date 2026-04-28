import { state } from './state.js';
import { evaluateAbsorptionWallCanonical, evaluateBreakoutCanonical, evaluateFadeCanonical, evaluateValueEdgeReject } from './analytics/canonical.js';
import { computeMatrixScores } from './analytics/regime.js';
import { bootstrapReplay, setActiveTimeframe } from './data/replay.js';
import { drawFlowChart } from './render/flowChart.js';
import { buildMatrix, renderMatrix } from './render/matrix.js';
import { drawPriceChart } from './render/priceChart.js';
import { renderAbsorptionWallWatch, renderBreakoutWatch, renderFadeWatch, renderValueEdgeRejectWatch } from './render/watch.js';
import { bindPlaybackHotkeys, onSpeedChange, resetStream, toggleStream } from './ui/controls.js';
import { dismissFire, openFireDetails } from './ui/fireBanner.js';
import { bindMatrixRangeUI, repaintMatrix } from './ui/matrixRange.js';
import { bindModalDrag, closeModal, onOverlayClick, openModal } from './ui/modal.js';
import { returnToLiveEdge, _setViewEnd } from './ui/pan.js';
import { bindSelectionUI } from './ui/selection.js';
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

// The /occupancy fetch is async; when a fresh response lands we want to
// repaint the matrix (so the heatmap layer fills in) without coupling
// the matrix renderer to the replay/step loop. matrix.js fires this
// event from within renderMatrix() after kicking off a fetch, and the
// occupancy module resolves the cached read on the next render pass.
window.addEventListener('orderflow:matrix-repaint', () => repaintMatrix());
