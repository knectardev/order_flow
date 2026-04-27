import { BREAKOUT_CELL, DEPTH_LABELS, FADE_CELL, MATRIX_COLS, MATRIX_ROWS, VOL_LABELS } from '../config/constants.js';
import { state } from '../state.js';
import { computeConfidence, topCells } from '../analytics/regime.js';
import { getCachedOccupancy, requestOccupancy } from '../data/occupancyApi.js';
import { resolveOccupancyWindow } from '../ui/matrixRange.js';

function buildMatrix() {
  const grid = document.getElementById('matrixGrid');
  grid.innerHTML = '';

  for (let r = 0; r < MATRIX_ROWS; r++) {
    const labelDiv = document.createElement('div');
    labelDiv.className = 'row-label';
    labelDiv.innerHTML = `<span class="num">${5-r}</span>${VOL_LABELS[r]}`;
    grid.appendChild(labelDiv);

    for (let c = 0; c < MATRIX_COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'matrix-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.innerHTML = `
        <div class="score-fill"></div>
        <div class="trail-dot"></div>
        <span class="watch-mark">◢</span>
      `;
      grid.appendChild(cell);
    }
  }

  // X-axis row
  const xRow = document.createElement('div');
  xRow.className = 'x-axis-row';
  const blank = document.createElement('div');
  xRow.appendChild(blank);
  for (let c = 0; c < MATRIX_COLS; c++) {
    const x = document.createElement('div');
    x.className = 'x-label';
    x.innerHTML = `<span class="num">${c+1}</span><br>${DEPTH_LABELS[c]}`;
    xRow.appendChild(x);
  }
  grid.appendChild(xRow);

  // Regime-DB plan §2c-d: warmup overlay element. Sits on top of the 5x5
  // grid (positioned over `.matrix-inner`); .visible class toggles via
  // renderMatrix when state.regimeWarmup is true. Centered amber label
  // signals "matrix is intentionally inactive" — distinct from "data is
  // missing" or "regime is at center cell". Element is created once and
  // reused; only the .visible class flips.
  const inner = document.querySelector('.matrix-inner');
  if (inner && !inner.querySelector('.matrix-warmup')) {
    const overlay = document.createElement('div');
    overlay.className = 'matrix-warmup';
    overlay.textContent = 'WARMING UP';
    inner.appendChild(overlay);
  }
}

function renderMatrix(breakoutCanonical, fadeCanonical) {
  const cells = document.querySelectorAll('.matrix-cell');
  const selectedSet = (state.selection.kind === 'cells')
    ? new Set(state.selection.cells.map(p => `${p.r},${p.c}`))
    : null;

  // Regime-DB plan §2c-d. Warmup short-circuits the entire normal render:
  //   - all 25 cells dimmed via .warmup class on the grid (CSS opacity 0.4)
  //   - watched/current/fired class flips skipped (no border on any cell)
  //   - .matrix-warmup overlay made visible
  //   - status block shows "— first 30 bars of session —" instead of cells
  // The matrix-inner element carries .warmup; toggling it on the parent
  // (rather than each cell individually) lets a single CSS rule dim the
  // grid without writing 25 inline opacity values per frame.
  const inner = document.querySelector('.matrix-inner');
  if (inner) inner.classList.toggle('warmup', !!state.regimeWarmup);
  if (inner) inner.classList.toggle('heatmap', state.matrixState.displayMode === 'heatmap');

  // Regime-DB plan §3a-c: kick off the /occupancy fetch (or read the
  // cached one) for the active range. We do this here, BEFORE the
  // warmup short-circuit, so the heatmap layer also paints during
  // warmup — the heatmap reflects the *historical* range, not the
  // currently-warming bar, so it's always meaningful even when the
  // posterior layer is dim. The fetched grid lands on
  // state.matrixState.occupancy synchronously when cached, or
  // asynchronously via onResolve (which calls renderMatrix again).
  _ensureOccupancy();

  if (state.regimeWarmup) {
    cells.forEach(cell => {
      const fill = cell.querySelector('.score-fill');
      if (fill) fill.style.opacity = '0';
      _applyHeatmapCellOpacity(cell);
      cell.classList.remove('watched', 'watched-fade', 'current',
                            'has-trail', 'selected');
    });
    document.getElementById('confFill').style.width = '0%';
    document.getElementById('confVal').textContent = '—';
    document.getElementById('topCell').textContent = '— first 30 bars of session —';
    document.getElementById('topCellScore').textContent = '';
    document.getElementById('altCell').textContent = '';
    document.getElementById('altCellScore').textContent = '';
    _renderOccupancyDiagnostic(null);
    _renderRangeLabel();
    return;
  }

  const maxScore = Math.max(...state.matrixScores.flat());
  const top = topCells(state.matrixScores, 2);
  // Plan §4c-d: matrix cells no longer carry per-fire glyphs/pulses.
  // Watched borders still mark the canonical Breakout/Fade target cells
  // (advisory framing), but the actual fire halo lives on the chart.
  // breakoutCanonical / fadeCanonical are still consumed by callers
  // (canonical evaluators, watch panels) — they're just not rendered
  // here.
  void breakoutCanonical; void fadeCanonical;

  cells.forEach(cell => {
    const r = +cell.dataset.r;
    const c = +cell.dataset.c;
    const s = state.matrixScores[r][c];
    const norm = s / Math.max(maxScore, 0.0001);
    const fill = cell.querySelector('.score-fill');
    fill.style.opacity = (norm * 0.45).toFixed(3);
    _applyHeatmapCellOpacity(cell);

    const isBreakoutCell = (r === BREAKOUT_CELL.r && c === BREAKOUT_CELL.c);
    const isFadeCell     = (r === FADE_CELL.r     && c === FADE_CELL.c);
    const isSelected     = selectedSet ? selectedSet.has(`${r},${c}`) : false;
    cell.classList.toggle('watched',       isBreakoutCell);
    cell.classList.toggle('watched-fade',  isFadeCell);
    cell.classList.toggle('current',       r === top[0].r && c === top[0].c);
    cell.classList.toggle('has-trail',     state.trail.some(t => t.r === r && t.c === c));
    cell.classList.toggle('selected',      isSelected);
  });

  // Confidence bar
  const conf = computeConfidence(state.matrixScores);
  document.getElementById('confFill').style.width = (conf * 100).toFixed(0) + '%';
  document.getElementById('confVal').textContent = conf.toFixed(2);

  // Status
  const cellName = (rc) => `${VOL_LABELS[rc.r]} · ${DEPTH_LABELS[rc.c]}`;
  document.getElementById('topCell').textContent = cellName(top[0]);
  document.getElementById('topCellScore').textContent = `score ${top[0].s.toFixed(3)} · cell [${5-top[0].r},${top[0].c+1}]`;
  document.getElementById('altCell').textContent = cellName(top[1]);
  document.getElementById('altCellScore').textContent = `score ${top[1].s.toFixed(3)} · cell [${5-top[1].r},${top[1].c+1}]`;
  _renderOccupancyDiagnostic(top[0]);
  _renderRangeLabel();
}

// Kick off / refresh the /occupancy fetch. Synchronous read populates
// `state.matrixState.occupancy`; asynchronous resolution triggers a
// repaint so the heatmap layer fills in once the response lands. We
// stash the resolved window on `state.matrixState.occupancy` only when
// the cached read succeeds — otherwise the renderer's heatmap path
// no-ops for one frame, which is what we want.
function _ensureOccupancy() {
  if (state.replay.mode !== 'real' || !state.replay.apiBase) {
    state.matrixState.occupancy = null;
    return;
  }
  const win = resolveOccupancyWindow();
  if (!win) {
    state.matrixState.occupancy = null;
    return;
  }
  // Cache hit?  → expose synchronously.
  const hit = getCachedOccupancy(win.from, win.to, win.sessionDate);
  if (hit) {
    state.matrixState.occupancy = { ...hit, label: win.label };
    return;
  }
  state.matrixState.occupancy = null;
  requestOccupancy(win.from, win.to, win.sessionDate, () => {
    // Re-render via the seek path's last-frame state. We can't import
    // seek/step here without circular deps, so we synthesize a minimal
    // re-render: the cached read on the next render frame will hit and
    // populate `occupancy`. Triggering a microtask repaint keeps the
    // user from waiting for the next step() tick.
    Promise.resolve().then(() => {
      if (typeof window === 'undefined') return;
      window.dispatchEvent(new CustomEvent('orderflow:matrix-repaint'));
    });
  });
}

// Apply heatmap-mode background opacity to a single cell. In posterior
// mode the heatmap layer is hidden via CSS (matrix-inner.heatmap
// scoping), so this only writes meaningful values in heatmap mode. We
// still set it in posterior mode so toggling back doesn't show stale
// values for one frame.
function _applyHeatmapCellOpacity(cell) {
  const occ = state.matrixState.occupancy;
  const r = +cell.dataset.r;
  const c = +cell.dataset.c;
  let layer = cell.querySelector('.heatmap-fill');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'heatmap-fill';
    // Insert at the bottom of the cell's stacking context so the
    // existing posterior `.score-fill`, trail dot, watch mark and
    // borders all sit on top of it without z-index gymnastics.
    cell.insertBefore(layer, cell.firstChild);
  }
  if (!occ || occ.maxCell <= 0) {
    layer.style.opacity = '0';
    return;
  }
  const v = occ.grid[r][c];
  // Linear scale to [0, 0.55]. Caps below 1 so the brightest cell
  // doesn't blow out the watched-cell border or the live-cell ring.
  const opacity = Math.max(0, Math.min(0.55, (v / occ.maxCell) * 0.55));
  layer.style.opacity = opacity.toFixed(3);
}

function _renderRangeLabel() {
  const el = document.getElementById('matrixRangeLabel');
  if (!el) return;
  const occ = state.matrixState.occupancy;
  const win = resolveOccupancyWindow();
  if (!occ || !win) {
    el.textContent = win ? `${win.label} · loading…` : '';
    return;
  }
  el.textContent = `${win.label} · ${occ.totalBars.toLocaleString()} bars`;
}

function _renderOccupancyDiagnostic(topCell) {
  const el = document.getElementById('matrixOccupancyDiag');
  if (!el) return;
  const occ = state.matrixState.occupancy;
  if (!occ || !topCell || occ.totalBars <= 0) {
    el.textContent = '—';
    return;
  }
  const v = occ.grid[topCell.r][topCell.c] || 0;
  const pct = (v / occ.totalBars) * 100;
  const cellName = `${VOL_LABELS[topCell.r]} · ${DEPTH_LABELS[topCell.c]}`;
  el.textContent = `[${cellName}] occupied ${pct.toFixed(1)}% of selected window (${v.toLocaleString()} / ${occ.totalBars.toLocaleString()} bars)`;
}

export { buildMatrix, renderMatrix };
