const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const assert = require('node:assert/strict');

async function main() {
  const mainBundle = await build({ entryPoints: ['src/main/updates.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' });
  const mod = { exports: {} };
  new Function('module', 'exports', mainBundle.outputFiles[0].text)(mod, mod.exports);
  const { UpdateChecker, isNewerRelease } = mod.exports;
  assert.equal(isNewerRelease('v0.1.10', '0.1.9'), true);
  assert.equal(isNewerRelease('v1.0.0', '0.9.99'), true);
  assert.equal(isNewerRelease('v0.1.8', '0.1.8'), false);
  assert.equal(isNewerRelease('v0.1.7', '0.1.8'), false);
  assert.equal(isNewerRelease('v0.1.8', '0.1.8-beta.1'), true);
  assert.equal(isNewerRelease('v0.1.8+build.1', '0.1.8'), false);
  assert.equal(isNewerRelease('v0.1.8', '0.1.8+build-test'), false);
  for (const tag of ['v0.2.0-beta.1', 'bad', 'v01.2.3', 'v99999999999999999999.0.0']) {
    assert.throws(() => isNewerRelease(tag, '0.1.8'));
  }
  const release = { tag_name: 'v0.2.0', draft: false, prerelease: false };
  let calls = 0, now = 0;
  const checker = new UpdateChecker('0.1.8', async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.github.com/repos/naveenalavilli/nabsun/releases/latest');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => release };
  }, () => now);
  const [first, second] = await Promise.all([checker.check(), checker.check()]);
  assert.equal(first.state, 'available'); assert.deepEqual(first, second); assert.equal(calls, 1);
  await checker.check(); assert.equal(calls, 1);
  await checker.check(true); assert.equal(calls, 1);
  now = 30001; await checker.check(true); assert.equal(calls, 2);
  now = 3600001; await checker.check(); assert.equal(calls, 2);
  now = 3630002; await checker.check(); assert.equal(calls, 3);
  for (const payload of [{ ...release, draft: true }, { ...release, prerelease: true }, {}, null, { ...release, tag_name: '<bad>' }]) {
    assert.equal((await new UpdateChecker('0.1.8', async () => ({ ok: true, json: async () => payload })).check()).state, 'error');
  }
  for (const request of [async () => { throw Error('offline'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => { throw Error('bad JSON'); } })]) {
    assert.equal((await new UpdateChecker('0.1.8', request).check()).state, 'error');
  }
  now = 0; let offline = true;
  const retry = new UpdateChecker('0.1.8', async () => {
    if (offline) throw Error('offline');
    return { ok: true, json: async () => release };
  }, () => now);
  assert.equal((await retry.check()).state, 'error');
  offline = false; now = 30001; assert.equal((await retry.check()).state, 'available');
  const timeout = new UpdateChecker('0.1.8', async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), Date.now, 20);
  assert.equal((await timeout.check()).state, 'error');
  console.log('PASS stable versions, validation, coalescing, cache, failures, retry and timeout');

  const ui = await build({ entryPoints: ['src/renderer/shell/updates.ts'], bundle: true, write: false, format: 'iife', globalName: 'Updates' });
  const settingsUi = await build({ entryPoints: ['src/renderer/shell/settings.ts'], bundle: true, write: false, format: 'iife', globalName: 'SettingsUi' });
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadURL('data:text/html,<button id="update-btn" hidden>Update available</button><button id="settings-btn">Settings</button><main></main>');
    const results = await win.webContents.executeJavaScript(`(async () => {
      ${ui.outputFiles[0].text}
      const checks = [], check = (name, ok) => { if (!ok) throw Error(name); checks.push(name); };
      const tick = () => new Promise(r => setTimeout(r, 0));
      let reply = { state: 'current', currentVersion: '0.1.8' }, opened = 0, failOpen = false, settingsOpened = false;
      let manualCheck = false;
      window.nabsun = { updates: { check: async manual => { manualCheck = manual; return reply; }, open: async () => { if (failOpen) throw Error('offline'); opened++; } } };
      document.querySelector('#settings-btn').onclick = () => { settingsOpened = true; };
      document.querySelector('main').append(Updates.updatesSection());
      Updates.startUpdateChecks(); await tick();
      const text = () => document.querySelector('[data-update-status]').textContent;
      check('current version is visible, notification hidden', text().includes('0.1.8') && text().includes('up to date') && document.querySelector('#update-btn').hidden);
      reply = { state: 'available', currentVersion: '0.1.8', latestVersion: '0.2.0' };
      document.querySelector('[data-update-check]').click(); await tick();
      check('manual check requests fresh release metadata', manualCheck === true);
      check('manual check shows toolbar notification and download action', !document.querySelector('#update-btn').hidden && !document.querySelector('[data-update-open]').hidden && text().includes('0.2.0'));
      document.querySelector('#update-btn').click(); await tick();
      document.querySelector('[data-update-open]').click(); await tick();
      check('both actions open the release page', opened === 2);
      reply = { state: 'error', currentVersion: '0.1.8' };
      await Updates.checkForUpdates();
      check('failure allows retry and preserves known update', text().includes('Could not check') && !document.querySelector('[data-update-check]').disabled && !document.querySelector('#update-btn').hidden);
      failOpen = true; document.querySelector('#update-btn').click(); await tick();
      check('download open failure is visible', settingsOpened && text().includes('Could not open'));
      reply = { state: 'current', currentVersion: '0.2.0' };
      await Updates.checkForUpdates();
      check('successful retry clears error and stale notification', text().includes('up to date') && document.querySelector('#update-btn').hidden);
      document.querySelector('main').replaceChildren(Updates.updatesSection()); await tick();
      check('reopening settings retains update state', text().includes('0.2.0'));
      return checks;
    })()`);
    results.forEach(name => console.log('PASS ' + name));
    await win.webContents.executeJavaScript(`(async () => {
      ${settingsUi.outputFiles[0].text}
      const root = document.createElement('div'); root.id = 'settings-body'; document.body.append(root);
      window.nabsun.settings = { set: async () => { throw Error('Disk write failed'); } };
      const view = new SettingsUi.SettingsView(() => { throw Error('Failed save notified success'); });
      view.settings = { theme: 'light', appearance: 'classic' };
      const pending = [];
      view.integrationsSection = () => new Promise(resolve => pending.push(resolve));
      view.advancedSection = async () => { const n = document.createElement('div'); n.className = 'test-advanced'; return n; };
      for (const method of ['modelSection', 'behaviourSection', 'browsingSection']) view[method] = () => document.createElement('div');
      view.paint();
      await view.patch({ theme: 'dark' });
      for (const resolve of pending.reverse()) { const n = document.createElement('div'); n.className = 'test-integration'; resolve(n); }
      await new Promise(r => setTimeout(r, 0));
      if (root.querySelectorAll('.test-integration').length !== 1 || root.querySelectorAll('.test-advanced').length !== 1) throw Error('Stale settings sections appended');
      if (!root.querySelector('[role=alert]')?.textContent.includes('Could not save') || view.settings.theme !== 'light') throw Error('Settings save failure was hidden');
    })()`);
    console.log('PASS failed settings save preserves prior value and ignores stale asynchronous sections');
  } finally { win.destroy(); }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
