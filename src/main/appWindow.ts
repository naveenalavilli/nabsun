import path from 'node:path';
import { BaseWindow, WebContentsView, screen } from 'electron';
import type { Settings, WindowState } from '../shared/types';
import { CH } from '../shared/ipc';
import type { HistoryStore } from './history';
import type { SettingsStore } from './store';
import { TabManager } from './tabs';

/** Height of the tab strip plus the toolbar, in CSS pixels. */
const TOP_CHROME_H = 76;
const FIND_BAR_H = 40;
const BOOKMARK_BAR_H = 34;
const INFO_BAR_H = 46;
const MIN_SIDEBAR = 300;
const MAX_SIDEBAR_RATIO = 0.6;

export class AppWindow {
  readonly window: BaseWindow;
  readonly shell: WebContentsView;
  readonly overlay: WebContentsView;
  readonly tabs: TabManager;

  private sidebarOpen: boolean;
  private sidebarWidth: number;
  private findOpen = false;
  private bookmarksBarVisible = true;
  /**
   * A credential captured from a sign-in form, held in memory only until the
   * user answers the save prompt. Never written to disk before they agree.
   */
  pendingLogin: { origin: string; username: string; password: string } | null = null;
  private overlayVisible = false;

  constructor(
    private readonly settings: SettingsStore,
    private readonly history: HistoryStore,
  ) {
    const config = settings.get();
    this.sidebarOpen = config.sidebarOpen;
    this.sidebarWidth = config.sidebarWidth;
    this.bookmarksBarVisible = config.bookmarksBarVisible;

    const display = screen.getPrimaryDisplay().workAreaSize;
    this.window = new BaseWindow({
      width: Math.min(1680, Math.round(display.width * 0.92)),
      height: Math.min(1000, Math.round(display.height * 0.92)),
      minWidth: 900,
      minHeight: 600,
      frame: false,
      // Painted before the renderer has anything up, so it should be the
      // theme's paper rather than a dark flash on a light desktop.
      backgroundColor: '#f4f2eb',
      title: 'Nabsun',
    });

    // The mouse's side buttons. Windows delivers these as app commands rather
    // than as key events, so no menu accelerator can pick them up — and they
    // are how a lot of people navigate without thinking about it.
    this.window.on('app-command', (_event, command) => {
      const wc = this.tabs.active?.wc;
      if (!wc) return;
      if (command === 'browser-backward' && wc.navigationHistory.canGoBack()) {
        wc.navigationHistory.goBack();
      } else if (command === 'browser-forward' && wc.navigationHistory.canGoForward()) {
        wc.navigationHistory.goForward();
      }
    });

    this.shell = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'shell.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.window.contentView.addChildView(this.shell);
    void this.shell.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'shell', 'index.html'));

    // A thrown exception in the shell silently kills the browser chrome — no
    // tab strip, no buttons — with nothing visible anywhere. Surface it.
    this.shell.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') {
        console.error(`[shell:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
      }
    });
    this.shell.webContents.on('preload-error', (_e, preloadPath, error) => {
      console.error(`[shell] preload failed: ${preloadPath}`, error);
    });
    this.shell.webContents.on('render-process-gone', (_e, details) => {
      console.error('[shell] renderer process gone:', details.reason);
    });

    this.overlay = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        transparent: true,
      },
    });
    this.overlay.setBackgroundColor('#00000000');
    void this.overlay.webContents.loadFile(
      path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'),
    );

    this.tabs = new TabManager({
      window: this.window,
      preloadPath: path.join(__dirname, '..', 'preload', 'page.js'),
      partition: 'persist:nabsun',
      history: this.history,
      homepage: config.homepage,
      onFindResult: (r) => this.send(CH.findResult, r),
    });

    this.tabs.on('update', () => this.pushState());
    this.window.on('resize', () => this.layout());
    this.window.on('maximize', () => this.layout());
    this.window.on('unmaximize', () => this.layout());
    this.window.on('closed', () => this.tabs.destroyAll());

    this.layout();
  }

  /* ------------------------------------------------------------- layout -- */

  /** Extra chrome rows stacked under the toolbar, each shrinking the page. */
  private chromeHeight(): number {
    return (
      TOP_CHROME_H +
      (this.bookmarksBarVisible ? BOOKMARK_BAR_H : 0) +
      (this.findOpen ? FIND_BAR_H : 0) +
      (this.pendingLogin ? INFO_BAR_H : 0)
    );
  }

  private contentRect() {
    const [width, height] = this.window.getContentSize();
    const top = this.chromeHeight();
    const sidebar = this.sidebarOpen ? this.clampSidebar(this.sidebarWidth) : 0;
    return {
      x: 0,
      y: top,
      width: Math.max(0, width - sidebar),
      height: Math.max(0, height - top),
    };
  }

  private clampSidebar(width: number): number {
    const [winWidth] = this.window.getContentSize();
    return Math.max(MIN_SIDEBAR, Math.min(width, Math.round(winWidth * MAX_SIDEBAR_RATIO)));
  }

  /** Where the page view sits, for translating page coordinates to window ones. */
  get contentBounds() {
    return this.contentRect();
  }

  layout() {
    const [width, height] = this.window.getContentSize();
    this.shell.setBounds({ x: 0, y: 0, width, height });
    this.overlay.setBounds({ x: 0, y: 0, width, height });
    this.tabs.setBounds(this.contentRect());
    this.pushState();
  }

  /* -------------------------------------------------------------- state -- */

  get state(): WindowState {
    return {
      tabs: this.tabs.states,
      activeTabId: this.tabs.activeTabId,
      sidebarOpen: this.sidebarOpen,
      sidebarWidth: this.clampSidebar(this.sidebarWidth),
      findOpen: this.findOpen,
      bookmarksBarVisible: this.bookmarksBarVisible,
    };
  }

  pushState() {
    this.send(CH.windowState, this.state);
  }

  send(channel: string, payload?: unknown) {
    if (this.shell.webContents.isDestroyed()) return;
    this.shell.webContents.send(channel, payload);
  }

  sendOverlay(channel: string, payload?: unknown) {
    if (this.overlay.webContents.isDestroyed()) return;
    this.overlay.webContents.send(channel, payload);
  }

  /* ------------------------------------------------------------ sidebar -- */

  toggleSidebar(open?: boolean) {
    this.sidebarOpen = open ?? !this.sidebarOpen;
    this.settings.set({ sidebarOpen: this.sidebarOpen });
    this.layout();
  }

  resizeSidebar(width: number) {
    this.sidebarWidth = this.clampSidebar(width);
    this.settings.set({ sidebarWidth: this.sidebarWidth });
    this.layout();
  }

  toggleBookmarksBar(visible?: boolean) {
    this.bookmarksBarVisible = visible ?? !this.bookmarksBarVisible;
    this.settings.set({ bookmarksBarVisible: this.bookmarksBarVisible });
    this.layout();
  }

  /** Shows or hides the "save password?" bar, which shrinks the page area. */
  setPendingLogin(login: { origin: string; username: string; password: string } | null) {
    const had = Boolean(this.pendingLogin);
    this.pendingLogin = login;
    if (had !== Boolean(login)) this.layout();
  }

  setFindOpen(open: boolean) {
    if (this.findOpen === open) return;
    this.findOpen = open;
    if (!open) this.tabs.stopFind();
    this.layout();
  }

  /* ------------------------------------------------------------ overlay -- */

  /**
   * The overlay is only attached while something is showing. A permanently
   * attached transparent view would swallow every click meant for the page.
   */
  showOverlay(kind: 'omnibox' | 'palette', payload: unknown) {
    if (!this.overlayVisible) {
      this.window.contentView.addChildView(this.overlay);
      this.overlayVisible = true;
      this.layout();
    }
    // The overlay has no settings channel of its own, and it is only ever on
    // screen in response to this message — so the theme rides along with it
    // rather than the overlay guessing from the OS and mismatching the shell.
    const theme = this.settings.get().theme;
    this.sendOverlay(CH.overlayOpen, {
      kind,
      payload,
      theme: theme === 'system' ? null : theme,
    });
    this.overlay.webContents.focus();
  }

  hideOverlay() {
    if (!this.overlayVisible) return;
    this.window.contentView.removeChildView(this.overlay);
    this.overlayVisible = false;
    this.tabs.active?.wc.focus();
  }

  get isOverlayVisible(): boolean {
    return this.overlayVisible;
  }

  /* -------------------------------------------------- extension popups -- */

  private popup: WebContentsView | null = null;
  /** Resolves an extension id to its popup URL and size. */
  private popupResolver: ((id: string) => { url: string } | null) | null = null;

  setExtensionPopupResolver(resolve: (id: string) => { url: string } | null) {
    this.popupResolver = resolve;
  }

  /**
   * Chromium does not draw extension toolbar buttons or their popups — that is
   * browser UI, and in Electron the browser is us. The popup is a plain view in
   * the extension's own session, anchored under its button.
   */
  showExtensionPopup(extensionId: string, anchorX: number) {
    this.hideExtensionPopup();
    const target = this.popupResolver?.(extensionId);
    if (!target) return;

    const width = 380;
    const height = 520;
    const [winWidth] = this.window.getContentSize();

    const view = new WebContentsView({
      webPreferences: {
        // Must match the tabs' partition, or the extension is not installed
        // in the session this view runs in.
        partition: 'persist:nabsun',
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.popup = view;
    this.window.contentView.addChildView(view);
    view.setBorderRadius(8);
    view.setBounds({
      // Keep the popup on screen when its button is near the right edge.
      x: Math.max(8, Math.min(Math.round(anchorX) - width + 20, winWidth - width - 8)),
      y: TOP_CHROME_H - 4,
      width,
      height,
    });
    void view.webContents.loadURL(target.url);

    // Dismiss the way a real popup does: on blur, or on Escape.
    view.webContents.on('blur', () => this.hideExtensionPopup());
    view.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'Escape') this.hideExtensionPopup();
    });
    view.webContents.focus();
  }

  hideExtensionPopup() {
    if (!this.popup) return;
    const view = this.popup;
    this.popup = null;
    try {
      this.window.contentView.removeChildView(view);
      view.webContents.close();
    } catch {
      /* already gone */
    }
  }

  applySettings(next: Settings) {
    if (next.sidebarWidth !== this.sidebarWidth) {
      this.sidebarWidth = next.sidebarWidth;
      this.layout();
    }
  }
}

