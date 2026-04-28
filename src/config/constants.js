// ───────────────────────────────────────────────────────────
// Numeric / structural constants
// ───────────────────────────────────────────────────────────
export const MAX_BARS     = 60;
/** Bars committed per slice in API `seekAsync` (yield between slices for UI). */
export const SEEK_ASYNC_BATCH_BARS = 1000;
export const PROFILE_BINS = 36;
export const VA_FRACTION  = 0.68;        // 1σ ≈ 68% of volume
export const MATRIX_ROWS  = 5;
export const MATRIX_COLS  = 5;
export const TRAIL_LEN    = 5;

export const BASE_TICK_MS  = 850;
export const FORMING_STEPS = 3;

// ───────────────────────────────────────────────────────────
// Labels for matrix axes
// ───────────────────────────────────────────────────────────
export const VOL_LABELS   = ['Climactic', 'Impulsive', 'Active', 'Steady', 'Quiet'];   // top → bottom (5 → 1)
export const DEPTH_LABELS = ['Thin', 'Light', 'Normal', 'Deep', 'Stacked'];            // left → right (1 → 5)

// ───────────────────────────────────────────────────────────
// Canonical Watches — the cells we're studying.
// BREAKOUT: [Impulsive · Light] — sweep into thin book, predicts continuation
// FADE:     [Active · Normal]   — stretch from POC + VWAP, predicts mean reversion
// ───────────────────────────────────────────────────────────
export const BREAKOUT_CELL = {
  r: 1, c: 1,
  volState: 3, depthState: 1,
  name: 'Impulsive · Light',
};
export const FADE_CELL = {
  r: 2, c: 2,
  volState: 2, depthState: 2,
  name: 'Active · Normal',
};
// ABSORPTION WALL: label cell [Climactic · Stacked]. Regime for fires is wider
// (see isAbsorptionWallRegime): Deep+ book, Active+ vol.
export const ABSORPTION_WALL_CELL = {
  r: 0, c: 4,
  volState: 4, depthState: 4,
  name: 'Climactic · Stacked',
};

/**
 * "Hybrid" book depth: **Deep (3) or Stacked (4)** — not only the far column —
 * with **Active+** volatility (2..4). Highest hit-rate lift vs Stacked-only.
 */
export function isAbsorptionWallRegime(volState, depthState) {
  return depthState >= 3 && volState >= 2;
}

/** Value Edge Rejection: Active–Steady vol (2..3) × Normal–Deep book (2..3) — 2×2 "middle" block. */
export function isValueEdgeRejectRegime(volState, depthState) {
  return volState >= 2 && volState <= 3 && depthState >= 2 && depthState <= 3;
}

// Representative cell for scenario-lock / force-demo (Active · Normal, inside the 2×2).
export const VALUE_EDGE_REJECT_LOCK_CELL = {
  r: 2, c: 2, volState: 2, depthState: 2, name: 'Active · Normal',
};

// Backward-compatible alias for any straggling references.
export const WATCHED_CELL = BREAKOUT_CELL;

export const BREAKOUT_LABELS = { cell: 'cell', sweep: 'sweep', flow: 'flow', clean: 'clean', alignment: 'HTF align' };
export const FADE_LABELS     = { balanced: 'balance', cell: 'cell', stretchPOC: 'POC stretch', stretchVWAP: 'VWAP stretch', noMomentum: 'momentum', alignment: 'HTF align' };
export const ABSORPTION_WALL_LABELS = { cell: 'cell', stall: 'stall', volume: 'volume', level: 'VWAP/VA', alignment: 'HTF align' };

export const VALUE_EDGE_REJECT_LABELS = {
  regime: 'regime',
  failedAtEdge: 'failed at VA',
  rejectionWick: 'rejection wick',
  volume: 'volume',
  alignment: 'HTF align',
};

/** ES / MES minimum price increment (for tick-based stall/level gates). */
export const ES_MIN_TICK = 0.25;

// ───────────────────────────────────────────────────────────
// Synthetic-default detection thresholds — match the inline numbers in
// detectEvents(). When a real session loads, replay.tunings overrides
// for the 1m timeframe; higher timeframes always read from
// SYNTH_TUNINGS_BY_TF until per-timeframe calibration lands.
//
// Phase 5: thresholds are structured as timeframe-keyed in the config
// dict, but the 15m and 1h values are COPIES of the 1m values for now.
// Per-timeframe threshold calibration is a follow-up task — bar count
// drops ~15× at 15m and ~60× at 1h, so absolute event rates will fall
// roughly proportionally with identical thresholds (which is fine for a
// first pass; thresholds are multiplicative against rolling avgs and
// thus already self-scaling to a degree).
// ───────────────────────────────────────────────────────────
const _BASE_TUNINGS_1M = {
  sweepVolMult:        1.65,
  absorbVolMult:       1.75,
  absorbRangeMult:     0.55,
  divergenceFlowMult:  0.6,
  largePrintThreshold: 50,
  /** Minimum settled bars between two chart events with the same (type, dir) signature. */
  eventCooldownBars: 4,
  /**
   * Minimum bars between canonical fires with the same watch + trade direction.
   * When omitted, `eventCooldownBars` is used.
   */
  fireCooldownBars:    4,
  /**
   * Absorption Wall: last bar volume > this × mean volume of prior bars (up to 10).
   * 1.15 captures smaller walls (notes); raise toward 1.3+ if too chatty in RTH.
   */
  absorptionWallVolMult:   1.15,
  /** Max |close − prev close| in ticks — ES often "vibrates" a few ticks in absorption. */
  absorptionWallStallTicks: 4.5,
  /** Max |close − open| in ticks for in-bar indecision (OR'd with close-to-close stall). */
  absorptionWallStallBodyTicks: 3.5,
  /**
   * With ≥11 settled bars: stall also requires (high−low) > this × mean prior-10
   * bar range, so wick+unchanged close counts as "energy" and flat inside bars do not.
   */
  absorptionWallStallMinRangeMult: 0.25,
  /** Bar close must be within this many ticks of VWAP, VAH, VAL, or POC (wider = vacuum). */
  absorptionWallLevelTicks: 15,
  /**
   * Value Edge Rejection: last bar volume within [min, max] × 10-bar average (normal participation).
   */
  valueRejectVolMinMult: 0.8,
  valueRejectVolMaxMult: 1.2,
};

export const SYNTH_TUNINGS_BY_TF = {
  '1m':  { ..._BASE_TUNINGS_1M },
  '15m': { ..._BASE_TUNINGS_1M },
  '1h':  { ..._BASE_TUNINGS_1M },
};

// Backward-compatible alias. Existing call sites that imported
// `SYNTH_TUNINGS` continue to receive the 1m thresholds unchanged.
export const SYNTH_TUNINGS = SYNTH_TUNINGS_BY_TF['1m'];

export function getSynthTunings(tf) {
  return SYNTH_TUNINGS_BY_TF[tf] || SYNTH_TUNINGS_BY_TF['1m'];
}

// Canonical timeframe set the dashboard understands. The selector will
// be populated from /timeframes when API mode is active, but this is
// the fallback / synthetic-mode default.
export const TIMEFRAMES = ['1m', '15m', '1h'];
export const DEFAULT_TIMEFRAME = '1m';
