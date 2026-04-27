// ───────────────────────────────────────────────────────────
// Numeric / structural constants
// ───────────────────────────────────────────────────────────
export const MAX_BARS     = 60;
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
// Backward-compatible alias for any straggling references.
export const WATCHED_CELL = BREAKOUT_CELL;

export const BREAKOUT_LABELS = { cell: 'cell', sweep: 'sweep', flow: 'flow', clean: 'clean' };
export const FADE_LABELS     = { balanced: 'balance', cell: 'cell', stretchPOC: 'POC stretch', stretchVWAP: 'VWAP stretch', noMomentum: 'momentum' };

// ───────────────────────────────────────────────────────────
// Synthetic-default detection thresholds — match the inline numbers in
// detectEvents(). When a real session loads, replay.tunings overrides.
// ───────────────────────────────────────────────────────────
export const SYNTH_TUNINGS = {
  sweepVolMult:        1.65,
  absorbVolMult:       1.75,
  absorbRangeMult:     0.55,
  divergenceFlowMult:  0.6,
  largePrintThreshold: 50,
};
