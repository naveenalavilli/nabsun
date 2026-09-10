import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, ChatSession } from '../../shared/types';

/** Attempts, spaced 15/30/60/120ms - about a quarter second in total. */
const RENAME_ATTEMPTS = 5;

/**
 * Whether an error looks like another process holding the file open, rather
 * than something waiting cannot fix. Windows reports that contention through
 * any of these three depending on what has the handle.
 */
function isContended(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/**
 * Blocks this thread for `ms`.
 *
 * `save` is synchronous to its IPC handler, and turning the whole chain async
 * to wait a few milliseconds would change every caller for no benefit the
 * user could perceive.
 */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Chat history, one JSON file per session so a long transcript never rewrites
 * every other one. Sessions are the browser's equivalent of editor tabs for
 * conversations.
 */
export class SessionStore {
  private readonly dir: string;

  constructor(userDataPath: string) {
    this.dir = path.join(userDataPath, 'sessions');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(id: string): string {
    // Session ids are generated internally, but never trust one from IPC.
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid session id');
    return path.join(this.dir, `${id}.json`);
  }

  private blank(id: string): ChatSession {
    return { id, title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  }

  create(): ChatSession {
    const session = this.blank(randomUUID());
    this.save(session);
    return session;
  }

  load(id: string): ChatSession | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as ChatSession;
    } catch {
      return null;
    }
  }

  /**
   * Writes the session atomically: whole file to a sibling, then rename.
   *
   * The rename is retried. On Windows it fails with EPERM when a virus
   * scanner or the search indexer still holds the file we have just written
   * open - and it succeeds a few milliseconds later. Unretried, that threw
   * out of `upsert`, out of the turn loop, and killed a completed assistant
   * response because a history file could not be renamed.
   *
   * Every call rewrites the entire session, so a write that is abandoned
   * after all attempts is repaired by the next one rather than leaving the
   * transcript with a hole in it.
   */
  save(session: ChatSession) {
    session.updatedAt = Date.now();
    const target = this.file(session.id);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');

    let lastError: unknown;
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
      try {
        fs.renameSync(tmp, target);
        return;
      } catch (err) {
        lastError = err;
        // A name that is invalid, or a disk that is full, will not become
        // valid or empty by waiting for it.
        if (!isContended(err)) break;
        if (attempt < RENAME_ATTEMPTS - 1) sleepSync(15 * 2 ** attempt);
      }
    }

    // The temporary file is litter at this point, and failing to clear it is
    // not the failure worth reporting.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing useful to do */
    }
    throw lastError;
  }

  append(id: string, message: ChatMessage): ChatSession {
    const session = this.load(id) ?? { ...this.create(), id };
    session.messages.push(message);
    // Name the session after the first thing the user asked, like an editor
    // naming an untitled file once it has content.
    if (session.title === 'New chat' && message.role === 'user') {
      const text = message.blocks.find((b) => b.type === 'text');
      if (text && 'text' in text) {
        session.title = text.text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
      }
    }
    this.save(session);
    return session;
  }

  /**
   * Appends a message and returns the session even if it cannot be written.
   *
   * The turn loop needs the conversation so far to build its request; it does
   * not need that conversation to be on disk. Losing a line of history is a
   * bad day - losing the answer the user asked for *because* history could not
   * be written is a worse one, and that is what used to happen: this threw
   * from `create` before the model was ever called, so the turn produced
   * nothing at all.
   */
  appendBestEffort(id: string, message: ChatMessage): ChatSession {
    try {
      return this.append(id, message);
    } catch (err) {
      console.error('[sessions] could not persist the message:', err);
      // `load` reports a missing or unreadable file as null rather than
      // throwing, so this stays on its feet when the store is unusable.
      const session = this.load(id) ?? this.blank(id);
      session.messages.push(message);
      return session;
    }
  }

  /**
   * Writes a message, replacing any earlier version of it.
   *
   * The turn record is saved as it progresses rather than once at the end.
   * Appending only on success meant a provider error after a completed write
   * left the transcript holding the user's message and no evidence that
   * anything had happened — the worst possible state to retry from.
   */
  upsert(id: string, message: ChatMessage): ChatSession {
    const session = this.load(id) ?? { ...this.create(), id };
    const at = session.messages.findIndex((m) => m.id === message.id);
    if (at === -1) session.messages.push(message);
    else session.messages[at] = message;
    this.save(session);
    return session;
  }

  list(): { id: string; title: string; updatedAt: number }[] {
    const out: { id: string; title: string; updatedAt: number }[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as ChatSession;
        if (s.messages.length) out.push({ id: s.id, title: s.title, updatedAt: s.updatedAt });
      } catch {
        /* skip unreadable session files rather than failing the whole list */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  remove(id: string) {
    try {
      fs.unlinkSync(this.file(id));
    } catch {
      /* already gone */
    }
  }

  rename(id: string, title: string) {
    const s = this.load(id);
    if (!s) return;
    s.title = title.slice(0, 120);
    this.save(s);
  }
}
