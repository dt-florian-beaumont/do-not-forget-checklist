chrome.action.onClicked.addListener(async (tab) => {
  const { active } = await chrome.storage.session.get('active');
  const newActive = active !== false ? false : true; // undefined → true → false
  await chrome.storage.session.set({ active: newActive });
  if (tab.id && tab.url?.startsWith('https://github.com/')) {
    try { chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', active: newActive }); }
    catch (_) {}
  }
});
