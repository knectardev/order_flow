/**
 * Collapsible dashboard sections with persisted expanded/collapsed state (localStorage).
 * The main price chart section is not collapsible (see HTML).
 */
const STORAGE_KEY = 'orderflow_dashboard_section_collapsed';

function loadMap() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch (_) {
    return {};
  }
}

function saveMap(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (_) { /* quota / private mode */ }
}

export function initSectionCollapse() {
  const saved = loadMap();

  document.querySelectorAll('.section--collapsible[data-section-key]').forEach((section) => {
    const key = section.dataset.sectionKey;
    const btn = section.querySelector('.section-collapse-btn');
    const body = section.querySelector('.section-body');
    if (!btn || !body || !key) return;

    const title = btn.dataset.sectionTitle || 'section';

    const syncUi = () => {
      const isCollapsed = section.classList.contains('is-collapsed');
      btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      btn.setAttribute('aria-label', isCollapsed ? `Expand ${title}` : `Collapse ${title}`);
    };

    if (saved[key] === true) section.classList.add('is-collapsed');
    syncUi();

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      section.classList.toggle('is-collapsed');
      const isCollapsed = section.classList.contains('is-collapsed');
      syncUi();
      saved[key] = isCollapsed;
      saveMap(saved);
    });
  });
}
