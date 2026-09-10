import { Menu, type BaseWindow, type ContextMenuParams, clipboard, shell } from 'electron';
import type { Settings } from '../shared/types';
import { searchUrlFor } from './history';
import type { Tab, TabManager } from './tabs';

export interface ContextMenuDeps {
  window: BaseWindow;
  tabs: TabManager;
  getSettings: () => Settings;
  /** Content-area rectangle, so menu coordinates land in the right place. */
  contentBounds: () => { x: number; y: number };
  askAssistant: (prompt: string) => void;
}

const truncate = (s: string, n = 32) =>
  s.replace(/\s+/g, ' ').trim().length > n
    ? `${s.replace(/\s+/g, ' ').trim().slice(0, n)}…`
    : s.replace(/\s+/g, ' ').trim();

/**
 * Chromium hands us a description of what was right-clicked; we assemble the
 * menu the same way Chrome does — link items, then image/media, then editing,
 * then page-level actions — with the assistant folded in where it is useful.
 */
export function attachContextMenu(deps: ContextMenuDeps, tab: Tab): void {
  tab.wc.on('context-menu', (_event, params) => {
    const menu = Menu.buildFromTemplate(buildTemplate(deps, tab, params));
    const offset = deps.contentBounds();
    menu.popup({
      window: deps.window,
      // params.x/y are relative to the page view, not the window.
      x: Math.round(params.x + offset.x),
      y: Math.round(params.y + offset.y),
    });
  });
}

function buildTemplate(
  deps: ContextMenuDeps,
  tab: Tab,
  params: ContextMenuParams,
): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  const { tabs } = deps;
  const wc = tab.wc;
  const sep = () => items.push({ type: 'separator' });

  /* ------------------------------------------------------------ spelling */

  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
    }
    if (!params.dictionarySuggestions.length) {
      items.push({ label: 'No spelling suggestions', enabled: false });
    }
    items.push({
      label: 'Add to dictionary',
      click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    sep();
  }

  /* --------------------------------------------------------------- links */

  if (params.linkURL) {
    items.push(
      {
        label: 'Open link in new tab',
        click: () => tabs.create(params.linkURL, { background: true }),
      },
      {
        label: 'Open link in new tab and switch',
        click: () => tabs.create(params.linkURL),
      },
      {
        label: 'Open link in default browser',
        click: () => void shell.openExternal(params.linkURL),
      },
      {
        label: 'Copy link address',
        click: () => clipboard.writeText(params.linkURL),
      },
    );
    sep();
  }

  /* -------------------------------------------------------- images/media */

  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { label: 'Open image in new tab', click: () => tabs.create(params.srcURL) },
      { label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
      { label: 'Save image as…', click: () => wc.downloadURL(params.srcURL) },
      {
        label: 'Ask the assistant about this image',
        click: () => deps.askAssistant(`Look at the image at ${params.srcURL} on this page and describe it.`),
      },
    );
    sep();
  }

  if (params.mediaType === 'video' || params.mediaType === 'audio') {
    items.push(
      {
        label: params.mediaFlags.isPaused ? 'Play' : 'Pause',
        click: () => wc.executeJavaScript('document.querySelector("video,audio")?.paused ? document.querySelector("video,audio").play() : document.querySelector("video,audio").pause()'),
      },
      { label: 'Save media as…', click: () => wc.downloadURL(params.srcURL) },
      { label: 'Copy media address', click: () => clipboard.writeText(params.srcURL) },
    );
    sep();
  }

  /* ------------------------------------------------------------- editing */

  if (params.isEditable) {
    items.push(
      { label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo },
      { label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
      { label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: params.editFlags.canPaste },
      { label: 'Select all', role: 'selectAll' },
    );
    sep();
  } else if (params.selectionText) {
    const text = params.selectionText;
    items.push(
      { label: 'Copy', role: 'copy' },
      {
        label: `Search for “${truncate(text)}”`,
        click: () => tabs.create(searchUrlFor(deps.getSettings().searchEngine, text)),
      },
      {
        label: `Ask the assistant about “${truncate(text, 24)}”`,
        click: () =>
          deps.askAssistant(
            `About this passage from ${wc.getURL()}:\n\n"""\n${text.slice(0, 2000)}\n"""\n\n`,
          ),
      },
    );
    // Selected text that is itself a URL is worth offering as a destination.
    if (/^https?:\/\/\S+$/i.test(text.trim())) {
      items.push({ label: 'Go to this address', click: () => tabs.create(text.trim()) });
    }
    sep();
  }

  /* --------------------------------------------------------------- page */

  if (!params.linkURL && !params.selectionText && !params.isEditable && params.mediaType === 'none') {
    items.push(
      {
        label: 'Back',
        enabled: wc.navigationHistory.canGoBack(),
        click: () => wc.navigationHistory.goBack(),
      },
      {
        label: 'Forward',
        enabled: wc.navigationHistory.canGoForward(),
        click: () => wc.navigationHistory.goForward(),
      },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      {
        label: 'Summarise this page',
        click: () => deps.askAssistant('Summarise this page for me.'),
      },
      { type: 'separator' },
      { label: 'Copy page address', click: () => clipboard.writeText(wc.getURL()) },
      { label: 'Save page as…', click: () => void wc.downloadURL(wc.getURL()) },
      { label: 'Print…', click: () => wc.print() },
      { type: 'separator' },
      {
        label: 'View page source',
        click: () => tabs.create(`view-source:${wc.getURL()}`),
      },
    );
  }

  items.push({
    label: 'Inspect element',
    click: () => {
      wc.inspectElement(params.x, params.y);
      if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus();
    },
  });

  return items;
}
