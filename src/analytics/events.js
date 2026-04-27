import { SYNTH_TUNINGS } from '../config/constants.js';
import { getTunings, state } from '../state.js';

/** Stable key for "similar" primitive events (cooldown groups sweeps by direction, etc.). */
function eventSignature(ev) {
  return `${ev.type}|${ev.dir ?? ''}`;
}

function _barIndexForTime(bars, time) {
  return bars.findIndex(b => b.time === time);
}

/**
 * Drop primitive events that repeat the same signature within `cooldownBars` of the
 * most recent kept event still present in `bars`. When `sessionStartIdx` is set
 * (per-session replay scan), prior events from an earlier session are ignored so
 * cooldown does not span the day boundary.
 */
function filterNewEventsCooldown(newEvs, existingEvents, bars, cooldownBars, sessionStartIdx = null) {
  if (!newEvs.length || cooldownBars <= 0) return newEvs.slice();
  const pool = existingEvents.slice();
  const out = [];
  for (const ev of newEvs) {
    const idx = _barIndexForTime(bars, ev.time);
    if (idx < 0) {
      out.push(ev);
      pool.push(ev);
      continue;
    }
    const sig = eventSignature(ev);
    let tooSoon = false;
    for (let i = pool.length - 1; i >= 0; i--) {
      const prev = pool[i];
      if (eventSignature(prev) !== sig) continue;
      const pidx = _barIndexForTime(bars, prev.time);
      if (pidx < 0) break;
      if (sessionStartIdx != null && pidx < sessionStartIdx) break;
      if (idx >= pidx && idx - pidx < cooldownBars) tooSoon = true;
      break;
    }
    if (tooSoon) continue;
    out.push(ev);
    pool.push(ev);
  }
  return out;
}

/**
 * True when a new canonical fire should be skipped as a near-duplicate of the last
 * same-watch, same-direction fire still visible in `bars`.
 */
function isCanonicalFireRepeatTooSoon(watchId, direction, barTime, existingFires, bars, cooldownBars, sessionStartIdx = null) {
  if (cooldownBars <= 0 || direction == null) return false;
  const idx = _barIndexForTime(bars, barTime);
  if (idx < 0) return false;
  for (let i = existingFires.length - 1; i >= 0; i--) {
    const f = existingFires[i];
    if (f.watchId !== watchId || f.direction !== direction) continue;
    const pidx = _barIndexForTime(bars, f.barTime);
    if (pidx < 0) break;
    if (sessionStartIdx != null && pidx < sessionStartIdx) break;
    if (idx > pidx && idx - pidx < cooldownBars) return true;
    break;
  }
  return false;
}

/** Effective cooldown bar counts from session/synth tunings (JSON may omit new keys). */
function getSignalCooldownBars() {
  const t = getTunings();
  const evCd = t.eventCooldownBars ?? SYNTH_TUNINGS.eventCooldownBars ?? 4;
  const fireCd = t.fireCooldownBars ?? t.eventCooldownBars ?? SYNTH_TUNINGS.fireCooldownBars ?? evCd;
  return { eventCooldownBars: evCd, fireCooldownBars: fireCd };
}

// Phase 6 follow-up: bias-adaptive detection multipliers.
//
// `_biasScale(biasH1, dir)` returns a multiplier applied to volume-style
// thresholds (sweepVolMult, divergenceFlowMult). Intuition: in a strong
// 1h trend, a sweep / divergence in the trend direction needs less
// confirmation (markup naturally produces these prints), while a sweep
// / divergence against the trend needs more (against-trend prints are
// rarer and more meaningful, so the bar to detect them is raised).
//
// Asymmetric scaling is centred on 1.0 so a null bias (synthetic mode,
// warmup, or any bar without a stamped 1h parent) leaves thresholds
// untouched — preserving synthetic-mode parity bit-for-bit.
//
// ACCUMULATION / DISTRIBUTION are deliberately neutral here: they're
// "anomaly" labels (depth-leads-location), not directional trends, and
// the fade Wyckoff overrides in canonical.js already pick them up at
// the tag layer. NEUTRAL is also 1.0 by definition.
function _biasScale(biasH1, dir) {
  if (!biasH1 || !dir) return 1.0;
  switch (biasH1) {
    case 'BULLISH_STRONG': return dir === 'up'   ? 0.8 : 1.2;
    case 'BEARISH_STRONG': return dir === 'down' ? 0.8 : 1.2;
    case 'BULLISH_MILD':   return dir === 'up'   ? 0.9 : 1.1;
    case 'BEARISH_MILD':   return dir === 'down' ? 0.9 : 1.1;
    default:               return 1.0;
  }
}

function detectEvents(newBar, history, opts = {}) {
  if (history.length < 12) return [];
  const t = getTunings();
  const biasH1 = opts.biasH1 ?? null;
  const recent = history.slice(-10);
  const recentHigh = Math.max(...recent.map(b => b.high));
  const recentLow  = Math.min(...recent.map(b => b.low));
  const avgVol = recent.reduce((s,b)=>s+b.volume,0)/recent.length;
  const avgRange = recent.reduce((s,b)=>s+(b.high-b.low),0)/recent.length;
  const range = newBar.high - newBar.low;

  const out = [];

  // Sweep: exceeds recent high/low with volume spike. Threshold scaled
  // by the bar's 1h bias — easier to confirm an up-sweep in a bullish
  // markup, harder against the trend (and symmetric for down-sweeps).
  const sweepUpMult   = t.sweepVolMult * _biasScale(biasH1, 'up');
  const sweepDownMult = t.sweepVolMult * _biasScale(biasH1, 'down');
  if (newBar.high > recentHigh && newBar.volume > avgVol * sweepUpMult) {
    out.push({ type: 'sweep', dir: 'up', price: newBar.high, time: newBar.time });
  } else if (newBar.low < recentLow && newBar.volume > avgVol * sweepDownMult) {
    out.push({ type: 'sweep', dir: 'down', price: newBar.low, time: newBar.time });
  }

  // Absorption: high volume but small range. Threshold tightened from 1.45×→1.75× avg vol
  // because the watched cell ([Impulsive · Light]) naturally produces small-wick state.bars,
  // which were over-firing absorption and self-poisoning criterion 4 ("no contradictory state.events").
  // Real absorption requires more pronounced volume relative to compressed range than this.
  if (newBar.volume > avgVol * t.absorbVolMult && range < avgRange * t.absorbRangeMult) {
    out.push({ type: 'absorption', price: newBar.close, time: newBar.time });
  }

  // Divergence: new extreme but cumulative delta over last 8 state.bars opposite.
  // A divergence event is conventionally typed by the *price* extreme direction:
  //   dir:'up'   → price made a new high but cumulative delta is negative
  //                (bearish-divergence at a high — "weak rally")
  //   dir:'down' → price made a new low but cumulative delta is positive
  //                (bullish-divergence at a low — "absorbed selloff")
  // The tactical signal therefore points *against* dir:
  //   "up" divergence is meaningful when 1h is bearish (confirms markdown
  //   continuation by exposing a failed rally); scale the up-extreme branch
  //   by _biasScale(biasH1, 'down').
  //   "down" divergence is meaningful when 1h is bullish (failed selloff →
  //   markup continuation); scale the down-extreme branch by _biasScale(biasH1, 'up').
  const cumD = recent.slice(-8).reduce((s,b)=>s+b.delta, 0) + newBar.delta;
  const divUpMult   = t.divergenceFlowMult * _biasScale(biasH1, 'down');
  const divDownMult = t.divergenceFlowMult * _biasScale(biasH1, 'up');
  if (newBar.high > recentHigh && cumD < -avgVol * divUpMult) {
    out.push({ type: 'divergence', dir: 'up', price: newBar.high, time: newBar.time });
  } else if (newBar.low < recentLow && cumD > avgVol * divDownMult) {
    out.push({ type: 'divergence', dir: 'down', price: newBar.low, time: newBar.time });
  }

  return out;
}

function detectStopRun() {
  // Look at state.events: a SWEEP whose next bar fully reverses past the swept level → stop run
  if (state.events.length === 0 || state.bars.length < 2) return;
  const last = state.events[state.events.length - 1];
  if (last.type !== 'sweep' || last._reviewed) return;
  const sweepBarIdx = state.bars.findIndex(b => b.time === last.time);
  if (sweepBarIdx < 0 || sweepBarIdx >= state.bars.length - 1) return;
  const next = state.bars[sweepBarIdx + 1];
  const sweepBar = state.bars[sweepBarIdx];
  last._reviewed = true;
  if (last.dir === 'up' && next.close < sweepBar.open) {
    state.events.push({ type: 'stoprun', dir: 'up', price: last.price, time: next.time });
  } else if (last.dir === 'down' && next.close > sweepBar.open) {
    state.events.push({ type: 'stoprun', dir: 'down', price: last.price, time: next.time });
  }
}

export {
  detectEvents,
  detectStopRun,
  _biasScale,
  filterNewEventsCooldown,
  isCanonicalFireRepeatTooSoon,
  getSignalCooldownBars,
};
