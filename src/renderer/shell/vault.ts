import type { Bookmark, PasswordPrompt, SavedLogin } from '../../shared/types';
import type { UiNotice } from '../../shared/ipc';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------ bookmarks -- */

/**
 * The bookmarks bar and the bookmarks manager. Both render from one list, so a
 * change in either shows up in the other without a reload.
 */
export class BookmarksView {
  private bar = $('#bookmarks-bar');
  private body = $('#bookmarks-body');
  private items: Bookmark[] = [];
  /** Opens the manager view. Supplied by the shell, which owns view switching. */
  private openManager: () => void = () => {};

  constructor(openManager?: () => void) {
    if (openManager) this.openManager = openManager;
    window.nabsun.data.onBookmarksChanged((items) => {
      this.items = items;
      this.renderBar();
      if (this.body.offsetParent !== null) this.renderManager();
    });

    $('#bm-bar-toggle').addEventListener('click', () => window.nabsun.data.toggleBookmarksBar());
  }

  async refresh(): Promise<void> {
    this.items = await window.nabsun.data.bookmarks();
    this.renderBar();
  }

  async render(): Promise<void> {
    await this.refresh();
    this.renderManager();
  }

  /** The strip under the toolbar. Only bookmarks flagged for the bar appear. */
  private renderBar() {
    this.bar.textContent = '';
    const onBar = this.items.filter((b) => b.onBar !== false);

    // The only visible way into the manager. The window is frameless, so the
    // menu holding "Bookmarks" is never drawn, and the ☆ in the toolbar saves
    // rather than opens. Rendered before the early return so it is there even
    // when nothing is bookmarked yet — which is exactly when someone goes
    // looking for where bookmarks live.
    const manage = el('button', {
      className: 'bm-manage',
      title: 'Manage bookmarks (Ctrl+Shift+O)',
      textContent: '★ All bookmarks',
    });
    manage.addEventListener('click', () => this.openManager());
    this.bar.append(manage);

    if (!onBar.length) {
      this.bar.append(
        el('span', {
          className: 'bm-empty',
          textContent: 'Bookmark a page with the ☆ or Ctrl+D and it appears here.',
        }),
      );
      return;
    }

    for (const bm of onBar) {
      const btn = el('button', { className: 'bm-item', title: `${bm.title}\n${bm.url}` });
      btn.append(
        el('span', { className: 'bm-favicon', textContent: hostOf(bm.url).charAt(0).toUpperCase() }),
        el('span', { className: 'bm-label', textContent: bm.title }),
      );
      btn.addEventListener('click', () => {
        const id = window.__activeTabId;
        if (id) window.nabsun.tabs.navigate(id, bm.url);
        else void window.nabsun.tabs.create(bm.url);
      });
      // Middle-click opens in a background tab, as everywhere else.
      btn.addEventListener('auxclick', (e) => {
        if (e.button === 1) void window.nabsun.tabs.create(bm.url, { background: true });
      });
      this.bar.append(btn);
    }
  }

  private renderManager() {
    this.body.textContent = '';
    if (!this.items.length) {
      this.body.append(
        el('div', { className: 'muted', textContent: 'No bookmarks yet.' }),
      );
      return;
    }

    // Grouped by folder, so folders are visible without a tree widget.
    const folders = new Map<string, Bookmark[]>();
    for (const bm of this.items) {
      const key = bm.folder || 'Bookmarks';
      if (!folders.has(key)) folders.set(key, []);
      folders.get(key)!.push(bm);
    }

    for (const [folder, list] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) {
      this.body.append(el('div', { className: 'bm-folder', textContent: folder }));
      for (const bm of list) this.body.append(this.row(bm));
    }
  }

  private row(bm: Bookmark): HTMLElement {
    const row = el('div', { className: 'bm-row' });
    const text = el('div', { className: 't' }, [
      el('div', { className: 't-title', textContent: bm.title }),
      el('div', { className: 't-url', textContent: bm.url }),
    ]);

    const acts = el('div', { className: 'acts' });

    const open = el('button', { textContent: 'Open' });
    open.addEventListener('click', () => void window.nabsun.tabs.create(bm.url));

    const rename = el('button', { textContent: 'Rename' });
    rename.addEventListener('click', async () => {
      const title = prompt('Bookmark name', bm.title);
      if (title === null) return;
      this.items = await window.nabsun.data.updateBookmark(bm.id, { title });
      this.renderManager();
      this.renderBar();
    });

    const move = el('button', { textContent: 'Folder' });
    move.addEventListener('click', async () => {
      const folder = prompt('Folder name', bm.folder || 'Bookmarks');
      if (folder === null) return;
      this.items = await window.nabsun.data.updateBookmark(bm.id, { folder: folder || 'Bookmarks' });
      this.renderManager();
    });

    const onBar = el('button', { textContent: bm.onBar === false ? 'Add to bar' : 'Hide from bar' });
    onBar.addEventListener('click', async () => {
      this.items = await window.nabsun.data.updateBookmark(bm.id, { onBar: bm.onBar === false });
      this.renderManager();
      this.renderBar();
    });

    const remove = el('button', { textContent: 'Delete' });
    remove.addEventListener('click', async () => {
      await window.nabsun.data.removeBookmark(bm.id);
      await this.render();
    });

    acts.append(open, rename, move, onBar, remove);
    row.append(text, acts);
    return row;
  }
}

/* ------------------------------------------------------------ passwords -- */

/**
 * Saved passwords: the "save this?" bar under the toolbar, and the manager.
 *
 * A password is only ever sent to this renderer when the user explicitly asks
 * to see one — the list itself carries metadata only.
 */
export class PasswordsView {
  private body = $('#passwords-body');
  private bar = $('#password-bar');
  private items: SavedLogin[] = [];
  /**
   * True while the bar is showing an error rather than a prompt.
   *
   * The two share one bar, and the events arrive in the order notice → clear
   * prompt, so without this the clear silently erased the error.
   */
  private noticeShowing = false;

  constructor() {
    window.nabsun.passwords.onPrompt((prompt) => this.showPrompt(prompt));

    $('#pw-save').addEventListener('click', () => {
      window.nabsun.passwords.confirmSave();
      this.hidePrompt();
      void this.refresh();
    });
    $('#pw-never').addEventListener('click', () => {
      window.nabsun.passwords.dismissPrompt();
      this.hidePrompt();
    });

    // A save that refused to write must be visible. Nothing consumed this
    // channel before, so the browser reported the refusal to no one and the
    // user was left believing their password had been stored.
    window.nabsun.onNotice((notice) => this.showNotice(notice));
  }

  /** Reuses the password bar to state an outcome, with nothing to answer. */
  private showNotice(notice: UiNotice) {
    $('#pw-message').textContent = notice.message;
    $('#pw-save').hidden = true;
    $('#pw-never').textContent = 'Dismiss';
    this.bar.dataset.kind = notice.kind;
    this.bar.hidden = false;
    // An error stays until the user dismisses it. The main process sends the
    // notice and then clears the prompt, and that second event used to hide the
    // bar the notice had just been written into — so a password that failed to
    // save reported nothing at all.
    this.noticeShowing = notice.kind === 'error';
  }

  private showPrompt(prompt: PasswordPrompt | null) {
    if (!prompt) {
      // Dismissing the prompt is not dismissing an error about it.
      if (!this.noticeShowing) this.hidePrompt();
      return;
    }
    this.noticeShowing = false;
    // Restore the prompt's own controls, in case a notice borrowed the bar.
    $('#pw-save').hidden = false;
    $('#pw-never').textContent = 'Not now';
    delete this.bar.dataset.kind;

    const who = prompt.username ? `${prompt.username} on ` : '';
    $('#pw-message').textContent = prompt.isUpdate
      ? `Update the saved password for ${who}${hostOf(prompt.origin)}?`
      : `Save the password for ${who}${hostOf(prompt.origin)}?`;
    this.bar.hidden = false;
  }

  private hidePrompt() {
    this.bar.hidden = true;
    // Whatever the bar was showing is gone, including an error.
    this.noticeShowing = false;
  }

  async refresh(): Promise<void> {
    this.items = await window.nabsun.passwords.list();
  }

  async render(): Promise<void> {
    await this.refresh();
    this.body.textContent = '';

    const note = el('div', {
      className: 'hint',
      textContent:
        'Encrypted with your operating system keychain. Autofill only ever matches the exact origin a password was saved for.',
    });
    this.body.append(note);

    if (!this.items.length) {
      this.body.append(
        el('div', { className: 'muted', textContent: 'No saved passwords yet.' }),
      );
      return;
    }

    for (const login of this.items) this.body.append(this.row(login));

    const clear = el('button', { className: 'ghost', textContent: 'Delete all saved passwords' });
    let armed = false;
    clear.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        clear.textContent = 'Click again to confirm';
        clear.className = 'danger';
        setTimeout(() => {
          armed = false;
          clear.textContent = 'Delete all saved passwords';
          clear.className = 'ghost';
        }, 4000);
        return;
      }
      await window.nabsun.data.clear({
        history: false,
        bookmarks: false,
        passwords: true,
        cookies: false,
        cache: false,
      });
      await this.render();
    });
    const footer = el('div', { className: 'inline' }, [clear]);
    footer.style.marginTop = '14px';
    this.body.append(footer);
  }

  private row(login: SavedLogin): HTMLElement {
    const row = el('div', { className: 'pw-row' });
    const secret = el('span', { className: 'pw-secret', textContent: '••••••••' });

    const text = el('div', { className: 't' }, [
      el('div', { className: 't-title', textContent: hostOf(login.origin) }),
      el('div', { className: 't-sub', textContent: login.username || '(no username)' }),
    ]);

    const acts = el('div', { className: 'acts' });

    let shown = false;
    const show = el('button', { textContent: 'Show' });
    show.addEventListener('click', async () => {
      if (shown) {
        secret.textContent = '••••••••';
        show.textContent = 'Show';
        shown = false;
        return;
      }
      const value = await window.nabsun.passwords.reveal(login.id);
      secret.textContent = value ?? '(could not decrypt)';
      show.textContent = 'Hide';
      shown = true;
    });

    const copy = el('button', { textContent: 'Copy' });
    copy.addEventListener('click', async () => {
      const value = await window.nabsun.passwords.reveal(login.id);
      if (value) await navigator.clipboard.writeText(value);
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    });

    const remove = el('button', { textContent: 'Delete' });
    remove.addEventListener('click', async () => {
      this.items = await window.nabsun.passwords.remove(login.id);
      await this.render();
    });

    acts.append(show, copy, remove);
    row.append(text, secret, acts);
    return row;
  }
}

declare global {
  interface Window {
    /** Set by the shell so bar clicks can navigate the current tab. */
    __activeTabId: string | null;
  }
}
