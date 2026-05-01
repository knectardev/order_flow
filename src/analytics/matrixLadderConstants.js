/**
 * Shared percentile band for matrix ladders (sqrt(volume) radii, abs(delta) color).
 * Tune here if extreme tails clip too aggressively on delta vs volume.
 */

/** Lower winsor bound (inclusive) on sorted samples. */
export const MATRIX_LADDER_LO_PCT = 0.05;

/** Upper winsor bound (inclusive) on sorted samples. */
export const MATRIX_LADDER_HI_PCT = 0.95;

/**
 * @param {number[]} sortedAsc non-decreasing
 * @param {number} p in [0,1]
 */
export function linearPercentile(sortedAsc, p) {
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
