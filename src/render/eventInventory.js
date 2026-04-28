import { loadEventsForActiveTypes } from '../data/replay.js';
import { state } from '../state.js';
import { drawPriceChart } from './priceChart.js';
import { renderEventLog } from './eventLog.js';

const URL_PARAM_DISPLAY_EVENTS = 'displayEvents';
const URL_PARAM_DISPLAY_FIRES = 'displayFires';

const FIRE_META = [
  { id: 'breakout', label: 'Breakout ★', glyph: '★', short: 'Impulsive breakout: matrix cell + momentum + cleanliness gates align.' },
  { id: 'fade', label: 'Fade ◆', glyph: '◆', short: 'Mean-reversion after stretch: balance, stretch vs POC/VWAP, no momentum.' },
  { id: 'absorptionWall', label: 'Absorption Wall 🛡', glyph: '🛡', short: 'Climactic defense: stalled auction, volume at level vs baseline.' },
  { id: 'valueEdgeReject', label: 'Value Edge 🎯', glyph: '🎯', short: 'Failed auction at VAH/VAL: rejection wick + flow confirmation.' },
];

/** Matches keys in glossary / precompute (`sweep up`, …). Modal ids match `src/ui/modal.js`. */
const EVENT_ORDER = [
  { key: 'sweep up', label: 'Sweep · up', modal: 'sweep', glyph: '▲', short: 'Bar takes out a recent high with elevated volume (up).' },
  { key: 'sweep down', label: 'Sweep · down', modal: 'sweep', glyph: '▼', short: 'Bar takes out a recent low with elevated volume (down).' },
  { key: 'absorption', label: 'Absorption', modal: 'absorption', glyph: '◉', short: 'High volume in a tight range — absorption vs continuation.' },
  { key: 'divergence up', label: 'Divergence · up', modal: 'divergence', glyph: '⚠', short: 'New high but cumulative delta disagrees (up).' },
  { key: 'divergence down', label: 'Divergence · down', modal: 'divergence', glyph: '⚠', short: 'New low but cumulative delta disagrees (down).' },
  { key: 'stoprun up', label: 'Stop run · up', modal: 'stoprun', glyph: '⚡', short: 'Sweep followed by full reversal — often stop-driven (up).' },
  { key: 'stoprun down', label: 'Stop run · down', modal: 'stoprun', glyph: '⚡', short: 'Sweep followed by full reversal — often stop-driven (down).' },
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

/** Best-effort modal + copy for dynamic / extra primitive keys. */
function metaForExtraKey(key) {
  const k = String(key);
  if (k.startsWith('sweep')) return { modal: 'sweep', glyph: '▲▼', short: 'Price sweeps a recent extreme with elevated volume.' };
  if (k.startsWith('stoprun')) return { modal: 'stoprun', glyph: '⚡', short: 'Sweep that fully reverses the next bar — late trap risk.' };
  if (k.startsWith('divergence')) return { modal: 'divergence', glyph: '⚠', short: 'New extreme without delta confirmation.' };
  if (k === 'absorption') return { modal: 'absorption', glyph: '◉', short: 'High volume in a compressed range.' };
  return { modal: null, glyph: '·', short: 'See event log for detection detail.' };
}

function renderMergedPrimitiveRow(label, short, glyph, modalKey, count, max, glossaryKey) {
  const pct = Math.round((count / Math.max(max, 1)) * 100);
  const active = glossaryKey && state.activeEventTypes?.has(glossaryKey);
  const cb = glossaryKey
    ? `<input type="checkbox" class="inv-cb" data-inv-kind="event" data-inv-key="${encodeURIComponent(glossaryKey)}" ${active ? 'checked' : ''} aria-label="Load ${esc(label)} markers" />`
    : '<span class="inv-cb-slot"></span>';
  const nameCell = modalKey
    ? `<button type="button" class="inv-name-btn" data-modal="${esc(modalKey)}">${esc(label)}</button>`
    : `<span class="inv-name-text">${esc(label)}</span>`;
  return `<div class="inv-row inv-row--merged">
    ${cb}
    <span class="inv-glyph-col" aria-hidden="true">${esc(glyph)}</span>
    <div class="inv-name-stack">${nameCell}</div>
    <span class="inv-desc-short">${esc(short)}</span>
    <div class="inv-bar-track" aria-hidden="true"><div class="inv-bar-fill" style="width:${pct}%"></div></div>
    <span class="inv-num">${count}</span>
  </div>`;
}

function renderMergedFireRow(label, short, glyph, modalKey, watchId, count, max) {
  const pct = Math.round((count / Math.max(max, 1)) * 100);
  const active = watchId && state.activeCanonicalFireTypes?.has(watchId);
  const cb = watchId
    ? `<input type="checkbox" class="inv-cb" data-inv-kind="fire" data-inv-watch="${encodeURIComponent(watchId)}" ${active ? 'checked' : ''} aria-label="Show ${esc(label)} halos" />`
    : '<span class="inv-cb-slot"></span>';
  const nameCell = modalKey
    ? `<button type="button" class="inv-name-btn" data-modal="${esc(modalKey)}">${esc(label)}</button>`
    : `<span class="inv-name-text">${esc(label)}</span>`;
  return `<div class="inv-row inv-row--merged">
    ${cb}
    <span class="inv-glyph-col" aria-hidden="true">${esc(glyph)}</span>
    <div class="inv-name-stack">${nameCell}</div>
    <span class="inv-desc-short">${esc(short)}</span>
    <div class="inv-bar-track" aria-hidden="true"><div class="inv-bar-fill" style="width:${pct}%"></div></div>
    <span class="inv-num">${count}</span>
  </div>`;
}

function _syncDisplayStateToUrl() {
  const url = new URL(window.location.href);
  const p = url.searchParams;
  p.delete(URL_PARAM_DISPLAY_EVENTS);
  p.delete(URL_PARAM_DISPLAY_FIRES);

  const eventKeys = [...(state.activeEventTypes || new Set())]
    .map(String)
    .filter(Boolean)
    .sort();
  const fireKeys = [...(state.activeCanonicalFireTypes || new Set())]
    .map(String)
    .filter(Boolean)
    .sort();

  if (eventKeys.length) p.set(URL_PARAM_DISPLAY_EVENTS, eventKeys.join(','));
  if (fireKeys.length) p.set(URL_PARAM_DISPLAY_FIRES, fireKeys.join(','));
  window.history.replaceState(null, '', url);
}

function _parseCsvParam(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

let _invDelegateBound = false;
function _ensureInventoryDelegate() {
  if (_invDelegateBound) return;
  _invDelegateBound = true;
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.classList.contains('inv-cb')) return;
    const kind = t.getAttribute('data-inv-kind') || 'event';
    if (kind === 'fire') {
      const raw = t.getAttribute('data-inv-watch');
      if (!raw) return;
      const w = decodeURIComponent(raw);
      if (t.checked) state.activeCanonicalFireTypes.add(w);
      else state.activeCanonicalFireTypes.delete(w);
      _syncDisplayStateToUrl();
      drawPriceChart();
      renderEventLog();
      renderEventInventory();
      return;
    }
    const raw = t.getAttribute('data-inv-key');
    if (!raw) return;
    const key = decodeURIComponent(raw);
    if (t.checked) state.activeEventTypes.add(key);
    else state.activeEventTypes.delete(key);
    _syncDisplayStateToUrl();
    await loadEventsForActiveTypes();
  });
}

async function restoreDisplayStateFromUrl() {
  const p = new URL(window.location.href).searchParams;
  const eventKeys = _parseCsvParam(p.get(URL_PARAM_DISPLAY_EVENTS));
  const fireKeys = _parseCsvParam(p.get(URL_PARAM_DISPLAY_FIRES));
  if (!eventKeys.length && !fireKeys.length) return false;

  state.activeEventTypes = new Set(eventKeys);
  state.activeCanonicalFireTypes = new Set(fireKeys);
  _syncDisplayStateToUrl();
  await loadEventsForActiveTypes();
  return true;
}

/**
 * Full-dataset histogram for API replay: one table with glossary copy, counts,
 * primitive load toggles, and canonical fire halo toggles.
 */
export function renderEventInventory() {
  const root = document.getElementById('eventInventory');
  if (!root) return;

  const real = state.replay.mode === 'real' && state.replay.allBars?.length;

  _ensureInventoryDelegate();

  if (!real) {
    root.innerHTML = '<p class="inv-empty">Open with <code>?source=api</code> for full-timeline replay. Check primitives to load markers; check canonical fires for chart halos.</p>';
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

  const knownFire = new Set(FIRE_META.map(m => m.id));
  const fireRows = FIRE_META.map(({ id, label, glyph, short }) => ({
    label,
    short,
    glyph,
    watchId: id,
    modalKey: id,
    count: fireCounts.get(id) || 0,
  }));
  for (const [id, count] of fireCounts) {
    if (!knownFire.has(id)) {
      fireRows.push({
        label: id,
        short: 'Canonical entry from API (see modal when wired).',
        glyph: '·',
        watchId: id,
        modalKey: null,
        count,
      });
    }
  }

  const evVals = [...eventCounts.values()];
  const fiVals = [...fireCounts.values()];
  const maxEvent = evVals.length ? Math.max(...evVals) : 0;
  const maxFire = fiVals.length ? Math.max(...fiVals) : 0;
  const max = Math.max(maxEvent, maxFire, 1);
  const eventRowsFinal = [];
  const seen = new Set();
  for (const { key, label, modal, glyph, short } of EVENT_ORDER) {
    const count = eventCounts.get(key) || 0;
    eventRowsFinal.push(renderMergedPrimitiveRow(label, short, glyph, modal, count, max, key));
    seen.add(key);
  }
  const extras = [...eventCounts.keys()].filter(k => !seen.has(k)).sort();
  for (const key of extras) {
    const meta = metaForExtraKey(key);
    const count = eventCounts.get(key) || 0;
    eventRowsFinal.push(renderMergedPrimitiveRow(key, meta.short, meta.glyph, meta.modal, count, max, key));
  }

  const fireRowsFinal = fireRows.map((r) =>
    renderMergedFireRow(r.label, r.short, r.glyph, r.modalKey, r.watchId, r.count, max),
  );

  const nPrim = events.length;
  const nFire = fires.length;
  const primSummary = state.activeEventTypes?.size
    ? [...state.activeEventTypes].join(', ')
    : '(none)';
  const fireSummary = state.activeCanonicalFireTypes?.size
    ? [...state.activeCanonicalFireTypes].join(', ')
    : '(none)';

  root.innerHTML = `
    <div class="inv-summary">${esc(tf)} · ${esc(String(state.replay.allBars.length))} bars · primitives loaded <strong>${nPrim}</strong> (active: ${esc(primSummary)}) · fires <strong>${nFire}</strong> (halos: ${esc(fireSummary)})</div>
    <div class="inv-table-head" aria-hidden="true">
      <span></span><span class="inv-h-glyph"></span><span class="inv-h-name">Signal</span><span class="inv-h-desc">What it measures</span><span class="inv-h-share">Share</span><span class="inv-h-num">#</span>
    </div>
    <div class="inv-group">
      <div class="inv-group-title">Canonical entries · chart halos</div>
      ${fireRowsFinal.join('')}
    </div>
    <div class="inv-group">
      <div class="inv-group-title">Flow primitives · load markers</div>
      ${eventRowsFinal.join('')}
    </div>
  `;
}

export { restoreDisplayStateFromUrl };
