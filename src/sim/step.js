import { ABSORPTION_WALL_CELL, BREAKOUT_CELL, FADE_CELL, FORMING_STEPS, MAX_BARS, TRAIL_LEN, VALUE_EDGE_REJECT_LOCK_CELL } from '../config/constants.js';
import { state } from '../state.js';
import { evaluateAbsorptionWallCanonical, evaluateBreakoutCanonical, evaluateFadeCanonical, evaluateValueEdgeReject } from '../analytics/canonical.js';
import { detectEvents, detectStopRun, filterNewEventsCooldown, getSignalCooldownBars, isCanonicalFireRepeatTooSoon } from '../analytics/events.js';
import { computeMatrixScores } from '../analytics/regime.js';
import { _commitRealBar, _renderReplayChrome, _syncCurrentSession } from '../data/replay.js';
import { renderEventLog } from '../render/eventLog.js';
import { drawFlowChart } from '../render/flowChart.js';
import { renderMatrix } from '../render/matrix.js';
import { drawPriceChart } from '../render/priceChart.js';
import { renderAbsorptionWallWatch, renderBreakoutWatch, renderFadeWatch, renderValueEdgeRejectWatch } from '../render/watch.js';
import { evolveSimState, generateBar } from './synthetic.js';
import { pauseForFire } from '../ui/fireBanner.js';
import { _refreshMatrixForView } from '../ui/pan.js';
import { rand } from '../util/math.js';

function step() {
  state.sim.tick++;

  if (state.replay.mode === 'real') {
    _stepReal();
  } else {
    _stepSynthetic();
  }

  // Update state.trail and scores (works for both modes — state.sim.volState/depthState
  // are kept current by either evolveSimState (synth) or deriveRegimeState
  // (real, applied during _commitRealBar)). During regime warmup we hold
  // matrixScores at zero (the matrix renders the WARMING UP overlay) and
  // skip the trail push so stale volState/depthState from before warmup
  // don't pollute the trail with a phantom cell.
  if (state.regimeWarmup) {
    for (let r = 0; r < state.matrixScores.length; r++)
      state.matrixScores[r].fill(0);
  } else {
    state.matrixScores = computeMatrixScores();
    const r = 4 - state.sim.volState;
    const c = state.sim.depthState;
    if (state.trail.length === 0 || state.trail[state.trail.length-1].r !== r || state.trail[state.trail.length-1].c !== c) {
      state.trail.push({ r, c });
      if (state.trail.length > TRAIL_LEN) state.trail.shift();
    }
  }

  // Evaluate both canonical entries. Edge-trigger per watch.
  // (In real mode, _commitRealBar already evaluated + recorded the fire for
  // the most recent settled bar, so handleWatchFire here is a no-op for the
  // already-fired case. We still re-evaluate so the matrix/watch panels
  // reflect the live state including the unsettled forming bar.)
  const breakoutCanonical = evaluateBreakoutCanonical();
  const fadeCanonical     = evaluateFadeCanonical();
  const absorptionWallCanonical = evaluateAbsorptionWallCanonical();
  const valueEdgeRejectCanonical = evaluateValueEdgeReject();

  if (state.replay.mode !== 'real') {
    handleWatchFire('breakout', breakoutCanonical, state.breakoutWatch, BREAKOUT_CELL, null);
    handleWatchFire('fade',     fadeCanonical,     state.fadeWatch,     FADE_CELL, null);
    handleWatchFire('absorptionWall', absorptionWallCanonical, state.absorptionWallWatch, ABSORPTION_WALL_CELL, null);
    handleWatchFire('valueEdgeReject', valueEdgeRejectCanonical, state.valueEdgeRejectWatch, VALUE_EDGE_REJECT_LOCK_CELL, null);
  }

  // Render
  document.getElementById('barCount').textContent =
    (state.replay.mode === 'real' ? '1m bars · ' : '') +
    `${state.bars.length} ${state.replay.mode === 'real' ? 'shown' : 'bars'} · last ${state.formingBar ? 'forming' : 'settled'}`;
  drawPriceChart();
  drawFlowChart();
  renderMatrix(breakoutCanonical, fadeCanonical, absorptionWallCanonical, valueEdgeRejectCanonical);
  renderBreakoutWatch(breakoutCanonical);
  renderFadeWatch(fadeCanonical);
  renderAbsorptionWallWatch(absorptionWallCanonical);
  renderValueEdgeRejectWatch(valueEdgeRejectCanonical);
  renderEventLog();
  if (state.replay.mode === 'real') _renderReplayChrome();
  // If the user is panned over history while streaming, override the live
  // matrix render with the regime at the NOW line so the panel keeps showing
  // the historical vol×depth state.
  if (state.replay.mode === 'real' && state.chartViewEnd !== null && state.chartViewEnd !== state.replay.cursor) {
    _refreshMatrixForView();
  }
}

function _stepSynthetic() {
  if (!state.formingBar) {
    evolveSimState();
    state.formingBar = generateBar();
    state.sim.formingProgress = 1;
  } else {
    state.sim.formingProgress++;
    // Slightly perturb forming bar to simulate intra-bar tick movement
    const wiggle = (Math.random() - 0.5) * 0.4;
    state.formingBar.close += wiggle;
    state.formingBar.high = Math.max(state.formingBar.high, state.formingBar.close + Math.random() * 0.2);
    state.formingBar.low  = Math.min(state.formingBar.low,  state.formingBar.close - Math.random() * 0.2);
    state.formingBar.volume += Math.round(rand(40, 120));
    const range = state.formingBar.high - state.formingBar.low || 0.01;
    const closePos = (state.formingBar.close - state.formingBar.low) / range;
    state.formingBar.delta = Math.round(state.formingBar.volume * (closePos - 0.5) * 2 * 0.6);
  }

  if (state.sim.formingProgress >= FORMING_STEPS) {
    state.bars.push(state.formingBar);
    if (state.bars.length > MAX_BARS) state.bars.shift();
    const newEvs = detectEvents(state.formingBar, state.bars.slice(0, -1),
                                  { biasH1: state.formingBar.biasH1 ?? null });
    const { eventCooldownBars } = getSignalCooldownBars();
    const deduped = filterNewEventsCooldown(
      newEvs, state.events, state.bars, eventCooldownBars, null);
    for (const ev of deduped) state.events.push(ev);
    detectStopRun();
    if (state.events.length > 80) state.events = state.events.slice(-80);
    state.formingBar = null;
    state.sim.formingProgress = 0;
  }
}

function _stepReal() {
  if (!state.formingBar) {
    if (state.replay.cursor >= state.replay.allBars.length) {
      // End of state.replay — pause the stream.
      if (state.interval) {
        clearInterval(state.interval);
        state.interval = null;
        document.getElementById('streamBtn').textContent = 'End of session';
      }
      return;
    }
    // Copy the next real bar; it's drawn as forming for FORMING_STEPS sub-ticks
    // before being settled and committed.
    state.formingBar = { ...state.replay.allBars[state.replay.cursor] };
    state.sim.formingProgress = 1;
  } else {
    state.sim.formingProgress++;
    // No wiggle: real values are sacred.
  }

  if (state.sim.formingProgress >= FORMING_STEPS) {
    // Commit the bar — runs detection/eval/watch-fire identically to seek.
    _commitRealBar(state.replay.cursor);
    state.replay.cursor++;
    state.formingBar = null;
    state.sim.formingProgress = 0;
    // Cursor advanced — re-derive state.replay.current so VWAP/POC/badge readouts
    // track the new right-edge session if we just rolled into a new day.
    _syncCurrentSession();
  }
}

function handleWatchFire(watchId, canonical, watchState, cellDef, sessionStartIdx = null) {
  if (canonical.fired && !watchState.firedThisCycle) {
    watchState.firedThisCycle = true;
    const lastBar = state.bars[state.bars.length - 1];
    if (lastBar) {
      const { fireCooldownBars } = getSignalCooldownBars();
      const indexSource = state.replay.mode === 'real' && state.replay.allBars.length
        ? state.replay.allBars
        : state.bars;
      const skipNearDup = isCanonicalFireRepeatTooSoon(
        watchId, canonical.direction, lastBar.time,
        state.canonicalFires, indexSource, fireCooldownBars, sessionStartIdx);
      if (!skipNearDup) {
        // Phase 6: every fire — including SUPPRESSED — gets recorded so
        // the event log can display them under `state.showSuppressed=true`.
        // What SUPPRESSED *does* skip is the user-visible banner + auto-
        // pause logic below; the dashboard renderers (event log, watch
        // panel) read the persisted tag to apply gradient tints, glyphs,
        // and "filtered by HTF" indicators.
        const row = {
          watchId,
          barTime: lastBar.time,
          direction: canonical.direction,
          price: lastBar.close,
          tag:        canonical.tag        || null,
          alignment:  canonical.alignment  || null,
          // Persist the gate results at fire time so the watch modal can show
          // the same breakdown as when the user opens it from a chart marker.
          checks:  { ...canonical.checks },
          passing: canonical.passing,
          total:   canonical.total,
        };
        if (watchId === 'valueEdgeReject') {
          if (canonical.edge) row.edge = canonical.edge;
          if (canonical.anchorPrice != null) row.anchorPrice = canonical.anchorPrice;
        }
        state.canonicalFires.push(row);
        // Keep synthetic mode lightweight (rolling panel), but preserve full
        // history in real/API mode so precomputeAllFires and inventory stats
        // reflect the entire loaded timeline.
        if (state.replay.mode !== 'real' && state.canonicalFires.length > 20) {
          state.canonicalFires.shift();
        }
      }
    }
    // SUPPRESSED never triggers banner / auto-pause — the whole point of
    // hard-mode is to silently filter; the row is still in the log for
    // post-hoc review when showSuppressed is on.
    if (canonical.tag === 'SUPPRESSED') return;
    // Suppress pause/banner during seek/precompute — we want to record the
    // fire but not interrupt the user's scrub.
    if (state.seekInProgress) return;
    const toggleId = watchId === 'fade'
      ? 'fadeAutoPauseToggle'
      : watchId === 'absorptionWall'
        ? 'absorptionWallAutoPauseToggle'
        : watchId === 'valueEdgeReject'
          ? 'valueEdgeRejectAutoPauseToggle'
          : 'autoPauseToggle';
    const toggle = document.getElementById(toggleId);
    // If the modal is closed, the toggle isn't in the DOM. Use the cached preference
    // (defaults to false). When the modal is open, sync the cached preference.
    if (toggle) state.autoPausePrefs[watchId] = toggle.checked;
    const autoPauseEnabled = state.autoPausePrefs[watchId];
    if (autoPauseEnabled && state.interval) {
      pauseForFire(watchId, canonical, cellDef);
    }
  } else if (!canonical.fired) {
    watchState.firedThisCycle = false;
  }
}

export { step, _stepSynthetic, _stepReal, handleWatchFire };
