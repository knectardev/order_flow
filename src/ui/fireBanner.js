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

  banner.classList.remove('fade-variant', 'breakout-variant');
  if (watchId === 'fade') {
    banner.classList.add('fade-variant');
    icon.textContent = '◆';
    headline.textContent = `Fade canonical fired · stream paused`;
    detail.textContent = `[${cellDef.name}] · stretch ${canonical.stretchDir === 'up' ? '↑' : '↓'} from POC + VWAP · all 4 criteria met. Predicts ${arrow} drift back toward POC within ~25-40 bars.`;
  } else {
    banner.classList.add('breakout-variant');
    icon.textContent = '⚡';
    headline.textContent = `Breakout canonical fired · stream paused`;
    detail.textContent = `[${cellDef.name}] · sweep ${dir} · all 4 criteria met. Predicts ${arrow} travel toward next structural level within ~15 bars.`;
  }
  banner.classList.add('visible');
}

function dismissFire() {
  document.getElementById('fireBanner').classList.remove('visible');
  toggleStream();
}

function openFireDetails() {
  if (state.lastFiredWatch) openModal(state.lastFiredWatch);
}

export { pauseForFire, dismissFire, openFireDetails };
