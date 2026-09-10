/**
 * Content script for the test extension.
 *
 * Proves two things the harness asserts: that a content script is injected into
 * ordinary pages at all, and that the Chrome extension APIs are actually
 * available to it rather than merely defined.
 */
const marker = document.createElement('div');
marker.id = '__nabsun_extension_marker__';
marker.dataset.runtimeId = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : '';
marker.dataset.hasStorage =
  typeof chrome !== 'undefined' && chrome.storage ? 'yes' : 'no';
marker.style.display = 'none';
marker.textContent = 'content-script-ran';

// documentElement, because a page may have no body at document_idle.
(document.body || document.documentElement).appendChild(marker);
