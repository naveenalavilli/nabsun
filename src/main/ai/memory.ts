import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

interface Note { text: string; updatedAt: number }
const MAX_FILE_BYTES = 512_000;
const MAX_NOTE_CHARS = 8_000;
const validKey = (key: string) => key.length > 0 && key.length <= 160 &&
  !['__proto__', 'prototype', 'constructor'].includes(key) && !/[\x00-\x1f]/.test(key);

/** Backwards-compatible local notes. No model call is needed to retrieve them. */
export class MemoryStore {
  readonly file: string;
  constructor(profile: string) { this.file = path.join(profile, 'agent-notes.json'); }

  private read(): Record<string, Note> {
    try {
      if (fs.statSync(this.file).size > MAX_FILE_BYTES) throw new Error('Memory exceeds its size limit. Edit agent-notes.json to reduce it.');
      const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid memory file');
      const notes: Record<string, Note> = Object.create(null);
      for (const [key, value] of Object.entries(data)) {
        if (!validKey(key) || !value || typeof value.text !== 'string' ||
            !Number.isFinite(value.updatedAt)) throw new Error('Invalid saved note');
        notes[key] = value;
      }
      return notes;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null);
      throw err; // Never replace corrupt/unreadable memory with an empty store.
    }
  }

  private save(notes: Record<string, Note>) {
    const data = JSON.stringify(notes, null, 2);
    if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error('Memory is full. Delete unused notes first.');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { try { fs.unlinkSync(temporary); } catch { /* already renamed */ } }
  }

  list(): string {
    const keys = Object.keys(this.read()).sort();
    return keys.slice(0, 40).map(k => `- ${k}`).join('\n') +
      (keys.length > 40 ? '\n[More notes available; use memory_search.]' : '') || 'No notes saved yet.';
  }

  get(key: string): string {
    if (!validKey(key)) throw new Error('Invalid memory key');
    const note = this.read()[key];
    return note ? note.text.slice(0, MAX_NOTE_CHARS) : `No note stored under ${JSON.stringify(key)}.`;
  }

  write(key: string, text: string, append: boolean) {
    if (!validKey(key)) throw new Error('Invalid memory key');
    const notes = this.read();
    const next = append && notes[key] ? `${notes[key].text}\n${text}` : text;
    if (next.length > MAX_NOTE_CHARS) throw new Error('Note exceeds 8000 characters. Shorten it or use a separate key.');
    notes[key] = { text: next, updatedAt: Date.now() };
    this.save(notes);
  }

  remove(key: string) {
    if (!validKey(key)) throw new Error('Invalid memory key');
    const notes = this.read();
    delete notes[key];
    this.save(notes);
  }

  search(query: string, maxChars = 2_000): string {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 32);
    if (!terms.length) return '';
    const ranked = Object.entries(this.read()).map(([key, note]) => ({
      key, ...note, score: terms.reduce((n, term) => n +
        (key.toLowerCase().includes(term) ? 3 : 0) + (note.text.toLowerCase().includes(term) ? 1 : 0), 0),
    })).filter(n => n.score > 0).sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
    return ranked.slice(0, 3).map(n => `${JSON.stringify(n.key)}: ${n.text.slice(0, 900)}`).join('\n\n').slice(0, maxChars);
  }
}
