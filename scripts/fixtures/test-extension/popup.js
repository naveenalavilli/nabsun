/** Popup script, kept in its own file because MV3 forbids inline script. */
const el = document.getElementById('rid');
el.textContent = chrome?.runtime?.id
  ? `runtime.id: ${chrome.runtime.id}`
  : 'chrome.runtime unavailable';
