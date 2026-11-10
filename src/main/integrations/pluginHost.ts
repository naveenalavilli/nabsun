import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '../ai/tools/types';
import { PolicyDeniedError } from '../ai/policy';

export interface HostedTool {
  name: string;
  description: string;
  risk?: string;
  parameters?: Record<string, unknown>;
  required?: string[];
}
interface Invocation {
  id: string;
  ctx: ToolContext;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abort: () => void;
  helpers: number;
  chain: Promise<unknown>;
}
/** Filesystem restrictions are enforced by Node, not by a replaced `require`. */
export class PluginHost {
  private child?: ChildProcess;
  private invocation?: Invocation;
  private closed = false;
  get running() {
    return !this.closed && !!this.child?.connected;
  }
  private ready?: {
    resolve: (tools: HostedTool[]) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
  constructor(
    private root: string,
    private entry: string,
    private storage: string,
    private id: string,
    private version: string,
    private worker = path
      .join(__dirname, '../main/plugin-worker.js')
      .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
  ) {}
  start(): Promise<HostedTool[]> {
    if (this.child) throw Error('Plugin host already started.');
    // Node checks canonical paths. macOS commonly exposes temporary folders
    // through /var -> /private/var; grant only the resolved source/storage.
    this.root = fs.realpathSync(this.root);
    this.entry = fs.realpathSync(this.entry);
    this.storage = fs.realpathSync(this.storage);
    this.worker = fs.realpathSync(this.worker);
    const env: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: '1',
      TEMP: this.storage,
      TMP: this.storage,
    };
    for (const key of [
      'PATH',
      'SystemRoot',
      'SYSTEMROOT',
      'WINDIR',
      'COMSPEC',
      'PATHEXT',
    ])
      if (process.env[key]) env[key] = process.env[key]!;
    const promise = new Promise<HostedTool[]>((resolve, reject) => {
      this.ready = {
        resolve,
        reject,
        timer: setTimeout(() => this.close('Plugin startup timed out.'), 10000),
      };
    });
    this.child = spawn(
      process.execPath,
      [
        '--permission',
        '--no-addons',
        '--max-old-space-size=128',
        '--allow-fs-read=' + this.root,
        '--allow-fs-read=' + this.worker,
        '--allow-fs-read=' + this.storage,
        '--allow-fs-write=' + this.storage,
        this.worker,
        this.entry,
        this.storage,
        this.id,
        this.version,
      ],
      {
        env,
        cwd: this.root,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    this.child.on('error', (error) => this.close(error.message));
    this.child.on('exit', () =>
      this.close(
        'Plugin host stopped. Reload the approved plugin to use it again.',
      ),
    );
    this.child.on('message', (message) => {
      void this.message(message).catch((error) =>
        this.close(String(error instanceof Error ? error.message : error)),
      );
    });
    return promise;
  }
  private send(message: unknown) {
    if (this.closed || !this.child?.connected)
      throw Error('Plugin host is not connected.');
    if (JSON.stringify(message).length > 256000)
      throw Error('Plugin message exceeds 256 KB.');
    this.child.send(message as object, (error) => {
      if (error) this.close('Plugin IPC failed.');
    });
  }
  private async message(raw: unknown) {
    if (!raw || typeof raw !== 'object' || JSON.stringify(raw).length > 256000)
      throw Error('Invalid plugin message.');
    const message = raw as Record<string, unknown>;
    if (message.type === 'ready') {
      const waiting = this.ready;
      if (!waiting) return;
      if (
        !Array.isArray(message.tools) ||
        message.tools.length > 100 ||
        message.tools.some(
          (tool) =>
            !tool ||
            typeof tool.name !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(tool.name) ||
            typeof tool.description !== 'string' ||
            tool.description.length > 4000,
        )
      )
        throw Error('Invalid plugin tool catalogue.');
      clearTimeout(waiting.timer);
      this.ready = undefined;
      waiting.resolve(message.tools);
      return;
    }
    if (message.type === 'startup-error') throw Error(String(message.error));
    const invocation = this.invocation;
    if (!invocation || message.call !== invocation.id) return;
    if (message.type === 'result') {
      this.clearInvocation();
      if (message.error) invocation.reject(Error(String(message.error)));
      else invocation.resolve(message.value);
      return;
    }
    if (message.type !== 'helper') throw Error('Unknown plugin message.');
    if (++invocation.helpers > 100)
      throw Error('Plugin helper budget exceeded.');
    const request = String(message.request),
      args = Array.isArray(message.args) ? message.args : [];
    try {
      invocation.ctx.signal.throwIfAborted();
      const action = invocation.chain.then(() => {
        if (this.closed || this.invocation !== invocation)
          throw Error('Plugin invocation ended.');
        invocation.ctx.signal.throwIfAborted();
        return this.helper(invocation.ctx, String(message.method), args);
      });
      invocation.chain = action.catch(() => {});
      const value = await action;
      if (this.invocation !== invocation) return;
      const tab = invocation.ctx.tabs.resolveTarget(
        invocation.ctx.getAgentTabId() ?? undefined,
      );
      this.send({
        type: 'helper-result',
        request,
        value,
        page: { url: tab.wc.getURL(), title: tab.wc.getTitle() },
      });
    } catch (error) {
      if (error instanceof PolicyDeniedError) {
        this.close(error.message);
        return;
      }
      if (this.invocation === invocation)
        this.send({
          type: 'helper-result',
          request,
          error: String(error instanceof Error ? error.message : error).slice(
            0,
            1000,
          ),
        });
    }
  }
  private async helper(ctx: ToolContext, method: string, args: unknown[]) {
    if (method === 'status') {
      ctx.status(String(args[0]).slice(0, 500));
      return null;
    }
    if (!ctx.invokeTool || !ctx.cancelTask)
      throw Error(
        'Shared host approval and cancellation are required for plugin page access.',
      );
    const text = (value: unknown) => {
      if (typeof value !== 'string' || value.length > 20000)
        throw Error('Invalid plugin helper input.');
      return value;
    };
    switch (method) {
      case 'navigate':
        return ctx.invokeTool('browser_navigate', { url: text(args[0]) });
      case 'readText':
        return ctx.invokeTool(
          'browser_read_text',
          args[0] === undefined ? {} : { selector: text(args[0]) },
        );
      case 'snapshot':
        return ctx.invokeTool('browser_snapshot', {});
      case 'openTab': {
        const result = await ctx.invokeTool('tab_open', {
          url: text(args[0]),
          background: args[1] !== false,
        });
        const id = /^Opened tab \[([^\]]+)\]/.exec(result)?.[1];
        if (!id) throw Error('Opened tab id was not returned.');
        return id;
      }
      case 'evaluate': {
        const value = await ctx.invokeTool('browser_evaluate', {
          expression: `JSON.stringify({value:(${text(args[0])})})`,
        });
        return (JSON.parse(value) as { value: unknown }).value;
      }
      default:
        throw Error('Unsupported plugin page capability.');
    }
  }
  call(
    tool: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<unknown> {
    if (this.closed || !this.child?.connected)
      throw Error('Plugin host is not running.');
    if (this.invocation) throw Error('Plugin is already busy.');
    ctx.signal.throwIfAborted();
    const tab = ctx.tabs.resolveTarget(ctx.getAgentTabId() ?? undefined),
      id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () =>
        this.close(
          'Plugin invocation stopped. Reload the plugin before using it again.',
        );
      this.invocation = {
        id,
        ctx,
        resolve,
        reject,
        abort,
        helpers: 0,
        chain: Promise.resolve(),
        timer: setTimeout(
          () => this.close('Plugin exceeded its 60-second budget.'),
          60000,
        ),
      };
      ctx.signal.addEventListener('abort', abort, { once: true });
      try {
        this.send({
          type: 'invoke',
          call: id,
          tool,
          input,
          page: { url: tab.wc.getURL(), title: tab.wc.getTitle() },
        });
      } catch (error) {
        this.clearInvocation();
        reject(error);
      }
    });
  }
  private clearInvocation() {
    const invocation = this.invocation;
    if (!invocation) return;
    clearTimeout(invocation.timer);
    invocation.ctx.signal.removeEventListener('abort', invocation.abort);
    this.invocation = undefined;
  }
  close(reason = 'Plugin unloaded.') {
    if (this.closed) return;
    this.closed = true;
    if (this.ready) {
      clearTimeout(this.ready.timer);
      this.ready.reject(Error(reason));
      this.ready = undefined;
    }
    const invocation = this.invocation;
    this.clearInvocation();
    invocation?.reject(Error(reason));
    // A nested browser approval may still be pending when the process exits.
    // Cancel its owning task so approving a stale prompt can never run it later.
    invocation?.ctx.cancelTask?.();
    this.child?.kill();
  }
}
