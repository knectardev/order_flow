import { PROFILE_BINS, VA_FRACTION } from '../config/constants.js';
import { step } from '../sim/step.js';
import { clamp } from '../util/math.js';

function computeProfile(barsIn) {
  if (barsIn.length === 0) return null;
  let lo = Infinity, hi = -Infinity, totalVol = 0;
  for (const b of barsIn) {
    if (b.low  < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
    totalVol += b.volume;
  }
  if (hi - lo < 0.001) hi = lo + 0.001;
  const step = (hi - lo) / PROFILE_BINS;
  const bins = new Array(PROFILE_BINS).fill(0);

  // Distribute each bar's volume across its range, weighted toward close
  for (const b of barsIn) {
    const startIdx = Math.max(0, Math.floor((b.low  - lo) / step));
    const endIdx   = Math.min(PROFILE_BINS - 1, Math.floor((b.high - lo) / step));
    const span = endIdx - startIdx + 1;
    if (span <= 0) continue;
    const closeIdx = clamp(Math.floor((b.close - lo) / step), 0, PROFILE_BINS - 1);
    for (let i = startIdx; i <= endIdx; i++) {
      // Triangular weight toward close
      const dist = Math.abs(i - closeIdx);
      const w = 1 / (1 + dist * 0.6);
      bins[i] += b.volume * w / span;
    }
  }

  // POC = bin with max volume
  let pocIdx = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[pocIdx]) pocIdx = i;

  // Expand outward from POC until VA_FRACTION of volume captured
  const sumBins = bins.reduce((s, x) => s + x, 0);
  const target = sumBins * VA_FRACTION;
  let acc = bins[pocIdx];
  let lo_i = pocIdx, hi_i = pocIdx;
  while (acc < target && (lo_i > 0 || hi_i < PROFILE_BINS - 1)) {
    const upNext   = hi_i < PROFILE_BINS - 1 ? bins[hi_i + 1] : -1;
    const downNext = lo_i > 0                 ? bins[lo_i - 1] : -1;
    if (upNext >= downNext && hi_i < PROFILE_BINS - 1) { hi_i++; acc += bins[hi_i]; }
    else if (lo_i > 0)                                  { lo_i--; acc += bins[lo_i]; }
    else break;
  }

  return {
    bins,
    binStep: step,
    priceLo: lo,
    priceHi: hi,
    pocPrice: lo + (pocIdx + 0.5) * step,
    valPrice: lo + lo_i * step,
    vahPrice: lo + (hi_i + 1) * step,
    maxBin: Math.max(...bins),
  };
}

export { computeProfile };
