import { MATRIX_COLS, MATRIX_ROWS } from '../config/constants.js';
import { state } from '../state.js';
import { sessionForBar } from '../data/replay.js';
import { bucketByBreaks, clamp, quintileBreaks } from '../util/math.js';

function precomputeRegimeBreaks() {
  if (!state.replay.allBars.length || !state.replay.sessions.length) return;

  const med = arr => {
    const s = arr.slice().sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const mad = (arr, m) => {
    const dev = arr.map(x => Math.abs(x - m));
    return med(dev) || 1e-9;
  };

  for (const sess of state.replay.sessions) {
    const sBars = state.replay.allBars.slice(sess.startIdx, sess.endIdx);
    if (sBars.length === 0) {
      sess.regimeBreaks = null;
      continue;
    }
    const ranges    = sBars.map(b => b.high - b.low);
    const avgSizes  = sBars.map(b => b.avgTradeSize || 0);
    const lpRatios  = sBars.map(b => b.tradeCount > 0 ? (b.largePrintCount || 0) / b.tradeCount : 0);

    const sizeMed = med(avgSizes), sizeMad = mad(avgSizes, sizeMed);
    const lpMed   = med(lpRatios), lpMad   = mad(lpRatios, lpMed);
    // Depth proxy: higher avg trade size + higher large-print ratio → deeper.
    const depthScores = sBars.map((b, i) => {
      const z1 = (avgSizes[i] - sizeMed) / (1.4826 * sizeMad);
      const z2 = (lpRatios[i] - lpMed)   / (1.4826 * lpMad);
      return 0.5 * z1 + 0.5 * z2;
    });

    sess.regimeBreaks = {
      volBreaks:   quintileBreaks(ranges),
      depthBreaks: quintileBreaks(depthScores),
      // depthScores is keyed by session-local index (0..barCount-1); callers
      // must subtract sess.startIdx before indexing.
      depthScores,
    };
  }
}

function deriveRegimeState(idx) {
  if (idx < 0 || idx >= state.replay.allBars.length) {
    return { volState: 2, depthState: 2 };
  }
  const sess = sessionForBar(idx);
  if (!sess || !sess.regimeBreaks) return { volState: 2, depthState: 2 };
  const b = state.replay.allBars[idx];
  const range = b.high - b.low;
  const localIdx = idx - sess.startIdx;
  const volState = bucketByBreaks(range, sess.regimeBreaks.volBreaks);
  const depthState = bucketByBreaks(sess.regimeBreaks.depthScores[localIdx], sess.regimeBreaks.depthBreaks);
  return { volState, depthState };
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

export { precomputeRegimeBreaks, deriveRegimeState, computeMatrixScores, topCells, computeConfidence };
