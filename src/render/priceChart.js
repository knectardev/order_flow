import {
  CHART_CANVAS_BG,
  CHART_CANDLE_DOWN,
  CHART_CANDLE_DOWN_RGB,
  CHART_CANDLE_UP,
  CHART_CANDLE_UP_RGB,
  DEFAULT_TIMEFRAME,
  ES_MIN_TICK,
  MAX_CHART_VISIBLE_BARS,
  MIN_CHART_VISIBLE_BARS,
} from '../config/constants.js';
import { state } from '../state.js';
import { computeProfile } from '../analytics/profile.js';
import { computeAnchoredVWAP, getVwapAnchors } from '../analytics/vwap.js';
import { getCachedProfile, hasResolvedProfile, requestProfile } from '../data/profileApi.js';
import { sessionForBar } from '../data/replay.js';
import { isBarSelected } from '../ui/selection.js';
import { _refreshTooltipFromLastMouse } from '../ui/tooltip.js';
import { pctx, priceCanvas, resizeCanvas } from '../util/dom.js';
import { clamp } from '../util/math.js';
import { drawBiasRibbon } from './biasRibbon.js';
import { computeViewportVolumeRange, volumeNorm01Linear } from '../analytics/viewportVolumeNorm.js';

function _candleUpRgba(a) {
  const [r, g, b] = CHART_CANDLE_UP_RGB;
  return `rgba(${r},${g},${b},${a})`;
}
function _candleDownRgba(a) {
  const [r, g, b] = CHART_CANDLE_DOWN_RGB;
  return `rgba(${r},${g},${b},${a})`;
}

/** X-axis and panned readout: US Eastern (RTH session wall clock, DST-aware). */
/**
 * Chart-only: min width as a fraction of tier `maxCap` for viewport volume → PHAT body width.
 * Raising compresses volume contrast (silhouettes look alike); lowering thins low-volume bodies (noisier, harder hit-test).
 */
const PHAT_WIDTH_VOLUME_MIN_CAP_FRAC = 0.20;

const CHART_AXIS_TZ = 'America/New_York';
const _fmtEtClock12 = new Intl.DateTimeFormat('en-US', {
  timeZone: CHART_AXIS_TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const _fmtEtMonthDay = new Intl.DateTimeFormat('en-US', {
  timeZone: CHART_AXIS_TZ,
  month: 'short',
  day: '2-digit',
});
const _fmtEtYmdParts = new Intl.DateTimeFormat('en-US', {
  timeZone: CHART_AXIS_TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

// Format a Date (or epoch-ms number) as an ISO-8601 timestamp with a Z
// suffix for the /profile endpoint. We keep millisecond precision because
// the API matches against `bar_time TIMESTAMP` columns at second
// granularity but accepts fractional input — using full ISO keeps the
// cache keys stable across re-renders that produce identical Date objects.
function _isoZ(t) {
  if (t == null) return '';
  return (t instanceof Date) ? t.toISOString() : new Date(t).toISOString();
}

function _barTimeMs(t) {
  if (t == null) return NaN;
  return t instanceof Date ? t.getTime() : +new Date(t);
}

/** [y,m,d] in America/New_York for grouping tick labels across session-calendar days */
function _etYmd(barTime) {
  const d = barTime instanceof Date ? barTime : new Date(barTime);
  const parts = _fmtEtYmdParts.formatToParts(d);
  let y = 0;
  let m = 0;
  let day = 0;
  for (const p of parts) {
    if (p.type === 'year') y = +p.value;
    if (p.type === 'month') m = +p.value - 1;
    if (p.type === 'day') day = +p.value;
  }
  return [y, m, day];
}

function _sameEtYmd(a, b) {
  const [ya, ma, da] = _etYmd(a);
  const [yb, mb, db] = _etYmd(b);
  return ya === yb && ma === mb && da === db;
}

/**
 * Visible window spans more than one Eastern calendar day (any adjacent pair).
 */
function _viewportSpansMultipleEtDays(bars) {
  if (!bars || bars.length < 2) return false;
  for (let i = 1; i < bars.length; i++) {
    if (!_sameEtYmd(bars[i - 1].time, bars[i].time)) return true;
  }
  return false;
}

/** 12-hour clock in Eastern time, e.g. "2:30 PM" (no suffix — add " ET" at axis layer). */
function _formatEtClock12(barTime) {
  const d = barTime instanceof Date ? barTime : new Date(barTime);
  return _fmtEtClock12.format(d);
}

/** One bottom-axis tick label; prefixes month/day after an ET calendar day change (multi-day viewports). */
function _bottomAxisTickText(bars, idx, prevTickIdx, multiDay) {
  const b = bars[idx];
  const d = b.time instanceof Date ? b.time : new Date(b.time);
  if (!multiDay) return `${_formatEtClock12(b.time)} ET`;
  const prevBar = prevTickIdx >= 0 ? bars[prevTickIdx] : null;
  if (!prevBar || !_sameEtYmd(prevBar.time, b.time)) {
    return `${_fmtEtMonthDay.format(d)} ${_formatEtClock12(b.time)} ET`;
  }
  return `${_formatEtClock12(b.time)} ET`;
}

/** Matches `catalogKeyFromPrimitiveEvent` in replay.js (keep in sync). */
function _glossaryKeyFromPrimitiveEvent(ev) {
  if (!ev) return '';
  if (ev.type === 'absorption') return 'absorption';
  const d = ev.dir ? ` ${ev.dir}` : '';
  return `${ev.type}${d}`;
}

/** API replay: halos only for watch IDs checked in Signals & glossary (synthetic ignores this). */
function _filterFiresByGlossary(fires) {
  if (state.replay.mode !== 'real') return fires;
  if (!state.activeCanonicalFireTypes?.size) return [];
  return fires.filter(f => f.watchId && state.activeCanonicalFireTypes.has(f.watchId));
}

/** Fire list for draw. In API mode, DuckDB /fires is the single source of truth. */
function _chartFireListForDraw(isPanned) {
  let merged;
  if (state.replay.mode !== 'real') merged = state.canonicalFires;
  else merged = state.replay.allFires;
  return _filterFiresByGlossary(merged);
}

// Anti-flicker carry-over for the right-side volume profile sidebar.
// During streaming, every `FORMING_STEPS`-th frame settles a new bar
// which shifts `state.bars` forward → both endpoints of the (from, to)
// window change → cache miss → without this carry-over we'd render the
// OHLC-proxy profile for the ~50 ms it takes the new /profile fetch to
// resolve. The proxy and API profiles have different bin counts and
// scales, so the visual swap reads as a black flash several times a
// second. Stashing the most-recent resolved API profile and reusing it
// on miss keeps the sidebar visually stable.
//
// Scoped to the active timeframe so a tf-switch doesn't show stale
// 1m bins under 1h candles. Cleared by setActiveTimeframe()'s
// clearProfileCache() call → handled below in the resolve path.
//
// Staleness guards: at 1m the chart's Y-range fits the profile's price
// extent, AND the value-area highlights drive how the user reads the
// session. Reusing a stale `_lastApiProfile` produces two distinct bugs:
//   1. Cross-session: profile from a far-away session compresses
//      candles into a thin band (e.g. POC stuck at 6848 while candles
//      stream at 6993).
//   2. Intra-session: profile resolved earlier in the same session,
//      before the candle range widened (open spike, late-session
//      run-up). The carry-over is fully *inside* the current candle
//      range but missing 30-50 points of price action, so the value
//      area highlights look anchored to a stale chop zone.
// `_isApiProfileCompatibleWith()` rejects both. It requires the
// carry-over to (a) overlap the candle range AND (b) cover most of it:
// the carry-over's price extent must reach within `tolerance` of both
// candleLo and candleHi. If the candle range has grown beyond that
// tolerance since the carry-over was resolved, the proxy fallback
// (which is computed fresh from the current `profileBars`) is used
// until the new API fetch lands.
//
// Tolerance was originally `candleRange * 0.05` (~0.5 ticks). That was
// too tight for a live-edge stream: every settled bar shifts the rolling
// 60-bar window's candleLo/candleHi by a tick or so, which is enough to
// flip the carry-over from "compatible → reuse" to "incompatible → fall
// back to OHLC proxy" on the very next frame. The proxy's POC differs
// from the tick-level API POC by 1-10 points (different methodologies),
// so the chart's POC line and the slack-fold y-range both jump per
// frame, producing a visible flicker during playback. Loosening the
// tolerance to half the candle range keeps the carry-over engaged
// across normal live-edge drift while still rejecting the actual stale
// cases (cross-session, large pan jumps).
let _lastApiProfile = null;
let _lastApiProfileTf = null;
let _lastApiProfileFromMs = NaN;
let _lastApiProfileToMs = NaN;
let _lastApiProfileSessionStartMs = NaN;
let _lastApiProfileSessionEndMs = NaN;
let _lastVpDebugSig = null;

const _profileDebug = (() => {
  try {
    return new URLSearchParams(window.location.search).get('profileDebug') === '1';
  } catch {
    return false;
  }
})();

function _logProfileDecision(payload) {
  if (!_profileDebug) return;
  // eslint-disable-next-line no-console
  console.debug('[orderflow][profile]', payload);
}

function _windowOverlapMs(aLo, aHi, bLo, bHi) {
  const lo = Math.max(aLo, bLo);
  const hi = Math.min(aHi, bHi);
  return Math.max(0, hi - lo);
}

function _logVpNormOnce(payload) {
  if (!_profileDebug) return;
  const sig = JSON.stringify(payload);
  if (sig === _lastVpDebugSig) return;
  _lastVpDebugSig = sig;
  // eslint-disable-next-line no-console
  console.debug('[orderflow][vp-norm]', payload);
}

// Profile-fold hysteresis state. The y-range fitter (in drawPriceChart)
// optionally folds POC/VAH/VAL/profileLo/profileHi into the candle-driven
// [lo, hi] when each price sits within `slack` of the candle range. The
// raw decision per frame oscillates whenever a price hovers near the
// slack boundary (one settled bar shifts candleRange enough to flip the
// inclusion test), causing a visible y-axis jump every other frame.
// Hysteresis replaces the single threshold with a Schmitt-trigger: once
// folded the price stays folded at a *looser* threshold, and once
// unfolded it must move well *inside* the tighter threshold to refold.
// Keyed by profile identity (binStep|priceLo|binCount) so we wipe state
// when the underlying profile changes (session boundary, pan jump,
// timeframe switch).
let _foldHysteresis = {
  pid: null,
  // booleans, persistent across frames within the same profile
  priceLo:  false,
  profileHi:false,
  valPrice: false,
  pocPrice: false,
  vahPrice: false,
};

function _resetFoldHysteresis(pid) {
  _foldHysteresis = {
    pid,
    priceLo:  false,
    profileHi:false,
    valPrice: false,
    pocPrice: false,
    vahPrice: false,
  };
}

function _profileIdentity(p) {
  if (!p) return null;
  return `${p.priceLo}|${p.binStep}|${p.bins?.length ?? 0}`;
}

/** Bar-time + direction keys where both a sweep and a divergence fire (same side). */
function _coSweepDivergePairKeySet(viewedEvents) {
  const byT = new Map();
  for (const ev of viewedEvents) {
    const t = ev.time instanceof Date ? ev.time.getTime() : Date.parse(String(ev.time));
    if (!byT.has(t)) byT.set(t, { sweep: new Set(), div: new Set() });
    const b = byT.get(t);
    if (ev.type === 'sweep' && (ev.dir === 'up' || ev.dir === 'down')) b.sweep.add(ev.dir);
    if (ev.type === 'divergence' && (ev.dir === 'up' || ev.dir === 'down')) b.div.add(ev.dir);
  }
  const out = new Set();
  for (const [t, b] of byT) {
    for (const dir of b.sweep) {
      if (b.div.has(dir)) out.add(`${t}|${dir}`);
    }
  }
  return out;
}

/** Pixel Y offset for event glyphs; when `coPair` is true, sweep and divergence on the same wick are separated. */
function _eventMarkerYOffset(ev, fontSize, coPair) {
  if (ev.type === 'sweep') {
    if (coPair) {
      return ev.dir === 'up' ? -fontSize * 0.9 : fontSize * 0.9;
    }
    return ev.dir === 'up' ? -fontSize * 0.7 : fontSize * 0.7;
  }
  if (ev.type === 'absorption') return 0;
  if (ev.type === 'stoprun') return 0;
  if (ev.type === 'divergence') {
    if (coPair) {
      return ev.dir === 'up' ? -fontSize * 0.2 : fontSize * 0.2;
    }
    return ev.dir === 'up' ? -fontSize * 0.5 : fontSize * 0.5;
  }
  return 0;
}

function _hasPhatFields(bar) {
  return Number.isFinite(Number(bar?.topCvd))
    || Number.isFinite(Number(bar?.bottomCvd))
    || Number.isFinite(Number(bar?.topBodyVolumeRatio))
    || Number.isFinite(Number(bar?.upperWickLiquidity))
    || Number.isFinite(Number(bar?.lowerWickLiquidity));
}

function _classifyPhatBody(bar, isUp) {
  const topNorm = Number(bar?.topCvdNorm);
  const botNorm = Number(bar?.bottomCvdNorm);
  const threshold = Math.max(0, Math.min(2, Number(state.phatBodyImbalanceThreshold) || 0.30));
  const hasNorms = Number.isFinite(topNorm) && Number.isFinite(botNorm);
  const imbalance = hasNorms ? Math.abs(topNorm - botNorm) : 0;
  // Option A lock: disagreement bars stay neutral.
  let shape = 'neutral';
  if (hasNorms && imbalance >= threshold) {
    if (isUp && topNorm > botNorm) shape = 'P';
    else if (!isUp && botNorm > topNorm) shape = 'b';
  }
  return {
    shape,
    topNorm,
    botNorm,
    hasNorms,
    imbalance,
  };
}

/** Both wick liquidity above this ⇒ tooltip explains winner-vs-other-extreme (see phat.py). */
const PHAT_WICK_LIQ_EPS = 0.02;

function _classifyPhatRejection(bar) {
  const rejectionSide = String(bar?.rejectionSide || 'none');
  const rejectionType = String(bar?.rejectionType || 'none');
  const rejectionStrength = Number.isFinite(Number(bar?.rejectionStrength)) ? Number(bar.rejectionStrength) : 0;
  const sideLiquidity = rejectionSide === 'high'
    ? Number(bar?.upperWickLiquidity)
    : rejectionSide === 'low'
      ? Number(bar?.lowerWickLiquidity)
      : NaN;
  const hasRejection = rejectionStrength > 0 && (rejectionSide === 'high' || rejectionSide === 'low');
  let strengthLabel = null;
  if (hasRejection) {
    if (rejectionStrength < 0.34) strengthLabel = 'weak';
    else if (rejectionStrength < 0.67) strengthLabel = 'moderate';
    else strengthLabel = 'strong';
  }
  return {
    hasRejection,
    rejectionSide,
    rejectionType,
    rejectionStrength,
    sideLiquidity,
    strengthLabel,
  };
}

function _phatRejectionRingFilled(bar) {
  const rj = _classifyPhatRejection(bar);
  if (!rj.hasRejection) return false;
  const type = String(rj.rejectionType || 'none');
  if (type === 'absorption') return true;
  const liq = Number(rj.sideLiquidity);
  const thr = Number(state.phatExhaustionRingLiquidityThreshold);
  if (type === 'exhaustion' && Number.isFinite(liq) && Number.isFinite(thr) && liq >= thr) return true;
  return false;
}

function _buildPhatHoverPayload(bar, isUp, layout = null) {
  const G = Math.max(0, Math.min(2, Number(state.phatBodyImbalanceThreshold) || 0.30));
  const body = _classifyPhatBody(bar, isUp);
  const rejection = _classifyPhatRejection(bar);
  const shapeLabel = body.shape === 'P' ? 'P-shape' : (body.shape === 'b' ? 'b-shape' : 'Neutral body');

  let neutralReason = null;
  if (body.shape === 'neutral') {
    if (!body.hasNorms) neutralReason = 'no_norms';
    else if (body.imbalance < G) neutralReason = 'below_gate';
    else neutralReason = 'disagreement';
  }
  const disagreementFlag = body.shape === 'neutral' && body.hasNorms && body.imbalance >= G;

  const uLiq = Number(bar?.upperWickLiquidity);
  const lLiq = Number(bar?.lowerWickLiquidity);
  const bothWicksLiquidity =
    Number.isFinite(uLiq) && uLiq > PHAT_WICK_LIQ_EPS
    && Number.isFinite(lLiq) && lLiq > PHAT_WICK_LIQ_EPS;

  const d = Number(bar?.delta);
  const delta = Number.isFinite(d) ? d : null;

  const rejectionRingFilled = rejection.hasRejection ? _phatRejectionRingFilled(bar) : null;

  return {
    shape: body.shape,
    shapeLabel,
    gate: G,
    imbalance: body.hasNorms ? body.imbalance : null,
    topNorm: body.hasNorms ? body.topNorm : null,
    bottomNorm: body.hasNorms ? body.botNorm : null,
    hasNorms: body.hasNorms,
    neutralReason,
    disagreementFlag,
    rejection,
    rejectionRingFilled,
    bothWicksLiquidity,
    delta,
    layout: layout && typeof layout.volNorm === 'number'
      ? { volNorm: layout.volNorm, narrowBody: !!layout.narrowBody }
      : null,
  };
}

function _drawPhatCandle(ctx, {
  bar, xCenter, top, bodyH, candleW, wickStrokeColor, isUp, isForming, dim, highlighted, yScale,
}) {
  const [r, g, b] = isUp ? CHART_CANDLE_UP_RGB : CHART_CANDLE_DOWN_RGB;
  const left = xCenter - candleW / 2;
  const halfH = Math.max(1, Math.floor(bodyH / 2));
  const lowerH = Math.max(1, bodyH - halfH);
  const highBeforeLow = bar.highBeforeLow !== false;
  const xHigh = highBeforeLow ? (left) : (left + candleW);
  const xLow = highBeforeLow ? (left + candleW) : (left);
  const topY = yScale(bar.high);
  const botY = yScale(bar.low);

  // Prototype-aligned wick anchoring:
  // high-first -> upper wick on left edge, lower on right edge.
  // low-first  -> upper wick on right edge, lower on left edge.
  // Liquidity scores thicken the segment slightly (tip participation).
  const uLiq = Math.min(1, Math.max(0, Number(bar.upperWickLiquidity) || 0));
  const lLiq = Math.min(1, Math.max(0, Number(bar.lowerWickLiquidity) || 0));
  ctx.strokeStyle = wickStrokeColor;
  ctx.save();
  ctx.lineWidth = 1 + 0.85 * uLiq;
  ctx.beginPath();
  ctx.moveTo(xHigh, topY);
  ctx.lineTo(xHigh, top);
  ctx.stroke();
  ctx.lineWidth = 1 + 0.85 * lLiq;
  ctx.beginPath();
  ctx.moveTo(xLow, top + bodyH);
  ctx.lineTo(xLow, botY);
  ctx.stroke();
  ctx.restore();

  if (isForming) {
    ctx.fillStyle = isUp ? _candleUpRgba(0.18) : _candleDownRgba(0.18);
    ctx.fillRect(left, top, candleW, bodyH);
    ctx.strokeStyle = isUp ? _candleUpRgba(0.7) : _candleDownRgba(0.7);
    ctx.setLineDash([2, 2]);
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, candleW, bodyH);
    ctx.setLineDash([]);
  } else {
    const dimMul = dim ? 0.45 : 1.0;
    const bodyClass = _classifyPhatBody(bar, isUp);
    const neutralAlpha = (0.22 * dimMul);
    const shape = bodyClass.shape;
    if (shape === 'neutral') {
      ctx.fillStyle = `rgba(${r},${g},${b},${neutralAlpha.toFixed(3)})`;
      ctx.fillRect(left, top, candleW, bodyH);
    } else if (shape === 'P') {
      ctx.fillStyle = `rgba(${r},${g},${b},${(0.82 * dimMul).toFixed(3)})`;
      ctx.fillRect(left, top, candleW, halfH);
      ctx.fillStyle = `rgba(${r},${g},${b},${(0.30 * dimMul).toFixed(3)})`;
      ctx.fillRect(left, top + halfH, candleW, lowerH);
    } else {
      ctx.fillStyle = `rgba(${r},${g},${b},${(0.30 * dimMul).toFixed(3)})`;
      ctx.fillRect(left, top, candleW, halfH);
      ctx.fillStyle = `rgba(${r},${g},${b},${(0.82 * dimMul).toFixed(3)})`;
      ctx.fillRect(left, top + halfH, candleW, lowerH);
    }
    // Prototype parity: keep a thin body border so wick segments appear
    // continuous at the body edge (avoids the tiny visual "jog").
    ctx.strokeStyle = wickStrokeColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, candleW, bodyH);
    if (highlighted) {
      ctx.strokeStyle = 'rgba(33, 160, 149, 0.85)';
      ctx.lineWidth = 1;
      ctx.strokeRect(left - 0.5, top - 0.5, candleW + 1, bodyH + 1);
    }
  }

  // Rejection marker: at most one circle, at the wick tip (high/low price). Radius 2–5px encodes strength.
  // Fill: absorption → solid; exhaustion → solid if wick liquidity crosses configured threshold.
  const rejection = _classifyPhatRejection(bar);
  const rejectionSide = rejection.rejectionSide;
  const rejectionStrength = rejection.rejectionStrength;
  const rejectionType = rejection.rejectionType;
  const ringDimMul = dim ? 0.45 : 1.0;
  const ringCol = isUp ? _candleUpRgba(0.9 * ringDimMul) : _candleDownRgba(0.9 * ringDimMul);
  const chartBg = CHART_CANVAS_BG;
  const _wickLiqAtSide = () => {
    if (rejectionSide === 'high') return Number(bar.upperWickLiquidity);
    if (rejectionSide === 'low') return Number(bar.lowerWickLiquidity);
    return NaN;
  };
  const _ringFilled = () => {
    if (rejectionType === 'absorption') return true;
    const liq = _wickLiqAtSide();
    if (rejectionType === 'exhaustion' && Number.isFinite(liq) && liq >= state.phatExhaustionRingLiquidityThreshold) {
      return true;
    }
    return false;
  };
  const drawRing = (x, y) => {
    const ringR = 2 + Math.max(0, Math.min(1, rejectionStrength)) * 3;
    ctx.beginPath();
    ctx.arc(x, y, ringR, 0, Math.PI * 2);
    if (_ringFilled()) {
      ctx.fillStyle = ringCol;
      ctx.fill();
    } else {
      ctx.fillStyle = chartBg;
      ctx.fill();
      ctx.strokeStyle = ringCol;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  };
  if (rejectionStrength > 0) {
    if (rejectionSide === 'high') drawRing(xHigh, topY);
    else if (rejectionSide === 'low') drawRing(xLow, botY);
  }
}

function _isApiProfileCompatibleWith(apiProfile, candleLo, candleHi) {
  if (!apiProfile || !Number.isFinite(candleLo) || !Number.isFinite(candleHi)) return false;
  const pLo = apiProfile.priceLo;
  if (!Number.isFinite(pLo)) return false;
  const pHi = pLo + (apiProfile.bins?.length ?? 0) * (apiProfile.binStep ?? 0);
  if (!Number.isFinite(pHi) || pHi <= pLo) return false;
  const candleRange = Math.max(candleHi - candleLo, 1.0);
  // Tolerance ≈ 50% of the candle range (or ≥ 2 ticks on tiny ranges).
  // The carry-over may legitimately lag the live edge by a few ticks
  // each side; only reject when it's clearly missing meaningful chunks
  // of price action (≥ half the rolling window).
  const tolerance = Math.max(candleRange * 0.5, 2.0);
  // (a) Disjoint check (cross-session staleness).
  if (pHi < candleLo - candleRange || pLo > candleHi + candleRange) return false;
  // (b) Coverage check (intra-session staleness — the candle range has
  // grown beyond what the carry-over knows about).
  if (pLo > candleLo + tolerance) return false;   // missing the bottom
  if (pHi < candleHi - tolerance) return false;   // missing the top
  return true;
}

function _getViewedBars() {
  const vbReq = clamp(state.chartVisibleBars, MIN_CHART_VISIBLE_BARS, MAX_CHART_VISIBLE_BARS);
  const replay = state.replay;

  if (replay.mode === 'real' && state.chartViewEnd !== null && state.chartViewEnd !== replay.cursor) {
    const end = clamp(state.chartViewEnd, 1, replay.allBars.length);
    const effVb = Math.min(vbReq, end, MAX_CHART_VISIBLE_BARS);
    const panViewStart = Math.max(0, end - effVb);
    return {
      viewedBars: replay.allBars.slice(panViewStart, end),
      isPanned: true,
      panViewStart,
    };
  }

  if (replay.mode === 'real') {
    const cursor = replay.cursor;
    const forming = state.formingBar;
    const settleWant = Math.max(0, vbReq - (forming ? 1 : 0));
    const nSettle = Math.min(settleWant, cursor);
    const start = Math.max(0, cursor - nSettle);
    const settledSlice = replay.allBars.slice(start, cursor);
    const viewedBars = forming ? [...settledSlice, forming] : settledSlice;
    return {
      viewedBars,
      isPanned: false,
      panViewStart: start,
    };
  }

  const forming = state.formingBar;
  const maxAvail = state.bars.length + (forming ? 1 : 0);
  const effVb = Math.min(vbReq, Math.max(maxAvail, 1));
  const nBase = Math.min(effVb - (forming ? 1 : 0), state.bars.length);
  const base = nBase > 0 ? state.bars.slice(-nBase) : [];
  const viewedBars = forming ? [...base, forming] : base;
  return {
    viewedBars,
    isPanned: false,
    panViewStart: 0,
  };
}

function drawPriceChart() {
  const { w, h } = resizeCanvas(priceCanvas);
  pctx.clearRect(0, 0, w, h);
  // Reset hit list every draw — geometry changes on resize/pan/streaming.
  state.chartHits = [];

  // Background grid
  pctx.fillStyle = CHART_CANVAS_BG;
  pctx.fillRect(0, 0, w, h);

  // ── Viewport selection ───────────────────────────────────────────────
  // Synthetic: rolling `state.bars` (+ forming), clipped by chartVisibleBars.
  // Real @ live edge: slice replay.allBars ending at cursor (+ forming), width from chartVisibleBars.
  // Real panned: allBars[viewStart..viewEnd]; events from allEvents by bar-time window when loaded.
  const view = _getViewedBars();
  const viewedBars = view.viewedBars;
  const isPanned = view.isPanned;
  const panViewStart = view.panViewStart;
  let viewedEvents;
  if (state.replay.mode === 'real' && viewedBars.length) {
    if (state.replay.allEvents?.length) {
      const winStart = viewedBars[0].time;
      const winEnd = viewedBars[viewedBars.length - 1].time;
      viewedEvents = state.replay.allEvents.filter(ev => ev.time >= winStart && ev.time <= winEnd);
    } else {
      viewedEvents = state.events;
    }
  } else {
    viewedEvents = state.events;
  }
  // API replay: glossary checkboxes gate primitive glyphs. Live bar-by-bar detection
  // still fills state.events — do not draw those markers unless the type is checked.
  if (state.replay.mode === 'real') {
    if (!state.activeEventTypes?.size) {
      viewedEvents = [];
    } else {
      const want = state.activeEventTypes;
      viewedEvents = viewedEvents.filter(ev => want.has(_glossaryKeyFromPrimitiveEvent(ev)));
    }
  }

  if (viewedBars.length === 0) return;

  const activeTf = state.activeTimeframe || DEFAULT_TIMEFRAME;

  const PROFILE_W = Math.min(110, w * 0.22);
  // Phase 6: reserve a thin band at the very top of the canvas for the
  // bias ribbon (1h + 15m strips). The ribbon sits above the chart pane
  // but below the canvas's top edge, so PAD.t now includes both the
  // ribbon and a small gap before the candle area starts.
  const RIBBON_H   = 10;     // total ribbon height (split into two ~4px strips at 1m)
  const RIBBON_TOP = 2;      // small gap from canvas top
  const RIBBON_GAP = 3;      // gap between ribbon and candle area
  // Bottom padding reserves a strip below the volume band for Eastern time ticks (x-axis).

  const PAD = { l: 6, r: 8, t: RIBBON_TOP + RIBBON_H + RIBBON_GAP, b: 22 };
  const chartW = w - PROFILE_W - PAD.l - PAD.r - 8;
  // Reserve bottom ~22% for the volume sub-band; price chart uses the rest.
  const VOL_BAND_FRAC = 0.22;
  const VOL_BAND_GAP  = 4;        // small visual gap between price and volume bands
  const fullChartH = h - PAD.t - PAD.b;
  const volBandH = Math.round(fullChartH * VOL_BAND_FRAC);
  const chartH = fullChartH - volBandH - VOL_BAND_GAP;
  const volTop = PAD.t + chartH + VOL_BAND_GAP;

  const allBars = viewedBars;
  const phatViewportVolRange = computeViewportVolumeRange(allBars);

  // Profile (computed from settled state.bars only — exclude state.formingBar at live edge,
  // and use the visible window when panned so the profile reflects what's
  // on screen).
  //
  // Phase 5 timeframe-aware scoping:
  //   - 1m: scope the profile to the SESSION containing the right-edge /
  //     NOW bar. At 1m a 60-bar window is always intra-session, so this
  //     keeps POC/VAH/VAL anchored to "today's" distribution and resets
  //     visually when the user pans across a day boundary.
  //   - 15m / 1h: use the FULL visible window. A 60-bar 15m window spans
  //     ~15 sessions and a 60-bar 1h window spans ~10 sessions; scoping
  //     to the right-edge session would draw value-area lines across the
  //     whole chart that only describe the last day's distribution —
  //     visually misleading. Composing across all visible bars makes
  //     VAH/VAL/POC describe the bars actually on screen.
  //
  // Computed before the y-range so POC/VAH/VAL prices can be folded into
  // lo/hi and stay on-screen even when current price has drifted away from
  // the value area.
  const settledViewed = isPanned
    ? viewedBars
    : viewedBars.filter(b => b !== state.formingBar);
  let profileBars = settledViewed;
  const _scopeToRightEdgeSession = (state.activeTimeframe || DEFAULT_TIMEFRAME) === DEFAULT_TIMEFRAME;
  let scopedSession = null;
  if (_scopeToRightEdgeSession && state.replay.mode === 'real' && settledViewed.length > 0) {
    const rightEdgeIdx = (isPanned ? state.chartViewEnd : state.replay.cursor) - 1;
    const sess = sessionForBar(clamp(rightEdgeIdx, 0, state.replay.allBars.length - 1));
    if (sess) {
      scopedSession = sess;
      profileBars = settledViewed.filter(b => {
        const ms = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
        return ms >= sess.sessionStartMs && ms < sess.sessionEndMs;
      });
    }
  }
  // Profile source fork (regime-DB plan §1b'):
  //   - API mode: fetch true tick-level volume profile from /profile,
  //     keyed on the visible (or session-scoped) bar_time window. The
  //     server runs the same value-area-fraction logic the JS proxy uses,
  //     just over real per-print volume instead of redistributed bar
  //     totals. The fetch resolution callback schedules a re-render via
  //     drawPriceChart() so the tick-level data takes over once it lands.
  //   - JSON mode (Phase 1 transition) and synthetic mode: fall back to
  //     the OHLC-distribution proxy in src/analytics/profile.js. Synthetic
  //     mode has no per-trade data; JSON mode is retired in Phase 2f.
  //
  // Fallback policy: in API mode, if the server profile isn't yet
  // resolved (in-flight fetch, network/API failure, or a window that
  // legitimately has no bar_volume_profile rows so the response carried
  // null POC/VAH/VAL), render the OHLC-proxy profile in the meantime.
  // Without this fallback the chart goes blank — no value-area lines, no
  // profile sidebar — every time the rolling-window key shifts (each new
  // settled bar), which is the symptom we see while streaming. The
  // proxy's POC may be a tick or two off vs the tick-level truth, but
  // showing an approximation always beats showing nothing, and the real
  // profile pops in seamlessly once the fetch resolves.
  let profile = null;
  let profileSource = 'none';
  if (profileBars.length > 2) {
    if (state.replay.dataDriven && state.replay.apiBase) {
      const fromIso = _isoZ(profileBars[0].time);
      const toIso   = _isoZ(profileBars[profileBars.length - 1].time);
      const fromMs = _barTimeMs(profileBars[0].time);
      const toMs   = _barTimeMs(profileBars[profileBars.length - 1].time);
      const activeTf = state.activeTimeframe || 'unknown';
      const cached = getCachedProfile(fromIso, toIso);
      // API may legitimately return all-null POC/VAH/VAL when the window
      // has no rows in bar_volume_profile — treat that as "not usable"
      // and fall back to the proxy.
      const cachedUsable = cached
        && cached.pocPrice != null
        && cached.vahPrice != null
        && cached.valPrice != null;
      if (cachedUsable) {
        profile = cached;
        profileSource = 'api-cache';
        _lastApiProfile = cached;
        _lastApiProfileTf = activeTf;
        _lastApiProfileFromMs = fromMs;
        _lastApiProfileToMs = toMs;
        _lastApiProfileSessionStartMs = scopedSession?.sessionStartMs ?? NaN;
        _lastApiProfileSessionEndMs = scopedSession?.sessionEndMs ?? NaN;
        _logProfileDecision({
          isPanned,
          source: profileSource,
          timeframe: activeTf,
          fromIso,
          toIso,
          fromMs,
          toMs,
          pocPrice: cached.pocPrice,
          maxBin: cached.maxBin,
        });
      } else {
        // Cache miss for this exact (from, to) window. Anti-flicker at
        // the live edge: reuse the most recently resolved API profile
        // (same timeframe) until the in-flight fetch lands. While panned,
        // do NOT reuse stale API profiles — panned navigation should show
        // the exact window/session selection immediately, so we use the
        // deterministic proxy until the matching API window resolves.
        //
        // Compatibility guard: refuse the carry-over when its price
        // extent doesn't overlap the current candle range. Without this
        // a stale `_lastApiProfile` (e.g. resolved during a prior pan
        // session at a different price level) drags the 1m chart's
        // Y-fit down/up by ~150 points, compressing live candles into a
        // thin band. The proxy fallback is computed from the current
        // `profileBars` so its range is always candle-aligned.
        let candleLo = Infinity, candleHi = -Infinity;
        for (const b of profileBars) {
          if (b.low  < candleLo) candleLo = b.low;
          if (b.high > candleHi) candleHi = b.high;
        }
        // Panned-mode policy: avoid proxy swaps, but never show an obviously
        // stale profile. Reuse carry-over only when it is still compatible with
        // the current candle range and session/window context.
        let canReuseLastApi = !!_lastApiProfile && _lastApiProfileTf === activeTf;
        if (canReuseLastApi && isPanned) {
          canReuseLastApi = _isApiProfileCompatibleWith(_lastApiProfile, candleLo, candleHi);
          // Prefer same-session reuse when session metadata is available.
          if (scopedSession
              && Number.isFinite(_lastApiProfileSessionStartMs)
              && Number.isFinite(_lastApiProfileSessionEndMs)) {
            canReuseLastApi = _lastApiProfileSessionStartMs === scopedSession.sessionStartMs
              && _lastApiProfileSessionEndMs === scopedSession.sessionEndMs;
          }
          // If we cannot verify session stamps, require at least window overlap.
          if (canReuseLastApi
              && Number.isFinite(fromMs)
              && Number.isFinite(toMs)
              && Number.isFinite(_lastApiProfileFromMs)
              && Number.isFinite(_lastApiProfileToMs)) {
            canReuseLastApi = _windowOverlapMs(fromMs, toMs, _lastApiProfileFromMs, _lastApiProfileToMs) > 0;
          }
        } else if (canReuseLastApi) {
          canReuseLastApi = _isApiProfileCompatibleWith(_lastApiProfile, candleLo, candleHi);
          if (canReuseLastApi
              && Number.isFinite(fromMs)
              && Number.isFinite(toMs)
              && Number.isFinite(_lastApiProfileFromMs)
              && Number.isFinite(_lastApiProfileToMs)) {
            canReuseLastApi = _windowOverlapMs(fromMs, toMs, _lastApiProfileFromMs, _lastApiProfileToMs) > 0;
          }
          if (canReuseLastApi && scopedSession
              && Number.isFinite(_lastApiProfileSessionStartMs)
              && Number.isFinite(_lastApiProfileSessionEndMs)) {
            canReuseLastApi = _lastApiProfileSessionStartMs === scopedSession.sessionStartMs
              && _lastApiProfileSessionEndMs === scopedSession.sessionEndMs;
          }
        }
        if (canReuseLastApi) {
          profile = _lastApiProfile;
          profileSource = 'api-carryover';
          _logProfileDecision({
            isPanned,
            source: profileSource,
            timeframe: activeTf,
            fromIso,
            toIso,
            fromMs,
            toMs,
            pocPrice: _lastApiProfile.pocPrice,
            maxBin: _lastApiProfile.maxBin,
          });
        } else {
          // Keep the sidebar present at all times. If no compatible API
          // carry-over is available for this unresolved key, fall back to the
          // deterministic proxy until the API response lands.
          profile = computeProfile(profileBars);
          profileSource = isPanned ? 'proxy-panned' : 'proxy';
          _logProfileDecision({
            isPanned,
            source: profileSource,
            timeframe: activeTf,
            fromIso,
            toIso,
            fromMs,
            toMs,
            pocPrice: profile?.pocPrice ?? null,
            maxBin: profile?.maxBin ?? null,
          });
        }
        // Only kick off a fetch if one hasn't *already* resolved for
        // this (from, to). When a window's response was null POC/VAH/VAL
        // (or any prior resolution) requestProfile() invokes onResolve
        // synchronously for already-resolved entries, which would feed
        // back into our microtask draw and infinite-loop the renderer.
        if (!hasResolvedProfile(fromIso, toIso)) {
          requestProfile(fromIso, toIso, () => Promise.resolve().then(() => drawPriceChart()));
        }
      }
    } else {
      profile = computeProfile(profileBars);
      profileSource = 'proxy-nonapi';
    }
  }

  // Anchored VWAP — same cumulative basis for live and panned in real mode:
  // build from allBars[0..cursor) (full day/session anchor semantics), then
  // take only the visible window. A narrow rolling-window build at the live
  // edge made the line look artificially straight vs the panned view.
  // Synthetic: keep rolling `state.bars` only.
  let vwapDisplay = null;
  const vwapAnchors = getVwapAnchors();
  if (state.replay.mode === 'real' && state.replay.allBars.length >= 2 && state.replay.cursor > 0) {
    const fullSlice = state.replay.allBars.slice(0, state.replay.cursor);
    if (fullSlice.length >= 2) {
      const fullVwap = computeAnchoredVWAP(fullSlice, vwapAnchors);
      if (isPanned) {
        const n = viewedBars.length;
        const hi = panViewStart + n;
        if (n > 0 && fullVwap.length > panViewStart) {
          vwapDisplay = fullVwap.slice(panViewStart, Math.min(hi, fullVwap.length));
        }
      } else if (state.bars.length) {
        const n = state.bars.length;
        const start = Math.max(0, state.replay.cursor - n);
        let slice = fullVwap.slice(start, Math.min(start + n, fullVwap.length));
        if (state.formingBar && slice.length) {
          const last = slice[slice.length - 1];
          slice = [...slice, { time: state.formingBar.time, vwap: last.vwap, segmentStart: false }];
        }
        vwapDisplay = slice;
      }
    }
  } else if (state.bars.length >= 2) {
    vwapDisplay = computeAnchoredVWAP(state.bars, vwapAnchors);
  }

  // Determine price range. Baseline is candle high/low (stable while the
  // rolling window slides), but at 1m we also include the profile's full
  // vertical extent + POC/VAH/VAL so the profile pane and key reference
  // levels remain visible. This is intentionally 1m-scoped because the
  // 1m profile is session-anchored and operationally central to signal
  // interpretation; higher timeframes keep the candle-only range behavior.
  let lo = Infinity, hi = -Infinity;
  for (const b of allBars) {
    if (b.low  < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  const fitProfileToRange = (state.activeTimeframe || DEFAULT_TIMEFRAME) === DEFAULT_TIMEFRAME;
  if (
    fitProfileToRange &&
    profile &&
    profile.bins &&
    profile.bins.length > 0 &&
    profile.binStep > 0
  ) {
    // Defensive cap: only fold a profile-derived price into the y-fit
    // when it's within `slack` of the candle range. Anything farther is
    // treated as off-range and falls through to the existing
    // _drawRefLine off-range arrow path (POC/VAH/VAL pinned to the
    // top/bottom edge with a price label). Without this guard, a
    // mismatched profile (stale carry-over, or a server response that
    // straddled a session-open gap) would expand the chart's y-axis to
    // span both the profile and candles, squishing the candles into a
    // thin band — the original 1m streaming bug.
    //
    // Hysteresis: a single slack threshold causes the inclusion test to
    // flip per frame whenever a price (most often POC) sits right at the
    // boundary, which the user observed as the chart "flickering between
    // two scales" during playback. We use a Schmitt-trigger pair —
    // tighter `slackFold` to refold a previously-unfolded price, looser
    // `slackKeep` to retain a previously-folded one — so the y-range
    // doesn't oscillate when the candle range jitters by a tick or two.
    // State is wiped whenever the underlying profile changes (session
    // boundary, pan, timeframe switch) so we don't carry "folded"
    // decisions across discontinuities.
    const candleRange = Math.max(hi - lo, 1.0);
    const slackFold = candleRange * 1.5;
    const slackKeep = candleRange * 3.0;
    const profileHi = profile.priceLo + profile.bins.length * profile.binStep;
    // Hysteresis is valuable at the live edge (streaming jitter), but while
    // panned it can "stick" prior fold decisions across tiny viewport moves
    // and produce abrupt scale compression. Use a stateless strict fold check
    // when panned so each viewport position is evaluated independently.
    const useFoldHysteresis = !isPanned;
    let _shouldFold;
    if (useFoldHysteresis) {
      const pid = _profileIdentity(profile);
      if (pid !== _foldHysteresis.pid) _resetFoldHysteresis(pid);
      _shouldFold = (p, key) => {
        if (!Number.isFinite(p)) {
          _foldHysteresis[key] = false;
          return false;
        }
        const wasFolded = _foldHysteresis[key];
        const slack = wasFolded ? slackKeep : slackFold;
        const folded = p >= lo - slack && p <= hi + slack;
        _foldHysteresis[key] = folded;
        return folded;
      };
    } else {
      _shouldFold = (p) => Number.isFinite(p) && p >= lo - slackFold && p <= hi + slackFold;
    }

    if (_shouldFold(profile.priceLo, 'priceLo'))   lo = Math.min(lo, profile.priceLo);
    if (_shouldFold(profileHi,       'profileHi')) hi = Math.max(hi, profileHi);
    if (_shouldFold(profile.valPrice, 'valPrice')) {
      lo = Math.min(lo, profile.valPrice);
      hi = Math.max(hi, profile.valPrice);
    }
    if (_shouldFold(profile.pocPrice, 'pocPrice')) {
      lo = Math.min(lo, profile.pocPrice);
      hi = Math.max(hi, profile.pocPrice);
    }
    if (_shouldFold(profile.vahPrice, 'vahPrice')) {
      lo = Math.min(lo, profile.vahPrice);
      hi = Math.max(hi, profile.vahPrice);
    }
  }
  const padPrice = (hi - lo) * 0.05 + 0.05;
  lo -= padPrice; hi += padPrice;
  if (hi - lo < 0.01) { hi = lo + 0.5; }

  const yScale = p => PAD.t + ((hi - p) / (hi - lo)) * chartH;
  // y-coordinate clipped to the chart's vertical bounds. Used when a
  // reference price (POC/VAH/VAL/VWAP) lies outside the candle-driven
  // y-range — the line is then drawn pinned to the relevant edge so its
  // existence + direction stays visible without expanding the axis.
  const yScaleClamped = p => {
    const y = yScale(p);
    return Math.max(PAD.t, Math.min(PAD.t + chartH, y));
  };
  // Whether `p` lies above (-1), below (+1), or inside (0) the visible
  // price range. Used to drive the off-range edge labels.
  const refDirection = p => {
    if (p > hi) return -1;   // above visible range → line pinned to top
    if (p < lo) return  1;   // below visible range → line pinned to bottom
    return 0;
  };
  const overlayVisibility = state.chartOverlayVisibility || {};
  const showPoc = overlayVisibility.poc !== false;
  const showVa = overlayVisibility.va !== false;
  const showVwap = overlayVisibility.vwap !== false;

  // Draw VAH / VAL / POC lines across full chart. Same null-guard as the
  // profile-bar label block below — empty windows can return all-null
  // POC/VAH/VAL.
  if (profile && profile.vahPrice != null && profile.valPrice != null && profile.pocPrice != null) {
    // Draw each reference line at its true y-coord when in range, or
    // pinned to the top/bottom edge when off-range. The off-range case
    // also gets an arrow + price label so the user can see "POC is
    // above this chart at 6890" without us re-scaling the y-axis.
    const _drawRefLine = (price, label, strokeStyle, lineW, dash) => {
      const dir = refDirection(price);
      const y   = yScaleClamped(price);
      pctx.strokeStyle = strokeStyle;
      pctx.lineWidth   = lineW;
      if (dash) pctx.setLineDash(dash); else pctx.setLineDash([]);
      pctx.beginPath();
      pctx.moveTo(PAD.l, y);
      pctx.lineTo(PAD.l + chartW, y);
      pctx.stroke();
      pctx.setLineDash([]);
      if (dir !== 0) {
        // Off-range edge tag: arrow indicates direction of true price,
        // label shows the price itself. Right-aligned so it doesn't
        // collide with the chart's left-edge "PANNED · …" hint.
        pctx.fillStyle = strokeStyle;
        pctx.font = '9px "IBM Plex Mono", monospace';
        pctx.textAlign = 'right';
        const arrow = dir < 0 ? '↑' : '↓';
        const yLabel = dir < 0 ? (PAD.t + 10) : (PAD.t + chartH - 4);
        pctx.fillText(`${label} ${arrow} ${price.toFixed(2)}`,
                      PAD.l + chartW - 4, yLabel);
      }
    };
    if (showVa) {
      _drawRefLine(profile.vahPrice, 'VAH', 'rgba(138, 146, 166, 0.55)', 1, [3, 3]);
      _drawRefLine(profile.valPrice, 'VAL', 'rgba(138, 146, 166, 0.55)', 1, [3, 3]);
    }
    if (showPoc) {
      _drawRefLine(profile.pocPrice, 'POC', 'rgba(33, 160, 149, 0.75)', 1.2, null);
    }
  }

  // Candles
  const totalBars = allBars.length;
  const slotW = chartW / Math.max(totalBars, 12);
  const baseCandleW = Math.max(2, Math.min(slotW * 0.65, 14));

  // Phase 6: directional-bias ribbon. Drawn first inside the reserved
  // [RIBBON_TOP, RIBBON_TOP + RIBBON_H] band above the candle pane so
  // candles + reference lines layer above it (they don't overlap, but
  // belt-and-suspenders — the ribbon should be the lowest z-layer of
  // any chrome that lives at the top edge). Returns hover hits which
  // we append to chartHits so the existing tooltip module picks them
  // up without needing a new pathway.
  const ribbonHits = drawBiasRibbon(pctx, allBars, {
    x: PAD.l,
    slotW,
    top: RIBBON_TOP,
    height: RIBBON_H,
    activeTimeframe: state.activeTimeframe || DEFAULT_TIMEFRAME,
  });
  if (ribbonHits.length) state.chartHits.push(...ribbonHits);

  // RTH session-start dividers (real-data mode only). For every loaded
  // session whose first bar happens to be visible in the current
  // viewport, build {viewportIdx, date} pairs by exact-time matching
  // each session's actual first-bar time against the bars on screen.
  // We draw the vertical lines now (before candles, so candle bodies
  // sit on top) and stash the matches for the matching label block
  // below — the labels render after candles so the date text stays
  // legible. Bars outside the viewport contribute nothing, so a 60-bar
  // live window typically shows only the right-edge session's divider;
  // panning back across a boundary reveals the prior day's marker.
  //
  // Phase 5 robustness: we key on `allBars[session.startIdx].time`, NOT
  // on `meta.session_start` from the /sessions API. At 1h the first
  // loaded bar of every session is at 10:00 ET because the leading
  // partial 09:00-10:00 ET bin is dropped by the aggregator (RTH opens
  // mid-bin), while `session_start` is 09:30 ET. Anchoring on the
  // first loaded bar guarantees a match at every timeframe — and
  // survives any future API drift between the reported session window
  // and the actual data.
  const sessionDividers = [];
  if (state.replay.mode === 'real' && state.replay.sessions.length) {
    const startMsToDate = new Map();
    for (const s of state.replay.sessions) {
      const firstBar = state.replay.allBars[s.startIdx];
      if (!firstBar) continue;
      const t = firstBar.time;
      const ms = t instanceof Date ? t.getTime() : Date.parse(t);
      if (Number.isFinite(ms)) startMsToDate.set(ms, s.date);
    }
    for (let i = 0; i < allBars.length; i++) {
      const t = allBars[i].time;
      const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
      const date = startMsToDate.get(ms);
      if (date != null) sessionDividers.push({ idx: i, date });
    }
    if (sessionDividers.length) {
      pctx.save();
      pctx.strokeStyle = 'rgba(192, 198, 208, 0.55)';
      pctx.lineWidth = 1.2;
      for (const d of sessionDividers) {
        const xStart = PAD.l + (d.idx + 0.5) * slotW;
        pctx.beginPath();
        pctx.moveTo(xStart, PAD.t);
        pctx.lineTo(xStart, volTop + volBandH);
        pctx.stroke();
      }
      pctx.restore();
    }
  }

  // Plan §4b/§4c-d: brushing tint pass. When state.selection is active,
  // bars whose bar_time_ms isn't in selection.barTimes render dim and
  // desaturated; selected bars render at full saturation with a thin
  // accent halo. O(visible) per frame because we only check membership
  // for the candles we're drawing — Set lookup is O(1).
  const selectionActive = state.selection.kind !== null && state.selection.barTimes !== null;

  for (let i = 0; i < allBars.length; i++) {
    const b = allBars[i];
    const xCenter = PAD.l + (i + 0.5) * slotW;
    const isForming = (b === state.formingBar);
    const barTimeMs = _barTimeMs(b.time);
    const isUp = b.close >= b.open;
    const upColor = CHART_CANDLE_UP;
    const downColor = CHART_CANDLE_DOWN;
    const color = isUp ? upColor : downColor;

    // Selection-driven tint. Forming bars are passed through unchanged
    // (the live-edge feedback loop matters more than the selection
    // affordance for that one bar).
    let dim = false;
    let highlighted = false;
    let hoverPreview = false;
    if (selectionActive && !isForming) {
      if (isBarSelected(barTimeMs)) {
        highlighted = true;
      } else {
        dim = true;
      }
    }
    if (selectionActive && isForming && isBarSelected(barTimeMs)) {
      highlighted = true;
    }
    if (state.selection.hoverBarTime != null && state.selection.hoverBarTime === barTimeMs) {
      hoverPreview = true;
    }

    const wickColor = isForming ? 'rgba(192,198,208,0.45)'
                    : dim         ? (isUp ? _candleUpRgba(0.22) : _candleDownRgba(0.22))
                                  : color;
    const usePhat = state.candleMode === 'phat' && _hasPhatFields(b);
    // candle_prototype.html: bodyW = maxBodyW * (spreadTicks === 1 ? 0.7 : 1.0). No L2 spread in bars —
    // use body extent in ticks as the proxy (≤1 tick → narrow “tight” bar).
    const bodyTicks = Math.round(Math.abs(b.close - b.open) / ES_MIN_TICK);
    const narrowPhatBody = bodyTicks <= 1;
    const maxBodyW = Math.min(slotW * 0.6, 30);
    // Tier cap (prototype): narrow bodies when ≤1 tick; volume maps linearly in [minCap, maxCap] over visible bars.
    const maxCap = maxBodyW * (narrowPhatBody ? 0.7 : 1.0);
    const minCap = maxCap * PHAT_WIDTH_VOLUME_MIN_CAP_FRAC;
    const volNorm = volumeNorm01Linear(b, phatViewportVolRange);
    const phatWidth = Math.max(2, minCap + (maxCap - minCap) * volNorm);
    const candleW = usePhat ? phatWidth : baseCandleW;
    if (!usePhat) {
      pctx.strokeStyle = wickColor;
      pctx.lineWidth = 1;
      pctx.beginPath();
      pctx.moveTo(xCenter, yScale(b.high));
      pctx.lineTo(xCenter, yScale(b.low));
      pctx.stroke();
    }

    const yO = yScale(b.open), yC = yScale(b.close);
    const top = Math.min(yO, yC), bot = Math.max(yO, yC);
    const bodyH = Math.max(1, bot - top);

    if (usePhat) {
      _drawPhatCandle(pctx, {
        bar: b,
        xCenter,
        top,
        bodyH,
        candleW,
        wickStrokeColor: wickColor,
        isUp,
        isForming,
        dim,
        highlighted,
        yScale,
      });
      {
        const left = xCenter - candleW / 2;
        state.chartHits.push({
          x: xCenter,
          y: top + bodyH / 2,
          r: Math.max(8, candleW * 0.7),
          hitShape: 'rect',
          x0: left,
          x1: left + candleW,
          y0: top,
          y1: top + bodyH,
          kind: 'phatCandle',
          payload: {
            ..._buildPhatHoverPayload(b, isUp, { volNorm, narrowBody: narrowPhatBody }),
            barTimeMs,
          },
        });
      }
    } else if (isForming) {
      pctx.fillStyle = isUp ? _candleUpRgba(0.18) : _candleDownRgba(0.18);
      pctx.fillRect(xCenter - candleW/2, top, candleW, bodyH);
      pctx.strokeStyle = isUp ? _candleUpRgba(0.7) : _candleDownRgba(0.7);
      pctx.setLineDash([2, 2]);
      pctx.lineWidth = 1;
      pctx.strokeRect(xCenter - candleW/2, top, candleW, bodyH);
      pctx.setLineDash([]);
    } else if (dim) {
      pctx.fillStyle = isUp ? _candleUpRgba(0.22) : _candleDownRgba(0.22);
      pctx.fillRect(xCenter - candleW/2, top, candleW, bodyH);
    } else {
      pctx.fillStyle = color;
      pctx.fillRect(xCenter - candleW/2, top, candleW, bodyH);
      if (highlighted) {
        // Subtle accent ring around selected bars. 1px outset so the
        // candle body itself stays at canonical color/opacity.
        pctx.strokeStyle = 'rgba(33, 160, 149, 0.85)';
        pctx.lineWidth = 1;
        pctx.strokeRect(xCenter - candleW/2 - 0.5, top - 0.5, candleW + 1, bodyH + 1);
      }
    }
    if (hoverPreview && !highlighted) {
      pctx.strokeStyle = isUp ? 'rgba(198, 230, 225, 0.85)' : 'rgba(255, 59, 48, 0.9)';
      pctx.lineWidth = 1;
      pctx.strokeRect(xCenter - candleW/2 - 0.5, top - 0.5, candleW + 1, bodyH + 1);
    }
    if (!usePhat) {
      const left = xCenter - candleW / 2;
      state.chartHits.push({
        x: xCenter,
        y: top + bodyH / 2,
        r: Math.max(8, candleW * 0.7),
        hitShape: 'rect',
        x0: left,
        x1: left + candleW,
        y0: top,
        y1: top + bodyH,
        kind: 'candle',
        payload: { barTimeMs, isUp, open: b.open, high: b.high, low: b.low, close: b.close },
      });
    }
  }

  // Backtest trade overlay (latest compare runs): mark entries/exits on visible bars.
  // Teal = regime filter ON, Orange = regime filter OFF. This gives a direct
  // visual sanity-check between chart signals and executed trade points.
  const btFiltered = state.backtest?.compare?.filtered?.trades || [];
  const btUnfiltered = state.backtest?.compare?.unfiltered?.trades || [];
  const showBtMarkersOn = state.backtest?.runParams?.showMarkersOn !== false;
  const compareRegimeOff =
    state.backtest?.runParams?.compareRegimeOff === true &&
    !!(state.backtest?.compare?.unfiltered?.runId);
  const showBtMarkersOff =
    compareRegimeOff && state.backtest?.runParams?.showMarkersOff !== false;
  if ((showBtMarkersOn || showBtMarkersOff) && (btFiltered.length || btUnfiltered.length) && allBars.length) {
    const idxByMs = new Map();
    for (let i = 0; i < allBars.length; i++) {
      idxByMs.set(_barTimeMs(allBars[i].time), i);
    }
    const drawTradeMarkers = (trades, color) => {
      if (!trades || !trades.length) return;
      for (const t of trades) {
        const entryMs = Date.parse(t.entryTime);
        const exitMs = Date.parse(t.exitTime);
        const entryIdx = idxByMs.get(entryMs);
        const exitIdx = idxByMs.get(exitMs);
        let entryPoint = null;
        let exitPoint = null;
        if (entryIdx != null) {
          const x = PAD.l + (entryIdx + 0.5) * slotW;
          const yBase = yScaleClamped(Number(t.entryPrice));
          const y = Math.max(PAD.t + 10, yBase - 10);
          entryPoint = { x, y };
          pctx.fillStyle = 'rgba(9, 13, 20, 0.74)';
          pctx.beginPath();
          pctx.arc(x, y, 6.5, 0, Math.PI * 2);
          pctx.fill();
          pctx.fillStyle = color;
          pctx.beginPath();
          pctx.moveTo(x, y - 5.5);
          pctx.lineTo(x - 4.5, y + 3.5);
          pctx.lineTo(x + 4.5, y + 3.5);
          pctx.closePath();
          pctx.fill();
          pctx.fillStyle = color;
          pctx.font = '8px "IBM Plex Mono", monospace';
          pctx.textAlign = 'left';
          pctx.fillText('E', x + 7, y + 2);
        }
        if (exitIdx != null) {
          const x = PAD.l + (exitIdx + 0.5) * slotW;
          const yBase = yScaleClamped(Number(t.exitPrice));
          const y = Math.min(PAD.t + chartH - 10, yBase + 10);
          exitPoint = { x, y };
          pctx.fillStyle = 'rgba(9, 13, 20, 0.74)';
          pctx.beginPath();
          pctx.arc(x, y, 6.5, 0, Math.PI * 2);
          pctx.fill();
          pctx.strokeStyle = color;
          pctx.lineWidth = 1.7;
          pctx.beginPath();
          pctx.moveTo(x - 4.4, y - 4.4);
          pctx.lineTo(x + 4.4, y + 4.4);
          pctx.moveTo(x + 4.4, y - 4.4);
          pctx.lineTo(x - 4.4, y + 4.4);
          pctx.stroke();
          pctx.fillStyle = color;
          pctx.font = '8px "IBM Plex Mono", monospace';
          pctx.textAlign = 'left';
          pctx.fillText('X', x + 7, y + 2);
        }
        if (entryPoint && exitPoint) {
          pctx.strokeStyle = color.replace('0.95', '0.40');
          pctx.lineWidth = 1;
          pctx.setLineDash([3, 3]);
          pctx.beginPath();
          pctx.moveTo(entryPoint.x, entryPoint.y);
          pctx.lineTo(exitPoint.x, exitPoint.y);
          pctx.stroke();
          pctx.setLineDash([]);
        }
      }
    };
    if (showBtMarkersOn) drawTradeMarkers(btFiltered, 'rgba(33, 160, 149, 0.95)');
    if (showBtMarkersOff) drawTradeMarkers(btUnfiltered, 'rgba(211, 145, 69, 0.95)');
  }

  // Volume sub-band — bottom of the price canvas, color-matched to candle direction.
  // Own y-scale based on max volume in view so spikes are visible.
  let maxVol = 1;
  for (const b of allBars) if (b.volume > maxVol) maxVol = b.volume;
  // Faint zero baseline
  pctx.strokeStyle = 'rgba(138, 146, 166, 0.18)';
  pctx.lineWidth = 1;
  pctx.beginPath();
  pctx.moveTo(PAD.l, volTop + volBandH);
  pctx.lineTo(PAD.l + chartW, volTop + volBandH);
  pctx.stroke();
  for (let i = 0; i < allBars.length; i++) {
    const b = allBars[i];
    const xCenter = PAD.l + (i + 0.5) * slotW;
    const isForming = (b === state.formingBar);
    const isUp = b.close >= b.open;
    const barH = Math.max(1, (b.volume / maxVol) * (volBandH - 2));
    pctx.fillStyle = isForming
      ? (isUp ? _candleUpRgba(0.3) : _candleDownRgba(0.3))
      : (isUp ? _candleUpRgba(0.55) : _candleDownRgba(0.55));
    const volW = Math.max(2, Math.min(slotW * 0.65, 14));
    pctx.fillRect(xCenter - volW/2, volTop + volBandH - barH, volW, barH);
  }
  // Tiny "VOL" label — annotated with the units so the volume bar's scale is
  // self-evident (each bar = total contracts traded in that 1-minute slot).
  pctx.fillStyle = 'rgba(138, 146, 166, 0.5)';
  pctx.font = '8px "IBM Plex Mono", monospace';
  pctx.textAlign = 'left';
  pctx.fillText('VOL · contracts/min', PAD.l + 2, volTop + 8);
  // Right-aligned peak-volume tag so the volume sub-band's y-axis isn't a black box.
  pctx.fillStyle = 'rgba(138, 146, 166, 0.55)';
  pctx.textAlign = 'right';
  pctx.fillText(`max ${maxVol.toLocaleString()}`, PAD.l + chartW - 4, volTop + 8);

  // Anchored VWAP — dashed yellow line over price (settled state.bars only).
  // The polyline values were computed up front (above the y-range block).
  // Off-range portions are clamped to the top/bottom edge of the chart so
  // the line stays visible even when current price has drifted far from
  // VWAP, without the y-axis having to expand to fit it. The VWAP
  // function emits `segmentStart=true` on the first bar of each anchor
  // segment; we break the polyline at every such point so the visual
  // reset at every RTH open is unambiguous (no slanted line connecting
  // the last bar of Day N to the first of Day N+1).
  if (showVwap && vwapDisplay && vwapDisplay.length > 0) {
    pctx.strokeStyle = 'rgba(220, 200, 90, 0.72)';
    pctx.lineWidth = 1.3;
    pctx.setLineDash([4, 3]);
    pctx.beginPath();
    let pen = false;   // false ⇒ next point starts a new sub-path with moveTo
    for (let i = 0; i < vwapDisplay.length; i++) {
      const pt = vwapDisplay[i];
      const x = PAD.l + (i + 0.5) * slotW;
      const y = yScaleClamped(pt.vwap);
      if (!pen || pt.segmentStart) {
        pctx.moveTo(x, y);
        pen = true;
      } else {
        pctx.lineTo(x, y);
      }
    }
    pctx.stroke();
    pctx.setLineDash([]);
    const lastVWAP = vwapDisplay[vwapDisplay.length - 1].vwap;
    const lastDir  = refDirection(lastVWAP);
    const lastX    = PAD.l + (vwapDisplay.length - 0.5) * slotW;
    const lastY    = yScaleClamped(lastVWAP);
    pctx.fillStyle = 'rgba(220, 200, 90, 0.85)';
    pctx.font = '9px "IBM Plex Mono", monospace';
    pctx.textAlign = 'left';
    // Append a direction arrow when VWAP is off-range so the user can
    // see "VWAP ↑ 6900.25" pinned to the top edge of the chart.
    const arrow = lastDir < 0 ? ' ↑' : (lastDir > 0 ? ' ↓' : '');
    pctx.fillText('VWAP' + arrow + ' ' + lastVWAP.toFixed(2),
                  Math.min(lastX + 4, PAD.l + chartW - 80), lastY + 3);
  }

  // Canonical fire halos — merge `allFires` (full-timeline pre-scan) with the
  // online ring buffer so streaming fires after the scan still show when panned.
  // `Date` vs string `time` is normalized with _barTimeMs for matching.
  const fireSource = _chartFireListForDraw(isPanned);
  for (const fire of fireSource) {
    const ft = _barTimeMs(fire.barTime);
    const barIdx = viewedBars.findIndex(b => _barTimeMs(b.time) === ft);
    if (barIdx < 0) continue;
    const xCenter = PAD.l + (barIdx + 0.5) * slotW;
    const bar = viewedBars[barIdx];
    const yMid = yScale((bar.high + bar.low) / 2);
    const haloR = Math.max(10, slotW * 0.7);

    // Color by watch type. Breakout = amber. Fade = blue. Absorption Wall = indigo. Value Edge = forest teal.
    const isFade = fire.watchId === 'fade';
    const isAbsorptionWall = fire.watchId === 'absorptionWall';
    const isValueEdge = fire.watchId === 'valueEdgeReject';
    const isSel = state.selection.kind === 'fire' && state.selection.fireBarTime
      && ft === state.selection.fireBarTime;
    const ringMain = isFade ? 'rgba(107, 140, 206, 0.55)'
      : isAbsorptionWall ? 'rgba(95, 115, 200, 0.55)'
        : isValueEdge ? 'rgba(33, 150, 120, 0.55)' : 'rgba(212, 160, 74, 0.55)';
    const ringDim  = isFade ? 'rgba(107, 140, 206, 0.22)'
      : isAbsorptionWall ? 'rgba(95, 115, 200, 0.22)'
        : isValueEdge ? 'rgba(33, 150, 120, 0.22)' : 'rgba(212, 160, 74, 0.22)';
    const glyphCol = isFade ? 'rgba(107, 140, 206, 0.95)'
      : isAbsorptionWall ? 'rgba(110, 130, 210, 0.95)'
        : isValueEdge ? 'rgba(42, 180, 150, 0.95)' : 'rgba(212, 160, 74, 0.95)';
    const glyph = isFade ? '◆' : isAbsorptionWall ? '🛡' : isValueEdge ? '🎯' : '★';

    // Outer warm ring
    pctx.strokeStyle = ringMain;
    pctx.lineWidth = 1.4;
    pctx.beginPath();
    pctx.arc(xCenter, yMid, haloR, 0, Math.PI * 2);
    pctx.stroke();
    // Inner dim ring
    pctx.strokeStyle = ringDim;
    pctx.lineWidth = 1;
    pctx.beginPath();
    pctx.arc(xCenter, yMid, haloR * 1.45, 0, Math.PI * 2);
    pctx.stroke();
    // Brushed target from the event log / chart: extra focus ring
    if (isSel) {
      pctx.strokeStyle = 'rgba(33, 160, 149, 0.85)';
      pctx.lineWidth = 2;
      pctx.setLineDash([2, 2]);
      pctx.beginPath();
      pctx.arc(xCenter, yMid, Math.max(14, haloR * 1.65), 0, Math.PI * 2);
      pctx.stroke();
      pctx.setLineDash([]);
    }
    // Glyph above bar — exactly as it was pre-Phase-6 follow-up. Critical
    // not to change xCenter / y / textAlign / textBaseline here, because
    // the diamond's halo + the chart's per-bar slot geometry are tuned
    // around it; shifting it (e.g., to share a center with a neighbouring
    // arrow text) clipped the glyph against the canvas top edge whenever
    // the fire bar's high sat near the visible y-max.
    pctx.fillStyle = glyphCol;
    pctx.font = '11px "IBM Plex Mono", monospace';
    pctx.textAlign = 'center';
    // 🛡: pin to the bar’s push extreme. 🎯: at VAH/VAL anchor when stored on the fire.
    let yGlyph;
    if (isAbsorptionWall) {
      yGlyph = bar.close >= bar.open ? yScale(bar.high) - 8 : yScale(bar.low) + 12;
    } else if (isValueEdge && fire.anchorPrice != null) {
      const yA = yScale(fire.anchorPrice);
      yGlyph = fire.edge === 'val' ? yA + 12 : yA - 8;
    } else {
      yGlyph = yScale(bar.high) - 8;
    }
    pctx.fillText(glyph, xCenter, yGlyph);

    // Phase 6 follow-up: directional tail on fade diamonds. A fade fire's
    // trade direction is the *opposite* of the stretch (up = mean-revert
    // from below POC; down = mean-revert from above POC), so reading it
    // off the chart context is non-obvious. We layer a small arrow to
    // the right of the diamond as a separate, smaller fillText so the
    // diamond's render path above stays byte-identical to the working
    // pre-tail behavior — the arrow is purely additive and a no-op when
    // direction is missing (e.g., legacy fires from before the bias
    // engine populated `canonical.direction`). Breakouts keep the bare
    // star: their direction trivially follows the underlying sweep, so
    // the extra glyph would just add chart noise.
    if ((isFade || isAbsorptionWall || isValueEdge) && (fire.direction === 'up' || fire.direction === 'down')) {
      const arrow = fire.direction === 'up' ? '↑' : '↓';
      pctx.font = '9px "IBM Plex Mono", monospace';
      pctx.textAlign = 'left';
      pctx.fillText(arrow, xCenter + 6, yGlyph);
    }

    // Hit-test entry for tooltip + click-to-open-modal.
    state.chartHits.push({
      x: xCenter, y: yMid, r: Math.max(haloR, 12),
      kind: 'fire', payload: fire,
    });
  }

  // Event markers (sparse, only on settled state.bars)
  const coSweepDiv = _coSweepDivergePairKeySet(viewedEvents);
  for (const ev of viewedEvents) {
    const barIdx = viewedBars.findIndex(b => b.time === ev.time);
    if (barIdx < 0) continue;
    const xCenter = PAD.l + (barIdx + 0.5) * slotW;
    const yEv = yScale(ev.price);
    const fontSize = Math.max(9, Math.min(slotW * 0.95, 14));
    const t = ev.time instanceof Date ? ev.time.getTime() : Date.parse(String(ev.time));
    const coPair = (ev.type === 'sweep' || ev.type === 'divergence') && coSweepDiv.has(`${t}|${ev.dir}`);
    const yOff = _eventMarkerYOffset(ev, fontSize, coPair);
    drawEventMarker(pctx, ev, xCenter, yEv, slotW, coPair);
    state.chartHits.push({
      x: xCenter, y: yEv + yOff, r: Math.max(slotW * 0.7, 8),
      kind: 'event', payload: ev,
    });
  }

  // Volume profile state.bars on right.
  // The /profile endpoint can return all-null POC/VAH/VAL when the
  // requested window has no rows in bar_volume_profile (zero-volume
  // gap, range smaller than one tick, etc.). Guard the labels so a
  // null doesn't poison `toFixed`.
  if (profile && profile.bins && profile.vahPrice != null && profile.valPrice != null && profile.pocPrice != null) {
    const px = PAD.l + chartW + 8;
    // Sidebar width normalization should use what the user can actually see in
    // the chart pane, not a far-tail max bin that may be off-screen. We score
    // bins by pixel visibility first, then fall back to value-area bins, then
    // full-profile max as a last resort.
    const paneTop = PAD.t;
    const paneBot = PAD.t + chartH;
    let pixelVisibleMaxBin = 0;
    const pixelVisibleBins = [];
    let vaMaxBin = 0;
    const vaBins = [];
    for (let i = 0; i < profile.bins.length; i++) {
      const v = profile.bins[i];
      const yTop = yScale(profile.priceLo + (i + 1) * profile.binStep);
      const yBot = yScale(profile.priceLo + i * profile.binStep);
      const yLo = Math.min(yTop, yBot);
      const yHi = Math.max(yTop, yBot);
      const overlapsPane = yHi >= paneTop && yLo <= paneBot;
      if (overlapsPane) {
        pixelVisibleBins.push(v);
        if (v > pixelVisibleMaxBin) pixelVisibleMaxBin = v;
      }

      const binPrice = profile.priceLo + (i + 0.5) * profile.binStep;
      const inVA = binPrice >= profile.valPrice && binPrice <= profile.vahPrice;
      if (inVA) {
        vaBins.push(v);
        if (v > vaMaxBin) vaMaxBin = v;
      }
    }
    // Robust normalization: visible-bin MAX is extremely sensitive to one-bin
    // spikes (often introduced/removed by a 1-bar pan), which reads as
    // "everything compressed" between adjacent viewport positions. Use a high
    // percentile of visible bins instead of strict max to stabilize geometry.
    let pixelVisibleP97 = 0;
    if (pixelVisibleBins.length > 0) {
      const sorted = pixelVisibleBins.slice().sort((a, b) => a - b);
      const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.97)));
      pixelVisibleP97 = sorted[idx];
    }
    let vaP97 = 0;
    if (vaBins.length > 0) {
      const sortedVa = vaBins.slice().sort((a, b) => a - b);
      const idxVa = Math.max(0, Math.min(sortedVa.length - 1, Math.floor((sortedVa.length - 1) * 0.97)));
      vaP97 = sortedVa[idxVa];
    }
    // Proxy-panned windows are the unstable path in debug captures; force
    // normalization to value-area distribution in that case.
    const useVaOnlyNorm = isPanned && String(profileSource).startsWith('proxy');
    const widthMaxBin = useVaOnlyNorm
      ? (vaP97 > 0 ? vaP97 : (vaMaxBin > 0 ? vaMaxBin : Math.max(profile.maxBin || 0, 1)))
      : (pixelVisibleP97 > 0 ? pixelVisibleP97 : (vaP97 > 0 ? vaP97 : Math.max(profile.maxBin || 0, 1)));
    if (isPanned) {
      _logVpNormOnce({
        chartViewEnd: state.chartViewEnd,
        profileSource,
        useVaOnlyNorm,
        widthMaxBin,
        pixelVisibleMaxBin,
        pixelVisibleP97,
        vaMaxBin,
        vaP97,
        profileMaxBin: profile.maxBin,
        binsLength: profile.bins.length,
        pocPrice: profile.pocPrice,
        valPrice: profile.valPrice,
        vahPrice: profile.vahPrice,
      });
    }
    for (let i = 0; i < profile.bins.length; i++) {
      const v = profile.bins[i];
      const bw = Math.min(PROFILE_W - 8, (v / widthMaxBin) * (PROFILE_W - 8));
      const yTop = yScale(profile.priceLo + (i + 1) * profile.binStep);
      const yBot = yScale(profile.priceLo + i * profile.binStep);
      const binH = Math.max(1, Math.abs(yBot - yTop) - 1);
      const binPrice = profile.priceLo + (i + 0.5) * profile.binStep;
      const inVA = showVa && binPrice >= profile.valPrice && binPrice <= profile.vahPrice;
      const isPOC = showPoc && binPrice >= profile.pocPrice - profile.binStep/2 && binPrice <= profile.pocPrice + profile.binStep/2;
      pctx.fillStyle = isPOC ? 'rgba(33,160,149,0.85)'
        : inVA ? 'rgba(33,160,149,0.32)'
          : 'rgba(138,146,166,0.18)';
      pctx.fillRect(px, Math.min(yTop, yBot), bw, binH);
    }

    // Profile labels
    pctx.fillStyle = 'rgba(192,198,208,0.6)';
    pctx.font = '9px "IBM Plex Mono", monospace';
    pctx.textAlign = 'left';
    if (showVa) pctx.fillText('VAH ' + profile.vahPrice.toFixed(2), px, yScale(profile.vahPrice) - 3);
    if (showPoc) pctx.fillText('POC ' + profile.pocPrice.toFixed(2), px, yScale(profile.pocPrice) - 3);
    if (showVa) pctx.fillText('VAL ' + profile.valPrice.toFixed(2), px, yScale(profile.valPrice) + 11);
  }

  // Last price tag
  if (allBars.length) {
    const last = allBars[allBars.length - 1];
    const yL = yScale(last.close);
    pctx.fillStyle = last.close >= last.open ? CHART_CANDLE_UP : CHART_CANDLE_DOWN;
    pctx.font = '10px "IBM Plex Mono", monospace';
    pctx.textAlign = 'right';
    pctx.fillText(last.close.toFixed(2), PAD.l + chartW - 4, yL - 4);
  }

  // Session-start date labels. One per visible session-start divider.
  // Rendered after candles so the date text sits on top and stays legible.
  // Each label anchors to its divider's x; if it would clip the right edge
  // of the chart we right-align so it tucks back into the plot area. The
  // divider line itself already implies "this is where a session begins",
  // so the label is just the YYYY-MM-DD date — no "RTH OPEN" prefix.
  if (sessionDividers.length) {
    pctx.save();
    pctx.font = '10px "IBM Plex Mono", monospace';
    pctx.fillStyle = 'rgba(220, 226, 236, 0.92)';
    for (const d of sessionDividers) {
      const xStart = PAD.l + (d.idx + 0.5) * slotW;
      const labelText = d.date;
      const labelW = pctx.measureText(labelText).width;
      const fitsRight = (xStart + 6 + labelW) <= (PAD.l + chartW - 4);
      pctx.textAlign = fitsRight ? 'left' : 'right';
      const labelX = fitsRight ? (xStart + 6) : (xStart - 4);
      pctx.fillText(labelText, labelX, PAD.t + 10);
    }
    pctx.restore();
  }

  // Bottom axis strip (canvas area above HTML “Chart view” slider): US Eastern 12h clock + “ ET”.
  // 15m uses fewer candidate ticks + larger min gap so long date+time labels never overlap.
  // Mirrored session dates on a second row are skipped on 15m and when clock ticks already
  // carry day changes (multi-day window).
  const axisFloorY = volTop + volBandH;
  const multiDayVp = _viewportSpansMultipleEtDays(allBars);
  const is15mAxis = activeTf === '15m';

  if (totalBars >= 1) {
    pctx.save();
    pctx.font = '9px "IBM Plex Mono", monospace';
    pctx.strokeStyle = 'rgba(148, 156, 172, 0.4)';
    pctx.fillStyle = 'rgba(178, 186, 200, 0.92)';
    pctx.lineWidth = 1;
    pctx.textBaseline = 'bottom';
    const nBars = totalBars;
    const pxPerSlot = is15mAxis && multiDayVp ? 100 : is15mAxis ? 88 : 52;
    const capTicks = is15mAxis && multiDayVp ? 4 : is15mAxis ? 5 : 12;
    let wantTicks = clamp(Math.floor(chartW / pxPerSlot), Math.min(nBars, is15mAxis ? 3 : 4), Math.min(capTicks, nBars));
    if (nBars <= 4) wantTicks = Math.max(1, nBars);
    const cand = [];
    if (nBars === 1) {
      cand.push(0);
    } else {
      const stepBar = (nBars - 1) / Math.max(wantTicks - 1, 1);
      for (let k = 0; k < wantTicks; k++) {
        cand.push(Math.round(k * stepBar));
      }
    }
    const uniq = [...new Set(cand)].sort((a, b) => a - b);
    let minGapPx = is15mAxis ? 14 : 6;
    if (is15mAxis && multiDayVp) minGapPx = 22;
    const acceptedTicks = [];
    let lastRight = -Infinity;
    let prevLblIdx = -1;
    for (const idx of uniq) {
      const lbl = _bottomAxisTickText(allBars, idx, prevLblIdx, multiDayVp);
      const wTxt = Math.ceil(pctx.measureText(lbl).width) + 4;
      const x = PAD.l + (idx + 0.5) * slotW;
      const left = x - wTxt / 2;
      const right = x + wTxt / 2;
      if (left < PAD.l - 1 || right > PAD.l + chartW + 1) continue;
      if (acceptedTicks.length === 0 || left >= lastRight + minGapPx) {
        acceptedTicks.push({ idx, lbl, x });
        lastRight = right;
        prevLblIdx = idx;
      }
    }
    if (uniq.length && acceptedTicks.length === 0) {
      const idx = uniq[Math.floor(uniq.length / 2)];
      const lbl = _bottomAxisTickText(allBars, idx, -1, multiDayVp);
      acceptedTicks.push({ idx, lbl, x: PAD.l + (idx + 0.5) * slotW });
    }
    for (const t of acceptedTicks) {
      pctx.beginPath();
      pctx.moveTo(t.x, axisFloorY);
      pctx.lineTo(t.x, axisFloorY + 4);
      pctx.stroke();
    }
    pctx.textAlign = 'center';
    const timeY = h - 3;
    for (const t of acceptedTicks) {
      pctx.fillText(t.lbl, t.x, timeY);
    }
    if (sessionDividers.length >= 2 && !is15mAxis && !multiDayVp) {
      const vd = sessionDividers;
      const maxSd = Math.min(10, Math.max(2, Math.floor(chartW / 52)));
      let sdStep = 1;
      if (vd.length > maxSd) sdStep = Math.ceil(vd.length / maxSd);
      pctx.font = '8px "IBM Plex Mono", monospace';
      pctx.fillStyle = 'rgba(160, 168, 186, 0.88)';
      pctx.textBaseline = 'middle';
      const dateMidY = axisFloorY + 10;
      for (let j = 0; j < vd.length; j += sdStep) {
        const sd = vd[j];
        const xSd = PAD.l + (sd.idx + 0.5) * slotW;
        pctx.fillText(String(sd.date), xSd, dateMidY);
      }
    }
    pctx.restore();
  }

  // Plan §4c-d: vertical anchor for fire-window selection. Drawn before
  // the NOW line so the NOW indicator stays on top when both happen to
  // land on the same x. Anchors the user's eye to the fire bar that
  // opens the brushed window — the surrounding 30 bars are tinted
  // accent via the candle loop above.
  if (state.selection.kind === 'fire' && state.selection.fireBarTime != null) {
    const fireMs = state.selection.fireBarTime;
    const fireIdx = allBars.findIndex(b => {
      const ms = b.time instanceof Date ? b.time.getTime() : Date.parse(b.time);
      return ms === fireMs;
    });
    if (fireIdx >= 0) {
      const xFire = PAD.l + (fireIdx + 0.5) * slotW;
      pctx.save();
      pctx.strokeStyle = 'rgba(33, 160, 149, 0.85)';
      pctx.lineWidth = 1.4;
      pctx.setLineDash([4, 3]);
      pctx.beginPath();
      pctx.moveTo(xFire, PAD.t);
      pctx.lineTo(xFire, volTop + volBandH);
      pctx.stroke();
      pctx.setLineDash([]);
      pctx.fillStyle = 'rgba(33, 160, 149, 0.95)';
      pctx.font = '8px "IBM Plex Mono", monospace';
      pctx.textAlign = 'center';
      pctx.fillText('FIRE', xFire, PAD.t + 8);
      pctx.restore();
    }
  }

  // Vertical "NOW" line — anchors the user's perception to "what bar drives
  // the regime matrix". At live edge: the rightmost (forming or last
  // committed) bar; when panned: the right edge of the visible slice (the bar
  // whose vol×depth state the matrix is displaying — see _refreshMatrixForView).
  if (allBars.length) {
    const lastIdx = allBars.length - 1;
    const xNow = PAD.l + (lastIdx + 0.5) * slotW;
    pctx.save();
    pctx.strokeStyle = isPanned ? 'rgba(212, 160, 74, 0.55)' : 'rgba(33, 160, 149, 0.40)';
    pctx.lineWidth = 1;
    pctx.setLineDash([3, 4]);
    pctx.beginPath();
    pctx.moveTo(xNow, PAD.t);
    pctx.lineTo(xNow, PAD.t + chartH);
    pctx.stroke();
    pctx.setLineDash([]);
    pctx.fillStyle = isPanned ? 'rgba(212, 160, 74, 0.85)' : 'rgba(33, 160, 149, 0.75)';
    pctx.font = '8px "IBM Plex Mono", monospace';
    pctx.textAlign = 'center';
    pctx.fillText('NOW', xNow, PAD.t + 8);
    pctx.restore();
  }

  // "Panned" hint: dim, mono, top-left of the price chart so it never overlaps
  // the volume profile labels on the right.
  if (isPanned) {
    const end = clamp(state.chartViewEnd, 1, state.replay.allBars.length);
    const lastBar = state.replay.allBars[end - 1];
    const t = lastBar ? new Date(lastBar.time) : null;
    const tEt = t ? `${_formatEtClock12(t)} ET` : '--';
    pctx.fillStyle = 'rgba(212, 160, 74, 0.85)';
    pctx.font = '9px "IBM Plex Mono", monospace';
    pctx.textAlign = 'left';
    pctx.fillText(`PANNED · ${tEt} · bar ${end}/${state.replay.allBars.length}`,
                  PAD.l + 2, PAD.t + 8);
  }

  // Toggle "↺ Live" button visibility based on viewport state.
  const liveBtn = document.getElementById('liveEdgeBtn');
  if (liveBtn) liveBtn.classList.toggle('visible', isPanned);

  // Refresh tooltip if the cursor is over a hit (geometry may have shifted on resize/pan).
  _refreshTooltipFromLastMouse();
}

function drawEventMarker(ctx, ev, x, y, slotW, coSweepDivergePair = false) {
  // Render as text glyphs using the same Unicode characters as the Event Glossary,
  // so chart icons and legend icons are visually identical (no path-vs-glyph drift).
  const fontSize = Math.max(9, Math.min(slotW * 0.95, 14));
  ctx.save();
  ctx.font = `${fontSize}px "IBM Plex Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let glyph, color;
  if (ev.type === 'sweep') {
    color = '#b07ac9';
    glyph = ev.dir === 'up' ? '▲' : '▼';
  } else if (ev.type === 'absorption') {
    color = '#6b8cce';
    glyph = '◉';
  } else if (ev.type === 'stoprun') {
    color = '#d4634a';
    glyph = '⚡';
  } else if (ev.type === 'divergence') {
    color = '#d4a04a';
    glyph = '⚠';
  }

  if (glyph) {
    const yOffset = _eventMarkerYOffset(ev, fontSize, coSweepDivergePair);
    ctx.fillStyle = color;
    ctx.fillText(glyph, x, y + yOffset);
  }
  ctx.restore();
}

export { _getViewedBars, drawPriceChart, drawEventMarker };
