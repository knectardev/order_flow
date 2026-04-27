function rand(min, max) { return min + Math.random() * (max - min); }

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function quintileBreaks(values) {
  const sorted = values.filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (sorted.length < 5) return [0, 0, 0, 0];
  const at = q => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
  return [at(0.2), at(0.4), at(0.6), at(0.8)];
}

function bucketByBreaks(value, breaks) {
  // Returns 0..4 (count of breakpoints the value exceeds).
  let n = 0;
  for (const b of breaks) if (value > b) n++;
  return n;
}

export { rand, clamp, quintileBreaks, bucketByBreaks };
