import { MATRIX_COLS, MATRIX_ROWS } from '../config/constants.js';
import { state } from '../state.js';
import { clamp } from '../util/math.js';

// regime-DB plan §2c-d/§2f. Data-driven only: bars carry `vRank` /
// `dRank` ∈ {1..5} or null, computed by
// `pipeline/src/orderflow_pipeline/regime.py` and served via the
// FastAPI/DuckDB stack. NULL ranks ⇒ warmup, and we return null so the
// caller can dim the matrix and suppress canonical fires.
//
// The legacy session-local quintile-proxy fallback (which used MAD-z on
// avg trade size + large-print ratio for a depth proxy and per-session
// range-quintile breaks for vol) was retired in Phase 2f together with
// the JSON-manifest data path. Synthetic mode no longer drives the
// matrix; only `?source=api` does.
function deriveRegimeState(idx) {
  if (idx < 0 || idx >= state.replay.allBars.length) return null;
  const b = state.replay.allBars[idx];
  if (!b) return null;
  if (b.vRank == null || b.dRank == null) return null;   // warmup
  return { volState: b.vRank - 1, depthState: b.dRank - 1 };
}

function computeMatrixScores() {
  // Center on current state with a Gaussian-ish kernel, plus noise/uncertainty
  const cx = state.sim.volState;     // col index
  const cy = state.sim.depthState;   // row index (0=top=climactic? we'll flip mapping)
  // We display row 0 = Climactic (top), row 4 = Quiet (bottom).
  // Map: matrix row index r = 4 - volState  (highest vol at top)
  // Map: matrix col index c = depthState     (deepest book at right)
  const rTarget = 4 - state.sim.volState;
  const cTarget = state.sim.depthState;
  const sigma = 0.85;  // spread

  const scores = Array.from({length: MATRIX_ROWS}, () => Array(MATRIX_COLS).fill(0));
  let total = 0;
  for (let r = 0; r < MATRIX_ROWS; r++) {
    for (let c = 0; c < MATRIX_COLS; c++) {
      const d2 = (r - rTarget) ** 2 + (c - cTarget) ** 2;
      const w = Math.exp(-d2 / (2 * sigma * sigma));
      const noise = 0.05 + Math.random() * 0.05;
      scores[r][c] = w + noise;
      total += scores[r][c];
    }
  }
  // Normalize
  for (let r = 0; r < MATRIX_ROWS; r++)
    for (let c = 0; c < MATRIX_COLS; c++)
      scores[r][c] /= total;

  return scores;
}

function topCells(scores, n) {
  const flat = [];
  for (let r = 0; r < MATRIX_ROWS; r++)
    for (let c = 0; c < MATRIX_COLS; c++)
      flat.push({ r, c, s: scores[r][c] });
  flat.sort((a,b) => b.s - a.s);
  return flat.slice(0, n);
}

function computeConfidence(scores) {
  const top = topCells(scores, 2);
  if (top.length < 2) return 1;
  const ratio = top[0].s / Math.max(top[1].s, 0.0001);
  // map ratio (1.0 → 0, 3.0+ → 1) sigmoidally
  return clamp((ratio - 1) / 2, 0, 1);
}

export { deriveRegimeState, computeMatrixScores, topCells, computeConfidence };
