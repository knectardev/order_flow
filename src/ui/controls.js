import { ABSORPTION_WALL_CELL, BREAKOUT_CELL, FADE_CELL, VALUE_EDGE_REJECT_LOCK_CELL } from '../config/constants.js';
import { getScenario, getTickMs, state } from '../state.js';
import { evaluateAbsorptionWallCanonical, evaluateBreakoutCanonical, evaluateFadeCanonical, evaluateValueEdgeReject } from '../analytics/canonical.js';
import { computeMatrixScores } from '../analytics/regime.js';
import { jumpToNextFire, seek } from '../data/replay.js';
import { renderEventLog } from '../render/eventLog.js';
import { drawFlowChart } from '../render/flowChart.js';
import { drawCvdChart } from '../render/cvdChart.js';
import { renderMatrix } from '../render/matrix.js';
import { drawPriceChart } from '../render/priceChart.js';
import { renderAbsorptionWallWatch, renderBreakoutWatch, renderFadeWatch, renderValueEdgeRejectWatch } from '../render/watch.js';
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
    // the prior live edge. seek() clears state.chartViewEnd (live coupling)
    // but preserves chartFutureBlankSlots so the simulated future strip stays put.
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

function bindPlaybackHotkeys() {
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    if (e.repeat) return;

    const target = e.target;
    const isEditable = target instanceof HTMLElement && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    );
    if (isEditable) return;

    // Prevent page scrolling and toggle stream pause/resume.
    e.preventDefault();
    toggleStream();
  });
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
  state.breakoutWatch.flipTicks = { cell: null, sweep: null, flow: null, clean: null, alignment: null };
  state.fadeWatch.lastCanonical = null;
  state.fadeWatch.firedThisCycle = false;
  state.fadeWatch.flipTicks = { balanced: null, cell: null, stretchPOC: null, stretchVWAP: null, noMomentum: null, alignment: null };
  state.absorptionWallWatch.lastCanonical = null;
  state.absorptionWallWatch.firedThisCycle = false;
  state.absorptionWallWatch.flipTicks = { cell: null, stall: null, volume: null, level: null, alignment: null };
  state.valueEdgeRejectWatch.lastCanonical = null;
  state.valueEdgeRejectWatch.firedThisCycle = false;
  state.valueEdgeRejectWatch.flipTicks = { regime: null, failedAtEdge: null, rejectionWick: null, volume: null, alignment: null };
  // Reset scenario state for the active timeframe's bucket. Synthetic
  // mode is always 1m so this is functionally a 1m reset; the per-tf
  // structure lets future multi-timeframe synthetic / mixed scenarios
  // keep their state independent.
  const sc = getScenario();
  sc.scenarioLockBars = 0;
  sc.scenarioLockCell = null;
  sc.primeNextSweep = false;
  sc.primedDisplacement = 0;
  sc.primedDirection = 0;
  state.lastFiredWatch = null;
  state.sim = {
    price: 4500, volState: 2, depthState: 2,
    drift: 0, bias: 1, tick: 0, formingProgress: 0,
  };
  state.matrixScores = computeMatrixScores();
  const emptyBreakout = evaluateBreakoutCanonical();
  const emptyFade     = evaluateFadeCanonical();
  const emptyAbsorptionWall = evaluateAbsorptionWallCanonical();
  const emptyValueEdge = evaluateValueEdgeReject();
  renderMatrix(emptyBreakout, emptyFade, emptyAbsorptionWall, emptyValueEdge);
  renderBreakoutWatch(emptyBreakout);
  renderFadeWatch(emptyFade);
  renderAbsorptionWallWatch(emptyAbsorptionWall);
  renderValueEdgeRejectWatch(emptyValueEdge);
  renderEventLog();
  drawPriceChart();
  drawFlowChart();
  drawCvdChart();
  const el = document.getElementById('deltaWindowSum');
  if (el) el.textContent = 'ΣΔ —';
}

function forceBreakoutScenario() {
  if (state.replay.mode === 'real') { jumpToNextFire('breakout'); return; }
  document.getElementById('fireBanner').classList.remove('visible');
  const sc = getScenario();
  sc.scenarioLockBars = 12;
  sc.scenarioLockCell = BREAKOUT_CELL;
  sc.primeNextSweep   = true;
  sc.primedDisplacement = 0; // make sure we're not also doing a fade scenario
  state.sim.volState   = BREAKOUT_CELL.volState;
  state.sim.depthState = BREAKOUT_CELL.depthState;
  state.sim.bias = Math.random() < 0.5 ? 1 : -1;
  state.breakoutWatch.firedThisCycle = false;
  if (!state.interval) toggleStream();
}

function forceFadeScenario() {
  if (state.replay.mode === 'real') { jumpToNextFire('fade'); return; }
  document.getElementById('fireBanner').classList.remove('visible');
  const sc = getScenario();
  sc.scenarioLockBars = 14;
  sc.scenarioLockCell = FADE_CELL;
  sc.primeNextSweep = false;
  sc.primedDirection    = Math.random() < 0.5 ? 1 : -1;
  sc.primedDisplacement = 4;  // 4 state.bars of strong drift to clear 1σ from POC
  state.sim.volState   = FADE_CELL.volState;
  state.sim.depthState = FADE_CELL.depthState;
  state.sim.bias = sc.primedDirection;
  state.fadeWatch.firedThisCycle = false;
  if (!state.interval) toggleStream();
}

function forceAbsorptionWallScenario() {
  if (state.replay.mode === 'real') { jumpToNextFire('absorptionWall'); return; }
  document.getElementById('fireBanner').classList.remove('visible');
  const sc = getScenario();
  sc.scenarioLockBars = 12;
  sc.scenarioLockCell = ABSORPTION_WALL_CELL;
  sc.primeNextSweep = false;
  sc.primedDisplacement = 0;
  state.sim.volState   = ABSORPTION_WALL_CELL.volState;
  state.sim.depthState = ABSORPTION_WALL_CELL.depthState;
  state.absorptionWallWatch.firedThisCycle = false;
  if (!state.interval) toggleStream();
}

function forceValueEdgeRejectScenario() {
  if (state.replay.mode === 'real') { jumpToNextFire('valueEdgeReject'); return; }
  document.getElementById('fireBanner').classList.remove('visible');
  const sc = getScenario();
  sc.scenarioLockBars = 12;
  sc.scenarioLockCell = VALUE_EDGE_REJECT_LOCK_CELL;
  sc.primeNextSweep = false;
  sc.primedDisplacement = 0;
  state.sim.volState   = VALUE_EDGE_REJECT_LOCK_CELL.volState;
  state.sim.depthState = VALUE_EDGE_REJECT_LOCK_CELL.depthState;
  state.valueEdgeRejectWatch.firedThisCycle = false;
  if (!state.interval) toggleStream();
}

export { toggleStream, onSpeedChange, bindPlaybackHotkeys, resetStream, forceBreakoutScenario, forceFadeScenario, forceAbsorptionWallScenario, forceValueEdgeRejectScenario };
