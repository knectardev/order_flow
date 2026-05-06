import { state } from '../state.js';

/** Notes.txt 3×3: rows Low→High jitter, cols Low→High conviction → cells 1–9. */
function _velocityMatrixCellFromRegimes(jitterRegime, convictionRegime) {
  const jMap = { Low: 0, Mid: 1, High: 2 };
  const cMap = { Low: 0, Mid: 1, High: 2 };
  const jr = jMap[String(jitterRegime ?? '')];
  const cr = cMap[String(convictionRegime ?? '')];
  if (jr === undefined || cr === undefined) return null;
  return jr * 3 + cr + 1;
}

function _velocityTooltipExtraHtml(p, esc) {
  const rows = [];
  let matrixHtml = '';
  if (Number.isFinite(Number(p.pldRatio))) {
    rows.push(`PLD ratio: ${Number(p.pldRatio).toFixed(6)}`);
  } else if (p.pldRatio != null && p.pldRatio !== '') {
    rows.push(`PLD ratio: ${esc(String(p.pldRatio))}`);
  }
  if (Number.isFinite(Number(p.flipRate))) {
    rows.push(`Flip rate: ${Number(p.flipRate).toFixed(6)}`);
  } else if (p.flipRate != null && p.flipRate !== '') {
    rows.push(`Flip rate: ${esc(String(p.flipRate))}`);
  }
  if (p.jitterRegime != null && p.jitterRegime !== '') {
    rows.push(`Jitter regime: ${esc(String(p.jitterRegime))}`);
  }
  if (p.convictionRegime != null && p.convictionRegime !== '') {
    rows.push(`Conviction regime: ${esc(String(p.convictionRegime))}`);
  }
  if (p.tradeContext != null && p.tradeContext !== '') {
    rows.push(`Trade context: ${esc(String(p.tradeContext))}`);
  }
  if (state.chartOverlayVisibility?.velocityMatrixDev === true) {
    const cell = _velocityMatrixCellFromRegimes(p.jitterRegime, p.convictionRegime);
    if (cell != null) {
      rows.push(`Matrix cell (dev): ${cell}`);
      const rowIdx = Math.floor((cell - 1) / 3);
      const colIdx = (cell - 1) % 3;
      const labels = ['Low', 'Mid', 'High'];
      matrixHtml =
        `<div class="tt-velocity-matrix-wrap">`
        + `<div class="tt-velocity-matrix-head">Dev matrix view</div>`
        + `<div class="tt-velocity-matrix-grid">`
        + [0, 1, 2].map((r) =>
          [0, 1, 2].map((c) => {
            const n = r * 3 + c + 1;
            const active = r === rowIdx && c === colIdx;
            return `<div class="tt-velocity-cell${active ? ' is-active' : ''}">${n}</div>`;
          }).join(''),
        ).join('')
        + `</div>`
        + `<div class="tt-velocity-matrix-meta">`
        + `jitter=${labels[rowIdx]} · conviction=${labels[colIdx]}`
        + `</div>`
        + `</div>`;
    }
  }
  if (!rows.length) return '';
  return `<div class="tt-desc tt-velocity">${rows.map(r => `<div>${r}</div>`).join('')}${matrixHtml}</div>`;
}
import { _continuePan, consumePanMoved, _continuePlayheadDrag, nearPriceChartPlayhead } from './pan.js';
import { openModal } from './modal.js';
import { selectFire, selectBar, hoverBar, clearSelection } from './selection.js';
import { priceCanvas, flowCanvas, cvdCanvas } from '../util/dom.js';
import { barTimeMsFromSubchartX } from '../render/subchartHit.js';

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

function _distSqPointToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) {
    const ux = px - x0;
    const uy = py - y0;
    return ux * ux + uy * uy;
  }
  let t = ((px - x0) * dx + (py - y0) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = x0 + t * dx;
  const qy = y0 + t * dy;
  const ux = px - qx;
  const uy = py - qy;
  return ux * ux + uy * uy;
}

/** Bars whose `bar_time_ms` falls in [earlierTime, laterTime] of a loaded divergence row. */
function _divergenceSpansForBarMs(btMs) {
  if (state.replay.mode !== 'real' || !Number.isFinite(btMs) || !state.replay.allDivergences?.length) return [];
  return state.replay.allDivergences.filter((d) => {
    const t0 = Date.parse(d.earlierTime);
    const t1 = Date.parse(d.laterTime);
    return btMs >= Math.min(t0, t1) && btMs <= Math.max(t0, t1);
  });
}

function _divergenceDetailLines(d) {
  const dP = Number(d.laterPrice) - Number(d.earlierPrice);
  const dC = Number(d.laterCvd) - Number(d.earlierCvd);
  const pTxt = Number.isFinite(dP) ? `${dP >= 0 ? '+' : ''}${dP.toFixed(2)} pts` : 'Δprice —';
  const cTxt = Number.isFinite(dC) ? `${dC >= 0 ? '+' : ''}${Math.round(dC).toLocaleString()} session CVD` : 'Δsession CVD —';
  const kind = String(d.kind || '—');
  const bars = d.barsBetween != null ? String(d.barsBetween) : '—';
  const conf = d.sizeConfirmation === true ? 'yes' : (d.sizeConfirmation === false ? 'no' : String(d.sizeConfirmation));
  return [
    `${kind} · ${pTxt} · ${cTxt}`,
    `Bars between swing anchors: ${bars} · Size confirmation: ${conf}`,
  ];
}

function _hitTestChart(x, y) {
  const _dist2ForHit = (hit) => {
    if (hit.hitShape === 'rect') {
      if (!(x >= hit.x0 && x <= hit.x1 && y >= hit.y0 && y <= hit.y1)) return null;
      const dx = x - hit.x;
      const dy = y - hit.y;
      return dx * dx + dy * dy;
    }
    if (hit.hitShape === 'segment') {
      const d2 = _distSqPointToSegment(x, y, hit.x0, hit.y0, hit.x1, hit.y1);
      const pad = hit.padPx ?? 10;
      if (d2 > pad * pad) return null;
      return d2;
    }
    const dx = x - hit.x;
    const dy = y - hit.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > hit.r * hit.r) return null;
    return d2;
  };
  const _priority = (hit) => {
    if (hit.kind === 'event' || hit.kind === 'fire' || hit.kind === 'bias') return 2;
    if (hit.kind === 'priceSwing') return 1.5;
    if (hit.kind === 'divergenceSegment') return 1.45;
    if (hit.kind === 'regimeLaneJitter') return 1.38;
    if (hit.kind === 'phatCandle' || hit.kind === 'candle') return 1;
    return 0;
  };
  let best = null;
  let bestD2 = Infinity;
  let bestPriority = -1;
  for (const hit of state.chartHits) {
    const d2 = _dist2ForHit(hit);
    if (d2 == null) continue;
    const pri = _priority(hit);
    if (pri > bestPriority || (pri === bestPriority && d2 < bestD2)) {
      best = hit;
      bestD2 = d2;
      bestPriority = pri;
    }
  }
  return best;
}

function _pickCvdDivergenceHit(x, y) {
  const hits = state.cvdDivergenceHits || [];
  let best = null;
  let bestD2 = Infinity;
  for (const h of hits) {
    const d2 = _distSqPointToSegment(x, y, h.x0, h.y0, h.x1, h.y1);
    const pad = h.padPx ?? 10;
    if (d2 <= pad * pad && d2 < bestD2) {
      best = h;
      bestD2 = d2;
    }
  }
  return best;
}

function _pickCvdSwingHit(x, y) {
  const hits = state.cvdSwingHits || [];
  let best = null;
  let bestD2 = Infinity;
  for (const h of hits) {
    const dx = x - h.x;
    const dy = y - h.y;
    const d2 = dx * dx + dy * dy;
    const r = h.r ?? 10;
    if (d2 <= r * r && d2 < bestD2) {
      best = h;
      bestD2 = d2;
    }
  }
  return best;
}

function _hideTooltip() {
  const tt = document.getElementById('chartTooltip');
  if (tt) {
    tt.classList.remove('visible');
    tt.setAttribute('aria-hidden', 'true');
    tt.style.position = '';
    tt.style.left = '';
    tt.style.top = '';
    tt.style.transform = '';
  }
  if (cvdCanvas) cvdCanvas.style.cursor = 'crosshair';
  priceCanvas.style.cursor = state.isPanningChart ? 'grabbing' : 'crosshair';
}

function _showTooltipForHit(hit, mouseX, mouseY, opts = {}) {
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
    const velPhatHtml = _velocityTooltipExtraHtml(p, _phatEsc);

    const btPhat = Number(p.barTimeMs);
    const divSpansPhat = _divergenceSpansForBarMs(btPhat);
    let divPhatHtml = '';
    if (divSpansPhat.length) {
      const blocks = divSpansPhat.map((dv) => {
        const lines = _divergenceDetailLines(dv);
        return '<div class="tt-phat-div-block">'
          + lines.map(ln => `<div class="tt-desc">${_phatEsc(ln)}</div>`).join('')
          + '</div>';
      }).join('');
      divPhatHtml = `<div class="tt-desc tt-phat-div-wrap"><strong>In CVD divergence span</strong> (pipeline)${blocks}</div>`;
    }

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
        + velPhatHtml
        + divPhatHtml
        + `<div class="tt-hint tt-phat-disclaimer">PHAT read is descriptive, not predictive</div>`,
    };
    meta = p.shapeLabel || 'PHAT';
  } else if (hit.kind === 'priceSwing' || hit.kind === 'cvdSwing') {
    const p = hit.payload || {};
    const st = p.seriesType || '';
    const K = Number(p.swingLookback);
    const kDisp = Number.isFinite(K) ? K : (Number(state.replay.swingLookbackDisplay) || null);
    const kStr = kDisp != null ? String(kDisp) : 'K';
    const isHigh = st === 'cvd_high' || st === 'price_high';
    const onCvd = st.startsWith('cvd_');
    const name = onCvd
      ? (isHigh ? 'Session CVD swing high' : 'Session CVD swing low')
      : (isHigh ? 'Price swing high' : 'Price swing low');
    const desc = onCvd
      ? (isHigh
        ? `Local maximum on session cumulative delta: no higher CVD within ${kStr} bars on each side where that window exists. Down-triangle marks this bar; divergence lines pair it with a matching price pivot when ingest rules pass.`
        : `Local minimum on session cumulative delta with the same ${kStr}-bar fractal rule (up-triangle).`)
      : (isHigh
        ? `Local maximum on trade price: this bar’s high is ≥ the highs of the ${kStr} bars on each side where the window exists.`
        : `Local minimum on trade price: this bar’s low is ≤ the lows of the ${kStr} bars on each side where the window exists.`);
    const valLine = onCvd
      ? `Session CVD at bar: ${Number.isFinite(Number(p.swingValue)) ? Math.round(Number(p.swingValue)).toLocaleString() : '—'}`
      : (() => {
        const hStr = Number.isFinite(Number(p.high)) ? Number(p.high).toFixed(2) : '—';
        const lStr = Number.isFinite(Number(p.low)) ? Number(p.low).toFixed(2) : '—';
        return `Bar H ${hStr} · L ${lStr}`;
      })();
    const bt = Number(p.barTimeMs);
    const timeLabel = Number.isFinite(bt)
      ? new Date(bt).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }) + ' ET'
      : '—';
    info = {
      variant: 'diverge',
      glyph: isHigh ? '▼' : '▲',
      name,
      desc,
      detail: `${_phatEsc(valLine)}<br>${_phatEsc(timeLabel)}`,
    };
    meta = kDisp != null ? `K=${kDisp}` : 'K from ingest';
  } else if (hit.kind === 'divergenceSegment') {
    const d = hit.payload?.divergence || {};
    const panel = hit.payload?.panel === 'cvd' ? 'Session CVD panel' : 'Price chart';
    const lines = _divergenceDetailLines(d);
    info = {
      variant: 'diverge',
      glyph: '⚠',
      name: `CVD–price divergence (${String(d.kind || '—')})`,
      desc: `Persisted pipeline span on the ${panel} (earlier → later swing). Solid line = size confirmation; dashed = not.`,
      detail: lines.map(ln => _phatEsc(ln)).join('<br>'),
    };
    meta = 'divergence_events';
  } else if (hit.kind === 'regimeLaneJitter') {
    const p = hit.payload || {};
    const jr = p.jitterRegime;
    const jrDisp = jr != null && jr !== '' ? String(jr) : '—';
    let desc;
    if (jr === 'Low') {
      desc = 'Bottom third of trailing log(PLD ratio) for this session kind (up to ~200 prior bars). Price path vs displacement is relatively efficient compared with recent bars — less micro-chop.';
    } else if (jr === 'Mid') {
      desc = 'Middle third of that same trailing distribution — typical path-length vs displacement for this window.';
    } else if (jr === 'High') {
      desc = 'Top third — more cumulative path per net displacement; choppier microstructure vs recent same-session bars.';
    } else {
      desc = 'Not classified: missing/non-positive PLD ratio, insufficient history, or warmup (see ingest velocity_regime).';
    }
    const btLane = Number(p.barTimeMs);
    meta = Number.isFinite(btLane)
      ? new Date(btLane).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }) + ' ET'
      : '—';
    info = {
      variant: 'breakout',
      glyph: '▬',
      name: `Lane jitter · ${jrDisp}`,
      desc,
      _velocityHtml: _velocityTooltipExtraHtml(p, _phatEsc),
    };
  } else if (hit.kind === 'candle') {
    const p = hit.payload || {};
    const up = p.isUp !== false;
    const bt = Number(p.barTimeMs);
    let detail = '';
    const spans = _divergenceSpansForBarMs(bt);
    if (spans.length) {
      detail = spans.map((dv) =>
        _divergenceDetailLines(dv).map(ln => _phatEsc(ln)).join('<br>'),
      ).join('<br><br>');
    }
    info = {
      variant: up ? 'sweep' : 'stop',
      glyph: up ? '▲' : '▼',
      name: up ? 'Bull bar (close ≥ open)' : 'Bear bar (close < open)',
      desc: `O ${Number(p.open).toFixed(2)} · H ${Number(p.high).toFixed(2)} · L ${Number(p.low).toFixed(2)} · C ${Number(p.close).toFixed(2)}`,
      detail,
      _velocityHtml: _velocityTooltipExtraHtml(p, _phatEsc),
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
      : hit.kind === 'regimeLaneJitter'
        ? 'Click to highlight on regime matrix'
      : (hit.kind === 'priceSwing' || hit.kind === 'cvdSwing')
        ? 'Pipeline fractal (swing_events); K matches the Δ section header when uniform.'
        : hit.kind === 'divergenceSegment'
          ? 'Connector pairs CVD vs price fractal pivots from divergence_events.'
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
      `${info._velocityHtml ?? ''}` +
      `${info.detail ? `<div class="tt-desc">${info.detail}</div>` : ''}` +
      `<div class="tt-hint">${hint}</div>`;
  }

  // Position: price-wrap coords, or fixed viewport when hovering CVD (tooltip DOM lives under price-wrap).
  const ttW = tt.offsetWidth || 220;
  const ttH = tt.offsetHeight || 60;
  if (opts.useClientCoords) {
    tt.style.position = 'fixed';
    tt.style.transform = 'none';
    const pad = 14;
    let left = mouseX + pad;
    let top = mouseY + pad;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left + ttW > vw - 8) left = mouseX - ttW - pad;
    if (top + ttH > vh - 8) top = mouseY - ttH - pad;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    tt.style.left = `${left}px`;
    tt.style.top = `${top}px`;
    if (cvdCanvas) cvdCanvas.style.cursor = 'pointer';
    priceCanvas.style.cursor = 'crosshair';
  } else {
    tt.style.position = '';
    const wrap = priceCanvas.parentElement.getBoundingClientRect();
    let left = mouseX + 14;
    let top = mouseY + 14;
    if (left + ttW > wrap.width - 4) left = mouseX - ttW - 14;
    if (top + ttH > wrap.height - 4) top = mouseY - ttH - 14;
    if (left < 4) left = 4;
    if (top < 4) top = 4;
    tt.style.left = `${left}px`;
    tt.style.top = `${top}px`;
    tt.style.transform = 'none';
    priceCanvas.style.cursor = 'pointer';
  }
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
  // Pan wins over playhead if both flags were stuck — avoids blocking horizontal scrub after playhead drags.
  if (state.isPanningChart) {
    _continuePan(e);
    hoverBar(null, 'chart-pan');
    _hideTooltip();
    return;
  }
  if (state.isDraggingPlayhead) {
    _hideTooltip();
    return;
  }
  const hit = _hitTestChart(_lastMouse.x, _lastMouse.y);
  let hoverMs = null;
  if (hit && (hit.kind === 'phatCandle' || hit.kind === 'candle' || hit.kind === 'priceSwing' || hit.kind === 'regimeLaneJitter')) {
    hoverMs = Number(hit.payload?.barTimeMs);
  } else if (hit && hit.kind === 'divergenceSegment') {
    hoverMs = barTimeMsFromSubchartX(priceCanvas, _lastMouse.x);
  }
  hoverBar(Number.isFinite(hoverMs) ? hoverMs : null, 'chart-hover');
  if (hit && (hit.kind === 'event' || hit.kind === 'fire' || hit.kind === 'bias' || hit.kind === 'phatCandle' || hit.kind === 'candle' || hit.kind === 'priceSwing' || hit.kind === 'divergenceSegment' || hit.kind === 'regimeLaneJitter')) {
    _showTooltipForHit(hit, _lastMouse.x, _lastMouse.y);
  } else {
    _hideTooltip();
  }
  if (nearPriceChartPlayhead(_lastMouse.x, _lastMouse.y)) {
    priceCanvas.style.cursor = 'col-resize';
  }
});
document.addEventListener('mousemove', (e) => {
  if (!state.isDraggingPlayhead) return;
  _continuePlayheadDrag(e);
  hoverBar(null, 'chart-playhead');
  priceCanvas.style.cursor = 'col-resize';
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
  } else if (hit.kind === 'phatCandle' || hit.kind === 'candle' || hit.kind === 'priceSwing' || hit.kind === 'regimeLaneJitter') {
    const barMs = Number(hit.payload?.barTimeMs);
    if (Number.isFinite(barMs)) {
      selectBar(barMs, 'chart-click');
    }
  }
  // hit.kind === 'bias' falls through intentionally — bias-ribbon hovers
  // are informational only, no click action.
});

function _wireSubchartHover(canvas) {
  if (!canvas) return;
  canvas.addEventListener('mousemove', (e) => {
    if (state.isPanningChart) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ms = barTimeMsFromSubchartX(canvas, x);
    hoverBar(Number.isFinite(ms) ? ms : null, 'subchart-hover');
  });
  canvas.addEventListener('mouseleave', () => hoverBar(null, 'subchart-leave'));
}

_wireSubchartHover(flowCanvas);

function _wireCvdChartHover(canvas) {
  if (!canvas) return;
  canvas.addEventListener('mousemove', (e) => {
    if (state.isPanningChart) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const divH = _pickCvdDivergenceHit(x, y);
    if (divH) {
      const ms = barTimeMsFromSubchartX(canvas, x);
      hoverBar(Number.isFinite(ms) ? ms : null, 'cvd-div-hover');
      _showTooltipForHit({
        kind: 'divergenceSegment',
        payload: { divergence: divH.divergence, panel: 'cvd' },
      }, e.clientX, e.clientY, { useClientCoords: true });
      return;
    }
    const h = _pickCvdSwingHit(x, y);
    if (h) {
      hoverBar(Number(h.barTimeMs), 'cvd-swing-hover');
      _showTooltipForHit({
        kind: 'cvdSwing',
        payload: {
          seriesType: h.seriesType,
          swingValue: h.swingValue,
          barTimeMs: h.barTimeMs,
          swingLookback: h.swingLookback,
        },
      }, e.clientX, e.clientY, { useClientCoords: true });
    } else {
      const ms = barTimeMsFromSubchartX(canvas, x);
      hoverBar(Number.isFinite(ms) ? ms : null, 'subchart-hover');
      _hideTooltip();
    }
  });
  canvas.addEventListener('mouseleave', () => {
    hoverBar(null, 'subchart-leave');
    _hideTooltip();
  });
}

_wireCvdChartHover(cvdCanvas);

// ───────────────────────────────────────────────────────────

export { TOOLTIP_INFO, _hitTestChart, _hideTooltip, _showTooltipForHit, _refreshTooltipFromLastMouse };
