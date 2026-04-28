import { BREAKOUT_CELL, ES_MIN_TICK, FADE_CELL, isAbsorptionWallRegime, isValueEdgeRejectRegime, SYNTH_TUNINGS } from '../config/constants.js';
import { getTunings, state } from '../state.js';
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

// Fade-only Wyckoff overrides applied on top of the base anchor-priority
// tag. Captures the qualitative asymmetry that pure +1/-1 vote sums lose:
//
//   Fade-Long under ACCUMULATION  (depth-leads-Location bullish anomaly)
//     → textbook "spring" entry; upgrade STANDARD to HIGH_CONVICTION even
//       when 15m is neutral. The base rule with vote_1h=+1 and
//       vote_15m=0 yields STANDARD; the override re-tags it.
//   Fade-Short under DISTRIBUTION (depth-leads-Location bearish anomaly)
//     → textbook "upthrust" entry; symmetric upgrade.
//   Fade-Long against BEARISH_STRONG → "catching a falling knife".
//     Base rule with vote_1h=-2 yields SUPPRESSED (hard) or LOW_CONVICTION
//     (soft, off). The override does NOT change the tag — it annotates
//     `reason` for downstream tooltips so the user sees why this fade is
//     being de-rated even when it would otherwise look reasonable on
//     core technicals.
//   Fade-Short against BULLISH_STRONG → symmetric falling-knife annotation.
//
// Returns the (possibly mutated) base block. The score, vote_1h, vote_15m
// fields are always preserved so downstream score-tinted UI is unaffected.
function _applyFadeOverrides(base, biasH1, dir1m) {
  if (!base || !dir1m || !biasH1) return base;
  if (dir1m === 'up') {
    if (biasH1 === 'ACCUMULATION') {
      base.tag = 'HIGH_CONVICTION';
      base.reason = 'wyckoff_spring';
    } else if (biasH1 === 'BEARISH_STRONG') {
      base.reason = 'falling_knife';
    }
  } else if (dir1m === 'down') {
    if (biasH1 === 'DISTRIBUTION') {
      base.tag = 'HIGH_CONVICTION';
      base.reason = 'wyckoff_upthrust';
    } else if (biasH1 === 'BULLISH_STRONG') {
      base.reason = 'falling_knife';
    }
  }
  return base;
}

// Build the alignment block for a canonical fire. Returns null when
// dir1m is null (canonical didn't fire / no direction yet) or the bar
// has no HTF biases stamped (warmup / non-API mode); callers should
// treat null as "no alignment context".
//
// `watchKind` ∈ { 'breakout', 'fade', 'absorption' } — fade applies Wyckoff
// tag overrides (same for Value Edge Rejection mean-reversion). Breakout and
// absorption use the same base tag rule; absorption
// passes the bar's *impulse* (close vs open) as dir1m for votes, not mean-reversion.
// Defaults to 'breakout' so the existing single-arg call sites work unchanged.
function buildAlignment(lastBar, dir1m, watchKind = 'breakout') {
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

  const base = { score, vote_1h, vote_15m, tag, biasH1, bias15m };
  if (watchKind === 'fade') return _applyFadeOverrides(base, biasH1, dir1m);
  // 'breakout' and 'absorption' share the base block (no extra tag overlay).
  return base;
}

function evaluateBreakoutCanonical() {
  // Phase 6 follow-up: `alignment` is now a true gating check. It evaluates
  // to `true` when the 1h bias does not oppose `direction` (vote_1h >= 0),
  // when alignment cannot be computed (synthetic / no direction yet), or
  // when biasFilterMode is 'off' (which forces vote_1h = 0). It evaluates
  // to `false` when the 1h bias actively opposes the trade direction —
  // that is, even soft-mode "LOW_CONVICTION" fires now fail the gate, so
  // an opposing 1h trend can no longer fire a breakout. The tag itself
  // (HIGH/STANDARD/LOW/SUPPRESSED) is still surfaced for diagnostics.
  const checks = { cell: false, sweep: false, flow: false, clean: false, alignment: false };
  let direction = null;

  // Regime-DB plan §2c-d: while regime is in warmup (NULL ranks for the
  // first 30 bars of a session, or any zero-volume bar), all checks are
  // forced false. The unstable rolling stats during warmup are exactly
  // when proxy-driven false positives historically fired (notes.txt
  // screenshot moments), so the suppression is protective, not cosmetic.
  if (state.regimeWarmup) {
    return { checks, passing: 0, total: 5, fired: false, direction: null,
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

  // Phase 6: read HTF biases off the last settled bar and compute the
  // alignment block + anchor-priority tag. The block is attached to
  // both fired and not-yet-fired evaluations so the watch panel can
  // display "would-be" conviction even before all five checks pass.
  // Order-of-ops: alignment must be computed *before* `checks.alignment`
  // is finalized so the gating check reads from the same vote.
  const lastBar = state.bars[state.bars.length - 1];
  const alignment = buildAlignment(lastBar, direction);
  const tag = alignment ? alignment.tag : null;
  // Gate: 1h must not oppose direction. Null alignment (no direction
  // yet, or no lastBar) leaves the check false — which is fine because
  // those states can't fire on the other criteria either.
  checks.alignment = !!alignment && alignment.vote_1h >= 0;

  const passing = Object.values(checks).filter(Boolean).length;
  const fired = passing === 5;
  return { checks, passing, total: 5, fired, direction, alignment, tag };
}

function evaluateFadeCanonical() {
  // Phase 6 follow-up: `alignment` is now a true gating check (see
  // evaluateBreakoutCanonical for the gating semantics). For fades the
  // tag rule is additionally Wyckoff-aware via buildAlignment's
  // 'fade' watchKind — Fade-Long under ACCUMULATION upgrades to
  // HIGH_CONVICTION even with a neutral 15m, and Fade-Long against
  // BEARISH_STRONG annotates the LOW/SUPPRESSED with `falling_knife`.
  const checks = { balanced: false, cell: false, stretchPOC: false, stretchVWAP: false, noMomentum: false, alignment: false };
  let stretchDir = null;
  let direction = null;

  // Regime-DB plan §2c-d: warmup short-circuit (see breakout for rationale).
  if (state.regimeWarmup) {
    return { checks, passing: 0, total: 6, fired: false, direction: null, stretchDir: null,
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

  const lastBar = state.bars[state.bars.length - 1];
  const alignment = buildAlignment(lastBar, direction, 'fade');
  const tag = alignment ? alignment.tag : null;
  checks.alignment = !!alignment && alignment.vote_1h >= 0;

  const passing = Object.values(checks).filter(Boolean).length;
  const fired = passing === 6;
  return { checks, passing, total: 6, fired, direction, stretchDir, alignment, tag };
}

/**
 * Absorption Wall: [Climactic · Stacked] with stalled price, volume spike, and
 * proximity to VAH/VAL/VWAP. Uses the last *settled* bar in `state.bars` (forming
 * bars are not in this array). Returned `direction` is mean reversion: bull bar →
 * 'down', bear bar → 'up' (for halos, event log, and fire record). HTF alignment
 * uses the bar impulse (close vs open) passed to buildAlignment as 'absorption',
 * not MR direction, so 1h votes test agreement with the push into the level.
 */
function evaluateAbsorptionWallCanonical() {
  const checks = { cell: false, stall: false, volume: false, level: false, alignment: false };
  let direction = null;

  if (state.regimeWarmup) {
    return { checks, passing: 0, total: 5, fired: false, direction: null, alignment: null, tag: null };
  }

  const t = getTunings();
  const volM = t.absorptionWallVolMult ?? SYNTH_TUNINGS.absorptionWallVolMult ?? 1.15;
  const stallTicks = t.absorptionWallStallTicks ?? SYNTH_TUNINGS.absorptionWallStallTicks ?? 4.5;
  const bodyTicks = t.absorptionWallStallBodyTicks ?? SYNTH_TUNINGS.absorptionWallStallBodyTicks ?? 3.5;
  const levelTicks = t.absorptionWallLevelTicks ?? SYNTH_TUNINGS.absorptionWallLevelTicks ?? 15;
  const rangeMult = t.absorptionWallStallMinRangeMult ?? SYNTH_TUNINGS.absorptionWallStallMinRangeMult ?? 0.25;
  const stallEps = stallTicks * ES_MIN_TICK;
  const bodyEps = bodyTicks * ES_MIN_TICK;
  const levelEps = levelTicks * ES_MIN_TICK;

  // Deep or Stacked book + Active+ vol (see isAbsorptionWallRegime in constants).
  checks.cell = isAbsorptionWallRegime(state.sim.volState, state.sim.depthState);

  const n = state.bars.length;
  const lastBar = n ? state.bars[n - 1] : null;
  const prevBar = n >= 2 ? state.bars[n - 2] : null;
  // Strict 10-bar window for range/stall when history is long enough.
  const prior10 = n >= 11 ? state.bars.slice(-11, -1) : null;

  if (lastBar && prevBar) {
    // Stall = contested range, no net progress from the prior print OR a small
    // open→close (indecision) — either OR with the same range gate when prior10 exists.
    const closeStall = Math.abs(lastBar.close - prevBar.close) < stallEps;
    const bodyStall = Math.abs(lastBar.close - lastBar.open) < bodyEps;
    if (prior10) {
      const avgRange = prior10.reduce((s, b) => s + (b.high - b.low), 0) / prior10.length;
      const br = lastBar.high - lastBar.low;
      if (avgRange > 0) {
        const rangeStall = br > avgRange * rangeMult;
        checks.stall = rangeStall && (closeStall || bodyStall);
      } else {
        checks.stall = false;
      }
    } else {
      checks.stall = closeStall || bodyStall;
    }
  }

  // Volume: same × prior-avg rule as precompute; use 1..10 prior bars when <11
  // settled (session open / short seek) so the gate is not stuck false.
  if (lastBar && n >= 2) {
    const start = Math.max(0, n - 1 - 10);
    const volPrior = state.bars.slice(start, -1);
    if (volPrior.length > 0) {
      const avgVol = volPrior.reduce((s, b) => s + b.volume, 0) / volPrior.length;
      if (avgVol > 0) checks.volume = lastBar.volume > avgVol * volM;
    }
  }

  if (lastBar) {
    direction = lastBar.close >= lastBar.open ? 'down' : 'up';
  }

  const impulseDir = lastBar
    ? (lastBar.close >= lastBar.open ? 'up' : 'down')
    : null;

  if (n >= 3 && lastBar) {
    const profile = computeProfile(state.bars);
    if (profile && profile.vahPrice != null && profile.valPrice != null) {
      const vwapPts = computeAnchoredVWAP(state.bars, getVwapAnchors());
      const lastVWAP = vwapPts.length > 0 ? vwapPts[vwapPts.length - 1].vwap : null;
      const c = lastBar.close;
      const dVah = Math.abs(c - profile.vahPrice);
      const dVal = Math.abs(c - profile.valPrice);
      const dPoc = profile.pocPrice != null ? Math.abs(c - profile.pocPrice) : Infinity;
      const dVw = lastVWAP != null ? Math.abs(c - lastVWAP) : Infinity;
      const d = Math.min(dVah, dVal, dPoc, dVw);
      checks.level = d <= levelEps;
    }
  }

  const alignment = lastBar && impulseDir
    ? buildAlignment(lastBar, impulseDir, 'absorption')
    : null;
  const tag = alignment ? alignment.tag : null;
  // Slightly looser than breakout: allow mild 1h disagreement (e.g. −1), veto strong (≤ −2).
  checks.alignment = !!alignment && alignment.vote_1h >= -1;

  const passing = Object.values(checks).filter(Boolean).length;
  const fired = passing === 5;
  return { checks, passing, total: 5, fired, direction, alignment, tag };
}

const VA_EDGE_EPS = ES_MIN_TICK * 0.5;

/**
 * Value Edge Rejection: failed breakout at VAH/VAL (high/low probe the edge, close
 * back strictly inside the value area), normal-volume bar, mean-reversion direction
 * toward POC. Uses last settled bar. HTF alignment uses the same "fade" path
 * (Wyckoff) as other MR canonicals.
 */
function evaluateValueEdgeReject() {
  const checks = { regime: false, failedAtEdge: false, rejectionWick: false, volume: false, alignment: false };
  let direction = null;
  let edge = null; // 'vah' | 'val'

  if (state.regimeWarmup) {
    return { checks, passing: 0, total: 5, fired: false, direction: null, edge: null, anchorPrice: null,
             alignment: null, tag: null };
  }

  const t = getTunings();
  const vMinM = t.valueRejectVolMinMult ?? SYNTH_TUNINGS.valueRejectVolMinMult ?? 0.8;
  const vMaxM = t.valueRejectVolMaxMult ?? SYNTH_TUNINGS.valueRejectVolMaxMult ?? 1.2;

  checks.regime = isValueEdgeRejectRegime(state.sim.volState, state.sim.depthState);

  const n = state.bars.length;
  const lastBar = n ? state.bars[n - 1] : null;

  let profile = null;
  if (n >= 3) profile = computeProfile(state.bars);

  if (lastBar && profile && profile.vahPrice != null && profile.valPrice != null) {
    const vah = profile.vahPrice;
    const val = profile.valPrice;
    if (val < vah) {
      // Failed VAH: probed at or through VAH; close strictly inside [VAL, VAH] body (not on edges).
      const vahTouched = lastBar.high + VA_EDGE_EPS >= vah;
      const valTouched = lastBar.low - VA_EDGE_EPS <= val;
      const closeInside = lastBar.close > val && lastBar.close < vah;
      const candVah = vahTouched && closeInside;
      const candVal = valTouched && closeInside;
      if (candVah && candVal) {
        const upperW = lastBar.high - Math.max(lastBar.open, lastBar.close);
        const lowerW = Math.min(lastBar.open, lastBar.close) - lastBar.low;
        if (upperW >= lowerW) { edge = 'vah'; } else { edge = 'val'; }
      } else if (candVah) {
        edge = 'vah';
      } else if (candVal) {
        edge = 'val';
      }
      if (edge) {
        checks.failedAtEdge = true;
        if (edge === 'vah') {
          direction = 'down';
        } else {
          direction = 'up';
        }
        const b = lastBar;
        if (edge === 'vah') {
          // Notes: top wick vs body — (H−C) > (C−O) captures rejection at the high.
          checks.rejectionWick = (b.high - b.close) > (b.close - b.open);
        } else {
          // Notes: (C−L) > (O−C) for rejection at the low.
          checks.rejectionWick = (b.close - b.low) > (b.open - b.close);
        }
      }
    }
  }

  if (lastBar && n >= 2) {
    const start = Math.max(0, n - 1 - 10);
    const volPrior = state.bars.slice(start, -1);
    if (volPrior.length > 0) {
      const avgVol = volPrior.reduce((s, b) => s + b.volume, 0) / volPrior.length;
      if (avgVol > 0) {
        const ratio = lastBar.volume / avgVol;
        checks.volume = ratio >= vMinM && ratio <= vMaxM;
      }
    }
  }

  const alignment = lastBar && direction
    ? buildAlignment(lastBar, direction, 'fade')
    : null;
  const tag = alignment ? alignment.tag : null;
  checks.alignment = !!alignment && alignment.vote_1h >= 0;

  const passing = Object.values(checks).filter(Boolean).length;
  const fired = passing === 5;
  const anchorPrice = edge === 'vah' && profile
    ? profile.vahPrice
    : edge === 'val' && profile
      ? profile.valPrice
      : null;

  return { checks, passing, total: 5, fired, direction, edge, anchorPrice, alignment, tag };
}

export { evaluateAbsorptionWallCanonical, evaluateBreakoutCanonical, evaluateFadeCanonical, evaluateValueEdgeReject, vote, buildAlignment, BIAS_VOTE };
