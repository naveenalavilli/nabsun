import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebContentsView, type BaseWindow, type WebContents, shell } from 'electron';
import type { TabState } from '../shared/types';
import type { HistoryStore } from './history';

/** Isolated world reserved for the agent bridge; page scripts cannot reach it. */
const AGENT_WORLD_ID = 1729;

let bridgeSource: string | null = null;

function loadBridgeSource(): string {
  if (bridgeSource) return bridgeSource;
  const file = path.join(__dirname, '..', 'page', 'agent-bridge.js');
  bridgeSource = fs.readFileSync(file, 'utf8');
  return bridgeSource;
}

export class Tab {
  readonly id = randomUUID();
  readonly view: WebContentsView;
  pinned = false;
  error: string | null = null;
  /**
   * The address the user asked for when a navigation failed. A failed first
   * load commits no entry, so `getURL()` is empty and this is what the omnibox
   * has to show.
   */
  failedUrl: string | null = null;
  agentControlled = false;
  /** Set when the tab was created by the agent, so it can be cleaned up. */
  createdByAgent = false;

  constructor(preloadPath: string, partition: string) {
    this.view = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition,
        // Pages get the standard web security model; the agent reaches them
        // through the isolated world, never by relaxing this.
        webSecurity: true,
        spellcheck: true,
      },
    });
  }

  get wc(): WebContents {
    return this.view.webContents;
  }

  get state(): TabState {
    const wc = this.wc;
    return {
      id: this.id,
      // Show the address that was asked for, even though it never committed.
      url: this.failedUrl ?? wc.getURL(),
      title: wc.getTitle() || this.failedUrl || wc.getURL() || 'New Tab',
      favicon: this.favicon,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      audible: wc.isCurrentlyAudible(),
      muted: wc.isAudioMuted(),
      pinned: this.pinned,
      error: this.error,
      agentControlled: this.agentControlled,
    };
  }

  favicon: string | null = null;

  destroy() {
    try {
      this.wc.close();
    } catch {
      /* already gone */
    }
  }
}

export interface TabManagerOptions {
  window: BaseWindow;
  preloadPath: string;
  partition: string;
  history: HistoryStore;
  homepage: string;
  onFindResult: (r: { activeMatch: number; matches: number }) => void;
}

export declare interface TabManager {
  on(event: 'update', listener: () => void): this;
  on(event: 'tab-navigated', listener: (tab: Tab) => void): this;
  on(event: 'tab-created', listener: (tab: Tab) => void): this;
  emit(event: 'update'): boolean;
  emit(event: 'tab-navigated', tab: Tab): boolean;
  emit(event: 'tab-created', tab: Tab): boolean;
}

export class TabManager extends EventEmitter {
  private tabs: Tab[] = [];
  private activeId: string | null = null;
  private bounds = { x: 0, y: 0, width: 800, height: 600 };
  private opts: TabManagerOptions;

  constructor(opts: TabManagerOptions) {
    super();
    this.opts = opts;
  }

  get all(): Tab[] {
    return this.tabs;
  }

  get active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  get activeTabId(): string | null {
    return this.activeId;
  }

  get states(): TabState[] {
    return this.tabs.map((t) => t.state);
  }

  byId(id: string): Tab | null {
    return this.tabs.find((t) => t.id === id) ?? null;
  }

  /** The tab tools operate on: the agent's target, else the active tab. */
  resolveTarget(tabId?: string): Tab {
    const tab = tabId ? this.byId(tabId) : this.active;
    if (!tab) throw new Error(tabId ? `No tab with id ${tabId}` : 'No active tab');
    return tab;
  }

  create(url?: string, opts: { background?: boolean; byAgent?: boolean } = {}): Tab {
    const tab = new Tab(this.opts.preloadPath, this.opts.partition);
    tab.createdByAgent = Boolean(opts.byAgent);
    this.wire(tab);
    this.tabs.push(tab);
    this.opts.window.contentView.addChildView(tab.view);
    tab.view.setVisible(false);
    this.emit('tab-created', tab);

    const target = url || this.opts.homepage;
    void this.loadUrl(tab, target);

    if (!opts.background || this.tabs.length === 1) this.activate(tab.id);
    else this.emitUpdate();
    return tab;
  }

  private async loadUrl(tab: Tab, url: string) {
    try {
      await tab.wc.loadURL(url);
    } catch (err: unknown) {
      // ERR_ABORTED fires for ordinary redirect/cancel races; surfacing it as a
      // tab error would flag healthy navigations as failures.
      const message = err instanceof Error ? err.message : String(err);
      if (!/ERR_ABORTED/.test(message)) {
        tab.error = message;
        this.emitUpdate();
      }
    }
  }

  close(id: string) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [tab] = this.tabs.splice(idx, 1);

    const url = tab.wc.getURL();
    if (/^https?:/i.test(url)) {
      this.closed.push({ url, index: idx });
      if (this.closed.length > 25) this.closed.shift();
    }

    try {
      this.opts.window.contentView.removeChildView(tab.view);
    } catch {
      /* view already detached */
    }
    tab.destroy();

    if (this.activeId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activeId = next?.id ?? null;
      if (next) {
        next.view.setVisible(true);
        this.layoutActive();
        next.wc.focus();
      }
    }
    this.emitUpdate();
  }

  activate(id: string) {
    const tab = this.byId(id);
    if (!tab) return;
    for (const t of this.tabs) t.view.setVisible(t.id === id);
    this.activeId = id;
    // Re-adding raises the view above the shell so it is not painted over.
    this.opts.window.contentView.addChildView(tab.view);
    this.layoutActive();
    tab.wc.focus();
    this.emitUpdate();
  }

  reorder(id: string, toIndex: number) {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from === -1) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab);
    this.emitUpdate();
  }

  duplicate(id: string) {
    const tab = this.byId(id);
    if (!tab) return;
    this.create(tab.wc.getURL());
  }

  /** Closed tabs, most recent last, for Ctrl+Shift+T. */
  private closed: { url: string; index: number }[] = [];

  reopenLast() {
    const entry = this.closed.pop();
    if (!entry) return;
    const tab = this.create(entry.url);
    this.reorder(tab.id, entry.index);
  }

  /* ---------------------------------------------------------------- zoom -- */

  private static readonly ZOOM_STEPS = [-3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3, 4];

  /** Chrome-like stepping, rather than free-running zoom levels. */
  zoom(id: string, direction: 'in' | 'out' | 'reset') {
    const tab = this.byId(id);
    if (!tab) return;
    if (direction === 'reset') {
      tab.wc.setZoomLevel(0);
    } else {
      const current = tab.wc.getZoomLevel();
      const steps = TabManager.ZOOM_STEPS;
      const nearest = steps.reduce((a, b) => (Math.abs(b - current) < Math.abs(a - current) ? b : a));
      const i = steps.indexOf(nearest);
      const next = steps[Math.max(0, Math.min(steps.length - 1, i + (direction === 'in' ? 1 : -1)))];
      tab.wc.setZoomLevel(next);
    }
    this.emitUpdate();
  }

  /* ------------------------------------------------- selection / cycling -- */

  /** Moves the active tab by `delta`, wrapping around like Ctrl+Tab. */
  cycle(delta: number) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = (i + delta + this.tabs.length) % this.tabs.length;
    this.activate(this.tabs[next].id);
  }

  /** Ctrl+1..8 select by position; Ctrl+9 selects the last tab. */
  activateByIndex(index: number) {
    const tab = index === -1 ? this.tabs[this.tabs.length - 1] : this.tabs[index];
    if (tab) this.activate(tab.id);
  }

  /* ------------------------------------------------------ session restore -- */

  /** URLs worth restoring on the next launch. */
  snapshot(): { urls: string[]; activeIndex: number } {
    const urls = this.tabs
      .map((t) => t.wc.getURL())
      .filter((u) => /^(https?|nabsun|smart):/i.test(u));
    return {
      urls,
      activeIndex: Math.max(0, this.tabs.findIndex((t) => t.id === this.activeId)),
    };
  }

  restore(session: { urls: string[]; activeIndex: number }): boolean {
    if (!session.urls?.length) return false;
    session.urls.forEach((url, i) => this.create(url, { background: i !== session.activeIndex }));
    return true;
  }

  navigate(id: string, url: string) {
    const tab = this.byId(id);
    if (!tab) return;
    tab.error = null;
    void this.loadUrl(tab, url);
  }

  /** Content-area rectangle, in window coordinates. */
  setBounds(b: { x: number; y: number; width: number; height: number }) {
    this.bounds = b;
    this.layoutActive();
  }

  private layoutActive() {
    const tab = this.active;
    if (!tab) return;
    tab.view.setBounds(this.bounds);
  }

  /* ------------------------------------------------------------- events -- */

  private wire(tab: Tab) {
    const wc = tab.wc;
    const update = () => this.emitUpdate();

    wc.on('page-title-updated', (_e, title) => {
      this.opts.history.updateTitle(wc.getURL(), title);
      update();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons[0] ?? null;
      update();
    });
    wc.on('did-start-loading', update);
    wc.on('did-stop-loading', update);
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return;
      // A failed load produces extra navigations of its own — Chromium's error
      // commit, and ours replacing it. Neither is a fresh attempt, so neither
      // may clear the failure they exist to report.
      if (!isErrorArtefact(details.url, tab.failedUrl)) {
        tab.error = null;
        tab.failedUrl = null;
      }
      update();
    });
    wc.on('did-navigate', (_e, url) => {
      this.opts.history.record(url, wc.getTitle());
      this.emit('tab-navigated', tab);
      update();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) this.opts.history.record(url, wc.getTitle());
      update();
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 is ERR_ABORTED, emitted on ordinary navigation cancellation.
      if (!isMainFrame || code === -3) return;
      tab.error = `${desc} (${code}) while loading ${url}`;
      tab.failedUrl = url;
      // `desc` is the symbolic name, e.g. ERR_NAME_NOT_RESOLVED.
      renderErrorPage(wc, { url, code: desc, desc: `${desc} (${code})` });
      update();
    });
    wc.on('media-started-playing', update);
    wc.on('media-paused', update);
    wc.on('audio-state-changed', update);
    wc.on('found-in-page', (_e, result) => {
      this.opts.onFindResult({ activeMatch: result.activeMatchOrdinal, matches: result.matches });
    });
    wc.on('render-process-gone', (_e, details) => {
      tab.error = `Page process ended: ${details.reason}`;
      update();
    });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window' || disposition === 'foreground-tab' || disposition === 'background-tab') {
        this.create(url, { background: disposition === 'background-tab' });
        return { action: 'deny' };
      }
      // Anything else (e.g. `save-to-disk`) goes to the OS handler rather than
      // silently opening an unmanaged Electron window.
      if (/^https?:/.test(url)) {
        this.create(url);
      } else {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // External schemes (mailto:, tel:, custom app links) leave the browser.
    wc.on('will-navigate', (event, url) => {
      if (!/^(https?|file|about|data|nabsun|smart|view-source|chrome):/i.test(url)) {
        event.preventDefault();
        void shell.openExternal(url);
      }
    });
  }

  private updateScheduled = false;

  emitUpdate() {
    // Chromium fires navigation/loading events in bursts; coalescing them into
    // one frame keeps the shell from re-rendering dozens of times per load.
    if (this.updateScheduled) return;
    this.updateScheduled = true;
    setTimeout(() => {
      this.updateScheduled = false;
      this.emit('update');
    }, 16);
  }

  /* ---------------------------------------------------------- find --------*/

  find(query: string, forward = true, findNext = false) {
    const tab = this.active;
    if (!tab) return;
    if (!query) {
      tab.wc.stopFindInPage('clearSelection');
      return;
    }
    tab.wc.findInPage(query, { forward, findNext });
  }

  stopFind() {
    this.active?.wc.stopFindInPage('clearSelection');
  }

  /* --------------------------------------------------- agent bridge ------ */

  /**
   * Evaluates an expression against the agent bridge in the tab's isolated
   * world, injecting the bridge first if this document has not seen it yet.
   */
  async callBridge<T>(tab: Tab, expression: string, signal?: AbortSignal): Promise<T> {
    const wc = tab.wc;

    /**
     * Cancellation is rechecked after every await on the way to the page.
     *
     * Checking once in the tool handler was not enough, because the journey
     * from there to the renderer contains awaits of its own: the isolated-world
     * presence check, and possibly injecting the bridge. A Stop landing during
     * either still ended with the click being submitted afterwards. The last
     * check sits immediately before the expression is handed to the renderer,
     * which is the real boundary — anything above it is a layer that a later
     * layer can outlive.
     *
     * What remains is the synchronous window between that final check and the
     * IPC send, which cannot be closed from this side: once the renderer has
     * the expression, only the page could refuse it.
     */
    const stillWanted = () => {
      if (signal?.aborted) throw new Error('Stopped before this action reached the page.');
    };

    stillWanted();
    const present = await wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [
      { code: 'typeof window.__nabsunAgent !== "undefined" && window.__nabsunAgent.version === 1' },
    ]);
    stillWanted();
    if (!present) {
      await wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code: loadBridgeSource() }]);
      stillWanted();
    }
    // Errors thrown inside the page are returned as a tagged object so that the
    // real message survives the IPC boundary instead of becoming "Script error".
    const wrapped = `(() => { try { return { ok: true, value: ${expression} }; }
      catch (e) { return { ok: false, error: (e && e.message) ? e.message : String(e) }; } })()`;
    stillWanted();
    const result = (await wc.executeJavaScriptInIsolatedWorld(
      AGENT_WORLD_ID,
      [{ code: wrapped }],
      true,
    )) as { ok: true; value: T } | { ok: false; error: string };
    if (!result || typeof result !== 'object') throw new Error('Page bridge returned no result');
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  /** Waits until the document is complete and the network has gone quiet. */
  async waitForSettled(tab: Tab, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!tab.wc.isLoading()) {
        try {
          const r = await this.callBridge<{ ready: boolean }>(tab, 'window.__nabsunAgent.readyState()');
          if (r.ready) return;
        } catch {
          // Mid-navigation the world is torn down; retry on the next tick.
        }
      }
      await delay(150);
    }
  }

  async screenshot(tab: Tab, maxWidth = 1200): Promise<{ data: string; mediaType: string }> {
    const image = await tab.wc.capturePage();
    const size = image.getSize();
    const scaled = size.width > maxWidth
      ? image.resize({ width: maxWidth, quality: 'good' })
      : image;
    return { data: scaled.toPNG().toString('base64'), mediaType: 'image/png' };
  }

  destroyAll() {
    for (const tab of this.tabs) tab.destroy();
    this.tabs = [];
    this.activeId = null;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replaces Chromium's built-in error page with one that names the problem in
 * plain language and offers a retry.
 *
 * Two things were tried first and did not work. Rewriting the existing document
 * with `executeJavaScript` would have preserved the URL and reload behaviour,
 * but scripts do not run reliably inside Chromium's error pages. Navigating
 * synchronously from inside `did-fail-load` gets aborted while the failed
 * navigation is still being torn down. So: navigate, but on the next tick.
 *
 * A failed first navigation commits no entry, so `getURL()` stays empty
 * afterwards. `Tab.failedUrl` records the address for the omnibox.
 */
function renderErrorPage(wc: WebContents, params: { url: string; code: string; desc: string }): void {
  const query = new URLSearchParams(params).toString();
  setTimeout(() => {
    if (wc.isDestroyed()) return;
    // Only skip when the tab has genuinely moved on. Counting navigation
    // events was unreliable here: a failed load emits extra ones of its own,
    // which made this skip at random and leave Chromium's page in place.
    if (!isErrorArtefact(wc.getURL(), params.url)) return;
    void wc.loadURL(`nabsun://error?${query}`).catch(() => {});
  }, 0);
}

/**
 * True for the URLs a failed navigation leaves behind: nothing committed, the
 * address that failed, Chromium's internal error document, or our replacement.
 */
function isErrorArtefact(url: string, failedUrl: string | null): boolean {
  if (!url) return true;
  if (url.startsWith('chrome-error://') || url.startsWith('nabsun://error')) return true;
  return failedUrl !== null && url === failedUrl;
}

