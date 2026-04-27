import { state } from '../state.js';
import { _continuePan, consumePanMoved } from './pan.js';
import { openModal } from './modal.js';
import { selectFire, clearSelection } from './selection.js';
import { priceCanvas } from '../util/dom.js';

const TOOLTIP_INFO = {
  sweep:      { name: 'Sweep',      glyph: '▲▼', variant: 'sweep',
                desc: 'New 10-bar extreme + elevated volume. Direction-tagged: ▲ above bar = up-sweep, ▼ below = down-sweep.' },
  absorption: { name: 'Absorption', glyph: '◉',  variant: 'absorb',
                desc: 'High volume in a compressed bar — flow met liquidity, liquidity won.' },
  stoprun:    { name: 'Stop Run',   glyph: '⚡',  variant: 'stop',
                desc: 'Sweep whose next bar fully reverses past the swept level. Often "last buyers/sellers in".' },
  divergence: { name: 'Divergence', glyph: '⚠',  variant: 'diverge',
                desc: 'New price extreme NOT confirmed by cumulative Δ. Flow disagrees with price.' },
  breakout:   { name: 'Breakout Fire', glyph: '★', variant: 'breakout',
                desc: 'All 5 criteria met for [Impulsive · Light] entry — predicts directional travel.' },
  fade:       { name: 'Fade Fire',     glyph: '◆', variant: 'fade',
                desc: 'All 6 criteria met for [Active · Normal] entry — predicts mean-reversion to POC.' },
};

function _hitTestChart(x, y) {
  let best = null, bestD2 = Infinity;
  for (const hit of state.chartHits) {
    const dx = x - hit.x, dy = y - hit.y;
    const d2 = dx*dx + dy*dy;
    if (d2 <= hit.r * hit.r && d2 < bestD2) {
      best = hit; bestD2 = d2;
    }
  }
  return best;
}

function _hideTooltip() {
  const tt = document.getElementById('chartTooltip');
  if (tt) {
    tt.classList.remove('visible');
    tt.setAttribute('aria-hidden', 'true');
  }
  priceCanvas.style.cursor = state.isPanningChart ? 'grabbing' : 'crosshair';
}

function _showTooltipForHit(hit, mouseX, mouseY) {
  const tt = document.getElementById('chartTooltip');
  if (!tt) return;
  let info, meta;
  if (hit.kind === 'event') {
    info = TOOLTIP_INFO[hit.payload.type];
    if (!info) return;
    const dirTag = hit.payload.dir ? ` · ${hit.payload.dir.toUpperCase()}` : '';
    meta = `@ ${(hit.payload.price ?? 0).toFixed(2)}${dirTag}`;
  } else if (hit.kind === 'fire') {
    info = TOOLTIP_INFO[hit.payload.watchId];
    if (!info) return;
    const dirTag = hit.payload.direction ? ` · ${hit.payload.direction.toUpperCase()}` : '';
    meta = `@ ${(hit.payload.price ?? 0).toFixed(2)}${dirTag}`;
  } else if (hit.kind === 'bias') {
    // Phase 6: bias-ribbon hover. Build a minimal info shim — there's no
    // entry in TOOLTIP_INFO because biases aren't first-class events.
    const biasLabel = hit.payload.bias || 'NEUTRAL';
    info = {
      variant: 'absorption',
      glyph:   '◆',
      name:    `${hit.payload.strip} bias`,
      desc:    `${biasLabel.replace(/_/g, ' ')} — Wyckoffian regime read on the higher timeframe.`,
    };
    meta = biasLabel;
  } else {
    return;
  }

  // Reset variant classes, then apply the matching one.
  tt.className = 'chart-tooltip visible variant-' + info.variant;
  tt.setAttribute('aria-hidden', 'false');
  tt.innerHTML =
    `<div class="tt-head">` +
      `<span class="tt-glyph">${info.glyph}</span>` +
      `<span class="tt-name">${info.name}</span>` +
      `<span class="tt-meta">${meta}</span>` +
    `</div>` +
    `<div class="tt-desc">${info.desc}</div>` +
    `<div class="tt-hint">click marker for full breakdown</div>`;

  // Position: prefer right-of-cursor; flip if it would clip the chart.
  const wrap = priceCanvas.parentElement.getBoundingClientRect();
  const ttW = tt.offsetWidth || 220;
  const ttH = tt.offsetHeight || 60;
  let left = mouseX + 14;
  let top  = mouseY + 14;
  if (left + ttW > wrap.width - 4)  left = mouseX - ttW - 14;
  if (top + ttH > wrap.height - 4)  top  = mouseY - ttH - 14;
  if (left < 4) left = 4;
  if (top < 4)  top  = 4;
  tt.style.left = left + 'px';
  tt.style.top  = top  + 'px';
  tt.style.transform = 'none';
  priceCanvas.style.cursor = 'pointer';
}

function _refreshTooltipFromLastMouse() {
  if (!_lastMouse) return;
  const hit = _hitTestChart(_lastMouse.x, _lastMouse.y);
  if (hit) _showTooltipForHit(hit, _lastMouse.x, _lastMouse.y);
  else     _hideTooltip();
}

let _lastMouse = null;   // {x, y} CSS-pixel coords inside the canvas





priceCanvas.addEventListener('mousemove', (e) => {
  const rect = priceCanvas.getBoundingClientRect();
  _lastMouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  // If we're actively click-dragging a pan, suppress the tooltip — pan UX wins.
  if (state.isPanningChart) {
    _continuePan(e);
    _hideTooltip();
    return;
  }
  const hit = _hitTestChart(_lastMouse.x, _lastMouse.y);
  if (hit) _showTooltipForHit(hit, _lastMouse.x, _lastMouse.y);
  else     _hideTooltip();
});
priceCanvas.addEventListener('mouseleave', () => {
  _lastMouse = null;
  _hideTooltip();
});
priceCanvas.addEventListener('click', (e) => {
  // Suppress click handling if this was the tail of a drag-pan.
  if (consumePanMoved()) return;
  const rect = priceCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const hit = _hitTestChart(x, y);

  // Click in empty chart space (no event/fire/bias hit) clears any
  // active brush selection. This is the natural reset gesture — much
  // more discoverable than the previous matrix-empty-area click or the
  // event-log ✕ button — and undoes the dim/desaturated tint applied
  // by drawPriceChart() when state.selection.kind !== null.
  if (!hit) {
    if (state.selection.kind !== null) clearSelection();
    return;
  }
  if (hit.kind === 'event') {
    openModal(hit.payload.type);
  } else if (hit.kind === 'fire') {
    // Plan §4c-d: clicking a fire halo brushes the fire-window (fire bar
    // + next 30) into the selection. Shift-click preserves the legacy
    // modal-open behavior so users can still inspect the canonical
    // breakdown without going through the fire banner. The fire banner's
    // Details button continues to open the modal directly.
    //
    // Toggle behavior: clicking the *same* fire halo while it's already
    // the active selection clears it, matching the same-cell-click-clears
    // convention in selectCell(). Without this the only ways to undo
    // a fire-halo brush were Esc / event-log ✕ / clicking outside the
    // halo, none of which are obvious from the chart alone.
    if (e.shiftKey) {
      openModal(hit.payload.watchId);
      return;
    }
    const sel = state.selection;
    const fireMs = hit.payload.barTime instanceof Date
      ? hit.payload.barTime.getTime()
      : Date.parse(hit.payload.barTime);
    if (sel.kind === 'fire' && sel.fireBarTime === fireMs) {
      clearSelection();
    } else {
      selectFire(hit.payload);
    }
  }
  // hit.kind === 'bias' falls through intentionally — bias-ribbon hovers
  // are informational only, no click action.
});

// ───────────────────────────────────────────────────────────

export { TOOLTIP_INFO, _hitTestChart, _hideTooltip, _showTooltipForHit, _refreshTooltipFromLastMouse };
