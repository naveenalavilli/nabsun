const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-connect-ui-'));
app.setPath('userData', profile);

async function main() {
  const bundle = await build({
    entryPoints: [path.join(__dirname, '../src/renderer/shell/extensions.ts')],
    bundle: true, write: false, format: 'iife', globalName: 'ConnectionUI', platform: 'browser',
  });
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL('data:text/html,<div id="extensions-body"></div>');
    const results = await win.webContents.executeJavaScript(`(async () => {
      ${bundle.outputFiles[0].text}
      const results = [];
      const check = (name, ok) => { if (!ok) throw Error(name); results.push(name); };
      const listeners = [], tabs = [], calls = [];
      let connected = false, active = false, changed = 0;
      window.nabsun = {
        accounts: {
          onEvent: cb => { listeners.push(cb); return () => {}; },
          status: async id => ({ provider: id, supported: true, connected: id === 'codex-cli' && connected, detail: '' }),
          connect: (id, mode) => calls.push({id,mode}),
          cancel: id => listeners.forEach(cb => cb({provider:id,done:true,ok:false,message:'Connection cancelled.'})),
          disconnect: async () => { connected = false; return {ok:true}; },
        },
        agentExtensions: { list: async () => ['codex-cli','claude-cli'].map(id => ({
          id, name:id==='codex-cli'?'Codex':'Claude Code', publisher:id==='codex-cli'?'OpenAI':'Anthropic',
          kind:'cli', installed:connected, active:id==='codex-cli'&&active, summary:'Connect your account', capabilities:[],
        })) },
        extensions: { onChanged: () => {}, list: async () => [] },
        tabs: { create: async url => tabs.push(url) },
      };
      const view = new ConnectionUI.ExtensionsView(() => changed++);
      await view.render(); await view.render();
      const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text);
      check('missing CLIs have Connect buttons', button('Connect Codex') && button('Connect Claude Code'));
      check('setup does not show npm commands', !document.body.textContent.includes('npm'));
      check('repaint registers only one account listener', listeners.length === 1);
      button('Connect Codex').click();
      check('Connect starts browser login', calls.length === 1 && calls[0].mode === 'browser');
      check('pending connection disables repeat clicks', button('Connecting...').disabled && button('Cancel'));
      const send = event => listeners.forEach(cb => cb({provider:'codex-cli',...event}));
      send({url:'https://auth.openai.com/oauth/authorize?state=fixture',message:'Finish sign-in'});
      await view.render();
      send({url:'https://auth.openai.com/oauth/authorize?state=fixture'});
      check('repaint and duplicate events open only one tab', tabs.length === 1);
      check('sign-in progress survives reopening panel', button('Open sign-in page') && button('Cancel'));
      button('Cancel').click();
      await new Promise(r => setTimeout(r, 20));
      check('cancel restores Connect', !!button('Connect Codex'));
      button('Connect Codex').click(); send({done:true,ok:false,error:'Fixture failure'});
      await new Promise(r => setTimeout(r, 20));
      check('failure shows Retry and keeps error visible', button('Retry connection') && document.body.textContent.includes('Fixture failure'));
      button('Retry connection').click(); connected = true; active = true; send({done:true,ok:true,message:'Connected and ready to use.'});
      await new Promise(r => setTimeout(r, 20));
      check('verified connection refreshes provider and offers sign-out', changed === 1 && button('Sign out') && !button('Connect Codex'));
      button('Sign out').click();
      check('sign-out does not offer a nonfunctional Cancel button', button('Signing out...')?.disabled && !button('Cancel'));
      await new Promise(r => setTimeout(r, 20));
      check('sign-out restores Connect', !!button('Connect Codex'));
      connected = true; await view.render();
      check('external reconnection replaces stale Signed out text', !document.body.textContent.includes('Signed out'));
      connected = false; active = false;
      const normalStatus = window.nabsun.accounts.status;
      let releaseStatus;
      window.nabsun.accounts.status = id => id === 'codex-cli'
        ? new Promise(resolve => { releaseStatus = resolve; }) : normalStatus(id);
      document.querySelector('#extensions-body').textContent = '';
      const slow = view.render();
      await new Promise(r => setTimeout(r, 20));
      check('slow Codex status does not hide Claude or browser extensions', button('Connect Claude Code') && button('Load unpacked extension…'));
      releaseStatus({ provider:'codex-cli', supported:true, connected:false, detail:'Not connected' });
      await slow;
      window.nabsun.accounts.status = async () => { throw Error('Fixture status failure'); };
      await view.render();
      check('failed account status leaves Connect usable and reports the problem', button('Connect Codex') && document.body.textContent.includes('Could not check this account'));
      window.nabsun.accounts.status = normalStatus;
      await view.render();
      let refuseTab = true;
      window.nabsun.tabs.create = async url => { if(refuseTab) throw Error('Fixture tab failure'); tabs.push(url); };
      button('Connect Codex').click();
      send({url:'https://auth.openai.com/oauth/authorize?state=retry'});
      await new Promise(r => setTimeout(r, 20));
      check('failed sign-in tab offers recovery instead of an unhandled rejection', button('Open sign-in page') && document.body.textContent.includes('Could not open sign-in'));
      refuseTab = false; button('Open sign-in page').click();
      await new Promise(r => setTimeout(r, 20));
      check('opening sign-in successfully clears the tab error', !document.body.textContent.includes('Could not open sign-in'));
      button('Cancel').click(); await new Promise(r => setTimeout(r, 20));
      const normalList = window.nabsun.agentExtensions.list;
      window.nabsun.agentExtensions.list = async () => { throw Error('Fixture catalogue failure'); };
      await view.render();
      check('catalogue failure offers a retry', !!button('Try again'));
      window.nabsun.agentExtensions.list = normalList;
      button('Try again').click(); await new Promise(r => setTimeout(r, 20));
      check('catalogue retry restores assistant cards', !!button('Connect Claude Code'));
      const repair = [...document.querySelectorAll('.ext-card')].find(card => card.textContent.includes('Claude Code'));
      const repairButton = [...repair.querySelectorAll('button')].find(b => b.textContent === 'Repair / update');
      check('native repair is available without a terminal command', !!repairButton);
      repairButton.click();
      check('repair uses the dedicated update flow and disables duplicate clicks', calls.at(-1).mode === 'repair' && button('Connecting...').disabled);
      listeners.forEach(cb => cb({provider:'claude-cli',done:true,ok:false,error:'Fixture update failure'}));
      await new Promise(r => setTimeout(r, 20));
      check('failed repair remains retryable', button('Retry connection') && button('Repair / update'));
      return results;
    })()`);
    for (const result of results) console.log('PASS ' + result);
    console.log('Connection UI checks passed: ' + results.length);
  } finally { win.destroy(); }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
