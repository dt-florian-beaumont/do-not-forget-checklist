const STYLE_ID = 'dnf-styles';
const DATA_ATTR = 'data-dnf-highlight';
const HEADING_TEXT = 'Reviewer checklist';
const ARROW_UP_ID = 'dnf-arrow-up';
const ARROW_DOWN_ID = 'dnf-arrow-down';

const CSS = `
@keyframes dnf-pulse {
  0%, 100% { box-shadow: 0 0 0 2px #EF4444; transform: translateZ(0); }
  50%      { box-shadow: 0 0 0 4px rgba(239,68,68,0.4); transform: translateZ(0); }
}
@keyframes dnf-bounce-up {
  0%, 100% { transform: translateY(0) scale(1); box-shadow: 0 2px 8px rgba(239,68,68,0.4); }
  50%       { transform: translateY(-7px) scale(1.1); box-shadow: 0 8px 20px rgba(239,68,68,0.6); }
}
@keyframes dnf-bounce-down {
  0%, 100% { transform: translateY(0) scale(1); box-shadow: 0 2px 8px rgba(239,68,68,0.4); }
  50%       { transform: translateY(7px) scale(1.1); box-shadow: 0 8px 20px rgba(239,68,68,0.6); }
}
input[type="checkbox"][${DATA_ATTR}] {
  will-change: transform;
  box-shadow: 0 0 0 2px #EF4444 !important;
  animation: dnf-pulse 1.2s ease-in-out infinite !important;
}
.dnf-arrow {
  position: fixed;
  left: 40px;
  top: 120px;
  width: 64px; height: 64px;
  background: #EF4444; color: white;
  border: none; border-radius: 50%;
  font-size: 32px; cursor: pointer;
  z-index: 10;
  box-shadow: 0 2px 8px rgba(239,68,68,0.4);
  will-change: transform;
}
.dnf-arrow-up { animation: dnf-bounce-up 1s ease-in-out infinite; }
.dnf-arrow-down { animation: dnf-bounce-down 1s ease-in-out infinite; }
`;

let isActive = true;
let debounceTimer = null;
let scrollIo = null;
const ioVisibilityMap = new Map();
const REFRESH_DEBOUNCE_MS = 300;
const CHECKBOX_SETTLE_MS = 700;
let suspendRefreshUntil = 0;
let refreshRafId = 0;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

function findUncheckedReviewerCheckboxes() {
  const results = [];
  for (const heading of document.querySelectorAll('h2')) {
    if (heading.textContent.trim() !== HEADING_TEXT) continue;
    let sibling = heading.nextElementSibling;
    while (sibling) {
      const tag = sibling.tagName.toLowerCase();
      if (tag === 'h1' || tag === 'h2') break;
      for (const cb of sibling.querySelectorAll('input[type="checkbox"]:not(:checked)')) {
        results.push(cb);
      }
      sibling = sibling.nextElementSibling;
    }
  }
  return results;
}

function clearHighlights() {
  document.querySelectorAll(`input[${DATA_ATTR}]`).forEach((cb) => {
    cb.removeAttribute(DATA_ATTR);
  });
}

function createArrowEl(id, direction) {
  const el = document.createElement('button');
  el.id = id;
  el.className = `dnf-arrow dnf-arrow-${direction}`;
  el.textContent = direction === 'up' ? '↑' : '↓';
  el.addEventListener('click', () => scrollToNearestCheckbox(direction));
  return el;
}

/**
 * Find the next highlighted checkbox and scroll to it.
 * It uses element positions to pick the closest one above or below.
 * The final scroll is centered for better reading.
 * @param {'up'|'down'} direction
 */
function scrollToNearestCheckbox(direction) {
  const all = Array.from(document.querySelectorAll(`input[${DATA_ATTR}]`));
  const vh = window.innerHeight;
  const withPos = all.map((el) => ({ el, rect: el.getBoundingClientRect() }));
  let target;
  if (direction === 'up') {
    const above = withPos.filter(({ rect }) => rect.bottom < 0);
    above.sort((a, b) => b.rect.bottom - a.rect.bottom);
    target = above[0]?.el;
  } else {
    const below = withPos.filter(({ rect }) => rect.top > vh);
    below.sort((a, b) => a.rect.top - b.rect.top);
    target = below[0]?.el;
  }
  if (!target) return;
  const top = Math.max(
    0,
    window.scrollY + target.getBoundingClientRect().top - (window.innerHeight / 2) + (target.offsetHeight / 2),
  );
  window.scrollTo({ top, behavior: 'smooth' });
}

function clearArrows() {
  document.getElementById(ARROW_UP_ID)?.remove();
  document.getElementById(ARROW_DOWN_ID)?.remove();
}

function updateScrollIndicators() {
  if (!isActive) {
    clearArrows();
    syncScrollIo([]);
    return;
  }
  const checkboxes = Array.from(document.querySelectorAll(`input[${DATA_ATTR}]`));
  syncScrollIo(checkboxes);
}

function applyHighlights() {
  if (!isActive) return;
  injectStyles();
  const next = new Set(findUncheckedReviewerCheckboxes());
  document.querySelectorAll(`input[${DATA_ATTR}]`).forEach((cb) => {
    if (!next.has(cb)) cb.removeAttribute(DATA_ATTR);
  });
  next.forEach((cb) => {
    if (!cb.hasAttribute(DATA_ATTR)) cb.setAttribute(DATA_ATTR, '');
  });
  updateScrollIndicators();
}

function refresh() {
  if (isActive) {
    applyHighlights();
  } else {
    clearHighlights();
    clearArrows();
    removeStyles();
    syncScrollIo([]);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TOGGLE') {
    isActive = message.active;
    refresh();
  }
});

function scheduleRefresh(delay = REFRESH_DEBOUNCE_MS) {
  clearTimeout(debounceTimer);
  const wait = Math.max(delay, suspendRefreshUntil - Date.now(), 0);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    /**
     * Two requestAnimationFrame calls help us wait until
     * GitHub finishes its own render and scroll restore.
     */
    requestAnimationFrame(() => requestAnimationFrame(refresh));
  }, wait);
}

/**
 * Queue one refresh per frame.
 * This avoids duplicate refresh calls when Turbo events
 * fire very close to each other.
 */
function queueRefresh() {
  if (refreshRafId) return;
  refreshRafId = requestAnimationFrame(() => {
    refreshRafId = 0;
    refresh();
  });
}

document.addEventListener('change', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
  suspendRefreshUntil = Date.now() + CHECKBOX_SETTLE_MS;
  scheduleRefresh(CHECKBOX_SETTLE_MS);
}, true);

const observer = new MutationObserver(() => {
  scheduleRefresh();
});

function connectObserver() {
  observer.observe(document.body, { childList: true, subtree: true });
}

document.addEventListener('turbo:before-render', (e) => {
  if (e.detail?.renderMethod === 'replace') {
    observer.disconnect();
    clearTimeout(debounceTimer);
    debounceTimer = null;
    if (refreshRafId) {
      cancelAnimationFrame(refreshRafId);
      refreshRafId = 0;
    }
    suspendRefreshUntil = 0;
    scrollIo?.disconnect();
    scrollIo = null;
    ioVisibilityMap.clear();
  }
});

document.addEventListener('turbo:load', () => {
  connectObserver();
  queueRefresh();
});
document.addEventListener('turbo:render', () => {
  queueRefresh();
});

/**
 * Keep IntersectionObserver targets in sync with current checkboxes.
 * It updates arrow visibility using cached visibility state to avoid
 * heavy scroll listeners and extra layout work.
 * @param {HTMLInputElement[]} checkboxes
 */
function syncScrollIo(checkboxes) {
  const set = new Set(checkboxes);
  const prev = new Set(scrollIo ? ioVisibilityMap.keys() : []);
  if (set.size === 0) {
    scrollIo?.disconnect();
    scrollIo = null;
    ioVisibilityMap.clear();
    clearArrows();
    return;
  }
  const vh = window.innerHeight;
  const updateFromEntries = (entries) => {
    for (const e of entries) {
      const { bottom, top } = e.boundingClientRect;
      ioVisibilityMap.set(e.target, { above: bottom < 0, below: top > vh });
    }
    const hasAbove = [...ioVisibilityMap.values()].some((v) => v.above);
    const hasBelow = [...ioVisibilityMap.values()].some((v) => v.below);
    if (hasAbove && !document.getElementById(ARROW_UP_ID))
      document.body.appendChild(createArrowEl(ARROW_UP_ID, 'up'));
    else if (!hasAbove) document.getElementById(ARROW_UP_ID)?.remove();
    if (hasBelow && !document.getElementById(ARROW_DOWN_ID))
      document.body.appendChild(createArrowEl(ARROW_DOWN_ID, 'down'));
    else if (!hasBelow) document.getElementById(ARROW_DOWN_ID)?.remove();
  };
  if (!scrollIo) {
    scrollIo = new IntersectionObserver(updateFromEntries, { root: null, rootMargin: '0px', threshold: 0 });
  }
  for (const el of prev) {
    if (!set.has(el)) {
      scrollIo.unobserve(el);
      ioVisibilityMap.delete(el);
    }
  }
  for (const el of set) {
    if (!prev.has(el)) {
      const rect = el.getBoundingClientRect();
      ioVisibilityMap.set(el, { above: rect.bottom < 0, below: rect.top > vh });
      scrollIo.observe(el);
    }
  }
  if (set.size > 0) {
    const hasAbove = [...ioVisibilityMap.values()].some((v) => v.above);
    const hasBelow = [...ioVisibilityMap.values()].some((v) => v.below);
    if (hasAbove && !document.getElementById(ARROW_UP_ID))
      document.body.appendChild(createArrowEl(ARROW_UP_ID, 'up'));
    else if (!hasAbove) document.getElementById(ARROW_UP_ID)?.remove();
    if (hasBelow && !document.getElementById(ARROW_DOWN_ID))
      document.body.appendChild(createArrowEl(ARROW_DOWN_ID, 'down'));
    else if (!hasBelow) document.getElementById(ARROW_DOWN_ID)?.remove();
  }
}

connectObserver();

refresh();
