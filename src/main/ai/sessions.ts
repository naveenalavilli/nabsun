import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, ChatSession } from '../../shared/types';

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

  create(): ChatSession {
    const session: ChatSession = {
      id: randomUUID(),
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
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

  save(session: ChatSession) {
    session.updatedAt = Date.now();
    const tmp = `${this.file(session.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
    fs.renameSync(tmp, this.file(session.id));
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
