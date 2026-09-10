import { randomUUID } from 'node:crypto';
import type { Bookmark, HistoryEntry, OmniboxSuggestion, Settings } from '../shared/types';
import { JsonStore } from './store';

interface HistoryFile {
  entries: HistoryEntry[];
  nextId: number;
}

interface BookmarkFile {
  bookmarks: Bookmark[];
}

const MAX_ENTRIES = 20_000;

/**
 * History and bookmarks live in JSON rather than SQLite deliberately: a native
 * module would need rebuilding against each Electron ABI, and at browser-history
 * scale an in-memory scan is well under a frame budget.
 */
export class HistoryStore {
  private history: JsonStore<HistoryFile>;
  private bookmarksStore: JsonStore<BookmarkFile>;
  /** url -> index into entries, keeps visit merging O(1). */
  private index = new Map<string, HistoryEntry>();

  constructor() {
    this.history = new JsonStore<HistoryFile>('history.json', { entries: [], nextId: 1 });
    this.bookmarksStore = new JsonStore<BookmarkFile>('bookmarks.json', { bookmarks: [] });
    for (const e of this.history.get().entries) this.index.set(e.url, e);
  }

  record(url: string, title: string) {
    if (!/^https?:/i.test(url)) return;
    const existing = this.index.get(url);
    if (existing) {
      existing.visitedAt = Date.now();
      existing.visitCount += 1;
      if (title) existing.title = title;
    } else {
      const file = this.history.get();
      const entry: HistoryEntry = {
        id: file.nextId++,
        url,
        title: title || url,
        visitedAt: Date.now(),
        visitCount: 1,
      };
      file.entries.push(entry);
      this.index.set(url, entry);
      if (file.entries.length > MAX_ENTRIES) {
        const dropped = file.entries.splice(0, file.entries.length - MAX_ENTRIES);
        for (const d of dropped) this.index.delete(d.url);
      }
    }
    this.history.set({});
  }

  /** Updates the title of an already-recorded URL once the page reports one. */
  updateTitle(url: string, title: string) {
    const e = this.index.get(url);
    if (e && title) {
      e.title = title;
      this.history.set({});
    }
  }

  search(query: string, limit = 12): HistoryEntry[] {
    const q = query.trim().toLowerCase();
    const all = this.history.get().entries;
    if (!q) {
      return [...all].sort((a, b) => b.visitedAt - a.visitedAt).slice(0, limit);
    }
    const scored: { e: HistoryEntry; score: number }[] = [];
    for (const e of all) {
      const score = scoreMatch(q, e.url, e.title, e.visitCount, e.visitedAt);
      if (score > 0) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.e);
  }

  clear() {
    this.history.replace({ entries: [], nextId: 1 });
    this.index.clear();
    this.history.flush();
  }

  bookmarks(): Bookmark[] {
    return this.bookmarksStore.get().bookmarks;
  }

  addBookmark(url: string, title: string, folder = 'Bookmarks'): Bookmark {
    const list = this.bookmarksStore.get().bookmarks;
    const existing = list.find((b) => b.url === url);
    if (existing) return existing;
    const bm: Bookmark = {
      id: randomUUID(),
      url,
      title: title || url,
      createdAt: Date.now(),
      folder,
      // New bookmarks go on the bar by default, the way Chrome's star does.
      onBar: folder === 'Bookmarks',
    };
    list.push(bm);
    this.bookmarksStore.set({});
    this.bookmarksStore.flush();
    return bm;
  }

  updateBookmark(id: string, patch: Partial<Pick<Bookmark, 'title' | 'url' | 'folder' | 'onBar'>>) {
    const bm = this.bookmarksStore.get().bookmarks.find((b) => b.id === id);
    if (!bm) return;
    Object.assign(bm, patch);
    this.bookmarksStore.set({});
    this.bookmarksStore.flush();
  }

  /** Moves a bookmark to a new position, so the bar can be arranged. */
  reorderBookmark(id: string, toIndex: number) {
    const file = this.bookmarksStore.get();
    const from = file.bookmarks.findIndex((b) => b.id === id);
    if (from === -1) return;
    const [bm] = file.bookmarks.splice(from, 1);
    file.bookmarks.splice(Math.max(0, Math.min(toIndex, file.bookmarks.length)), 0, bm);
    this.bookmarksStore.replace(file);
  }

  removeBookmark(id: string) {
    const file = this.bookmarksStore.get();
    file.bookmarks = file.bookmarks.filter((b) => b.id !== id);
    this.bookmarksStore.replace(file);
    this.bookmarksStore.flush();
  }

  isBookmarked(url: string): boolean {
    return this.bookmarksStore.get().bookmarks.some((b) => b.url === url);
  }

  folders(): string[] {
    const names = new Set(this.bookmarksStore.get().bookmarks.map((b) => b.folder || 'Bookmarks'));
    names.add('Bookmarks');
    return [...names].sort();
  }

  /**
   * Most-visited sites for the new tab page, one entry per host so a single
   * site cannot fill the grid.
   */
  topSites(limit = 8): HistoryEntry[] {
    const best = new Map<string, HistoryEntry>();
    for (const entry of this.history.get().entries) {
      let host: string;
      try {
        host = new URL(entry.url).hostname;
      } catch {
        continue;
      }
      const current = best.get(host);
      if (!current || score(entry) > score(current)) best.set(host, entry);
    }
    return [...best.values()].sort((a, b) => score(b) - score(a)).slice(0, limit);
  }

  /** Removes everything in the given categories. */
  clearData(what: { history?: boolean; bookmarks?: boolean }) {
    if (what.history) this.clear();
    if (what.bookmarks) {
      this.bookmarksStore.replace({ bookmarks: [] });
      this.bookmarksStore.flush();
    }
  }

  flush() {
    this.history.flush();
    this.bookmarksStore.flush();
  }
}

/** Frecency: frequent and recent beat merely frequent. */
function score(entry: HistoryEntry): number {
  const ageDays = (Date.now() - entry.visitedAt) / 86_400_000;
  return entry.visitCount * 10 + Math.max(0, 60 - ageDays);
}

function scoreMatch(
  q: string,
  url: string,
  title: string,
  visitCount: number,
  visitedAt: number,
): number {
  const u = url.toLowerCase();
  const t = title.toLowerCase();
  let score = 0;
  if (u.includes(q)) score += u.startsWith(`https://${q}`) || u.startsWith(`http://${q}`) ? 100 : 40;
  if (t.includes(q)) score += t.startsWith(q) ? 60 : 30;
  if (score === 0) return 0;
  // Frecency: frequent and recent entries float to the top.
  const ageDays = (Date.now() - visitedAt) / 86_400_000;
  score += Math.min(visitCount, 25) * 2;
  score += Math.max(0, 30 - ageDays);
  return score;
}

const SEARCH_URLS: Record<Settings['searchEngine'], string> = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
};

export function searchUrlFor(engine: Settings['searchEngine'], query: string): string {
  return SEARCH_URLS[engine] + encodeURIComponent(query);
}

/**
 * Turns omnibox text into a URL. Anything that parses as a host, a known scheme
 * or a localhost/port form navigates; everything else searches.
 */
export function resolveNavigationInput(input: string, engine: Settings['searchEngine']): string {
  const raw = input.trim();
  if (!raw) return 'about:blank';
  if (/^(https?|file|about|data|chrome|nabsun|smart|view-source):/i.test(raw)) return raw;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(raw)) return `http://${raw}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(raw)) return `http://${raw}`;
  // A bare domain: at least one dot, no spaces, plausible TLD.
  if (!/\s/.test(raw) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(raw)) return `https://${raw}`;
  return searchUrlFor(engine, raw);
}

export function buildSuggestions(
  query: string,
  store: HistoryStore,
  settings: Settings,
): OmniboxSuggestion[] {
  const q = query.trim();
  const out: OmniboxSuggestion[] = [];
  if (!q) return out;

  const looksLikeUrl = resolveNavigationInput(q, settings.searchEngine).startsWith('http') &&
    !/\s/.test(q) && /\./.test(q);

  if (looksLikeUrl) {
    out.push({
      kind: 'url',
      title: q,
      subtitle: 'Open site',
      value: resolveNavigationInput(q, settings.searchEngine),
    });
  }

  out.push({
    kind: 'search',
    title: q,
    subtitle: `Search with ${settings.searchEngine}`,
    value: searchUrlFor(settings.searchEngine, q),
  });

  out.push({
    kind: 'ask',
    title: q,
    subtitle: 'Ask the AI assistant about this',
    value: q,
  });

  for (const b of store.bookmarks()) {
    if (b.title.toLowerCase().includes(q.toLowerCase()) || b.url.toLowerCase().includes(q.toLowerCase())) {
      out.push({ kind: 'bookmark', title: b.title, subtitle: b.url, value: b.url });
    }
    if (out.length > 6) break;
  }

  for (const h of store.search(q, 6)) {
    out.push({ kind: 'history', title: h.title, subtitle: h.url, value: h.url });
  }

  // De-duplicate by destination, keeping the highest-priority entry.
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.kind === 'ask' ? 'ask' : 'nav'}:${s.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}
