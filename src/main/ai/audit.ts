import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { durableJson } from '../data/storage';
import type { ActivityRecord } from '../../shared/types';

const genesis = '0'.repeat(64);
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export interface AuditEvent {
  actionId: string;
  phase: 'intent' | 'result';
  tool: string;
  task: string;
  origin?: string;
  input?: Record<string, unknown>;
  status?: 'ok' | 'denied' | 'cancelled' | 'error';
  approver?: string;
  target?: Record<string, unknown>;
}
export type AuditRecord = ActivityRecord;
interface Head {
  sequence: number;
  hash: string;
}
interface Anchor extends Head {
  firstDay: string;
}
export interface AuditSink {
  append(event: AuditEvent): void;
}

/** Values are fingerprinted before serialization; credentials never enter the log. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth limit]';
  if (typeof value === 'string')
    return { sha256: digest(value), characters: value.length };
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return value;
  if (Array.isArray(value))
    return value.slice(0, 200).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 200)
        .map(([key, item]) => [key.slice(0, 100), redact(item, depth + 1)]),
    );
  return null;
}

/**
 * Detects changed/reordered/missing records, including a removed final line via
 * a separate durable head. This is tamper evidence, not protection against an
 * attacker who can rewrite both the journal and its checkpoint.
 */
export class FileAuditSink implements AuditSink {
  readonly directory: string;
  private head: Head;
  private failed = false;
  private signature = '';
  constructor(
    profile: string,
    private now: () => Date = () => new Date(),
  ) {
    this.directory = path.join(profile, 'activity');
    fs.mkdirSync(this.directory, { recursive: true });
    this.head = this.verify();
    if (!fs.existsSync(path.join(this.directory, 'head.json')))
      durableJson(path.join(this.directory, 'head.json'), this.head);
    this.signature = this.fingerprint();
  }
  private anchor(): Anchor {
    const file = path.join(this.directory, 'retention-anchor.json');
    if (!fs.existsSync(file))
      return { sequence: 0, hash: genesis, firstDay: '0000-00-00' };
    const anchor = JSON.parse(fs.readFileSync(file, 'utf8')) as Anchor;
    if (
      !Number.isSafeInteger(anchor.sequence) ||
      anchor.sequence < 0 ||
      !/^[a-f0-9]{64}$/.test(anchor.hash) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(anchor.firstDay)
    )
      throw Error('Invalid activity retention anchor.');
    return anchor;
  }
  private allFiles() {
    return fs
      .readdirSync(this.directory)
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .sort();
  }
  private files() {
    const anchor = this.anchor();
    return this.allFiles().filter(
      (file) => file.slice(0, 10) >= anchor.firstDay,
    );
  }
  private fingerprint() {
    return (
      JSON.stringify(this.anchor()) +
      '|' +
      this.files()
        .map((file) => {
          const stat = fs.statSync(path.join(this.directory, file));
          return [file, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(
            ':',
          );
        })
        .join('|')
    );
  }
  days() {
    return this.files().map((file) => file.slice(0, -6));
  }
  records(day: string, limit = 200): AuditRecord[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !this.days().includes(day))
      throw Error('Activity day not found.');
    this.verify();
    return fs
      .readFileSync(path.join(this.directory, day + '.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(100000, limit)))
      .map((line) => JSON.parse(line) as AuditRecord);
  }
  exportDay(day: string, target: string) {
    if (!this.days().includes(day)) throw Error('Activity day not found.');
    this.verify();
    fs.copyFileSync(path.join(this.directory, day + '.jsonl'), target);
  }
  /** A durable anchor lets retained records keep their original hashes. */
  retain(days = 30) {
    if (!Number.isInteger(days) || days < 7 || days > 365)
      throw Error('Choose 7 to 365 retention days.');
    this.verify();
    const cutoff = new Date(this.now().getTime() - (days - 1) * 86400000)
      .toISOString()
      .slice(0, 10);
    const expired = this.files().filter((file) => file.slice(0, 10) < cutoff);
    if (expired.length) {
      const records = fs
        .readFileSync(path.join(this.directory, expired.at(-1)!), 'utf8')
        .trim()
        .split('\n');
      const last = JSON.parse(records.at(-1)!) as AuditRecord;
      durableJson(path.join(this.directory, 'retention-anchor.json'), {
        sequence: last.sequence,
        hash: last.hash,
        firstDay: cutoff,
      });
    }
    // Also finishes cleanup if the app closed after saving the anchor.
    const anchor = this.anchor();
    for (const file of this.allFiles())
      if (file.slice(0, 10) < anchor.firstDay)
        fs.unlinkSync(path.join(this.directory, file));
    this.head = this.verify();
    this.signature = this.fingerprint();
  }
  verify(): Head {
    const anchor = this.anchor();
    let head: Head = { sequence: anchor.sequence, hash: anchor.hash };
    for (const file of this.files()) {
      const filename = path.join(this.directory, file);
      if (fs.statSync(filename).size > 32 * 1024 * 1024)
        throw Error(
          'Activity journal exceeds its verification limit. Export and archive it before continuing.',
        );
      const text = fs.readFileSync(filename, 'utf8');
      if (text && !text.endsWith('\n'))
        throw Error('Activity journal has an incomplete record.');
      for (const line of text.split('\n').filter(Boolean)) {
        const record = JSON.parse(line) as AuditRecord;
        const { hash, ...body } = record;
        if (
          record.sequence !== head.sequence + 1 ||
          record.previous !== head.hash ||
          typeof record.time !== 'string' ||
          record.time.slice(0, 10) !== file.slice(0, 10) ||
          hash !== digest(JSON.stringify(body))
        )
          throw Error('Activity journal integrity check failed.');
        head = { sequence: record.sequence, hash };
      }
    }
    const checkpoint = path.join(this.directory, 'head.json');
    if (fs.existsSync(checkpoint)) {
      const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8')) as Head;
      if (saved.sequence !== head.sequence || saved.hash !== head.hash)
        throw Error(
          'Activity journal checkpoint does not match. No further actions will run.',
        );
    } else if (head.sequence)
      throw Error('Activity journal checkpoint is missing.');
    return head;
  }
  append(event: AuditEvent) {
    if (this.failed)
      throw Error(
        'Activity recording failed. Restart and check the journal before running more actions.',
      );
    try {
      const saved = JSON.parse(
        fs.readFileSync(path.join(this.directory, 'head.json'), 'utf8'),
      ) as Head;
      if (
        saved.hash !== this.head.hash ||
        saved.sequence !== this.head.sequence ||
        this.fingerprint() !== this.signature
      )
        this.head = this.verify();
      // Only fixed host fields are stored verbatim. Input keys and all values
      // are bounded; URLs, selectors, code, and typed data are fingerprinted.
      let origin: string | undefined;
      try {
        const url = new URL(event.origin ?? '');
        if (['http:', 'https:'].includes(url.protocol)) origin = url.origin;
      } catch {
        /* Omit opaque/local origins. */
      }
      const safe = {
        actionId: event.actionId,
        phase: event.phase,
        tool: event.tool.slice(0, 200),
        task: digest(event.task),
        origin,
        status: event.status,
        approver: event.approver,
        target: event.target ? redact(event.target) : undefined,
        input: event.input ? redact(event.input) : undefined,
      };
      const time = this.now().toISOString(),
        file = path.join(this.directory, time.slice(0, 10) + '.jsonl');
      const body = {
        sequence: this.head.sequence + 1,
        time,
        previous: this.head.hash,
        event: safe,
      };
      const hash = digest(JSON.stringify(body)),
        line = JSON.stringify({ ...body, hash }) + '\n';
      if (Buffer.byteLength(line) > 256 * 1024)
        throw Error('Activity record is too large.');
      if (
        (fs.existsSync(file) ? fs.statSync(file).size : 0) +
          Buffer.byteLength(line) >
        32 * 1024 * 1024
      )
        throw Error('Daily activity journal is full.');
      const fd = fs.openSync(file, 'a', 0o600);
      try {
        fs.writeFileSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const next = { sequence: body.sequence, hash };
      durableJson(path.join(this.directory, 'head.json'), next);
      this.head = next;
      this.signature = this.fingerprint();
    } catch (error) {
      this.failed = true;
      throw Error(
        'Activity could not be recorded. Further actions are blocked: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
