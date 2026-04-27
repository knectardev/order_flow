import { BREAKOUT_CELL, FADE_CELL, MATRIX_COLS, MATRIX_ROWS, MAX_BARS, SYNTH_TUNINGS, TRAIL_LEN } from '../config/constants.js';
import { state } from '../state.js';
import { evaluateBreakoutCanonical, evaluateFadeCanonical } from '../analytics/canonical.js';
import { detectEvents, detectStopRun } from '../analytics/events.js';
import { computeMatrixScores, deriveRegimeState } from '../analytics/regime.js';
import { renderEventLog } from '../render/eventLog.js';
import { drawFlowChart } from '../render/flowChart.js';
import { renderMatrix } from '../render/matrix.js';
import { _getViewedBars, drawPriceChart } from '../render/priceChart.js';
import { renderBreakoutWatch, renderFadeWatch } from '../render/watch.js';
import { handleWatchFire } from '../sim/step.js';
import { toggleStream } from '../ui/controls.js';
import { _syncSessionDropdown } from '../ui/pan.js';
import { clamp } from '../util/math.js';

function sessionForBar(barIdx) {
  const arr = state.replay.sessions;
  if (!arr || arr.length === 0) return null;
  if (barIdx < 0 || barIdx >= state.replay.allBars.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = arr[mid];
    if (barIdx < s.startIdx) hi = mid - 1;
    else if (barIdx >= s.endIdx) lo = mid + 1;
    else return s;
  }
  return null;
}

function _syncCurrentSession() {
  if (state.replay.mode !== 'real' || state.replay.sessions.length === 0) return;
  const idx = clamp((state.chartViewEnd !== null ? state.chartViewEnd : state.replay.cursor) - 1,
                    0, state.replay.allBars.length - 1);
  const sess = sessionForBar(idx) || state.replay.sessions[state.replay.sessions.length - 1];
  state.replay.current = sess;
  state.replay.tunings = sess.tunings || null;
}

function _resetReplayAccumulators() {
  state.bars = [];
  state.formingBar = null;
  state.events = [];
  state.trail = [];
  state.canonicalFires = [];
  state.matrixScores = Array.from({length: MATRIX_ROWS}, () => Array(MATRIX_COLS).fill(0));
  state.breakoutWatch.lastCanonical = null;
  state.breakoutWatch.firedThisCycle = false;
  state.breakoutWatch.flipTicks = { cell: null, sweep: null, flow: null, clean: null };
  state.fadeWatch.lastCanonical = null;
  state.fadeWatch.firedThisCycle = false;
  state.fadeWatch.flipTicks = { balanced: null, cell: null, stretchPOC: null, stretchVWAP: null, noMomentum: null };
  state.sim.formingProgress = 0;
  state.sim.tick = 0;
  state.sim.volState = 2;
  state.sim.depthState = 2;
  state.lastFiredWatch = null;
  // Reset warmup flag on every seek/replay reset; the next _commitRealBar
  // sets it to its true value based on the bar's v_rank/d_rank.
  state.regimeWarmup = false;
}

function _resetForSessionBoundary() {
  state.bars = [];
  state.events = [];
  state.breakoutWatch.lastCanonical = null;
  state.breakoutWatch.firedThisCycle = false;
  state.breakoutWatch.flipTicks = { cell: null, sweep: null, flow: null, clean: null };
  state.fadeWatch.lastCanonical = null;
  state.fadeWatch.firedThisCycle = false;
  state.fadeWatch.flipTicks = { balanced: null, cell: null, stretchPOC: null, stretchVWAP: null, noMomentum: null };
}

function _commitRealBar(idx) {
  // Multi-session boundary handling: when this bar starts a new session
  // (any session other than the first), purge per-session live state so
  // detection, watches, and rolling-window VWAP/profile don't see prior-day
  // state.bars. We also re-point state.replay.tunings at the current bar's session so
  // detectEvents() uses the right thresholds for this day.
  const sess = sessionForBar(idx);
  if (sess) {
    state.replay.tunings = sess.tunings || null;
    if (sess.startIdx === idx && sess !== state.replay.sessions[0]) {
      _resetForSessionBoundary();
    }
  }

  const realBar = state.replay.allBars[idx];
  state.bars.push(realBar);
  if (state.bars.length > MAX_BARS) state.bars.shift();

  // regime-DB plan §2c-d: deriveRegimeState may return null (warmup window
  // or zero-volume bar with data-driven ranks). In that case we *do not*
  // overwrite state.sim.volState / depthState — leaving them stale doesn't
  // matter because canonical evaluators short-circuit on warmup, the
  // matrix is rendered as the WARMING UP overlay, and trail dots are
  // suppressed. Once ranks emit (typically bar 30), the flag flips back
  // and normal rendering resumes in a single repaint.
  const reg = deriveRegimeState(idx);
  if (reg) {
    state.sim.volState = reg.volState;
    state.sim.depthState = reg.depthState;
    state.regimeWarmup = false;
  } else {
    state.regimeWarmup = true;
  }

  const newEvs = detectEvents(realBar, state.bars.slice(0, -1));
  for (const ev of newEvs) state.events.push(ev);
  detectStopRun();
  if (state.events.length > 80) state.events = state.events.slice(-80);

  if (!state.regimeWarmup) {
    const r = 4 - state.sim.volState;
    const c = state.sim.depthState;
    if (state.trail.length === 0 || state.trail[state.trail.length - 1].r !== r || state.trail[state.trail.length - 1].c !== c) {
      state.trail.push({ r, c });
      if (state.trail.length > TRAIL_LEN) state.trail.shift();
    }
  }

  const breakoutCanonical = evaluateBreakoutCanonical();
  const fadeCanonical = evaluateFadeCanonical();
  handleWatchFire('breakout', breakoutCanonical, state.breakoutWatch, BREAKOUT_CELL);
  handleWatchFire('fade',     fadeCanonical,     state.fadeWatch,     FADE_CELL);
  return { breakoutCanonical, fadeCanonical };
}

function seek(targetIdx) {
  if (state.replay.mode !== 'real') return;
  targetIdx = clamp(targetIdx, 0, state.replay.allBars.length);
  state.seekInProgress = true;
  _resetReplayAccumulators();
  for (let i = 0; i < targetIdx; i++) _commitRealBar(i);
  state.replay.cursor = targetIdx;
  // Re-couple the chart viewport to the cursor on any explicit seek (scrubber,
  // step buttons, jump-to-fire, Reset). Free-form pan is preserved only across
  // streaming/forming-bar updates, which never call seek().
  state.chartViewEnd = null;
  // Re-derive state.replay.current/tunings + dropdown selection now that the
  // cursor (and thus the right-edge bar) has moved.
  _syncCurrentSession();
  _syncSessionDropdown();
  state.seekInProgress = false;
  // Render once at end
  state.matrixScores = computeMatrixScores();
  const breakoutCanonical = evaluateBreakoutCanonical();
  const fadeCanonical = evaluateFadeCanonical();
  drawPriceChart();
  drawFlowChart();
  renderMatrix(breakoutCanonical, fadeCanonical);
  renderBreakoutWatch(breakoutCanonical);
  renderFadeWatch(fadeCanonical);
  renderEventLog();
  _renderReplayChrome();
}

function seekStep(delta) {
  if (state.replay.mode !== 'real') return;
  if (state.interval) toggleStream();   // pause stream when stepping manually
  seek(state.replay.cursor + delta);
}

function _renderReplayChrome() {
  if (state.replay.mode !== 'real') return;
  const sc = document.getElementById('scrubber');
  sc.max = String(state.replay.allBars.length);
  sc.value = String(state.replay.cursor);
  const tr = document.getElementById('timeReadout');
  if (state.replay.cursor === 0) {
    tr.textContent = '— bar 0 / ' + state.replay.allBars.length;
  } else {
    const lastBar = state.replay.allBars[state.replay.cursor - 1];
    const t = lastBar ? new Date(lastBar.time) : null;
    const hh = t ? String(t.getUTCHours()).padStart(2, '0') : '--';
    const mm = t ? String(t.getUTCMinutes()).padStart(2, '0') : '--';
    // With multiple sessions loaded, prefix the date so the readout
    // disambiguates same-time-of-day across days.
    const datePart = state.replay.current ? `${state.replay.current.date} ` : '';
    tr.textContent = `${datePart}${hh}:${mm}Z · bar ${state.replay.cursor} / ${state.replay.allBars.length}`;
  }
  // Bar-count + cumulative-delta readouts mirror what's actually on screen.
  // When panned the user is looking at a historical slice; reporting the
  // live-edge `state.bars` array's count and cumΔ here would contradict the
  // candles + delta-distribution panel they're viewing.
  const { viewedBars, isPanned } = _getViewedBars();
  const lastTag = isPanned
    ? 'panned'
    : (state.formingBar ? 'forming' : 'settled');
  document.getElementById('barCount').textContent =
    `1m bars · ${viewedBars.length} shown · last ${lastTag}`;
  const cumD = viewedBars.reduce((s, b) => s + b.delta, 0);
  document.getElementById('cumDelta').textContent =
    viewedBars.length ? `cum Δ ${cumD >= 0 ? '+' : ''}${cumD}` : 'cum Δ —';
  _syncSessionDropdown();
}

function onScrubberInput()  {
  const v = parseInt(document.getElementById('scrubber').value, 10);
  if (state.interval) toggleStream();
  seek(v);
}

function onScrubberCommit() { onScrubberInput(); }

function precomputeAllFires() {
  if (state.replay.mode !== 'real' || !state.replay.allBars.length) {
    state.replay.allFires = [];
    return;
  }
  const savedCursor = state.replay.cursor;
  seek(state.replay.allBars.length);
  state.replay.allFires = state.canonicalFires.slice();
  seek(savedCursor);
}

function precomputeAllEvents() {
  state.replay.allEvents = [];
  if (state.replay.mode !== 'real' || !state.replay.allBars.length) return;
  const all = state.replay.allEvents;
  // Iterate session-by-session so the 12-bar lookback never crosses a day
  // boundary. Each session also uses its own tunings (the JSON embeds them
  // per-day; thresholds can drift as exchange microstructure evolves).
  for (const sess of state.replay.sessions) {
    const t = sess.tunings || SYNTH_TUNINGS;
    for (let i = sess.startIdx; i < sess.endIdx; i++) {
      const newBar = state.replay.allBars[i];
      // Clamp the lookback at the session's own startIdx so Day N bar 0
      // doesn't compare against Day N-1's last state.bars.
      const lookbackStart = Math.max(sess.startIdx, i - 12);
      const history = state.replay.allBars.slice(lookbackStart, i);
      if (history.length >= 12) {
        const recent = history.slice(-10);
        const recentHigh = Math.max(...recent.map(b => b.high));
        const recentLow  = Math.min(...recent.map(b => b.low));
        const avgVol  = recent.reduce((s,b)=>s+b.volume,0)/recent.length;
        const avgRange= recent.reduce((s,b)=>s+(b.high-b.low),0)/recent.length;
        const range = newBar.high - newBar.low;

        if (newBar.high > recentHigh && newBar.volume > avgVol * t.sweepVolMult) {
          all.push({ type: 'sweep', dir: 'up', price: newBar.high, time: newBar.time });
        } else if (newBar.low < recentLow && newBar.volume > avgVol * t.sweepVolMult) {
          all.push({ type: 'sweep', dir: 'down', price: newBar.low, time: newBar.time });
        }
        if (newBar.volume > avgVol * t.absorbVolMult && range < avgRange * t.absorbRangeMult) {
          all.push({ type: 'absorption', price: newBar.close, time: newBar.time });
        }
        const cumD = recent.slice(-8).reduce((s,b)=>s+b.delta, 0) + newBar.delta;
        if (newBar.high > recentHigh && cumD < -avgVol * t.divergenceFlowMult) {
          all.push({ type: 'divergence', dir: 'up', price: newBar.high, time: newBar.time });
        } else if (newBar.low < recentLow && cumD > avgVol * t.divergenceFlowMult) {
          all.push({ type: 'divergence', dir: 'down', price: newBar.low, time: newBar.time });
        }
      }
      // Stop-run review: sweep + reverse on consecutive state.bars. Skip if the
      // sweep bar lives in a different session (i.e. last bar of Day N → first
      // bar of Day N+1) — those aren't meaningfully consecutive.
      if (all.length >= 1) {
        const last = all[all.length - 1];
        if (last.type === 'sweep' && !last._reviewed) {
          // last.time is a Date; match against the bar at i-1 by reference.
          if (i - 1 >= sess.startIdx) {
            const sweepBar = state.replay.allBars[i - 1];
            if (sweepBar && sweepBar.time === last.time) {
              last._reviewed = true;
              if (last.dir === 'up' && newBar.close < sweepBar.open) {
                all.push({ type: 'stoprun', dir: 'up', price: last.price, time: newBar.time });
              } else if (last.dir === 'down' && newBar.close > sweepBar.open) {
                all.push({ type: 'stoprun', dir: 'down', price: last.price, time: newBar.time });
              }
            }
          }
        }
      }
    }
  }
}

function jumpToNextFire(watchId) {
  if (state.replay.mode !== 'real') return;
  if (!state.replay.allFires.length) return;
  // Find the next fire after the current cursor for this watch
  const next = state.replay.allFires.find(f => {
    if (f.watchId !== watchId) return false;
    const idx = state.replay.allBars.findIndex(b => b.time === f.barTime);
    return idx >= state.replay.cursor;
  });
  if (!next) return;
  const idx = state.replay.allBars.findIndex(b => b.time === next.barTime);
  if (state.interval) toggleStream();
  seek(idx + 1);   // land just after the firing bar so it's visible at the right edge
}

async function bootstrapReplay() {
  // regime-DB plan §2f: JSON-manifest mode has been retired. The
  // dashboard now requires `?source=api[&apiBase=…]`. Older `?source=
  // json` URLs (or omitted `source=`) intentionally fall back to
  // synthetic mode rather than silently loading stale JSON. Live data
  // and the v2 regime classifier come from the FastAPI/DuckDB stack.
  const params = new URL(window.location.href).searchParams;
  const source = (params.get('source') || '').toLowerCase();
  if (source === 'api') {
    const apiBase = (params.get('apiBase') || 'http://localhost:8001').replace(/\/+$/, '');
    return bootstrapFromApi(apiBase);
  }
  console.info('[orderflow] No ?source=api specified; staying in synthetic mode.');
}

// API-mode bootstrap (regime-DB plan §1d). Fetches the session manifest
// from /sessions, then per-session bars from /bars?session_date=…, and
// concatenates them into the same state.replay.allBars / .sessions shape
// that JSON mode uses. The downstream replay machinery (commit loop,
// regime classifier, watch evaluators, event log) is identical — only
// the data ingress changes — which is what makes the Phase 1e
// data-equivalence verification meaningful.
//
// Profile fetching is lazy (priceChart.js → profileApi.js); we don't
// pre-fetch /profile here because the profile window depends on viewport
// state that can change after bootstrap.
async function bootstrapFromApi(apiBase) {
  state.replay.apiBase = apiBase;
  state.replay.source = 'api';
  state.replay.dataDriven = true;
  let metas = [];
  try {
    const res = await fetch(`${apiBase}/sessions`);
    if (!res.ok) throw new Error(`/sessions ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.sessions) || data.sessions.length === 0) {
      console.info('[orderflow] API mode: /sessions returned no sessions.');
      return;
    }
    metas = data.sessions.slice().sort((a, b) =>
      (a.session_date < b.session_date ? -1 : a.session_date > b.session_date ? 1 : 0));
  } catch (err) {
    // Surface API failures rather than masking them with synthetic mode —
    // ?source=api is an explicit user/dev choice. The console message is
    // the contract.
    console.error('[orderflow] API bootstrap failed:', err.message);
    state.replay.apiBase = null;
    state.replay.source = 'synthetic';
    state.replay.dataDriven = false;
    return;
  }
  await _loadAllSessionsFromApi(apiBase, metas);
}

async function _loadAllSessionsFromApi(apiBase, metas) {
  const datas = await Promise.all(metas.map(async (meta) => {
    const url = `${apiBase}/bars?session_date=${encodeURIComponent(meta.session_date)}`;
    try {
      const r = await fetch(url);
      if (!r.ok) {
        console.warn('Failed to load API session bars', meta.session_date, r.status);
        return null;
      }
      const j = await r.json();
      return { meta, data: j };
    } catch (err) {
      console.warn('Failed to load API session bars', meta.session_date, err.message);
      return null;
    }
  }));

  if (state.interval) toggleStream();

  const allBars = [];
  const sessions = [];
  for (const entry of datas) {
    if (!entry) continue;
    const { meta, data } = entry;
    if (!Array.isArray(data.bars) || data.bars.length === 0) continue;
    const startIdx = allBars.length;
    for (const b of data.bars) {
      // Bars come over the wire with `time` as ISO-Z strings; promote to
      // Date so downstream code (chart axis, fire matching, event log
      // formatting) can call .getUTC*() / .getTime() the same way it does
      // in JSON mode.
      allBars.push({ ...b, time: new Date(b.time) });
    }
    const endIdx = allBars.length;
    if (endIdx === startIdx) continue;
    const sessionStartMs = meta.session_start ? Date.parse(meta.session_start) : null;
    const sessionEndMs   = meta.session_end   ? Date.parse(meta.session_end)   : null;
    sessions.push({
      // Synthetic 'file' key for the dropdown — onSessionChange()
      // matches against this string. Prefix with `api:` so it can never
      // collide with a JSON session manifest path.
      file: `api:${meta.session_date}`,
      symbol: 'ES',
      contract: '',
      date: meta.session_date,
      session: 'rth',
      sessionStart: meta.session_start,
      sessionEnd: meta.session_end,
      sessionStartMs,
      sessionEndMs,
      startIdx,
      endIdx,
      barCount: endIdx - startIdx,
      // Phase 1: per-session tunings aren't yet stored in DuckDB. Falling
      // back to SYNTH_TUNINGS keeps detectors firing on the same
      // thresholds JSON mode used in synthetic-tuning days; Phase 5+ can
      // round-trip tunings through the DB if we need per-session drift.
      tunings: SYNTH_TUNINGS,
    });
  }

  if (allBars.length === 0 || sessions.length === 0) return;

  state.replay.mode = 'real';
  state.replay.sessions = sessions;
  state.replay.allBars = allBars;
  state.replay.current = sessions[0];
  state.replay.tunings = sessions[0].tunings || null;
  state.replay.sessionAnchorNs = sessions[0].sessionStart;
  state.replay.cursor = 0;
  state.replay.allFires = [];
  state.replay.allEvents = [];
  state.chartViewEnd = null;

  precomputeAllEvents();

  document.getElementById('replayRow').style.display = '';
  populateSessionList();
  const sel = document.getElementById('sessionSelect');
  if (sel) sel.value = state.replay.current.file;
  const badge = document.getElementById('modeBadge');
  if (badge) {
    badge.textContent = `Real · ES · API · v2 regime`;
    badge.style.background = 'rgba(33, 160, 149, 0.18)';
  }
  _renderModeSubtitle();

  seek(0);
  precomputeAllFires();
}

function populateSessionList() {
  const sel = document.getElementById('sessionSelect');
  sel.innerHTML = '';
  for (const s of state.replay.sessions) {
    const opt = document.createElement('option');
    opt.value = s.file;
    opt.textContent = `${s.symbol || 'ES'} ${s.contract || ''} · ${s.date} · ${s.session.toUpperCase()} (${s.barCount} bars)`;
    sel.appendChild(opt);
  }
}

function onSessionChange() {
  const file = document.getElementById('sessionSelect').value;
  const meta = state.replay.sessions.find(s => s.file === file);
  if (!meta) return;
  if (state.interval) toggleStream();
  // Snap cursor to the session's end so streaming would naturally roll
  // forward into the next session, AND so _setViewEnd's "snap-to-live-edge
  // when clamped == cursor" behavior keeps subsequent panning intuitive.
  seek(meta.endIdx);
}

function _renderModeSubtitle() {
  if (state.replay.mode !== 'real' || state.replay.sessions.length === 0) return;
  const first = state.replay.sessions[0];
  const last  = state.replay.sessions[state.replay.sessions.length - 1];
  const span  = (state.replay.sessions.length === 1)
    ? `${first.date}`
    : `${first.date} → ${last.date}`;
  const sessText = state.replay.sessions.length === 1 ? 'session' : 'sessions';
  document.getElementById('modeSubtitle').textContent =
    `${first.contract || ''} · ${state.replay.sessions.length} ${sessText} · ${span} · ${state.replay.allBars.length} bars · scrub or stream to replay`;
}

export { sessionForBar, _syncCurrentSession, _resetReplayAccumulators, _resetForSessionBoundary, _commitRealBar, seek, seekStep, _renderReplayChrome, onScrubberInput, onScrubberCommit, precomputeAllFires, precomputeAllEvents, jumpToNextFire, bootstrapReplay, bootstrapFromApi, populateSessionList, onSessionChange, _renderModeSubtitle };
