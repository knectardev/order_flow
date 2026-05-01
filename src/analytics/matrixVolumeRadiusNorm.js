/**
 * Stable sqrt(volume) ladder for regime-matrix point radii (decoupled from chart viewport).
 * Winsorize at MATRIX_LADDER_LO_PCT / HI_PCT on sqrt(volume) over loaded bars — same band as
 * abs(delta) coloring (`matrixLadderConstants.js`). Spike-heavy days compress extremes.
 */

import { state } from '../state.js';
import {
  MATRIX_LADDER_HI_PCT,
  MATRIX_LADDER_LO_PCT,
  linearPercentile,
} from './matrixLadderConstants.js';

export const MATRIX_SQRT_VOLUME_LO_PCT = MATRIX_LADDER_LO_PCT;
export const MATRIX_SQRT_VOLUME_HI_PCT = MATRIX_LADDER_HI_PCT;

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
  const lo = linearPercentile(sqrtVals, MATRIX_LADDER_LO_PCT);
  const hi = linearPercentile(sqrtVals, MATRIX_LADDER_HI_PCT);
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
