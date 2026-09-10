import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderId } from '../../../shared/types';
import type { ModelMessage, Provider, StreamEvent, StreamRequest } from '../provider';

export interface CliBridgeInfo {
  url: string;
  token: string;
  /** Absolute path to bin/nabsun-mcp.mjs. */
  serverScript: string;
}

/**
 * Locates an executable the way a shell would.
 *
 * Cached, because this spawns a process and is asked on every turn. A hit is
 * kept only while the file is still there, so uninstalling is noticed; a miss
 * is kept briefly, so installing a CLI and coming back to the Extensions panel
 * finds it without a restart.
 */
export function resolveBin(name: string): string | null {
  const hit = binCache.get(name);
  if (hit) {
    if (hit.path && fs.existsSync(hit.path)) return hit.path;
    if (!hit.path && Date.now() - hit.at < 5_000) return null;
  }
  const found = searchPath(name);
  binCache.set(name, { path: found, at: Date.now() });
  return found;
}

const binCache = new Map<string, { path: string | null; at: number }>();

function searchPath(name: string): string | null {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const res = spawnSync(finder, [name], { encoding: 'utf8' });
    if (res.status !== 0 || !res.stdout) return null;
    const candidates = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (process.platform === 'win32') {
      // .exe first, then the .cmd shim; .ps1 cannot be spawned at all.
      return (
        candidates.find((c) => /\.exe$/i.test(c)) ??
        candidates.find((c) => /\.(cmd|bat)$/i.test(c)) ??
        candidates.find((c) => !/\.ps1$/i.test(c)) ??
        null
      );
    }
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

/** A concrete command line that can be spawned without a shell. */
export interface Launcher {
  command: string;
  args: string[];
  /** Set when `command` is Electron being used as a plain Node runtime. */
  runAsNode: boolean;
  /** Extra environment the CLI's own wrapper would have set. */
  env?: Record<string, string>;
}

/**
 * Turns a resolved binary into something `spawn` will actually accept.
 *
 * On Windows an npm-installed CLI is a `.cmd` batch shim, and since the
 * CVE-2024-27980 mitigation Node refuses to spawn `.cmd`/`.bat` without
 * `shell: true` — it fails with EINVAL. Using a shell is not an acceptable fix
 * here: the prompt would become part of a command line the shell parses.
 *
 * So we read the shim and spawn what it would have spawned. Some shims name the
 * binary outright — Claude's does — and those need nothing further. Codex's
 * names a Node script, and for those we look for the binary that script would
 * have spawned; see `nativeBinaryFor()` for why running it ourselves matters.
 * Driving Electron as a Node runtime is the last resort, for a CLI that really
 * is only JavaScript.
 */
export function resolveLauncher(binName: string, override: string): Launcher | null {
  const direct = override.trim() || resolveBin(binName);
  if (!direct || !fs.existsSync(direct)) return null;

  return cachedLauncher(direct, () => {
    const ext = path.extname(direct).toLowerCase();
    if (ext === '.exe' || ext === '') return { command: direct, args: [], runAsNode: false };

    if (ext === '.cmd' || ext === '.bat') {
      const target = readShimTarget(direct);
      if (!target) return null;
      if (isScript(target)) {
        const native = nativeBinaryFor(target, binName);
        if (native) return native;
        return { command: process.execPath, args: [target], runAsNode: true };
      }
      return { command: target, args: [], runAsNode: false };
    }

    // .ps1 and anything else: try a sibling we can spawn directly.
    for (const candidate of ['.exe', '.cmd']) {
      const sibling = direct.replace(/\.[^.]+$/, candidate);
      if (fs.existsSync(sibling)) return resolveLauncher(sibling, sibling);
    }
    return null;
  });
}

const isScript = (file: string) => /\.(js|cjs|mjs)$/i.test(file);

/**
 * Resolution now searches a package tree and runs what it finds, which is far
 * too much to repeat on every turn. Keyed by the entry point's identity on
 * disk, so upgrading the CLI re-resolves by itself.
 */
const launcherCache = new Map<string, Launcher | null>();

function cachedLauncher(entry: string, resolve: () => Launcher | null): Launcher | null {
  let key = entry;
  try {
    const stat = fs.statSync(entry);
    key = `${entry}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    // Unreadable: fall through and let resolution fail honestly.
  }
  if (launcherCache.has(key)) return launcherCache.get(key)!;

  const launcher = resolve();
  launcherCache.set(key, launcher);
  return launcher;
}

/**
 * Finds the native binary an npm wrapper script would have spawned.
 *
 * Both CLIs we support are now Rust binaries with a Node script in front of
 * them, and that script is pure overhead we cannot control. Codex's re-spawns
 * the binary with `stdio: 'inherit'` and no `windowsHide`: our child is hidden,
 * but spawn options do not reach *its* children, so Windows hands the
 * grandchild a console window of its own — a black box over the browser on
 * every turn. Nothing can be passed through the wrapper to stop it.
 *
 * So we find the binary and run it ourselves, hidden. That also drops a Node
 * process from every turn.
 *
 * The two packages disagree about where to put it —
 *   codex:  <pkg>/node_modules/@openai/codex-win32-x64/vendor/<triple>/bin/codex.exe
 *   claude: <pkg>/bin/claude.exe
 * — and a layout is not a contract, so this searches for the name instead of
 * predicting the path: breadth-first from the package root, nearest match
 * first, bounded so a deep tree cannot stall a turn. Every candidate is then
 * *run* before it is trusted, because the failure mode of guessing wrong is a
 * CLI that never starts.
 */
function nativeBinaryFor(script: string, binName: string): Launcher | null {
  const root = packageRootOf(script);
  if (!root) return null;

  for (const candidate of findExecutables(root, binName)) {
    if (!isWorkingCli(candidate)) continue;
    return { command: candidate, args: [], runAsNode: false, env: wrapperEnv(root) };
  }
  return null;
}

/**
 * Environment the package's own wrapper would have set.
 *
 * Only Codex sets any, and only to keep its "how to upgrade" advice accurate —
 * but printing the wrong upgrade command sends someone down a dead end, so it
 * is worth carrying. Keyed off the package's real name rather than assumed,
 * so Claude does not inherit Codex's variables.
 */
function wrapperEnv(pkgRoot: string): Record<string, string> | undefined {
  let name: unknown;
  try {
    name = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).name;
  } catch {
    return undefined;
  }
  if (name === '@openai/codex') {
    return { CODEX_MANAGED_PACKAGE_ROOT: pkgRoot, CODEX_MANAGED_BY_NPM: '1' };
  }
  return undefined;
}

/**
 * Executables named after the CLI, nearest first.
 *
 * Bounded on both depth and directories visited: this runs while someone is
 * waiting for a reply, and a package's `node_modules` can be arbitrarily deep.
 */
function* findExecutables(root: string, binName: string): Generator<string> {
  const wanted = process.platform === 'win32' ? `${binName}.exe`.toLowerCase() : binName;
  const queue = [root];
  let visited = 0;

  while (queue.length && visited < 3_000) {
    const dir = queue.shift()!;
    visited++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.name.toLowerCase() === wanted && isNativeExecutable(full)) {
        yield full;
      }
    }
  }
}

/**
 * Rejects a script wearing an executable's name. On Unix the wrapper and the
 * binary can both be called `claude`, and the wrapper is the thing we are
 * trying to escape; a shebang is what tells them apart.
 */
function isNativeExecutable(file: string): boolean {
  if (process.platform === 'win32') return true;
  try {
    if (!(fs.statSync(file).mode & 0o111)) return false;
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    return head.toString('latin1') !== '#!';
  } catch {
    return false;
  }
}

/** Verified launchers, keyed by path and the file's identity on disk. */
const cliProbes = new Map<string, boolean>();

/**
 * Whether this really is the CLI, established by running it.
 *
 * Cached against the file's size and mtime, so an upgrade re-probes but a
 * conversation does not pay for this on every turn.
 */
function isWorkingCli(candidate: string): boolean {
  let key: string;
  try {
    const stat = fs.statSync(candidate);
    key = `${candidate}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return false;
  }

  const cached = cliProbes.get(key);
  if (cached !== undefined) return cached;

  let ok = false;
  try {
    const res = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    ok = res.status === 0 && /\d+\.\d+/.test(`${res.stdout ?? ''}${res.stderr ?? ''}`);
  } catch {
    ok = false;
  }

  cliProbes.set(key, ok);
  return ok;
}

/**
 * The environment a launcher needs, on top of whatever the caller sets.
 *
 * `ELECTRON_NO_ATTACH_CONSOLE` matters on Windows: Electron in Node mode
 * attaches to a console, and with no console to attach to it gets a new one —
 * another empty black window over the browser.
 */
export function launcherEnv(launcher: Launcher): Record<string, string> {
  return {
    ...launcher.env,
    ...(launcher.runAsNode
      ? { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' }
      : {}),
  };
}

/** Walks up from a script to the directory holding its package.json. */
function packageRootOf(script: string): string | null {
  let dir = path.dirname(script);
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}


/** Extracts the real target out of an npm `.cmd` shim. */
function readShimTarget(shim: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(shim, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(shim);
  // Every quoted token that looks like a script or binary, most specific first.
  for (const match of text.matchAll(/"([^"]+\.(?:js|mjs|cjs|exe))"/gi)) {
    const raw = match[1];
    const resolved = path.resolve(
      dir,
      raw.replace(/%~?dp0%?\\?/gi, '').replace(/^\\+/, ''),
    );
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

/**
 * Renders the conversation into a single prompt, for backends that cannot
 * resume their own thread. Bounded, because the CLI reads this on every turn.
 */
export function conversationPrompt(messages: ModelMessage[], maxHistoryChars = 8_000): string {
  const turns: { role: string; text: string }[] = [];
  for (const msg of messages) {
    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
      .trim();
    if (text) turns.push({ role: msg.role === 'user' ? 'User' : 'Assistant', text });
  }
  if (!turns.length) return '';

  // The final user turn is the actual request; everything before is context.
  const current = turns.pop()!;
  if (!turns.length) return current.text;

  let history = turns.map((t) => `${t.role}: ${t.text}`).join('\n\n');
  if (history.length > maxHistoryChars) {
    history = `[earlier turns omitted]\n\n${history.slice(-maxHistoryChars)}`;
  }

  return `Earlier in this conversation:\n\n${history}\n\n---\n\n${current.text}`;
}

/**
 * Prefixes the host's operating rules to a CLI prompt.
 *
 * A delegated CLI never sees `req.system`, so without this the browser's own
 * safety rules stop at the process boundary while the CLI still holds browser
 * tools. Bounded, since it is re-sent every turn.
 */
export function withHostInstructions(prompt: string, system: string, maxChars = 6_000): string {
  const rules = (system ?? '').trim();
  if (!rules) return prompt;
  const clipped = rules.length > maxChars ? `${rules.slice(0, maxChars)}\n[…]` : rules;
  return [
    'You are operating inside Nabsun, which owns the browser you are',
    'driving. Follow its operating rules for the whole of this task:',
    '',
    clipped,
    '',
    '--- end of Nabsun rules ---',
    '',
    prompt,
  ].join('\n');
}

/** Pulls the newest user text out of the conversation for the CLI's prompt. */
function latestUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

/**
 * Base for backends that delegate the entire turn to a locally installed agent
 * CLI. The CLI runs its own tool loop and authenticates with its own login, so
 * Nabsun never handles a key — the same arrangement as the Claude and
 * Codex extensions in VS Code.
 *
 * Browser tools reach the CLI over MCP: we point it at `bin/nabsun-mcp.mjs`,
 * which proxies back into this process. Calls still pass the approval gate.
 *
 * These providers emit prose and progress but never `tool_use`, so the agent
 * loop runs exactly one iteration and lets the CLI own the rest.
 */
abstract class CliProvider implements Provider {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  protected abstract readonly binName: string;

  /** conversationKey -> the CLI's own session id, so turns stay in one thread. */
  protected sessions = new Map<string, string>();

  /**
   * True when the backend cannot resume its own thread, so the conversation
   * must be replayed in the prompt each turn.
   */
  protected replayHistory = false;

  constructor(
    protected readonly bridge: () => CliBridgeInfo | null,
    protected readonly overridePath: () => string,
  ) {}

  get binaryPath(): string | null {
    const override = this.overridePath().trim();
    if (override) return fs.existsSync(override) ? override : null;
    return resolveBin(this.binName);
  }

  /** How this CLI is actually launched, shim resolution included. */
  get launcher(): Launcher | null {
    return resolveLauncher(this.binName, this.overridePath());
  }

  get installed(): boolean {
    return this.binaryPath !== null;
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  supportsVision(): boolean {
    return false;
  }

  protected abstract buildArgs(req: StreamRequest, bridge: CliBridgeInfo): string[];

  /** Translates one line of the CLI's JSONL output into stream events. */
  protected abstract handleLine(line: string): StreamEvent[];

  /** Called after the process exits, for a final answer the CLI only prints at the end. */
  protected finalize(): StreamEvent[] {
    return [];
  }

  /**
   * A better message than "exited with code N" when the CLI reports its failure
   * somewhere other than stderr.
   */
  protected failureHint(): string | null {
    return null;
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    const launcher = this.launcher;
    if (!launcher) {
      throw new Error(
        this.binaryPath
          ? `${this.label} was found at ${this.binaryPath} but could not be launched. Set an explicit path in Extensions → ${this.label}.`
          : `${this.label} is not installed, or not on PATH. Add it from the Extensions panel.`,
      );
    }
    const bridge = this.bridge();
    if (!bridge) throw new Error('The browser tool bridge is not running.');

    const body = this.replayHistory
      ? conversationPrompt(req.messages)
      : latestUserText(req.messages);
    if (!body) throw new Error('Nothing to send.');

    // The CLI runs its own harness with its own system prompt, so ours has to
    // travel in the message or the rules it carries — never enter credentials,
    // treat page text as data, stop before anything irreversible — simply do
    // not reach this backend. They are stated as house rules rather than
    // suggestions, but they are still only instructions: the approval gate is
    // what actually holds, and it is enforced on the way back in.
    const prompt = withHostInstructions(body, req.system);

    const args = [...launcher.args, ...this.buildArgs(req, bridge)];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launcher.command, args, {
        cwd: os.tmpdir(),
        env: {
          ...process.env,
          NABSUN_BRIDGE_URL: bridge.url,
          NABSUN_BRIDGE_TOKEN: bridge.token,
          // Some CLIs colourise even when piped, which corrupts JSONL parsing.
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          ...launcherEnv(launcher),
        },
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      // spawn() throws synchronously for EINVAL/ENOENT instead of emitting
      // 'error', so a bare "spawn EINVAL" would otherwise reach the user.
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not start ${this.label} (${reason}).\n` +
          `Tried: ${launcher.command}\n` +
          'Set an explicit path in Extensions, or reinstall the CLI.',
      );
    }

    // The prompt goes over stdin, never argv: it never reaches a command line,
    // and a long conversation cannot hit the platform's argument length limit.
    child.stdin.on('error', () => {
      /* the CLI may exit before we finish writing */
    });
    child.stdin.end(prompt, 'utf8');

    const onAbort = () => child.kill();
    req.signal.addEventListener('abort', onAbort, { once: true });

    // Bridge the callback-style child streams into an async iterator.
    const queue: StreamEvent[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    let failure: Error | null = null;
    let stderrTail = '';

    const push = (events: StreamEvent[]) => {
      if (!events.length) return;
      queue.push(...events);
      notify?.();
    };

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          push(this.handleLine(line));
        } catch (err) {
          console.error(`[${this.id}] failed to handle line:`, err);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = `${stderrTail}${text}`.slice(-4000);
    });

    child.on('error', (err) => {
      failure = err instanceof Error ? err : new Error(String(err));
      finished = true;
      notify?.();
    });

    child.on('close', (code) => {
      if (stdoutBuffer.trim()) {
        try {
          push(this.handleLine(stdoutBuffer));
        } catch {
          /* trailing partial line */
        }
      }
      push(this.finalize());
      if (code !== 0 && !req.signal.aborted && !failure) {
        failure = new Error(
          this.failureHint() ??
            `${this.label} exited with code ${code}.${stderrTail ? `\n${stderrTail.trim()}` : ''}`,
        );
      }
      finished = true;
      notify?.();
    });

    try {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (finished) break;
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = null;
            resolve();
          };
        });
      }
      while (queue.length) yield queue.shift()!;
      if (failure) throw failure;
      yield { type: 'stop', reason: 'end_turn' };
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      if (!child.killed) child.kill();
    }
  }
}

/* ------------------------------------------------------------ Claude Code -- */

interface ClaudeStreamLine {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  event?: {
    type: string;
    delta?: { type: string; text?: string; thinking?: string };
    content_block?: { type: string; name?: string };
  };
  message?: { content?: { type: string; name?: string; text?: string }[] };
  usage?: { input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
}

export class ClaudeCodeProvider extends CliProvider {
  readonly id: ProviderId = 'claude-cli';
  readonly label = 'Claude Code (CLI)';
  protected readonly binName = 'claude';

  private pendingKey: string | null = null;

  protected buildArgs(req: StreamRequest, bridge: CliBridgeInfo): string[] {
    this.pendingKey = req.conversationKey ?? null;

    // Written to a temp file rather than passed inline: the token should not
    // appear in the process command line, where other users could read it.
    const configPath = path.join(os.tmpdir(), `nabsun-mcp-${process.pid}.json`);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          nabsun: {
            command: process.execPath,
            args: [bridge.serverScript],
            env: {
              NABSUN_BRIDGE_URL: bridge.url,
              NABSUN_BRIDGE_TOKEN: bridge.token,
              // Electron's binary must run this as plain Node.
              ELECTRON_RUN_AS_NODE: '1',
            },
          },
        },
      }),
      'utf8',
    );

    const args = [
      // No positional prompt: it arrives on stdin.
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--mcp-config',
      configPath,
      // Pre-approve only our browser tools. Claude Code's own file and shell
      // tools stay behind its prompts, which headless mode declines.
      '--allowedTools',
      'mcp__nabsun',
    ];

    const model = req.model.trim();
    if (model) args.push('--model', model);

    const existing = req.conversationKey ? this.sessions.get(req.conversationKey) : undefined;
    if (existing) args.push('--resume', existing);

    return args;
  }

  protected handleLine(line: string): StreamEvent[] {
    const data = JSON.parse(line) as ClaudeStreamLine;
    const out: StreamEvent[] = [];

    if (data.session_id && this.pendingKey) {
      this.sessions.set(this.pendingKey, data.session_id);
    }

    if (data.type === 'stream_event' && data.event) {
      const delta = data.event.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        out.push({ type: 'text', delta: delta.text });
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        out.push({ type: 'thinking', delta: delta.thinking });
      } else if (data.event.type === 'content_block_start' && data.event.content_block?.name) {
        // Surface the CLI's own tool activity as progress, since it executes
        // those calls itself rather than handing them back to us.
        out.push({ type: 'thinking', delta: `\nâ–¸ ${data.event.content_block.name}\n` });
      }
    }

    if (data.type === 'result') {
      if (data.usage) {
        out.push({
          type: 'usage',
          usage: {
            inputTokens: data.usage.input_tokens ?? 0,
            outputTokens: data.usage.output_tokens ?? 0,
          },
        });
      }
      if (data.is_error && data.result) {
        out.push({ type: 'text', delta: `\n\n${data.result}` });
      }
    }

    return out;
  }
}

/* ------------------------------------------------------------------ Codex -- */

/** TOML literal string: no escape processing, which Windows paths need. */
const tomlString = (s: string) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);

export interface CodexArgOptions {
  model: string;
  bridge: CliBridgeInfo;
  /** The Node-capable binary the MCP server is launched with. */
  mcpCommand: string;
}

/**
 * Builds the argument list for `codex exec`.
 *
 * Two constraints shaped this, both learned the hard way:
 *
 * `codex exec` runs non-interactively with `approval_policy: never`, and that
 * cannot be changed by config — an `-c approval_policy=…` override is silently
 * ignored, the session still reports `approval: never`, and **every MCP tool
 * call is refused** with "the tool requires approval, but the current policy
 * forbids approvals". `--approve-for-me` is the only switch that lets them run.
 *
 * `--approve-for-me` is rejected alongside `--sandbox` (it implies its own),
 * and it does not exist on `exec resume` at all. Since a resumed turn therefore
 * could never call a browser tool, this does not resume: the conversation is
 * replayed in the prompt instead, which our own transcript already holds. One
 * code path, one flag set, and no "works on the first message only" bugs.
 *
 * Values after `-c` are TOML, not JSON, whatever older help text claimed.
 */
export function buildCodexArgs(opts: CodexArgOptions): string[] {
  const env: Record<string, string> = {
    NABSUN_BRIDGE_URL: opts.bridge.url,
    NABSUN_BRIDGE_TOKEN: opts.bridge.token,
    ELECTRON_RUN_AS_NODE: '1',
    // Codex spawns the MCP server itself, so we cannot hide its window; this
    // stops Electron asking for a console it would then have to display.
    ELECTRON_NO_ATTACH_CONSOLE: '1',
  };

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    // Without this, MCP tool calls are refused outright. Mutually exclusive
    // with --sandbox, so the sandbox is requested by config instead.
    '--approve-for-me',
    '-c',
    `sandbox_mode=${tomlString('read-only')}`,
    '-c',
    `mcp_servers.nabsun.command=${tomlString(opts.mcpCommand)}`,
    '-c',
    `mcp_servers.nabsun.args=[${tomlString(opts.bridge.serverScript)}]`,
    // A dotted key per variable: an inline table would need its own escaping.
    ...Object.entries(env).flatMap(([key, value]) => [
      '-c',
      `mcp_servers.nabsun.env.${key}=${tomlString(value)}`,
    ]),
  ];

  const model = opts.model.trim();
  if (model) args.push('--model', model);

  // "-" tells codex to read the instructions from stdin.
  args.push('-');
  return args;
}

/** What one line of `codex exec --json` carries, once normalised. */
export interface CodexLine {
  threadId?: string;
  text?: string;
  reasoning?: string;
  tool?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Normalises one JSONL line from `codex exec --json`.
 *
 * The schema has changed across releases and its field names are not stable:
 * 0.153 emits `{type:"item.completed", item:{type:"agent_message", text}}`,
 * while older builds used a `msg` wrapper with `message`. An earlier version of
 * this matched `assistant_message` exactly and silently dropped every reply —
 * the CLI ran, tokens were billed, and the sidebar showed nothing. So this
 * matches the *shape* (any `…_message` item carrying `text`) rather than one
 * exact name, and is exercised against real captured output in the harness.
 */
export function parseCodexLine(line: string): CodexLine {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {};
  }

  const out: CodexLine = {};
  const item = (data.item ?? {}) as Record<string, unknown>;
  const msg = (data.msg ?? {}) as Record<string, unknown>;
  const kind = String(data.type ?? msg.type ?? '');
  const itemType = String(item.type ?? '');

  const threadId = data.thread_id ?? data.session_id ?? msg.session_id;
  if (typeof threadId === 'string') out.threadId = threadId;

  // Any "<something>_message" item holding text is the assistant speaking.
  if (/(^|_)(agent|assistant)_message$/.test(itemType) && typeof item.text === 'string') {
    out.text = item.text;
  } else if (msg.type === 'agent_message' && typeof msg.message === 'string') {
    out.text = msg.message;
  } else if (kind === 'assistant_message' && typeof data.text === 'string') {
    out.text = data.text;
  }

  if (itemType === 'reasoning' && typeof item.text === 'string') out.reasoning = item.text;
  else if (msg.type === 'agent_reasoning' && typeof msg.text === 'string') out.reasoning = msg.text;

  if (itemType === 'mcp_tool_call' && typeof item.tool === 'string') out.tool = item.tool;
  else if (itemType === 'command_execution' && typeof item.command === 'string') out.tool = item.command;
  else if (msg.type === 'mcp_tool_call_begin' && typeof msg.tool === 'string') out.tool = msg.tool;

  if (kind === 'error' && typeof data.message === 'string') out.error = data.message;
  if (kind === 'turn.failed') {
    const err = (data.error ?? {}) as Record<string, unknown>;
    if (typeof err.message === 'string') out.error = err.message;
  }

  const usage = (data.usage ?? msg.usage) as Record<string, number> | undefined;
  if (usage) {
    out.usage = {
      inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
      outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    };
  }

  return out;
}

export class CodexProvider extends CliProvider {
  readonly id: ProviderId = 'codex-cli';
  readonly label = 'Codex (CLI)';
  protected readonly binName = 'codex';
  // `exec resume` cannot approve tool calls, so every turn is a fresh exec.
  protected override replayHistory = true;

  /** Codex prints its answer as a completed item; track what we already showed. */
  private emittedText = '';
  /** Codex reports failures as JSON on stdout, not on stderr. */
  private lastError: string | null = null;
  /** The CLI's own id for this turn, kept only so logs can be correlated. */
  private threadId: string | null = null;

  protected buildArgs(req: StreamRequest, bridge: CliBridgeInfo): string[] {
    this.emittedText = '';
    this.lastError = null;
    this.threadId = null;

    return buildCodexArgs({ model: req.model, bridge, mcpCommand: process.execPath });
  }

  protected handleLine(line: string): StreamEvent[] {
    const parsed = parseCodexLine(line);
    const out: StreamEvent[] = [];

    if (parsed.threadId) this.threadId = parsed.threadId;
    if (parsed.error) this.lastError = parsed.error;

    if (parsed.text && parsed.text !== this.emittedText) {
      // Items arrive complete, so emit only the part not yet shown.
      const delta = parsed.text.startsWith(this.emittedText)
        ? parsed.text.slice(this.emittedText.length)
        : `\n${parsed.text}`;
      this.emittedText = parsed.text;
      out.push({ type: 'text', delta });
    }

    if (parsed.reasoning) out.push({ type: 'thinking', delta: `${parsed.reasoning}\n` });
    if (parsed.tool) out.push({ type: 'thinking', delta: `\n▸ ${parsed.tool}\n` });
    if (parsed.usage) out.push({ type: 'usage', usage: parsed.usage });

    return out;
  }

  /**
   * Codex exits non-zero with its explanation on stdout, so the generic
   * "exited with code 1" would hide the only useful part. A stale CLI is the
   * most common cause, and its message says so — pass it straight through.
   */
  protected override failureHint(): string | null {
    if (!this.lastError) return null;
    const upgrade = /requires a newer version|upgrade to the latest/i.test(this.lastError)
      ? '\n\nUpdate the CLI with:  npm install -g @openai/codex@latest'
      : '';
    // The id points at the CLI's own session log, which holds the detail.
    const session = this.threadId ? `\n\nCodex session: ${this.threadId}` : '';
    return `Codex: ${this.lastError}${upgrade}${session}`;
  }
}

