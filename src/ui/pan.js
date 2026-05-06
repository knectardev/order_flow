import { MAX_BARS, MIN_CHART_VISIBLE_BARS, MAX_CHART_VISIBLE_BARS, TRAIL_LEN } from '../config/constants.js';
import { state } from '../state.js';
import { evaluateAbsorptionWallCanonical, evaluateBreakoutCanonical, evaluateFadeCanonical, evaluateValueEdgeReject } from '../analytics/canonical.js';
import { computeMatrixScores, deriveRegimeState } from '../analytics/regime.js';
import { _syncCurrentSession, _renderReplayChrome, precomputeAllFires } from '../data/replay.js';
import { drawFlowChart } from '../render/flowChart.js';
import { drawCvdChart } from '../render/cvdChart.js';
import { renderMatrix } from '../render/matrix.js';
import { drawPriceChart } from '../render/priceChart.js';
import { _hideTooltip } from './tooltip.js';
import { priceCanvas } from '../util/dom.js';
import { clamp } from '../util/math.js';
import { isPhatLegendModalOpen } from './phatLegendModal.js';

function _panAvailable() {
  return state.replay.mode === 'real' && state.replay.allBars.length > MAX_BARS;
}

function _chartWheelZoomAvailable() {
  if (state.replay.mode === 'real') return state.replay.allBars.length > 0;
  return state.bars.length > 0 || !!state.formingBar;
}

function _maxChartVisibleBarsCap() {
  if (state.replay.mode !== 'real') {
    return Math.min(MAX_CHART_VISIBLE_BARS, state.bars.length + (state.formingBar ? 1 : 0));
  }
  const forming = state.formingBar ? 1 : 0;
  if (state.chartViewEnd !== null && state.chartViewEnd !== state.replay.cursor) {
    return Math.min(MAX_CHART_VISIBLE_BARS, state.chartViewEnd);
  }
  return Math.min(MAX_CHART_VISIBLE_BARS, state.replay.cursor + forming);
}

function _clampChartVisibleBars() {
  const hi = _maxChartVisibleBarsCap();
  state.chartVisibleBars = clamp(state.chartVisibleBars, MIN_CHART_VISIBLE_BARS, Math.max(hi, MIN_CHART_VISIBLE_BARS));
}

function _currentViewEnd() {
  // Effective right-edge index when state.chartViewEnd is null (live tracking).
  return state.chartViewEnd !== null ? state.chartViewEnd : state.replay.cursor;
}

function _setViewEnd(idx) {
  const minEnd = Math.min(state.chartVisibleBars, state.replay.allBars.length);
  const maxEnd = state.replay.allBars.length;
  const clamped = clamp(Math.round(idx), minEnd, maxEnd);
  // Snap back to live-edge tracking when the user pans all the way to the
  // current cursor — keeps subsequent streaming state.bars sliding in naturally.
  if (clamped === state.replay.cursor) {
    state.chartViewEnd = null;
    state.chartFutureBlankSlots = 0;
  } else {
    state.chartViewEnd = clamped;
  }
  _syncCurrentSession();
  // First time we leave the live edge, build the full-timeline fire list if
  // it is missing; otherwise the chart would fall back to the online ring
  // buffer and historical halos on screen would not match the viewport.
  const panned = state.chartViewEnd !== null && state.chartViewEnd !== state.replay.cursor;
  if (panned && !state.replay.allFires.length && state.replay.allBars.length) {
    precomputeAllFires();
  }
  drawPriceChart();
  drawFlowChart();
  drawCvdChart();
  if (state.replay.mode === 'real') _renderReplayChrome();
  // Keep the regime matrix synced to whatever bar the NOW line points at,
  // so the user can scroll through vol×depth states across the session.
  _refreshMatrixForView();
}

function returnToLiveEdge() {
  state.chartViewEnd = null;
  state.chartFutureBlankSlots = 0;
  drawPriceChart();
  drawFlowChart();
  drawCvdChart();
  _refreshMatrixForView();   // resyncs matrix to live state on un-pan
  if (state.replay.mode === 'real') _renderReplayChrome();
}

function _refreshMatrixForView() {
  if (state.replay.mode !== 'real') return;
  const panned = state.chartViewEnd !== null && state.chartViewEnd !== state.replay.cursor;

  // Live: just re-render with the current live state.
  if (!panned) {
    state.matrixScores = computeMatrixScores();
    const b = evaluateBreakoutCanonical();
    const f = evaluateFadeCanonical();
    const a = evaluateAbsorptionWallCanonical();
    const v = evaluateValueEdgeReject();
    renderMatrix(b, f, a, v);
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
  const a = evaluateAbsorptionWallCanonical();
  const v = evaluateValueEdgeReject();
  renderMatrix(b, f, a, v);

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
let _playheadDragStartFut = 0;
let _playheadDragStartMouseX = 0;
let _playheadDragMoved = false;

function _playheadGeomAllowsDrag() {
  return !!(state._chartStripGeom?.playheadDragAvailable);
}

function nearPriceChartPlayhead(cssX, cssY) {
  const g = state._chartStripGeom;
  if (!g?.playheadDragAvailable || !Number.isFinite(g.xPlayhead)) return false;
  if (cssY < g.stripTop || cssY > g.stripBottom) return false;
  return Math.abs(cssX - g.xPlayhead) <= 12;
}

function _continuePlayheadDrag(e) {
  const rect = priceCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const g = state._chartStripGeom;
  if (!g?.slotW) return;
  const dx = mx - _playheadDragStartMouseX;
  const slotDelta = Math.round(dx / g.slotW);
  const vbReq = clamp(state.chartVisibleBars, MIN_CHART_VISIBLE_BARS, MAX_CHART_VISIBLE_BARS);
  // Subtract slotDelta so the playhead tracks drag direction (right-drag ⇒ playhead moves right).
  state.chartFutureBlankSlots = clamp(_playheadDragStartFut - slotDelta, 0, vbReq - 1);
  if (Math.abs(dx) > 2) _playheadDragMoved = true;
  drawPriceChart();
  drawFlowChart();
  drawCvdChart();
  if (state.replay.mode === 'real') _renderReplayChrome();
}
/** True while pointer is over `#priceChart` — gates arrow-key pan. */
let _pointerOverPriceChart = false;

const CHART_ARROW_PAN_STEP = 3;

// Click-vs-drag arbiter: tooltip click handler asks whether the just-released
// mousedown crossed the drag threshold. If so, suppress the click → modal-open
// chain so panning can't accidentally open modals. Always clears the flag.
function consumePanMoved() {
  const moved = _panMovedDuringDown || _playheadDragMoved;
  _panMovedDuringDown = false;
  _playheadDragMoved = false;
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

priceCanvas.addEventListener('mouseenter', () => {
  _pointerOverPriceChart = true;
});
priceCanvas.addEventListener('mouseleave', () => {
  _pointerOverPriceChart = false;
});

document.addEventListener('keydown', (e) => {
  if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
  if (!_pointerOverPriceChart || !_panAvailable()) return;
  if (document.getElementById('modalOverlay')?.classList.contains('visible')) return;
  if (isPhatLegendModalOpen()) return;

  const target = e.target;
  const isEditable = target instanceof HTMLElement && (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
  if (isEditable) return;

  // ArrowLeft → viewport shifts right on screen (older bars); ArrowRight → toward live.
  // Matches drag: drag-right decreases viewEnd; drag-left increases viewEnd.
  e.preventDefault();
  const step = CHART_ARROW_PAN_STEP;
  const delta = e.code === 'ArrowLeft' ? -step : step;
  _setViewEnd(_currentViewEnd() + delta);
}, true);

/** Wheel zoom on the price strip — reusable when events originate from `#chartDrawOverlay`. */
function handlePriceChartWheelZoom(e) {
  if (!_chartWheelZoomAvailable()) return false;
  e.preventDefault();
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const step = 3;
  state.chartVisibleBars += delta > 0 ? step : -step;
  _clampChartVisibleBars();
  const mxFut = Math.max(0, state.chartVisibleBars - 1);
  state.chartFutureBlankSlots = clamp(state.chartFutureBlankSlots, 0, mxFut);
  drawPriceChart();
  drawFlowChart();
  drawCvdChart();
  if (state.replay.mode === 'real') _renderReplayChrome();
  return true;
}

priceCanvas.addEventListener('wheel', (e) => {
  handlePriceChartWheelZoom(e);
}, { passive: false });

priceCanvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const rect = priceCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  if (_playheadGeomAllowsDrag() && nearPriceChartPlayhead(mx, my)) {
    state.isDraggingPlayhead = true;
    _playheadDragStartFut = state.chartFutureBlankSlots;
    _playheadDragStartMouseX = mx;
    _playheadDragMoved = false;
    _hideTooltip();
    return;
  }
  if (!_panAvailable()) return;
  state.isPanningChart = true;
  _panMovedDuringDown = false;
  _panStartX = e.clientX - rect.left;
  _panStartViewEnd = _currentViewEnd();
  // Estimate slot width once at drag-start (matches drawPriceChart logic).
  const PROFILE_W = Math.min(110, rect.width * 0.22);
  const chartW = rect.width - PROFILE_W - 6 - 8 - 8;
  _panSlotW = chartW / Math.max(state.chartVisibleBars, 12);
  priceCanvas.classList.add('panning');
  _hideTooltip();
});


window.addEventListener('mouseup', () => {
  if (state.isDraggingPlayhead) state.isDraggingPlayhead = false;
  if (!state.isPanningChart) return;
  state.isPanningChart = false;
  priceCanvas.classList.remove('panning');
});

// ───────────────────────────────────────────────────────────

export {
  _panAvailable,
  _currentViewEnd,
  _setViewEnd,
  returnToLiveEdge,
  _refreshMatrixForView,
  _continuePan,
  _continuePlayheadDrag,
  consumePanMoved,
  handlePriceChartWheelZoom,
  nearPriceChartPlayhead,
};
