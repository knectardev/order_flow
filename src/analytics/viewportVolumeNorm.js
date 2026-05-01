/**
 * Viewport-relative volume bounds for PHAT candle body width only.
 * Used with `_getViewedBars()` slice — rescales when pan/zoom changes visible bars.
 */

export function computeViewportVolumeRange(viewedBars) {
  let minV = Infinity;
  let maxV = -Infinity;
  for (const b of viewedBars || []) {
    const v = Number(b?.volume);
    if (!Number.isFinite(v) || v < 0) continue;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
    return { minV: 0, maxV: 0, degenerate: true };
  }
  return { minV, maxV, degenerate: maxV <= minV };
}

/** Linear 0..1 inside [minV,maxV]; midpoint when degenerate or missing volume. */
export function volumeNorm01Linear(bar, range) {
  const v = Number(bar?.volume);
  if (!Number.isFinite(v)) return 0.5;
  if (!range || range.degenerate || range.maxV <= range.minV) return 0.5;
  const t = (v - range.minV) / (range.maxV - range.minV);
  return Math.max(0, Math.min(1, t));
}
