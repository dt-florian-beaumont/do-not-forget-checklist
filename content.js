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
let observerConnected = false;
const highlightedCheckboxes = new Set();
let arrowUpEl = null;
let arrowDownEl = null;

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

/**
 * Scan "Reviewer checklist" sections and return unchecked checkboxes.
 * Complexity is O(h + n), where h is heading count and n candidate checkboxes.
 * Perf-sensitive path: this runs on each refresh and should avoid extra global queries.
 * @returns {HTMLInputElement[]}
 */
function findUncheckedReviewerCheckboxes() {
  const results = [];
  for (const heading of document.querySelectorAll('h2')) {
    if (heading.textContent.trim() !== HEADING_TEXT) continue;
    let sibling = heading.nextElementSibling;
    while (sibling) {
      const tag = sibling.tagName;
      if (tag === 'H1' || tag === 'H2') break;
      for (const cb of sibling.querySelectorAll('input[type="checkbox"]:not(:checked)')) {
        results.push(cb);
      }
      sibling = sibling.nextElementSibling;
    }
  }
  return results;
}

function clearHighlights() {
  if (highlightedCheckboxes.size === 0) {
    document.querySelectorAll(`input[${DATA_ATTR}]`).forEach((cb) => cb.removeAttribute(DATA_ATTR));
    return;
  }
  for (const cb of highlightedCheckboxes) {
    cb.removeAttribute(DATA_ATTR);
  }
  highlightedCheckboxes.clear();
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
 * Jump to the nearest highlighted checkbox above or below the viewport.
 * Complexity is O(n) over highlighted checkboxes with one layout read per item.
 * Invariant: highlightedCheckboxes must only contain current highlighted inputs.
 * @param {'up'|'down'} direction
 * @returns {void}
 */
function scrollToNearestCheckbox(direction) {
  const vh = window.innerHeight;
  let target = null;
  let targetRect = null;
  if (direction === 'up') {
    let bestBottom = -Infinity;
    for (const el of highlightedCheckboxes) {
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0 && rect.bottom > bestBottom) {
        bestBottom = rect.bottom;
        target = el;
        targetRect = rect;
      }
    }
  } else {
    let bestTop = Infinity;
    for (const el of highlightedCheckboxes) {
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top > vh && rect.top < bestTop) {
        bestTop = rect.top;
        target = el;
        targetRect = rect;
      }
    }
  }
  if (!target || !targetRect) return;
  const top = Math.max(0, window.scrollY + targetRect.top - (vh / 2) + (targetRect.height / 2));
  window.scrollTo({ top, behavior: 'smooth' });
}

function clearArrows() {
  arrowUpEl?.remove();
  arrowDownEl?.remove();
  arrowUpEl = null;
  arrowDownEl = null;
}

function setArrowVisibility(showUp, showDown) {
  if (showUp) {
    if (!arrowUpEl || !arrowUpEl.isConnected) {
      arrowUpEl = createArrowEl(ARROW_UP_ID, 'up');
      document.body.appendChild(arrowUpEl);
    }
  } else if (arrowUpEl) {
    arrowUpEl.remove();
    arrowUpEl = null;
  }
  if (showDown) {
    if (!arrowDownEl || !arrowDownEl.isConnected) {
      arrowDownEl = createArrowEl(ARROW_DOWN_ID, 'down');
      document.body.appendChild(arrowDownEl);
    }
  } else if (arrowDownEl) {
    arrowDownEl.remove();
    arrowDownEl = null;
  }
}

function getArrowStateFromMap() {
  let hasAbove = false;
  let hasBelow = false;
  for (const state of ioVisibilityMap.values()) {
    if (state.above) hasAbove = true;
    if (state.below) hasBelow = true;
    if (hasAbove && hasBelow) break;
  }
  return { hasAbove, hasBelow };
}

function updateScrollIndicators() {
  if (!isActive) {
    clearArrows();
    syncScrollIo([]);
    return;
  }
  syncScrollIo([...highlightedCheckboxes]);
}

/**
 * Compute next highlight state and apply minimal DOM diffs.
 * Complexity is O(n) on highlighted and next sets; no full highlight rescan.
 * Invariant: highlightedCheckboxes mirrors DOM nodes carrying DATA_ATTR.
 * @returns {void}
 */
function applyHighlights() {
  if (!isActive) return;
  injectStyles();
  const next = new Set(findUncheckedReviewerCheckboxes());
  for (const cb of highlightedCheckboxes) {
    if (!cb.isConnected || !next.has(cb)) {
      cb.removeAttribute(DATA_ATTR);
      highlightedCheckboxes.delete(cb);
    }
  }
  for (const cb of next) {
    if (!highlightedCheckboxes.has(cb)) {
      cb.setAttribute(DATA_ATTR, '');
      highlightedCheckboxes.add(cb);
    }
  }
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

function resetRefreshScheduling() {
  clearTimeout(debounceTimer);
  debounceTimer = null;
  if (refreshRafId) {
    cancelAnimationFrame(refreshRafId);
    refreshRafId = 0;
  }
  suspendRefreshUntil = 0;
}

function resetScrollTracking() {
  scrollIo?.disconnect();
  scrollIo = null;
  ioVisibilityMap.clear();
  highlightedCheckboxes.clear();
  clearArrows();
}

/**
 * Keep IntersectionObserver targets in sync with current highlighted checkboxes.
 * Complexity is O(n) for set diffs + initial geometry reads for new observed nodes.
 * Perf-sensitive path: avoids scroll listeners and updates arrows from cached visibility.
 * @param {HTMLInputElement[]} checkboxes
 * @returns {void}
 */
function syncScrollIo(checkboxes) {
  const set = new Set(checkboxes.filter((el) => el.isConnected));
  const prev = new Set(ioVisibilityMap.keys());
  if (set.size === 0) {
    scrollIo?.disconnect();
    scrollIo = null;
    ioVisibilityMap.clear();
    clearArrows();
    return;
  }
  const updateFromEntries = (entries) => {
    const vh = window.innerHeight;
    for (const e of entries) {
      const { bottom, top } = e.boundingClientRect;
      ioVisibilityMap.set(e.target, { above: bottom < 0, below: top > vh });
    }
    const { hasAbove, hasBelow } = getArrowStateFromMap();
    setArrowVisibility(hasAbove, hasBelow);
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
  const vh = window.innerHeight;
  for (const el of set) {
    if (!prev.has(el)) {
      const rect = el.getBoundingClientRect();
      ioVisibilityMap.set(el, { above: rect.bottom < 0, below: rect.top > vh });
      scrollIo.observe(el);
    }
  }
  const { hasAbove, hasBelow } = getArrowStateFromMap();
  setArrowVisibility(hasAbove, hasBelow);
}

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

/**
 * Decide whether observed mutations can affect checklist highlighting.
 * Fast-reject path should skip most unrelated GitHub DOM updates.
 * @param {MutationRecord[]} records
 * @returns {boolean}
 */
function hasRelevantMutations(records) {
  return records.some((record) => record.type === 'childList');
}

const observer = new MutationObserver((records) => {
  if (!hasRelevantMutations(records)) return;
  scheduleRefresh();
});

function connectObserver() {
  if (observerConnected || !document.body) return;
  observer.observe(document.body, { childList: true, subtree: true });
  observerConnected = true;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TOGGLE') {
    isActive = message.active;
    refresh();
  }
});

document.addEventListener('change', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
  suspendRefreshUntil = Date.now() + CHECKBOX_SETTLE_MS;
  scheduleRefresh(CHECKBOX_SETTLE_MS);
}, true);

document.addEventListener('turbo:before-render', (e) => {
  if (e.detail?.renderMethod === 'replace') {
    observer.disconnect();
    observerConnected = false;
    resetRefreshScheduling();
    resetScrollTracking();
  }
});

document.addEventListener('turbo:load', () => {
  connectObserver();
  queueRefresh();
});
document.addEventListener('turbo:render', () => {
  queueRefresh();
});

connectObserver();

refresh();
