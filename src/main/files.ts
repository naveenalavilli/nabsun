import type { DownloadManager } from './downloads';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { AttachedFile } from '../shared/types';
import { nativeImage } from 'electron';
interface FileRecord extends AttachedFile {
  scope: string;
  hash: string;
  source: 'attachment' | 'download';
}
export interface ParsedFile {
  kind: 'text' | 'table';
  text?: string;
  columns?: string[];
  rows?: Record<string, string>[];
  pages?: number;
}
const MAX_BYTES = 20 * 1024 * 1024;
function boundedRead(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_BYTES) {
    const chunk = Buffer.alloc(Math.min(1024 * 1024, MAX_BYTES + 1 - total));
    const count = fs.readSync(fd, chunk);
    if (!count) break;
    total += count;
    chunks.push(chunk.subarray(0, count));
  }
  if (total > MAX_BYTES) throw Error('File exceeds 20 MB.');
  return Buffer.concat(chunks, total);
}

/** Only the UI file picker and owned download events may create file capabilities. */
export class FileStore {
  private records = new Map<string, FileRecord>();
  private pendingDownloads = new Map<string, string>();
  noteDownload(id: string, scope: string | null) {
    if (scope) this.pendingDownloads.set(id, scope);
    else this.pendingDownloads.delete(id);
  }
  pending(scope: string) {
    return [...this.pendingDownloads.values()].filter(
      (owner) => owner === scope,
    ).length;
  }
  private dir: string;
  private indexError = false;
  constructor(
    profile: string,
    private parserPath = path.join(__dirname, '../main/file-parser.js'),
  ) {
    this.dir = path.join(profile, 'attachments');
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const file = path.join(this.dir, 'index.json');
      if (fs.statSync(file).size > 5 * 1024 * 1024)
        throw Error('Attachment index is too large.');
      const records = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(records)) throw Error('Invalid attachment index.');
      for (const record of records) {
        if (
          !(
            /^[a-f0-9-]{36}$/.test(record.id) &&
            typeof record.scope === 'string' &&
            typeof record.name === 'string' &&
            record.name === path.basename(record.name) &&
            !/[\\/]/.test(record.name) &&
            Number.isInteger(record.size) &&
            record.size >= 0 &&
            record.size <= MAX_BYTES &&
            /^[a-f0-9]{64}$/.test(record.hash)
          )
        )
          throw Error('Invalid attachment index.');
        this.records.set(record.id, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.indexError = true;
        this.records.clear();
      }
    }
    this.parserPath = this.parserPath.replace(
      /app\.asar([\\/])/,
      'app.asar.unpacked$1',
    );
  }
  private save() {
    if (this.indexError)
      throw Error(
        'The attachment index could not be read. Existing files were not changed.',
      );
    const file = path.join(this.dir, 'index.json');
    fs.writeFileSync(
      file + '.tmp',
      JSON.stringify([...this.records.values()]),
      { mode: 0o600 },
    );
    fs.renameSync(file + '.tmp', file);
  }
  attach(
    scope: string,
    file: string,
    source: 'attachment' | 'download' = 'attachment',
  ): AttachedFile {
    if (this.indexError)
      throw Error(
        'The attachment index could not be read. Existing files were not changed.',
      );
    if (this.records.size >= 1000)
      throw Error('Remove unused attachments before adding more files.');
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(scope))
      throw Error('Invalid file scope.');
    if (this.list(scope).length >= 20)
      throw Error('A chat can hold at most 20 files.');
    const fd = fs.openSync(file, 'r');
    let bytes: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES)
        throw Error('Choose a regular file no larger than 20 MB.');
      bytes = boundedRead(fd);
      if (bytes.length > MAX_BYTES) throw Error('File grew beyond 20 MB.');
    } finally {
      fs.closeSync(fd);
    }
    const id = randomUUID(),
      name = path
        .basename(file)
        .replace(/[\x00-\x1f\x7f\\/]/g, ' ')
        .slice(0, 200);
    const record: FileRecord = {
      id,
      name,
      size: bytes.length,
      scope,
      hash: createHash('sha256').update(bytes).digest('hex'),
      source,
    };
    fs.mkdirSync(path.join(this.dir, id), { mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, id, name), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    this.records.set(id, record);
    try {
      this.save();
    } catch (error) {
      this.records.delete(id);
      fs.unlinkSync(path.join(this.dir, id, name));
      fs.rmdirSync(path.join(this.dir, id));
      throw error;
    }
    return { id, name, size: bytes.length };
  }
  list(scope: string): AttachedFile[] {
    return [...this.records.values()]
      .filter((record) => record.scope === scope)
      .map(({ id, name, size }) => ({ id, name, size }));
  }
  downloads(scope: string): AttachedFile[] {
    return this.list(scope).filter(
      (file) => this.records.get(file.id)?.source === 'download',
    );
  }
  private record(scope: string | null | undefined, id: string) {
    const record = this.records.get(id);
    if (!scope || !record || record.scope !== scope)
      throw Error('This file was not attached to this chat.');
    return record;
  }
  describe(scope: string | null | undefined, id: string): AttachedFile {
    const { name, size } = this.record(scope, id);
    return { id, name, size };
  }
  isImage(scope: string | null | undefined, id: string) {
    return /\.(png|jpe?g|webp|gif)$/i.test(this.record(scope, id).name);
  }
  image(
    scope: string | null | undefined,
    id: string,
    thumbnail = false,
  ): { mediaType: string; data: string } {
    if (!this.isImage(scope, id))
      throw Error('Image previews support PNG, JPEG, WebP and GIF.');
    const bytes = this.bytes(scope, id);
    if (bytes.length > 5 * 1024 * 1024)
      throw Error(
        'Choose an image no larger than 5 MB for visual analysis. The original can still be uploaded to a website.',
      );
    const image = nativeImage.createFromBuffer(bytes),
      size = image.getSize();
    if (image.isEmpty() || size.width * size.height > 20000000)
      throw Error(
        'This image cannot be previewed. Use an image up to 20 megapixels.',
      );
    const edge = thumbnail ? 96 : 1600,
      scale = Math.min(1, edge / Math.max(size.width, size.height));
    const resized =
      scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: 'good',
          })
        : image;
    return { mediaType: 'image/png', data: resized.toPNG().toString('base64') };
  }
  bytes(scope: string | null | undefined, id: string): Buffer {
    const record = this.record(scope, id),
      file = path.join(this.dir, record.id, record.name);
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== record.size || stat.size > MAX_BYTES)
        throw Error('Attached file changed. Attach it again.');
      const bytes = boundedRead(fd);
      if (
        bytes.length !== record.size ||
        createHash('sha256').update(bytes).digest('hex') !== record.hash
      )
        throw Error('Attached file changed. Attach it again.');
      return bytes;
    } finally {
      fs.closeSync(fd);
    }
  }
  uploadPath(scope: string | null | undefined, id: string): string {
    this.bytes(scope, id);
    const record = this.record(scope, id);
    return path.join(this.dir, record.id, record.name);
  }
  remove(scope: string, id: string) {
    const record = this.record(scope, id);
    this.records.delete(id);
    try {
      this.save();
    } catch (error) {
      this.records.set(id, record);
      throw error;
    }
    try {
      fs.unlinkSync(path.join(this.dir, id, record.name));
      fs.rmdirSync(path.join(this.dir, id));
    } catch {
      /* No authority survives deletion of its record. */
    }
  }
  async read(
    scope: string | null | undefined,
    id: string,
    signal?: AbortSignal,
  ): Promise<ParsedFile> {
    if (signal?.aborted) throw Error('Stopped before reading file.');
    const record = this.record(scope, id),
      bytes = this.bytes(scope, id);
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.parserPath, {
        workerData: {
          bytes,
          extension: path.extname(record.name).toLowerCase(),
        },
        execArgv: ['--no-addons'],
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      const timer = setTimeout(
        () => finish(Error('File parsing exceeded 15 seconds.')),
        15000,
      );
      const abort = () => finish(Error('Stopped while reading file.'));
      let done = false;
      const finish = (error: Error | null, value?: ParsedFile) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        void worker.terminate();
        error ? reject(error) : resolve(value!);
      };
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', (message) =>
        message.ok ? finish(null, message.value) : finish(Error(message.error)),
      );
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) => {
        if (!done)
          finish(Error('File parser exited before completing (' + code + ').'));
      });
      if (signal?.aborted) abort();
    });
  }
}

/** Capture ownership at download start, not whichever chat happens to be active later. */
export function bindOwnedDownloads(
  downloads: DownloadManager,
  files: FileStore,
  claim: (contentsId: number) => string | null,
  scopeExists: (scope: string) => boolean = () => true,
) {
  const pending = new Map<string, string>();
  const created = (entry: { id: string }, contentsId: number) => {
    const scope = claim(contentsId);
    if (scope) {
      pending.set(entry.id, scope);
      files.noteDownload(entry.id, scope);
    }
  };
  const completed = (entry: { id: string; savePath: string }) => {
    const scope = pending.get(entry.id);
    pending.delete(entry.id);
    files.noteDownload(entry.id, null);
    if (scope && scopeExists(scope)) {
      try {
        files.attach(scope, entry.savePath, 'download');
      } catch (error) {
        console.warn(
          '[files] Download was not shared:',
          error instanceof Error ? error.message : 'file unavailable',
        );
      }
    }
  };
  const finished = (entry: { id: string }) => {
    pending.delete(entry.id);
    files.noteDownload(entry.id, null);
  };
  downloads.on('created', created);
  downloads.on('completed', completed);
  downloads.on('finished', finished);
  return () => {
    downloads.off('created', created);
    downloads.off('completed', completed);
    downloads.off('finished', finished);
    for (const id of pending.keys()) files.noteDownload(id, null);
    pending.clear();
  };
}
