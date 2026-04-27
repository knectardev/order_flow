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
//   - calls renderEventLog() (filtered rows when kind != null)
//   - calls repaintMatrix() so the matrix paints `selected` borders on
//     the active cells
// ───────────────────────────────────────────────────────────
import { state } from '../state.js';
import { drawPriceChart } from '../render/priceChart.js';
import { renderEventLog } from '../render/eventLog.js';
import { repaintMatrix } from './matrixRange.js';

// Length of the fire-anchored highlight window, expressed as a count of
// bars including the fire bar itself. Plan says "fire bar + next 30
// bars" → 31 entries, fire at index 0.
const FIRE_WINDOW_BARS = 31;

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
  };
  _repaint();

  _fetchCellSelection(nextCells).then(barTimes => {
    // Stale-fetch guard: only apply if the selection is still the same
    // set of cells. A user shift-clicking quickly can issue multiple
    // requests; we drop the older results so the visible tint matches
    // the visible matrix borders.
    const live = state.selection;
    if (live.kind !== 'cells' || !_sameCellSet(live.cells, nextCells)) return;
    state.selection = { ...live, barTimes };
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
  };
  _repaint();
}

function clearSelection() {
  if (state.selection.kind === null) return;
  state.selection = {
    kind: null,
    cells: [],
    barTimes: null,
    fireBarTime: null,
    fireWindowEndMs: null,
  };
  _repaint();
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
  renderEventLog();
  repaintMatrix();
}

// ───────────────────────────────────────────────────────────
// DOM wiring (called from main.js after buildMatrix). The matrix
// renderer adds .matrix-cell elements with dataset.r / dataset.c, so we
// can attach a single delegated click on #matrixGrid.
// ───────────────────────────────────────────────────────────
function bindSelectionUI() {
  const grid = document.getElementById('matrixGrid');
  if (grid) {
    grid.addEventListener('click', (e) => {
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
    if (state.selection.kind !== null) clearSelection();
  });
}

export { selectCell, selectFire, clearSelection, isBarSelected, bindSelectionUI };
