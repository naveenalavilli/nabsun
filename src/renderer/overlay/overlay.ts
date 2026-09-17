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

window.overlay.onOpen(({ kind, payload, theme }) => {
  // Match the shell rather than the OS; see AppWindow.showOverlay.
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  mode = kind;
  backdrop.classList.toggle('palette', kind === 'palette');
  const query = (payload as { query?: string })?.query ?? '';
  input.value = kind === 'omnibox' ? query : '';
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

input.addEventListener('keydown', (e) => {
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

  const token = ++queryToken;
  const suggestions = query.trim() ? await window.overlay.suggest(query) : [];
  if (token !== queryToken) return;

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
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = mode === 'palette' ? 'No matching commands' : 'Start typing to search';
    list.append(empty);
    return;
  }

  rows.forEach((row, i) => {
    const item = document.createElement('div');
    item.className = `item${i === selected ? ' selected' : ''}`;
    item.setAttribute('role', 'option');

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
      paint();
    });
    item.addEventListener('click', () => row.run());
    list.append(item);
  });

  list.children[selected]?.scrollIntoView({ block: 'nearest' });
}
