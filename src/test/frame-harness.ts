import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { app, BaseWindow } from 'electron';
import { TabManager, delay } from '../main/tabs';
import { HistoryStore } from '../main/history';
import { SettingsStore } from '../main/store';
import { Agent } from '../main/ai/agent';
import { ApprovalManager } from '../main/ai/approvals';
import { SessionStore } from '../main/ai/sessions';
import { browserTools } from '../main/ai/tools/browser';
import type { PageSnapshot } from '../shared/types';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-frames-'));
app.setPath('userData', profile);
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function main() {
  await app.whenReady();
  const child = http.createServer((_req, res) => {
    res.setHeader('Connection', 'close');
    res.end(
      '<!doctype html><label>Frame name<input aria-label="Frame name"></label><button>Frame save</button><script>document.querySelector("button").onclick=()=>parent.postMessage({value:document.querySelector("input").value},"*")</script>',
    );
  });
  const childPort = await listen(child);
  let crossSite = false;
  const server = http.createServer((_req, res) => {
    res.setHeader('Connection', 'close');
    res.end(
      `<!doctype html><style>body{padding:30px}iframe{width:600px;height:250px}button{padding:12px}</style><iframe id="child" src="http://${crossSite ? 'localhost' : '127.0.0.1'}:${childPort}"></iframe><iframe style="visibility:hidden" src="http://127.0.0.1:${childPort}"></iframe><div id="host"></div><div id="secret" autocomplete="one-time-code"></div><script>window.result=null;addEventListener('message',e=>{if(e.source===document.querySelector('#child').contentWindow)window.result=e.data});const shadow=document.querySelector('#host').attachShadow({mode:'open'});shadow.innerHTML='<button>Shadow action</button>';shadow.querySelector('button').onclick=()=>window.shadowClicked=true;const secret=document.querySelector('#secret').attachShadow({mode:'open'});secret.innerHTML='<input aria-label="Shadow secret" value="DO_NOT_LEAK">';</script>`,
    );
  });
  const port = await listen(server),
    history = new HistoryStore(),
    settings = new SettingsStore();
  settings.save({ autoApprove: { safe: true, write: true, dangerous: false } });
  const window = new BaseWindow({ width: 1000, height: 800, show: false });
  window.showInactive();
  const tabs = new TabManager({
    window,
    history,
    partition: 'frame-fixture',
    preloadPath: path.join(__dirname, '../preload/page.js'),
    homepage: 'about:blank',
    onFindResult: () => {},
  });
  tabs.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
  const approvals = new ApprovalManager(settings),
    agent = new Agent({
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
  // The fixture explicitly approves crossing between the child and top origins.
  // Production autopilot must never silently inherit that authority.
  approvals.setEmitter((request) => approvals.resolve(request.id, 'allow'));
  try {
    const tab = tabs.create(`http://127.0.0.1:${port}`);
    await tabs.waitForSettled(tab, 5000);
    await delay(150);
    const snap = () =>
      tabs.callBridge<PageSnapshot>(
        tab,
        'window.__nabsunAgent.snapshot({maxChars:8000})',
      );
    let snapshot = await snap();
    const ref = (name: string) => {
      const item = snapshot.elements.find((element) => element.name === name);
      assert.ok(item, name + ' absent: ' + snapshot.text);
      return item.ref;
    };
    assert.equal(
      snapshot.elements.filter((element) => element.name === 'Frame name')
        .length,
      1,
      'hidden frames are skipped',
    );
    assert.ok(!JSON.stringify(snapshot).includes('DO_NOT_LEAK'));
    const run = (name: string, input: Record<string, unknown>) =>
      agent.runToolForExternalAgent(
        name,
        { tabId: tab.id, ...input },
        'frame-fixture',
      );
    await run('browser_type', {
      ref: ref('Frame name'),
      text: 'Cross-origin value',
    });
    await run('browser_click', { ref: ref('Frame save') });
    assert.deepEqual(await tab.wc.executeJavaScript('window.result'), {
      value: 'Cross-origin value',
    });
    await run('browser_click', { ref: ref('Shadow action') });
    assert.equal(await tab.wc.executeJavaScript('window.shadowClicked'), true);
    console.log(
      'PASS cross-origin iframe input/submit and open-shadow ref action; hidden frame and shadow credential redaction',
    );
    const stale = ref('Frame name');
    await tab.wc.executeJavaScript(
      'document.querySelector("#child").src += "?reload=1"',
    );
    await delay(200);
    await assert.rejects(
      run('browser_type', { ref: stale, text: 'stale' }),
      /document|ref|context|frame|target/i,
    );
    console.log('PASS a reloaded frame rejects its old ref');
    crossSite = true;
    tabs.navigate(tab.id, `http://127.0.0.1:${port}/cross-site`);
    await tabs.waitForSettled(tab, 5000);
    await delay(200);
    snapshot = await snap();
    await run('browser_type', {
      ref: ref('Frame name'),
      text: 'Cross-site value',
    });
    await run('browser_click', { ref: ref('Frame save') });
    assert.deepEqual(await tab.wc.executeJavaScript('window.result'), {
      value: 'Cross-site value',
    });
    console.log('PASS isolated cross-site frame input and submit');
  } finally {
    agent.abortAll();
    tabs.destroyAll();
    window.destroy();
    settings.flush();
    for (const s of [server, child]) s.closeAllConnections();
    await Promise.all(
      [server, child].map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve())),
      ),
    );
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
