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
import { MATRIX_ROWS, MATRIX_COLS, BASE_TICK_MS, DEFAULT_TIMEFRAME, SYNTH_TUNINGS, SYNTH_TUNINGS_BY_TF, TIMEFRAMES, getSynthTunings } from './config/constants.js';

export const state = {
  // Bars + events on the rolling window
  bars: [],            // settled bars
  formingBar: null,    // current pending bar (drawn distinct)
  events: [],          // {type, dir, time, price, barIndex}
  trail: [],           // [{r, c}, ...] last TRAIL_LEN cells the regime visited
  matrixScores: Array.from({ length: MATRIX_ROWS }, () => Array(MATRIX_COLS).fill(0)),
  canonicalFires: [],  // {watchId, barTime, direction, price, tag?, alignment?, checks?, passing?, total?, edge?, anchorPrice?}

  // Per-watch state. Each watch tracks its own fire-edge, last evaluation, and flip ticks.
  breakoutWatch: {
    lastCanonical: null,
    firedThisCycle: false,
    flipTicks: { cell: null, sweep: null, flow: null, clean: null, alignment: null },
  },
  fadeWatch: {
    lastCanonical: null,
    firedThisCycle: false,
    flipTicks: { balanced: null, cell: null, stretchPOC: null, stretchVWAP: null, noMomentum: null, alignment: null },
  },
  absorptionWallWatch: {
    lastCanonical: null,
    firedThisCycle: false,
    flipTicks: { cell: null, stall: null, volume: null, level: null, alignment: null },
  },
  valueEdgeRejectWatch: {
    lastCanonical: null,
    firedThisCycle: false,
    flipTicks: { regime: null, failedAtEdge: null, rejectionWick: null, volume: null, alignment: null },
  },

  // Auto-pause preferences — persist outside modal lifecycle since toggles only exist when modal is open
  autoPausePrefs: { breakout: false, fade: false, absorptionWall: false, valueEdgeReject: false },

  // Scenario forcer — drives demo buttons (synthetic mode only).
  //
  // Phase 5: per-timeframe scenario buckets so a forced breakout at 15m
  // does not bleed into 1m state and vice versa. In synthetic mode the
  // dashboard is always single-timeframe so only the '1m' bucket is
  // ever written to today, but the structure is in place for future
  // multi-timeframe synthetic / mixed scenarios.
  //
  // Each bucket's fields:
  //   scenarioLockBars   - pin state to scenarioLockCell for N bars
  //   scenarioLockCell   - BREAKOUT_CELL, FADE_CELL, ABSORPTION_WALL_CELL, VALUE_EDGE_REJECT_LOCK_CELL, or null
  //   primeNextSweep     - next bar guaranteed to produce a sweep (breakout demo)
  //   primedDisplacement - remaining bars of forced directional drift (fade demo)
  //   primedDirection    - -1 or +1 for forced drift
  scenarioByTf: Object.fromEntries(
    TIMEFRAMES.map(tf => [tf, {
      scenarioLockBars: 0,
      scenarioLockCell: null,
      primeNextSweep: false,
      primedDisplacement: 0,
      primedDirection: 0,
    }])
  ),

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
  // mode='real' switches step() to consume bars from the FastAPI/DuckDB
  // stack (Phase 2f retired the JSON-manifest path; ?source=api is now
  // mandatory). Each bar arrives with its v2 regime ranks (vRank/dRank)
  // already stamped, so volState/depthState are read straight off the
  // bar; per-session tunings/VWAP/POC still reset at session boundaries.
  //
  // `sessions` holds one meta object per loaded day:
  //   { file, date, contract, sessionStart (ISO), sessionEnd (ISO),
  //     sessionStartMs, sessionEndMs, startIdx, endIdx (exclusive),
  //     barCount, tunings }
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
    // Data-source flags (regime-DB plan §1d/§2f). Set during bootstrap.
    //   dataDriven  — true when bars/events/fires came from the API.
    //   apiBase     — when non-null, frontend modules talk to the FastAPI
    //                  service at this origin (e.g. http://localhost:8000)
    //                  for /bars, /events, /fires, /profile, /occupancy.
    //   source      — 'synthetic' | 'api' (JSON mode retired in §2f).
    dataDriven: false,
    apiBase: null,
    source: 'synthetic',
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

  // Brushing-and-linking selection (regime-DB plan §4b / §4c-d).
  //   kind                — null | 'cells' | 'fire'
  //                         null  ⇒ no selection, full chart visible
  //                         cells ⇒ user clicked one or more matrix cells
  //                         fire  ⇒ user clicked a fire halo on the chart
  //                                 OR a fire row in the event log; fixes the
  //                                 highlight to a 31-bar window starting at
  //                                 the fire bar (fire bar + next 30)
  //   cells               — [{r,c}, ...] when kind='cells'. Display row r
  //                         (4 - (vRank-1)) and column c (dRank-1) — same
  //                         coordinates renderMatrix uses.
  //   barTimes            — Set<number> of bar_time_ms covered by the
  //                         current selection. priceChart tints any bar in
  //                         this set during its O(visible) draw pass; null
  //                         means "no tint, render normally".
  //   fireBarTime         — ms, only when kind='fire'. Used to draw the
  //                         vertical anchor line at the fire bar.
  //   fireWindowEndMs     — ms, only when kind='fire'. Inclusive end of the
  //                         fire+30 window (matches barTimes membership).
  // Reducer: src/ui/selection.js owns mutations + drives the
  // /bars?cell=… and /events?bar_times= fetches when kind='cells'.
  selection: {
    kind: null,
    cells: [],
    barTimes: null,
    fireBarTime: null,
    fireWindowEndMs: null,
  },

  // Matrix occupancy heatmap state (regime-DB plan §3a-d).
  //   range.kind   — 'session' | 'lastHour' | 'lastN' | 'all' | 'custom'
  //   range.n      — when kind='lastN', number of trailing sessions
  //   range.from / .to — Unix ms (custom only; the other kinds derive
  //                       these on each render from cursor + sessions)
  //   range.label  — short pill/legend text ("Current session", "Last 5",
  //                   "Custom 04-24 13:30 → 04-24 16:00", …)
  //   displayMode  — 'posterior' (default — preserves existing visual)
  //                   | 'heatmap' (cells tinted by occupancy fraction)
  //   occupancy    — last-fetched /occupancy response: { from, to,
  //                   total_bars, cells: [{v_rank,d_rank,occupancy}],
  //                   maxCell }. `null` until the first fetch resolves.
  // The reducer fields (range/displayMode) drive rendering; `occupancy`
  // is a fetch cache — re-populated when `range` changes (or every step
  // for cursor-bound ranges where the API returns no-cache).
  matrixState: {
    range: { kind: 'session', n: null, from: null, to: null, label: 'Current session' },
    displayMode: 'posterior',
    occupancy: null,
  },

  // Regime warmup flag (regime-DB plan §2c-d). True when the bar at the
  // current cursor / right-edge has NULL v_rank/d_rank — i.e. it's inside
  // the first 30 bars of its session, OR a zero-volume bar. While true:
  //   - matrix dims to 0.4 opacity, suppresses watched/current borders,
  //     and overlays a centered "WARMING UP" amber label
  //   - canonical evaluators (Breakout / Fade / Absorption Wall / Value Edge) return `fired: false`
  //     (suppressed even if the legacy proxy would have fired)
  //   - event log shows a sticky SYSTEM row at top until the first non-
  //     NULL rank emits
  // Set per-tick by _commitRealBar() based on deriveRegimeState's return
  // value (null ⇒ warmup). Synthetic mode never enters warmup.
  regimeWarmup: false,

  seekInProgress: false,  // suppresses fire-banner pause during seek/precompute

  interval: null,         // setInterval handle for the streaming tick
  speedMultiplier: 5.5,   // 1×..8× tick-speed multiplier from the speed slider

  lastFiredWatch: null,   // 'breakout' | 'fade' | 'absorptionWall' | 'valueEdgeReject' | null — used by Details button
  currentModal: null,     // 'breakout' | 'fade' | 'absorptionWall' | 'valueEdgeReject' | 'sweep' | 'absorption' | …

  isPanningChart: false,  // chart is currently being click-dragged horizontally

  // Phase 5 multi-timeframe context. Drives the segmented control in
  // the header, every API request URL, and the per-timeframe selection
  // of regime ranks / events / fires the dashboard renders. Default
  // '1m' preserves existing behavior on first paint and on full reload.
  // The selector is populated from /timeframes (API mode) or falls back
  // to TIMEFRAMES (synthetic).
  activeTimeframe: DEFAULT_TIMEFRAME,
  availableTimeframes: TIMEFRAMES.slice(),
  // Saved matrix-range selection from the timeframe the user was on
  // before switching to '1h'. Used to restore the selection when they
  // switch back to 1m/15m. null ⇒ no saved selection (first paint).
  savedMatrixRangeBeforeTf1h: null,

  // Phase 6 cross-timeframe bias filtering controls.
  //
  //   biasFilterMode:
  //     'soft'  (default) — Compute alignment_score and tag for every
  //                          fire. Tag never reaches SUPPRESSED in soft
  //                          mode; opposing 1h biases produce
  //                          LOW_CONVICTION but the fire is still
  //                          recorded and shown. Bias ribbon + event-log
  //                          tints render the conviction visually.
  //     'hard'             — Same as 'soft', but a fire is fully
  //                          SUPPRESSED (not pushed to canonicalFires)
  //                          when the 1h bias opposes the canonical's
  //                          direction. Use for backtests where you
  //                          want to know how many fires the regime
  //                          filter would have excluded.
  //     'off'              — Don't compute alignment at all (vote=0,
  //                          score=0, tag='STANDARD'). The bias ribbon
  //                          still draws (it's purely informational),
  //                          but no canonical fires are filtered.
  //
  //   showSuppressed: when true, SUPPRESSED entries are still rendered
  //                   in the event log (greyed/strikethrough) so the
  //                   user can see what hard-mode is filtering. When
  //                   false, SUPPRESSED entries are hidden from the
  //                   event log entirely.
  //
  // Both flags are bootstrapped from URL params at app start
  // (?biasFilter=hard, ?showSuppressed=1) — see bootstrapReplay.
  biasFilterMode: 'soft',
  showSuppressed: false,

  // Event-log UI filter.
  //   type: 'all' for no filter, 'fire_<watchId>' for canonical fires, or
  //         primitive event keys ('sweep_up' | 'sweep_down' | 'absorption' |
  //         'stoprun_up' | 'stoprun_down' | 'divergence_up' | 'divergence_down').
  eventLogFilter: {
    type: 'all',
  },
};

// Effective tunings: real-session overrides default synthetic, scoped
// to the active timeframe. The replay session's `.tunings` block is
// 1m-shaped (legacy JSON), so for higher timeframes we always read
// from SYNTH_TUNINGS_BY_TF (which currently holds copies of 1m values
// — per-timeframe calibration is a follow-up).
export function getTunings() {
  const tf = state.activeTimeframe || DEFAULT_TIMEFRAME;
  const base = { ...getSynthTunings(tf) };
  // 1m: merge session (API) on top of defaults so new SYNTH keys apply when
  // older embedded JSON omits them; per-session values still win on collision.
  if (tf === '1m' && state.replay.tunings && typeof state.replay.tunings === 'object') {
    return { ...base, ...state.replay.tunings };
  }
  if (tf === '1m') {
    return base;
  }
  return base;
}

// Active timeframe's scenario bucket. Synthetic engine + force-* demo
// buttons read/write through here so per-timeframe state stays
// independent. In synthetic mode the dashboard is always 1m so the
// helper effectively returns the '1m' bucket every call.
export function getScenario() {
  const tf = state.activeTimeframe || DEFAULT_TIMEFRAME;
  return state.scenarioByTf[tf] || state.scenarioByTf[DEFAULT_TIMEFRAME];
}

// Streaming tick interval, scaled by the speed slider.
export function getTickMs() {
  return BASE_TICK_MS / state.speedMultiplier;
}
