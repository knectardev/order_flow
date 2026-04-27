function rand(min, max) { return min + Math.random() * (max - min); }

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

// `quintileBreaks` and `bucketByBreaks` were retired in regime-DB plan
// §2f along with the session-local quintile-proxy regime classifier.
// The data-driven 5x5 ranking now happens in
// `pipeline/src/orderflow_pipeline/regime.py` and arrives on each bar
// as `vRank` / `dRank`.

export { rand, clamp };
