import fs from 'node:fs';
import path from 'node:path';
import type { Extension, Session } from 'electron';
import type { ChromeExtensionEntry, ExtensionStatus } from '../../shared/types';

/**
 * Chrome extension host.
 *
 * Electron implements a subset of the Chrome Extensions API on top of the same
 * Chromium machinery: content scripts, `chrome.storage`, `chrome.runtime`,
 * much of `chrome.tabs`, `chrome.webRequest`, and devtools pages all work.
 * Extensions are loaded unpacked from a folder — there is no Web Store install
 * flow — and Chromium does not draw the toolbar button or popup for us, so the
 * browser renders those itself (see AppWindow's action popup).
 *
 * Extensions load into the *tab partition's* session, which is what makes
 * content scripts run in the pages the user is actually looking at.
 */
export class ChromeExtensionManager {
  private session: Session | null = null;
  /** path -> the load error, so the UI can explain a failure. */
  private errors = new Map<string, string>();

  constructor(private readonly getEntries: () => ChromeExtensionEntry[]) {}

  /**
   * Chromium will not load extensions into an in-memory session, so this must
   * be a `persist:` partition. Attaching a temporary one fails every load with
   * "Extensions cannot be loaded in a temporary session", so say so up front.
   */
  attach(session: Session) {
    if (!session.isPersistent()) {
      console.error('[extensions] refusing to attach: extensions need a persistent session');
      return;
    }
    this.session = session;
  }

  /**
   * Extensions are not persisted by Chromium across runs, so every enabled one
   * is re-loaded on each boot. One broken extension must not stop the others.
   */
  async loadAll(): Promise<void> {
    if (!this.session) return;
    this.errors.clear();

    // Unload anything already present so this doubles as "reload".
    for (const ext of this.session.extensions.getAllExtensions()) {
      try {
        this.session.extensions.removeExtension(ext.id);
      } catch {
        /* already gone */
      }
    }

    for (const entry of this.getEntries()) {
      if (entry.enabled === false) continue;
      await this.loadOne(entry.path);
    }
  }

  private async loadOne(dir: string): Promise<Extension | null> {
    if (!this.session) return null;
    try {
      if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
        throw new Error('No manifest.json in that folder');
      }
      return await this.session.extensions.loadExtension(dir, { allowFileAccess: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[extensions] failed to load ${dir}:`, message);
      this.errors.set(dir, message);
      return null;
    }
  }

  /** Loads a folder immediately and reports what happened. */
  async add(dir: string): Promise<{ ok: boolean; error?: string; name?: string }> {
    const ext = await this.loadOne(dir);
    if (!ext) return { ok: false, error: this.errors.get(dir) ?? 'Could not load that folder' };
    return { ok: true, name: ext.name };
  }

  remove(extensionId: string) {
    try {
      this.session?.extensions.removeExtension(extensionId);
    } catch {
      /* not loaded */
    }
  }

  get loaded(): Extension[] {
    return this.session?.extensions.getAllExtensions() ?? [];
  }

  byId(id: string): Extension | null {
    return this.loaded.find((e) => e.id === id) ?? null;
  }

  status(): ExtensionStatus[] {
    const live = this.loaded;
    const out: ExtensionStatus[] = [];

    for (const entry of this.getEntries()) {
      // Match by path: ids are only assigned once an extension actually loads.
      const ext = live.find((e) => samePath(e.path, entry.path));
      const action = ext ? readAction(ext) : null;
      out.push({
        id: ext?.id ?? '',
        name: ext?.name ?? path.basename(entry.path),
        version: ext?.version ?? '',
        description: ext?.manifest?.description ?? '',
        path: entry.path,
        enabled: entry.enabled !== false,
        loaded: Boolean(ext),
        error: this.errors.get(entry.path),
        hasAction: Boolean(action?.popup || action?.hasAction),
        popupPath: action?.popup ?? undefined,
        iconDataUrl: ext ? readIcon(ext) : undefined,
        manifestVersion: ext?.manifest?.manifest_version ?? 0,
      });
    }
    return out;
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

interface ActionInfo {
  hasAction: boolean;
  popup: string | null;
  icon: string | null;
}

/** MV3 uses `action`; MV2 used `browser_action` / `page_action`. */
function readAction(ext: Extension): ActionInfo {
  const m = ext.manifest ?? {};
  const action = m.action ?? m.browser_action ?? m.page_action;
  if (!action) return { hasAction: false, popup: null, icon: null };
  return {
    hasAction: true,
    popup: typeof action.default_popup === 'string' ? action.default_popup : null,
    icon: pickIcon(action.default_icon) ?? pickIcon(m.icons),
  };
}

/** Chooses the largest icon at or under 64px, falling back to whatever exists. */
function pickIcon(spec: unknown): string | null {
  if (!spec) return null;
  if (typeof spec === 'string') return spec;
  if (typeof spec !== 'object') return null;
  const entries = Object.entries(spec as Record<string, string>)
    .map(([size, file]) => ({ size: Number(size) || 0, file }))
    .sort((a, b) => a.size - b.size);
  if (!entries.length) return null;
  const preferred = entries.filter((e) => e.size <= 64).pop();
  return (preferred ?? entries[entries.length - 1]).file;
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/**
 * Reads the action icon off disk as a data URL. The shell renderer cannot load
 * `chrome-extension://` URLs — its CSP does not allow them and it is not in the
 * extension's session — so the bytes travel over IPC instead.
 */
function readIcon(ext: Extension): string | undefined {
  const action = readAction(ext);
  const rel = action.icon ?? pickIcon(ext.manifest?.icons);
  if (!rel) return undefined;
  try {
    const file = path.join(ext.path, rel);
    if (!path.resolve(file).startsWith(path.resolve(ext.path))) return undefined;
    const data = fs.readFileSync(file);
    const mime = MIME[path.extname(file).toLowerCase()] ?? 'image/png';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    return undefined;
  }
}
