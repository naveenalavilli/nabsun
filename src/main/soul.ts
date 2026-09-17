import fs from 'node:fs';
import path from 'node:path';

/**
 * `soul.md` — what the assistant knows about the person using it.
 *
 * A plain Markdown file in the profile folder, written and owned by the user.
 * It exists so the assistant does not have to ask the same things every session:
 * who they are, where they are, how they like answers, what a form should say.
 *
 * Three properties matter, and each is enforced here rather than by convention:
 *
 * 1. **It is a file, not a database.** The user edits it in whatever editor they
 *    already use. Nothing in the app rewrites it after the first run, so a line
 *    they deleted stays deleted.
 * 2. **It stays on this machine unless the user says otherwise.** Nothing
 *    uploads it, and by default the agent withholds it from any backend that is
 *    not running here — see `Agent.shareSoulWith`. Switch that off and it
 *    travels with the turn like the rest of the conversation. Settings names
 *    the current provider and says which of the two is happening, so the
 *    guarantee is visible rather than asserted.
 * 3. **It is bounded.** An unbounded personal file becomes an unbounded prompt,
 *    and on a CPU backend prompt tokens are the dominant wait. It is truncated,
 *    hard, and more tightly for a small local model.
 */
export const SOUL_FILENAME = 'soul.md';

/** Roughly 2k tokens. Beyond this the file is costing more than it earns. */
const MAX_CHARS = 8_000;
/** A 1.7B model on an 8k context cannot afford the full budget. */
const MAX_CHARS_LEAN = 1_500;

export function soulPath(userDataPath: string): string {
  return path.join(userDataPath, SOUL_FILENAME);
}

const TEMPLATE = `# Soul

This file is your assistant's memory of *you*. Everything below is given to it
as background, so you do not have to introduce yourself every time.

**Where it goes.** By default, nowhere. Settings keeps *Only share it with
models on this machine* switched on, so this file reaches the built-in model or
your own local Ollama server and nothing else — Anthropic, OpenAI and the
signed-in CLIs are given none of it. Turn that off and it travels with your turn
to whichever provider you picked, like anything else you type.

**How to use it.** Fill in what helps, delete what does not. Empty lines are
ignored. Delete the whole file, or switch it off in Settings → Assistant, to
stop sharing it. Do not put passwords, card numbers or one-time codes here —
the assistant is blocked from typing those into a page anyway.

## Who I am

- Name:
- Pronouns:
- Where I am (city, time zone):
- What I do:

## How I like to be worked with

- Tone:
- How much detail:
- Always:
- Never:

## Things I would otherwise repeat every time

- Employer / team:
- What I am working on:
- Tools and languages I use:
- Sites I live in:

## Practical details

- Date and unit format:
- Dietary needs:
- Travel preferences (airline, seat, hotel):

## Off limits

-
`;

interface Cached {
  mtimeMs: number;
  size: number;
  text: string;
}

export class SoulStore {
  readonly file: string;
  private cache: Cached | null = null;

  constructor(userDataPath: string) {
    this.file = soulPath(userDataPath);
  }

  /**
   * Write the starter file once, on first run.
   *
   * Never overwrites: if the user emptied it deliberately, an app that helpfully
   * restores the template has overridden them.
   */
  ensure(): void {
    try {
      if (fs.existsSync(this.file)) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, TEMPLATE, 'utf8');
    } catch (err) {
      console.error('[soul] could not create soul.md:', err);
    }
  }

  exists(): boolean {
    try {
      return fs.existsSync(this.file);
    } catch {
      return false;
    }
  }

  /**
   * The file's content, or null when there is nothing worth sending.
   *
   * Cached against mtime and size, because this is consulted on every step of
   * every turn: an edit lands on the next step without a restart, and an
   * unedited file costs one `stat`.
   */
  read(opts: { lean?: boolean } = {}): string | null {
    const limit = opts.lean ? MAX_CHARS_LEAN : MAX_CHARS;
    let text: string;

    try {
      const stat = fs.statSync(this.file);
      if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
        text = this.cache.text;
      } else {
        text = fs.readFileSync(this.file, 'utf8');
        this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, text };
      }
    } catch {
      return null;
    }

    const meaningful = stripBoilerplate(text);
    if (!meaningful) return null;
    return meaningful.length > limit
      ? `${meaningful.slice(0, limit)}\n\n[truncated — soul.md is longer than the assistant's budget for it]`
      : meaningful;
  }

  /** Path, and whether there is anything in it, for Settings and the About page. */
  status(): { path: string; exists: boolean; filled: boolean; bytes: number } {
    let bytes = 0;
    try {
      bytes = fs.statSync(this.file).size;
    } catch {
      return { path: this.file, exists: false, filled: false, bytes: 0 };
    }
    return { path: this.file, exists: true, filled: this.read() !== null, bytes };
  }
}

/**
 * Every line of the shipped template that is not a heading.
 *
 * Derived from TEMPLATE itself rather than restated as a list of phrases. The
 * first version hard-coded sentences from the preamble, and the moment the
 * template was reworded the stripping silently stopped matching — which turns a
 * pristine file into "content" and posts our own instructions to the model.
 * Anything we wrote is boilerplate by construction, so ask the template.
 */
const TEMPLATE_LINES: ReadonlySet<string> = new Set(
  TEMPLATE.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#')),
);

/**
 * Drop the scaffolding, keep what the user wrote.
 *
 * A freshly created file is all template and no content; sending it would spend
 * context telling the model that the user's name is blank. Headings survive —
 * they give the remaining answers their shape — but they do not count as
 * content, so an untouched file returns empty and callers read that as
 * "nothing here yet".
 */
function stripBoilerplate(raw: string): string {
  const kept: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push('');
      continue;
    }
    // Ours, verbatim, and not a heading.
    if (TEMPLATE_LINES.has(trimmed)) continue;
    // A label with nothing after the colon was never filled in — including
    // bullets the user added themselves.
    if (/^[-*]\s*[^:]*:\s*$/.test(trimmed)) continue;
    if (/^[-*]\s*$/.test(trimmed)) continue;
    kept.push(line);
  }

  const body = kept
    .join('\n')
    // Collapse the runs of blank lines the filtering leaves behind.
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const hasContent = body
    .split(/\r?\n/)
    .some((l) => l.trim() && !l.trim().startsWith('#'));
  return hasContent ? body : '';
}
