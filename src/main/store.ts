import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderId, Settings } from '../shared/types';

/** Minimal JSON store with atomic writes and an in-memory cache. */
export class JsonStore<T extends object> {
  private cache: T;
  private readonly file: string;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(fileName: string, private readonly defaults: T) {
    this.file = path.join(app.getPath('userData'), fileName);
    this.cache = this.read();
  }

  private read(): T {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return { ...this.defaults, ...(JSON.parse(raw) as T) };
    } catch {
      return { ...this.defaults };
    }
  }

  get(): T {
    return this.cache;
  }

  set(patch: Partial<T>): T {
    this.cache = { ...this.cache, ...patch };
    this.scheduleWrite();
    return this.cache;
  }

  replace(value: T): T {
    this.cache = value;
    this.scheduleWrite();
    return this.cache;
  }

  /** Debounced so rapid updates (sidebar drag, scroll state) don't thrash disk. */
  private scheduleWrite() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] failed to persist', this.file, err);
    }
  }
}

export const DEFAULT_SETTINGS: Settings = {
  // The bundled model: works on first launch with no account, no key and no
  // network, and costs nothing per action. Everything else is one setting away.
  provider: 'local',
  models: {
    local: 'Qwen3-1.7B-Q4_K_M',
    anthropic: 'claude-opus-5',
    openai: 'gpt-5.1',
    ollama: 'llama3.1',
    // CLI backends pick their own default; blank means "whatever it is set to".
    'claude-cli': '',
    'codex-cli': '',
  },
  baseUrls: {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com/v1',
    ollama: 'http://127.0.0.1:11434',
  },
  cliPaths: { 'claude-cli': '', 'codex-cli': '' },
  // Blank paths mean the bundled engine and weights; 8k holds a page snapshot
  // plus a few turns without asking a low-spec machine for too much RAM.
  localModel: { serverPath: '', modelPath: '', contextSize: 8192, threads: 0 },
  homepage: 'nabsun://home',
  searchEngine: 'duckduckgo',
  // Light by default: a browser is mostly other people's pages, and most of the
  // web is white — a dark shell around a white page is a glare sandwich.
  // 'dark' and 'system' are both available in Settings.
  theme: 'light',
  sidebarWidth: 420,
  sidebarOpen: true,
  autoApprove: { safe: true, write: false, dangerous: false },
  alwaysAllowTools: [],
  maxAgentSteps: 40,
  vision: true,
  extendedThinking: false,
  blockAds: true,
  bookmarksBarVisible: true,
  savePasswords: true,
  mcpServers: {},
  chromeExtensions: [],
};

export class SettingsStore {
  private store: JsonStore<Settings>;
  private listeners = new Set<(s: Settings) => void>();

  constructor() {
    this.store = new JsonStore<Settings>('settings.json', DEFAULT_SETTINGS);
  }

  get(): Settings {
    // Merge nested defaults so a settings file written by an older build still
    // gains any newly-introduced keys.
    const s = this.store.get();
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      models: { ...DEFAULT_SETTINGS.models, ...s.models },
      baseUrls: { ...DEFAULT_SETTINGS.baseUrls, ...s.baseUrls },
      cliPaths: { ...DEFAULT_SETTINGS.cliPaths, ...s.cliPaths },
      autoApprove: { ...DEFAULT_SETTINGS.autoApprove, ...s.autoApprove },
      alwaysAllowTools: s.alwaysAllowTools ?? [],
      mcpServers: { ...DEFAULT_SETTINGS.mcpServers, ...s.mcpServers },
      chromeExtensions: s.chromeExtensions ?? [],
    };
  }

  set(patch: Partial<Settings>): Settings {
    this.store.set(patch);
    const next = this.get();
    for (const l of this.listeners) l(next);
    return next;
  }

  /** Restores factory defaults. Credentials live elsewhere and are untouched. */
  reset(): Settings {
    this.store.replace({ ...DEFAULT_SETTINGS });
    this.store.flush();
    const next = this.get();
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  flush() {
    this.store.flush();
  }
}

/* --------------------------------------------------------------- secrets -- */

interface SecretsFile {
  /** provider -> `enc:` + base64 of the OS-encrypted blob. Nothing else is written. */
  keys: Record<string, string>;
  /** provider -> the endpoint the key was saved for. Absent means unbound. */
  endpoints?: Record<string, string>;
}

/** Endpoints compare by origin, so a trailing slash or path is not a new host. */
function normaliseEndpoint(endpoint: string): string {
  const raw = (endpoint ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** Raised instead of writing a secret somewhere it would be recoverable. */
export class NoSecureStorageError extends Error {
  constructor() {
    super(
      'No OS secure storage is available, so this secret was not saved. ' +
        'On Linux, install a keyring (gnome-keyring or kwallet) and restart.',
    );
    this.name = 'NoSecureStorageError';
  }
}

/**
 * Whether `safeStorage` is backed by something that actually protects a secret.
 *
 * On Linux, `isEncryptionAvailable()` also returns true for the `basic_text`
 * backend, which encrypts with a hardcoded key — recoverable by anyone who can
 * read the file. That is not secure storage, and is refused here.
 */
export function secureStorageUsable(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend?.();
      if (backend === 'basic_text' || backend === 'unknown') return false;
    }
    return true;
  } catch {
    return false;
  }
}

const ENV_KEYS: Record<ProviderId, string[]> = {
  // Runs on this machine against bundled weights: there is nothing to authenticate.
  local: [],
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  openai: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  ollama: ['OLLAMA_API_KEY'],
  // The CLI backends authenticate themselves; Nabsun never sees a key.
  'claude-cli': [],
  'codex-cli': [],
};

/**
 * API keys, encrypted with the OS keychain (DPAPI on Windows, Keychain on
 * macOS, libsecret on Linux) via Electron's safeStorage. When no secure backing
 * store exists the key is not persisted at all: it is held for the session and
 * the caller is told. Storing a recoverable secret while claiming otherwise is
 * worse than refusing.
 */
export class SecretStore {
  private store: JsonStore<SecretsFile>;
  /** Session-only keys, when the platform cannot protect them at rest. */
  private volatile = new Map<string, string>();

  constructor() {
    this.store = new JsonStore<SecretsFile>('credentials.json', { keys: {} });
  }

  get encryptionAvailable(): boolean {
    return secureStorageUsable();
  }

  /**
   * Persists the key, or throws `NoSecureStorageError` having kept it for this
   * session only. The caller is expected to surface that: a key that silently
   * vanishes on restart is confusing, and one silently written in the clear is
   * dangerous.
   */
  set(provider: ProviderId, key: string, endpoint = '') {
    const keys = { ...this.store.get().keys };
    const endpoints = { ...(this.store.get().endpoints ?? {}) };
    this.volatile.delete(provider);

    if (!key) {
      delete keys[provider];
      delete endpoints[provider];
      this.store.set({ keys, endpoints });
      this.store.flush();
      return;
    }

    // Remember where this key belongs, so it cannot later be sent somewhere
    // else — an imported base URL was enough to redirect an existing key to an
    // endpoint of the file author's choosing.
    endpoints[provider] = normaliseEndpoint(endpoint);

    if (!this.encryptionAvailable) {
      this.volatile.set(provider, key);
      delete keys[provider];
      this.store.set({ keys, endpoints });
      this.store.flush();
      throw new NoSecureStorageError();
    }

    keys[provider] = `enc:${safeStorage.encryptString(key).toString('base64')}`;
    this.store.set({ keys, endpoints });
    this.store.flush();
  }

  /**
   * Whether this key may be sent to this endpoint.
   *
   * A key saved against one endpoint is never offered to another. A key with no
   * recorded binding — saved before bindings existed — is usable only at the
   * provider's *default* endpoint: it was entered when that was the only place
   * it could go, and inheriting it into a custom endpoint would grant exactly
   * the redirect this is meant to prevent. Re-saving the key binds it.
   */
  boundTo(provider: ProviderId, endpoint: string, defaultEndpoint = ''): boolean {
    const bound = this.store.get().endpoints?.[provider];
    const target = normaliseEndpoint(endpoint);
    if (bound !== undefined) return bound === target;
    return target === normaliseEndpoint(defaultEndpoint);
  }

  clear(provider: ProviderId) {
    this.set(provider, '');
  }

  /** Stored key wins over the environment so the UI is authoritative. */
  get(provider: ProviderId): string | null {
    const held = this.volatile.get(provider);
    if (held) return held;

    const raw = this.store.get().keys[provider];
    if (raw) {
      try {
        if (raw.startsWith('enc:')) {
          return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'));
        }
        // Written by a build that had a reversible fallback: readable so it can
        // be migrated or cleared, never written again.
        if (raw.startsWith('plain:')) {
          return Buffer.from(raw.slice(6), 'base64').toString('utf8');
        }
      } catch (err) {
        console.error('[secrets] failed to decrypt key for', provider, err);
      }
    }
    for (const name of ENV_KEYS[provider] ?? []) {
      const v = process.env[name];
      if (v) return v;
    }
    return null;
  }

  has(provider: ProviderId): boolean {
    return Boolean(this.get(provider));
  }
}


