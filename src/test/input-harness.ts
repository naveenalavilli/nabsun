import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { app, BaseWindow, ipcMain } from 'electron';
import { Agent } from '../main/ai/agent';
import { ApprovalManager } from '../main/ai/approvals';
import { SessionStore } from '../main/ai/sessions';
import { SettingsStore } from '../main/store';
import { HistoryStore } from '../main/history';
import { TabManager, delay } from '../main/tabs';
import { browserTools } from '../main/ai/tools/browser';
import type { PageSnapshot } from '../shared/types';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-input-'));
app.setPath('userData', profile);
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
async function main() {
  await app.whenReady();
  ipcMain.handle('pw:for-origin', () => []);
  const server = http.createServer((_req, res) => {
    res.setHeader('Connection', 'close');
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<!doctype html><style>body{padding:30px}button,input,select{padding:12px;margin:12px}.cover{position:fixed;inset:0;background:white;z-index:10}</style><form><label>Name<input aria-label="Name" value="Old name"></label></form><label>Password<input type="password" aria-label="Password"></label><label>Code<input autocomplete="one-time-code" aria-label="Code"></label><button>Commit</button><input type="checkbox" aria-label="Enabled"><select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option><option value="green">Green</option></select><script>window.submitted=false;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.submitted=true};window.events=[];for(const type of ['click','dblclick','contextmenu','keydown','input','change'])document.addEventListener(type,e=>{window.events.push({type,trusted:e.isTrusted,name:e.target.getAttribute('aria-label')||e.target.textContent,value:e.target.value});if(type==='contextmenu')e.preventDefault()});</script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const settings = new SettingsStore();
  settings.save({ autoApprove: { safe: true, write: true, dangerous: false } });
  const history = new HistoryStore(),
    approvals = new ApprovalManager(settings),
    window = new BaseWindow({ width: 1100, height: 800, show: false });
  window.showInactive();
  const tabs = new TabManager({
    window,
    history,
    partition: 'input-test',
    preloadPath: path.join(__dirname, '../preload/page.js'),
    homepage: 'about:blank',
    onFindResult: () => {},
  });
  tabs.setBounds({ x: 0, y: 0, width: 1100, height: 800 });
  const agent = new Agent({
    settings,
    history,
    tabs,
    approvals,
    sessions: new SessionStore(profile),
    providers: new Map(),
    getTools: () => browserTools(),
    userDataPath: profile,
    emit: () => {},
  });
  try {
    const tab = tabs.create(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    await tabs.waitForSettled(tab, 5000);
    await delay(100);
    const refs = async () => {
      const snapshot = await tabs.callBridge<PageSnapshot>(
        tab,
        'window.__nabsunAgent.snapshot({})',
      );
      return (name: string) => {
        const item = snapshot.elements.find((item) => item.name === name);
        assert.ok(item, name);
        return item.ref;
      };
    };
    let ref = await refs();
    const run = (name: string, input: Record<string, unknown>) =>
      agent.runToolForExternalAgent(
        name,
        { tabId: tab.id, ...input },
        'input-fixture',
      );
    await run('browser_type', { ref: ref('Name'), text: 'Nabsun \u2600 test' });
    assert.equal(
      await tab.wc.executeJavaScript('document.querySelector("input").value'),
      'Nabsun \u2600 test',
    );
    assert.equal(
      await tab.wc.executeJavaScript(
        'window.events.filter(e=>e.name==="Name"&&(e.type==="keydown"||e.type==="input")).every(e=>e.trusted)',
      ),
      true,
    );
    console.log(
      'PASS trusted keyboard/input events replace existing text, including Unicode',
    );
    ref = await refs();
    await assert.rejects(
      run('browser_type', { ref: ref('Name'), text: 'one\ntwo' }),
      /requested value/,
    );
    assert.equal(await tab.wc.executeJavaScript('window.submitted'), false);
    console.log(
      'PASS a newline in data cannot implicitly submit a single-line form',
    );
    ref = await refs();
    await run('browser_click', { ref: ref('Commit'), clickCount: 2 });
    await run('browser_click', { ref: ref('Commit'), button: 'right' });
    assert.equal(
      await tab.wc.executeJavaScript(
        'window.events.some(e=>e.type==="dblclick"&&e.trusted)&&window.events.some(e=>e.type==="contextmenu"&&e.trusted)',
      ),
      true,
    );
    console.log('PASS trusted double-click and right-click');
    for (const name of ['Password', 'Code'])
      await assert.rejects(
        run('browser_type', { ref: ref(name), text: 'not-allowed' }),
        /does not enter credentials/,
      );
    for (const name of ['Password', 'Code']) {
      await tab.wc.executeJavaScript(
        `document.querySelector('[aria-label="${name}"]').focus()`,
      );
      for (const key of ['x', 'Backspace'])
        await assert.rejects(
          run('browser_press_key', { key }),
          /password|one-time-code/,
        );
      assert.equal(
        await tab.wc.executeJavaScript(
          `document.querySelector('[aria-label="${name}"]').value`,
        ),
        '',
      );
    }
    await tab.wc.executeJavaScript(
      'const upload=document.createElement("input");upload.type="file";upload.setAttribute("aria-label","Upload fixture");document.body.append(upload)',
    );
    ref = await refs();
    await assert.rejects(
      run('browser_click', { ref: ref('Upload fixture') }),
      /Only you can choose files/,
    );
    console.log('PASS password and one-time-code fields refuse trusted typing');
    await tab.wc.executeJavaScript(
      'const cover=document.createElement("div");cover.className="cover";document.body.append(cover);window.events=[]',
    );
    await assert.rejects(
      run('browser_click', { ref: ref('Commit') }),
      /covered/,
    );
    assert.equal(await tab.wc.executeJavaScript('window.events.length'), 0);
    await tab.wc.executeJavaScript('document.querySelector(".cover").remove()');
    console.log(
      'PASS covered target refuses input without emitting pointer events',
    );
    ref = await refs();
    await run('browser_set_checked', { ref: ref('Enabled'), checked: true });
    await run('browser_set_checked', { ref: ref('Enabled'), checked: true });
    assert.equal(
      await tab.wc.executeJavaScript(
        'document.querySelector("[type=checkbox]").checked',
      ),
      true,
    );
    await run('browser_select', { ref: ref('Color'), values: ['Green'] });
    assert.equal(
      await tab.wc.executeJavaScript('document.querySelector("select").value'),
      'green',
    );
    console.log(
      'PASS trusted checkbox changes are idempotent and native select keeps the requested value',
    );
    settings.set({
      autoApprove: { safe: true, write: false, dangerous: false },
    });
    approvals.setEmitter(() => agent.abortAll());
    await tab.wc.executeJavaScript('window.events=[]');
    await assert.rejects(
      run('browser_click', { ref: ref('Commit') }),
      /declined|Stopped/,
    );
    assert.equal(await tab.wc.executeJavaScript('window.events.length'), 0);
    console.log('PASS Stop during approval emits no input');
  } finally {
    agent.abortAll();
    approvals.denyAll();
    tabs.destroyAll();
    window.destroy();
    settings.flush();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
