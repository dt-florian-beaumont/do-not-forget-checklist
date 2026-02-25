let active = true;

chrome.action.onClicked.addListener(async (tab) => {
  active = !active;
  if (tab.id && tab.url?.startsWith('https://github.com/')) {
    try { chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', active }); }
    catch (_) {}
  }
});
