import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { launcherEnv, type Launcher } from '../ai/providers/cli';
import { stopCliProcess } from './nativeCli';
import os from 'node:os';

export class UnsupportedCodexLogin extends Error {}

/** Official app-server login: the host opens authUrl, with no external browser launch. */
export function loginCodex(launcher: Launcher, signal: AbortSignal, onUrl: (url: string) => void): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(launcher.command, [...launcher.args, 'app-server'], {
      cwd: os.tmpdir(), windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, ...launcherEnv(launcher) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let finished = false;
    let closed = false;
    let failure: Error | undefined;
    let loginId: string | undefined;
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      failure = error;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      // Keep the operation pending until the callback server actually exits.
      if (!closed) void stopCliProcess(child);
      else if (failure) reject(failure); else resolve();
    };
    const abort = () => finish(new Error('Connection cancelled.'));
    const timeout = setTimeout(() => finish(new Error('Sign-in timed out. Try connecting again.')), 10 * 60_000);
    signal.addEventListener('abort', abort, { once: true });
    const send = (message: unknown) => child.stdin?.write(JSON.stringify(message) + '\n');
    child.stdin?.on('error', error => finish(error));
    child.on('error', error => finish(error));
    child.on('close', () => {
      closed = true;
      if (!finished) finish(new Error('Codex closed before sign-in completed. Try again or choose Repair / update.'));
      else if (failure) reject(failure); else resolve();
    });
    child.stderr?.resume(); // Never expose credential-bearing protocol output to the UI.
    child.stdout?.on('data', (chunk: Buffer) => {
      if (finished) return;
      buffer += decoder.write(chunk);
      if (buffer.length > 1_000_000) { finish(new Error('Codex returned an oversized sign-in message.')); return; }
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (finished || !line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.error) {
            finish(message.error.code === -32601
              ? new UnsupportedCodexLogin('This Codex version does not support browser sign-in.')
              : new Error(message.error.message || 'Codex sign-in failed.'));
            return;
          }
          if (message.id === 1) {
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'account/login/start', params: { type: 'chatgpt' } });
          } else if (message.id === 2) {
            if (typeof message.result?.authUrl !== 'string' || typeof message.result?.loginId !== 'string' || !message.result.loginId) {
              finish(new Error('Codex returned an incomplete sign-in response. Choose Repair / update and try again.'));
              return;
            }
            loginId = message.result.loginId;
            onUrl(message.result.authUrl);
          } else if (message.method === 'account/login/completed' && loginId && message.params?.loginId === loginId) {
            finish(message.params?.success === true ? undefined : new Error(message.params?.error || 'Sign-in was not completed.'));
          }
        } catch (error) { finish(error instanceof Error ? error : new Error('Invalid Codex sign-in response.')); }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'nabsun', title: 'Nabsun', version: '0.1.6' } } });
  });
}
