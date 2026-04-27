import { state } from '../state.js';
import { evaluateBreakoutCanonical, evaluateFadeCanonical } from '../analytics/canonical.js';
import { renderBreakoutWatch, renderFadeWatch } from '../render/watch.js';
import { forceBreakoutScenario, forceFadeScenario } from './controls.js';

const MODAL_CONFIG = {
  breakout: {
    variant: 'breakout',
    glyph: '★',
    name: 'Breakout · Impulsive · Light',
    build: buildBreakoutModalBody,
  },
  fade: {
    variant: 'fade',
    glyph: '◆',
    name: 'Fade · Active · Normal',
    build: buildFadeModalBody,
  },
  sweep: {
    variant: 'sweep',
    glyph: '▲▼',
    name: 'Sweep',
    build: buildEventModalBody.bind(null, 'sweep'),
  },
  absorption: {
    variant: 'absorb',
    glyph: '◉',
    name: 'Absorption',
    build: buildEventModalBody.bind(null, 'absorption'),
  },
  stoprun: {
    variant: 'stop',
    glyph: '⚡',
    name: 'Stop Run',
    build: buildEventModalBody.bind(null, 'stoprun'),
  },
  divergence: {
    variant: 'diverge',
    glyph: '⚠',
    name: 'Divergence',
    build: buildEventModalBody.bind(null, 'divergence'),
  },
};

const EVENT_INFO = {
  sweep: {
    description: 'A bar exceeds the prior N-bar high or low with elevated volume. Direction-tagged: ▲ above the bar = up-sweep, ▼ below = down-sweep.',
    detection: ['Bar high > recent 10-bar high (up) or low < recent 10-bar low (down)', 'Bar volume > 1.65× recent average volume'],
    significance: 'Sweeps mark moments where price tested a recent extreme with conviction. Whether the move continues or reverses depends on what the book and flow do next — sweep alone is mechanics, not intent.',
  },
  absorption: {
    description: 'High volume occurring in a compressed bar range. Aggressive flow met resting liquidity, and liquidity won — the move that "should have" happened didn\'t.',
    detection: ['Bar volume > 1.75× recent average', 'Bar range < 0.55× recent average range'],
    significance: 'Often indicates exhaustion or a defended level. Especially meaningful at structural levels (VAH, VAL, prior session extreme). Counts as contradictory evidence for breakout setups.',
  },
  stoprun: {
    description: 'A sweep whose immediate next bar fully reverses past the swept level. Often "last buyers/sellers in" — the kind of breakout that traps late entrants.',
    detection: ['Prior bar was a sweep (up or down)', 'Next bar closes below the sweep bar\'s open (for up-sweeps) or above it (for down-sweeps)'],
    significance: 'A textbook signal that "aggressive" buying or selling was actually stop-driven, not conviction-driven. Detected one bar after the sweep — inherently retrospective.',
  },
  divergence: {
    description: 'Price makes a new extreme but cumulative delta over the lookback window disagrees. Flow underneath the move doesn\'t confirm what price is showing.',
    detection: ['Bar high > recent 10-bar high (up div) or low < recent 10-bar low (down div)', 'Cumulative Δ over last 9 bars opposes the new extreme by > 0.6× avg volume'],
    significance: 'Often precedes mean-reversion at extremes. Particularly informative when divergence appears at a structural level — the new high/low is unconfirmed by the underlying flow.',
  },
};

function openModal(modalId) {
  const cfg = MODAL_CONFIG[modalId];
  if (!cfg) return;
  state.currentModal = modalId;

  const overlay = document.getElementById('modalOverlay');
  const panel = document.getElementById('modalPanel');
  panel.className = 'modal-panel variant-' + cfg.variant;
  document.getElementById('modalGlyph').textContent = cfg.glyph;
  document.getElementById('modalName').textContent = cfg.name;
  document.getElementById('modalMeta').innerHTML = '';

  const body = document.getElementById('modalBody');
  body.innerHTML = cfg.build();

  // Wire force-scenario buttons that were emitted into the modal body. We use
  // data-force=breakout|fade rather than inline onclick= so this works under
  // ES modules (the function isn't on `window`).
  body.querySelectorAll('[data-force]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.force === 'breakout') forceBreakoutScenario();
      else if (btn.dataset.force === 'fade') forceFadeScenario();
    });
  });

  overlay.classList.add('visible');

  // For canonical watch modals, immediately update with current state
  if (modalId === 'breakout') renderBreakoutWatch(evaluateBreakoutCanonical());
  if (modalId === 'fade')     renderFadeWatch(evaluateFadeCanonical());
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('visible');
  state.currentModal = null;
}

function onOverlayClick(e) {
  if (e.target.id === 'modalOverlay') closeModal();
}

function buildBreakoutModalBody() {
  // Append match counter to modal meta
  setTimeout(() => {
    const meta = document.getElementById('modalMeta');
    if (meta) meta.innerHTML = '<span class="modal-meta-num" id="modalMetaNum">0</span> / 4';
  }, 0);

  return `
    <div class="watch-summary">
      <strong>Watching for:</strong> sweep into thin book with cumulative-Δ confirmation. Predicts directional travel toward next structural level (opposite VAH/VAL, prior session extreme) within ~15 bars after entry.
    </div>
    <ul class="criteria-list" id="breakoutCriteriaList">
      <li class="criterion" data-key="cell"><span class="check">○</span><span class="text">State currently in [Impulsive · Light]</span></li>
      <li class="criterion" data-key="sweep"><span class="check">○</span><span class="text">Sweep event in last 3 settled bars</span></li>
      <li class="criterion" data-key="flow"><span class="check">○</span><span class="text">Cumulative Δ over last 5 bars aligned with sweep direction</span></li>
      <li class="criterion" data-key="clean"><span class="check">○</span><span class="text">No contradictory absorption / divergence in last 8 bars</span></li>
    </ul>
    <div class="watch-diagnostic" id="breakoutDiagnostic">
      <span class="diag-label">last to break:</span>
      <span class="diag-value" id="breakoutDiagValue">—</span>
    </div>
    <div class="watch-controls">
      <label class="auto-pause-label">
        <input type="checkbox" id="autoPauseToggle" ${state.autoPausePrefs.breakout ? 'checked' : ''}>
        <span>Auto-pause when this entry fires</span>
      </label>
      <button class="watch-force breakout-force" data-force="breakout">${state.replay.mode === 'real' ? 'Jump to next ★' : 'Force ★'}</button>
    </div>
    <div class="watch-twin">
      <span class="twin-label">Failure twin:</span>identical pattern in <strong style="color:var(--text-2);">[Impulsive · Stacked]</strong> predicts absorption + reversal. Same candle shape, opposite outcome — depth axis carries the prediction.
    </div>
  `;
}

function buildFadeModalBody() {
  setTimeout(() => {
    const meta = document.getElementById('modalMeta');
    if (meta) meta.innerHTML = '<span class="modal-meta-num" id="modalMetaNum">0</span> / 5';
  }, 0);

  return `
    <div class="watch-summary">
      <strong>Watching for:</strong> price stretched ≥1σ from POC for 3+ bars, confirmed by anchored VWAP, with no fresh momentum in stretch direction. Predicts drift back toward POC within ~25-40 bars (slower, longer horizon than breakout).
    </div>
    <ul class="criteria-list" id="fadeCriteriaList">
      <li class="criterion" data-key="balanced"><span class="check">○</span><span class="text">POC and VWAP within 1σ (session balanced)</span></li>
      <li class="criterion" data-key="cell"><span class="check">○</span><span class="text">State currently in [Active · Normal]</span></li>
      <li class="criterion" data-key="stretchPOC"><span class="check">○</span><span class="text">Price displaced ≥1σ from POC for 3+ consecutive bars</span></li>
      <li class="criterion" data-key="stretchVWAP"><span class="check">○</span><span class="text">Price also displaced from anchored VWAP in same direction</span></li>
      <li class="criterion" data-key="noMomentum"><span class="check">○</span><span class="text">No sweep events in last 5 bars in stretch direction</span></li>
    </ul>
    <div class="watch-diagnostic" id="fadeDiagnostic">
      <span class="diag-label">last to break:</span>
      <span class="diag-value" id="fadeDiagValue">—</span>
    </div>
    <div class="watch-controls">
      <label class="auto-pause-label">
        <input type="checkbox" id="fadeAutoPauseToggle" ${state.autoPausePrefs.fade ? 'checked' : ''}>
        <span>Auto-pause when this entry fires</span>
      </label>
      <button class="watch-force fade-force" data-force="fade">${state.replay.mode === 'real' ? 'Jump to next ◆' : 'Force ◆'}</button>
    </div>
    <div class="watch-twin">
      <span class="twin-label">Failure twin:</span>identical stretch in <strong style="color:var(--text-2);">[Active · Thin]</strong> predicts continuation, not reversion. Thin book lets stretch run; normal/deep book pulls it back. Depth axis again carries the prediction.
    </div>
  `;
}

function buildEventModalBody(eventType) {
  const info = EVENT_INFO[eventType];
  if (!info) return '<p>No info available.</p>';

  // Find recent fires of this event from the state.events log
  const recent = state.events.filter(ev => ev.type === eventType).slice(-5).reverse();
  let recentHTML = '';
  if (recent.length > 0) {
    recentHTML = `
      <div class="modal-recent-fires">
        <div class="rf-label">recent firings (this session)</div>
        ${recent.map(ev => {
          const t = ev.time.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
          const dir = ev.dir ? ` ${ev.dir === 'up' ? '↑' : '↓'}` : '';
          return `<div class="rf-row">
            <span class="rf-time">${t}</span>
            <span>${eventType}${dir}</span>
            <span class="rf-price">${ev.price.toFixed(2)}</span>
          </div>`;
        }).join('')}
      </div>
    `;
  } else {
    recentHTML = '<div class="modal-recent-fires"><div class="rf-label">recent firings</div><div style="color: var(--muted-2); font-style: italic;">none yet this session</div></div>';
  }

  const detectionList = info.detection.map(d => `<li>${d}</li>`).join('');

  return `
    <div class="watch-summary">${info.description}</div>
    <div class="modal-event-detection">
      <div class="label">Detection criteria:</div>
      <ul style="margin: 4px 0 0 18px; padding: 0; list-style: disc;">${detectionList}</ul>
    </div>
    <div class="modal-placeholder">
      <strong>Significance.</strong> ${info.significance}
    </div>
    ${recentHTML}
    <div class="modal-placeholder" style="margin-top: 14px;">
      <strong>Note.</strong> Events are detection primitives — they fire on bar-level pattern matches without making predictions about what happens next. Canonical entries (★, ◆) combine state.events with regime context to form actual hypotheses.
    </div>
  `;
}

export { MODAL_CONFIG, EVENT_INFO, openModal, closeModal, onOverlayClick, buildBreakoutModalBody, buildFadeModalBody, buildEventModalBody };
