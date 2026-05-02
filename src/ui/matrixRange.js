// ───────────────────────────────────────────────────────────
// Matrix occupancy range selector + heatmap toggle (regime-DB plan §3b/§3c).
//
// Owns `range.kind` reducers (Current session / Last hour / Last N /
// Custom) that resolve `state.matrixState.range`
// down to a concrete (from, to[, sessionDate]) trio for /occupancy.
// `resolveOccupancyWindow()` is called every render — it's pure,
// deterministic in `(cursor, range, replay.sessions)`, and cheap.
//
// The display-mode toggle (Heatmap | Posterior) is also wired here
// because it's one click and lives in the same matrix-panel header.
// State writes always end with `repaintMatrix()` which recomputes
// scores, runs canonical evaluators, and calls renderMatrix(). Heavier
// downstream effects (priceChart, eventLog) are *not* triggered by
// matrix-range changes — the range drives occupancy, heatmap, diagnostics,
// and the point cloud (`resolveOccupancyWindow()`).
// ───────────────────────────────────────────────────────────
import { state } from '../state.js';
import { evaluateAbsorptionWallCanonical, evaluateBreakoutCanonical, evaluateFadeCanonical, evaluateValueEdgeReject } from '../analytics/canonical.js';
import { computeMatrixScores } from '../analytics/regime.js';
import { renderMatrix } from '../render/matrix.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

// ───────────────────────────────────────────────────────────
// Pure window resolution from `state.matrixState.range`.
//
// Returns null if the active range can't be resolved (e.g. dashboard is
// in synthetic mode and `state.replay.sessions` is empty). Callers
// (renderMatrix) treat null as "no occupancy data available — render
// the matrix without the heatmap layer and skip the diagnostic line".
// ───────────────────────────────────────────────────────────
function resolveOccupancyWindow() {
  if (state.replay.mode !== 'real' || state.replay.sessions.length === 0) return null;
  const range = state.matrixState.range;
  const sessions = state.replay.sessions;
  const effEnd = state.chartViewEnd !== null ? state.chartViewEnd : state.replay.cursor;

  if (range.kind === 'session') {
    const idx = Math.max(0, Math.min(state.replay.allBars.length - 1, effEnd - 1));
    const sess = _sessionContaining(idx) || sessions[sessions.length - 1];
    if (!sess) return null;
    return {
      sessionDate: sess.date,
      from: sess.sessionStart,
      to:   sess.sessionEnd,
      label: `Current RTH (${sess.date})`,
    };
  }

  if (range.kind === 'lastHour') {
    const cursorBar = state.replay.allBars[Math.max(0, effEnd - 1)];
    if (!cursorBar) return null;
    const cursorMs = cursorBar.time instanceof Date ? cursorBar.time.getTime()
                                                    : Date.parse(cursorBar.time);
    const fromMs = cursorMs - ONE_HOUR_MS;
    return {
      sessionDate: null,
      from: _isoZ(fromMs),
      to:   _isoZ(cursorMs),
      label: 'Last hour',
    };
  }

  if (range.kind === 'lastN') {
    const n = Math.max(1, range.n || 5);
    const slice = sessions.slice(Math.max(0, sessions.length - n));
    if (slice.length === 0) return null;
    return {
      sessionDate: null,
      from: slice[0].sessionStart,
      to:   slice[slice.length - 1].sessionEnd,
      label: `Last ${slice.length} session${slice.length === 1 ? '' : 's'}`,
    };
  }

  // Legacy / defensive: `all` is no longer selectable in the UI; treat as
  // capped trailing sessions so occupancy stays bounded.
  if (range.kind === 'all') {
    const cap = 20;
    const n = Math.min(cap, sessions.length);
    const slice = sessions.slice(Math.max(0, sessions.length - n));
    if (slice.length === 0) return null;
    return {
      sessionDate: null,
      from: slice[0].sessionStart,
      to: slice[slice.length - 1].sessionEnd,
      label: `Last ${slice.length} session${slice.length === 1 ? '' : 's'} (capped)`,
    };
  }

  if (range.kind === 'custom') {
    if (!range.from || !range.to) return null;
    return {
      sessionDate: null,
      from: range.from,
      to:   range.to,
      label: `Custom · ${_shortLabel(range.from)} → ${_shortLabel(range.to)}`,
    };
  }

  return null;
}

function _sessionContaining(barIdx) {
  for (const s of state.replay.sessions) {
    if (barIdx >= s.startIdx && barIdx < s.endIdx) return s;
  }
  return null;
}

function _isoZ(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

function _shortLabel(iso) {
  if (!iso) return '?';
  return iso.slice(5, 16).replace('T', ' ');   // "MM-DDTHH:MM" → "MM-DD HH:MM"
}

// ───────────────────────────────────────────────────────────
// Range-selector wiring. The HTML in orderflow_dashboard.html provides
// the buttons; this module binds clicks → state mutations + repaint.
// ───────────────────────────────────────────────────────────
function _setRange(kind, extras = {}) {
  const prev = state.matrixState.range || {};
  state.matrixState.range = { ...prev, ...extras, kind };
  // Clear the cached projection so a stale grid doesn't render for one
  // frame while the new fetch is in flight. The renderer will issue a
  // fresh /occupancy request on its next pass.
  state.matrixState.occupancy = null;
  _highlightActiveRangeButton();
  repaintMatrix();
}

function _highlightActiveRangeButton() {
  const kind = state.matrixState.range.kind;
  document.querySelectorAll('.matrix-range-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.kind === kind);
  });
  const lastN = state.matrixState.range.n;
  const sel = document.getElementById('matrixRangeNSelect');
  if (sel && lastN) sel.value = String(lastN);
  const customRow = document.getElementById('matrixRangeCustomRow');
  if (customRow) customRow.style.display = (kind === 'custom') ? 'flex' : 'none';
}

function _setDisplayMode(mode) {
  state.matrixState.displayMode = (mode === 'heatmap') ? 'heatmap' : 'posterior';
  document.querySelectorAll('.matrix-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.matrixState.displayMode);
  });
  repaintMatrix();
}

function repaintMatrix() {
  // Re-run the same render path step()/seek() use. Doing this from a
  // UI handler is safe — we don't touch replay.bars or detection
  // state, only the matrix overlay. Canonical evaluators are called
  // so watch borders / fire halos stay in sync with the live cursor.
  state.matrixScores = state.regimeWarmup
    ? state.matrixScores
    : computeMatrixScores();
  const breakout = evaluateBreakoutCanonical();
  const fade     = evaluateFadeCanonical();
  const absorptionWall = evaluateAbsorptionWallCanonical();
  const valueEdgeReject = evaluateValueEdgeReject();
  renderMatrix(breakout, fade, absorptionWall, valueEdgeReject);
}

function bindMatrixRangeUI() {
  // "All loaded" was removed from the UI (unbounded occupancy); migrate stale state.
  if (state.matrixState.range?.kind === 'all') {
    state.matrixState.range = {
      kind: 'lastN',
      n: 5,
      from: null,
      to: null,
      label: 'Last 5 sessions',
    };
  }
  document.querySelectorAll('.matrix-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind;
      if (kind === 'lastN') {
        const sel = document.getElementById('matrixRangeNSelect');
        const n = sel ? parseInt(sel.value, 10) || 5 : 5;
        _setRange('lastN', { n });
      } else if (kind === 'custom') {
        const from = document.getElementById('matrixRangeCustomFrom').value;
        const to   = document.getElementById('matrixRangeCustomTo').value;
        if (!from || !to) {
          // First click: just reveal the inputs and let the user fill them.
          state.matrixState.range = { kind: 'custom', from: null, to: null, n: null,
                                       label: 'Custom (set range)' };
          _highlightActiveRangeButton();
          repaintMatrix();
          return;
        }
        // datetime-local strings are local-time; reinterpret as UTC for
        // the API by appending 'Z'. Users entering "2026-04-21T13:30"
        // will get exactly that wall-clock window in UTC, which matches
        // the bar_time values stored in DuckDB.
        _setRange('custom', { from: `${from}:00Z`, to: `${to}:00Z`, n: null });
      } else {
        _setRange(kind, { from: null, to: null, n: null });
      }
    });
  });

  const sel = document.getElementById('matrixRangeNSelect');
  if (sel) {
    sel.addEventListener('change', () => {
      if (state.matrixState.range.kind === 'lastN') {
        _setRange('lastN', { n: parseInt(sel.value, 10) || 5 });
      }
    });
  }

  const customApply = document.getElementById('matrixRangeCustomApply');
  if (customApply) {
    customApply.addEventListener('click', () => {
      const from = document.getElementById('matrixRangeCustomFrom').value;
      const to   = document.getElementById('matrixRangeCustomTo').value;
      if (!from || !to) return;
      _setRange('custom', { from: `${from}:00Z`, to: `${to}:00Z`, n: null });
    });
  }

  document.querySelectorAll('.matrix-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => _setDisplayMode(btn.dataset.mode));
  });

  _highlightActiveRangeButton();
  document.querySelectorAll('.matrix-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.matrixState.displayMode);
  });
}

export { resolveOccupancyWindow, bindMatrixRangeUI, repaintMatrix };
