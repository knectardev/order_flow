// ───────────────────────────────────────────────────────────
// Shared mutable state singleton.
//
// Every module that needs to read or write live state imports `state` and
// uses `state.bars`, `state.sim.price`, etc. This avoids ESM's read-only
// `let` export problem: bindings exported with `let` cannot be reassigned
// from import sites, but properties of an exported object can.
//
// Boundary: this file owns *mutable* runtime state only. Numeric/structural
// constants live in `./config/constants.js`. DOM canvas refs are owned by
// the modules that draw to them (they're acquired once, never reassigned).
// ───────────────────────────────────────────────────────────
import { MATRIX_ROWS, MATRIX_COLS, BASE_TICK_MS, SYNTH_TUNINGS } from './config/constants.js';

export const state = {
  // Bars + events on the rolling window
  bars: [],            // settled bars
  formingBar: null,    // current pending bar (drawn distinct)
  events: [],          // {type, dir, time, price, barIndex}
  trail: [],           // [{r, c}, ...] last TRAIL_LEN cells the regime visited
  matrixScores: Array.from({ length: MATRIX_ROWS }, () => Array(MATRIX_COLS).fill(0)),
  canonicalFires: [],  // {watchId, barTime, direction, price}

  // Per-watch state. Each watch tracks its own fire-edge, last evaluation, and flip ticks.
  breakoutWatch: {
    lastCanonical: null,
    firedThisCycle: false,
    flipTicks: { cell: null, sweep: null, flow: null, clean: null },
  },
  fadeWatch: {
    lastCanonical: null,
    firedThisCycle: false,
    flipTicks: { balanced: null, cell: null, stretchPOC: null, stretchVWAP: null, noMomentum: null },
  },

  // Auto-pause preferences — persist outside modal lifecycle since toggles only exist when modal is open
  autoPausePrefs: { breakout: true, fade: true },

  // Scenario forcer — drives demo buttons.
  // scenarioLockBars pins state to scenarioLockCell for that many bars.
  scenarioLockBars: 0,
  scenarioLockCell: null,       // BREAKOUT_CELL or FADE_CELL or null
  primeNextSweep: false,        // next bar guaranteed to produce a sweep (breakout demo)
  primedDisplacement: 0,        // remaining bars of forced directional drift (fade demo)
  primedDirection: 0,           // -1 or +1 for forced drift

  // Synthetic-mode walk state
  sim: {
    price: 4500,
    volState: 2,    // 0..4 (matches matrix col)
    depthState: 2,  // 0..4 (matches matrix row, inverted)
    drift: 0,
    bias: 1,
    tick: 0,
    formingProgress: 0,
  },

  // Real-data replay state. mode='synthetic' preserves the original prototype
  // behavior 100% (no fetch, no JSON, generateBar/evolveSimState in step()).
  // mode='real' switches step() to consume pre-aggregated bars from session
  // JSONs (now ALL sessions concatenated into one continuous timeline), derives
  // volState/depthState from per-session quintile microstructure, and resets
  // VWAP/POC at every session boundary.
  //
  // `sessions` holds one meta object per loaded day:
  //   { file, date, contract, sessionStart (ISO), sessionEnd (ISO),
  //     sessionStartMs, sessionEndMs, startIdx, endIdx (exclusive),
  //     barCount, tunings, regimeBreaks }
  // `current` is a convenience pointer to the session containing the bar at
  // the right-edge / NOW position; it's re-derived on every seek/step/pan.
  replay: {
    mode: 'synthetic',
    sessions: [],            // [session-meta, ...] across all loaded days
    current: null,           // session containing right-edge / NOW bar
    allBars: [],             // concatenated bars across ALL loaded sessions
    cursor: 0,               // next bar to emit (== bars currently rendered, when not forming)
    tunings: null,           // tunings of replay.current (overrides SYNTH_TUNINGS in real mode)
    sessionAnchorNs: null,   // (legacy; superseded by per-session sessionStartMs)
    allFires: [],            // pre-scanned canonical fires for jump-to-next
    allEvents: [],           // pre-scanned events across the entire concatenated timeline
  },

  // Chart viewport state for real-data history scrolling.
  // `chartViewEnd` is an exclusive index into replay.allBars; null ⇒ follow live cursor
  // (default behavior — viewport ends at the last committed/forming bar).
  // When the user pans, chartViewEnd is locked to a specific value and a "↺ Live"
  // button appears to return to live edge.
  chartViewEnd: null,

  // Hit-test list rebuilt every drawPriceChart() call, used by the hover tooltip.
  // Each entry: {x, y, r, kind: 'event'|'fire', payload}
  chartHits: [],

  seekInProgress: false,  // suppresses fire-banner pause during seek/precompute

  interval: null,         // setInterval handle for the streaming tick
  speedMultiplier: 1,     // 1×..8× tick-speed multiplier from the speed slider

  lastFiredWatch: null,   // 'breakout' | 'fade' | null — used by Details button
  currentModal: null,     // 'breakout' | 'fade' | 'sweep' | 'absorption' | 'stoprun' | 'divergence' | null

  isPanningChart: false,  // chart is currently being click-dragged horizontally
};

// Effective tunings: real-session overrides default synthetic.
export function getTunings() {
  return state.replay.tunings || SYNTH_TUNINGS;
}

// Streaming tick interval, scaled by the speed slider.
export function getTickMs() {
  return BASE_TICK_MS / state.speedMultiplier;
}
