const STYLE_ID = 'dnf-styles';
const DATA_ATTR = 'data-dnf-highlight';
const HEADING_TEXT = 'Reviewer checklist';
const ARROW_UP_ID = 'dnf-arrow-up';
const ARROW_DOWN_ID = 'dnf-arrow-down';
const TITLE_WARNING_ATTR = 'data-dnf-pr-title-warning';
const STORAGE_KEY_PREFIX = 'dnf-pr:';
const STORAGE_AREA = chrome.storage.local;
const HEADING_TEXT_LOWER = HEADING_TEXT.toLowerCase();

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
@keyframes dnf-title-pulse {
  0%, 100% { color: #EF4444; text-shadow: 0 0 0 rgba(239,68,68,0.5); }
  50%      { color: #DC2626; text-shadow: 0 0 10px rgba(239,68,68,0.45); }
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
[${TITLE_WARNING_ATTR}] {
  color: #EF4444 !important;
  animation: dnf-title-pulse 1.2s ease-in-out infinite !important;
}
[${TITLE_WARNING_ATTR}] * {
  color: inherit !important;
}
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
let currentPrKey = '';
const lastStoredRemainingByPr = new Map();

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

function isHeadingTag(tag) {
  return tag.length === 2 && tag[0] === 'H' && tag >= 'H1' && tag <= 'H6';
}

/**
 * Scan "Reviewer checklist" sections and return checklist state.
 * Complexity is O(h + n), where h is heading count and n candidate checkboxes.
 * Perf-sensitive path: this runs on each refresh and should avoid extra global queries.
 * @returns {{ hasSection: boolean, unchecked: HTMLInputElement[] }}
 */
function findReviewerChecklistState() {
  const unchecked = [];
  let hasSection = false;
  for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (heading.textContent.trim().toLowerCase() !== HEADING_TEXT_LOWER) continue;
    hasSection = true;
    let sibling = heading.nextElementSibling;
    while (sibling) {
      const tag = sibling.tagName;
      if (isHeadingTag(tag)) break;
      for (const cb of sibling.querySelectorAll('input[type="checkbox"]:not(:checked)')) {
        unchecked.push(cb);
      }
      sibling = sibling.nextElementSibling;
    }
  }
  return { hasSection, unchecked };
}

function getPrKeyFromLocation() {
  const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
  if (!match) return '';
  return `${match[1]}/${match[2]}/pull/${match[3]}`;
}

function getStorageKey(prKey) {
  return `${STORAGE_KEY_PREFIX}${prKey}`;
}

function setStoredChecklistState(prKey, hasRemaining) {
  if (!prKey || !STORAGE_AREA) return;
  const prev = lastStoredRemainingByPr.get(prKey);
  if (prev === hasRemaining) return;
  lastStoredRemainingByPr.set(prKey, hasRemaining);
  const key = getStorageKey(prKey);
  try {
    STORAGE_AREA.set({ [key]: { hasRemaining, updatedAt: Date.now() } });
  } catch (_) {}
}

function getStoredChecklistState(prKey) {
  if (!prKey || !STORAGE_AREA) return Promise.resolve(false);
  const key = getStorageKey(prKey);
  return new Promise((resolve) => {
    try {
      STORAGE_AREA.get(key, (store) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        const hasRemaining = store?.[key]?.hasRemaining === true;
        lastStoredRemainingByPr.set(prKey, hasRemaining);
        resolve(hasRemaining);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

function getPrTitleEl() {
  return (
    document.querySelector('h1[data-component="PH_Title"]')
    || document.querySelector('.gh-header-title .js-issue-title')
    || document.querySelector('.js-issue-title')
  );
}

function setTitleWarningVisible(visible) {
  const titleEl = getPrTitleEl();
  if (!titleEl) return;
  if (!visible || !isActive) {
    titleEl.removeAttribute(TITLE_WARNING_ATTR);
    return;
  }
  injectStyles();
  titleEl.setAttribute(TITLE_WARNING_ATTR, '');
}

async function syncTitleWarningFromStorage(prKey) {
  if (!prKey) {
    setTitleWarningVisible(false);
    return;
  }
  if (!isActive) {
    setTitleWarningVisible(false);
    return;
  }
  const hasRemaining = await getStoredChecklistState(prKey);
  setTitleWarningVisible(hasRemaining);
}

function resolveCurrentPrKey() {
  currentPrKey = getPrKeyFromLocation();
  return currentPrKey;
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
 * @returns {{ hasSection: boolean, hasRemaining: boolean } | void}
 */
function applyHighlights() {
  if (!isActive) return;
  injectStyles();
  const { hasSection, unchecked } = findReviewerChecklistState();
  const next = new Set(unchecked);
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
  if (hasSection) {
    const prKey = resolveCurrentPrKey();
    const hasRemaining = next.size > 0;
    setStoredChecklistState(prKey, hasRemaining);
    setTitleWarningVisible(hasRemaining);
    updateScrollIndicators();
    return { hasSection, hasRemaining };
  }
  updateScrollIndicators();
  return { hasSection: false, hasRemaining: false };
}

function refresh() {
  if (isActive) {
    const state = applyHighlights();
    if (!state?.hasSection) {
      syncTitleWarningFromStorage(resolveCurrentPrKey());
    }
  } else {
    clearHighlights();
    clearArrows();
    setTitleWarningVisible(false);
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!currentPrKey) return;
  const key = getStorageKey(currentPrKey);
  if (!(key in changes)) return;
  const hasRemaining = changes[key].newValue?.hasRemaining === true;
  lastStoredRemainingByPr.set(currentPrKey, hasRemaining);
  setTitleWarningVisible(hasRemaining);
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
