import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CliAccountManager, isSignInUrl, type AccountRunEvent } from '../main/integrations/cliAccounts';
import { downloadInstaller, nativeInstaller, nativeInstallerEnv, stopCliProcess } from '../main/integrations/nativeCli';
import { clearBinCache, resolveBin, type Launcher } from '../main/ai/providers/cli';
import { listAgentExtensions } from '../main/integrations/agentExtensions';

async function main() {
  let checks = 0;
  const pass = (name: string) => { checks++; console.log('PASS ' + name); };
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    for (const id of ['codex-cli', 'claude-cli'] as const) {
      const spec = nativeInstaller(id, platform);
      assert.match(spec.url, /^https:\/\/(chatgpt\.com\/codex|claude\.ai)\/install\.(ps1|sh)$/);
      assert(!JSON.stringify(spec).includes('npm'));
    }
    pass(platform + ' uses official native setup without npm');
  }
  const inherited = { PSModulePath: 'PowerShell 7 modules', psmodulepath: 'alternate casing', PATH: 'keep', HTTPS_PROXY: 'keep-proxy' };
  assert.deepEqual(nativeInstallerEnv(inherited, 'win32'), { PATH: 'keep', HTTPS_PROXY: 'keep-proxy' });
  assert.deepEqual(nativeInstallerEnv(inherited, 'linux'), inherited);
  assert.equal(inherited.PSModulePath, 'PowerShell 7 modules');
  pass('installer environment isolates Windows module paths without changing parent or Unix environments');
  const signal = new AbortController().signal;
  const mockFetch = (fn: (url: string) => Response) => (async (url: unknown) => fn(String(url))) as typeof fetch;
  assert.equal(await downloadInstaller('https://claude.ai/install.sh', signal, mockFetch(() => new Response('#!/bin/bash\necho fixture'))), '#!/bin/bash\necho fixture');
  pass('official installer response accepted');
  await assert.rejects(downloadInstaller('https://claude.ai/install.sh', signal, mockFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/setup.sh' } }))), /outside/);
  await assert.rejects(downloadInstaller('https://claude.ai/install.sh', signal, mockFetch(() => new Response('x'.repeat(1_000_001)))), /size limit/);
  await assert.rejects(downloadInstaller('https://claude.ai/install.sh', signal, mockFetch(() => new Response('<!doctype html>'))), /did not return/);
  pass('untrusted redirects, oversized scripts and HTML rejected');
  assert(isSignInUrl('codex-cli', 'https://auth.openai.com/oauth/authorize?state=test'));
  assert(isSignInUrl('claude-cli', 'https://claude.ai/oauth/authorize?state=test'));
  for (const url of ['http://auth.openai.com/login', 'https://auth.openai.com.evil.example/login', 'https://user@auth.openai.com/login', 'file:///tmp/login', 'https://auth.openai.com:8888/login']) assert(!isSignInUrl('codex-cli', url));
  pass('only exact provider HTTPS sign-in origins accepted');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nabsun-connect-test-'));
  if (process.platform === 'win32') {
    const modules = path.join(dir, 'Modules');
    const utility = path.join(modules, 'Microsoft.PowerShell.Utility');
    const manifest = path.join(utility, 'Microsoft.PowerShell.Utility.psd1');
    const payload = path.join(dir, 'hash-fixture.txt');
    await fs.mkdir(utility, { recursive: true });
    // Simulate a newer PowerShell module shadowing the Windows PowerShell cmdlets.
    await fs.writeFile(manifest, "@{ ModuleVersion = '99.0'; PowerShellVersion = '99.0'; FunctionsToExport = @('Get-FileHash') }");
    await fs.writeFile(payload, 'checksum fixture');
    const inheritedEnv = { ...process.env, PSModulePath: modules + path.delimiter + (process.env.PSModulePath ?? '') };
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; (Get-FileHash -LiteralPath $env:NABSUN_HASH_FIXTURE -Algorithm SHA256).Hash"];
    const options = { windowsHide: true, timeout: 30_000, encoding: 'utf8' as const, env: { ...inheritedEnv, NABSUN_HASH_FIXTURE: payload } };
    try {
      assert.throws(() => execFileSync(nativeInstaller('codex-cli').command, args, { ...options, stdio: 'pipe' }));
      const result = execFileSync(nativeInstaller('codex-cli').command, args, { ...options, env: nativeInstallerEnv(options.env) });
      assert.equal(result.trim().toLowerCase(), createHash('sha256').update('checksum fixture').digest('hex'));
      pass('Windows installer can verify checksums despite incompatible inherited modules');
    } finally {
      await fs.unlink(manifest); await fs.unlink(payload);
      await fs.rmdir(utility); await fs.rmdir(modules);
    }
  }
  const fixture = path.join(dir, 'cli.cjs');
  const state = path.join(dir, 'signed-in');
  if (process.platform === 'win32') {
    const before = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
    const nativeDir = path.join(dir, 'Programs', 'OpenAI', 'Codex', 'bin');
    const binary = path.join(nativeDir, 'codex.exe');
    await fs.mkdir(nativeDir, { recursive: true });
    await fs.writeFile(binary, 'resolution fixture');
    try {
      process.env.PATH = ''; process.env.APPDATA = dir; process.env.LOCALAPPDATA = dir;
      clearBinCache();
      assert.equal(resolveBin('codex'), binary);
      pass('native Windows Codex is found without restarting or refreshing PATH');
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      clearBinCache();
      await fs.unlink(binary);
      // Only remove known empty fixture folders; never recurse through a computed path.
      for (let empty = nativeDir; empty !== dir; empty = path.dirname(empty)) await fs.rmdir(empty);
    }
  }
  await fs.writeFile(fixture, `
const fs = require('fs');
const [state, behavior, ...args] = process.argv.slice(2);
const signed = fs.existsSync(state);
if(args.includes('--help')) {
  console.log(behavior==='legacy' ? 'error: unknown command auth' : 'Usage: fixture auth login / app-server');
  process.exit(behavior==='legacy'?2:0);
}
if(args.includes('--version')) { setTimeout(()=>{console.log('fixture 1.2.3');process.exit(0)},150); }
if (args.includes('status')) {
  if(behavior==='statuswait') { fs.writeFileSync(state+'.pid',String(process.pid)); setInterval(()=>{},1000); }
  else {
  console.log(args[0] === 'auth' ? JSON.stringify({loggedIn:signed}) : signed ? 'Logged in using ChatGPT' : 'Not logged in');
  process.exit(signed ? 0 : 1);
  }
}
if(args.includes('logout')) {
  if(behavior==='logoutwait') { fs.writeFileSync(state+'.pid',String(process.pid)); setInterval(()=>{},1000); }
  else if(behavior==='logoutdelay') { setTimeout(()=>{if(fs.existsSync(state))fs.unlinkSync(state);process.exit(0)},250); }
  else { if(signed) fs.unlinkSync(state); process.exit(0); }
}
if(args[0] === 'app-server') {
  fs.writeFileSync(state+'.pid',String(process.pid));
  require('readline').createInterface({input:process.stdin}).on('line', line => {
    const m=JSON.parse(line);
    if(m.id===1) console.log(JSON.stringify({id:1,result:{}}));
    if(m.id===2) {
      if(behavior==='protocollegacy') { console.log(JSON.stringify({id:2,error:{code:-32601,message:'Method not found'}})); return; }
      if(behavior==='malformed') { console.log(JSON.stringify({id:2,result:{authUrl:'https://auth.openai.com/login'}})); return; }
      console.log(JSON.stringify({id:2,result:{type:'chatgpt',loginId:'fixture',authUrl:behavior==='evil'?'https://evil.example/login':'https://auth.openai.com/oauth/authorize?state=fixture'}}));
      if(behavior==='foreign') console.log(JSON.stringify({method:'account/login/completed',params:{loginId:'another-login',success:true}}));
      if(behavior!=='wait' && behavior!=='evil') setTimeout(()=>{
        if(behavior!=='unverified' && behavior!=='fail')fs.writeFileSync(state,'yes');
        console.log(JSON.stringify({method:'account/login/completed',params:{loginId:'fixture',success:behavior!=='fail',error:'Fixture failure'}}));
      },80);
    }
  });
} else if(args.includes('login')) {
  process.stdout.write('Open https://claude.ai/oauth/');
  if(behavior==='interleaved') setTimeout(()=>process.stderr.write('Waiting for browser\\n'),10);
  setTimeout(()=>process.stdout.write('authorize?state=fixture\\n'),30);
  if(behavior==='multiurl') {
    setTimeout(()=>process.stdout.write('https://claude.ai/oauth/authorize?state=second\\n'),40);
    setTimeout(()=>process.stdout.write('Waiting for sign-in\\n'),60);
  }
  if(behavior!=='wait') setTimeout(()=>{if(behavior!=='unverified')fs.writeFileSync(state,'yes');process.exit(behavior==='fail'?1:0)},100);
  else setInterval(()=>{},1000);
}
`);
  const events: AccountRunEvent[] = [];
  let behavior = 'ok', installed = false, installs = 0;
  const launcher = (): Launcher | null => installed ? { command: process.execPath, args: [fixture, state, behavior], runAsNode: true } : null;
  const manager = new CliAccountManager(() => '', event => events.push(event), async (_id, abort, progress) => {
    abort.throwIfAborted(); installs++; progress('Installing fixture'); installed = true;
  }, launcher);
  const reset = async () => { events.length = 0; await fs.unlink(state).catch(() => {}); };
  const waitFor = async (ready: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await ready()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert(await ready(), 'fixture must become ready before timeout');
  };
  const assertStopped = async () => {
    const pid = Number(await fs.readFile(state + '.pid', 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  };
  try {
    assert.equal((await manager.status('codex-cli')).supported, true);
    await manager.login('codex-cli', 'browser');
    assert.equal(installs, 1);
    assert.equal(events.filter(e => e.url).length, 1);
    assert(events.some(e => e.done && e.ok));
    assert.equal((await manager.status('codex-cli')).connected, true);
    pass('missing Codex is installed, app-server login runs, connection verified');
    events.length = 0;
    await manager.login('codex-cli', 'browser');
    assert.equal(installs, 1); assert(!events.some(e => e.url)); assert(events.some(e => e.ok));
    pass('existing authenticated CLI reused without installation or new sign-in');
    await manager.logout('codex-cli'); assert.equal((await manager.status('codex-cli')).connected, false);
    pass('Codex sign-out clears fixture account');
    await reset();
    await manager.login('claude-cli', 'browser');
    assert.deepEqual(events.filter(e => e.url).map(e => e.url), ['https://claude.ai/oauth/authorize?state=fixture']);
    assert(events.some(e => e.done && e.ok));
    assert.equal((await manager.status('claude-cli')).connected, true);
    await manager.logout('claude-cli');
    assert.equal((await manager.status('claude-cli')).connected, false);
    pass('Claude auth commands work and split URL opens once, complete');
    await reset(); behavior = 'multiurl';
    await manager.login('claude-cli', 'browser');
    assert.equal(events.filter(e => e.url).length, 2);
    pass('multiple sign-in URLs are each emitted once even when more output arrives');
    await reset(); behavior = 'interleaved';
    await manager.login('claude-cli', 'browser');
    assert.deepEqual(events.filter(e => e.url).map(e => e.url), ['https://claude.ai/oauth/authorize?state=fixture']);
    pass('stderr progress cannot corrupt a sign-in URL split across stdout chunks');
    for (const id of ['codex-cli', 'claude-cli'] as const) {
      await reset(); behavior = 'unverified';
      await manager.login(id, 'browser');
      assert(events.some(e => e.done && !e.ok && e.error?.includes('verified')));
      assert(!events.some(e => e.ok));
      pass(id + ' cannot report success just because login exited successfully');
    }
    await reset(); behavior = 'evil';
    await manager.login('codex-cli', 'browser');
    assert(!events.some(e => e.url || e.ok)); assert(events.some(e => e.error?.includes('unrecognized')));
    pass('Codex cannot open an untrusted auth URL');
    await reset(); behavior = 'malformed';
    await manager.login('codex-cli', 'browser');
    assert(events.some(e => e.error?.includes('incomplete'))); assert(!events.some(e => e.ok));
    pass('incomplete app-server response fails promptly instead of waiting ten minutes');
    await reset(); behavior = 'foreign';
    await manager.login('codex-cli', 'browser');
    assert(events.some(e => e.ok)); assert(!events.some(e => e.error));
    pass('completion for another login cannot finish this connection');
    await reset(); behavior = 'statuswait';
    await fs.unlink(state + '.pid').catch(() => {});
    const checking = manager.login('codex-cli', 'browser');
    await waitFor(async () => !!(await fs.stat(state + '.pid').catch(() => null)));
    const cancelledAt = Date.now();
    manager.cancel('codex-cli');
    await checking;
    assert(Date.now() - cancelledAt < 5000, 'cancel must not wait for the 15-second status timeout');
    await assertStopped();
    assert.equal(events.filter(e => e.done).length, 1);
    assert(!events.some(e => e.ok));
    pass('cancelling during account status stops the child before completion');
    await reset(); behavior = 'wait';
    const pending = manager.login('codex-cli', 'browser');
    await waitFor(() => events.some(e => e.url));
    await manager.login('codex-cli', 'browser');
    assert.equal(events.filter(e => e.url).length, 1);
    const waitingPid = Number(await fs.readFile(state + '.pid', 'utf8'));
    const closedBeforeRetry = pending.then(() => assert.throws(() => process.kill(waitingPid, 0), { code: 'ESRCH' }));
    manager.cancel('codex-cli');
    behavior = 'ok';
    const retry = manager.login('codex-cli', 'browser');
    await Promise.all([closedBeforeRetry, retry]);
    await assertStopped();
    assert.equal(events.filter(e => e.done && !e.ok).length, 1);
    assert.equal(events.filter(e => e.done && e.ok).length, 1);
    pass('duplicate click ignored; cancel and immediate retry do not corrupt each other');
    await reset();
    const broken = new CliAccountManager(() => '', e => events.push(e), async () => { throw new Error('Download unavailable'); }, () => null);
    await broken.login('claude-cli', 'browser');
    assert(events.some(e => e.error === 'Download unavailable')); assert(!events.some(e => e.ok));
    pass('installer failure reaches UI without a false connected state');
    await reset();
    let releaseInstall!: () => void;
    let installedAfterCancel = false;
    let attempts = 0;
    const cancelling = new CliAccountManager(() => '', e => events.push(e), async (_id, abort) => {
      attempts++;
      if (attempts === 1) await new Promise<void>((_resolve, reject) => {
        releaseInstall = () => reject(new Error('cancelled fixture'));
        abort.addEventListener('abort', () => {}, { once: true });
      });
      else installedAfterCancel = true;
    }, () => installedAfterCancel ? launcher() : null);
    const first = cancelling.login('codex-cli', 'browser');
    await waitFor(() => !!releaseInstall);
    cancelling.cancel('codex-cli');
    const second = cancelling.login('codex-cli', 'browser');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(attempts, 1); assert(!events.some(e => e.done));
    releaseInstall();
    await Promise.all([first, second]);
    assert.equal(attempts, 2); assert(events.some(e => e.ok));
    pass('retry waits for cancelled installer cleanup before starting a new setup');
    await reset();
    let override = '';
    const changedPath = new CliAccountManager(() => override, e => {
      events.push(e);
      if (e.url) override = 'another-cli';
    }, undefined, launcher);
    await changedPath.login('codex-cli', 'browser');
    assert(events.some(e => e.error?.includes('setting changed'))); assert(!events.some(e => e.ok));
    pass('changing the executable during sign-in cannot activate an unverified CLI');
    await fs.unlink(state + '.pid').catch(() => {});
    behavior = 'logoutwait';
    const shuttingDown = new CliAccountManager(() => '', () => {}, undefined, launcher);
    const signingOut = shuttingDown.logout('codex-cli');
    await waitFor(async () => !!(await fs.stat(state + '.pid').catch(() => null)));
    shuttingDown.cancelAll();
    assert.equal((await signingOut).ok, false);
    await assertStopped();
    pass('app shutdown stops a pending sign-out process');
    behavior = 'ok';
    const provider = { binaryPath: fixture, launcher: launcher() };
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 20);
    const listing = listAgentExtensions(
      { provider: 'codex-cli', baseUrls: { ollama: '' } } as Parameters<typeof listAgentExtensions>[0],
      new Map([['codex-cli', provider]]) as unknown as Parameters<typeof listAgentExtensions>[1],
      { has: () => false } as unknown as Parameters<typeof listAgentExtensions>[2],
    );
    const catalogue = await listing;
    clearTimeout(timer);
    assert(ticked); assert.equal(catalogue.find(a => a.id === 'codex-cli')?.detail, 'Version 1.2.3');
    pass('version discovery yields to the event loop and preserves catalogue details');
    await reset();
    let selected = '';
    let repairs = 0;
    const native = path.join(dir, 'updated-native');
    const repairManager = new CliAccountManager(() => selected, event => events.push(event), async () => { repairs++; return native; },
      (_name, override) => ({ command: process.execPath, args: [fixture, state, override === native ? 'ok' : 'legacy'], runAsNode: true }),
      (_id, executable) => { selected = executable; });
    await repairManager.login('claude-cli', 'browser');
    assert.equal(repairs, 1); assert.equal(selected, native); assert(events.some(e => e.ok));
    pass('old Claude account commands trigger native repair and persist the new executable');
    await reset(); selected = ''; let protocolRepairs = 0;
    const oldProtocol = new CliAccountManager(() => selected, e => events.push(e), async () => { protocolRepairs++; return native; },
      (_name, override) => ({ command: process.execPath, args: [fixture, state, override === native ? 'ok' : 'protocollegacy'], runAsNode: true }),
      (_id, executable) => { selected = executable; });
    await oldProtocol.login('codex-cli', 'browser');
    assert.equal(protocolRepairs, 1); assert(events.some(e => e.ok));
    pass('an older Codex account protocol upgrades once and retries sign-in');
    events.length = 0;
    await repairManager.login('codex-cli', 'repair');
    assert.equal(repairs, 2); assert(events.some(e => e.ok)); assert(!events.some(e => e.url));
    pass('explicit repair updates an already connected CLI without signing out');
    await reset();
    selected = 'custom-before-install';
    const changedSetup = new CliAccountManager(() => selected, e => events.push(e), async () => { selected = 'custom-edited-during-install'; return native; },
      () => launcher(), () => { throw new Error('must not overwrite a newer setting'); });
    await changedSetup.login('codex-cli', 'repair');
    assert(events.some(e => e.error?.includes('setting changed during setup'))); assert(!events.some(e => e.ok));
    assert.equal(selected, 'custom-edited-during-install');
    pass('repair cannot overwrite an executable setting changed during download');
    events.length = 0;
    let failedRepairSelected = false;
    const failedRepair = new CliAccountManager(() => '', e => events.push(e), async () => { throw new Error('fixture download failed'); },
      launcher, () => { failedRepairSelected = true; });
    await failedRepair.login('codex-cli', 'repair');
    assert(!failedRepairSelected); assert(!events.some(e => e.ok));
    pass('failed repair preserves the previous executable and never activates it');
    await fs.writeFile(state, 'yes');
    events.length = 0; behavior = 'logoutdelay';
    const signingOutAndIn = manager.logout('codex-cli');
    const signingBackIn = manager.login('codex-cli', 'browser');
    await Promise.all([signingOutAndIn, signingBackIn]);
    assert(events.some(e => e.ok)); assert.equal((await manager.status('codex-cli')).connected, true);
    pass('sign-in waits for an overlapping sign-out instead of losing its credentials');
    behavior = 'ok';

    const tree = path.join(dir, 'tree.cjs');
    const leafFile = path.join(dir, 'leaf.pid');
    await fs.writeFile(tree, `
const fs=require('fs'),{spawn}=require('child_process');
const [mode,file,ignore]=process.argv.slice(2);
if(mode==='leaf') { fs.writeFileSync(file,String(process.pid)); process.on('SIGTERM',()=>{}); }
else { if(ignore==='yes')process.on('SIGTERM',()=>{}); spawn(process.execPath,[__filename,'leaf',file],{stdio:'ignore'}); }
setInterval(()=>{},1000);
`);
    try {
      for (const ignore of ['yes', 'no']) {
        await fs.unlink(leafFile).catch(() => {});
        const root = spawn(process.execPath, [tree, 'parent', leafFile, ignore], {
          detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore',
        });
        const closed = new Promise<void>((resolve, reject) => { root.once('close', () => resolve()); root.once('error', reject); });
        try {
          await waitFor(async () => !!(await fs.stat(leafFile).catch(() => null)));
          const leaf = Number(await fs.readFile(leafFile, 'utf8'));
          stopCliProcess(root);
          await closed;
          await waitFor(async () => {
            try { process.kill(leaf, 0); } catch { return true; }
            // Linux may retain a killed orphan as a zombie until init reaps it.
            if (process.platform === 'linux') return /\) Z /.test(await fs.readFile(`/proc/${leaf}/stat`, 'utf8').catch(() => ') Z '));
            return false;
          });
          pass(`cancellation kills descendants when the parent ${ignore === 'yes' ? 'ignores termination' : 'exits first'}`);
        } finally { stopCliProcess(root); }
      }
    } finally { await fs.unlink(tree); await fs.unlink(leafFile).catch(() => {}); }
  } finally {
    manager.cancelAll();
    await fs.unlink(fixture); await fs.unlink(state).catch(() => {}); await fs.unlink(state + '.pid').catch(() => {}); await fs.rmdir(dir);
  }
  console.log('Connection checks passed: ' + checks);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
