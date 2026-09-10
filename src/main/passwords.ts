import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { SavedLogin } from '../shared/types';
import { JsonStore, NoSecureStorageError, secureStorageUsable } from './store';

interface StoredLogin {
  id: string;
  /** Scheme + host + port. Credentials never cross an origin boundary. */
  origin: string;
  username: string;
  /** Always `enc:` — OS-encrypted. Nothing else is ever written. */
  secret: string;
  createdAt: number;
  updatedAt: number;
  timesUsed: number;
  lastUsedAt: number | null;
}

interface PasswordFile {
  logins: StoredLogin[];
}

/**
 * Saved passwords.
 *
 * Stored per-origin and encrypted with the OS keychain (DPAPI on Windows,
 * Keychain on macOS, libsecret on Linux) through Electron's safeStorage — the
 * same mechanism the API keys use. Plaintext only ever exists in memory, on the
 * way to filling a field or when the user explicitly asks to see it.
 *
 * Autofill matches on the full origin, so a page on `http://example.com` cannot
 * receive a credential saved for `https://example.com`, and a subdomain cannot
 * receive its parent's.
 */
export class PasswordStore {
  private store: JsonStore<PasswordFile>;

  constructor() {
    this.store = new JsonStore<PasswordFile>('passwords.json', { logins: [] });
  }

  get encryptionAvailable(): boolean {
    return secureStorageUsable();
  }

  /**
   * Throws rather than degrading. A base64 fallback is not encryption, and a
   * user who was told their passwords are protected by the OS keychain must not
   * end up with recoverable secrets on disk instead.
   */
  private encrypt(value: string): string {
    if (!this.encryptionAvailable) throw new NoSecureStorageError();
    return `enc:${safeStorage.encryptString(value).toString('base64')}`;
  }

  private decrypt(secret: string): string | null {
    try {
      if (secret.startsWith('enc:')) {
        return safeStorage.decryptString(Buffer.from(secret.slice(4), 'base64'));
      }
      // Written by a build that had a reversible fallback. Readable so the user
      // can migrate or delete it; never written again.
      if (secret.startsWith('plain:')) {
        return Buffer.from(secret.slice(6), 'base64').toString('utf8');
      }
    } catch (err) {
      console.error('[passwords] could not decrypt an entry', err);
    }
    return null;
  }

  /** Normalises a URL to the origin used as the matching key. */
  static originOf(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }

  /** Credentials for autofill. Plaintext — never persist or log the result. */
  forOrigin(origin: string): { id: string; username: string; password: string }[] {
    return this.store
      .get()
      .logins.filter((l) => l.origin === origin)
      .map((l) => {
        const password = this.decrypt(l.secret);
        return password === null ? null : { id: l.id, username: l.username, password };
      })
      .filter((v): v is { id: string; username: string; password: string } => v !== null);
  }

  /** True when this exact origin+username+password is already stored. */
  isKnown(origin: string, username: string, password: string): boolean {
    return this.forOrigin(origin).some(
      (l) => l.username === username && l.password === password,
    );
  }

  /** True when we hold a different password for this origin+username. */
  isUpdate(origin: string, username: string): boolean {
    return this.store.get().logins.some((l) => l.origin === origin && l.username === username);
  }

  save(origin: string, username: string, password: string): SavedLogin {
    const file = this.store.get();
    const now = Date.now();
    const existing = file.logins.find((l) => l.origin === origin && l.username === username);

    if (existing) {
      existing.secret = this.encrypt(password);
      existing.updatedAt = now;
      this.store.set({});
      this.store.flush();
      return toPublic(existing);
    }

    const entry: StoredLogin = {
      id: randomUUID(),
      origin,
      username,
      secret: this.encrypt(password),
      createdAt: now,
      updatedAt: now,
      timesUsed: 0,
      lastUsedAt: null,
    };
    file.logins.push(entry);
    this.store.set({});
    this.store.flush();
    return toPublic(entry);
  }

  /** Records that a credential was actually filled, for the "last used" column. */
  markUsed(id: string) {
    const entry = this.store.get().logins.find((l) => l.id === id);
    if (!entry) return;
    entry.timesUsed += 1;
    entry.lastUsedAt = Date.now();
    this.store.set({});
  }

  /** Metadata only — passwords are never included. */
  list(): SavedLogin[] {
    return [...this.store.get().logins]
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
      .map(toPublic);
  }

  /** Deliberately explicit: the only path that hands a password to the UI. */
  reveal(id: string): string | null {
    const entry = this.store.get().logins.find((l) => l.id === id);
    return entry ? this.decrypt(entry.secret) : null;
  }

  remove(id: string) {
    const file = this.store.get();
    file.logins = file.logins.filter((l) => l.id !== id);
    this.store.replace(file);
    this.store.flush();
  }

  clearAll() {
    this.store.replace({ logins: [] });
    this.store.flush();
  }

  get count(): number {
    return this.store.get().logins.length;
  }

  flush() {
    this.store.flush();
  }
}

function toPublic(entry: StoredLogin): SavedLogin {
  return {
    id: entry.id,
    origin: entry.origin,
    username: entry.username,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    timesUsed: entry.timesUsed,
    lastUsedAt: entry.lastUsedAt,
  };
}
