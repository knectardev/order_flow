import { state } from '../state.js';
import { toggleStream } from './controls.js';
import { openModal } from './modal.js';

function pauseForFire(watchId, canonical, cellDef) {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
    document.getElementById('streamBtn').textContent = 'Resume Stream';
  }
  state.lastFiredWatch = watchId;
  const banner = document.getElementById('fireBanner');
  const headline = document.getElementById('fireHeadline');
  const detail = document.getElementById('fireDetail');
  const icon   = document.getElementById('fireIcon');
  const dir    = canonical.direction === 'up' ? '↑' : '↓';
  const arrow  = canonical.direction === 'up' ? 'upward' : 'downward';

  banner.classList.remove('fade-variant', 'breakout-variant', 'absorption-wall-variant', 'value-edge-variant');
  if (watchId === 'fade') {
    banner.classList.add('fade-variant');
    icon.textContent = '◆';
    headline.textContent = `Fade canonical fired · stream paused`;
    detail.textContent = `[${cellDef.name}] · stretch ${canonical.stretchDir === 'up' ? '↑' : '↓'} from POC + VWAP · all 6 criteria met. Predicts ${arrow} drift back toward POC within ~25-40 bars.`;
  } else if (watchId === 'absorptionWall') {
    banner.classList.add('absorption-wall-variant');
    icon.textContent = '🛡';
    headline.textContent = `Absorption Wall canonical fired · stream paused`;
    detail.textContent = `[${cellDef.name}] · stalled price + vol spike at structure · all 5 criteria met. Expect ${arrow} responsive move off the passive wall.`;
  } else if (watchId === 'valueEdgeReject') {
    banner.classList.add('value-edge-variant');
    icon.textContent = '🎯';
    headline.textContent = `Value Edge Rejection fired · stream paused`;
    const edge = canonical.edge === 'val' ? 'VAL' : (canonical.edge === 'vah' ? 'VAH' : '');
    detail.textContent = edge
      ? `[${cellDef.name}] · failed ${edge} probe, close in VA · all 5 met. ${arrow} toward POC.`
      : `[${cellDef.name}] · all 5 criteria met. ${arrow} toward POC.`;
  } else {
    banner.classList.add('breakout-variant');
    icon.textContent = '⚡';
    headline.textContent = `Breakout canonical fired · stream paused`;
    detail.textContent = `[${cellDef.name}] · sweep ${dir} · all 5 criteria met. Predicts ${arrow} travel toward next structural level within ~15 bars.`;
  }
  banner.classList.add('visible');
}

function dismissFire() {
  document.getElementById('fireBanner').classList.remove('visible');
  toggleStream();
}

function openFireDetails() {
  const w = state.lastFiredWatch;
  if (!w) return;
  const forWatch = state.canonicalFires.filter(f => f.watchId === w);
  const last = forWatch.length ? forWatch[forWatch.length - 1] : null;
  openModal(w, last ? { fire: last } : undefined);
}

export { pauseForFire, dismissFire, openFireDetails };
