import { spawn, type ChildProcess } from 'node:child_process';
import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { stopCliProcess } from './nativeCli';

/** A bounded stdio transport with a host-owned process group for cancellation. */
export class McpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcess;
  private reader = new ReadBuffer({ maxBufferSize: 2 * 1024 * 1024 });
  private ended = false;
  private closing?: Promise<void>;
  private done: Promise<void> = Promise.resolve();
  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string>,
  ) {}
  async start() {
    if (this.child || this.ended)
      throw Error('MCP transport cannot be restarted.');
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(this.command))
      throw Error(
        'Choose the installed MCP executable, or Node with an absolute entry-script argument. Shell shims cannot be pinned as a running server.',
      );
    const child = (this.child = spawn(this.command, this.args, {
      env: this.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    }));
    this.done = new Promise((resolve) =>
      child.once('close', () => {
        this.finish();
        resolve();
      }),
    );
    child.on('error', (error) => {
      this.onerror?.(error);
      void this.close();
    });
    child.once('exit', () => {
      if (!this.closing) stopCliProcess(child);
    });
    child.stdout!.on('data', (chunk: Buffer) => {
      if (this.closing || this.ended) return;
      try {
        this.reader.append(chunk);
        for (
          let message = this.reader.readMessage();
          message;
          message = this.reader.readMessage()
        )
          this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : Error(String(error)));
        void this.close();
      }
    });
    child.stdin!.on('error', (error) => this.onerror?.(error));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }
  async send(message: JSONRPCMessage) {
    const text = serializeMessage(message);
    if (this.ended || this.closing || !this.child?.stdin?.writable)
      throw Error('MCP server is disconnected.');
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw Error('MCP message exceeds 2 MB.');
    await new Promise<void>((resolve, reject) =>
      this.child!.stdin!.write(text, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.reader.clear();
    this.onclose?.();
  }
  close() {
    if (!this.closing) this.closing = this.stop();
    return this.closing;
  }
  private async stop() {
    if (this.ended) return;
    const child = this.child;
    if (child) stopCliProcess(child);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.finish();
    }
  }
}
