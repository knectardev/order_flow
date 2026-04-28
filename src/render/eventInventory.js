import { state } from '../state.js';

const FIRE_META = [
  { id: 'breakout', label: 'Breakout ★' },
  { id: 'fade', label: 'Fade ◆' },
  { id: 'absorptionWall', label: 'Absorption Wall 🛡' },
  { id: 'valueEdgeReject', label: 'Value Edge 🎯' },
];

/** Stable labels for primitive flow events (matches precompute keys). */
const EVENT_ORDER = [
  { key: 'sweep up', label: 'Sweep · up' },
  { key: 'sweep down', label: 'Sweep · down' },
  { key: 'absorption', label: 'Absorption' },
  { key: 'divergence up', label: 'Divergence · up' },
  { key: 'divergence down', label: 'Divergence · down' },
  { key: 'stoprun up', label: 'Stop run · up' },
  { key: 'stoprun down', label: 'Stop run · down' },
];

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function eventAggKey(ev) {
  if (!ev || ev.type === 'absorption') return 'absorption';
  const d = ev.dir ? ` ${ev.dir}` : '';
  return `${ev.type}${d}`;
}

function renderRows(rows, max) {
  const m = Math.max(max, 1);
  return rows.map(({ label, count }) => {
    const pct = Math.round((count / m) * 100);
    return `<div class="inv-row">
      <span class="inv-label">${esc(label)}</span>
      <div class="inv-bar-track" aria-hidden="true"><div class="inv-bar-fill" style="width:${pct}%"></div></div>
      <span class="inv-num">${count}</span>
    </div>`;
  }).join('');
}

/**
 * Full-dataset histogram for API replay: counts every primitive in
 * `state.replay.allEvents` and every canonical fire in `state.replay.allFires`
 * after `precomputeAllEvents` / `precomputeAllFires`. Synthetic mode has no
 * full-timeline store — show an empty-state note instead.
 */
export function renderEventInventory() {
  const root = document.getElementById('eventInventory');
  if (!root) return;

  const real = state.replay.mode === 'real' && state.replay.allBars?.length;

  if (!real) {
    root.innerHTML = '<p class="inv-empty">Open with <code>?source=api</code> to load sessions; counts cover all loaded bars at the active timeframe.</p>';
    return;
  }

  const events = state.replay.allEvents || [];
  const fires = state.replay.allFires || [];
  const tf = (state.activeTimeframe || '1m').toUpperCase();

  const eventCounts = new Map();
  for (const ev of events) {
    const k = eventAggKey(ev);
    eventCounts.set(k, (eventCounts.get(k) || 0) + 1);
  }

  const fireCounts = new Map();
  for (const f of fires) {
    const id = f.watchId || 'unknown';
    fireCounts.set(id, (fireCounts.get(id) || 0) + 1);
  }

  const eventRows = [];
  const seen = new Set();
  for (const { key, label } of EVENT_ORDER) {
    const count = eventCounts.get(key) || 0;
    eventRows.push({ label, count });
    seen.add(key);
  }
  const extras = [...eventCounts.keys()].filter(k => !seen.has(k)).sort();
  for (const key of extras) {
    eventRows.push({ label: key, count: eventCounts.get(key) });
  }

  const knownFire = new Set(FIRE_META.map(m => m.id));
  const fireRows = FIRE_META.map(({ id, label }) => ({
    label,
    count: fireCounts.get(id) || 0,
  }));
  for (const [id, count] of fireCounts) {
    if (!knownFire.has(id)) fireRows.push({ label: id, count });
  }

  const max = Math.max(
    ...eventRows.map(r => r.count),
    ...fireRows.map(r => r.count),
    1,
  );

  const nPrim = events.length;
  const nFire = fires.length;

  root.innerHTML = `
    <div class="inv-summary">${esc(tf)} · ${esc(String(state.replay.allBars.length))} bars · primitives <strong>${nPrim}</strong> · fires <strong>${nFire}</strong></div>
    <div class="inv-group">
      <div class="inv-group-title">Flow primitives</div>
      ${renderRows(eventRows, max)}
    </div>
    <div class="inv-group">
      <div class="inv-group-title">Canonical fires</div>
      ${renderRows(fireRows, max)}
    </div>
  `;
}
