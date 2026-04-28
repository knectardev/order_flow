import { state } from '../state.js';
import { evaluateAbsorptionWallCanonical, evaluateBreakoutCanonical, evaluateFadeCanonical, evaluateValueEdgeReject } from '../analytics/canonical.js';
import { renderAbsorptionWallWatch, renderBreakoutWatch, renderFadeWatch, renderValueEdgeRejectWatch } from '../render/watch.js';
import { forceAbsorptionWallScenario, forceBreakoutScenario, forceFadeScenario, forceValueEdgeRejectScenario } from './controls.js';

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
  absorptionWall: {
    variant: 'absorption-wall',
    glyph: '🛡',
    name: 'Absorption Wall · Climactic · Stacked',
    build: buildAbsorptionWallModalBody,
  },
  valueEdgeReject: {
    variant: 'value-edge',
    glyph: '🎯',
    name: 'Value Edge Rejection · Active–Steady · Normal–Deep',
    build: buildValueEdgeRejectModalBody,
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

/**
 * @param {string} modalId
 * @param {{ fire?: { watchId: string, checks?: object, barTime: *, passing?: number, total?: number } }} [openOpts]
 *        When opening from a chart fire marker, pass the fire log row so the
 *        checklist can use the criteria snapshot at fire time.
 */
function openModal(modalId, openOpts) {
  const cfg = MODAL_CONFIG[modalId];
  if (!cfg) return;
  state.currentModal = modalId;

  const overlay = document.getElementById('modalOverlay');
  const panel = document.getElementById('modalPanel');
  panel.className = 'modal-panel variant-' + cfg.variant;
  document.getElementById('modalGlyph').textContent = cfg.glyph;
  document.getElementById('modalName').textContent = cfg.name;
  const headMeta = document.getElementById('modalMeta');
  if (modalId === 'breakout' || modalId === 'fade' || modalId === 'absorptionWall' || modalId === 'valueEdgeReject') {
    const total = modalId === 'fade' ? 6 : 5;
    headMeta.innerHTML = `<span class="modal-meta-num" id="modalMetaNum">0</span> / ${total}`;
  } else {
    headMeta.innerHTML = '';
  }

  const body = document.getElementById('modalBody');
  body.innerHTML = cfg.build();

  const fire = openOpts && openOpts.fire ? openOpts.fire : null;
  if (fire && (modalId === 'breakout' || modalId === 'fade' || modalId === 'absorptionWall' || modalId === 'valueEdgeReject')) {
    const hint = document.createElement('div');
    hint.className = 'watch-snapshot-hint';
    if (fire.checks) {
      hint.textContent = 'Gates below are the snapshot from when this entry fired; they do not follow the current bar.';
    } else {
      hint.textContent = 'This log entry has no stored gate snapshot; values below are live state.';
    }
    body.insertBefore(hint, body.firstChild);
  }

  // Wire force-scenario buttons that were emitted into the modal body. We use
  // data-force=breakout|fade rather than inline onclick= so this works under
  // ES modules (the function isn't on `window`).
  body.querySelectorAll('[data-force]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.force === 'breakout') forceBreakoutScenario();
      else if (btn.dataset.force === 'fade') forceFadeScenario();
      else if (btn.dataset.force === 'absorptionWall') forceAbsorptionWallScenario();
      else if (btn.dataset.force === 'valueEdgeReject') forceValueEdgeRejectScenario();
    });
  });

  overlay.classList.add('visible');

  const fromFireSnapshot = !!(fire && fire.checks);
  if (modalId === 'breakout') {
    let c;
    if (fire && fire.watchId === 'breakout' && fire.checks) {
      c = {
        checks: { ...fire.checks },
        passing: fire.passing,
        total: fire.total,
        fired: fire.passing === fire.total,
        direction: fire.direction,
        alignment: fire.alignment,
        tag: fire.tag,
      };
    } else {
      c = evaluateBreakoutCanonical();
    }
    renderBreakoutWatch(c, { fromFireSnapshot });
  }
  if (modalId === 'fade') {
    let c;
    if (fire && fire.watchId === 'fade' && fire.checks) {
      c = {
        checks: { ...fire.checks },
        passing: fire.passing,
        total: fire.total,
        fired: true,
        direction: fire.direction,
        stretchDir: null,
        alignment: fire.alignment,
        tag: fire.tag,
      };
    } else {
      c = evaluateFadeCanonical();
    }
    renderFadeWatch(c, { fromFireSnapshot });
  }
  if (modalId === 'absorptionWall') {
    let c;
    if (fire && fire.watchId === 'absorptionWall' && fire.checks) {
      c = {
        checks: { ...fire.checks },
        passing: fire.passing,
        total: fire.total,
        fired: fire.passing === fire.total,
        direction: fire.direction,
        alignment: fire.alignment,
        tag: fire.tag,
      };
    } else {
      c = evaluateAbsorptionWallCanonical();
    }
    renderAbsorptionWallWatch(c, { fromFireSnapshot });
  }
  if (modalId === 'valueEdgeReject') {
    let c;
    if (fire && fire.watchId === 'valueEdgeReject' && fire.checks) {
      c = {
        checks: { ...fire.checks },
        passing: fire.passing,
        total: fire.total,
        fired: fire.passing === fire.total,
        direction: fire.direction,
        edge: fire.edge ?? null,
        anchorPrice: fire.anchorPrice ?? null,
        alignment: fire.alignment,
        tag: fire.tag,
      };
    } else {
      c = evaluateValueEdgeReject();
    }
    renderValueEdgeRejectWatch(c, { fromFireSnapshot });
  }
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('visible');
  state.currentModal = null;
}

function onOverlayClick(e) {
  if (e.target.id === 'modalOverlay') closeModal();
}

function buildBreakoutModalBody() {
  // Match counter `modalMetaNum` is set by `renderBreakoutWatch` in `openModal`.
  return `
    <div class="watch-summary">
      <strong>Watching for:</strong> sweep into thin book with cumulative-Δ confirmation. Predicts directional travel toward next structural level (opposite VAH/VAL, prior session extreme) within ~15 bars after entry.
    </div>
    <ul class="criteria-list" id="breakoutCriteriaList">
      <li class="criterion" data-key="cell"><span class="check">○</span><span class="text">State currently in [Impulsive · Light]</span></li>
      <li class="criterion" data-key="sweep"><span class="check">○</span><span class="text">Sweep event in last 3 settled bars</span></li>
      <li class="criterion" data-key="flow"><span class="check">○</span><span class="text">Cumulative Δ over last 5 bars aligned with sweep direction</span></li>
      <li class="criterion" data-key="clean"><span class="check">○</span><span class="text">No contradictory absorption / divergence in last 8 bars</span></li>
      <li class="criterion" data-key="alignment"><span class="check">○</span><span class="text">1h bias not opposing trade direction</span></li>
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
  // Match counter `modalMetaNum` is set by `renderFadeWatch` in `openModal`.
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
      <li class="criterion" data-key="alignment"><span class="check">○</span><span class="text">1h bias not opposing trade direction</span></li>
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

function buildValueEdgeRejectModalBody() {
  return `
    <div class="watch-summary">
      <strong>Balance-based mean reversion:</strong> a failed push at the value-area edge (high/low probe VAH/VAL, close back inside the VA) with a rejection wick and normal (non-spike) volume. The intended direction is back toward the session POC — fade-style HTF alignment.
    </div>
    <ul class="criteria-list" id="valueEdgeRejectCriteriaList">
      <li class="criterion" data-key="regime"><span class="check">○</span><span class="text">Volatility Active or Steady, book Normal or Deep (middle 2×2)</span></li>
      <li class="criterion" data-key="failedAtEdge"><span class="check">○</span><span class="text">Bar probed VAH/VAL (high/low) and closed strictly inside the value area</span></li>
      <li class="criterion" data-key="rejectionWick"><span class="check">○</span><span class="text">Rejection wick on the probed side (top at VAH, bottom at VAL)</span></li>
      <li class="criterion" data-key="volume"><span class="check">○</span><span class="text">Volume between 0.8× and 1.2× 10-bar average (standard participation)</span></li>
      <li class="criterion" data-key="alignment"><span class="check">○</span><span class="text">1h bias not opposing trade direction (toward POC)</span></li>
    </ul>
    <div class="watch-diagnostic" id="valueEdgeRejectDiagnostic">
      <span class="diag-label">last to break:</span>
      <span class="diag-value" id="valueEdgeRejectDiagValue">—</span>
    </div>
    <div class="watch-controls">
      <label class="auto-pause-label">
        <input type="checkbox" id="valueEdgeRejectAutoPauseToggle" ${state.autoPausePrefs.valueEdgeReject ? 'checked' : ''}>
        <span>Auto-pause when this entry fires</span>
      </label>
      <button class="watch-force value-edge-force" data-force="valueEdgeReject">${state.replay.mode === 'real' ? 'Jump to next 🎯' : 'Force 🎯'}</button>
    </div>
  `;
}

function buildAbsorptionWallModalBody() {
  return `
    <div class="watch-summary">
      <strong>Watching for:</strong> high volatility with deep book, stalled price, volume spike, and price parked near session VAH, VAL, or VWAP. Aggressive flow met passive liquidity — the move that should have continued did not.
    </div>
    <ul class="criteria-list" id="absorptionWallCriteriaList">
      <li class="criterion" data-key="cell"><span class="check">○</span><span class="text">[Active+ · Deep] or [Active+ · Stacked] — last two depth columns, Active vol+</span></li>
      <li class="criterion" data-key="stall"><span class="check">○</span><span class="text">Contested range + (tight close vs prior OR small body); k× prior range when 10+ lookback</span></li>
      <li class="criterion" data-key="volume"><span class="check">○</span><span class="text">Volume &gt; mult × 10-bar average volume</span></li>
      <li class="criterion" data-key="level"><span class="check">○</span><span class="text">Close within N ticks of VAH, VAL, POC, or anchored VWAP</span></li>
      <li class="criterion" data-key="alignment"><span class="check">○</span><span class="text">1h vote ≥ −1 vs bar impulse; fire arrow = mean-reversion</span></li>
    </ul>
    <div class="watch-diagnostic" id="absorptionWallDiagnostic">
      <span class="diag-label">last to break:</span>
      <span class="diag-value" id="absorptionWallDiagValue">—</span>
    </div>
    <div class="watch-controls">
      <label class="auto-pause-label">
        <input type="checkbox" id="absorptionWallAutoPauseToggle" ${state.autoPausePrefs.absorptionWall ? 'checked' : ''}>
        <span>Auto-pause when this entry fires</span>
      </label>
      <button class="watch-force absorption-wall-force" data-force="absorptionWall">${state.replay.mode === 'real' ? 'Jump to next 🛡' : 'Force 🛡'}</button>
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

export { MODAL_CONFIG, EVENT_INFO, openModal, closeModal, onOverlayClick, buildAbsorptionWallModalBody, buildBreakoutModalBody, buildFadeModalBody, buildValueEdgeRejectModalBody, buildEventModalBody };
