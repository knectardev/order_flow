import { BREAKOUT_CELL, FADE_CELL } from '../config/constants.js';
import { state } from '../state.js';
import { computeProfile } from './profile.js';
import { computeAnchoredVWAP, getVwapAnchors } from './vwap.js';

function evaluateBreakoutCanonical() {
  const checks = { cell: false, sweep: false, flow: false, clean: false };
  let direction = null;

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
  return { checks, passing, total: 4, fired: passing === 4, direction };
}

function evaluateFadeCanonical() {
  const checks = { balanced: false, cell: false, stretchPOC: false, stretchVWAP: false, noMomentum: false };
  let stretchDir = null;
  let direction = null;

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
  return { checks, passing, total: 5, fired: passing === 5, direction, stretchDir };
}

export { evaluateBreakoutCanonical, evaluateFadeCanonical };
