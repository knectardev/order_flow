// Prev / next navigation for persisted pipeline CVD–price divergences
// (`replay.allDivergences`). Pans the shared chart window via `_setViewEnd`
// so price, delta, and CVD panels stay aligned.
import { state } from '../state.js';
import { clamp } from '../util/math.js';
import {
  MIN_CHART_VISIBLE_BARS,
  MAX_CHART_VISIBLE_BARS,
} from '../config/constants.js';
import { _setViewEnd } from './pan.js';
import { _getViewedBars } from '../render/priceChart.js';

function _laterMs(d) {
  return Date.parse(d.laterTime);
}

function _sortedPipelineDivergences() {
  const rows = state.replay.mode === 'real' ? (state.replay.allDivergences || []) : [];
  if (!rows.length) return [];
  return rows.slice().sort((a, b) => {
    const la = _laterMs(a);
    const lb = _laterMs(b);
    if (la !== lb) return la - lb;
    return Date.parse(a.earlierTime) - Date.parse(b.earlierTime);
  });
}

/** Center bar of the current price/delta/CVD viewport — stable for sequential div jumps after re-centering. */
function _refMsCenterViewport() {
  const { viewedBars } = _getViewedBars();
  if (!viewedBars.length) return NaN;
  const mid = viewedBars[Math.floor((viewedBars.length - 1) / 2)];
  return mid.time instanceof Date ? mid.time.getTime() : Date.parse(mid.time);
}

function _barIndexForTime(allBars, ms) {
  return allBars.findIndex(bar => {
    const t = bar.time instanceof Date ? bar.time.getTime() : Date.parse(bar.time);
    return t === ms;
  });
}

function _focusBarIndexCentered(targetIdx) {
  const allBars = state.replay.allBars;
  const n = allBars.length;
  if (!n || targetIdx < 0 || targetIdx >= n) return;
  const minEnd = Math.min(state.chartVisibleBars, n);
  const vbReq = clamp(
    state.chartVisibleBars,
    MIN_CHART_VISIBLE_BARS,
    MAX_CHART_VISIBLE_BARS,
  );
  const effVb = Math.min(vbReq, n, MAX_CHART_VISIBLE_BARS);
  let panStart = clamp(
    targetIdx - Math.floor(effVb / 2),
    0,
    Math.max(0, n - effVb),
  );
  let endExclusive = panStart + effVb;
  endExclusive = clamp(endExclusive, minEnd, n);
  panStart = endExclusive - effVb;
  if (panStart < 0) {
    panStart = 0;
    endExclusive = Math.min(n, panStart + effVb);
  }
  endExclusive = Math.max(endExclusive, minEnd);
  _setViewEnd(endExclusive);
}

export function jumpAdjacentPipelineDivergence(direction) {
  if (state.replay.mode !== 'real' || !state.replay.allBars.length) return;
  const sorted = _sortedPipelineDivergences();
  if (!sorted.length) return;
  const ref = _refMsCenterViewport();
  if (!Number.isFinite(ref)) return;

  let pick = null;
  if (direction > 0) {
    for (const d of sorted) {
      if (_laterMs(d) > ref) {
        pick = d;
        break;
      }
    }
  } else {
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (_laterMs(sorted[i]) < ref) {
        pick = sorted[i];
        break;
      }
    }
  }
  if (!pick) return;
  const idx = _barIndexForTime(state.replay.allBars, _laterMs(pick));
  if (idx < 0) return;
  _focusBarIndexCentered(idx);
}

export function syncDivergenceNavButtons() {
  const prev = document.getElementById('cvdDivNavPrev');
  const next = document.getElementById('cvdDivNavNext');
  if (!prev || !next) return;
  const enabled =
    state.replay.mode === 'real' &&
    state.replay.allBars.length > 0 &&
    _sortedPipelineDivergences().length > 0;
  if (!enabled) {
    prev.disabled = true;
    next.disabled = true;
    return;
  }
  const ref = _refMsCenterViewport();
  if (!Number.isFinite(ref)) {
    prev.disabled = true;
    next.disabled = true;
    return;
  }
  const sorted = _sortedPipelineDivergences();
  prev.disabled = !sorted.some(d => _laterMs(d) < ref);
  next.disabled = !sorted.some(d => _laterMs(d) > ref);
}

export function bindDivergenceNavUI() {
  const prev = document.getElementById('cvdDivNavPrev');
  const next = document.getElementById('cvdDivNavNext');
  if (!prev || !next) return;
  prev.addEventListener('click', () => jumpAdjacentPipelineDivergence(-1));
  next.addEventListener('click', () => jumpAdjacentPipelineDivergence(1));
  syncDivergenceNavButtons();
}
