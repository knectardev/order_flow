import { BREAKOUT_CELL, FADE_CELL } from '../config/constants.js';
import { state } from '../state.js';
import { computeProfile } from './profile.js';
import { computeAnchoredVWAP, getVwapAnchors } from './vwap.js';

// ───────────────────────────────────────────────────────────────────
// Phase 6: directional bias vote table + alignment scoring + anchor-
// priority tag rule.
//
// The pipeline stamps a 7-level bias_state on every bar (per its own
// timeframe), and the writer denormalizes the bar's higher-timeframe
// parents (`biasH1`, `bias15m`) onto each LTF row at ingest time. At
// fire-eval time we read those denormalized parents off the last
// settled bar and convert them into directional votes against the 1m
// canonical's intended trade direction.
//
// Vote magnitudes (BIAS_VOTE):
//   BULLISH_STRONG : +2  (high-vol + deep + above VWAP, confirmed markup)
//   ACCUMULATION   : +1  (depth-leads-Location bullish anomaly)
//   BULLISH_MILD   : +1  (default Mild bull above VWAP)
//   NEUTRAL        :  0  (warmup OR inside the VWAP band — no signal)
//   BEARISH_MILD   : -1  (default Mild bear below VWAP)
//   DISTRIBUTION   : -1  (depth-leads-Location bearish anomaly)
//   BEARISH_STRONG : -2  (high-vol + thin + below VWAP, confirmed markdown)
//
// `vote(biasState, dir1m)` flips the sign so a +2 against an "up"
// canonical scores +2 (HTF agrees), and a +2 against a "down"
// canonical scores -2 (HTF disagrees). Sums to alignment_score in
// [-4, +4].
//
// Tag rule (anchor-priority):
//   1h opposes (vote_1h < 0) + biasFilterMode === 'hard' -> SUPPRESSED
//   1h opposes (vote_1h < 0)                              -> LOW_CONVICTION
//   1h neutral (vote_1h == 0)                             -> STANDARD
//   1h agrees + 15m agrees                                -> HIGH_CONVICTION
//   1h agrees + 15m opposes (CAUTION zone)                -> LOW_CONVICTION
//   1h agrees + 15m neutral                               -> STANDARD
// `biasFilterMode === 'off'` short-circuits to STANDARD with score=0.
// ───────────────────────────────────────────────────────────────────
const BIAS_VOTE = {
  BULLISH_STRONG:  +2,
  BULLISH_MILD:    +1,
  ACCUMULATION:    +1,
  NEUTRAL:          0,
  DISTRIBUTION:    -1,
  BEARISH_MILD:    -1,
  BEARISH_STRONG:  -2,
};

function vote(biasState, dir1m) {
  if (!biasState || !dir1m) return 0;
  const v = BIAS_VOTE[biasState];
  if (v === undefined) return 0;
  return dir1m === 'up' ? v : -v;
}

// Build the alignment block for a canonical fire. Returns null when
// dir1m is null (canonical didn't fire / no direction yet) or the bar
// has no HTF biases stamped (warmup / non-API mode); callers should
// treat null as "no alignment context".
function buildAlignment(lastBar, dir1m) {
  if (!lastBar || !dir1m) return null;
  const filterMode = state.biasFilterMode || 'soft';
  if (filterMode === 'off') {
    return { score: 0, vote_1h: 0, vote_15m: 0, tag: 'STANDARD',
             biasH1: lastBar.biasH1 ?? null, bias15m: lastBar.bias15m ?? null };
  }
  const biasH1  = lastBar.biasH1  ?? null;
  const bias15m = lastBar.bias15m ?? null;
  const vote_1h  = vote(biasH1,  dir1m);
  const vote_15m = vote(bias15m, dir1m);
  const score = vote_1h + vote_15m;

  let tag;
  if (vote_1h < 0) {
    tag = (filterMode === 'hard') ? 'SUPPRESSED' : 'LOW_CONVICTION';
  } else if (vote_1h === 0) {
    tag = 'STANDARD';
  } else {
    if (vote_15m < 0)      tag = 'LOW_CONVICTION';
    else if (vote_15m > 0) tag = 'HIGH_CONVICTION';
    else                   tag = 'STANDARD';
  }

  return { score, vote_1h, vote_15m, tag, biasH1, bias15m };
}

function evaluateBreakoutCanonical() {
  const checks = { cell: false, sweep: false, flow: false, clean: false };
  let direction = null;

  // Regime-DB plan §2c-d: while regime is in warmup (NULL ranks for the
  // first 30 bars of a session, or any zero-volume bar), all checks are
  // forced false. The unstable rolling stats during warmup are exactly
  // when proxy-driven false positives historically fired (notes.txt
  // screenshot moments), so the suppression is protective, not cosmetic.
  if (state.regimeWarmup) {
    return { checks, passing: 0, total: 4, fired: false, direction: null,
             alignment: null, tag: null };
  }

  // 1. State in watched cell
  checks.cell = (state.sim.volState === BREAKOUT_CELL.volState
              && state.sim.depthState === BREAKOUT_CELL.depthState);

  // 2. Recent sweep event in last 3 settled state.bars
  if (state.bars.length >= 3) {
    const recentBarTimes = new Set(state.bars.slice(-3).map(b => b.time));
    const recentSweeps = state.events.filter(ev =>
      ev.type === 'sweep' && recentBarTimes.has(ev.time)
    );
    if (recentSweeps.length > 0) {
      checks.sweep = true;
      direction = recentSweeps[recentSweeps.length - 1].dir;
    }
  }

  // 3. Cumulative delta over last 5 state.bars aligns with sweep direction
  if (direction && state.bars.length >= 5) {
    const cumD = state.bars.slice(-5).reduce((s, b) => s + b.delta, 0);
    if (direction === 'up'   && cumD > 0) checks.flow = true;
    if (direction === 'down' && cumD < 0) checks.flow = true;
  }

  // 4. No contradictory absorption/divergence in last 8 state.bars
  if (direction && state.bars.length >= 4) {
    const lookbackTimes = new Set(state.bars.slice(-8).map(b => b.time));
    const contradictory = state.events.some(ev => {
      if (!lookbackTimes.has(ev.time)) return false;
      if (ev.type === 'absorption') return true;
      if (ev.type === 'divergence' && ev.dir === direction) return true;
      return false;
    });
    checks.clean = !contradictory;
  } else if (!direction) {
    checks.clean = false;
  }

  const passing = Object.values(checks).filter(Boolean).length;
  const fired = passing === 4;
  // Phase 6: read HTF biases off the last settled bar and compute the
  // alignment block + anchor-priority tag. The block is attached to
  // both fired and not-yet-fired evaluations so the watch panel can
  // display "would-be" conviction even before all four checks pass.
  const lastBar = state.bars[state.bars.length - 1];
  const alignment = buildAlignment(lastBar, direction);
  const tag = alignment ? alignment.tag : null;
  return { checks, passing, total: 4, fired, direction, alignment, tag };
}

function evaluateFadeCanonical() {
  const checks = { balanced: false, cell: false, stretchPOC: false, stretchVWAP: false, noMomentum: false };
  let stretchDir = null;
  let direction = null;

  // Regime-DB plan §2c-d: warmup short-circuit (see breakout for rationale).
  if (state.regimeWarmup) {
    return { checks, passing: 0, total: 5, fired: false, direction: null, stretchDir: null,
             alignment: null, tag: null };
  }

  // Hoisted shared values: profile, sigma, lastVWAP — computed once and reused
  // by balanced / stretchPOC / stretchVWAP. Guarded for early-session (too few
  // state.bars), null profile, degenerate sigma, and empty VWAP series.
  let profile = null;
  let sigma = 0;
  let lastVWAP = null;
  if (state.bars.length >= 3) {
    profile = computeProfile(state.bars);
    if (profile) {
      sigma = (profile.vahPrice - profile.valPrice) / 2;
      const vwapPts = computeAnchoredVWAP(state.bars, getVwapAnchors());
      if (vwapPts.length > 0) lastVWAP = vwapPts[vwapPts.length - 1].vwap;
    }
  }

  // 1. Session balanced: POC and anchored VWAP within 1σ of each other.
  // Degenerate sigma (< 0.001) leaves balanced=false.
  if (profile && lastVWAP !== null && sigma >= 0.001) {
    checks.balanced = Math.abs(profile.pocPrice - lastVWAP) <= 1.0 * sigma;
  }

  // 2. State in fade cell
  checks.cell = (state.sim.volState === FADE_CELL.volState
              && state.sim.depthState === FADE_CELL.depthState);

  // 3. POC stretch: 3+ consecutive state.bars with close > POC + 1σ (or < POC - 1σ)
  if (profile && sigma > 0.001) {
    const poc = profile.pocPrice;
    const last3 = state.bars.slice(-3);
    const allUp   = last3.every(b => b.close > poc + sigma);
    const allDown = last3.every(b => b.close < poc - sigma);
    if (allUp)   { checks.stretchPOC = true; stretchDir = 'up'; }
    if (allDown) { checks.stretchPOC = true; stretchDir = 'down'; }

    // 4. VWAP stretch in same direction as POC stretch
    if (stretchDir && lastVWAP !== null) {
      const lastBar  = state.bars[state.bars.length - 1];
      const threshold = sigma * 0.4;
      if (stretchDir === 'up'   && lastBar.close > lastVWAP + threshold) checks.stretchVWAP = true;
      if (stretchDir === 'down' && lastBar.close < lastVWAP - threshold) checks.stretchVWAP = true;
    }
  }

  // 5. No fresh momentum: no sweeps in last 5 state.bars in the stretch direction
  if (stretchDir && state.bars.length >= 5) {
    const recentBarTimes = new Set(state.bars.slice(-5).map(b => b.time));
    const fresh = state.events.some(ev =>
      ev.type === 'sweep' && ev.dir === stretchDir && recentBarTimes.has(ev.time)
    );
    checks.noMomentum = !fresh;
  }

  // Predicted trade direction is opposite of stretch
  if (stretchDir) direction = stretchDir === 'up' ? 'down' : 'up';

  const passing = Object.values(checks).filter(Boolean).length;
  const fired = passing === 5;
  const lastBar = state.bars[state.bars.length - 1];
  const alignment = buildAlignment(lastBar, direction);
  const tag = alignment ? alignment.tag : null;
  return { checks, passing, total: 5, fired, direction, stretchDir, alignment, tag };
}

export { evaluateBreakoutCanonical, evaluateFadeCanonical, vote, buildAlignment, BIAS_VOTE };
