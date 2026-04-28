import { ABSORPTION_WALL_LABELS, BREAKOUT_LABELS, FADE_LABELS } from '../config/constants.js';
import { state } from '../state.js';

function renderWatchPanel(prefix, criterionKeys, labels, watchState, canonical, renderOpts = null) {
  const skipWatchMutation = !!(renderOpts && renderOpts.fromFireSnapshot);
  if (!skipWatchMutation) {
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
  }

  // DOM updates only if this watch's modal is currently open.
  if (state.currentModal !== prefix) return;

  // The modal uses `modalMetaNum` in the panel head; a legacy `fadeMatchNum` slot
  // is optional. Never skip the checklist when the match id is absent.
  const matchEl = document.getElementById(prefix + 'MatchNum');
  if (matchEl) matchEl.textContent = canonical.passing;

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
    // Phase 6: when the canonical is fully armed, surface the
    // anchor-priority tag so the user can see HTF context at a glance:
    //   HIGH_CONVICTION  -> normal "fire armed"
    //   STANDARD         -> normal "fire armed"
    //   LOW_CONVICTION   -> "fire armed (CAUTION: HTF mixed)"
    //   SUPPRESSED       -> "filtered by HTF (1h opposes)"
    let tail = '';
    if (canonical.tag === 'SUPPRESSED') {
      tail = ' (filtered by HTF — 1h opposes)';
    } else if (canonical.tag === 'LOW_CONVICTION') {
      tail = ' (CAUTION — HTF mixed)';
    } else if (canonical.tag === 'HIGH_CONVICTION') {
      tail = ' (HIGH conviction — HTF aligned)';
    }
    diagVal.textContent = `all ${canonical.total} criteria met — fire armed${tail}`;
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

function renderBreakoutWatch(canonical, renderOpts) {
  renderWatchPanel('breakout', ['cell','sweep','flow','clean','alignment'],
                    BREAKOUT_LABELS, state.breakoutWatch, canonical, renderOpts);
}

function renderFadeWatch(canonical, renderOpts) {
  renderWatchPanel('fade', ['balanced','cell','stretchPOC','stretchVWAP','noMomentum','alignment'],
                    FADE_LABELS, state.fadeWatch, canonical, renderOpts);
}

function renderAbsorptionWallWatch(canonical, renderOpts) {
  renderWatchPanel('absorptionWall', ['cell', 'stall', 'volume', 'level', 'alignment'],
                    ABSORPTION_WALL_LABELS, state.absorptionWallWatch, canonical, renderOpts);
}

export { renderWatchPanel, renderBreakoutWatch, renderFadeWatch, renderAbsorptionWallWatch };
