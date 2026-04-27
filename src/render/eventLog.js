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
  return fire.watchId === 'fade'
    ? `Fade fire ${dirArrow} mean-revert to POC`
    : `Breakout fire ${dirArrow} impulsive light`;
}

function renderEventLog() {
  const log = document.getElementById('eventLog');
  const warmupHtml = state.regimeWarmup ? SYSTEM_WARMUP_HTML : '';
  const selBanner  = _selectionBannerHtml();

  // ── Build a unified, time-ordered row list (events + canonical fires).
  // Plan §4c-d: fires are clickable rows in the log so they can serve as
  // the brushing entry point alongside chart-fire-halo clicks.
  const fires = state.replay.mode === 'real' && state.replay.allFires.length
    ? state.replay.allFires
    : state.canonicalFires;

  const fireRows = fires.map(f => ({
    kind: 'fire',
    time: f.barTime instanceof Date ? f.barTime : new Date(f.barTime),
    payload: f,
  }));
  const evRows = state.events.map(ev => ({
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

  const merged = [...evRows, ...fireRows]
    .filter(filterPredicate)
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  if (merged.length === 0) {
    const emptyMsg = sel.kind
      ? '<div class="empty">no events or fires in the selected window</div>'
      : '<div class="empty">no events yet — events fire only on specific microstructural patterns, not every bar</div>';
    log.innerHTML = warmupHtml + selBanner + emptyMsg;
    document.getElementById('eventCount').textContent =
      state.regimeWarmup ? 'warming up' : (sel.kind ? '0 in selection' : '—');
    return;
  }

  document.getElementById('eventCount').textContent = sel.kind
    ? `${merged.length} in selection`
    : `${state.events.length} event${state.events.length===1?'':'s'}` +
      (fires.length ? ` · ${fires.length} fire${fires.length===1?'':'s'}` : '');

  // Show most recent 15 in reverse chronological order so the latest
  // sits at the top, matching the prior event-only behavior. Slight bump
  // (was 10) since fires can crowd the visible slice.
  const recent = merged.slice(-15).reverse();
  log.innerHTML = warmupHtml + selBanner + recent.map(row => {
    const tStr = row.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (row.kind === 'fire') {
      const f = row.payload;
      const isFade = f.watchId === 'fade';
      const cls = isFade ? 'fire-fade' : 'fire-breakout';
      const glyph = isFade ? '◆' : '★';
      const ms = row.time.getTime();
      return `<div class="event-row event-row-fire ${cls}" data-fire-ms="${ms}" data-fire-id="${f.watchId}">
        <span class="time">${tStr}</span>
        <span class="glyph">${glyph}</span>
        <span class="label">${_fireLabel(f)}</span>
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
    return `<div class="event-row ${cls}">
      <span class="time">${tStr}</span>
      <span class="glyph">${glyph}</span>
      <span class="label">${label}</span>
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

export { renderEventLog, bindEventLogClicks };
