import { spawn } from 'node:child_process';
import os from 'node:os';
import type { AccountStatus, ProviderId } from '../../shared/types';
import { launcherEnv, resolveLauncher, type Launcher } from '../ai/providers/cli';

interface CliSpec {
  binName: string;
  /** Argument sets for each account operation, or null when unsupported. */
  status: string[] | null;
  loginBrowser: string[] | null;
  loginDevice: string[] | null;
  loginApiKey: string[] | null;
  logout: string[] | null;
}

const SPECS: Partial<Record<ProviderId, CliSpec>> = {
  'codex-cli': {
    binName: 'codex',
    status: ['login', 'status'],
    loginBrowser: ['login'],
    // Device flow prints a URL and a code, which we can show in the panel.
    loginDevice: ['login', '--device-auth'],
    loginApiKey: ['login', '--with-api-key'],
    logout: ['logout'],
  },
  'claude-cli': {
    binName: 'claude',
    // Claude Code manages auth through its own interactive `/login`; there is
    // no documented non-interactive status command, so we only report presence.
    status: null,
    loginBrowser: null,
    loginDevice: null,
    loginApiKey: null,
    logout: null,
  },
};

export type LoginMode = 'browser' | 'device' | 'apiKey';

export interface AccountRunEvent {
  provider: ProviderId;
  /** Streamed CLI output, so a device code or URL is visible in the panel. */
  chunk?: string;
  /** A sign-in URL found in the output, so the browser can open it in a tab. */
  url?: string;
  /** A device code found in the output, shown prominently to be typed. */
  code?: string;
  done?: boolean;
  ok?: boolean;
  error?: string;
}

/**
 * Pulls the sign-in URL and device code out of whatever the CLI prints.
 *
 * The exact wording differs between tools and versions, so this matches shape
 * rather than phrasing: the first http(s) URL, and a grouped code of the
 * `ABCD-EFGH` form that device flows use. Deliberately tolerant â€” a missed code
 * just means the user reads it from the streamed output instead.
 */
export function parseLoginOutput(text: string): { url?: string; code?: string } {
  const out: { url?: string; code?: string } = {};

  // Trailing punctuation is common when a URL ends a sentence.
  const url = /https?:\/\/[^\s"'<>)\]]+/.exec(text)?.[0]?.replace(/[.,;:]+$/, '');
  if (url) out.url = url;

  const grouped = /\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/.exec(text)?.[0];
  const labelled = /(?:code|enter)\D{0,20}?\b([A-Z0-9]{6,10})\b/i.exec(text)?.[1];
  const code = grouped ?? labelled;
  // A code that is just part of the URL is not a code.
  if (code && !(out.url ?? '').includes(code)) out.code = code;

  return out;
}

/**
 * Connect / disconnect for CLI-backed assistants.
 *
 * The CLI owns the credentials â€” we never see them â€” so "connecting an account"
 * means running that tool's own login command and showing the user what it
 * prints. `codex login` opens a browser; `--device-auth` prints a code to type
 * elsewhere, which is the flow that works when the browser cannot be handed
 * over cleanly.
 */
export class CliAccountManager {
  /** provider -> the login process currently running, so it can be cancelled. */
  private running = new Map<ProviderId, ReturnType<typeof spawn>>();

  constructor(
    private readonly getOverride: (id: ProviderId) => string,
    private readonly emit: (event: AccountRunEvent) => void,
  ) {}

  private launcherFor(id: ProviderId): { spec: CliSpec; launcher: Launcher } | null {
    const spec = SPECS[id];
    if (!spec) return null;
    const launcher = resolveLauncher(spec.binName, this.getOverride(id));
    return launcher ? { spec, launcher } : null;
  }

  supports(id: ProviderId): boolean {
    return Boolean(SPECS[id]?.status);
  }

  /** Runs the CLI's status command and reports whether an account is connected. */
  async status(id: ProviderId): Promise<AccountStatus> {
    const resolved = this.launcherFor(id);
    if (!resolved) {
      return { provider: id, supported: false, connected: false, detail: 'CLI not installed' };
    }
    const { spec, launcher } = resolved;
    if (!spec.status) {
      return {
        provider: id,
        supported: false,
        connected: false,
        detail: 'This CLI manages sign-in interactively.',
      };
    }

    const result = await this.run(launcher, spec.status, { timeoutMs: 15_000 });
    const text = `${result.stdout}\n${result.stderr}`.trim();

    // Treat an explicit "not logged in" as authoritative; otherwise a zero exit
    // with an account line means connected.
    const notLoggedIn = /not logged in|no credentials|logged out|please run .*login/i.test(text);
    const connected = result.code === 0 && !notLoggedIn && text.length > 0;

    return {
      provider: id,
      supported: true,
      connected,
      detail: summarise(text) || (connected ? 'Connected' : 'Not connected'),
    };
  }

  /**
   * Starts a login. Output is streamed so the panel can show a device code or a
   * URL while it is happening.
   */
  async login(id: ProviderId, mode: LoginMode, apiKey?: string): Promise<void> {
    const resolved = this.launcherFor(id);
    if (!resolved) {
      this.emit({ provider: id, done: true, ok: false, error: 'That CLI is not installed.' });
      return;
    }
    const { spec, launcher } = resolved;
    const args =
      mode === 'device' ? spec.loginDevice : mode === 'apiKey' ? spec.loginApiKey : spec.loginBrowser;
    if (!args) {
      this.emit({ provider: id, done: true, ok: false, error: 'That sign-in method is not supported.' });
      return;
    }

    this.cancel(id);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launcher.command, [...launcher.args, ...args], {
        cwd: os.tmpdir(),
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          ...launcherEnv(launcher),
        },
        windowsHide: true,
      });
    } catch (err) {
      // spawn() throws synchronously for EINVAL/ENOENT.
      this.emit({
        provider: id,
        done: true,
        ok: false,
        error: `Could not start the CLI: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    this.running.set(id, child);

    // An API key arrives on stdin so it never appears in a command line or in
    // any process listing.
    if (mode === 'apiKey') {
      child.stdin?.on('error', () => {});
      child.stdin?.end(`${apiKey ?? ''}\n`, 'utf8');
    }

    // Output arrives in arbitrary chunks, so scan the accumulated text and only
    // announce a URL or code the first time it appears.
    let seen = '';
    let sentUrl: string | undefined;
    let sentCode: string | undefined;

    const forward = (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      seen += chunk;
      const found = parseLoginOutput(seen);
      const event: AccountRunEvent = { provider: id, chunk };
      if (found.url && found.url !== sentUrl) {
        sentUrl = found.url;
        event.url = found.url;
      }
      if (found.code && found.code !== sentCode) {
        sentCode = found.code;
        event.code = found.code;
      }
      this.emit(event);
    };

    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);

    child.on('error', (err) => {
      this.running.delete(id);
      this.emit({ provider: id, done: true, ok: false, error: err.message });
    });
    child.on('close', (code) => {
      this.running.delete(id);
      this.emit({
        provider: id,
        done: true,
        ok: code === 0,
        error: code === 0 ? undefined : `Sign-in exited with code ${code}.`,
      });
    });
  }

  async logout(id: ProviderId): Promise<{ ok: boolean; error?: string }> {
    const resolved = this.launcherFor(id);
    if (!resolved?.spec.logout) return { ok: false, error: 'Sign-out is not supported for this CLI.' };
    const result = await this.run(resolved.launcher, resolved.spec.logout, { timeoutMs: 20_000 });
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: summarise(`${result.stdout}\n${result.stderr}`) || 'Sign-out failed.' };
  }

  /** Stops a login that is waiting on the user. */
  cancel(id: ProviderId) {
    const child = this.running.get(id);
    if (child) {
      child.kill();
      this.running.delete(id);
    }
  }

  private run(
    launcher: Launcher,
    args: string[],
    opts: { timeoutMs: number },
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(launcher.command, [...launcher.args, ...args], {
          cwd: os.tmpdir(),
          env: {
            ...process.env,
            NO_COLOR: '1',
            FORCE_COLOR: '0',
            ...launcherEnv(launcher),
          },
          windowsHide: true,
        });
      } catch (err) {
        resolve({ code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
        return;
      }

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
      child.stderr?.on('data', (b: Buffer) => (stderr += b.toString('utf8')));

      // A status command that hangs must not hang the settings panel.
      const timer = setTimeout(() => child.kill(), opts.timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }
}

/** First meaningful line of CLI output, for a one-line status. */
function summarise(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 160) : '';
}
