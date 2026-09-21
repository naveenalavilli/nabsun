import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import type { ProviderId } from '../../../shared/types';
import type { Provider, StreamEvent, StreamRequest } from '../provider';
import { streamChatCompletions } from './openai';

/** Where the bundled engine and weights live, dev tree and packaged app alike. */
export interface LocalPaths {
  /** `llama-server` executable, or '' to fall back to the bundled location. */
  serverPath: string;
  /** `.gguf` weights, or '' for the bundled model. */
  modelPath: string;
}

export interface LocalOptions {
  /** Context window. Larger costs RAM; a page snapshot is the bulk of the input. */
  contextSize: number;
  /** 0 lets llama.cpp choose from the core count. */
  threads: number;
}

export const DEFAULT_LOCAL_OPTIONS: LocalOptions = { contextSize: 8192, threads: 0 };

/** The model shipped with the app; a user-set path overrides it. */
export const BUNDLED_MODEL_FILE = 'Qwen3-1.7B-Q4_K_M.gguf';

/**
 * Resolves the vendored engine and model.
 *
 * Packaged, they sit in `resources/vendor`, unpacked from the asar because a
 * child process cannot be spawned from inside an archive and llama.cpp memory
 * maps the weights. In the dev tree they are in `vendor/`, fetched by
 * `npm run fetch:model` and never committed.
 */
export function bundledPaths(resourcesPath: string | null, appRoot: string): LocalPaths {
  const vendor = resourcesPath
    ? path.join(resourcesPath, 'vendor')
    : path.join(appRoot, 'vendor');
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return {
    serverPath: path.join(vendor, 'llama', exe),
    modelPath: path.join(vendor, 'models', BUNDLED_MODEL_FILE),
  };
}

/**
 * The embedded model: llama.cpp running in-process-adjacent, no network at all.
 *
 * This is the default backend, and the reason is cost rather than capability.
 * Routing every trivial navigation step through a frontier model bills tokens
 * for "click the search box". A 1.7B model handles the routine majority
 * locally, for nothing, with no outbound request — which also makes the browser
 * usable inside networks where calling a third-party model is not permitted.
 *
 * `llama-server` is spawned rather than linked: it speaks the OpenAI Chat
 * Completions wire format, tool calls included, so the entire adapter is the
 * shared streaming loop pointed at localhost. Linking a native addon would mean
 * an ABI-matched rebuild for every Electron bump, for no gain.
 *
 * The process starts lazily on the first turn and is reused, because loading
 * 1.1 GB of weights takes seconds and doing it per request would be absurd.
 */
export class LocalProvider implements Provider {
  readonly id: ProviderId = 'local';
  readonly label = 'Built-in (local)';

  private server: ChildProcess | null = null;
  private port = 0;
  /**
   * Per-process bearer token for the loopback server.
   *
   * llama-server authenticates nothing by default, and `--no-webui` turns off
   * the UI, not the API. Without this, any other process on the machine — and
   * any origin whose request reaches it — can use the browser's inference
   * service, and a request carrying a foreign `Origin` was answered with that
   * origin reflected back. The token is regenerated per launch and never
   * leaves this process.
   */
  private readonly apiKey = randomBytes(24).toString('hex');
  private starting: Promise<void> | null = null;
  /**
   * What the running process was actually started with.
   *
   * The configuration is read fresh on every access, so it is not a record of
   * what is in force — only this is.
   */
  private active: {
    contextSize: number;
    threads: number;
    serverPath: string;
    modelPath: string;
  } | null = null;
  /** Kept for the error message when the server dies during startup. */
  private lastStderr = '';

  constructor(
    private readonly getPaths: () => LocalPaths,
    private readonly getOptions: () => LocalOptions,
  ) {}

  /**
   * The context the *running* server has, not the one currently configured.
   *
   * These diverge the moment someone edits the setting: the process is reused
   * and keeps whatever it was started with, so reading the configuration told
   * the agent it had 32,768 tokens while the server still enforced 8,192 — the
   * fitting logic would then build a request the server rejects, and could
   * restore the full tool catalogue on the strength of room that does not
   * exist. Before anything is running, the configured value is the honest
   * answer, because that is what the next start will use.
   */
  get contextTokens(): number {
    return this.active?.contextSize ?? Math.max(2048, this.getOptions().contextSize);
  }

  /**
   * Settings that differ from what the running server was started with.
   *
   * Applying them means a restart, which would discard a loaded model mid-task,
   * so the decision is surfaced rather than taken: the UI can say "pending
   * restart" instead of displaying a configuration that is not in force.
   */
  get pendingRestart(): string[] {
    if (!this.active) return [];
    const options = this.getOptions();
    const paths = this.resolved();
    const changed: string[] = [];
    if (Math.max(2048, options.contextSize) !== this.active.contextSize) changed.push('context size');
    if (options.threads !== this.active.threads) changed.push('threads');
    if (paths.serverPath !== this.active.serverPath) changed.push('engine path');
    if (paths.modelPath !== this.active.modelPath) changed.push('model file');
    return changed;
  }

  /** Both halves must be present; an engine with no weights is not usable. */
  get installed(): boolean {
    const { serverPath, modelPath } = this.resolved();
    return Boolean(serverPath && modelPath && fs.existsSync(serverPath) && fs.existsSync(modelPath));
  }

  get binaryPath(): string | null {
    const { serverPath } = this.resolved();
    return serverPath && fs.existsSync(serverPath) ? serverPath : null;
  }

  get modelPath(): string | null {
    const { modelPath } = this.resolved();
    return modelPath && fs.existsSync(modelPath) ? modelPath : null;
  }

  private resolved(): LocalPaths {
    return this.getPaths();
  }

  async listModels(): Promise<string[]> {
    // One model is loaded at a time; the name is cosmetic for a local server.
    const file = this.resolved().modelPath;
    return file ? [path.basename(file, '.gguf')] : [];
  }

  supportsVision(): boolean {
    // A text model. Screenshots would be silently dropped, so say so honestly:
    // the agent loop uses this to decide whether to offer the screenshot tool.
    return false;
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    await this.ensureRunning(req.signal);
    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: `http://127.0.0.1:${this.port}/v1`,
      // Generous on purpose. This was 180s, and a realistic first turn — full
      // tool catalogue, a page attached — took 184s to produce its first token
      // on a normal laptop. The client gave up four seconds before the model
      // spoke, so the work was done and then thrown away, and the sidebar sat
      // blank. A local model costs nothing per token; the only thing a short
      // timeout buys here is discarding work already paid for.
      timeout: 900_000,
      maxRetries: 0,
    });
    yield* streamChatCompletions(client, req);
  }

  /** Idempotent, and concurrent callers share one startup. */
  private async ensureRunning(signal?: AbortSignal): Promise<void> {
    if (this.server && !this.server.killed && this.port) return;
    if (this.starting) return this.starting;
    this.starting = this.start(signal).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(signal?: AbortSignal): Promise<void> {
    const { serverPath, modelPath } = this.resolved();

    // isFile(), not existsSync(): a directory passes an existence check and
    // then fails asynchronously inside spawn, where the error was reaching
    // uncaughtException instead of this function's caller.
    if (!serverPath || !isFile(serverPath)) {
      throw new Error(
        `The local inference engine is missing (looked in ${serverPath || 'the bundled location'}).\n\n` +
          'Run `npm run fetch:model` in the Nabsun source tree, or set a path to ' +
          'llama-server in Settings → Models.',
      );
    }
    if (!modelPath || !isFile(modelPath)) {
      throw new Error(
        `The local model file is missing (looked for ${modelPath || BUNDLED_MODEL_FILE}).\n\n` +
          'Run `npm run fetch:model`, or point Settings → Models at a .gguf file you already have.',
      );
    }

    const options = this.getOptions();
    const port = await freePort();
    const args = [
      '--model', modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--ctx-size', String(Math.max(2048, options.contextSize)),
      // Applies the model's own chat template, which is what turns tool
      // definitions into something the model was actually trained to emit.
      // Without it llama-server ignores the tools array entirely.
      '--jinja',
      // Qwen3 reasons before answering by default. For "click the search box"
      // that is pure latency — the thinking is longer than the answer — and
      // this backend exists to make routine actions cheap and quick. A harder
      // task belongs on a larger model, which is one setting away.
      '--reasoning', 'off',
      // Reuse the KV cache across turns: the system prompt and the page
      // snapshot are largely identical between steps of the same task.
      '--cache-reuse', '256',
      // Authentication is off by default, and `--no-webui` disables the UI, not
      // the API — so without this any local process can use the browser's
      // inference service.
      '--api-key', this.apiKey,
      // And no browser origin can, either. The default reflects whatever
      // Origin it is sent; there is exactly one legitimate caller here and it
      // is not a web page.
      '--cors-origins', 'localhost',
      // Nothing here should serve a UI; the API above is the only surface.
      '--no-webui',
    ];
    if (options.threads > 0) args.push('--threads', String(options.threads));

    this.lastStderr = '';
    let child: ChildProcess;
    try {
      child = spawn(serverPath, args, {
        cwd: path.dirname(serverPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // spawn throws synchronously for ENOENT/EINVAL rather than emitting.
      throw new Error(
        `Could not start the local model engine at ${serverPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    child.stdout?.resume();
    child.stderr?.on('data', (b: Buffer) => {
      // Bounded: llama.cpp is chatty, and this is only ever a failure message.
      this.lastStderr = `${this.lastStderr}${b.toString('utf8')}`.slice(-4000);
    });
    child.on('exit', (code) => {
      if (this.server === child) {
        this.server = null;
        this.port = 0;
        this.active = null;
      }
      if (code) console.error(`[local] llama-server exited with ${code}`);
    });

    // Not every spawn failure is synchronous. A path that exists but cannot be
    // executed fails through this event, and with no listener Node promotes it
    // to an uncaughtException that takes down the browser rather than failing
    // the turn. Recorded here and read by the startup wait below.
    let spawnError: Error | null = null;
    child.on('error', (err: Error) => {
      spawnError = err;
    });

    this.server = child;

    try {
      await waitForHealth(port, 120_000, () => child.exitCode !== null || spawnError !== null, signal);
    } catch (err) {
      child.kill();
      this.server = null;
      const cause = spawnError ? (spawnError as Error).message : null;
      const detail = this.lastStderr.trim().split('\n').slice(-6).join('\n');
      throw new Error(
        `The local model did not start: ${cause ?? (err instanceof Error ? err.message : String(err))}` +
          (detail ? `\n\n${detail}` : ''),
      );
    }

    this.port = port;
    // Recorded only once the server answers, so `contextTokens` never reports
    // a configuration that failed to start.
    this.active = {
      contextSize: Math.max(2048, options.contextSize),
      threads: options.threads,
      serverPath,
      modelPath,
    };
    console.log(`[local] ${path.basename(modelPath)} ready on 127.0.0.1:${port}`);
  }

  /** Called on quit; a stranded llama-server would hold the weights in RAM. */
  stop(): void {
    this.server?.kill();
    this.server = null;
    this.port = 0;
    this.active = null;
  }
}

/**
 * Polls the server's health endpoint until it loads the model.
 *
 * A fixed sleep would either be too short on a cold disk or waste seconds on a
 * warm one; a 1.1 GB model off a spinning disk can take a while the first time.
 */
async function waitForHealth(
  port: number,
  timeoutMs: number,
  died: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Stop is not something to notice two minutes later. Loading a large model
    // on a slow disk can take most of this window, and the user pressing Stop
    // during it deserves to be obeyed.
    if (signal?.aborted) throw new Error('startup was cancelled');
    if (died()) throw new Error('the engine exited during startup');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`it did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

/** A path that exists *and* is a regular file. A directory is neither. */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** An ephemeral port, so two windows or a stale process cannot collide. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/**
 * Thread count to offer when the user wants one, leaving the UI some room.
 *
 * The old value — half the logical processors, capped at 8 — came from the
 * usual "physical cores, SMT does not help" advice, and measurement did not
 * agree. On a 12-thread i7-1255U, prompt processing went 49 tok/s at 6 threads
 * and 70 at 12; the received wisdom cost 43%. Modern hybrid laptop chips are
 * not the machines that advice was written for.
 *
 * Two short of every processor, so a long prompt does not make the browser
 * itself stutter. Note the shipped default is 0 — llama.cpp's own choice — and
 * this is only a suggestion for someone setting the field by hand.
 */
export function suggestedThreads(): number {
  return Math.max(2, Math.min(16, os.cpus().length - 2));
}
