import { ABSORPTION_WALL_CELL, BREAKOUT_CELL, DEPTH_LABELS, FADE_CELL, isAbsorptionWallRegime, isValueEdgeRejectRegime, MATRIX_COLS, MATRIX_ROWS, VOL_LABELS } from '../config/constants.js';
import { state } from '../state.js';
import { computeConfidence, topCells } from '../analytics/regime.js';
import { getCachedOccupancy, requestOccupancy } from '../data/occupancyApi.js';
import { resolveOccupancyWindow } from '../ui/matrixRange.js';
import {
  computeMatrixAbsDeltaLadder,
  matrixDeltaFillAndStroke,
} from '../analytics/matrixDeltaColorNorm.js';
import {
  computeMatrixSqrtVolumeLadder,
  getLoadedBarsForMatrixVolumeLadder,
  matrixVolumeBaseRadiusPx,
} from '../analytics/matrixVolumeRadiusNorm.js';

const POINT_MIN_OPACITY = 0.18;
const POINT_MAX_OPACITY = 0.95;
const POINT_RADIUS_PX = 2.5;
/** Hover / selected radii multiply volume-derived base — keep rank ordering under interaction. */
const MATRIX_POINT_HOVER_RADIUS_MULT = 1.3;
const MATRIX_POINT_SELECTED_RADIUS_MULT = 1.5;
const JITTER_RADIUS_NORM = 0.075;
const POINT_STROKE_WIDTH_PX = 1;
const POINT_HOVER_STROKE_COLOR = 'rgba(255,255,255,0.9)';
const POINT_SELECTED_STROKE_COLOR = 'rgba(255,255,255,1)';

function _isBearBar(bar) {
  if (!bar || bar.open == null || bar.close == null) return false;
  return bar.close < bar.open;
}

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
  if (inner && !inner.querySelector('.matrix-point-layer')) {
    const pointLayer = document.createElement('div');
    pointLayer.className = 'matrix-point-layer';
    pointLayer.id = 'matrixPointLayer';
    inner.appendChild(pointLayer);
  }
}

function renderMatrix(breakoutCanonical, fadeCanonical, absorptionWallCanonical, valueEdgeRejectCanonical) {
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
      cell.classList.remove('watched', 'watched-fade', 'watched-absorption-wall', 'watched-value-edge', 'current',
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
    _renderPointCloud();
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
  void breakoutCanonical; void fadeCanonical; void absorptionWallCanonical; void valueEdgeRejectCanonical;

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
    // Deep + Stacked columns (regime), Active+ vol — see isAbsorptionWallRegime.
    const isAbsorptionWallCell = isAbsorptionWallRegime(4 - r, c);
    const isValueEdgeCell = isValueEdgeRejectRegime(4 - r, c);
    const isSelected     = selectedSet ? selectedSet.has(`${r},${c}`) : false;
    cell.classList.toggle('watched',       isBreakoutCell);
    cell.classList.toggle('watched-fade',  isFadeCell);
    cell.classList.toggle('watched-absorption-wall', isAbsorptionWallCell);
    cell.classList.toggle('watched-value-edge', isValueEdgeCell);
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
  _renderPointCloud();
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

function _hashJitter(ms) {
  let h = (Number(ms) >>> 0) || 1;
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  const x = ((h & 0xffff) / 0xffff) * 2 - 1;
  const y = (((h >>> 16) & 0xffff) / 0xffff) * 2 - 1;
  return { x, y };
}

function _clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function _getViewedBarsForMatrix() {
  const replay = state.replay;
  const vbReqRaw = Number(state.chartVisibleBars);
  const vbReq = Number.isFinite(vbReqRaw) ? Math.max(10, Math.min(vbReqRaw, 240)) : 60;
  if (replay.mode === 'real' && state.chartViewEnd !== null && state.chartViewEnd !== replay.cursor) {
    const end = Math.max(1, Math.min(state.chartViewEnd, replay.allBars.length));
    const eff = Math.min(vbReq, end, 240);
    const start = Math.max(0, end - eff);
    return replay.allBars.slice(start, end);
  }
  if (replay.mode === 'real') {
    const forming = state.formingBar;
    const settleWant = Math.max(0, vbReq - (forming ? 1 : 0));
    const nSettle = Math.min(settleWant, replay.cursor);
    const start = Math.max(0, replay.cursor - nSettle);
    const settledSlice = replay.allBars.slice(start, replay.cursor);
    return forming ? [...settledSlice, forming] : settledSlice;
  }
  const forming = state.formingBar;
  const maxAvail = state.bars.length + (forming ? 1 : 0);
  const eff = Math.min(vbReq, Math.max(maxAvail, 1));
  const nBase = Math.min(eff - (forming ? 1 : 0), state.bars.length);
  const base = nBase > 0 ? state.bars.slice(-nBase) : [];
  return forming ? [...base, forming] : base;
}

function _resolvePointFrame(inner) {
  const cells = Array.from(document.querySelectorAll('.matrix-cell'));
  if (!cells.length) return null;
  const innerRect = inner.getBoundingClientRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cell of cells) {
    const r = cell.getBoundingClientRect();
    minX = Math.min(minX, r.left - innerRect.left);
    minY = Math.min(minY, r.top - innerRect.top);
    maxX = Math.max(maxX, r.right - innerRect.left);
    maxY = Math.max(maxY, r.bottom - innerRect.top);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function resolvePointStyle(bar, { isSelected, isHovered, opacity, pulseBear, pulseBull, baseRadiusPx, deltaLadder }) {
  const base = Number.isFinite(baseRadiusPx) && baseRadiusPx > 0 ? baseRadiusPx : POINT_RADIUS_PX;
  let radius = base;
  if (isSelected) radius = base * MATRIX_POINT_SELECTED_RADIUS_MULT;
  else if (isHovered) radius = base * MATRIX_POINT_HOVER_RADIUS_MULT;
  const zIndex = isSelected ? 4 : (isHovered ? 3 : 2);
  if (pulseBear && _isBearBar(bar)) {
    return {
      radius,
      fill: null,
      stroke: null,
      strokeWidth: 0,
      opacity,
      zIndex,
      pulseKind: 'bear',
    };
  }
  if (pulseBull && !_isBearBar(bar)) {
    return {
      radius,
      fill: null,
      stroke: null,
      strokeWidth: 0,
      opacity,
      zIndex,
      pulseKind: 'bull',
    };
  }
  const { fill: deltaFill, stroke: deltaStroke } = matrixDeltaFillAndStroke(bar, deltaLadder);
  const stroke = isSelected
    ? POINT_SELECTED_STROKE_COLOR
    : (isHovered ? POINT_HOVER_STROKE_COLOR : deltaStroke);
  return {
    radius,
    fill: deltaFill,
    stroke,
    strokeWidth: POINT_STROKE_WIDTH_PX,
    opacity,
    zIndex,
    pulseKind: null,
  };
}

function _renderPointCloud() {
  const inner = document.querySelector('.matrix-inner');
  if (!inner) return;
  const layer = inner.querySelector('#matrixPointLayer');
  if (!layer) return;
  const frame = _resolvePointFrame(inner);
  if (!frame) {
    layer.innerHTML = '';
    return;
  }

  const viewedBars = _getViewedBarsForMatrix();
  const eligible = [];
  let formingMs = null;
  if (state.formingBar?.time != null) {
    const ft = state.formingBar.time instanceof Date
      ? state.formingBar.time.getTime()
      : Date.parse(state.formingBar.time);
    if (Number.isFinite(ft)) formingMs = ft;
  }
  for (const bar of viewedBars) {
    const vRank = Number(bar?.vRank);
    const dRank = Number(bar?.dRank);
    if (!Number.isInteger(vRank) || !Number.isInteger(dRank)) continue;
    if (vRank < 1 || vRank > 5 || dRank < 1 || dRank > 5) continue;
    const t = bar.time instanceof Date ? bar.time.getTime() : Date.parse(bar.time);
    if (!Number.isFinite(t)) continue;
    eligible.push({ bar, barTimeMs: t, vRank, dRank });
  }

  layer.innerHTML = '';
  const count = eligible.length;
  if (!count) return;
  const ladderBars = getLoadedBarsForMatrixVolumeLadder();
  const volLadder = computeMatrixSqrtVolumeLadder(ladderBars);
  const deltaLadder = computeMatrixAbsDeltaLadder(ladderBars);
  for (let i = 0; i < count; i++) {
    const point = eligible[i];
    const age = (count - 1) - i;
    const t = age / Math.max(count - 1, 1);
    const opacity = POINT_MAX_OPACITY - t * (POINT_MAX_OPACITY - POINT_MIN_OPACITY);
    const xCenter = (point.dRank - 0.5) / 5;
    const yCenter = (5 - point.vRank + 0.5) / 5;
    const jitter = _hashJitter(point.barTimeMs);
    const xNorm = _clamp01(xCenter + jitter.x * JITTER_RADIUS_NORM);
    const yNorm = _clamp01(yCenter + jitter.y * JITTER_RADIUS_NORM);
    const x = frame.x + xNorm * frame.w;
    const y = frame.y + yNorm * frame.h;
    const isSelected = state.selection.barTimes?.has(point.barTimeMs) || false;
    const isHovered = state.selection.hoverBarTime != null && state.selection.hoverBarTime === point.barTimeMs;
    const isFormingBar = state.formingBar != null && point.bar === state.formingBar;
    const ambientLiveBear = isFormingBar
      && _isBearBar(point.bar)
      && formingMs != null
      && (state.selection.hoverBarTime == null || state.selection.hoverBarTime === formingMs);
    const ambientLiveBull = isFormingBar
      && !_isBearBar(point.bar)
      && formingMs != null
      && (state.selection.hoverBarTime == null || state.selection.hoverBarTime === formingMs);
    const pulseBear = _isBearBar(point.bar) && (isSelected || isHovered || ambientLiveBear);
    const pulseBull = !_isBearBar(point.bar) && (isSelected || isHovered || ambientLiveBull);
    const baseRadiusPx = matrixVolumeBaseRadiusPx(point.bar, volLadder, POINT_RADIUS_PX);
    const style = resolvePointStyle(point.bar, {
      isSelected, isHovered, opacity, pulseBear, pulseBull, baseRadiusPx, deltaLadder,
    });

    const el = document.createElement('button');
    el.type = 'button';
    let pulseClass = '';
    if (style.pulseKind === 'bear') pulseClass = ' matrix-point--bear-flash';
    else if (style.pulseKind === 'bull') pulseClass = ' matrix-point--bull-flash';
    el.className = 'matrix-point' + pulseClass;
    el.tabIndex = -1;
    el.dataset.barTime = String(point.barTimeMs);
    el.dataset.isBear = _isBearBar(point.bar) ? '1' : '0';
    el.setAttribute('aria-label', `Candle ${new Date(point.barTimeMs).toISOString()}`);
    el.style.left = `${x.toFixed(2)}px`;
    el.style.top = `${y.toFixed(2)}px`;
    el.style.width = `${(style.radius * 2).toFixed(2)}px`;
    el.style.height = `${(style.radius * 2).toFixed(2)}px`;
    el.style.opacity = style.opacity.toFixed(3);
    el.style.zIndex = String(style.zIndex);
    if (style.pulseKind) {
      const r = style.radius;
      const ringMin = Math.max(1, r * 0.35);
      const ringMax = Math.max(ringMin + 0.5, r * 1.75);
      el.style.setProperty('--pulse-ring-min', `${ringMin}px`);
      el.style.setProperty('--pulse-ring-max', `${ringMax}px`);
      el.style.background = 'transparent';
      el.style.border = 'none';
    } else {
      el.style.background = style.fill;
      el.style.border = `${style.strokeWidth}px solid ${style.stroke}`;
    }
    layer.appendChild(el);
  }
}

export { buildMatrix, renderMatrix };
