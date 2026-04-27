import { MAX_BARS, DEFAULT_TIMEFRAME } from '../config/constants.js';
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

// Format a Date (or epoch-ms number) as an ISO-8601 timestamp with a Z
// suffix for the /profile endpoint. We keep millisecond precision because
// the API matches against `bar_time TIMESTAMP` columns at second
// granularity but accepts fractional input — using full ISO keeps the
// cache keys stable across re-renders that produce identical Date objects.
function _isoZ(t) {
  if (t == null) return '';
  return (t instanceof Date) ? t.toISOString() : new Date(t).toISOString();
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
  // Phase 6: reserve a thin band at the very top of the canvas for the
  // bias ribbon (1h + 15m strips). The ribbon sits above the chart pane
  // but below the canvas's top edge, so PAD.t now includes both the
  // ribbon and a small gap before the candle area starts.
  const RIBBON_H   = 10;     // total ribbon height (split into two ~4px strips at 1m)
  const RIBBON_TOP = 2;      // small gap from canvas top
  const RIBBON_GAP = 3;      // gap between ribbon and candle area
  const PAD = { l: 6, r: 8, t: RIBBON_TOP + RIBBON_H + RIBBON_GAP, b: 14 };
  const chartW = w - PROFILE_W - PAD.l - PAD.r - 8;
  // Reserve bottom ~22% for the volume sub-band; price chart uses the rest.
  const VOL_BAND_FRAC = 0.22;
  const VOL_BAND_GAP  = 4;        // small visual gap between price and volume bands
  const fullChartH = h - PAD.t - PAD.b;
  const volBandH = Math.round(fullChartH * VOL_BAND_FRAC);
  const chartH = fullChartH - volBandH - VOL_BAND_GAP;
  const volTop = PAD.t + chartH + VOL_BAND_GAP;

  const allBars = viewedBars;

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
  if (_scopeToRightEdgeSession && state.replay.mode === 'real' && settledViewed.length > 0) {
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
  if (profileBars.length > 2) {
    if (state.replay.dataDriven && state.replay.apiBase) {
      const fromIso = _isoZ(profileBars[0].time);
      const toIso   = _isoZ(profileBars[profileBars.length - 1].time);
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
        _lastApiProfile = cached;
        _lastApiProfileTf = activeTf;
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
        if (!isPanned
            && _lastApiProfile
            && _lastApiProfileTf === activeTf
            && _isApiProfileCompatibleWith(_lastApiProfile, candleLo, candleHi)) {
          profile = _lastApiProfile;
        } else {
          profile = computeProfile(profileBars);
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
    }
  }

  // Anchored VWAP — computed up front (same reason as profile: we want to
  // fold its visible price range into the chart's y-axis so the dashed
  // yellow line can't fall off-screen).
  // Live edge: compute from the rolling `state.bars` window.
  // Panned (real): compute on the entire concatenated timeline up through
  //                the right edge so the cumulative VWAP is correct, then
  //                render only the slice visible in the current viewport.
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
    const pid = _profileIdentity(profile);
    if (pid !== _foldHysteresis.pid) _resetFoldHysteresis(pid);

    const candleRange = Math.max(hi - lo, 1.0);
    const slackFold = candleRange * 1.5;
    const slackKeep = candleRange * 3.0;
    const profileHi = profile.priceLo + profile.bins.length * profile.binStep;

    const _shouldFold = (p, key) => {
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
    _drawRefLine(profile.vahPrice, 'VAH', 'rgba(138, 146, 166, 0.55)', 1,   [3, 3]);
    _drawRefLine(profile.valPrice, 'VAL', 'rgba(138, 146, 166, 0.55)', 1,   [3, 3]);
    _drawRefLine(profile.pocPrice, 'POC', 'rgba(33, 160, 149, 0.75)',  1.2, null);
  }

  // Candles
  const totalBars = allBars.length;
  const slotW = chartW / Math.max(totalBars, 12);
  const candleW = Math.max(2, Math.min(slotW * 0.65, 14));

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
  // The polyline values were computed up front (above the y-range block).
  // Off-range portions are clamped to the top/bottom edge of the chart so
  // the line stays visible even when current price has drifted far from
  // VWAP, without the y-axis having to expand to fit it. The VWAP
  // function emits `segmentStart=true` on the first bar of each anchor
  // segment; we break the polyline at every such point so the visual
  // reset at every RTH open is unambiguous (no slanted line connecting
  // the last bar of Day N to the first of Day N+1).
  if (vwapDisplay && vwapDisplay.length > 0) {
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
    const glyph = isFade ? '◆' : '★';

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
    // Glyph above bar — exactly as it was pre-Phase-6 follow-up. Critical
    // not to change xCenter / y / textAlign / textBaseline here, because
    // the diamond's halo + the chart's per-bar slot geometry are tuned
    // around it; shifting it (e.g., to share a center with a neighbouring
    // arrow text) clipped the glyph against the canvas top edge whenever
    // the fire bar's high sat near the visible y-max.
    pctx.fillStyle = glyphCol;
    pctx.font = '11px "IBM Plex Mono", monospace';
    pctx.textAlign = 'center';
    pctx.fillText(glyph, xCenter, yScale(bar.high) - 8);

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
    if (isFade && (fire.direction === 'up' || fire.direction === 'down')) {
      const arrow = fire.direction === 'up' ? '↑' : '↓';
      pctx.font = '9px "IBM Plex Mono", monospace';
      pctx.textAlign = 'left';
      pctx.fillText(arrow, xCenter + 6, yScale(bar.high) - 8);
    }

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
