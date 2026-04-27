// ───────────────────────────────────────────────────────────
// Cell-occupancy histogram — fetched from /occupancy (regime-DB plan §3a).
//
// The endpoint returns the 5x5 GROUP BY (v_rank, d_rank, COUNT(*)) for a
// time window, plus `total_bars` (the rankable denominator — NULL-rank
// warmup/zero-vol bars excluded). The matrix renderer projects this into
// a 5x5 number grid (`grid[r][c]`) where r = 4 - (v_rank - 1) (top row =
// highest vol) and c = d_rank - 1 (right col = deepest book), matching
// the existing posterior-shading layout.
//
// Caching:
//   - In-memory range-keyed Map for in-flight de-dup + sync access from
//     `renderMatrix()`. Same shape as `profileApi.js`.
//   - The browser's HTTP cache adds a second tier: API sets max-age=60
//     for fixed (from,to) windows (immutable historical data) and
//     no-cache for session_date-bound windows (cursor-driven, must
//     re-resolve on session boundary).
//
// `setOccupancy(latest)` projects the API rows into the renderer-ready
// `state.matrixState.occupancy` shape:
//     { from, to, totalBars, maxCell, grid: number[5][5] }
// `grid` is dense (every cell 0 if not in API rows) so renderers don't
// need defensive lookups per cell.
// ───────────────────────────────────────────────────────────
import { MATRIX_COLS, MATRIX_ROWS } from '../config/constants.js';
import { state } from '../state.js';

const _cache = new Map();   // key: `${from}|${to}`  →  Promise<occupancy>

function _key(from, to) {
  return `${from}|${to}`;
}

function _projectToGrid(api) {
  // grid[r][c] — r = 4 - (v_rank-1); c = d_rank - 1. v_rank=5 (most
  // volatile) lands on row 0 (top), v_rank=1 (quiet) on row 4 (bottom).
  const grid = Array.from({ length: MATRIX_ROWS }, () => Array(MATRIX_COLS).fill(0));
  let maxCell = 0;
  for (const c of api.cells || []) {
    const v = c.v_rank, d = c.d_rank;
    if (v < 1 || v > 5 || d < 1 || d > 5) continue;
    const row = 4 - (v - 1);
    const col = d - 1;
    grid[row][col] = c.occupancy;
    if (c.occupancy > maxCell) maxCell = c.occupancy;
  }
  return {
    from:      api.from,
    to:        api.to,
    totalBars: api.total_bars || 0,
    maxCell,
    grid,
  };
}

function fetchOccupancy(from, to, sessionDate = null) {
  const apiBase = state.replay.apiBase;
  if (!apiBase) {
    return Promise.reject(new Error('fetchOccupancy called without state.replay.apiBase'));
  }
  // Keying on `from|to` (already-resolved ISO strings) is sufficient
  // even when the caller passes session_date — the API resolves
  // session_date to the same (from, to) window every time, and the
  // client only knows about it as one of the param triggers. But we
  // include sessionDate in the cache key so that "Current session"
  // (uses session_date=) and a manually-requested fixed-range query
  // for the same boundaries don't collide on different Cache-Control
  // semantics.
  const k = sessionDate ? `sd:${sessionDate}` : _key(from, to);
  const hit = _cache.get(k);
  if (hit) return hit;

  const params = new URLSearchParams();
  if (sessionDate) {
    params.set('session_date', sessionDate);
  } else {
    params.set('from', from);
    params.set('to', to);
  }
  const url = `${apiBase}/occupancy?${params.toString()}`;
  const p = fetch(url)
    .then(r => {
      if (!r.ok) throw new Error(`/occupancy ${r.status}`);
      return r.json();
    })
    .then(_projectToGrid)
    .then(grid => {
      // Stash the resolved grid directly on the promise so
      // `getCachedOccupancy` can read it synchronously without a second
      // .then() on the call site (used by the renderer fast path).
      p._resolved = grid;
      return grid;
    })
    .catch(err => {
      _cache.delete(k);
      throw err;
    });
  _cache.set(k, p);
  return p;
}

function getCachedOccupancy(from, to, sessionDate = null) {
  const k = sessionDate ? `sd:${sessionDate}` : _key(from, to);
  const hit = _cache.get(k);
  if (!hit || typeof hit.then !== 'function') return null;
  return hit._resolved || null;
}

function requestOccupancy(from, to, sessionDate = null, onResolve) {
  const k = sessionDate ? `sd:${sessionDate}` : _key(from, to);
  const hit = _cache.get(k);
  if (hit && hit._resolved) {
    if (onResolve) onResolve(hit._resolved);
    return hit._resolved;
  }
  const p = fetchOccupancy(from, to, sessionDate);
  p.then(val => {
    p._resolved = val;
    if (onResolve) onResolve(val);
  }).catch(() => { /* dropped from cache */ });
  return null;
}

function clearOccupancyCache() {
  _cache.clear();
}

export { fetchOccupancy, getCachedOccupancy, requestOccupancy, clearOccupancyCache };
