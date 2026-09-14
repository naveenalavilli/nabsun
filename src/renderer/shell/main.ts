import type { DownloadEntry, ExtensionStatus, Settings, TabState, WindowState } from '../../shared/types';
import { ExtensionsView } from './extensions';
import { BookmarksView, PasswordsView } from './vault';
import { ChatView } from './chat';
import { SettingsView } from './settings';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

let state: WindowState | null = null;
let settings: Settings | null = null;
let bookmarkedUrls = new Set<string>();

/* ------------------------------------------------------------- tab strip -- */

const tabsEl = $('#tabs');

function renderTabs(next: WindowState) {
  tabsEl.textContent = '';
  for (const tab of next.tabs) {
    tabsEl.appendChild(renderTab(tab, tab.id === next.activeTabId));
  }
}

function renderTab(tab: TabState, active: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className = `tab${active ? ' active' : ''}${tab.agentControlled ? ' agent' : ''}`;
  el.title = `${tab.title}\n${tab.url}`;
  el.setAttribute('role', 'tab');

  if (tab.loading) {
    el.appendChild(Object.assign(document.createElement('div'), { className: 'spinner' }));
  } else if (tab.favicon) {
    const img = document.createElement('img');
    img.className = 'favicon';
    img.src = tab.favicon;
    // A broken favicon must not leave a torn image in the strip.
    img.addEventListener('error', () => img.replaceWith(fallbackIcon(tab)));
    el.appendChild(img);
  } else {
    el.appendChild(fallbackIcon(tab));
  }

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = tab.title || 'New Tab';
  el.appendChild(label);

  if (tab.audible) {
    const audio = document.createElement('span');
    audio.textContent = tab.muted ? '🔇' : '🔊';
    audio.style.fontSize = '10px';
    audio.addEventListener('click', (e) => {
      e.stopPropagation();
      window.nabsun.tabs.mute(tab.id, !tab.muted);
    });
    el.appendChild(audio);
  }

  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '✕';
  close.setAttribute('aria-label', `Close ${tab.title}`);
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    window.nabsun.tabs.close(tab.id);
  });
  el.appendChild(close);

  el.addEventListener('click', () => window.nabsun.tabs.activate(tab.id));
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) window.nabsun.tabs.close(tab.id);
  });

  // Drag to reorder, dropping before or after depending on which half of the
  // target tab the pointer is over.
  el.draggable = true;
  el.dataset.tabId = tab.id;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData('text/x-tab-id', tab.id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    for (const t of tabsEl.children) t.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    el.classList.toggle('drop-before', !after);
    el.classList.toggle('drop-after', after);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-before', 'drop-after');
    const draggedId = e.dataTransfer?.getData('text/x-tab-id');
    if (!draggedId || draggedId === tab.id || !state) return;
    const rect = el.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    const from = state.tabs.findIndex((t) => t.id === draggedId);
    let to = state.tabs.findIndex((t) => t.id === tab.id) + (after ? 1 : 0);
    // Removing the dragged tab first shifts every later index down by one.
    if (from < to) to -= 1;
    window.nabsun.tabs.reorder(draggedId, to);
  });

  return el;
}

function fallbackIcon(tab: TabState): HTMLElement {
  const span = document.createElement('span');
  span.className = 'fallback-icon';
  try {
    span.textContent = new URL(tab.url).hostname.replace(/^www\./, '').charAt(0).toUpperCase();
  } catch {
    span.textContent = '•';
  }
  return span;
}

/* --------------------------------------------------------------- toolbar -- */

const omnibox = $('#omnibox');
const omniboxText = $('#omnibox-text');
const omniboxScheme = $('#omnibox-scheme');
const bookmarkBtn = $('#bookmark');

function renderToolbar(next: WindowState) {
  const active = next.tabs.find((t) => t.id === next.activeTabId);
  $<HTMLButtonElement>('#nav-back').disabled = !active?.canGoBack;
  $<HTMLButtonElement>('#nav-forward').disabled = !active?.canGoForward;
  $('#nav-reload').textContent = active?.loading ? '✕' : '⟳';

  const url = active?.url ?? '';
  if (!url || url === 'about:blank' || url.startsWith('nabsun://')) {
    omnibox.classList.add('placeholder');
    omniboxScheme.textContent = '';
    omniboxText.textContent = 'Search or enter address';
  } else {
    omnibox.classList.remove('placeholder');
    try {
      const parsed = new URL(url);
      omniboxScheme.textContent = parsed.protocol === 'https:' ? '🔒' : '⚠';
      omniboxText.textContent = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
    } catch {
      omniboxScheme.textContent = '';
      omniboxText.textContent = url;
    }
  }

  bookmarkBtn.textContent = bookmarkedUrls.has(url) ? '★' : '☆';
  bookmarkBtn.classList.toggle('on', bookmarkedUrls.has(url));
}

function activeTabId(): string | null {
  return state?.activeTabId ?? null;
}

function wireToolbar() {
  $('#nav-back').addEventListener('click', () => {
    const id = activeTabId();
    if (id) window.nabsun.tabs.back(id);
  });
  $('#nav-forward').addEventListener('click', () => {
    const id = activeTabId();
    if (id) window.nabsun.tabs.forward(id);
  });
  $('#nav-reload').addEventListener('click', () => {
    const id = activeTabId();
    if (!id) return;
    const tab = state?.tabs.find((t) => t.id === id);
    if (tab?.loading) window.nabsun.tabs.stop(id);
    else window.nabsun.tabs.reload(id);
  });
  $('#new-tab').addEventListener('click', () => void window.nabsun.tabs.create());

  omnibox.addEventListener('click', () => openOmnibox());

  bookmarkBtn.addEventListener('click', async () => {
    const tab = state?.tabs.find((t) => t.id === state?.activeTabId);
    if (!tab || !/^https?:/.test(tab.url)) return;
    const existing = (await window.nabsun.data.bookmarks()).find((b) => b.url === tab.url);
    if (existing) await window.nabsun.data.removeBookmark(existing.id);
    else await window.nabsun.data.addBookmark(tab.url, tab.title);
    await refreshBookmarks();
  await bookmarksView.refresh();
  });

  $('#ask-page').addEventListener('click', () => {
    window.nabsun.window.toggleSidebar(true);
    showView('chat');
    chat.ask('');
  });

  $('#sidebar-toggle').addEventListener('click', () => window.nabsun.window.toggleSidebar());

  $('#win-min').addEventListener('click', () => window.nabsun.window.minimize());
  $('#win-max').addEventListener('click', () => window.nabsun.window.maximize());
  $('#win-close').addEventListener('click', () => window.nabsun.window.close());
}

/**
 * The omnibox is a transparent overlay view owned by the main process, because
 * a dropdown drawn by this renderer would be painted over by the page view.
 */
function openOmnibox() {
  const tab = state?.tabs.find((t) => t.id === state?.activeTabId);
  const query = tab && !tab.url.startsWith('nabsun://') ? tab.url : '';
  window.nabsun.window.showOverlay('omnibox', { query });
}

async function refreshBookmarks() {
  const list = await window.nabsun.data.bookmarks();
  bookmarkedUrls = new Set(list.map((b) => b.url));
  if (state) renderToolbar(state);
}

/* --------------------------------------------------------------- findbar -- */

const findbar = $('#findbar');
const findInput = $<HTMLInputElement>('#find-input');

function wireFind() {
  findInput.addEventListener('input', () => window.nabsun.find.start(findInput.value));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') window.nabsun.find.next(!e.shiftKey);
    if (e.key === 'Escape') closeFind();
  });
  $('#find-next').addEventListener('click', () => window.nabsun.find.next(true));
  $('#find-prev').addEventListener('click', () => window.nabsun.find.next(false));
  $('#find-close').addEventListener('click', () => closeFind());

  window.nabsun.onFindResult((r) => {
    $('#find-count').textContent = r.matches ? `${r.activeMatch}/${r.matches}` : 'No results';
  });
}

function openFind() {
  findbar.hidden = false;
  findInput.focus();
  findInput.select();
}

function closeFind() {
  findbar.hidden = true;
  findInput.value = '';
  $('#find-count').textContent = '';
  window.nabsun.find.stop();
}

/* --------------------------------------------------------------- sidebar -- */

function wireSidebarResize() {
  const resizer = $('#sidebar-resizer');
  let dragging = false;

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // The sidebar is anchored right, so its width is the distance to the edge.
    window.nabsun.window.resizeSidebar(Math.round(window.innerWidth - e.clientX));
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
  });
}

/* ------------------------------------------------------------- downloads -- */

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function renderDownloads(items: DownloadEntry[]) {
  const list = $('#download-list');
  list.textContent = '';

  const active = items.filter((d) => d.state === 'progressing').length;
  $('#dl-badge').hidden = active === 0;

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '20px 4px';
    empty.textContent = 'No downloads yet.';
    list.append(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = `dl ${item.state}`;

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.filename;
    name.title = item.savePath;

    const meta = document.createElement('div');
    meta.className = 'meta';
    if (item.state === 'progressing') {
      meta.textContent = item.totalBytes
        ? `${formatBytes(item.receivedBytes)} of ${formatBytes(item.totalBytes)}${item.paused ? ' · paused' : ''}`
        : `${formatBytes(item.receivedBytes)}${item.paused ? ' · paused' : ''}`;
    } else if (item.state === 'completed') {
      meta.textContent = `${formatBytes(item.receivedBytes)} · done`;
    } else {
      meta.textContent = item.state === 'cancelled' ? 'Cancelled' : 'Interrupted';
    }

    row.append(name, meta);

    if (item.state === 'progressing') {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      // An unknown total (no Content-Length) shows an indeterminate-ish bar.
      fill.style.width = item.totalBytes
        ? `${Math.min(100, (item.receivedBytes / item.totalBytes) * 100)}%`
        : '40%';
      bar.append(fill);
      row.append(bar);
    }

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const button = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };

    if (item.state === 'progressing') {
      actions.append(
        button(item.paused ? 'Resume' : 'Pause', () => window.nabsun.downloads.togglePause(item.id)),
        button('Cancel', () => window.nabsun.downloads.cancel(item.id)),
      );
    } else if (item.state === 'completed') {
      actions.append(
        button('Open', () => window.nabsun.downloads.open(item.id)),
        button('Show in folder', () => window.nabsun.downloads.reveal(item.id)),
      );
    }
    if (actions.childElementCount) row.append(actions);

    list.append(row);
  }
}

function wireDownloads() {
  $('#downloads-btn').addEventListener('click', async () => {
    window.nabsun.window.toggleSidebar(true);
    showView('downloads');
    renderDownloads(await window.nabsun.downloads.list());
  });
  $('#dl-clear').addEventListener('click', () => window.nabsun.downloads.clearFinished());
  $('#dl-folder').addEventListener('click', () => window.nabsun.downloads.openFolder());

  window.nabsun.downloads.onChanged((items) => {
    // Keep the badge live even when the panel is not the visible view.
    renderDownloads(items);
  });
}

/* ------------------------------------------------- extension action bar -- */

/**
 * Chromium does not draw extension toolbar buttons, so the browser does. The
 * popup itself is a native view the main process anchors under the button.
 */
function renderExtensionActions(items: ExtensionStatus[]) {
  const bar = $('#ext-actions');
  bar.textContent = '';
  for (const ext of items) {
    if (!ext.loaded || !ext.hasAction) continue;
    const btn = document.createElement('button');
    btn.className = 'ext-action';
    btn.title = ext.name;
    btn.setAttribute('aria-label', ext.name);

    if (ext.iconDataUrl) {
      const img = document.createElement('img');
      img.src = ext.iconDataUrl;
      img.alt = '';
      btn.append(img);
    } else {
      const letter = document.createElement('span');
      letter.className = 'letter';
      letter.textContent = ext.name.charAt(0).toUpperCase();
      btn.append(letter);
    }

    btn.addEventListener('click', () => {
      // The main process needs a window coordinate to anchor the popup to.
      const rect = btn.getBoundingClientRect();
      window.nabsun.extensions.openAction(ext.id, rect.right);
    });
    bar.append(btn);
  }
}

type ViewName =
  | 'chat'
  | 'history'
  | 'settings'
  | 'downloads'
  | 'extensions'
  | 'bookmarks'
  | 'passwords';

function showView(name: ViewName) {
  for (const view of document.querySelectorAll('.view')) view.classList.remove('active');
  $(`#view-${name}`).classList.add('active');
  if (name === 'settings') void settingsView.render();
  if (name === 'extensions') void extensionsView.render();
  if (name === 'bookmarks') void bookmarksView.render();
  if (name === 'passwords') void passwordsView.render();
  if (name === 'history') void renderSessions();
}

async function renderSessions() {
  const list = await window.nabsun.sessions.list();
  const container = $('#session-list');
  container.textContent = '';
  if (!list.length) {
    container.append(
      Object.assign(document.createElement('div'), {
        className: 'muted',
        textContent: 'No previous chats yet.',
      }),
    );
    return;
  }
  for (const item of list) {
    const row = document.createElement('div');
    row.className = `session-item${item.id === chat.currentSessionId ? ' active' : ''}`;

    const title = document.createElement('span');
    title.className = 't';
    title.textContent = item.title;

    const when = document.createElement('span');
    when.className = 'muted';
    when.textContent = new Date(item.updatedAt).toLocaleDateString();

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '\u{1F5D1}';
    del.setAttribute('aria-label', `Delete chat ${item.title}`);
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.nabsun.sessions.remove(item.id);
      await renderSessions();
    });

    row.append(title, when, del);
    row.addEventListener('click', async () => {
      await chat.open(item.id);
      showView('chat');
    });
    container.append(row);
  }
}

/* ------------------------------------------------------------------ boot -- */

const chat = new ChatView(() => void renderSessions());
const bookmarksView = new BookmarksView();
const passwordsView = new PasswordsView();
const extensionsView = new ExtensionsView(() => void refreshSettings());
const settingsView = new SettingsView((next) => {
  settings = next;
});

async function refreshSettings() {
  settings = await window.nabsun.settings.get();
  applyTheme(settings.theme);
  applyVerbose(settings.verbose);
}

function wireExtensions() {
  // The action bar mirrors whatever is loaded, including changes made while
  // the Extensions panel is closed.
  window.nabsun.extensions.onChanged(renderExtensionActions);
  void window.nabsun.extensions.list().then(renderExtensionActions);
}

function wireSidebarButtons() {
  $('#new-chat').addEventListener('click', async () => {
    await chat.start();
    showView('chat');
  });
  $('#history-btn').addEventListener('click', () => showView('history'));
  $('#extensions-btn').addEventListener('click', () => showView('extensions'));
  $('#bookmarks-btn').addEventListener('click', () => showView('bookmarks'));
  $('#passwords-btn').addEventListener('click', () => showView('passwords'));
  $('#settings-btn').addEventListener('click', () => showView('settings'));
  for (const btn of document.querySelectorAll('.back-to-chat')) {
    btn.addEventListener('click', () => showView('chat'));
  }
}

function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openFind();
    } else if (e.key === 'Escape' && !findbar.hidden) {
      closeFind();
    }
  });
}

window.nabsun.onWindowState((next) => {
  state = next;
  window.__activeTabId = next.activeTabId;
  document.body.classList.toggle('sidebar-closed', !next.sidebarOpen);
  document.body.classList.toggle('no-bookmarks-bar', !next.bookmarksBarVisible);
  $('#sidebar').style.width = `${next.sidebarWidth}px`;
  $('#sidebar-toggle').classList.toggle('on', next.sidebarOpen);
  if (next.findOpen && findbar.hidden) openFind();
  if (!next.findOpen && !findbar.hidden) closeFind();
  renderTabs(next);
  renderToolbar(next);
});

window.nabsun.onSettingsChanged((next) => {
  settings = next;
  applyTheme(next.theme);
  applyVerbose(next.verbose);
});

/**
 * Puts the chosen theme on <html>, which is what the stylesheet keys off.
 *
 * "system" deliberately removes the attribute rather than setting it: the
 * palette's `prefers-color-scheme` rule only applies when neither explicit
 * value is present, so leaving a stale attribute would pin the theme.
 *
 * The setting existed from the start and nothing read it, so the browser was
 * dark whatever it said.
 */
function applyTheme(theme: Settings['theme']): void {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

/**
 * Verbosity is a class on the root, not a branch in the renderer.
 *
 * The reasoning and tool cards are still built and still in the DOM, so
 * turning this on reveals what has already happened rather than only applying
 * to the next turn - including a session restored from history.
 */
function applyVerbose(verbose: boolean): void {
  document.documentElement.classList.toggle('verbose', verbose);
}


window.nabsun.onCommand((command, arg) => {
  switch (command) {
    case 'ask-ai':
      showView('chat');
      chat.ask(String(arg ?? ''), true);
      break;
    case 'open-settings':
      showView('settings');
      break;
    case 'open-bookmarks':
      showView('bookmarks');
      break;
    case 'open-passwords':
      showView('passwords');
      break;
    case 'focus-find':
      openFind();
      break;
    case 'ask-selection':
      showView('chat');
      chat.ask(String(arg ?? ''));
      break;
    case 'open-downloads':
      showView('downloads');
      void window.nabsun.downloads.list().then(renderDownloads);
      break;
    case 'open-clear-data':
      // Ctrl+Shift+Delete. The controls live in Settings, so go there and put
      // them on screen rather than dropping the user at the top of the page.
      showView('settings');
      void revealWhenReady('clear-data-block');
      break;
  }
});

/**
 * Scrolls to an element that a view is still rendering.
 *
 * Settings renders asynchronously, so the target does not exist on the tick the
 * command arrives; a single rAF would miss it about half the time.
 */
async function revealWhenReady(id: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function boot() {
  wireToolbar();
  wireFind();
  wireSidebarResize();
  wireSidebarButtons();
  wireShortcuts();
  wireDownloads();
  wireExtensions();

  settings = await window.nabsun.settings.get();
  $<HTMLInputElement>('#autopilot').checked = settings.autoApprove.write;
  $<HTMLInputElement>('#autopilot').addEventListener('change', async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    settings = await window.nabsun.settings.set({
      autoApprove: { ...settings!.autoApprove, write: on },
    });
  });

  await refreshBookmarks();
  await bookmarksView.refresh();
  await chat.start();
  window.nabsun.ready();
}

void boot();




