// ───────────────────────────────────────────────────────────
// True tick-level volume profile — fetched from /profile (regime-DB plan §1b').
//
// In API mode the dashboard replaces the OHLC-distribution proxy in
// `src/analytics/profile.js#computeProfile` with a fetch against
// `/profile?from=&to=&session_date=`, which serves real per-print volume
// + signed delta from the DuckDB `bar_volume_profile` table. POC / VAH /
// VAL are computed server-side (same value-area-fraction logic the JS
// proxy uses) and the response shape mirrors the proxy's return shape so
// `priceChart.js` can consume both with one render path.
//
// Caching: range-keyed in-memory map. The same (from, to) window inside
// one session almost certainly has identical contents, and the natural
// recompute trigger is "session boundary or visible window change" —
// both of which produce a different cache key. The browser's HTTP cache
// catches additional duplicates if the API sets sensible Cache-Control,
// but the in-memory map saves the round-trip cost on cursor-move-driven
// re-renders inside one session.
//
// In synthetic mode and (Phase 1's still-supported) JSON mode, this
// module is unused — `priceChart.js` falls back to `computeProfile`.
// ───────────────────────────────────────────────────────────
import { state } from '../state.js';

const _cache = new Map();   // key: `${tf}|${from}|${to}`  →  Promise<profile>

// Phase 5: cache + request URL are scoped to the active timeframe so a
// 1m profile and a 15m profile for the same (from, to) window stay
// distinct (the per-tick aggregation is timeframe-scoped on the server).
function _activeTf() {
  return state.activeTimeframe || '1m';
}

function _key(from, to, tf) {
  return `${tf}|${from}|${to}`;
}

// In-flight de-dup: when two render passes ask for the same window before
// the first response arrives, we return the same Promise and the network
// hits exactly once. Resolved entries stay cached for the lifetime of the
// page (the dashboard never deletes ranges; clearing on session change is
// done by `clearProfileCache()`).
function fetchProfile(from, to) {
  const apiBase = state.replay.apiBase;
  if (!apiBase) {
    return Promise.reject(new Error('fetchProfile called without state.replay.apiBase'));
  }
  const tf = _activeTf();
  const k = _key(from, to, tf);
  const hit = _cache.get(k);
  if (hit) return hit;

  const url = `${apiBase}/profile?timeframe=${encodeURIComponent(tf)}`
    + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const p = fetch(url)
    .then(r => {
      if (!r.ok) throw new Error(`/profile ${r.status}`);
      return r.json();
    })
    .catch(err => {
      // Drop failed entries from the cache so a later retry can succeed
      // — keeping a rejected Promise around would make every subsequent
      // render see the failure forever. Surface the failure to the
      // console so the dashboard's "no profile lines" symptom isn't
      // silently masked when /profile is down or returns a 5xx — the
      // priceChart fallback to the OHLC proxy keeps the chart usable
      // either way, but without this log we'd never know to investigate.
      _cache.delete(k);
      console.warn('[orderflow] /profile fetch failed:', from, '→', to, err.message);
      throw err;
    });
  _cache.set(k, p);
  return p;
}

// Synchronous accessor used by the chart renderer. Returns the resolved
// profile if the (from, to) window is already in cache; otherwise kicks
// off the fetch and returns null. The caller (priceChart.js) re-renders
// when the cache fills via `requestProfile`'s onResolve hook.
function getCachedProfile(from, to) {
  const hit = _cache.get(_key(from, to, _activeTf()));
  if (!hit || typeof hit.then !== 'function') return null;
  // Promise.any on resolved-vs-pending: we can't introspect a Promise's
  // state synchronously, so we stash the resolved value on a side
  // property when the Promise resolves (set up at request time below).
  return hit._resolved || null;
}

// Has the (from, to) window's fetch ALREADY resolved (success or
// success-with-null-payload)? Distinct from getCachedProfile which
// returns null for both "fetch in flight" and "fetch resolved but the
// server returned all-null POC/VAH/VAL". The chart renderer uses this
// to avoid re-issuing requestProfile() in the resolved-but-null case —
// without this gate, requestProfile() invokes onResolve synchronously
// for already-resolved entries and the renderer's microtask-scheduled
// re-render becomes an infinite loop (re-render → requestProfile →
// sync onResolve → schedule re-render → …).
function hasResolvedProfile(from, to) {
  const hit = _cache.get(_key(from, to, _activeTf()));
  return !!(hit && hit._resolved);
}

// Fire-and-forget request for a window. When the response arrives the
// resolved value is stamped on the cached Promise so getCachedProfile()
// can find it without re-awaiting; `onResolve` is invoked once on
// completion (used by priceChart.js to trigger a re-render with the now-
// available data). Calling this twice for the same window is cheap —
// fetchProfile() de-dupes in flight.
function requestProfile(from, to, onResolve) {
  const k = _key(from, to, _activeTf());
  const hit = _cache.get(k);
  if (hit && hit._resolved) {
    if (onResolve) onResolve(hit._resolved);
    return hit._resolved;
  }
  const p = fetchProfile(from, to);
  p.then(val => {
    p._resolved = val;
    if (onResolve) onResolve(val);
  }).catch(() => { /* already cleared from cache; renderer falls back */ });
  return null;
}

function clearProfileCache() {
  _cache.clear();
}

export { fetchProfile, getCachedProfile, hasResolvedProfile, requestProfile, clearProfileCache };
