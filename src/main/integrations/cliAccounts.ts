import { spawn } from 'node:child_process';
import os from 'node:os';
import type { AccountStatus, ProviderId } from '../../shared/types';
import { clearBinCache, launcherEnv, resolveLauncher, type Launcher } from '../ai/providers/cli';
import { installNativeCli, isNativeCli, stopCliProcess } from './nativeCli';
import { loginCodex, UnsupportedCodexLogin } from './codexLogin';

export type LoginMode = 'browser' | 'device' | 'apiKey' | 'repair';
export interface AccountRunEvent {
  provider: ProviderId;
  message?: string;
  chunk?: string;
  url?: string;
  code?: string;
  done?: boolean;
  ok?: boolean;
  error?: string;
}

export function parseLoginOutput(text: string): { url?: string; code?: string } {
  const url = /https?:\/\/[^\s"'<>)\]]+/.exec(text)?.[0]?.replace(/[.,;:]+$/, '');
  const grouped = /\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/.exec(text)?.[0];
  const labelled = /(?:code|enter)\D{0,20}?\b([A-Z0-9]{6,10})\b/i.exec(text)?.[1];
  const code = grouped ?? labelled;
  return { ...(url ? { url } : {}), ...(code && !url?.includes(code) ? { code } : {}) };
}

export function isSignInUrl(id: ProviderId, value: string): boolean {
  try {
    const url = new URL(value);
    const hosts = id === 'codex-cli' ? ['auth.openai.com', 'auth0.openai.com', 'chatgpt.com']
      : id === 'claude-cli' ? ['claude.ai', 'platform.claude.com', 'console.anthropic.com', 'auth.anthropic.com'] : [];
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname);
  } catch { return false; }
}

/** The native CLI owns credentials. Nabsun handles setup, sign-in and verification. */
export class CliAccountManager {
  private operations = new Map<ProviderId, AbortController>();
  private completions = new Map<ProviderId, Promise<void>>();
  private shutdown = new AbortController();
  private signouts = new Map<ProviderId, Promise<{ ok: boolean; error?: string }>>();
  private installedPaths = new Map<ProviderId, { path: string; setting: string }>();
  constructor(
    private readonly getOverride: (id: ProviderId) => string,
    private readonly emit: (event: AccountRunEvent) => void,
    private readonly install: (id: 'codex-cli' | 'claude-cli', signal: AbortSignal, progress: (message: string) => void) => Promise<string | void> = installNativeCli,
    private readonly resolve = resolveLauncher,
    private readonly selectExecutable: (id: 'codex-cli' | 'claude-cli', executable: string) => void = () => {},
  ) {}

  private launcher(id: ProviderId): Launcher | null {
    const override = this.getOverride(id);
    const installed = this.installedPaths.get(id);
    const selected = installed?.setting === override ? installed.path : override;
    return isNativeCli(id) ? this.resolve(id === 'codex-cli' ? 'codex' : 'claude', selected) : null;
  }

  supports(id: ProviderId): boolean { return isNativeCli(id); }

  async status(id: ProviderId, signal?: AbortSignal): Promise<AccountStatus> {
    const launcher = this.launcher(id);
    if (!launcher) return { provider: id, supported: this.supports(id), connected: false, detail: 'Ready to connect' };
    const result = await this.run(launcher, id === 'codex-cli' ? ['login', 'status'] : ['auth', 'status'],
      AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]));
    let connected = false;
    if (result.code === 0) {
      if (id === 'claude-cli') {
        try { connected = JSON.parse(result.stdout).loggedIn === true; } catch { /* Older CLIs cannot verify sign-in. */ }
      } else {
        const text = `${result.stdout}\n${result.stderr}`.trim();
        connected = text.length > 0 && !/not logged in|no credentials|logged out|please run .*login/i.test(text);
      }
    }
    return { provider: id, supported: true, connected, detail: connected ? 'Connected' : 'Not connected' };
  }

  async login(id: ProviderId, mode: LoginMode, apiKey?: string): Promise<void> {
    const signout = this.signouts.get(id);
    if (signout) await signout.catch(() => {});
    const previous = this.operations.get(id);
    if (previous) {
      if (previous.signal.aborted) {
        await this.completions.get(id);
        return this.login(id, mode, apiKey);
      }
      return;
    }
    if (this.shutdown.signal.aborted) return;
    if (!isNativeCli(id) || !['browser', 'device', 'apiKey', 'repair'].includes(mode) || (id === 'claude-cli' && !['browser', 'repair'].includes(mode))) {
      this.emit({ provider: id, done: true, ok: false, error: 'This sign-in method is not supported.' }); return;
    }
    const controller = new AbortController();
    let settle!: () => void;
    this.completions.set(id, new Promise<void>(resolve => { settle = resolve; }));
    this.operations.set(id, controller);
    let originalOverride = this.getOverride(id);
    const { signal } = controller;
    const notify = (event: Omit<AccountRunEvent, 'provider'>) => {
      if (this.operations.get(id) === controller && !signal.aborted) this.emit({ provider: id, ...event });
    };
    try {
      notify({ message: 'Preparing your connection...' });
      let launcher = this.launcher(id);
      let preparedThisAttempt = false;
      const setup = async () => {
        const executable = await this.install(id, signal, message => notify({ message }));
        clearBinCache();
        signal.throwIfAborted();
        if (this.getOverride(id) !== originalOverride) throw new Error('The executable setting changed during setup. Connect again with the new setting.');
        if (executable) {
          const prepared = this.resolve(id === 'codex-cli' ? 'codex' : 'claude', executable);
          if (!prepared) throw new Error('The updated CLI could not be found. Try Repair / update again.');
          const version = await this.run(prepared, ['--version'], AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
          signal.throwIfAborted();
          if (version.code !== 0 || !/\d+\.\d+\.\d+/.test(version.stdout + version.stderr)) throw new Error('The updated CLI could not start. Try Repair / update again.');
          if (this.getOverride(id) !== originalOverride) throw new Error('The executable setting changed during setup. Connect again with the new setting.');
          this.selectExecutable(id, executable);
          originalOverride = this.getOverride(id);
          this.installedPaths.set(id, { path: executable, setting: originalOverride });
        }
        launcher = this.launcher(id);
        if (!launcher) throw new Error('Setup finished, but the CLI could not be found. Try connecting again.');
        preparedThisAttempt = true;
      };
      if (!launcher || mode === 'repair') {
        if (!launcher && originalOverride && mode !== 'repair') throw new Error('The custom executable was not found. Choose Repair / update to set it up automatically.');
        await setup();
      }
      let existing = await this.status(id, signal);
      signal.throwIfAborted();
      if (!existing.connected || mode === 'apiKey') {
        // Old CLIs report unknown-command for their account interface. Upgrade
        // only that case; network/account failures should never cause reinstall loops.
        if (mode !== 'repair') {
          const help = await this.run(launcher!, id === 'codex-cli' ? ['app-server', '--help'] : ['auth', 'login', '--help'],
            AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
          signal.throwIfAborted();
          const helpText = help.stdout + help.stderr;
          const commandUsage = id === 'codex-cli' ? /usage:[^\r\n]*\bapp-server\b/i : /usage:[^\r\n]*\bauth\s+login\b/i;
          const unsupported = (help.code !== 0 && /unknown|unrecognized|unexpected argument|invalid (?:command|subcommand)/i.test(helpText))
            || (help.code === 0 && /usage:/i.test(helpText) && !commandUsage.test(helpText));
          if (unsupported && !preparedThisAttempt) {
            notify({ message: 'Updating this assistant for browser sign-in...' });
            await setup();
            existing = await this.status(id, signal);
            signal.throwIfAborted();
          }
        }
        if (!existing.connected || mode === 'apiKey') {
          notify({ message: 'Starting secure sign-in...' });
          const sentUrls = new Set<string>();
          const onUrl = (url: string) => {
            if (!isSignInUrl(id, url)) throw new Error('The CLI returned an unrecognized sign-in address.');
            if (!sentUrls.has(url)) { sentUrls.add(url); notify({ url, message: 'Finish signing in on the account page.' }); }
          };
          if (id === 'codex-cli' && (mode === 'browser' || mode === 'repair')) {
            try { await loginCodex(launcher!, signal, onUrl); }
            catch (error) {
              signal.throwIfAborted();
              if (!(error instanceof UnsupportedCodexLogin) || preparedThisAttempt) throw error;
              notify({ message: 'Updating Codex for browser sign-in...' });
              await setup();
              if (!(await this.status(id, signal)).connected) await loginCodex(launcher!, signal, onUrl);
            }
          } else {
            const args = id === 'claude-cli' ? ['auth', 'login'] : mode === 'device' ? ['login', '--device-auth'] : ['login', '--with-api-key'];
            const output = { stdout: '', stderr: '' };
            let sentCode = '';
            const result = await this.run(launcher!, args, AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]), (chunk, stream) => {
              // stderr progress can arrive between two halves of a stdout URL.
              const seen = output[stream] = (output[stream] + chunk).slice(-32_000);
              // Wait for a delimiter; a URL can arrive split across multiple chunks.
              for (const match of seen.matchAll(/https:\/\/[^\s"'<>)\]]+(?=[\s"'<>)\]])/g)) {
                const url = match[0].replace(/[.,;:]+$/, '');
                if (isSignInUrl(id, url)) onUrl(url);
              }
              const code = mode === 'device' ? parseLoginOutput(seen).code : undefined;
              if (code && code !== sentCode) { sentCode = code; notify({ code }); }
            }, mode === 'apiKey' ? `${apiKey ?? ''}\n` : undefined);
            signal.throwIfAborted();
            if (result.code !== 0) throw new Error('Sign-in did not finish. Try again, or choose Repair / update.');
          }
        }
      }
      signal.throwIfAborted();
      notify({ message: 'Checking your connection...' });
      if (this.getOverride(id) !== originalOverride) throw new Error('The executable setting changed during sign-in. Connect again with the new setting.');
      if (!(await this.status(id, signal)).connected) throw new Error('Sign-in could not be verified. Try connecting again.');
      signal.throwIfAborted();
      if (this.getOverride(id) !== originalOverride) throw new Error('The executable setting changed during sign-in. Connect again with the new setting.');
      notify({ done: true, ok: true, message: 'Connected and ready to use.' });
    } catch (error) {
      notify({ done: true, ok: false, error: error instanceof Error ? error.message : 'Connection failed. Try again.' });
    } finally {
      if (this.operations.get(id) === controller) this.operations.delete(id);
      this.completions.delete(id);
      if (signal.aborted) this.emit({ provider: id, done: true, ok: false, message: 'Connection cancelled.' });
      settle();
    }
  }

  logout(id: ProviderId): Promise<{ ok: boolean; error?: string }> {
    const pending = this.signouts.get(id);
    if (pending) return pending;
    const work = this.signOut(id);
    this.signouts.set(id, work);
    return work.finally(() => { if (this.signouts.get(id) === work) this.signouts.delete(id); });
  }

  private async signOut(id: ProviderId): Promise<{ ok: boolean; error?: string }> {
    this.cancel(id);
    await this.completions.get(id);
    const launcher = this.launcher(id);
    if (!launcher) return { ok: true };
    const result = await this.run(launcher, id === 'codex-cli' ? ['logout'] : ['auth', 'logout'],
      AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20_000)]));
    return result.code === 0 ? { ok: true } : { ok: false, error: 'Sign-out failed. Try again.' };
  }

  cancel(id: ProviderId): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    if (operation.signal.aborted) return;
    operation.abort();
    this.emit({ provider: id, message: 'Cancelling connection...' });
  }

  cancelAll(): void {
    this.shutdown.abort();
    for (const id of this.operations.keys()) this.cancel(id);
  }

  private run(launcher: Launcher, args: string[], signal: AbortSignal, onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      if (signal.aborted) { resolve({ code: -1, stdout: '', stderr: '' }); return; }
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(launcher.command, [...launcher.args, ...args], {
          cwd: os.tmpdir(), windowsHide: true, detached: process.platform !== 'win32',
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...launcherEnv(launcher) },
        });
      } catch { resolve({ code: -1, stdout: '', stderr: '' }); return; }
      let stdout = '', stderr = '';
      const abort = () => stopCliProcess(child);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-32_000); onOutput?.(chunk, 'stdout'); });
      child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-32_000); onOutput?.(chunk, 'stderr'); });
      child.stdin?.on('error', () => {});
      if (input !== undefined) child.stdin?.end(input, 'utf8');
      const finish = (code: number | null) => { signal.removeEventListener('abort', abort); resolve({ code, stdout, stderr }); };
      child.on('error', () => finish(-1));
      child.on('close', code => finish(code));
    });
  }
}
