import { state } from '../state.js';
import { selectFire, clearSelection } from '../ui/selection.js';

// regime-DB plan §2d: sticky SYSTEM row HTML. Rendered as the *first*
// child of #eventLog while state.regimeWarmup is true so it pins to the
// top of the scroll region (CSS .event-log-system-row uses position: sticky
// with var(--panel) background to occlude scrolled-up events). The non-
// sticky alternative (just-prepend-as-first-row) loses the message as
// soon as 5–10 events scroll past — the trust-layer purpose requires it
// to stay visible *during* scroll-back.
const SYSTEM_WARMUP_HTML = `<div class="event-log-system-row">
      <span class="time">—</span>
      <span class="glyph">▣</span>
      <span class="label">SYSTEM · regime warming up · ranks unavailable for first 30 bars</span>
      <span class="price"></span>
    </div>`;

// Plan §4b: filtered SYSTEM row when a brushed selection is active. Tells
// the user the log is no longer showing the live event stream and gives
// a one-click escape hatch (Esc also clears, but the row is the discoverable
// affordance).
function _selectionBannerHtml() {
  const sel = state.selection;
  if (sel.kind === null) return '';
  let label;
  if (sel.kind === 'cells') {
    const n = sel.cells.length;
    label = `SELECTION · ${n} cell${n === 1 ? '' : 's'} brushed · click ✕ or press Esc to clear`;
  } else {
    label = 'SELECTION · fire window (fire bar + next 30) · click ✕ or press Esc to clear';
  }
  return `<div class="event-log-system-row event-log-selection-row" data-clear-selection="1">
      <span class="time">—</span>
      <span class="glyph">◧</span>
      <span class="label">${label}</span>
      <span class="price">✕</span>
    </div>`;
}

function _fireLabel(fire) {
  const dirArrow = fire.direction === 'up' ? '↑'
                 : fire.direction === 'down' ? '↓'
                 : '·';
  if (fire.watchId === 'fade') {
    return `Fade fire ${dirArrow} mean-revert to POC`;
  }
  if (fire.watchId === 'absorptionWall') {
    return `Absorption Wall ${dirArrow} passive liquidity`;
  }
  if (fire.watchId === 'valueEdgeReject') {
    return `Value Edge ${dirArrow} reject toward POC`;
  }
  return `Breakout fire ${dirArrow} impulsive light`;
}

function _eventFilterKey(ev) {
  if (!ev) return '';
  if (ev.type === 'absorption') return 'absorption';
  return `${ev.type}_${ev.dir || ''}`;
}

function _rowFilterKey(row) {
  if (row.kind === 'fire') return `fire_${row.payload.watchId || ''}`;
  return _eventFilterKey(row.payload);
}

// Phase 6: Align column. Maps the anchor-priority tag onto a glyph + a
// row-tint rgba string. Tints are intentionally *low-alpha* so the
// existing event-row palette (sweep/absorb/fire colors) still reads as
// the primary semantic; the bias gradient is a quiet secondary cue.
//
// Score threading: even with the same tag, a |score| spread (-4..+4)
// modulates alpha so a STANDARD fire whose score is +1 reads slightly
// greener than one whose score is 0. Keeps the tag bucket dominant
// (HIGH_CONVICTION never bleeds down into STANDARD) but gives the
// numeric score a small visible footprint.
const _TAG_GLYPH = {
  HIGH_CONVICTION: '✓✓',
  STANDARD:        '·',
  LOW_CONVICTION:  '⚠',
  SUPPRESSED:      '⊘',
};

function _alignTint(tag, score) {
  if (!tag) return '';
  // |score| in 0..4 → alpha lift in 0..0.10 above the tag's base alpha.
  const lift = Math.min(Math.abs(score || 0), 4) * 0.025;
  if (tag === 'HIGH_CONVICTION') return `background: rgba(70, 180, 110, ${0.18 + lift});`;
  if (tag === 'LOW_CONVICTION')  return `background: rgba(220, 160, 60, ${0.16 + lift});`;
  if (tag === 'SUPPRESSED')      return `background: rgba(190, 90, 90, ${0.20 + lift});`;
  // STANDARD: nearly transparent — score sign tints faint green/red so
  // the user can see "this STANDARD fire leans bullish/bearish HTF".
  if ((score || 0) > 0) return `background: rgba(70, 180, 110, ${0.04 + lift});`;
  if ((score || 0) < 0) return `background: rgba(190, 90, 90,  ${0.04 + lift});`;
  return '';
}

function _alignCellHtml(tag, score) {
  if (!tag) return '<span class="align"></span>';
  const glyph = _TAG_GLYPH[tag] || '·';
  const sNum  = (score == null) ? '' : (score > 0 ? `+${score}` : `${score}`);
  // title= gives a hover-tooltip with the verbose tag + score.
  const title = `${tag.replace(/_/g, ' ').toLowerCase()} (score ${sNum || '0'})`;
  return `<span class="align" title="${title}">${glyph}${sNum ? ` ${sNum}` : ''}</span>`;
}

function renderEventLog() {
  const log = document.getElementById('eventLog');
  const eventCountEl = document.getElementById('eventCount');
  const warmupHtml = state.regimeWarmup ? SYSTEM_WARMUP_HTML : '';
  const selBanner  = _selectionBannerHtml();

  // ── Build a unified, time-ordered row list (events + canonical fires).
  // Plan §4c-d: fires are clickable rows in the log so they can serve as
  // the brushing entry point alongside chart-fire-halo clicks.
  const fires = state.replay.mode === 'real' && state.replay.allFires.length
    ? state.replay.allFires
    : state.canonicalFires;
  const events = state.replay.mode === 'real' && state.replay.allEvents.length
    ? state.replay.allEvents
    : state.events;

  const fireRows = fires.map(f => ({
    kind: 'fire',
    time: f.barTime instanceof Date ? f.barTime : new Date(f.barTime),
    payload: f,
  }));
  const evRows = events.map(ev => ({
    kind: 'event',
    time: ev.time,
    payload: ev,
  }));

  // Apply brush filter. When kind='cells' or 'fire' is active, drop
  // any row whose bar_time isn't in the selection set; the active
  // selection banner above signals what was filtered.
  const sel = state.selection;
  const filterPredicate = (row) => {
    if (!sel.barTimes) return true;
    const ms = row.time instanceof Date ? row.time.getTime() : Date.parse(row.time);
    return sel.barTimes.has(ms);
  };

  // Phase 6: respect state.showSuppressed. SUPPRESSED fires are persisted
  // to state.canonicalFires (so post-session review can audit what hard-
  // mode filtered) but are hidden from the event log unless the user
  // opts in via ?showSuppressed=1.
  const suppressedFilter = (row) => {
    if (row.kind !== 'fire') return true;
    if (row.payload.tag !== 'SUPPRESSED') return true;
    return !!state.showSuppressed;
  };
  const typeFilter = (row) => {
    const wanted = state.eventLogFilter?.type || 'all';
    if (wanted === 'all') return true;
    return _rowFilterKey(row) === wanted;
  };

  const merged = [...evRows, ...fireRows]
    .filter(filterPredicate)
    .filter(suppressedFilter)
    .filter(typeFilter)
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const hiddenSuppressed = fires.filter(f => f.tag === 'SUPPRESSED').length;

  if (merged.length === 0) {
    const emptyMsg = sel.kind
      ? '<div class="empty">no events or fires in the selected window</div>'
      : '<div class="empty">no events yet — events fire only on specific microstructural patterns, not every bar</div>';
    log.innerHTML = warmupHtml + selBanner + emptyMsg;
    eventCountEl.textContent =
      state.regimeWarmup ? 'warming up' : (sel.kind ? '0 in selection' : '—');
    return;
  }

  // Show the full filtered timeline in reverse chronological order so
  // the newest event remains at the top while preserving total context.
  const shown = merged.length;
  const recent = merged.slice().reverse();
  if (sel.kind) {
    eventCountEl.textContent = `showing ${shown} in selection`;
  } else {
    const base = `showing ${shown} rows`;
    const totals = `${events.length} event${events.length===1?'':'s'}` +
      (fires.length ? ` · ${fires.length} fire${fires.length===1?'':'s'}` : '');
    const suppressedHint = !state.showSuppressed && hiddenSuppressed
      ? ` · ${hiddenSuppressed} suppressed hidden`
      : '';
    eventCountEl.textContent = `${base} · ${totals}${suppressedHint}`;
  }
  log.innerHTML = warmupHtml + selBanner + recent.map(row => {
    const tStr = row.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (row.kind === 'fire') {
      const f = row.payload;
      const isFade = f.watchId === 'fade';
      const isAbsorptionWall = f.watchId === 'absorptionWall';
      const isValueEdge = f.watchId === 'valueEdgeReject';
      const cls = isFade ? 'fire-fade' : isAbsorptionWall ? 'fire-absorption-wall' : isValueEdge ? 'fire-value-edge' : 'fire-breakout';
      const glyph = isFade ? '◆' : isAbsorptionWall ? '🛡' : isValueEdge ? '🎯' : '★';
      const ms = row.time.getTime();
      // Phase 6: tint + align column. Tag/score come from canonical
      // alignment computed at fire time; null for legacy fires that
      // predate the bias engine, in which case _alignTint returns ''
      // and _alignCellHtml renders an empty cell.
      const score = f.alignment?.score ?? null;
      const tint  = _alignTint(f.tag, score);
      const alignHtml = _alignCellHtml(f.tag, score);
      const styleAttr = tint ? ` style="${tint}"` : '';
      return `<div class="event-row event-row-fire ${cls}" data-fire-ms="${ms}" data-fire-id="${f.watchId}"${styleAttr}>
        <span class="time">${tStr}</span>
        <span class="glyph">${glyph}</span>
        <span class="label">${_fireLabel(f)}</span>
        ${alignHtml}
        <span class="price">${f.price.toFixed(2)}</span>
      </div>`;
    }

    const ev = row.payload;
    let cls, glyph, label;
    if (ev.type === 'sweep') {
      cls = 'sweep';
      glyph = ev.dir === 'up' ? '▲' : '▼';
      label = `Sweep ${ev.dir === 'up' ? '↑' : '↓'} cleared prior ${ev.dir === 'up' ? 'high' : 'low'}`;
    } else if (ev.type === 'absorption') {
      cls = 'absorb';
      glyph = '◉';
      label = 'Absorption — high vol, compressed range';
    } else if (ev.type === 'stoprun') {
      cls = 'stop';
      glyph = '⚡';
      label = `Stop run — sweep ${ev.dir === 'up' ? '↑' : '↓'} reversed`;
    } else if (ev.type === 'divergence') {
      cls = 'diverge';
      glyph = '⚠';
      label = `Divergence — new ${ev.dir === 'up' ? 'high' : 'low'}, Δ disagrees`;
    }
    // Phase 6: events don't carry canonical-tag context (alignment is
    // computed only on fires), so the align cell is an empty placeholder
    // to keep column widths consistent.
    return `<div class="event-row ${cls}">
      <span class="time">${tStr}</span>
      <span class="glyph">${glyph}</span>
      <span class="label">${label}</span>
      <span class="align"></span>
      <span class="price">${ev.price.toFixed(2)}</span>
    </div>`;
  }).join('');
}

// Plan §4c-d: delegated click handler. Bound once from main.js. Fire
// rows trigger selectFire(); the selection banner row clears.
function bindEventLogClicks() {
  const log = document.getElementById('eventLog');
  if (!log) return;
  log.addEventListener('click', (e) => {
    const clearRow = e.target.closest('[data-clear-selection]');
    if (clearRow) {
      clearSelection();
      return;
    }
    const fireRow = e.target.closest('[data-fire-ms]');
    if (!fireRow) return;
    const ms = +fireRow.dataset.fireMs;
    const id = fireRow.dataset.fireId;
    // Find the actual fire object so selectFire can resolve its bar.
    const fires = state.replay.mode === 'real' && state.replay.allFires.length
      ? state.replay.allFires
      : state.canonicalFires;
    const fire = fires.find(f => {
      const fms = f.barTime instanceof Date ? f.barTime.getTime() : Date.parse(f.barTime);
      return fms === ms && f.watchId === id;
    });
    if (fire) selectFire(fire);
  });
}

function bindEventLogFilters() {
  const typeSel = document.getElementById('eventLogTypeFilter');
  if (!typeSel) return;
  typeSel.value = state.eventLogFilter.type || 'all';
  typeSel.addEventListener('change', () => {
    state.eventLogFilter.type = typeSel.value || 'all';
    renderEventLog();
  });
}

export { renderEventLog, bindEventLogClicks, bindEventLogFilters };
