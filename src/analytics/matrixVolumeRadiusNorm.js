/**
 * Stable sqrt(volume) ladder for regime-matrix point radii (decoupled from chart viewport).
 * Winsorize at p5/p95 on sqrt(volume) over loaded bars — robust tails; spike-heavy days
 * compress extremes (see requirements — tunable toward p1/p99 later).
 */

import { state } from '../state.js';

/** Lower / upper percentile on sorted sqrt volumes (loaded timeframe universe). */
export const MATRIX_SQRT_VOLUME_LO_PCT = 0.05;
export const MATRIX_SQRT_VOLUME_HI_PCT = 0.95;

function _percentileLinear(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const idx = (n - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

/** Loaded timeline for active TF — same universe matrix percentile ladder uses. */
export function getLoadedBarsForMatrixVolumeLadder() {
  const replay = state.replay;
  if (replay.mode === 'real' && replay.allBars?.length) return replay.allBars;
  return state.bars?.length ? state.bars : [];
}

/**
 * @returns {{ lo: number, hi: number, degenerate: boolean }}
 */
export function computeMatrixSqrtVolumeLadder(bars) {
  const sqrtVals = [];
  for (const b of bars || []) {
    const v = Number(b?.volume);
    if (!Number.isFinite(v) || v < 0) continue;
    sqrtVals.push(Math.sqrt(v));
  }
  sqrtVals.sort((a, b) => a - b);
  const n = sqrtVals.length;
  if (n === 0) return { lo: 0, hi: 1, degenerate: true };
  // Tiny samples: min/max avoids percentile artifacts.
  if (n < 5) {
    const lo = sqrtVals[0];
    const hi = sqrtVals[n - 1];
    return { lo, hi, degenerate: hi <= lo };
  }
  const lo = _percentileLinear(sqrtVals, MATRIX_SQRT_VOLUME_LO_PCT);
  const hi = _percentileLinear(sqrtVals, MATRIX_SQRT_VOLUME_HI_PCT);
  return { lo, hi, degenerate: hi <= lo };
}

/**
 * Base pixel radius before hover/selection multipliers.
 * Maps winsorized sqrt(volume) into [pointRadiusPx * rMultLo, pointRadiusPx * rMultHi].
 */
export function matrixVolumeBaseRadiusPx(bar, ladder, pointRadiusPx, rMultLo = 0.65, rMultHi = 1.35) {
  const v = Number(bar?.volume);
  const sqrtV = Number.isFinite(v) && v >= 0 ? Math.sqrt(v) : NaN;
  if (!Number.isFinite(sqrtV) || ladder.degenerate || ladder.hi <= ladder.lo) {
    return pointRadiusPx;
  }
  const t = Math.max(0, Math.min(1, (sqrtV - ladder.lo) / (ladder.hi - ladder.lo)));
  const mult = rMultLo + (rMultHi - rMultLo) * t;
  return pointRadiusPx * mult;
}
