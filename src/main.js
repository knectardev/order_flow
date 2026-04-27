import { state } from './state.js';
import { evaluateBreakoutCanonical, evaluateFadeCanonical } from './analytics/canonical.js';
import { computeMatrixScores } from './analytics/regime.js';
import { bootstrapReplay, onScrubberCommit, onScrubberInput, onSessionChange, seekStep } from './data/replay.js';
import { drawFlowChart } from './render/flowChart.js';
import { buildMatrix, renderMatrix } from './render/matrix.js';
import { drawPriceChart } from './render/priceChart.js';
import { renderBreakoutWatch, renderFadeWatch } from './render/watch.js';
import { onSpeedChange, resetStream, toggleStream } from './ui/controls.js';
import { dismissFire, openFireDetails } from './ui/fireBanner.js';
import { bindMatrixRangeUI, repaintMatrix } from './ui/matrixRange.js';
import { closeModal, onOverlayClick, openModal } from './ui/modal.js';
import { returnToLiveEdge } from './ui/pan.js';
import { bindSelectionUI } from './ui/selection.js';
import { bindEventLogClicks } from './render/eventLog.js';

// ───────────────────────────────────────────────────────────
buildMatrix();
state.matrixScores = computeMatrixScores();
const initialBreakout = evaluateBreakoutCanonical();
const initialFade     = evaluateFadeCanonical();
renderMatrix(initialBreakout, initialFade);
renderBreakoutWatch(initialBreakout);
renderFadeWatch(initialFade);
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


// ───────────────────────────────────────────────────────────
// DOM event wiring (replaces inline on*= handlers stripped from HTML).
// Kept at the bottom of the file so all referenced functions are defined.
// ───────────────────────────────────────────────────────────
document.getElementById('sessionSelect').addEventListener('change', onSessionChange);
document.getElementById('seekPrevBtn').addEventListener('click', () => seekStep(-1));
document.getElementById('seekNextBtn').addEventListener('click', () => seekStep(+1));
document.getElementById('scrubber').addEventListener('input',  onScrubberInput);
document.getElementById('scrubber').addEventListener('change', onScrubberCommit);
document.getElementById('streamBtn').addEventListener('click', toggleStream);
document.getElementById('resetBtn').addEventListener('click', resetStream);
document.getElementById('speedSlider').addEventListener('input', onSpeedChange);
document.getElementById('fireDetailsBtn').addEventListener('click', openFireDetails);
document.getElementById('fireDismissBtn').addEventListener('click', dismissFire);
document.getElementById('liveEdgeBtn').addEventListener('click', returnToLiveEdge);
document.querySelectorAll('.glossary-list li[data-modal]').forEach(li =>
  li.addEventListener('click', () => openModal(li.dataset.modal))
);
document.getElementById('modalOverlay').addEventListener('click', onOverlayClick);
document.getElementById('modalPanel').addEventListener('click', (e) => e.stopPropagation());
document.getElementById('modalCloseBtn').addEventListener('click', closeModal);

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
