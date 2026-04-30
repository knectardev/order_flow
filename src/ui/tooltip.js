import { state } from '../state.js';
import { _continuePan, consumePanMoved } from './pan.js';
import { openModal } from './modal.js';
import { selectFire, selectBar, hoverBar, clearSelection } from './selection.js';
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
  absorptionWall: { name: 'Absorption Wall', glyph: '🛡', variant: 'absorption-wall',
                desc: '5/5: Stacked book + high vol, stalled/energy bar, vol vs prior-10 avg, level vs VA/POC/VWAP, HTF align. 🛡 at high (up bar) or low (down bar).' },
  valueEdgeReject: { name: 'Value Edge Rejection', glyph: '🎯', variant: 'value-edge',
                desc: '5/5: middle regime, failed VAH/VAL (high/low probe, close in VA), rejection wick, normal vol band, HTF not opposing MR toward POC.' },
};

function _hitTestChart(x, y) {
  const _contains = (hit) => {
    if (hit.hitShape === 'rect') {
      return x >= hit.x0 && x <= hit.x1 && y >= hit.y0 && y <= hit.y1;
    }
    const dx = x - hit.x;
    const dy = y - hit.y;
    return (dx * dx + dy * dy) <= hit.r * hit.r;
  };
  const _priority = (hit) => {
    if (hit.kind === 'event' || hit.kind === 'fire' || hit.kind === 'bias') return 2;
    if (hit.kind === 'phatCandle' || hit.kind === 'candle') return 1;
    return 0;
  };
  let best = null;
  let bestD2 = Infinity;
  let bestPriority = -1;
  for (const hit of state.chartHits) {
    if (!_contains(hit)) continue;
    const dx = x - hit.x;
    const dy = y - hit.y;
    const d2 = dx * dx + dy * dy;
    const pri = _priority(hit);
    if (pri > bestPriority || (pri === bestPriority && d2 < bestD2)) {
      best = hit;
      bestD2 = d2;
      bestPriority = pri;
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
  const _phatRejectionLabel = (r) => {
    if (!r?.hasRejection) return 'None';
    const typeLabel = r.rejectionType === 'absorption'
      ? 'Absorption'
      : (r.rejectionType === 'exhaustion' ? 'Exhaustion' : 'Rejection');
    const strengthLabel = r.strengthLabel || 'weak';
    return `${typeLabel} (${strengthLabel})`;
  };
  const _phatTemplate = (shape, hasRejection) => {
    if (shape === 'P') {
      return hasRejection
        ? {
          line1: 'P-shape · Buyers pressed the upper half',
          line3: 'Buy pressure held through a wick test at the extreme',
        }
        : {
          line1: 'P-shape · Buyers pressed the upper half',
          line3: 'Buy pressure dominated the body, but no wick-level rejection printed',
        };
    }
    if (shape === 'b') {
      return hasRejection
        ? {
          line1: 'b-shape · Sellers pressed the lower half',
          line3: 'Sell pressure held through a wick test at the extreme',
        }
        : {
          line1: 'b-shape · Sellers pressed the lower half',
          line3: 'Sell pressure dominated the body, but no wick-level rejection printed',
        };
    }
    return hasRejection
      ? {
        line1: 'Neutral body · Inside flow is balanced, wick shows response',
        line3: 'Auction tested one side and met liquidity at the wick',
      }
      : {
        line1: 'Neutral body · Flow is balanced across the bar',
        line3: 'No strong side showed control inside this candle',
      };
  };
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
  } else if (hit.kind === 'phatCandle') {
    const p = hit.payload || {};
    const imbalanceText = Number.isFinite(p.imbalance) ? p.imbalance.toFixed(2) : 'n/a';
    const rejectionText = _phatRejectionLabel(p.rejection);
    const tpl = _phatTemplate(p.shape, !!p.rejection?.hasRejection);
    info = {
      variant: 'breakout',
      glyph: '▌',
      name: tpl.line1,
      desc: `Imbalance: ${imbalanceText} · Rejection: ${rejectionText}`,
      detail: tpl.line3,
    };
    meta = p.shapeLabel || 'PHAT';
  } else if (hit.kind === 'candle') {
    const p = hit.payload || {};
    const up = p.isUp !== false;
    info = {
      variant: up ? 'sweep' : 'stop',
      glyph: up ? '▲' : '▼',
      name: up ? 'Bull bar (close ≥ open)' : 'Bear bar (close < open)',
      desc: `O ${Number(p.open).toFixed(2)} · H ${Number(p.high).toFixed(2)} · L ${Number(p.low).toFixed(2)} · C ${Number(p.close).toFixed(2)}`,
    };
    meta = 'OHLC';
  } else {
    return;
  }

  // Reset variant classes, then apply the matching one.
  tt.className = 'chart-tooltip visible variant-' + info.variant;
  tt.setAttribute('aria-hidden', 'false');
  const hint = hit.kind === 'phatCandle'
    ? 'PHAT read is descriptive, not predictive'
    : hit.kind === 'candle'
      ? 'Click to highlight on regime matrix'
      : 'Shift+click for at-fire criteria · click to select bar range';
  tt.innerHTML =
    `<div class="tt-head">` +
      `<span class="tt-glyph">${info.glyph}</span>` +
      `<span class="tt-name">${info.name}</span>` +
      `<span class="tt-meta">${meta}</span>` +
    `</div>` +
    `<div class="tt-desc">${info.desc}</div>` +
    `${info.detail ? `<div class="tt-desc">${info.detail}</div>` : ''}` +
    `<div class="tt-hint">${hint}</div>`;

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
    hoverBar(null, 'chart-pan');
    _hideTooltip();
    return;
  }
  const hit = _hitTestChart(_lastMouse.x, _lastMouse.y);
  const hoverMs = (hit && (hit.kind === 'phatCandle' || hit.kind === 'candle'))
    ? Number(hit.payload?.barTimeMs)
    : null;
  hoverBar(hoverMs, 'chart-hover');
  if (hit && (hit.kind === 'event' || hit.kind === 'fire' || hit.kind === 'bias' || hit.kind === 'phatCandle' || hit.kind === 'candle')) {
    _showTooltipForHit(hit, _lastMouse.x, _lastMouse.y);
  } else {
    _hideTooltip();
  }
});
priceCanvas.addEventListener('mouseleave', () => {
  _lastMouse = null;
  hoverBar(null, 'chart-leave');
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
      // Pass the log row so the watch modal can show the gate snapshot
      // from the fire bar, not the current live bar.
      openModal(hit.payload.watchId, { fire: hit.payload });
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
  } else if (hit.kind === 'phatCandle' || hit.kind === 'candle') {
    const barMs = Number(hit.payload?.barTimeMs);
    if (Number.isFinite(barMs)) {
      selectBar(barMs, 'chart-click');
    }
  }
  // hit.kind === 'bias' falls through intentionally — bias-ribbon hovers
  // are informational only, no click action.
});

// ───────────────────────────────────────────────────────────

export { TOOLTIP_INFO, _hitTestChart, _hideTooltip, _showTooltipForHit, _refreshTooltipFromLastMouse };
