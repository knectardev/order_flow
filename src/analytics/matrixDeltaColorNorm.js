/**
 * Regime matrix point fill: signed bar delta with winsorized |delta| magnitude (HSL anchors).
 * See requirements §6.1 — orthogonal to volume-based radius (matrixVolumeRadiusNorm.js).
 */

import {
  MATRIX_LADDER_HI_PCT,
  MATRIX_LADDER_LO_PCT,
  linearPercentile,
} from './matrixLadderConstants.js';

/** Neutral fill: visible on dark matrix at min age opacity; stroke backstops edge. */
const NEUTRAL_H = 210;
const NEUTRAL_S = 12;
const NEUTRAL_L_FILL = 64;
const NEUTRAL_L_STROKE = 46;

const GREEN_H = 142;
const GREEN_S_LO = 38;
const GREEN_S_HI = 92;
const GREEN_L_LO = 52;
const GREEN_L_HI = 48;

const RED_H = 4;
const RED_S_LO = 42;
const RED_S_HI = 93;
const RED_L_LO = 56;
const RED_L_HI = 52;

function _lerp(a, b, t) {
  return a + (b - a) * t;
}

function _clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * @returns {{ lo: number, hi: number, degenerate: boolean }}
 */
export function computeMatrixAbsDeltaLadder(bars) {
  const vals = [];
  for (const b of bars || []) {
    const d = Number(b?.delta);
    if (!Number.isFinite(d)) continue;
    vals.push(Math.abs(d));
  }
  vals.sort((a, b) => a - b);
  const n = vals.length;
  if (n === 0) return { lo: 0, hi: 1, degenerate: true };
  if (n < 5) {
    const lo = vals[0];
    const hi = vals[n - 1];
    return { lo, hi, degenerate: hi <= lo };
  }
  const lo = linearPercentile(vals, MATRIX_LADDER_LO_PCT);
  const hi = linearPercentile(vals, MATRIX_LADDER_HI_PCT);
  return { lo, hi, degenerate: hi <= lo };
}

function _magnitudeT(bar, ladder) {
  const d = Number(bar?.delta);
  if (!Number.isFinite(d)) return 0;
  const ad = Math.abs(d);
  if (ladder.degenerate || ladder.hi <= ladder.lo) return 0;
  return _clamp01((ad - ladder.lo) / (ladder.hi - ladder.lo));
}

/** Darken ring vs fill for readability on black chrome. */
function _strokeFromHueSatLight(h, s, l) {
  const lStroke = Math.max(24, l - 14);
  const sStroke = Math.min(100, s + 2);
  return `hsl(${h}, ${sStroke}%, ${lStroke}%)`;
}

/**
 * @returns {{ fill: string, stroke: string }} CSS color strings (hsl)
 */
export function matrixDeltaFillAndStroke(bar, ladder) {
  const lad = ladder && typeof ladder.lo === 'number' && typeof ladder.hi === 'number'
    ? ladder
    : { lo: 0, hi: 1, degenerate: true };
  const d = Number(bar?.delta);
  if (!Number.isFinite(d) || d === 0) {
    return {
      fill: `hsl(${NEUTRAL_H}, ${NEUTRAL_S}%, ${NEUTRAL_L_FILL}%)`,
      stroke: `hsl(${NEUTRAL_H}, ${NEUTRAL_S}%, ${NEUTRAL_L_STROKE}%)`,
    };
  }

  const t = _magnitudeT(bar, lad);
  if (d > 0) {
    const s = _lerp(GREEN_S_LO, GREEN_S_HI, t);
    const l = _lerp(GREEN_L_LO, GREEN_L_HI, t);
    const fill = `hsl(${GREEN_H}, ${s}%, ${l}%)`;
    return { fill, stroke: _strokeFromHueSatLight(GREEN_H, s, l) };
  }
  const s = _lerp(RED_S_LO, RED_S_HI, t);
  const l = _lerp(RED_L_LO, RED_L_HI, t);
  const fill = `hsl(${RED_H}, ${s}%, ${l}%)`;
  return { fill, stroke: _strokeFromHueSatLight(RED_H, s, l) };
}
