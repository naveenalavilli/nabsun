import assert from 'node:assert/strict';
import { getEventListeners, EventEmitter } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, dialog, shell as osShell, type Session } from 'electron';
import { requestExternalLink } from '../main/externalLinks';
import { DownloadManager } from '../main/downloads';
import { fetchPublicUrl, isPrivateAddress } from '../main/ai/tools/workspace';
import { CH } from '../shared/ipc';
import { ApprovalManager } from '../main/ai/approvals';
import { QuestionManager } from '../main/ai/questions';
import { SessionStore } from '../main/ai/sessions';
import type { Tool } from '../main/ai/tools/types';
import { SettingsStore } from '../main/store';
import { lockUiNavigation, uiIpc } from '../main/uiSecurity';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-review-'));
app.setPath('userData', tmp);
let passed = 0;
function check(name: string, test: () => void) {
  test();
  passed++;
  console.log(`PASS  ${name}`);
}

async function main() {
  await app.whenReady();
  const settings = new SettingsStore();
  const approvals = new ApprovalManager(settings);
  const questions = new QuestionManager();
  const tool = { name: 'review_write', risk: 'write' } as Tool;
  const cancelled = new AbortController();
  cancelled.abort();
  let prompts = 0;
  approvals.setEmitter(() => { prompts++; });
  const early = await Promise.race([
    approvals.request(tool, {}, cancelled.signal),
    new Promise<string>((r) => setTimeout(() => r('hung'), 100)),
  ]);
  check('already-cancelled approvals resolve without a prompt', () => {
    assert.equal(early, false); assert.equal(prompts, 0);
  });
  settings.set({ alwaysAllowTools: [tool.name] });
  check('cancellation overrides always-allow', () => assert.equal(prompts, 0));
  assert.equal(await approvals.request(tool, {}, cancelled.signal), false);
  settings.set({ alwaysAllowTools: [] });

  const signal = new AbortController().signal;
  approvals.setEmitter((r) => approvals.resolve(r.id, 'allow'));
  questions.setEmitter((r) => questions.answer(r.id, 'answer'));
  for (let i = 0; i < 25; i++) {
    assert.equal(await approvals.request(tool, {}, signal), true);
    assert.equal(await questions.ask('chat', 'Question?', [], signal), 'answer');
  }
  check('answered prompts release their abort listeners', () =>
    assert.equal(getEventListeners(signal, 'abort').length, 0));
  approvals.setEmitter(() => {});
  questions.setEmitter(() => {});
  const waiting = approvals.request(tool, {}, signal);
  const asking = questions.ask('chat', 'Question?', [], signal);
  approvals.denyAll(); questions.cancelAll();
  assert.equal(await waiting, false); assert.equal(await asking, null);
  check('closing pending prompts releases listeners too', () =>
    assert.equal(getEventListeners(signal, 'abort').length, 0));
  approvals.setEmitter(() => { throw new Error('UI closed'); });
  assert.equal(await approvals.request(tool, {}, signal), false);
  check('a failed prompt delivery denies and cleans up', () =>
    assert.equal(getEventListeners(signal, 'abort').length, 0));

  const store = new SessionStore(tmp);
  const first = store.create();
  const realWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }) as typeof fs.writeFileSync;
    store.appendBestEffort(first.id, { id: 'question', role: 'user', blocks: [{ type: 'text', text: 'Keep my question' }], createdAt: Date.now() });
    check('a failed initial write remains visible in the session list', () =>
      assert.equal(store.list()[0]?.title, 'Keep my question'));
  } finally { fs.writeFileSync = realWrite; }
  store.upsert(first.id, { id: 'answer', role: 'assistant', blocks: [{ type: 'text', text: 'Answer' }], createdAt: Date.now() });
  check('disk recovery preserves the question and answer exactly once', () =>
    assert.deepEqual(new SessionStore(tmp).load(first.id)?.messages.map((m) => m.id), ['question', 'answer']));
  const before = fs.readdirSync(path.join(tmp, 'sessions')).length;
  store.append('new-session', { id: 'new', role: 'user', blocks: [], createdAt: Date.now() });
  check('appending an unknown session creates no orphan chat file', () =>
    assert.equal(fs.readdirSync(path.join(tmp, 'sessions')).length, before + 1));
  try {
    fs.writeFileSync = (() => { throw new Error('read only'); }) as typeof fs.writeFileSync;
    store.appendBestEffort('unsaved-session', { id: 'lost', role: 'user', blocks: [], createdAt: Date.now() });
  } finally { fs.writeFileSync = realWrite; }
  store.remove('unsaved-session');
  check('deleting an unsaved session removes its in-memory copy', () => assert.equal(store.load('unsaved-session'), null));

  app.setPath('downloads', tmp);
  const downloadSession = new EventEmitter();
  const downloads = new DownloadManager();
  downloads.attach(downloadSession as unknown as Session);
  const savedPaths: string[] = [];
  const item = () => Object.assign(new EventEmitter(), {
    getFilename: () => 'simultaneous.txt', getURL: () => 'https://example.com/file', getTotalBytes: () => 10,
    setSavePath: (savePath: string) => savedPaths.push(savePath),
  });
  downloadSession.emit('will-download', {}, item());
  downloadSession.emit('will-download', {}, item());
  check('simultaneous downloads reserve different paths before any file exists', () => {
    assert.equal(path.basename(savedPaths[0]), 'simultaneous.txt');
    assert.equal(path.basename(savedPaths[1]), 'simultaneous (2).txt');
    assert.equal(fs.existsSync(savedPaths[0]), false);
  });

  for (const address of ['0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:192.168.1.2', 'ff02::1']) {
    check(`fetch blocks normalized private address ${address}`, () => assert.equal(isPrivateAddress(address), true));
  }
  const request = http.request;
  let resolutions = 0;
  let socketLookups = 0;
  try {
    http.request = ((url: URL, options: http.RequestOptions) => {
      assert.equal(url.hostname, 'rebind.example');
      assert.equal(options.agent, false);
      const lookup = options.lookup as Function;
      for (const all of [false, true]) lookup(url.hostname, { all }, (error: Error | null, result: unknown, family?: number) => {
        assert.equal(error, null);
        assert.deepEqual(result, all ? [{ address: '93.184.216.34', family: 4 }] : '93.184.216.34');
        if (!all) assert.equal(family, 4);
        socketLookups++;
      });
      throw new Error('socket intercepted');
    }) as typeof http.request;
    await assert.rejects(fetchPublicUrl('http://rebind.example/', new AbortController().signal, async () => {
      resolutions++;
      return resolutions === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
    }), /socket intercepted/);
    check('socket lookup pins the checked address instead of resolving again', () => {
      assert.equal(resolutions, 1); assert.equal(socketLookups, 2);
    });
  } finally { http.request = request; }
  const slowDns = new AbortController();
  const pendingFetch = fetchPublicUrl('http://slow.example/', slowDns.signal, () => new Promise(() => {}));
  slowDns.abort(new Error('cancelled DNS'));
  await assert.rejects(pendingFetch, /cancelled DNS/);
  check('fetch cancellation includes a pending DNS lookup', () => assert.ok(true));

  const file = path.join(tmp, 'ui.html');
  fs.writeFileSync(file, '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'"><title>Trusted fixture</title><p>UI fixture</p>');
  const windows: BrowserWindow[] = [];
  const make = (preload: string) => {
    const w = new BrowserWindow({ show: false, webPreferences: {
      preload: path.join(__dirname, '..', 'preload', preload), sandbox: true, contextIsolation: true,
    } });
    windows.push(w); return w;
  };
  const shell = make('shell.js');
  const rogue = make('shell.js');
  const overlay = make('overlay.js');
  const guarded = uiIpc([
    { contents: shell.webContents, url: pathToFileURL(file).href },
    { contents: overlay.webContents, url: pathToFileURL(file).href, channels: new Set([CH.omniboxSuggest]) },
  ]);
  guarded.handle(CH.settingsGet, () => 'trusted-result');
  guarded.handle(CH.omniboxSuggest, () => 'suggestions');
  let sends = 0;
  guarded.on(CH.winMinimize, () => { sends++; });
  try {
    await Promise.all(windows.map((w) => w.loadFile(file)));
    assert.equal(await shell.webContents.executeJavaScript('window.nabsun.settings.get()'), 'trusted-result');
    check('trusted shell can invoke IPC', () => assert.ok(true));
    const blocked = await rogue.webContents.executeJavaScript('window.nabsun.settings.get().then(() => false, () => true)');
    check('another renderer cannot invoke privileged IPC even from the same file', () => assert.equal(blocked, true));
    await rogue.webContents.executeJavaScript('window.nabsun.window.minimize(); window.nabsun.settings.get().catch(() => null)');
    check('untrusted fire-and-forget IPC is ignored', () => assert.equal(sends, 0));
    await shell.webContents.executeJavaScript('window.nabsun.window.minimize(); window.nabsun.settings.get()');
    check('trusted fire-and-forget IPC works', () => assert.equal(sends, 1));
    assert.equal(await overlay.webContents.executeJavaScript('window.overlay.suggest("test")'), 'suggestions');
    check('sandboxed overlay retains its permitted IPC', () => assert.ok(true));
    lockUiNavigation(shell.webContents);
    await shell.webContents.executeJavaScript('location.href = "https://example.invalid/"; true');
    await new Promise((r) => setTimeout(r, 150));
    check('UI navigation cannot carry the preload to a website', () => assert.equal(fileURLToPath(shell.webContents.getURL()), file));
    // Main-process loads bypass will-navigate; the IPC document check must
    // still reject this same webContents after its document changes.
    await shell.loadURL('data:text/html,<title>Untrusted</title>');
    const moved = await shell.webContents.executeJavaScript('window.nabsun.settings.get().then(() => false, () => true)');
    check('a trusted webContents loses access after changing documents', () => assert.equal(moved, true));
    const showMessageBox = dialog.showMessageBox;
    const openExternal = osShell.openExternal;
    let choice = 0;
    let prompts = 0;
    const opened: string[] = [];
    try {
      dialog.showMessageBox = (async () => { prompts++; return { response: choice, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
      osShell.openExternal = async (url) => { opened.push(url); };
      await requestExternalLink(rogue, rogue.webContents, 'mailto:test@example.com');
      check('denying an external link never launches an app', () => assert.deepEqual(opened, []));
      choice = 1;
      await requestExternalLink(rogue, rogue.webContents, 'mailto:test@example.com');
      check('an approved external link opens only its requested URL', () => assert.deepEqual(opened, ['mailto:test@example.com']));
      await requestExternalLink(rogue, rogue.webContents, 'javascript:alert(1)');
      await requestExternalLink(rogue, rogue.webContents, 'file:///C:/Windows/System32/cmd.exe');
      check('script and file URLs cannot use the external launcher', () => { assert.equal(prompts, 2); assert.equal(opened.length, 1); });
    } finally { dialog.showMessageBox = showMessageBox; osShell.openExternal = openExternal; }
  } finally {
    ipcMain.removeHandler(CH.settingsGet); ipcMain.removeHandler(CH.omniboxSuggest);
    ipcMain.removeAllListeners(CH.winMinimize);
    for (const w of windows) if (!w.isDestroyed()) w.destroy();
    settings.flush();
  }
  console.log(`All ${passed} review regression checks passed`);
}

void main().then(() => app.exit(0), (err) => { console.error(err); app.exit(1); });
