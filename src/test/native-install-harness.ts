/** Live native setup test. Installs official CLIs; never signs in or signs out. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { installNativeCli, nativeCliPath, stopCliProcess } from '../main/integrations/nativeCli';

const run = promisify(execFile);
async function codexProtocol(executable: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['app-server'], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let verified = false;
    let failure: Error | undefined;
    const timeout = setTimeout(() => { failure = new Error('Codex initialization timed out'); stopCliProcess(child); }, 30_000);
    child.stderr.resume();
    child.stdin.on('error', error => { failure = error; stopCliProcess(child); });
    child.on('error', error => { failure = error; });
    child.on('close', () => {
      clearTimeout(timeout);
      if (failure) reject(failure); else if (verified) resolve(); else reject(new Error('Codex protocol exited before verification'));
    });
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    readline.createInterface({ input: child.stdout }).on('line', line => {
      if (verified || failure) return;
      try {
        const message = JSON.parse(line);
        if (message.error) throw new Error('Codex rejected the account protocol request');
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          // Read-only. Never print the account payload, refresh tokens, or start OAuth.
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        } else if (message.id === 2) {
          assert(message.result && typeof message.result === 'object');
          assert('account' in message.result);
          verified = true;
          stopCliProcess(child);
        }
      } catch (error) { failure = error instanceof Error ? error : new Error('Invalid protocol response'); stopCliProcess(child); }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'nabsun_install_test', version: '1.0.0' } } });
  });
}

async function main() {
  if (!process.argv.includes('--install')) throw new Error('Pass --install to run official native installers on this machine.');
  for (const id of ['codex-cli', 'claude-cli'] as const) {
    console.log(`Installing ${id} at ${nativeCliPath(id)}`);
    const executable = await installNativeCli(id, AbortSignal.timeout(12 * 60_000), message => console.log(message));
    assert.equal(executable, nativeCliPath(id));
    const options = { windowsHide: true, timeout: 30_000, maxBuffer: 128_000, encoding: 'utf8' as const };
    const version = await run(executable, ['--version'], options);
    assert.match(version.stdout + version.stderr, /\d+\.\d+\.\d+/);
    console.log(`PASS ${id}: official installer produced a working native executable (${version.stdout.trim()})`);
    await run(executable, id === 'codex-cli' ? ['app-server', '--help'] : ['auth', 'login', '--help'], options);
    if (id === 'codex-cli') {
      await codexProtocol(executable);
      console.log('PASS Codex: real app-server initialization and read-only account protocol');
    } else {
      const status = await run(executable, ['auth', 'status'], options).catch(error => {
        if (error.code !== 1) throw error;
        return { stdout: error.stdout as string, stderr: error.stderr as string };
      });
      assert.equal(typeof JSON.parse(status.stdout).loggedIn, 'boolean');
      console.log('PASS Claude: real browser-login command and structured account status');
    }
  }
  console.log('Live native installation checks passed. OAuth consent was not requested.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
