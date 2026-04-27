import { BREAKOUT_CELL, FADE_CELL } from '../config/constants.js';
import { getTickMs, state } from '../state.js';
import { evaluateBreakoutCanonical, evaluateFadeCanonical } from '../analytics/canonical.js';
import { computeMatrixScores } from '../analytics/regime.js';
import { jumpToNextFire, seek } from '../data/replay.js';
import { renderEventLog } from '../render/eventLog.js';
import { drawFlowChart } from '../render/flowChart.js';
import { renderMatrix } from '../render/matrix.js';
import { drawPriceChart } from '../render/priceChart.js';
import { renderBreakoutWatch, renderFadeWatch } from '../render/watch.js';
import { step } from '../sim/step.js';

function toggleStream() {
  const btn = document.getElementById('streamBtn');
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
    btn.textContent = 'Resume Stream';
  } else {
    document.getElementById('fireBanner').classList.remove('visible');
    // If the user has panned the chart away from the live cursor and then
    // hits Resume Stream, treat the panned position as their new "now":
    // align state.replay.cursor with state.chartViewEnd so the next streamed bar
    // appears immediately on-screen rather than committing off-screen at
    // the prior live edge. seek() also clears state.chartViewEnd, re-coupling
    // the viewport to the cursor so subsequent state.bars slide in naturally.
    if (state.replay.mode === 'real'
        && state.chartViewEnd !== null
        && state.chartViewEnd !== state.replay.cursor) {
      seek(state.chartViewEnd);
    }
    state.interval = setInterval(step, getTickMs());
    btn.textContent = 'Pause Stream';
    step();
  }
}

function onSpeedChange() {
  const slider = document.getElementById('speedSlider');
  state.speedMultiplier = parseFloat(slider.value);
  document.getElementById('speedValue').textContent = state.speedMultiplier.toFixed(1) + '×';
  // If running, restart the state.interval with the new speed
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = setInterval(step, getTickMs());
  }
}

function resetStream() {
  if (state.interval) { clearInterval(state.interval); state.interval = null; }
  document.getElementById('streamBtn').textContent = 'Start Stream';
  document.getElementById('fireBanner').classList.remove('visible');

  if (state.replay.mode === 'real') {
    // Real-data Reset = rewind the loaded session to bar 0; do NOT discard
    // the session metadata or drop back to synthetic mode (use page reload
    // for that). Pre-scanned fires are preserved.
    seek(0);
    return;
  }

  state.bars = [];
  state.formingBar = null;
  state.events = [];
  state.trail = [];
  state.canonicalFires = [];
  // Reset both watches
  state.breakoutWatch.lastCanonical = null;
  state.breakoutWatch.firedThisCycle = false;
  state.breakoutWatch.flipTicks = { cell: null, sweep: null, flow: null, clean: null };
  state.fadeWatch.lastCanonical = null;
  state.fadeWatch.firedThisCycle = false;
  state.fadeWatch.flipTicks = { balanced: null, cell: null, stretchPOC: null, stretchVWAP: null, noMomentum: null };
  // Reset scenario state
  state.scenarioLockBars = 0;
  state.scenarioLockCell = null;
  state.primeNextSweep = false;
  state.primedDisplacement = 0;
  state.primedDirection = 0;
  state.lastFiredWatch = null;
  state.sim = {
    price: 4500, volState: 2, depthState: 2,
    drift: 0, bias: 1, tick: 0, formingProgress: 0,
  };
  state.matrixScores = computeMatrixScores();
  const emptyBreakout = evaluateBreakoutCanonical();
  const emptyFade     = evaluateFadeCanonical();
  renderMatrix(emptyBreakout, emptyFade);
  renderBreakoutWatch(emptyBreakout);
  renderFadeWatch(emptyFade);
  renderEventLog();
  drawPriceChart();
  drawFlowChart();
  document.getElementById('barCount').textContent = '0 bars';
  document.getElementById('cumDelta').textContent = 'cum Δ —';
}

function forceBreakoutScenario() {
  if (state.replay.mode === 'real') { jumpToNextFire('breakout'); return; }
  document.getElementById('fireBanner').classList.remove('visible');
  state.scenarioLockBars = 12;
  state.scenarioLockCell = BREAKOUT_CELL;
  state.primeNextSweep   = true;
  state.primedDisplacement = 0; // make sure we're not also doing a fade scenario
  state.sim.volState   = BREAKOUT_CELL.volState;
  state.sim.depthState = BREAKOUT_CELL.depthState;
  state.sim.bias = Math.random() < 0.5 ? 1 : -1;
  state.breakoutWatch.firedThisCycle = false;
  if (!state.interval) toggleStream();
}

function forceFadeScenario() {
  if (state.replay.mode === 'real') { jumpToNextFire('fade'); return; }
  document.getElementById('fireBanner').classList.remove('visible');
  state.scenarioLockBars = 14;
  state.scenarioLockCell = FADE_CELL;
  state.primeNextSweep = false;
  state.primedDirection    = Math.random() < 0.5 ? 1 : -1;
  state.primedDisplacement = 4;  // 4 state.bars of strong drift to clear 1σ from POC
  state.sim.volState   = FADE_CELL.volState;
  state.sim.depthState = FADE_CELL.depthState;
  state.sim.bias = state.primedDirection;
  state.fadeWatch.firedThisCycle = false;
  if (!state.interval) toggleStream();
}

export { toggleStream, onSpeedChange, resetStream, forceBreakoutScenario, forceFadeScenario };
