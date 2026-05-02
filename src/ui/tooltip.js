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
  const _phatTemplate = (shape, hasRejection, neutralReason) => {
    if (shape === 'P') {
      return hasRejection
        ? {
          line1: 'P-shape · Buyers pressed the upper half',
          line3: 'Buy pressure held through a wick test at the extreme',
        }
        : {
          line1: 'P-shape · Buyers pressed the upper half',
          line3: 'Buy pressure dominated the body, but no wick-level rejection detected',
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
          line3: 'Sell pressure dominated the body, but no wick-level rejection detected',
        };
    }
    if (neutralReason === 'below_gate') {
      return hasRejection
        ? {
          line1: 'Neutral body · Imbalance below P/b gate',
          line3: 'Auction tested one side at the wick; flow stayed mixed inside the bar',
        }
        : {
          line1: 'Neutral body · Imbalance below P/b gate',
          line3: 'No directional split · flow stayed inside the gate for this bar',
        };
    }
    if (neutralReason === 'disagreement') {
      return hasRejection
        ? {
          line1: 'Neutral body · Flow vs close disagree',
          line3: 'High imbalance but norms oppose bar direction; wick still shows a rejection read',
        }
        : {
          line1: 'Neutral body · Flow vs close disagree',
          line3: 'High imbalance fighting bar direction — body locks to neutral classification when flow opposes price',
        };
    }
    if (neutralReason === 'no_norms') {
      return {
        line1: 'Neutral body · CVD norms unavailable',
        line3: 'Top/bottom norm fields missing — P/b shading unavailable on this bar',
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

  const _phatVolThird = (volNorm) => {
    if (!Number.isFinite(volNorm)) return '—';
    if (volNorm < 1 / 3) return 'lower third';
    if (volNorm < 2 / 3) return 'middle third';
    return 'upper third';
  };

  const _phatImbalanceBandLabel = (I, G) => {
    if (!Number.isFinite(I) || !Number.isFinite(G)) return '';
    if (G >= 0.5) return I < G ? 'below gate' : 'at or above gate';
    if (I < G) return 'below gate';
    if (I < 0.5) return 'near gate';
    return 'strong';
  };

  const _phatEsc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  /** Compact scan-friendly title (notes.txt hierarchy). */
  const _phatCompactHead = (p, narrowLabel) => {
    const nb = narrowLabel;
    if (p.shape === 'P') return `P-SHAPE · UPPER HALF · ${nb}`;
    if (p.shape === 'b') return `B-SHAPE · LOWER HALF · ${nb}`;
    if (p.shape === 'neutral') {
      if (p.neutralReason === 'below_gate') return `NEUTRAL · Below P/b gate · ${nb}`;
      if (p.neutralReason === 'disagreement') return `NEUTRAL · Flow vs close · ${nb}`;
      if (p.neutralReason === 'no_norms') return `NEUTRAL · Norms unavailable · ${nb}`;
      return `NEUTRAL · ${nb}`;
    }
    return `${p.shapeLabel || 'PHAT'} · ${nb}`;
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
    const showRejRingsUi = !!state.phatShowWickRejectionRings;
    const tpl = _phatTemplate(p.shape, !!p.rejection?.hasRejection && showRejRingsUi, p.neutralReason);
    const narrowLabel = p.layout?.narrowBody ? 'Narrow body (≤1 tick)' : 'Wide body (>1 tick)';
    const headName = _phatCompactHead(p, narrowLabel);
    const G = Number.isFinite(p.gate) ? p.gate : (Number(state.phatBodyImbalanceThreshold) || 0.30);
    const I = p.imbalance;
    const band = _phatImbalanceBandLabel(I, G);
    const imbNum = Number.isFinite(I) ? I.toFixed(2) : '—';
    const imbMeta = Number.isFinite(I) && band
      ? `${band} (gate ${G.toFixed(2)})`
      : (Number.isFinite(I) ? `gate ${G.toFixed(2)}` : '');
    const vn = p.layout?.volNorm;
    const volThird = _phatVolThird(vn);
    const d = p.delta;
    const deltaNum = Number.isFinite(d) ? String(Math.round(d)) : '—';
    const deltaMeta = typeof p.isUp === 'boolean'
      ? `scatter ${p.isUp ? 'green' : 'red'} · matches chart OHLC`
      : 'scatter hue —';
    const rj = p.rejection;

    let rejPrimary = '';
    let rejSub = '';
    if (showRejRingsUi && rj?.hasRejection) {
      const thrEx = Number(state.phatExhaustionRingLiquidityThreshold);
      const thrStr = Number.isFinite(thrEx) ? thrEx.toFixed(2) : '0.55';
      const sideShort = rj.rejectionSide === 'high' ? 'Upper wick' : 'Lower wick';
      const typeShort = rj.rejectionType === 'absorption'
        ? 'absorption'
        : (rj.rejectionType === 'exhaustion' ? 'exhaustion' : 'rejection');
      const ringShort = p.rejectionRingFilled ? 'filled ring' : 'open ring';
      rejPrimary = `${sideShort} · ${typeShort} · ${ringShort}`;
      const liqTxt = Number.isFinite(rj.sideLiquidity) ? rj.sideLiquidity.toFixed(2) : 'n/a';
      const st = rj.strengthLabel || 'weak';
      const wtk = p.rejectionSideWickTicks;
      const spanTxt = Number.isFinite(wtk)
        ? ` · Wick span ${wtk} tick${wtk === 1 ? '' : 's'} (rejection side)`
        : '';
      if (rj.rejectionType === 'absorption') {
        rejSub = `Liquidity ${liqTxt}${spanTxt} · ${st}`;
      } else if (p.rejectionRingFilled) {
        rejSub = `Liquidity ${liqTxt}${spanTxt} (≥ ${thrStr} fill threshold) · ${st}`;
      } else {
        rejSub = `Liquidity ${liqTxt}${spanTxt} (below ${thrStr} fill threshold) · ${st}`;
      }
    }

    const kvCore = ''
      + `<div class="tt-phat-kv-row">`
      + `<span class="tt-phat-kv-label">Vol. (view)</span>`
      + `<span class="tt-phat-kv-num">${_phatEsc(volThird)}</span>`
      + `<span class="tt-phat-kv-meta"></span></div>`
      + `<div class="tt-phat-kv-row">`
      + `<span class="tt-phat-kv-label">Imbalance</span>`
      + `<span class="tt-phat-kv-num">${_phatEsc(imbNum)}</span>`
      + `<span class="tt-phat-kv-meta">${_phatEsc(imbMeta)}</span></div>`
      + `<div class="tt-phat-kv-row">`
      + `<span class="tt-phat-kv-label">Delta</span>`
      + `<span class="tt-phat-kv-num">${_phatEsc(deltaNum)}</span>`
      + `<span class="tt-phat-kv-meta">${_phatEsc(deltaMeta)}</span></div>`;

    let rejHtml = '';
    if (showRejRingsUi && rj?.hasRejection) {
      rejHtml = `<div class="tt-phat-kv-row">`
        + `<span class="tt-phat-kv-label">Rejection</span>`
        + `<span class="tt-phat-kv-num"></span>`
        + `<div class="tt-phat-kv-meta tt-phat-kv-meta--stack">`
        + `<span>${_phatEsc(rejPrimary)}</span>`
        + `<span class="tt-phat-kv-rej-sub">${_phatEsc(rejSub)}</span>`
        + `</div></div>`;
    } else {
      rejHtml = `<div class="tt-phat-kv-row">`
        + `<span class="tt-phat-kv-label">Rejection</span>`
        + `<span class="tt-phat-kv-num">—</span>`
        + `<span class="tt-phat-kv-meta">none</span></div>`;
    }

    const warnHtml = p.disagreementFlag
      ? '<div class="tt-phat-warn">⚠ High imbalance opposes bar direction — neutral body when flow conflicts with price</div>'
      : '';

    const kvHtml = `<div class="tt-phat-kv">${kvCore}${rejHtml}</div>`;

    info = {
      variant: 'breakout',
      glyph: '▌',
      name: headName,
      desc: '',
      detail: '',
      _phatHtml: ''
        + `<div class="tt-head">`
        + `<span class="tt-glyph">▌</span>`
        + `<span class="tt-name">${_phatEsc(headName)}</span>`
        + `<span class="tt-meta">${_phatEsc(p.shapeLabel || 'PHAT')}</span>`
        + `</div>`
        + `<p class="tt-phat-lede">“${_phatEsc(tpl.line3)}”</p>`
        + warnHtml
        + kvHtml
        + `<div class="tt-hint tt-phat-disclaimer">PHAT read is descriptive, not predictive</div>`,
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
    ? ''
    : hit.kind === 'candle'
      ? 'Click to highlight on regime matrix'
      : 'Shift+click for at-fire criteria · click to select bar range';
  if (hit.kind === 'phatCandle' && info._phatHtml) {
    tt.innerHTML = info._phatHtml;
  } else {
    tt.innerHTML =
      `<div class="tt-head">` +
        `<span class="tt-glyph">${info.glyph}</span>` +
        `<span class="tt-name">${info.name}</span>` +
        `<span class="tt-meta">${meta}</span>` +
      `</div>` +
      `<div class="tt-desc">${info.desc}</div>` +
      `${info.detail ? `<div class="tt-desc">${info.detail}</div>` : ''}` +
      `<div class="tt-hint">${hint}</div>`;
  }

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
