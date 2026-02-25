const STYLE_ID = 'dnf-styles';
const DATA_ATTR = 'data-dnf-highlight';
const HEADING_TEXT = 'Reviewer checklist';
const ARROW_UP_ID   = 'dnf-arrow-up';
const ARROW_DOWN_ID = 'dnf-arrow-down';

const CSS = `
@keyframes dnf-pulse {
  0%   { outline-color: #EF4444; outline-offset: 2px; }
  50%  { outline-color: transparent; outline-offset: 4px; }
  100% { outline-color: #EF4444; outline-offset: 2px; }
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
  outline: 2px solid #EF4444 !important;
  outline-offset: 2px !important;
  animation: dnf-pulse 1.2s ease-in-out infinite !important;
}
`;

let isActive = true;
let debounceTimer = null;

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
  el.textContent = direction === 'up' ? '↑' : '↓';
  el.style.cssText = `
    position: fixed;
    right: 20px;
    ${direction === 'up' ? 'top: 20px' : 'bottom: 20px'};
    width: 44px; height: 44px;
    background: #EF4444; color: white;
    border: none; border-radius: 50%;
    font-size: 22px; cursor: pointer;
    z-index: 2147483647;
    box-shadow: 0 2px 8px rgba(239,68,68,0.4);
    animation: ${direction === 'up' ? 'dnf-bounce-up' : 'dnf-bounce-down'} 1s ease-in-out infinite;
  `;
  el.addEventListener('click', () => scrollToNearestCheckbox(direction));
  return el;
}

function scrollToNearestCheckbox(direction) {
  const all = Array.from(document.querySelectorAll(`input[${DATA_ATTR}]`));
  const vh = window.innerHeight;
  let target;
  if (direction === 'up') {
    const above = all.filter(cb => cb.getBoundingClientRect().bottom < 0);
    above.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    target = above[0];
  } else {
    const below = all.filter(cb => cb.getBoundingClientRect().top > vh);
    below.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    target = below[0];
  }
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearArrows() {
  document.getElementById(ARROW_UP_ID)?.remove();
  document.getElementById(ARROW_DOWN_ID)?.remove();
}

function updateScrollIndicators() {
  if (!isActive) { clearArrows(); return; }
  const all = Array.from(document.querySelectorAll(`input[${DATA_ATTR}]`));
  const vh = window.innerHeight;
  const hasAbove = all.some(cb => cb.getBoundingClientRect().bottom < 0);
  const hasBelow = all.some(cb => cb.getBoundingClientRect().top > vh);

  if (hasAbove && !document.getElementById(ARROW_UP_ID))
    document.body.appendChild(createArrowEl(ARROW_UP_ID, 'up'));
  else if (!hasAbove)
    document.getElementById(ARROW_UP_ID)?.remove();

  if (hasBelow && !document.getElementById(ARROW_DOWN_ID))
    document.body.appendChild(createArrowEl(ARROW_DOWN_ID, 'down'));
  else if (!hasBelow)
    document.getElementById(ARROW_DOWN_ID)?.remove();
}

function applyHighlights() {
  clearHighlights();
  if (!isActive) return;
  injectStyles();
  findUncheckedReviewerCheckboxes().forEach((cb) => {
    cb.setAttribute(DATA_ATTR, '');
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
  }
}

// Listen for toggle messages from background.js
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TOGGLE') {
    isActive = message.active;
    refresh();
  }
});

// MutationObserver with debounce to handle dynamic DOM changes
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(refresh, 300);
});

observer.observe(document.body, { childList: true, subtree: true });

// Handle GitHub SPA navigation (Turbo)
document.addEventListener('turbo:load', refresh);
document.addEventListener('turbo:render', refresh);

// Scroll listener with debounce to update arrow indicators
let scrollTimer = null;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(updateScrollIndicators, 100);
}, { passive: true });

// Init: read stored state and apply
chrome.storage.session.get('active').then(({ active }) => {
  isActive = active !== false; // undefined → true
  refresh();
});
