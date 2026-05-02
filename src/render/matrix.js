import {
  ABSORPTION_WALL_CELL,
  BREAKOUT_CELL,
  CHART_CANDLE_DOWN,
  CHART_CANDLE_UP,
  DEPTH_LABELS,
  FADE_CELL,
  isAbsorptionWallRegime,
  isValueEdgeRejectRegime,
  MATRIX_COLS,
  MATRIX_ROWS,
  VOL_LABELS,
} from '../config/constants.js';
import { state } from '../state.js';
import { computeConfidence, topCells } from '../analytics/regime.js';
import { getCachedOccupancy, requestOccupancy } from '../data/occupancyApi.js';
import { resolveOccupancyWindow } from '../ui/matrixRange.js';
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
const POINT_STROKE_WIDTH_PX = 1;
const POINT_HOVER_STROKE_COLOR = 'rgba(255,255,255,0.9)';
const POINT_SELECTED_STROKE_COLOR = 'rgba(255,255,255,1)';

/** Scatter disk fill matches price chart candles: `close < open` → down red, else up green (`CHART_*`). */
function _matrixScatterCandleFillAndStroke(bar) {
  if (!bar || bar.open == null || bar.close == null) {
    return {
      fill: 'hsl(210, 12%, 64%)',
      stroke: 'hsl(210, 12%, 46%)',
    };
  }
  const o = Number(bar.open);
  const c = Number(bar.close);
  if (!Number.isFinite(o) || !Number.isFinite(c)) {
    return {
      fill: 'hsl(210, 12%, 64%)',
      stroke: 'hsl(210, 12%, 46%)',
    };
  }
  const bear = c < o;
  return {
    fill: bear ? CHART_CANDLE_DOWN : CHART_CANDLE_UP,
    stroke: bear ? 'rgba(255,59,48,0.55)' : 'rgba(0,192,135,0.55)',
  };
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
    const cnv = document.createElement('canvas');
    cnv.id = 'matrixScatterCanvas';
    cnv.className = 'matrix-scatter-canvas';
    cnv.setAttribute('aria-hidden', 'true');
    pointLayer.appendChild(cnv);
    inner.appendChild(pointLayer);
  } else if (inner) {
    const pl = inner.querySelector('#matrixPointLayer');
    if (pl && !pl.querySelector('#matrixScatterCanvas')) {
      const cnv = document.createElement('canvas');
      cnv.id = 'matrixScatterCanvas';
      cnv.className = 'matrix-scatter-canvas';
      cnv.setAttribute('aria-hidden', 'true');
      pl.appendChild(cnv);
    }
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

function _clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function _coerceMatrixDepthAxis1to5(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (Math.abs(n - r) > 1e-4) return null;
  if (r < 1 || r > 5) return null;
  return r;
}

function _coerceMatrixContinuous1to5(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const EPS = 1e-9;
  if (n < 1 - EPS || n > 5 + EPS) return null;
  return n;
}

function _stableUnitPair(seedMs) {
  let h = (Number(seedMs) >>> 0) || 1;
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  const u = Math.min(1 - 1e-9, Math.max(1e-9, (h >>> 0) / 4294967296));
  let h2 = Math.imul((h >>> 16) ^ (seedMs | 0), 0x85ebca6b) >>> 0;
  h2 ^= h2 << 13;
  h2 ^= h2 >>> 17;
  h2 ^= h2 << 5;
  const v = Math.min(1 - 1e-9, Math.max(1e-9, (h2 >>> 0) / 4294967296));
  return { u, v };
}

/** Scatter sample: pipeline `volScore`/`depthScore` (open (1,5) typical) when present; else rank-band spread (±0.5) from [1,5]. */
function _scatterVolDepthForBar(bar) {
  const t = _barTimeMsForMatrix(bar);
  if (!Number.isFinite(t)) return null;
  const vsRaw = bar?.volScore ?? bar?.vol_score;
  const dsRaw = bar?.depthScore ?? bar?.depth_score;
  const vc = _coerceMatrixContinuous1to5(vsRaw);
  const dc = _coerceMatrixContinuous1to5(dsRaw);
  if (vc != null && dc != null) {
    return { vol: vc, depth: dc, barTimeMs: t };
  }
  const vr = _coerceMatrixDepthAxis1to5(bar?.vRank ?? bar?.v_rank);
  const dr = _coerceMatrixDepthAxis1to5(bar?.dRank ?? bar?.d_rank);
  if (vr == null || dr == null) return null;
  const { u, v } = _stableUnitPair(t);
  const vol = Math.min(5, Math.max(1, vr - 0.5 + u));
  const depth = Math.min(5, Math.max(1, dr - 0.5 + v));
  return { vol, depth, barTimeMs: t };
}

/** Fixed [1,5] → [0,1] maps (score 5 → top): axis fallback when cloud has no spread on that dimension */
function _normFromVolDepth(vol, depth) {
  const xNorm = _clamp01((depth - 1) / 4);
  const yNorm = _clamp01((5 - vol) / 4);
  return { xNorm, yNorm };
}

/** Stretch each axis independently vs batch min/max; fixed-scale fallback per axis when span ~ 0 */
function _normScatterToFrame(vol, depth, agg) {
  const SPAN_EPS = 1e-6;
  const fixed = _normFromVolDepth(vol, depth);
  const xNorm = agg.dSpan < SPAN_EPS ? fixed.xNorm : _clamp01((depth - agg.dMin) / agg.dSpan);
  const yNorm = agg.vSpan < SPAN_EPS ? fixed.yNorm : _clamp01((agg.vMax - vol) / agg.vSpan);
  return { xNorm, yNorm };
}

function _aggregateScatterExtents(eligible) {
  let dMin = Infinity;
  let dMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < eligible.length; i++) {
    const p = eligible[i];
    const { depth: d, vol: v } = p;
    if (d < dMin) dMin = d;
    if (d > dMax) dMax = d;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const dSpan = Number.isFinite(dMin) ? dMax - dMin : 0;
  const vSpan = Number.isFinite(vMin) ? vMax - vMin : 0;
  return { dMin, dMax, vMin, vMax, dSpan, vSpan };
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

function _barTimeMsForMatrix(bar) {
  if (!bar?.time) return NaN;
  return bar.time instanceof Date ? bar.time.getTime() : Date.parse(bar.time);
}

/** Session index span for `range.kind === 'session'` — matches `resolveOccupancyWindow` session pick. */
function _matrixSessionBarIndices() {
  const range = state.matrixState.range;
  if (!range || range.kind !== 'session') return null;
  const sessions = state.replay.sessions;
  if (!sessions.length) return null;
  const effEnd = state.chartViewEnd !== null ? state.chartViewEnd : state.replay.cursor;
  const idx = Math.max(0, Math.min(state.replay.allBars.length - 1, effEnd - 1));
  for (const s of sessions) {
    if (idx >= s.startIdx && idx < s.endIdx) {
      return { startIdx: s.startIdx, endIdx: s.endIdx };
    }
  }
  const last = sessions[sessions.length - 1];
  return last ? { startIdx: last.startIdx, endIdx: last.endIdx } : null;
}

/**
 * Time bounds aligned with `/occupancy` when cache is warm: response `from`/`to`
 * are server-resolved (critical for `session_date` queries vs client session meta).
 */
function _pointCloudTimeBoundsMs(win) {
  const occ = state.matrixState?.occupancy;
  if (occ?.from && occ?.to) {
    const fromMs = Date.parse(occ.from);
    const toMs = Date.parse(occ.to);
    if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
      return { fromMs, toMs };
    }
  }
  if (!win?.from || !win?.to) return null;
  const fromMs = Date.parse(win.from);
  const toMs = Date.parse(win.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return { fromMs, toMs };
}

function _appendFormingBarIfInTimeWindow(out, fromMs, toMs) {
  const forming = state.formingBar;
  if (forming?.time == null) return;
  const ft = _barTimeMsForMatrix(forming);
  if (!Number.isFinite(ft) || ft < fromMs || ft > toMs) return;
  if (out.some(b => _barTimeMsForMatrix(b) === ft)) return;
  out.push(forming);
}

/** Bars for the point cloud — same universe as occupancy (session slice or server time window). */
function _getBarsForMatrixPointCloud() {
  const win = resolveOccupancyWindow();
  if (!win) {
    return _getViewedBarsForMatrix();
  }
  const replay = state.replay;
  if (replay.mode !== 'real' || !replay.allBars?.length) {
    return _getViewedBarsForMatrix();
  }

  const span = _matrixSessionBarIndices();
  if (span != null) {
    const out = replay.allBars.slice(span.startIdx, span.endIdx);
    const bounds = _pointCloudTimeBoundsMs(win);
    if (bounds) {
      _appendFormingBarIfInTimeWindow(out, bounds.fromMs, bounds.toMs);
    }
    return out;
  }

  const bounds = _pointCloudTimeBoundsMs(win);
  if (!bounds) {
    return _getViewedBarsForMatrix();
  }
  const { fromMs, toMs } = bounds;
  const out = [];
  for (const bar of replay.allBars) {
    const t = _barTimeMsForMatrix(bar);
    if (!Number.isFinite(t) || t < fromMs || t > toMs) continue;
    out.push(bar);
  }
  _appendFormingBarIfInTimeWindow(out, fromMs, toMs);
  return out;
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

/**
 * Spans `[earlier,later]` bar times from loaded `GET /divergence-events` rows whose interval
 * contains `hoverMs`. Matrix scatter treats every bar in those spans as hovered when any bar
 * in the span is the chart/matrix hover target (Phase 6 brush-link).
 */
function _cvdDivergenceHoverSpansContaining(hoverMs) {
  if (!Number.isFinite(hoverMs) || state.replay.mode !== 'real') return [];
  const divs = state.replay.allDivergences;
  if (!divs?.length) return [];
  const out = [];
  for (const d of divs) {
    const t0 = Date.parse(d.earlierTime);
    const t1 = Date.parse(d.laterTime);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    const lo = Math.min(t0, t1);
    const hi = Math.max(t0, t1);
    if (hoverMs >= lo && hoverMs <= hi) out.push({ lo, hi });
  }
  return out;
}

function resolvePointStyle(bar, { isSelected, isHovered, opacity, baseRadiusPx }) {
  const base = Number.isFinite(baseRadiusPx) && baseRadiusPx > 0 ? baseRadiusPx : POINT_RADIUS_PX;
  let radius = base;
  if (isSelected) radius = base * MATRIX_POINT_SELECTED_RADIUS_MULT;
  else if (isHovered) radius = base * MATRIX_POINT_HOVER_RADIUS_MULT;
  const zIndex = isSelected ? 4 : (isHovered ? 3 : 2);
  const { fill: candleFill, stroke: candleStroke } = _matrixScatterCandleFillAndStroke(bar);
  const stroke = isSelected
    ? POINT_SELECTED_STROKE_COLOR
    : (isHovered ? POINT_HOVER_STROKE_COLOR : candleStroke);
  return {
    radius,
    fill: candleFill,
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
  const canvas = document.getElementById('matrixScatterCanvas');
  if (!canvas) return;
  state.matrixScatterHits = [];

  const frame = _resolvePointFrame(inner);
  if (!frame) {
    canvas.style.display = 'none';
    return;
  }

  const pointBars = _getBarsForMatrixPointCloud();
  const eligible = [];
  for (const bar of pointBars) {
    const sample = _scatterVolDepthForBar(bar);
    if (!sample) continue;
    eligible.push({
      bar,
      barTimeMs: sample.barTimeMs,
      vol: sample.vol,
      depth: sample.depth,
    });
  }

  canvas.style.display = 'block';
  canvas.style.position = 'absolute';
  canvas.style.left = `${frame.x.toFixed(2)}px`;
  canvas.style.top = `${frame.y.toFixed(2)}px`;
  canvas.style.width = `${frame.w.toFixed(2)}px`;
  canvas.style.height = `${frame.h.toFixed(2)}px`;

  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  canvas.width = Math.round(frame.w * dpr);
  canvas.height = Math.round(frame.h * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, frame.w, frame.h);

  const count = eligible.length;
  if (!count) return;

  const scatterAgg = _aggregateScatterExtents(eligible);

  const ladderBars = getLoadedBarsForMatrixVolumeLadder();
  const volLadder = computeMatrixSqrtVolumeLadder(ladderBars);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const accent = [];
  /** Hovered/selected disks: redrawn source-over so hue is stable under `lighter` + larger hover radius. */
  const pinnedScatterOverlays = [];
  for (let i = 0; i < count; i++) {
    const point = eligible[i];
    const age = (count - 1) - i;
    const tAge = age / Math.max(count - 1, 1);
    const opacity = POINT_MAX_OPACITY - tAge * (POINT_MAX_OPACITY - POINT_MIN_OPACITY);
    const { xNorm, yNorm } = _normScatterToFrame(point.vol, point.depth, scatterAgg);
    const px = xNorm * frame.w;
    const py = yNorm * frame.h;
    const isSelected = state.selection.barTimes?.has(point.barTimeMs) || false;
    const hb = state.selection.hoverBarTime;
    const divSpans = _cvdDivergenceHoverSpansContaining(hb);
    const inCvdDivSpan = divSpans.some(
      (span) => point.barTimeMs >= span.lo && point.barTimeMs <= span.hi,
    );
    const isHovered =
      hb != null && (hb === point.barTimeMs || inCvdDivSpan);
    const baseRadiusPx = matrixVolumeBaseRadiusPx(point.bar, volLadder, POINT_RADIUS_PX);
    const style = resolvePointStyle(point.bar, {
      isSelected,
      isHovered,
      opacity,
      baseRadiusPx,
    });

    state.matrixScatterHits.push({
      x: px,
      y: py,
      r: style.radius,
      barTimeMs: point.barTimeMs,
    });

    const pinFill = isSelected || isHovered;
    if (pinFill) {
      pinnedScatterOverlays.push({ px, py, r: style.radius, opacity, bar: point.bar });
    } else if (style.fill) {
      ctx.globalAlpha = opacity;
      ctx.beginPath();
      ctx.arc(px, py, style.radius, 0, Math.PI * 2);
      ctx.fillStyle = style.fill;
      ctx.fill();
    }
    if (isSelected || isHovered) {
      accent.push({ px, py, r: style.radius, stroke: isSelected ? POINT_SELECTED_STROKE_COLOR : POINT_HOVER_STROKE_COLOR });
    }
  }
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  for (const pin of pinnedScatterOverlays) {
    const { fill } = _matrixScatterCandleFillAndStroke(pin.bar);
    ctx.globalAlpha = pin.opacity;
    ctx.beginPath();
    ctx.arc(pin.px, pin.py, pin.r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  for (const a of accent) {
    ctx.beginPath();
    ctx.arc(a.px, a.py, a.r, 0, Math.PI * 2);
    ctx.strokeStyle = a.stroke;
    ctx.lineWidth = Math.max(1, POINT_STROKE_WIDTH_PX);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Canvas pointer pick (CSS px coords inside `#matrixScatterCanvas`). Prefers chronologically newer hits when stacked.
 *
 * @param {number} clientX  viewport X
 * @param {number} clientY  viewport Y
 * @returns {number|null}   bar_time ms
 */
function pickMatrixScatterBarTime(clientX, clientY) {
  const canvas = document.getElementById('matrixScatterCanvas');
  if (!canvas || canvas.style.display === 'none') return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const lx = clientX - rect.left;
  const ly = clientY - rect.top;
  const hits = state.matrixScatterHits || [];
  let bestMs = null;
  let bestD = Infinity;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    const dx = lx - h.x;
    const dy = ly - h.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= h.r * h.r && d2 <= bestD) {
      bestD = d2;
      bestMs = h.barTimeMs;
    }
  }
  return Number.isFinite(bestMs) ? bestMs : null;
}

/**
 * Map a viewport click to the matrix cell (r,c) under the scatter canvas (same
 * grid as `.matrix-cell` dataset). The canvas stacks above cells; hits that
 * miss scatter disks still fall in a cell for regime brushing.
 *
 * @returns {{ r: number, c: number } | null}
 */
function pickMatrixCellFromScatterCanvas(clientX, clientY) {
  const canvas = document.getElementById('matrixScatterCanvas');
  if (!canvas || canvas.style.display === 'none') return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const lx = clientX - rect.left;
  const ly = clientY - rect.top;
  if (lx < 0 || ly < 0 || lx > rect.width || ly > rect.height) return null;
  const c = Math.min(MATRIX_COLS - 1, Math.max(0, Math.floor((lx / rect.width) * MATRIX_COLS)));
  const r = Math.min(MATRIX_ROWS - 1, Math.max(0, Math.floor((ly / rect.height) * MATRIX_ROWS)));
  return { r, c };
}

export { buildMatrix, renderMatrix, pickMatrixScatterBarTime, pickMatrixCellFromScatterCanvas };
