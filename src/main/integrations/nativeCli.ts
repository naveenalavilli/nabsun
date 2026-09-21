import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export type NativeCliId = 'codex-cli' | 'claude-cli';
export function isNativeCli(id: string): id is NativeCliId {
  return id === 'codex-cli' || id === 'claude-cli';
}

/** Pin the result of setup, rather than resolving an older npm shim on PATH. */
export function nativeCliPath(id: NativeCliId, platform = process.platform): string {
  if (id === 'codex-cli' && platform === 'win32') {
    if (!process.env.LOCALAPPDATA) throw new Error('The Windows application data folder is unavailable.');
    return path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  }
  return path.join(os.homedir(), '.local', 'bin', (id === 'codex-cli' ? 'codex' : 'claude') + (platform === 'win32' ? '.exe' : ''));
}

export function nativeInstaller(id: NativeCliId, platform = process.platform) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error('This platform is not supported yet.');
  const windows = platform === 'win32';
  return {
    url: id === 'codex-cli'
      ? `https://chatgpt.com/codex/install.${windows ? 'ps1' : 'sh'}`
      : `https://claude.ai/install.${windows ? 'ps1' : 'sh'}`,
    extension: windows ? 'ps1' : 'sh',
    command: windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : id === 'claude-cli' ? '/bin/bash' : '/bin/sh',
    args: windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'] : [],
  };
}

/** Windows PowerShell must not inherit incompatible PowerShell 7 modules via Node. */
export function nativeInstallerEnv(source: NodeJS.ProcessEnv = process.env, platform = process.platform): NodeJS.ProcessEnv {
  const env = { ...source };
  if (platform === 'win32') {
    // Let powershell.exe rebuild its own defaults. Environment names are case-insensitive.
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  return env;
}

/** Download only vendor-hosted bootstrap scripts, including every redirect. */
export async function downloadInstaller(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  const hosts = new Set(['chatgpt.com', 'releases.openai.com', 'claude.ai', 'downloads.claude.ai']);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) {
      throw new Error('The installer redirected outside the official download service.');
    }
    const response = await fetcher(url, { signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('The installer download returned an empty redirect.');
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`The installer could not be downloaded (${response.status}). Try again.`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1_000_000) throw new Error('The installer download exceeded its size limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const script = Buffer.concat(chunks).toString('utf8');
    if (!script.trim() || /^\s*<!doctype html/i.test(script)) throw new Error('The download service did not return an installer.');
    return script;
  }
  throw new Error('The installer download redirected too many times.');
}

/** Stop only the process tree created for this operation. */
export function stopCliProcess(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { child.kill(); });
    killer.on('exit', code => { if (code !== 0 && child.exitCode === null) child.kill(); });
  } else {
    // A hung process can ignore SIGTERM; cancellation still has to finish.
    const force = () => {
      try { process.kill(-child.pid!, 'SIGKILL'); }
      catch { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    };
    if (child.exitCode !== null || child.signalCode !== null) { force(); return; }
    const timer = setTimeout(force, 2000);
    timer.unref();
    // A shell can exit on SIGTERM while its child ignores it. Kill the remaining
    // group at leader exit, before waiting for inherited stdio handles to close.
    child.once('exit', () => { clearTimeout(timer); force(); });
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
  }
}

export async function installNativeCli(id: NativeCliId, signal: AbortSignal, progress: (message: string) => void): Promise<string> {
  signal.throwIfAborted();
  const name = id === 'codex-cli' ? 'Codex' : 'Claude';
  progress(`Preparing ${name}. Downloading the official installer…`);
  const installer = nativeInstaller(id);
  const executable = nativeCliPath(id);
  const script = await downloadInstaller(installer.url, AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
  signal.throwIfAborted();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nabsun-connect-'));
  const file = path.join(dir, `install.${installer.extension}`);
  try {
    await fs.writeFile(file, script, { mode: 0o600 });
    progress(`Installing ${name}. This may take a few minutes…`);
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(installer.command, [...installer.args, file], {
        windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...nativeInstallerEnv(), CODEX_NON_INTERACTIVE: '1', NO_COLOR: '1', FORCE_COLOR: '0',
          // Ignore inherited installer overrides: setup and selection must agree.
          ...(id === 'codex-cli' ? { CODEX_INSTALL_DIR: path.dirname(executable), CODEX_RELEASE: 'latest' } : {}),
        },
      });
      let tail = '';
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      const collect = (chunk: string) => { tail = (tail + chunk).slice(-3000); };
      child.stdout?.on('data', collect); child.stderr?.on('data', collect);
      const abort = () => stopCliProcess(child);
      signal.addEventListener('abort', abort, { once: true });
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; abort(); }, 10 * 60_000);
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); };
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', code => {
        cleanup();
        if (signal.aborted) reject(signal.reason);
        else if (timedOut) reject(new Error('Setup timed out. Check your connection and try again.'));
        else if (code !== 0) reject(new Error(`${name} setup failed. ${tail.trim().slice(-1000)}`));
        else resolve();
      });
    });
  } finally {
    // Both paths were created by this invocation; no recursive cleanup.
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
  }
  signal.throwIfAborted();
  if (!(await fs.stat(executable).catch(() => null))?.isFile()) throw new Error('The installer did not create its executable. Try Repair / update again.');
  return executable;
}
