import { MAX_BARS, TRAIL_LEN } from '../config/constants.js';
import { state } from '../state.js';
import { evaluateBreakoutCanonical, evaluateFadeCanonical } from '../analytics/canonical.js';
import { computeMatrixScores, deriveRegimeState } from '../analytics/regime.js';
import { _syncCurrentSession } from '../data/replay.js';
import { renderMatrix } from '../render/matrix.js';
import { drawPriceChart } from '../render/priceChart.js';
import { _hideTooltip } from './tooltip.js';
import { priceCanvas } from '../util/dom.js';
import { clamp } from '../util/math.js';

function _panAvailable() {
  return state.replay.mode === 'real' && state.replay.allBars.length > MAX_BARS;
}

function _currentViewEnd() {
  // Effective right-edge index when state.chartViewEnd is null (live tracking).
  return state.chartViewEnd !== null ? state.chartViewEnd : state.replay.cursor;
}

function _setViewEnd(idx) {
  const minEnd = Math.min(MAX_BARS, state.replay.allBars.length);
  const maxEnd = state.replay.allBars.length;
  const clamped = clamp(Math.round(idx), minEnd, maxEnd);
  // Snap back to live-edge tracking when the user pans all the way to the
  // current cursor — keeps subsequent streaming state.bars sliding in naturally.
  if (clamped === state.replay.cursor) {
    state.chartViewEnd = null;
  } else {
    state.chartViewEnd = clamped;
  }
  // Re-resolve the "current" session to whichever day the right edge now
  // sits in. Sync the dropdown so users see which day they've panned to.
  _syncCurrentSession();
  _syncSessionDropdown();
  drawPriceChart();
  // Keep the regime matrix synced to whatever bar the NOW line points at,
  // so the user can scroll through vol×depth states across the session.
  _refreshMatrixForView();
}

function _syncSessionDropdown() {
  if (state.replay.mode !== 'real' || !state.replay.current) return;
  const sel = document.getElementById('sessionSelect');
  if (sel && sel.value !== state.replay.current.file) sel.value = state.replay.current.file;
}

function returnToLiveEdge() {
  state.chartViewEnd = null;
  drawPriceChart();
  _refreshMatrixForView();   // resyncs matrix to live state on un-pan
}

function _refreshMatrixForView() {
  if (state.replay.mode !== 'real') return;
  const panned = state.chartViewEnd !== null && state.chartViewEnd !== state.replay.cursor;

  // Live: just re-render with the current live state.
  if (!panned) {
    state.matrixScores = computeMatrixScores();
    const b = evaluateBreakoutCanonical();
    const f = evaluateFadeCanonical();
    renderMatrix(b, f);
    return;
  }

  // Panned: temporarily override state.sim/state.trail/state.matrixScores for one render pass.
  const idx = clamp(state.chartViewEnd - 1, 0, state.replay.allBars.length - 1);
  const reg = deriveRegimeState(idx);

  const savedTrail = state.trail.slice();
  const savedMatrix = state.matrixScores;
  const savedVol = state.sim.volState;
  const savedDepth = state.sim.depthState;

  // Rebuild state.trail from regime states at the most recent ~60 state.bars leading up
  // to and including idx. Each unique (r, c) cell is appended; ties to the
  // last appended cell are skipped so the state.trail shows transitions, not dwell.
  // Warmup bars (first ~30 of each session, plus any zero-volume bar) yield
  // null from deriveRegimeState — skip them so the trail represents only the
  // bars where ranks were actually resolved.
  state.trail.length = 0;
  const startIdx = Math.max(0, idx - 60);
  let lastR = null, lastC = null;
  for (let i = startIdx; i <= idx; i++) {
    const r2 = deriveRegimeState(i);
    if (!r2) continue;
    const r = 4 - r2.volState;
    const c = r2.depthState;
    if (r !== lastR || c !== lastC) {
      state.trail.push({ r, c });
      if (state.trail.length > TRAIL_LEN) state.trail.shift();
      lastR = r; lastC = c;
    }
  }

  // If the panned right-edge bar itself is in warmup (`reg === null`), keep
  // the live state.sim values so computeMatrixScores still has a kernel
  // center to work with. The matrix will read as "live snapshot" for that
  // pan position, which is the least-bad fallback — alternatives (skipping
  // the matrix entirely or zeroing the kernel) produce a visually broken
  // panel that's worse than a slightly stale one.
  if (reg) {
    state.sim.volState = reg.volState;
    state.sim.depthState = reg.depthState;
  }
  state.matrixScores = computeMatrixScores();

  // Use live canonical evaluation for the fired-class indicators (panning the
  // chart shouldn't rewrite the live watch panels). The matrix highlight,
  // state.trail, and confidence still come from the panned state above.
  state.sim.volState = savedVol;
  state.sim.depthState = savedDepth;
  const b = evaluateBreakoutCanonical();
  const f = evaluateFadeCanonical();
  renderMatrix(b, f);

  // Restore live render state for the next live tick.
  state.trail.length = 0;
  for (const t of savedTrail) state.trail.push(t);
  state.matrixScores = savedMatrix;
}

function _continuePan(e) {
  if (!state.isPanningChart) return;
  const rect = priceCanvas.getBoundingClientRect();
  const dx = (e.clientX - rect.left) - _panStartX;
  if (Math.abs(dx) > 2) _panMovedDuringDown = true;
  // Drag-right = look further into the past (decrease viewEnd); drag-left = forward.
  const barsDelta = -dx / _panSlotW;
  _setViewEnd(_panStartViewEnd + barsDelta);
}

let _panStartX = 0;
let _panStartViewEnd = null;
let _panSlotW = 1;
let _panMovedDuringDown = false;

// Click-vs-drag arbiter: tooltip click handler asks whether the just-released
// mousedown crossed the drag threshold. If so, suppress the click → modal-open
// chain so panning can't accidentally open modals. Always clears the flag.
function consumePanMoved() {
  const moved = _panMovedDuringDown;
  _panMovedDuringDown = false;
  return moved;
}




// Set the dropdown selection to whatever session is currently "current"
// (right-edge / NOW). Cheap; safe to call from any render path. No-op if the
// dropdown isn't on screen yet (e.g. during bootstrap).


// Synchronize the regime matrix to whatever the chart's "NOW" line is pointing
// at:
//   - At live edge: matrix already reflects state.sim.volState/depthState (live); we
//     re-render to ensure it's clean (handles return-from-pan transitions).
//   - When panned: derive volState/depthState at allBars[viewEnd-1], rebuild
//     a session-quintile state.trail leading up to that bar, recompute state.matrixScores
//     with that cell as the kernel center, and re-render — without disturbing
//     the live `state.sim`/`state.trail`/`state.matrixScores` state used by the ongoing
//     state.replay/streaming pipeline.

priceCanvas.addEventListener('wheel', (e) => {
  if (!_panAvailable()) return;
  e.preventDefault();
  // Normalize: deltaX (horizontal trackpads) takes precedence; otherwise use
  // deltaY so a normal mouse wheel pans horizontally over history.
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const step = delta > 0 ? 3 : -3;   // 3 state.bars per wheel notch
  _setViewEnd(_currentViewEnd() + step);
}, { passive: false });

priceCanvas.addEventListener('mousedown', (e) => {
  if (!_panAvailable()) return;
  if (e.button !== 0) return;
  state.isPanningChart = true;
  _panMovedDuringDown = false;
  const rect = priceCanvas.getBoundingClientRect();
  _panStartX = e.clientX - rect.left;
  _panStartViewEnd = _currentViewEnd();
  // Estimate slot width once at drag-start (matches drawPriceChart logic).
  const PROFILE_W = Math.min(110, rect.width * 0.22);
  const chartW = rect.width - PROFILE_W - 6 - 8 - 8;
  _panSlotW = chartW / Math.max(MAX_BARS, 12);
  priceCanvas.classList.add('panning');
  _hideTooltip();
});


window.addEventListener('mouseup', () => {
  if (!state.isPanningChart) return;
  state.isPanningChart = false;
  priceCanvas.classList.remove('panning');
});

// ───────────────────────────────────────────────────────────

export { _panAvailable, _currentViewEnd, _setViewEnd, _syncSessionDropdown, returnToLiveEdge, _refreshMatrixForView, _continuePan, consumePanMoved };
