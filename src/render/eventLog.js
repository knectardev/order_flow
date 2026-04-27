import { state } from '../state.js';

function renderEventLog() {
  const log = document.getElementById('eventLog');
  if (state.events.length === 0) {
    log.innerHTML = '<div class="empty">no events yet — events fire only on specific microstructural patterns, not every bar</div>';
    document.getElementById('eventCount').textContent = '—';
    return;
  }
  document.getElementById('eventCount').textContent =
    `${state.events.length} event${state.events.length===1?'':'s'}`;

  const recent = state.events.slice(-10).reverse();
  log.innerHTML = recent.map(ev => {
    const t = ev.time;
    const tStr = t.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
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

export { renderEventLog };
