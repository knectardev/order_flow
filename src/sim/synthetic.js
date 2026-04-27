import { getScenario, state } from '../state.js';
import { clamp, rand } from '../util/math.js';

function evolveSimState() {
  // If a forced scenario is active, suppress random walk — keep state pinned to the locked cell.
  const sc = getScenario();
  if (sc.scenarioLockBars > 0 && sc.scenarioLockCell) {
    sc.scenarioLockBars--;
    state.sim.volState   = sc.scenarioLockCell.volState;
    state.sim.depthState = sc.scenarioLockCell.depthState;
    if (sc.scenarioLockBars === 0) sc.scenarioLockCell = null;
    return;
  }
  // Slowed from 0.18/0.14 → 0.08/0.06 per bar. State now persists ~12-17 state.bars
  // per axis on average, which keeps current-cell criterion aligned with recent
  // sweep state.events long enough for the canonical entry window to converge.
  if (Math.random() < 0.08) state.sim.volState   = clamp(state.sim.volState   + (Math.random()<0.5?-1:1), 0, 4);
  if (Math.random() < 0.06) state.sim.depthState = clamp(state.sim.depthState + (Math.random()<0.5?-1:1), 0, 4);
  if (Math.random() < 0.09) state.sim.bias = -state.sim.bias;
}

function generateBar() {
  const volMag   = 0.35 + state.sim.volState * 0.55;        // bar range magnitude
  const drift    = state.sim.bias * volMag * rand(0.05, 0.25);
  const noise    = (Math.random() - 0.5) * volMag * 1.6;
  const open     = state.sim.price;
  let   close    = open + drift + noise;
  const wickMag  = volMag * (0.3 + state.sim.depthState * 0.18);
  let   high     = Math.max(open, close) + Math.random() * wickMag;
  let   low      = Math.min(open, close) - Math.random() * wickMag;

  // Volume scales with vol state, with occasional spikes
  const baseVol  = 800 + state.sim.volState * 400;
  let   spike    = Math.random() < 0.10 ? rand(1.6, 2.6) : 1;

  // Sweep priming (BREAKOUT demo): guarantee bar exceeds prior 10-bar range with high volume.
  const sc = getScenario();
  if (sc.primeNextSweep && state.bars.length >= 10) {
    const recentHigh = Math.max(...state.bars.slice(-10).map(b => b.high));
    const recentLow  = Math.min(...state.bars.slice(-10).map(b => b.low));
    if (state.sim.bias > 0) {
      close = Math.max(close, recentHigh + 0.6);
      high  = Math.max(high, close + 0.2);
    } else {
      close = Math.min(close, recentLow - 0.6);
      low   = Math.min(low, close - 0.2);
    }
    spike = 2.2;
    sc.primeNextSweep = false;
  }

  // Displacement priming (FADE demo): drive several state.bars of strong directional drift
  // without a volume spike. Pushes price away from POC/VWAP without triggering sweep state.events.
  if (sc.primedDisplacement > 0) {
    const driftAmount = sc.primedDirection * 0.55;
    close = open + driftAmount + (Math.random() - 0.5) * 0.25;
    high = Math.max(open, close) + Math.random() * 0.18;
    low  = Math.min(open, close) - Math.random() * 0.18;
    spike = 1; // explicitly suppress spikes during displacement so no sweeps fire
    sc.primedDisplacement--;
  }

  const volume   = Math.round(baseVol * rand(0.7, 1.3) * spike);

  // Synthetic delta: weighted by close position in range, plus noise
  const range    = Math.max(0.0001, high - low);
  const closePos = (close - low) / range;       // 0..1
  const deltaSign = (closePos - 0.5) * 2;       // -1..1
  const delta    = Math.round(volume * deltaSign * rand(0.3, 0.85));

  const time = new Date(Date.now() + state.sim.tick * 60_000);

  state.sim.price = close;
  return { open, high, low, close, volume, delta, time };
}

export { evolveSimState, generateBar };
