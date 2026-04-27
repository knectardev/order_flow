import { MAX_BARS } from '../config/constants.js';
import { state } from '../state.js';
import { computeProfile } from '../analytics/profile.js';
import { computeAnchoredVWAP, getVwapAnchors } from '../analytics/vwap.js';
import { getCachedProfile, requestProfile } from '../data/profileApi.js';
import { sessionForBar } from '../data/replay.js';
import { isBarSelected } from '../ui/selection.js';
import { _refreshTooltipFromLastMouse } from '../ui/tooltip.js';
import { pctx, priceCanvas, resizeCanvas } from '../util/dom.js';
import { clamp } from '../util/math.js';

// Format a Date (or epoch-ms number) as an ISO-8601 timestamp with a Z
// suffix for the /profile endpoint. We keep millisecond precision because
// the API matches against `bar_time TIMESTAMP` columns at second
// granularity but accepts fractional input — using full ISO keeps the
// cache keys stable across re-renders that produce identical Date objects.
function _isoZ(t) {
  if (t == null) return '';
  return (t instanceof Date) ? t.toISOString() : new Date(t).toISOString();
}

function _getViewedBars() {
  if (state.replay.mode === 'real' && state.chartViewEnd !== null && state.chartViewEnd !== state.replay.cursor) {
    const end = clamp(state.chartViewEnd, 1, state.replay.allBars.length);
    const panViewStart = Math.max(0, end - MAX_BARS);
    return {
      viewedBars: state.replay.allBars.slice(panViewStart, end),
      isPanned: true,
      panViewStart,
    };
  }
  return {
    viewedBars: state.formingBar ? [...state.bars, state.formingBar] : state.bars,
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
  pctx.fillStyle = '#0d1218';
  pctx.fillRect(0, 0, w, h);

  // ── Viewport selection ───────────────────────────────────────────────
  // Synthetic mode: render the live `state.bars` rolling window (+ state.formingBar).
  // Real mode @ live edge: same — `state.bars` is the last MAX_BARS, state.formingBar is
  //    the in-progress real bar.
  // Real mode panned: render state.replay.allBars[viewStart..viewEnd], no forming
  //    bar (we're looking at history). Events are filtered from
  //    state.replay.allEvents by bar.time.
  const view = _getViewedBars();
  const viewedBars = view.viewedBars;
  const isPanned = view.isPanned;
  const panViewStart = view.panViewStart;
  // Events: when panned, filter from the full session log by bar-time window;
  // at live edge use the in-memory rolling `state.events` array (same semantics as
  // before — kept inline because the flow chart doesn't render state.events).
  let viewedEvents;
  if (isPanned && viewedBars.length) {
    const winStart = viewedBars[0].time;
    const winEnd   = viewedBars[viewedBars.length - 1].time;
    viewedEvents = state.replay.allEvents.filter(ev => ev.time >= winStart && ev.time <= winEnd);
  } else {
    viewedEvents = state.events;
  }

  if (viewedBars.length === 0) return;

  const PROFILE_W = Math.min(110, w * 0.22);
  const PAD = { l: 6, r: 8, t: 10, b: 14 };
  const chartW = w - PROFILE_W - PAD.l - PAD.r - 8;
  // Reserve bottom ~22% for the volume sub-band; price chart uses the rest.
  const VOL_BAND_FRAC = 0.22;
  const VOL_BAND_GAP  = 4;        // small visual gap between price and volume bands
  const fullChartH = h - PAD.t - PAD.b;
  const volBandH = Math.round(fullChartH * VOL_BAND_FRAC);
  const chartH = fullChartH - volBandH - VOL_BAND_GAP;
  const volTop = PAD.t + chartH + VOL_BAND_GAP;

  // Determine price range
  const allBars = viewedBars;
  let lo = Infinity, hi = -Infinity;
  for (const b of allBars) {
    if (b.low  < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  const padPrice = (hi - lo) * 0.05 + 0.05;
  lo -= padPrice; hi += padPrice;
  if (hi - lo < 0.01) { hi = lo + 0.5; }

  const yScale = p => PAD.t + ((hi - p) / (hi - lo)) * chartH;

  // Profile (computed from settled state.bars only — exclude state.formingBar at live edge,
  // and use the visible window when panned so the profile reflects what's
  // on screen).
  //
  // Multi-session refinement: in real-data mode, scope the profile state.bars to
  // the session containing the right-edge / NOW bar. This makes POC/VAH/VAL
  // reset visually as the user scrolls across a day boundary — POC for
  // "today" should never be polluted by yesterday's volume distribution.
  // When the viewport spans two days, the profile reflects only the
  // right-edge session's state.bars that happen to be visible.
  const settledViewed = isPanned
    ? viewedBars
    : viewedBars.filter(b => b !== state.formingBar);
  let profileBars = settledViewed;
  if (state.replay.mode === 'real' && settledViewed.length > 0) {
    const rightEdgeIdx = (isPanned ? state.chartViewEnd : state.replay.cursor) - 1;
    const sess = sessionForBar(clamp(rightEdgeIdx, 0, state.replay.allBars.length - 1));
    if (sess) {
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
  //     totals. While the fetch is in flight we render with no profile
  //     (one frame of no VAH/VAL/POC lines + no profile bars) and the
  //     resolution callback triggers a re-render via drawPriceChart().
  //   - JSON mode (Phase 1 transition) and synthetic mode: fall back to
  //     the OHLC-distribution proxy in src/analytics/profile.js. Synthetic
  //     mode has no per-trade data; JSON mode is retired in Phase 2f.
  let profile = null;
  if (profileBars.length > 2) {
    if (state.replay.dataDriven && state.replay.apiBase) {
      const fromIso = _isoZ(profileBars[0].time);
      const toIso   = _isoZ(profileBars[profileBars.length - 1].time);
      profile = getCachedProfile(fromIso, toIso);
      if (!profile) {
        // Kick off the fetch and re-render when it lands. The handler
        // schedules a microtask draw rather than calling drawPriceChart
        // synchronously to avoid recursing inside the current render.
        requestProfile(fromIso, toIso, () => Promise.resolve().then(() => drawPriceChart()));
      }
    } else {
      profile = computeProfile(profileBars);
    }
  }

  // Draw VAH / VAL / POC lines across full chart. Same null-guard as the
  // profile-bar label block below — empty windows can return all-null
  // POC/VAH/VAL.
  if (profile && profile.vahPrice != null && profile.valPrice != null && profile.pocPrice != null) {
    pctx.lineWidth = 1;
    // VAH dashed
    pctx.strokeStyle = 'rgba(138, 146, 166, 0.45)';
    pctx.setLineDash([3, 3]);
    pctx.beginPath();
    pctx.moveTo(PAD.l, yScale(profile.vahPrice));
    pctx.lineTo(PAD.l + chartW, yScale(profile.vahPrice));
    pctx.stroke();
    // VAL dashed
    pctx.beginPath();
    pctx.moveTo(PAD.l, yScale(profile.valPrice));
    pctx.lineTo(PAD.l + chartW, yScale(profile.valPrice));
    pctx.stroke();
    pctx.setLineDash([]);
    // POC solid teal
    pctx.strokeStyle = 'rgba(33, 160, 149, 0.55)';
    pctx.lineWidth = 1.2;
    pctx.beginPath();
    pctx.moveTo(PAD.l, yScale(profile.pocPrice));
    pctx.lineTo(PAD.l + chartW, yScale(profile.pocPrice));
    pctx.stroke();
  }

  // Candles
  const totalBars = allBars.length;
  const slotW = chartW / Math.max(totalBars, 12);
  const candleW = Math.max(2, Math.min(slotW * 0.65, 14));

  // RTH session-start dividers (real-data mode only). For every loaded
  // session whose sessionStart bar happens to be visible in the current
  // viewport, build {viewportIdx, date} pairs by exact-time matching the
  // sessionStart against the state.bars on screen. We draw the vertical lines now
  // (before candles, so candle bodies sit on top) and stash the matches for
  // the matching label block below — the labels render after candles so the
  // date text stays legible. Bars outside the viewport contribute nothing,
  // so a 60-bar live window typically shows only the right-edge session's
  // divider; panning back across a boundary reveals the prior day's marker.
  const sessionDividers = [];
  if (state.replay.mode === 'real' && state.replay.sessions.length) {
    const startMsToDate = new Map();
    for (const s of state.replay.sessions) startMsToDate.set(s.sessionStartMs, s.date);
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
    const isUp = b.close >= b.open;
    const upColor   = '#4ea674';
    const downColor = '#c95760';
    const color = isUp ? upColor : downColor;

    // Selection-driven tint. Forming bars are passed through unchanged
    // (the live-edge feedback loop matters more than the selection
    // affordance for that one bar).
    let dim = false;
    let highlighted = false;
    if (selectionActive && !isForming) {
      const ms = b.time instanceof Date ? b.time.getTime() : Date.parse(b.time);
      if (isBarSelected(ms)) {
        highlighted = true;
      } else {
        dim = true;
      }
    }

    const wickColor = isForming ? 'rgba(192,198,208,0.45)'
                    : dim         ? (isUp ? 'rgba(78,166,116,0.22)' : 'rgba(201,87,96,0.22)')
                                  : color;
    pctx.strokeStyle = wickColor;
    pctx.lineWidth = 1;
    pctx.beginPath();
    pctx.moveTo(xCenter, yScale(b.high));
    pctx.lineTo(xCenter, yScale(b.low));
    pctx.stroke();

    const yO = yScale(b.open), yC = yScale(b.close);
    const top = Math.min(yO, yC), bot = Math.max(yO, yC);
    const bodyH = Math.max(1, bot - top);

    if (isForming) {
      pctx.fillStyle = isUp ? 'rgba(78,166,116,0.18)' : 'rgba(201,87,96,0.18)';
      pctx.fillRect(xCenter - candleW/2, top, candleW, bodyH);
      pctx.strokeStyle = isUp ? 'rgba(78,166,116,0.7)' : 'rgba(201,87,96,0.7)';
      pctx.setLineDash([2, 2]);
      pctx.lineWidth = 1;
      pctx.strokeRect(xCenter - candleW/2, top, candleW, bodyH);
      pctx.setLineDash([]);
    } else if (dim) {
      pctx.fillStyle = isUp ? 'rgba(78,166,116,0.22)' : 'rgba(201,87,96,0.22)';
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
      ? (isUp ? 'rgba(78,166,116,0.30)' : 'rgba(201,87,96,0.30)')
      : (isUp ? 'rgba(78,166,116,0.55)' : 'rgba(201,87,96,0.55)');
    pctx.fillRect(xCenter - candleW/2, volTop + volBandH - barH, candleW, barH);
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
  // Live edge: compute from the rolling `state.bars` window (matches existing
  //            synthetic + real behavior).
  // Panned (real): compute on the entire concatenated timeline up through
  //                the right edge so the cumulative VWAP is correct, then
  //                render only the slice visible in the current viewport.
  // The VWAP function emits `segmentStart=true` on the first bar of each
  // anchor segment; we break the polyline at every such point so the visual
  // reset at every RTH open is unambiguous (no slanted line connecting the
  // last bar of Day N to the first of Day N+1).
  let vwapDisplay = null;
  const vwapAnchors = getVwapAnchors();
  if (isPanned) {
    const fullSlice = state.replay.allBars.slice(0, panViewStart + viewedBars.length);
    if (fullSlice.length >= 2) {
      const fullVwap = computeAnchoredVWAP(fullSlice, vwapAnchors);
      vwapDisplay = fullVwap.slice(panViewStart);
    }
  } else if (state.bars.length >= 2) {
    vwapDisplay = computeAnchoredVWAP(state.bars, vwapAnchors);
  }
  if (vwapDisplay && vwapDisplay.length > 0) {
    pctx.strokeStyle = 'rgba(220, 200, 90, 0.72)';
    pctx.lineWidth = 1.3;
    pctx.setLineDash([4, 3]);
    pctx.beginPath();
    let pen = false;   // false ⇒ next point starts a new sub-path with moveTo
    for (let i = 0; i < vwapDisplay.length; i++) {
      const pt = vwapDisplay[i];
      const x = PAD.l + (i + 0.5) * slotW;
      const y = yScale(pt.vwap);
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
    const lastX = PAD.l + (vwapDisplay.length - 0.5) * slotW;
    pctx.fillStyle = 'rgba(220, 200, 90, 0.85)';
    pctx.font = '9px "IBM Plex Mono", monospace';
    pctx.textAlign = 'left';
    pctx.fillText('VWAP ' + lastVWAP.toFixed(2), Math.min(lastX + 4, PAD.l + chartW - 60), yScale(lastVWAP) + 3);
  }

  // Canonical fire halos — drawn underneath event markers so the SWEEP/etc.
  // glyph sits on top. When panned (real mode), use the full session's fire
  // log (state.replay.allFires) so historic fires remain visible; when live, use the
  // online `state.canonicalFires` ring buffer (capped at 20).
  const fireSource = isPanned && state.replay.allFires.length ? state.replay.allFires : state.canonicalFires;
  for (const fire of fireSource) {
    const barIdx = viewedBars.findIndex(b => b.time === fire.barTime);
    if (barIdx < 0) continue;
    const xCenter = PAD.l + (barIdx + 0.5) * slotW;
    const bar = viewedBars[barIdx];
    const yMid = yScale((bar.high + bar.low) / 2);
    const haloR = Math.max(10, slotW * 0.7);

    // Color by watch type. Breakout = amber (warn). Fade = blue (absorb).
    const isFade = fire.watchId === 'fade';
    const ringMain = isFade ? 'rgba(107, 140, 206, 0.55)' : 'rgba(212, 160, 74, 0.55)';
    const ringDim  = isFade ? 'rgba(107, 140, 206, 0.22)' : 'rgba(212, 160, 74, 0.22)';
    const glyphCol = isFade ? 'rgba(107, 140, 206, 0.95)' : 'rgba(212, 160, 74, 0.95)';
    const glyph    = isFade ? '◆' : '★';

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
    // Glyph above bar
    pctx.fillStyle = glyphCol;
    pctx.font = '11px "IBM Plex Mono", monospace';
    pctx.textAlign = 'center';
    pctx.fillText(glyph, xCenter, yScale(bar.high) - 8);

    // Hit-test entry for tooltip + click-to-open-modal.
    state.chartHits.push({
      x: xCenter, y: yMid, r: Math.max(haloR, 12),
      kind: 'fire', payload: fire,
    });
  }

  // Event markers (sparse, only on settled state.bars)
  for (const ev of viewedEvents) {
    const barIdx = viewedBars.findIndex(b => b.time === ev.time);
    if (barIdx < 0) continue;
    const xCenter = PAD.l + (barIdx + 0.5) * slotW;
    const yEv = yScale(ev.price);
    drawEventMarker(pctx, ev, xCenter, yEv, slotW);
    state.chartHits.push({
      x: xCenter, y: yEv, r: Math.max(slotW * 0.7, 8),
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
    for (let i = 0; i < profile.bins.length; i++) {
      const v = profile.bins[i];
      const bw = (v / Math.max(profile.maxBin, 1)) * (PROFILE_W - 8);
      const yTop = yScale(profile.priceLo + (i + 1) * profile.binStep);
      const yBot = yScale(profile.priceLo + i * profile.binStep);
      const binH = Math.max(1, Math.abs(yBot - yTop) - 1);
      const binPrice = profile.priceLo + (i + 0.5) * profile.binStep;
      const inVA = binPrice >= profile.valPrice && binPrice <= profile.vahPrice;
      const isPOC = binPrice >= profile.pocPrice - profile.binStep/2 && binPrice <= profile.pocPrice + profile.binStep/2;
      pctx.fillStyle = isPOC ? 'rgba(33,160,149,0.85)'
                      : inVA  ? 'rgba(33,160,149,0.32)'
                              : 'rgba(138,146,166,0.18)';
      pctx.fillRect(px, Math.min(yTop, yBot), bw, binH);
    }

    // Profile labels
    pctx.fillStyle = 'rgba(192,198,208,0.6)';
    pctx.font = '9px "IBM Plex Mono", monospace';
    pctx.textAlign = 'left';
    pctx.fillText('VAH ' + profile.vahPrice.toFixed(2), px, yScale(profile.vahPrice) - 3);
    pctx.fillText('POC ' + profile.pocPrice.toFixed(2), px, yScale(profile.pocPrice) - 3);
    pctx.fillText('VAL ' + profile.valPrice.toFixed(2), px, yScale(profile.valPrice) + 11);
  }

  // Last price tag
  if (allBars.length) {
    const last = allBars[allBars.length - 1];
    const yL = yScale(last.close);
    pctx.fillStyle = last.close >= last.open ? '#4ea674' : '#c95760';
    pctx.font = '10px "IBM Plex Mono", monospace';
    pctx.textAlign = 'right';
    pctx.fillText(last.close.toFixed(2), PAD.l + chartW - 4, yL - 4);
  }

  // RTH session-start date labels. One per visible session-start divider.
  // Rendered after candles so the date text sits on top and stays legible.
  // Each label anchors to its divider's x; if it would clip the right edge
  // of the chart we right-align so it tucks back into the plot area. With
  // many dividers in view, identical-style labels keep the visual rhythm —
  // the user sees a clear "RTH OPEN · YYYY-MM-DD" stamp above each day's
  // first bar.
  if (sessionDividers.length) {
    pctx.save();
    pctx.font = '10px "IBM Plex Mono", monospace';
    pctx.fillStyle = 'rgba(220, 226, 236, 0.92)';
    for (const d of sessionDividers) {
      const xStart = PAD.l + (d.idx + 0.5) * slotW;
      const labelText = `RTH OPEN · ${d.date}`;
      const labelW = pctx.measureText(labelText).width;
      const fitsRight = (xStart + 6 + labelW) <= (PAD.l + chartW - 4);
      pctx.textAlign = fitsRight ? 'left' : 'right';
      const labelX = fitsRight ? (xStart + 6) : (xStart - 4);
      pctx.fillText(labelText, labelX, PAD.t + 10);
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
    const hh = t ? String(t.getUTCHours()).padStart(2, '0') : '--';
    const mm = t ? String(t.getUTCMinutes()).padStart(2, '0') : '--';
    pctx.fillStyle = 'rgba(212, 160, 74, 0.85)';
    pctx.font = '9px "IBM Plex Mono", monospace';
    pctx.textAlign = 'left';
    pctx.fillText(`PANNED · ${hh}:${mm}Z · bar ${end}/${state.replay.allBars.length}`,
                  PAD.l + 2, PAD.t + 8);
  }

  // Toggle "↺ Live" button visibility based on viewport state.
  const liveBtn = document.getElementById('liveEdgeBtn');
  if (liveBtn) liveBtn.classList.toggle('visible', isPanned);

  // Refresh tooltip if the cursor is over a hit (geometry may have shifted on resize/pan).
  _refreshTooltipFromLastMouse();
}

function drawEventMarker(ctx, ev, x, y, slotW) {
  // Render as text glyphs using the same Unicode characters as the Event Glossary,
  // so chart icons and legend icons are visually identical (no path-vs-glyph drift).
  const fontSize = Math.max(9, Math.min(slotW * 0.95, 14));
  ctx.save();
  ctx.font = `${fontSize}px "IBM Plex Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let glyph, color, yOffset = 0;
  if (ev.type === 'sweep') {
    color = '#b07ac9';
    glyph = ev.dir === 'up' ? '▲' : '▼';
    yOffset = ev.dir === 'up' ? -fontSize * 0.7 : fontSize * 0.7;
  } else if (ev.type === 'absorption') {
    color = '#6b8cce';
    glyph = '◉';
  } else if (ev.type === 'stoprun') {
    color = '#d4634a';
    glyph = '⚡';
  } else if (ev.type === 'divergence') {
    color = '#d4a04a';
    glyph = '⚠';
    yOffset = ev.dir === 'up' ? -fontSize * 0.5 : fontSize * 0.5;
  }

  if (glyph) {
    ctx.fillStyle = color;
    ctx.fillText(glyph, x, y + yOffset);
  }
  ctx.restore();
}

export { _getViewedBars, drawPriceChart, drawEventMarker };
