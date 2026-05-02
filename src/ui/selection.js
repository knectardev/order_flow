// ───────────────────────────────────────────────────────────
// Brushing-and-linking selection reducer (regime-DB plan §4b / §4c-d).
//
// Owns the single `state.selection` object. Three orthogonal entry
// points feed into it:
//
//   1. Matrix cell click  → `selectCell(r, c, { shift })`
//        - no shift     → set selection to a single cell (or clear if
//                         clicking the same cell again)
//        - shift        → toggle that cell in/out of a multi-cell set
//        Triggers a /bars?cell=v,d&cell=… fetch (DuckDB tuple-IN), then
//        materializes the response's bar_times into a Set<ms> so the
//        chart can tint members in O(visible) per frame.
//
//   2. Fire halo / event-log fire row click → `selectFire(fire)`
//        Locks the highlight to (fire bar + next 30 bars). Same data
//        plumbing — barTimes Set drives the tint — but populated from
//        replay.allBars[], not the API. Vertical marker at the fire bar
//        rendered by priceChart.
//
//   3. Esc key / click in empty matrix area / click same selected cell →
//        `clearSelection()`. Restores `state.selection` to its zero
//        value and re-renders.
//
// All mutations end with `_repaint()` which:
//   - calls drawPriceChart() (tint + vertical anchor)
//   - calls drawFlowChart() (same visible bar window as price chart)
//   - calls renderEventLog() (filtered rows when kind != null)
//   - calls repaintMatrix() so the matrix paints `selected` borders on
//     the active cells
// ───────────────────────────────────────────────────────────
import { state } from '../state.js';
import { isPhatLegendModalOpen } from './phatLegendModal.js';
import { _syncCurrentSession } from '../data/replay.js';
import { drawPriceChart } from '../render/priceChart.js';
import { drawFlowChart } from '../render/flowChart.js';
import { drawCvdChart } from '../render/cvdChart.js';
import { renderEventLog } from '../render/eventLog.js';
import { _refreshMatrixForView } from './pan.js';
import { repaintMatrix } from './matrixRange.js';
import { pickMatrixScatterBarTime, pickMatrixCellFromScatterCanvas } from '../render/matrix.js';

// Length of the fire-anchored highlight window, expressed as a count of
// bars including the fire bar itself. Plan says "fire bar + next 30
// bars" → 31 entries, fire at index 0.
const FIRE_WINDOW_BARS = 31;
const URL_PARAM_SELECTION_KIND = 'selection';
const URL_PARAM_SELECTION_FIRE_TIME = 'selectionFireTime';
const URL_PARAM_SELECTION_FIRE_WATCH = 'selectionFireWatch';
const URL_PARAM_SELECTION_CELLS = 'selectionCells';

// ───────────────────────────────────────────────────────────
// Public reducer entry points
// ───────────────────────────────────────────────────────────
function selectCell(r, c, opts = {}) {
  if (state.replay.mode !== 'real' || !state.replay.apiBase) return;

  const shift = !!opts.shift;
  const sel = state.selection;
  const exists = sel.kind === 'cells' && sel.cells.some(p => p.r === r && p.c === c);

  let nextCells;
  if (shift && sel.kind === 'cells') {
    // Toggle membership in the existing multi-set.
    nextCells = exists
      ? sel.cells.filter(p => !(p.r === r && p.c === c))
      : sel.cells.concat([{ r, c }]);
  } else if (!shift && sel.kind === 'cells' && sel.cells.length === 1 && exists) {
    // Click the single selected cell again → clear (one of the three
    // canonical reset gestures).
    nextCells = [];
  } else {
    nextCells = [{ r, c }];
  }

  if (nextCells.length === 0) {
    clearSelection();
    return;
  }

  state.selection = {
    kind: 'cells',
    cells: nextCells,
    barTimes: null,        // will populate when fetch resolves
    fireBarTime: null,
    fireWindowEndMs: null,
    barTime: null,
    hoverBarTime: null,
  };
  _syncSelectionToUrl();
  _repaint();

  _fetchCellSelection(nextCells).then(barTimes => {
    // Stale-fetch guard: only apply if the selection is still the same
    // set of cells. A user shift-clicking quickly can issue multiple
    // requests; we drop the older results so the visible tint matches
    // the visible matrix borders.
    const live = state.selection;
    if (live.kind !== 'cells' || !_sameCellSet(live.cells, nextCells)) return;
    state.selection = { ...live, barTimes };
    _syncSelectionToUrl();
    _repaint();
  }).catch(err => {
    console.warn('[orderflow] cell selection fetch failed:', err.message);
  });
}

function selectFire(fire) {
  if (!fire) return;
  // Resolve the fire's bar in the concatenated timeline so we can take
  // the next 30 bars after it. Fire.barTime can be a Date (live mode)
  // or an ISO-Z string (when sourced from /fires JSON); normalize.
  const fireMs = fire.barTime instanceof Date
    ? fire.barTime.getTime()
    : Date.parse(fire.barTime);
  const all = state.replay.allBars;
  let idx = -1;
  for (let i = 0; i < all.length; i++) {
    const t = all[i].time;
    const ms = t instanceof Date ? t.getTime() : Date.parse(t);
    if (ms === fireMs) { idx = i; break; }
  }
  if (idx < 0) return;

  const last = Math.min(all.length - 1, idx + (FIRE_WINDOW_BARS - 1));
  const barTimes = new Set();
  for (let i = idx; i <= last; i++) {
    const t = all[i].time;
    barTimes.add(t instanceof Date ? t.getTime() : Date.parse(t));
  }
  const lastT = all[last].time;
  const lastMs = lastT instanceof Date ? lastT.getTime() : Date.parse(lastT);

  state.selection = {
    kind: 'fire',
    cells: [],
    barTimes,
    fireBarTime: fireMs,
    fireWindowEndMs: lastMs,
    barTime: null,
    hoverBarTime: null,
  };
  _syncSelectionToUrl(fire);

  // So the 31-bar highlight and ◆/★ glyph are actually on-canvas. Without
  // this, a random pan leaves every visible bar outside `barTimes` (all
  // dim) and the marker off-screen.
  if (state.replay.mode === 'real' && all.length) {
    const endExclusive = Math.max(1, Math.min(last + 1, all.length));
    state.chartViewEnd = endExclusive;
    _syncCurrentSession();
  }

  _repaint();
  if (state.replay.mode === 'real' && all.length) {
    _refreshMatrixForView();
  }
}

function clearSelection() {
  const sel = state.selection;
  if (sel.kind === null && sel.hoverBarTime == null) return;
  state.selection = {
    kind: null,
    cells: [],
    barTimes: null,
    fireBarTime: null,
    fireWindowEndMs: null,
    barTime: null,
    hoverBarTime: null,
  };
  _syncSelectionToUrl();
  _repaint();
}

function selectBar(barTimeMs, source = 'unknown') {
  if (!Number.isFinite(barTimeMs)) return;
  const ms = Number(barTimeMs);
  const live = state.selection;
  // Same-bar click toggles off, mirroring cell/fire behavior.
  if (live.kind === 'bar' && live.barTime === ms) {
    clearSelection();
    return;
  }
  state.selection = {
    kind: 'bar',
    cells: [],
    barTimes: new Set([ms]),
    fireBarTime: null,
    fireWindowEndMs: null,
    barTime: ms,
    hoverBarTime: ms,
  };
  void source;
  _syncSelectionToUrl();
  _repaint();
}

function hoverBar(barTimeMs, source = 'unknown') {
  const next = Number.isFinite(barTimeMs) ? Number(barTimeMs) : null;
  const sel = state.selection;
  if (sel.hoverBarTime === next) return;
  state.selection = { ...sel, hoverBarTime: next };
  void source;
  _repaintLinked();
}

// ───────────────────────────────────────────────────────────
// Predicate used by the chart tint pass. Cheap (Set lookup) — called
// once per visible bar per frame.
// ───────────────────────────────────────────────────────────
function isBarSelected(barTimeMs) {
  const sel = state.selection;
  if (!sel.barTimes) return false;
  return sel.barTimes.has(barTimeMs);
}

// ───────────────────────────────────────────────────────────
// Internals
// ───────────────────────────────────────────────────────────
async function _fetchCellSelection(cells) {
  // Build the /bars query: cover the entire loaded timeline so the
  // selection isn't bounded by the current viewport. The API caps
  // cell= at 25 (matrix saturation), so the param list is bounded
  // regardless of how shift-happy the user gets.
  const sessions = state.replay.sessions;
  if (sessions.length === 0) return new Set();
  const fromIso = sessions[0].sessionStart;
  const toIso   = sessions[sessions.length - 1].sessionEnd;
  const params = new URLSearchParams();
  params.set('from', fromIso);
  params.set('to',   toIso);
  // Convert display coords (r,c) to API rank pairs (v_rank, d_rank):
  //   v_rank = 5 - r   (row 0 = volatility 5, row 4 = volatility 1)
  //   d_rank = c + 1   (column 0 = depth 1, column 4 = depth 5)
  for (const p of cells) {
    const vRank = 5 - p.r;
    const dRank = p.c + 1;
    params.append('cell', `${vRank},${dRank}`);
  }
  const url = `${state.replay.apiBase}/bars?${params.toString()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`/bars ${r.status}`);
  const j = await r.json();
  const set = new Set();
  for (const b of j.bars || []) {
    set.add(Date.parse(b.time));
  }
  return set;
}

function _sameCellSet(a, b) {
  if (a.length !== b.length) return false;
  // Order-independent equality by serializing both into a canonical
  // string set. Cell counts are <= 25, so this is trivially cheap.
  const k = p => `${p.r},${p.c}`;
  const sa = new Set(a.map(k));
  for (const p of b) if (!sa.has(k(p))) return false;
  return true;
}

function _repaint() {
  drawPriceChart();
  drawFlowChart();
  drawCvdChart();
  renderEventLog();
  repaintMatrix();
}

function _repaintLinked() {
  drawPriceChart();
  drawFlowChart();
  drawCvdChart();
  repaintMatrix();
}

function _syncSelectionToUrl(fire = null) {
  const url = new URL(window.location.href);
  const p = url.searchParams;
  // Keep URL params canonical so refresh/share restores the same selection.
  p.delete(URL_PARAM_SELECTION_KIND);
  p.delete(URL_PARAM_SELECTION_FIRE_TIME);
  p.delete(URL_PARAM_SELECTION_FIRE_WATCH);
  p.delete(URL_PARAM_SELECTION_CELLS);

  const sel = state.selection;
  if (sel.kind === 'fire') {
    p.set(URL_PARAM_SELECTION_KIND, 'fire');
    const fireMs = fire?.barTime instanceof Date
      ? fire.barTime.getTime()
      : (fire?.barTime ? Date.parse(fire.barTime) : sel.fireBarTime);
    if (Number.isFinite(fireMs)) p.set(URL_PARAM_SELECTION_FIRE_TIME, String(fireMs));
    const watch = fire?.watchId || '';
    if (watch) p.set(URL_PARAM_SELECTION_FIRE_WATCH, watch);
  } else if (sel.kind === 'cells' && sel.cells.length) {
    p.set(URL_PARAM_SELECTION_KIND, 'cells');
    const packed = sel.cells.map(c => `${c.r}.${c.c}`).join(',');
    p.set(URL_PARAM_SELECTION_CELLS, packed);
  }
  window.history.replaceState(null, '', url);
}

function restoreSelectionFromUrl() {
  const p = new URL(window.location.href).searchParams;
  const kind = (p.get(URL_PARAM_SELECTION_KIND) || '').toLowerCase();
  if (kind === 'fire') {
    const watch = p.get(URL_PARAM_SELECTION_FIRE_WATCH) || '';
    const raw = p.get(URL_PARAM_SELECTION_FIRE_TIME);
    if (!raw) return false;
    const ms = Number(raw);
    if (!Number.isFinite(ms)) return false;
    const fires = state.replay.mode === 'real'
      ? state.replay.allFires
      : state.canonicalFires;
    const match = fires.find(f => {
      const fms = f.barTime instanceof Date ? f.barTime.getTime() : Date.parse(f.barTime);
      return fms === ms && (!watch || f.watchId === watch);
    });
    if (!match) return false;
    selectFire(match);
    return true;
  }
  if (kind === 'cells' && state.replay.mode === 'real' && state.replay.apiBase) {
    const packed = p.get(URL_PARAM_SELECTION_CELLS) || '';
    const cells = packed.split(',').map(token => {
      const [rRaw, cRaw] = token.split('.');
      const r = Number(rRaw);
      const c = Number(cRaw);
      if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
      if (r < 0 || r > 4 || c < 0 || c > 4) return null;
      return { r, c };
    }).filter(Boolean);
    if (!cells.length) return false;
    state.selection = {
      kind: 'cells',
      cells,
      barTimes: null,
      fireBarTime: null,
      fireWindowEndMs: null,
      barTime: null,
      hoverBarTime: null,
    };
    _syncSelectionToUrl();
    _repaint();
    _fetchCellSelection(cells).then(barTimes => {
      const live = state.selection;
      if (live.kind !== 'cells' || !_sameCellSet(live.cells, cells)) return;
      state.selection = { ...live, barTimes };
      _syncSelectionToUrl();
      _repaint();
    }).catch(err => {
      console.warn('[orderflow] URL cell selection fetch failed:', err.message);
    });
    return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────
// DOM wiring (called from main.js after buildMatrix). The matrix
// renderer adds .matrix-cell elements with dataset.r / dataset.c, so we
// can attach a single delegated click on #matrixGrid.
// ───────────────────────────────────────────────────────────
function bindSelectionUI() {
  const grid = document.getElementById('matrixGrid');
  const pointLayer = document.getElementById('matrixPointLayer');
  if (pointLayer) {
    pointLayer.addEventListener('mousemove', (e) => {
      const ms = pickMatrixScatterBarTime(e.clientX, e.clientY);
      if (ms == null) hoverBar(null, 'matrix-point-layer');
      else hoverBar(ms, 'matrix-point-layer');
    });
    pointLayer.addEventListener('mouseleave', () => {
      hoverBar(null, 'matrix-point-layer-leave');
    });
    pointLayer.addEventListener('click', (e) => {
      if (!e.target.closest('#matrixScatterCanvas')) return;
      const ms = pickMatrixScatterBarTime(e.clientX, e.clientY);
      e.stopPropagation();
      if (ms != null && Number.isFinite(ms)) {
        selectBar(ms, 'matrix-point-click');
        return;
      }
      const cell = pickMatrixCellFromScatterCanvas(e.clientX, e.clientY);
      if (cell) {
        selectCell(cell.r, cell.c, { shift: e.shiftKey });
        return;
      }
      clearSelection();
    });
  }
  if (grid) {
    grid.addEventListener('click', (e) => {
      if (e.target.closest('#matrixScatterCanvas')) return;
      const cell = e.target.closest('.matrix-cell');
      if (!cell) {
        // Click in the matrix area but outside any cell → clear.
        clearSelection();
        return;
      }
      const r = +cell.dataset.r;
      const c = +cell.dataset.c;
      if (Number.isNaN(r) || Number.isNaN(c)) return;
      selectCell(r, c, { shift: e.shiftKey });
    });
  }

  // Esc anywhere in the document clears the selection. Don't intercept
  // when the user is in a modal (modal close has its own handler).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.currentModal) return;
    if (isPhatLegendModalOpen()) return;
    if (state.selection.kind !== null) clearSelection();
  });
}

export { selectCell, selectFire, selectBar, hoverBar, clearSelection, isBarSelected, bindSelectionUI, restoreSelectionFromUrl };
