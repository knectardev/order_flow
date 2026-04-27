import { getTunings, state } from '../state.js';

function detectEvents(newBar, history) {
  if (history.length < 12) return [];
  const t = getTunings();
  const recent = history.slice(-10);
  const recentHigh = Math.max(...recent.map(b => b.high));
  const recentLow  = Math.min(...recent.map(b => b.low));
  const avgVol = recent.reduce((s,b)=>s+b.volume,0)/recent.length;
  const avgRange = recent.reduce((s,b)=>s+(b.high-b.low),0)/recent.length;
  const range = newBar.high - newBar.low;

  const out = [];

  // Sweep: exceeds recent high/low with volume spike
  if (newBar.high > recentHigh && newBar.volume > avgVol * t.sweepVolMult) {
    out.push({ type: 'sweep', dir: 'up', price: newBar.high, time: newBar.time });
  } else if (newBar.low < recentLow && newBar.volume > avgVol * t.sweepVolMult) {
    out.push({ type: 'sweep', dir: 'down', price: newBar.low, time: newBar.time });
  }

  // Absorption: high volume but small range. Threshold tightened from 1.45×→1.75× avg vol
  // because the watched cell ([Impulsive · Light]) naturally produces small-wick state.bars,
  // which were over-firing absorption and self-poisoning criterion 4 ("no contradictory state.events").
  // Real absorption requires more pronounced volume relative to compressed range than this.
  if (newBar.volume > avgVol * t.absorbVolMult && range < avgRange * t.absorbRangeMult) {
    out.push({ type: 'absorption', price: newBar.close, time: newBar.time });
  }

  // Divergence: new extreme but cumulative delta over last 8 state.bars opposite
  const cumD = recent.slice(-8).reduce((s,b)=>s+b.delta, 0) + newBar.delta;
  if (newBar.high > recentHigh && cumD < -avgVol * t.divergenceFlowMult) {
    out.push({ type: 'divergence', dir: 'up', price: newBar.high, time: newBar.time });
  } else if (newBar.low < recentLow && cumD > avgVol * t.divergenceFlowMult) {
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

export { detectEvents, detectStopRun };
