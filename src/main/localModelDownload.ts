import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Session } from 'electron';
import { LOCAL_MODEL, type LocalModelSource, type LocalModelStatus } from '../shared/localModel';

type ExistingModel = { path: string; source: Exclude<LocalModelSource, 'managed'> } | null;

interface Receipt {
  file: string;
  bytes: number;
  sha256: string;
  revision: string;
}

const receiptForModel: Receipt = {
  file: LOCAL_MODEL.file,
  bytes: LOCAL_MODEL.bytes,
  sha256: LOCAL_MODEL.sha256,
  revision: LOCAL_MODEL.revision,
};

function isRegularFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

export function safeDownloadHost(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === 'huggingface.co' || host.endsWith('.huggingface.co') ||
      host === 'cdn.hf.co' || host.endsWith('.cdn.hf.co') ||
      host === 'xethub.hf.co' || host.endsWith('.xethub.hf.co');
  } catch { return false; }
}

/**
 * Owns the optional, pinned local-model download.
 *
 * The engine remains inside the signed app. Only weights live in user data, and
 * they become visible to the provider after an exact length and SHA-256 check.
 * Partial files are resumable but are never treated as models.
 */
export class LocalModelDownload extends EventEmitter {
  readonly directory: string;
  readonly modelPath: string;
  readonly partialPath: string;
  private readonly receiptPath: string;
  private managedReady = false;
  private active: Promise<LocalModelStatus> | null = null;
  private controller: AbortController | null = null;
  private phase: LocalModelStatus['state'] | null = null;
  private lastError = '';
  private lastProgressAt = 0;

  constructor(
    userDataPath: string,
    private readonly browserSession: Session,
    private readonly existingModel: () => ExistingModel,
  ) {
    super();
    this.directory = path.join(userDataPath, 'models');
    this.modelPath = path.join(this.directory, LOCAL_MODEL.file);
    this.partialPath = `${this.modelPath}.partial`;
    this.receiptPath = `${this.modelPath}.verified.json`;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.managedReady = this.hasVerifiedManagedModel();
  }

  /** Synchronous because provider path resolution occurs for every local turn. */
  readyModelPath(): string {
    return this.managedReady && isRegularFile(this.modelPath) ? this.modelPath : '';
  }

  /** Never expose an unverified crash remnant to llama.cpp. */
  providerModelPath(): string {
    return this.readyModelPath() || `${this.modelPath}.not-installed`;
  }

  status(): LocalModelStatus {
    const existing = this.existingModel();
    if (existing && isRegularFile(existing.path)) return this.makeStatus('ready', LOCAL_MODEL.bytes, existing.source);
    if (this.managedReady && isRegularFile(this.modelPath)) return this.makeStatus('ready', LOCAL_MODEL.bytes, 'managed');
    const downloaded = Math.min(this.partialBytes(), LOCAL_MODEL.bytes);
    return this.makeStatus(this.phase ?? (this.lastError ? 'failed' : 'available'), downloaded, undefined, this.lastError || undefined);
  }

  download(): Promise<LocalModelStatus> {
    const status = this.status();
    if (status.state === 'ready') return Promise.resolve(status);
    if (this.active) return this.active;
    this.lastError = '';
    this.controller = new AbortController();
    this.active = this.run(this.controller.signal).catch(error => {
      if (this.controller?.signal.aborted) {
        this.phase = null;
        this.lastError = '';
      } else {
        this.phase = 'failed';
        this.lastError = this.friendlyError(error);
      }
      this.changed();
      return this.status();
    }).finally(() => {
      this.active = null;
      this.controller = null;
    });
    return this.active;
  }

  cancel(): void {
    this.controller?.abort();
  }

  async remove(): Promise<LocalModelStatus> {
    if (this.active) throw new Error('Cancel the model download before removing it.');
    const external = this.existingModel();
    if (external) throw new Error('A bundled or custom model is active. Change its path instead.');
    await Promise.all([
      fs.promises.rm(this.modelPath, { force: true }),
      fs.promises.rm(this.partialPath, { force: true }),
      fs.promises.rm(this.receiptPath, { force: true }),
    ]);
    this.managedReady = false;
    this.phase = null;
    this.lastError = '';
    this.changed();
    return this.status();
  }

  private makeStatus(
    state: LocalModelStatus['state'],
    downloadedBytes: number,
    source?: LocalModelSource,
    error?: string,
  ): LocalModelStatus {
    return { state, source, downloadedBytes, totalBytes: LOCAL_MODEL.bytes, displayName: LOCAL_MODEL.name, error };
  }

  private changed(force = true): void {
    const now = Date.now();
    if (!force && now - this.lastProgressAt < 200) return;
    this.lastProgressAt = now;
    this.emit('status', this.status());
  }

  private partialBytes(): number {
    try {
      const stat = fs.lstatSync(this.partialPath);
      return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0;
    } catch { return 0; }
  }

  private hasVerifiedManagedModel(): boolean {
    try {
      const file = fs.lstatSync(this.modelPath);
      const receipt = JSON.parse(fs.readFileSync(this.receiptPath, 'utf8')) as Receipt;
      return file.isFile() && !file.isSymbolicLink() && file.size === LOCAL_MODEL.bytes &&
        JSON.stringify(receipt) === JSON.stringify(receiptForModel);
    } catch { return false; }
  }

  private async run(signal: AbortSignal): Promise<LocalModelStatus> {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const partial = await fs.promises.lstat(this.partialPath).catch(() => null);
    if (partial?.isSymbolicLink() || (partial && !partial.isFile())) throw new Error('Unsafe partial model path');
    let start = partial?.size ?? 0;
    if (start > LOCAL_MODEL.bytes) {
      await fs.promises.rm(this.partialPath, { force: true });
      start = 0;
    }
    this.phase = 'downloading';
    this.changed();
    // A process can exit after the final byte is flushed but before checksum
    // verification. Resume that state locally instead of issuing an invalid
    // `Range: bytes=<length>-` request and discarding a complete download.
    if (start < LOCAL_MODEL.bytes) await this.transfer(start, signal);
    if (signal.aborted) throw new Error('Download cancelled');
    const size = (await fs.promises.stat(this.partialPath)).size;
    if (size !== LOCAL_MODEL.bytes) throw new Error(`Model download has the wrong size (${size})`);

    this.phase = 'verifying';
    this.changed();
    const digest = await this.sha256(this.partialPath, signal);
    if (digest !== LOCAL_MODEL.sha256) {
      await fs.promises.rm(this.partialPath, { force: true });
      throw new Error('Model checksum did not match');
    }
    const target = await fs.promises.lstat(this.modelPath).catch(() => null);
    if (target?.isSymbolicLink() || (target && !target.isFile())) throw new Error('Unsafe model destination');
    await fs.promises.rm(this.modelPath, { force: true });
    await fs.promises.rename(this.partialPath, this.modelPath);
    await fs.promises.chmod(this.modelPath, 0o600).catch(() => undefined);
    await fs.promises.writeFile(this.receiptPath, `${JSON.stringify(receiptForModel)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.managedReady = true;
    this.phase = null;
    this.lastError = '';
    this.changed();
    return this.status();
  }

  private async transfer(start: number, signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' };
    if (start) headers.Range = `bytes=${start}-`;
    let url: string = LOCAL_MODEL.url;
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!safeDownloadHost(url)) throw new Error('Model download redirected to an unapproved host');
      response = await this.browserSession.fetch(url, {
        method: 'GET', headers, signal, redirect: 'manual', credentials: 'omit',
        bypassCustomProtocolHandlers: true,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('Model download redirected too many times');
      await response.body?.cancel().catch(() => undefined);
      url = new URL(location, url).href;
      response = null;
    }
    if (!response) throw new Error('Model service returned no response');
    if (response.status !== 200 && response.status !== 206) throw new Error(`Model service returned ${response.status}`);
    const encoding = response.headers.get('content-encoding') ?? '';
    if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('Model service returned encoded bytes');
    let append = start > 0;
    let received = start;
    if (append && response.status === 206) {
      const range = response.headers.get('content-range') ?? '';
      if (!range.startsWith(`bytes ${start}-`) || !range.endsWith(`/${LOCAL_MODEL.bytes}`)) {
        throw new Error('Model service returned an invalid resume range');
      }
    } else if (append && response.status === 200) {
      append = false;
      received = 0;
    } else if (!append && response.status === 206) {
      const range = response.headers.get('content-range') ?? '';
      if (!range.startsWith('bytes 0-')) throw new Error('Model service returned an invalid range');
    }
    if (!response.body) throw new Error('Model service returned an empty response');
    const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
      received += chunk.length;
      if (received > LOCAL_MODEL.bytes) { callback(new Error('Model download exceeded its expected size')); return; }
      this.changed(false);
      callback(null, chunk);
    } });
    const flags = append ? 'a' : 'w';
    await pipeline(
      Readable.fromWeb(response.body as never),
      meter,
      createWriteStream(this.partialPath, { flags, mode: 0o600 }),
      { signal },
    );
  }

  private async sha256(file: string, signal: AbortSignal): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) {
      if (signal.aborted) throw new Error('Download cancelled');
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }

  private friendlyError(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    if (/cancel/i.test(message)) return '';
    if (/ENOSPC|no space/i.test(message)) return 'There is not enough disk space for the local AI model.';
    if (/checksum|wrong size|exceeded|invalid range|unapproved host|encoded bytes|unsafe/i.test(message)) {
      return 'The model download could not be verified. Please retry from the official source.';
    }
    return 'The local AI model could not be downloaded. Check your connection and try again.';
  }
}
