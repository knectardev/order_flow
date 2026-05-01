/** Centered PHAT legend dialog — opens from `#phatLegendOpenBtn`, closes via X, backdrop, or Escape. */

let _lastFocus = null;

function _overlayEl() {
  return document.getElementById('phatLegendModalOverlay');
}

export function isPhatLegendModalOpen() {
  const el = _overlayEl();
  return !!(el && !el.hasAttribute('hidden'));
}

function openPhatLegendModal() {
  const overlay = _overlayEl();
  const panel = document.getElementById('phatLegendModalPanel');
  const closeBtn = document.getElementById('phatLegendModalCloseBtn');
  if (!overlay || !panel || !closeBtn) return;
  if (isPhatLegendModalOpen()) return;
  _lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay.removeAttribute('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('phat-legend-modal-active');
  closeBtn.focus();
}

function closePhatLegendModal() {
  const overlay = _overlayEl();
  if (!overlay || !isPhatLegendModalOpen()) return;
  overlay.setAttribute('hidden', '');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('phat-legend-modal-active');
  const openBtn = document.getElementById('phatLegendOpenBtn');
  if (_lastFocus && typeof _lastFocus.focus === 'function') {
    try {
      _lastFocus.focus();
    } catch (_) { /* noop */ }
  } else if (openBtn) {
    openBtn.focus();
  }
  _lastFocus = null;
}

export function bindPhatLegendModal() {
  const openBtn = document.getElementById('phatLegendOpenBtn');
  const overlay = _overlayEl();
  const panel = document.getElementById('phatLegendModalPanel');
  const closeBtn = document.getElementById('phatLegendModalCloseBtn');
  if (!openBtn || !overlay || !panel || !closeBtn) return;

  openBtn.addEventListener('click', (e) => {
    e.preventDefault();
    openPhatLegendModal();
  });

  closeBtn.addEventListener('click', () => closePhatLegendModal());

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePhatLegendModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!isPhatLegendModalOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    closePhatLegendModal();
  }, true);
}
