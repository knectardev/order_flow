// In-panel copy for CVD–price divergence connectors (see `src/render/cvdChart.js` drawing rules).
import { state } from '../state.js';

function _stampKey(d) {
  return [
    Number(d.minPriceDelta),
    Number(d.minCvdDelta),
    Number(d.maxSwingBarDistance),
    Number(d.swingLookback),
  ].join('|');
}

/** Refresh threshold line under the Delta / CVD canvases from `replay.allDivergences`. */
export function updateCvdDivergenceLegend() {
  const el = document.getElementById('cvdDivLegendThresholds');
  if (!el) return;

  if (state.replay.mode !== 'real') {
    el.textContent =
      'API replay: connectors use pipeline rows from DuckDB. Threshold stamps appear after bars load.';
    return;
  }

  const divs = state.replay.allDivergences || [];
  if (divs.length === 0) {
    el.textContent =
      'No pipeline divergences in the loaded date window for this timeframe — lines appear when matching rows exist (ingest or recompute-divergences).';
    return;
  }

  const d0 = divs[0];
  const mp = Number(d0.minPriceDelta);
  const mc = Number(d0.minCvdDelta);
  const mb = Number(d0.maxSwingBarDistance);
  const k = Number(d0.swingLookback);
  const mpStr = Number.isFinite(mp) ? (Number.isInteger(mp) ? String(mp) : mp.toFixed(2).replace(/\.?0+$/, '')) : '—';

  const keys = new Set(divs.map(_stampKey));
  const suffix =
    keys.size > 1
      ? ' Some rows use different stamps — hover a connector for that row.'
      : '';

  el.textContent =
    `Threshold stamps on stored rows (example from first row in window): min price Δ ${mpStr} pts · min CVD Δ ${Number.isFinite(mc) ? mc.toLocaleString() : '—'} contracts · max swing bar distance ${Number.isFinite(mb) ? mb : '—'} · swing K ${Number.isFinite(k) ? k : '—'}.${suffix}`;
}
