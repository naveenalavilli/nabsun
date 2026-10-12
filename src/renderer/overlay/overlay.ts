import type { OmniboxSuggestion } from '../../shared/types';
import type { OverlayApi } from '../../preload/overlay';

declare global {
  interface Window {
    overlay: OverlayApi;
  }
}

interface Row {
  icon: string;
  title: string;
  subtitle?: string;
  hint?: string;
  run: () => void;
}

const backdrop = document.getElementById('backdrop') as HTMLElement;
const input = document.getElementById('input') as HTMLInputElement;
const list = document.getElementById('list') as HTMLElement;

let rows: Row[] = [];
let selected = 0;
let mode: 'omnibox' | 'palette' = 'omnibox';
/** Guards against a slow suggestion response overwriting a newer query. */
let queryToken = 0;
let composing = false;

const COMMANDS: { title: string; subtitle: string; command: string; hint?: string }[] = [
  { title: 'New tab', subtitle: 'Open a blank tab', command: 'new-tab', hint: 'Ctrl+T' },
  { title: 'Close tab', subtitle: 'Close the current tab', command: 'close-tab', hint: 'Ctrl+W' },
  { title: 'Reload page', subtitle: 'Reload the current tab', command: 'reload', hint: 'Ctrl+R' },
  { title: 'Find in page', subtitle: 'Search the current page', command: 'find', hint: 'Ctrl+F' },
  { title: 'Toggle AI sidebar', subtitle: 'Show or hide the assistant', command: 'toggle-sidebar', hint: 'Ctrl+Shift+A' },
  { title: 'Bookmarks', subtitle: 'Rename, move between folders, show on the bar, delete', command: 'open-bookmarks', hint: 'Ctrl+Shift+O' },
  { title: 'History', subtitle: 'Everywhere you have been', command: 'open-history', hint: 'Ctrl+H' },
  { title: 'Downloads', subtitle: 'Progress, pause, open, reveal in folder', command: 'open-downloads', hint: 'Ctrl+J' },
  { title: 'Saved passwords', subtitle: 'Show, copy or delete a saved credential', command: 'open-passwords' },
  { title: 'Settings', subtitle: 'Provider, models, permissions, plugins', command: 'open-settings', hint: 'Ctrl+,' },
  { title: 'Developer tools', subtitle: 'Inspect the current page', command: 'devtools', hint: 'F12' },
];

const ICONS: Record<OmniboxSuggestion['kind'], string> = {
  url: '🌐',
  search: '🔍',
  ask: '✨',
  history: '🕘',
  bookmark: '★',
  command: '⌘',
};

window.overlay.onOpen(({ kind, payload, theme, appearance }) => {
  document.documentElement.dataset.appearance = appearance ?? 'classic';
  // Match the shell rather than the OS; see AppWindow.showOverlay.
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  mode = kind;
  queryToken++;
  rows = [];
  backdrop.classList.toggle('palette', kind === 'palette');
  const { query: rawQuery = '', anchor } = (payload ?? {}) as {
    query?: string; anchor?: { x: number; y: number; width: number; height: number; viewportWidth: number };
  };
  const query = rawQuery.startsWith('nabsun://') ? '' : rawQuery;
  if (anchor) {
    backdrop.style.setProperty('--address-left', `${anchor.x}px`);
    backdrop.style.setProperty('--address-top', `${anchor.y}px`);
    backdrop.style.setProperty('--address-right', `${Math.max(0, anchor.viewportWidth - anchor.x - anchor.width)}px`);
    backdrop.style.setProperty('--address-height', `${anchor.height}px`);
  }
  input.value = kind === 'omnibox' ? query : '';
  input.setAttribute('aria-label', kind === 'omnibox' ? 'Search or enter address' : 'Type a command');
  input.placeholder = kind === 'omnibox' ? 'Search or enter address' : 'Type a command';
  selected = 0;
  input.focus();
  input.select();
  void refresh();
});

input.addEventListener('input', () => {
  selected = 0;
  void refresh();
});
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; selected = 0; void refresh(); });

input.addEventListener('keydown', (e) => {
  if (composing || e.isComposing || e.keyCode === 229) return;
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      move(-1);
      break;
    case 'Tab':
      e.preventDefault();
      move(e.shiftKey ? -1 : 1);
      break;
    case 'Enter':
      e.preventDefault();
      rows[selected]?.run();
      break;
    case 'Escape':
      e.preventDefault();
      queryToken++;
      window.overlay.close();
      break;
  }
});

// Clicking outside the panel dismisses, matching every other command palette.
backdrop.addEventListener('mousedown', (e) => {
  if (e.target === backdrop) window.overlay.close();
});

function move(delta: number) {
  if (!rows.length) return;
  selected = (selected + delta + rows.length) % rows.length;
  paint();
}

async function refresh() {
  const query = input.value;
  const token = ++queryToken;
  if (mode === 'palette') {
    const q = query.trim().toLowerCase();
    rows = COMMANDS.filter(
      (c) => !q || c.title.toLowerCase().includes(q) || c.subtitle.toLowerCase().includes(q),
    ).map((c) => ({
      icon: '⌘',
      title: c.title,
      subtitle: c.subtitle,
      hint: c.hint,
      run: () => window.overlay.run(c.command),
    }));
    paint();
    return;
  }

  // Enter must always target the current text, even while IPC is pending.
  rows = query.trim() ? [{ icon: '↗', title: query, run: () => window.overlay.run('navigate', query) }] : [];
  paint();
  let suggestions: OmniboxSuggestion[] = [];
  try { suggestions = query.trim() ? await window.overlay.suggest(query) : []; }
  catch { return; } // Keep the current text usable when suggestions fail.
  if (token !== queryToken) return;
  selected = 0;

  rows = suggestions.map((s) => ({
    icon: ICONS[s.kind] ?? '•',
    title: s.title,
    subtitle: s.subtitle,
    hint: s.kind === 'ask' ? 'Ask AI' : undefined,
    run: () => {
      if (s.kind === 'ask') window.overlay.run('ask-ai', s.value);
      else window.overlay.run('navigate', s.value);
    },
  }));

  if (!rows.length && query.trim()) {
    rows = [
      {
        icon: '🌐',
        title: query,
        subtitle: 'Open',
        run: () => window.overlay.run('navigate', query),
      },
    ];
  }
  paint();
}

function paint() {
  list.textContent = '';
  input.setAttribute('aria-expanded', String(rows.length > 0));
  input.removeAttribute('aria-activedescendant');
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No matching commands';
    if (mode === 'palette') list.append(empty);
    return;
  }

  rows.forEach((row, i) => {
    const item = document.createElement('div');
    item.className = `item${i === selected ? ' selected' : ''}`;
    item.setAttribute('role', 'option');
    item.id = `suggestion-${i}`;
    item.setAttribute('aria-selected', String(i === selected));
    if (i === selected) input.setAttribute('aria-activedescendant', item.id);

    const icon = document.createElement('span');
    icon.className = 'kind';
    icon.textContent = row.icon;

    const text = document.createElement('span');
    text.className = 'text';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = row.title;
    text.append(title);
    if (row.subtitle) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = row.subtitle;
      text.append(sub);
    }

    item.append(icon, text);
    if (row.hint) {
      const hint = document.createElement('span');
      hint.className = 'hintkey';
      hint.textContent = row.hint;
      item.append(hint);
    }

    item.addEventListener('mouseenter', () => {
      selected = i;
      for (const [index, child] of [...list.children].entries()) {
        child.classList.toggle('selected', index === selected);
        child.setAttribute('aria-selected', String(index === selected));
      }
      input.setAttribute('aria-activedescendant', item.id);
    });
    item.addEventListener('mousedown', e => e.preventDefault());
    item.addEventListener('click', () => row.run());
    list.append(item);
  });

  list.children[selected]?.scrollIntoView({ block: 'nearest' });
}
