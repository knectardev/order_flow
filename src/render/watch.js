import { BREAKOUT_LABELS, FADE_LABELS } from '../config/constants.js';
import { state } from '../state.js';

function renderWatchPanel(prefix, criterionKeys, labels, watchState, canonical) {
  // Always track TRUE→FALSE flips per criterion regardless of modal visibility,
  // so the diagnostic stays accurate when the modal is reopened.
  if (watchState.lastCanonical) {
    for (const key of criterionKeys) {
      if (watchState.lastCanonical.checks[key] && !canonical.checks[key]) {
        watchState.flipTicks[key] = state.sim.tick;
      }
    }
  }
  watchState.lastCanonical = { checks: { ...canonical.checks } };

  // DOM updates only if this watch's modal is currently open.
  if (state.currentModal !== prefix) return;

  const matchEl = document.getElementById(prefix + 'MatchNum');
  if (!matchEl) return;
  matchEl.textContent = canonical.passing;

  const items = document.querySelectorAll('#' + prefix + 'CriteriaList .criterion');
  items.forEach(li => {
    const k = li.dataset.key;
    const met = !!canonical.checks[k];
    li.classList.toggle('met', met);
    li.querySelector('.check').textContent = met ? '✓' : '○';
  });

  const diag = document.getElementById(prefix + 'Diagnostic');
  const diagVal = document.getElementById(prefix + 'DiagValue');
  if (!diag || !diagVal) return;
  diag.classList.remove('active', 'all-met');

  if (canonical.passing === canonical.total) {
    diag.classList.add('all-met');
    diagVal.textContent = `all ${canonical.total} criteria met — fire armed`;
  } else {
    let mostRecent = null;
    for (const key of criterionKeys) {
      const t = watchState.flipTicks[key];
      if (t === null) continue;
      if (canonical.checks[key]) continue;
      if (mostRecent === null || t > mostRecent.tick) {
        mostRecent = { key, tick: t };
      }
    }
    if (mostRecent) {
      const ago = state.sim.tick - mostRecent.tick;
      diag.classList.add('active');
      diagVal.textContent = `${labels[mostRecent.key]} · ${ago} tick${ago === 1 ? '' : 's'} ago`;
    } else {
      diagVal.textContent = canonical.passing === 0
        ? 'no criteria yet met'
        : `${canonical.passing}/${canonical.total} — none broken from prior true state`;
    }
  }

  // Update the meta count in modal head
  const metaNum = document.getElementById('modalMetaNum');
  if (metaNum) metaNum.textContent = canonical.passing;
}

function renderBreakoutWatch(canonical) {
  renderWatchPanel('breakout', ['cell','sweep','flow','clean'],
                    BREAKOUT_LABELS, state.breakoutWatch, canonical);
}

function renderFadeWatch(canonical) {
  renderWatchPanel('fade', ['balanced','cell','stretchPOC','stretchVWAP','noMomentum'],
                    FADE_LABELS, state.fadeWatch, canonical);
}

export { renderWatchPanel, renderBreakoutWatch, renderFadeWatch };
