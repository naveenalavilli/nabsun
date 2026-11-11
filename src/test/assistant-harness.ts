import {LocalFolderStore,FolderAccessController} from '../main/localFiles';
import {FileStore} from '../main/files';
import {DatasetStore} from '../main/data/datasets';
import {DataWorkspace} from '../main/data/workspace';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { AppWindow } from '../main/appWindow';
import { SettingsStore, SecretStore } from '../main/store';
import { HistoryStore } from '../main/history';
import { SessionStore } from '../main/ai/sessions';
import { Agent } from '../main/ai/agent';
import { defineTool } from '../main/ai/tools/types';
import { ApprovalManager } from '../main/ai/approvals';
import { QuestionManager } from '../main/ai/questions';
import type { Provider, StreamEvent, StreamRequest } from '../main/ai/provider';
import { CliProvider } from '../main/ai/providers/cli';
import { registerIpc } from '../main/ipc';
import { DownloadManager } from '../main/downloads';
import { PasswordStore } from '../main/passwords';
import { McpManager } from '../main/integrations/mcp';
import { PluginManager } from '../main/integrations/plugins';
import { ChromeExtensionManager } from '../main/integrations/extensions';
import { CliAccountManager } from '../main/integrations/cliAccounts';
import { CH } from '../shared/ipc';
import {VoiceManager} from '../main/voice';
import type {VoiceEvent} from '../shared/voice';

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-assistant-test-'));
app.setPath('userData', tmp);
// Keep the test process alive long enough to observe callbacks after closure.
app.on('window-all-closed', () => {});
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(test: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await test()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for assistant');
    await delay(25);
  }
}

class WaitingProvider implements Provider {
  readonly id = 'anthropic' as const;
  readonly label = 'Waiting fixture';
  readonly requests: string[] = [];
  finish: (() => void) | null = null;
  async listModels() { return ['fixture']; }
  supportsVision() { return false; }
  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(JSON.stringify(req.messages.at(-1)));
    yield { type: 'text', delta: 'Working until Stop.' };
    await new Promise<void>(resolve => {
      this.finish = resolve;
      if (req.signal.aborted) resolve();
      else req.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    // Even a backend that returns normally after cancellation must report Stop.
    yield { type: 'text', delta: req.signal.aborted ? 'SHOULD NOT APPEAR' : 'Completed.' };
  }
}

class FixtureCli extends CliProvider {
  readonly id = 'codex-cli' as const;
  readonly label = 'Fixture CLI';
  protected readonly binName = 'fixture';
  override get launcher() { return { command: process.execPath, args: [path.join(tmp, 'cli.cjs')], runAsNode: true }; }
  protected buildArgs() { return []; }
  protected handleLine(): StreamEvent[] { return []; }
}

async function main() {
  await app.whenReady();
  const settings = new SettingsStore();
  settings.save({ onboardingCompleted: true, sidebarOpen: true, provider: 'anthropic', personalContext: false, memoryEnabled: false });
  const history = new HistoryStore();
  const sessions = new SessionStore(tmp);
  const win = new AppWindow(settings, history);
  const provider = new WaitingProvider();
  const providers = new Map([['anthropic' as const, provider]]);
  const approvals = new ApprovalManager(settings);
  const questions = new QuestionManager();
  const files=new FileStore(tmp),datasets=new DatasetStore(tmp,files);
  const agent = new Agent({ files,datasets,providers, settings, sessions, tabs: win.tabs, history, approvals, questions,
    getTools: () => [], userDataPath: tmp, emit: event => win.send(CH.agentEvent, event) });
  const mcp = new McpManager(tmp);
  const dataWorkspace=new DataWorkspace(tmp,files,agent,win.tabs,sessions,settings,providers,batch=>win.send(CH.batchChanged,batch),datasets);
  let voiceEmit:((event:Pick<VoiceEvent,'type'|'text'>)=>void)|undefined,voiceStops=0;
  class FixtureVoice extends VoiceManager {
    override start(...args:Parameters<VoiceManager['start']>){args[5]=async()=>true;return super.start(...args)}
  }
  const fixtureVoice=new FixtureVoice({availability:async()=>({available:true,languages:[{code:'en-US',name:'English'},{code:'te-IN',name:'Telugu'}],help:'Local test recognizer'}),listen:(_language,emit)=>{voiceEmit=emit;setImmediate(()=>emit({type:'listening'}));return()=>{voiceStops++}}});
  const localFixture=fs.mkdtempSync(path.join(os.tmpdir(),'nabsun-folder-ui-'));
  const localStore=new LocalFolderStore([tmp]);
  let folderChoice:string|null=localFixture;
  const folderAccess=new FolderAccessController(localStore,{choose:async()=>folderChoice,confirm:async()=> 'read',exists:scope=>!!sessions.load(scope),changed:scope=>win.send(CH.localFolderChanged,{sessionId:scope})});
  registerIpc({
    folderAccess,
    voice:fixtureVoice,
    dataWorkspace, win, settings, sessions, history, providers, approvals, questions, agent, mcp,
    secrets: new SecretStore(), downloads: new DownloadManager(), passwords: new PasswordStore(),
    plugins: new PluginManager(path.join(tmp, 'plugins')),
    extensions: new ChromeExtensionManager(() => []),
    accounts: new CliAccountManager(() => '', () => {}),
    reloadIntegrations: async () => {},
    bridgeInfo: () => ({ running: false, url: '', token: '', serverScript: '' }),
  });
  ipcMain.removeHandler(CH.updateCheck);
  ipcMain.handle(CH.updateCheck, () => ({ state: 'current', currentVersion: 'test' }));
  settings.onChange(next => win.send(CH.settingsChanged, next));
  try {
    const sessionCount = () => fs.readdirSync(path.join(tmp, 'sessions')).filter(name => name.endsWith('.json')).length;
    await until(() => win.window.contentView.children.includes(win.assistant.view) && sessionCount() === 1);
    assert.equal(win.state.assistantDetached, false, 'assistant starts attached by default');
    assert.equal(win.assistant.isVisible(), false);
    assert.equal(win.contentBounds.width, win.window.getContentSize()[0] - win.state.sidebarWidth - 3);
    if (process.platform === 'win32') {
      win.window.show();
      await win.shell.webContents.executeJavaScript('document.querySelector("#win-max").click()');
      await until(() => win.window.isMaximized());
      await until(() => win.shell.webContents.executeJavaScript('document.querySelector("#win-max").getAttribute("aria-label") === "Restore down"'));
      assert.equal(await win.shell.webContents.executeJavaScript('getComputedStyle(document.querySelector("#win-max .restore-icon")).display'), 'block');
      await win.shell.webContents.executeJavaScript('document.querySelector("#win-max").click()');
      await until(() => !win.window.isMaximized());
      await until(() => win.shell.webContents.executeJavaScript('document.querySelector("#win-max").getAttribute("aria-label") === "Maximize"'));
      await win.shell.webContents.executeJavaScript('document.querySelector("#win-min").click()');
      await until(() => win.window.isMinimized());
      win.window.restore();
      let closeRequested = false;
      win.window.once('close', event => { event.preventDefault(); closeRequested = true; });
      await win.shell.webContents.executeJavaScript('document.querySelector("#win-close").click()');
      await until(() => closeRequested);
      const macLayout = await win.shell.webContents.executeJavaScript(`(() => {
        document.documentElement.dataset.platform = 'darwin';
        const result = { controls: getComputedStyle(document.querySelector('#window-controls')).display, inset: parseFloat(getComputedStyle(document.querySelector('#tabstrip')).paddingLeft) };
        document.documentElement.dataset.platform = 'win32';
        return result;
      })()`);
      assert.equal(macLayout.controls, 'none');
      assert.ok(macLayout.inset >= 90);
      console.log('PASS Windows caption controls minimize, maximize/restore, and request close; macOS layout reserves native traffic lights');
    }
    const browserTab = win.tabs.create('about:blank');
    await until(() => !browserTab.wc.isLoading());
    const pageWidth = await browserTab.wc.executeJavaScript('innerWidth');
    const originalSize = win.window.getContentSize();
    for (const width of [900, 1280]) {
      win.window.setContentSize(width, 800);
      await delay(80);
      const toolbar = await win.shell.webContents.executeJavaScript(`(() => {
        const bar = document.querySelector('#toolbar').getBoundingClientRect();
        const buttons = [...document.querySelectorAll('#toolbar .icon-btn')].map(button => {
          const rect = button.getBoundingClientRect();
          return { width:rect.width, height:rect.height, center:rect.y + rect.height / 2,
            right:rect.right, icon:!!button.querySelector('svg'), label:button.getAttribute('aria-label') };
        });
        return { buttons, center:bar.y + bar.height / 2, width:innerWidth,
          pageY:document.querySelector('#content-placeholder').getBoundingClientRect().top,
          redundant:!!document.querySelector('#ask-page') };
      })()`);
      assert.equal(toolbar.redundant, false);
      for (const button of toolbar.buttons) {
        assert.ok(button.width >= 36 && button.height >= 36 && button.icon && button.label);
        assert.ok(Math.abs(button.center - toolbar.center) < 1);
        assert.ok(button.right <= toolbar.width);
      }
      assert.equal(toolbar.pageY, win.contentBounds.y, 'native page begins below the toolbar and bookmark bar');
    }
    win.window.setContentSize(originalSize[0], originalSize[1]);
    await win.shell.webContents.executeJavaScript('document.querySelector("#sidebar-toggle").click()');
    await until(() => !win.state.sidebarOpen);
    await until(() => win.shell.webContents.executeJavaScript('document.querySelector("#sidebar-toggle").getAttribute("aria-pressed") === "false"'));
    await win.shell.webContents.executeJavaScript('document.querySelector("#sidebar-toggle").click()');
    await until(() => win.state.sidebarOpen);
    await until(() => win.shell.webContents.executeJavaScript('document.querySelector("#sidebar-toggle").getAttribute("aria-pressed") === "true"'));
    assert.equal(await win.shell.webContents.executeJavaScript('!!document.querySelector("#nav-reload svg") && !!document.querySelector("#bookmark svg")'), true, 'state renders preserve vector icons');
    const chromeArtifacts = path.resolve(__dirname, '../../../.review-artifacts');
    fs.mkdirSync(chromeArtifacts, { recursive:true });
    fs.writeFileSync(path.join(chromeArtifacts, 'browser-toolbar.png'), (await win.shell.webContents.capturePage({x:0,y:0,width:win.window.getContentSize()[0],height:130})).toPNG());
    console.log('PASS desktop toolbar alignment at 900/1280px, native page bounds, vector icons, and assistant toggle');
    await win.assistant.webContents.executeJavaScript('document.querySelector("#workflows-btn").click()');
    await until(()=>win.shell.webContents.executeJavaScript('document.querySelector("#view-workflows").classList.contains("active") && !!document.querySelector("#data-paste")'));
    const literal='<img src=x onerror="window.__dataXss=true">';
    await win.shell.webContents.executeJavaScript(`document.querySelector('#data-table-text').value=${JSON.stringify('Name\n'+literal)};document.querySelector('#data-paste').dispatchEvent(new Event('submit',{cancelable:true}))`);
    await until(()=>win.shell.webContents.executeJavaScript('document.querySelector("#data-preview").textContent.includes("onerror")'));
    assert.equal(await win.shell.webContents.executeJavaScript('!!window.__dataXss || !!document.querySelector("#data-preview img")'),false,'table cells are rendered as text');
    for(const width of [900,1280])for(const theme of ['light','dark']){
      win.window.setContentSize(width,800);
      await win.shell.webContents.executeJavaScript(`document.documentElement.dataset.theme='${theme}'`);
      await delay(40);
      assert.equal(await win.shell.webContents.executeJavaScript('document.querySelector("#workflows-body").scrollWidth <= document.querySelector("#workflows-body").clientWidth'),true);
    }
    const dataArtifacts=path.resolve(__dirname,'../../../.review-artifacts');fs.mkdirSync(dataArtifacts,{recursive:true});
    fs.writeFileSync(path.join(dataArtifacts,'data-workspace.png'),(await win.shell.webContents.capturePage()).toPNG());
    await win.shell.webContents.executeJavaScript('document.querySelector("#workspace-close").click()');
    await until(()=>browserTab.view.getVisible());win.window.setContentSize(originalSize[0],originalSize[1]);
    console.log('PASS full data workspace, chat-scoped pasted table, inert HTML-looking cells, responsive themes, and return to browser');
    await win.shell.webContents.executeJavaScript(`window.nabsun.tabs.navigate(${JSON.stringify(browserTab.id)},'nabsun://activity')`);
    await until(async()=>await win.shell.webContents.executeJavaScript('document.querySelector("#view-activity").classList.contains("active") && document.querySelector("#activity-body").textContent.includes("Journal integrity verified")'));
    assert.equal(browserTab.view.getVisible(),false);
    assert.equal(await win.shell.webContents.executeJavaScript('document.querySelector("#activity-body").scrollWidth<=document.querySelector("#activity-body").clientWidth'),true);
    await win.shell.webContents.executeJavaScript('document.querySelector("#workspace-close").click()');await until(()=>browserTab.view.getVisible());
    console.log('PASS user-entered activity address opens a verified full workspace and returns to the existing browser tab');


    assert.equal(await win.shell.webContents.executeJavaScript('document.querySelector("#developer-tools-btn") === null'), true, 'everyday toolbar does not expose developer controls');
    await win.shell.webContents.executeJavaScript('window.nabsun.window.pageDevTools("toggle")');
    await until(() => browserTab.wc.isDevToolsOpened());
    assert.equal(win.shell.webContents.isDevToolsOpened(), false, 'developer shortcut targets the page, not browser UI');
    await until(async () => await browserTab.wc.executeJavaScript('innerWidth') < pageWidth);
    await until(() => Boolean(browserTab.wc.devToolsWebContents?.getURL().startsWith('devtools://')));
    win.tabs.pageDevTools('detach');
    await until(async()=>browserTab.wc.isDevToolsOpened()&&await browserTab.wc.executeJavaScript('innerWidth')>=pageWidth);
    win.tabs.pageDevTools('toggle');
    await until(() => !browserTab.wc.isDevToolsOpened());
    browserTab.wc.sendInputEvent({ type: 'keyDown', keyCode: 'F12' });
    browserTab.wc.sendInputEvent({ type: 'keyUp', keyCode: 'F12' });
    await until(() => browserTab.wc.isDevToolsOpened());
    win.tabs.pageDevTools('toggle');
    await until(() => !browserTab.wc.isDevToolsOpened());
    browserTab.wc.sendInputEvent({ type: 'keyDown', keyCode: 'I', modifiers: process.platform === 'darwin' ? ['meta', 'alt'] : ['control', 'shift'] });
    browserTab.wc.sendInputEvent({ type: 'keyUp', keyCode: 'I', modifiers: process.platform === 'darwin' ? ['meta', 'alt'] : ['control', 'shift'] });
    await until(() => browserTab.wc.isDevToolsOpened());
    win.tabs.pageDevTools('toggle');
    await until(() => !browserTab.wc.isDevToolsOpened());
    win.tabs.pageDevTools('detach');
    await until(() => browserTab.wc.isDevToolsOpened());
    win.tabs.pageDevTools('toggle');
    await until(() => !browserTab.wc.isDevToolsOpened());
    console.log('PASS page DevTools opens docked, toggles from familiar shortcuts, and supports a separate window');
    await win.assistant.webContents.executeJavaScript('document.querySelector("#settings-btn").click()');
    await until(() => win.shell.webContents.executeJavaScript('!!document.querySelector("#settings-overview")'));
    assert.equal(browserTab.view.getVisible(), false, 'native page is hidden behind settings');
    assert.equal(win.assistant.view.getVisible(), false, 'attached assistant does not cover settings');
    const settingsUI = () => win.shell.webContents;
    const layout = await settingsUI().executeJavaScript(`(() => {
      const root = document.querySelector('#workspace');
      const rail = document.querySelector('.settings-rail');
      const cards = document.querySelectorAll('.settings-card');
      return { width: root.getBoundingClientRect().width, window: innerWidth, categories: rail.querySelectorAll('button').length, cards: cards.length };
    })()`);
    assert.equal(layout.width, layout.window, 'settings uses the full browser content width');
    assert.equal(layout.categories, 8);
    assert.equal(layout.cards, 6);
    win.send(CH.overlayCommand, { command: 'open-clear-data' });
    await until(() => settingsUI().executeJavaScript('!document.querySelector("#settings-browsing")?.hidden'));
    assert.equal(win.assistant.view.getVisible(), false, 'clear-data command stays in the browser workspace');
    await settingsUI().executeJavaScript(`(() => {
      const input = document.querySelector('.settings-rail input');
      input.value = 'privacy'; input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    })()`);
    assert.equal(await settingsUI().executeJavaScript('document.querySelector("#settings-assistant").hidden'), false);
    const thinkingBefore = settings.get().extendedThinking;
    await settingsUI().executeJavaScript('document.querySelector("#settings-assistant input[role=switch]").focus()');
    settingsUI().sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    settingsUI().sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await until(() => settings.get().extendedThinking !== thinkingBefore);
    assert.equal(await settingsUI().executeJavaScript('getComputedStyle(document.querySelector("#settings-assistant input[role=switch]")).appearance'), 'none');
    settings.set({ extendedThinking: thinkingBefore });
    console.log('PASS styled settings switches remain keyboard operable and persist changes');
    await settingsUI().executeJavaScript(`(() => {
      const input = document.querySelector('.settings-rail input');
      input.value = ''; input.dispatchEvent(new Event('input'));
      document.querySelector('[aria-controls="settings-overview"]').click();
    })()`);
    const artifacts = path.resolve(__dirname, '../../../.review-artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    await delay(150);
    const visibleSettings = await settingsUI().executeJavaScript(`(() => {
      const rail = document.querySelector('.settings-rail').getBoundingClientRect();
      const card = document.querySelector('.settings-card').getBoundingClientRect();
      return { rail: rail.height, card: card.height, active: document.querySelector('#view-settings').className };
    })()`);
    assert.ok(visibleSettings.rail > 100 && visibleSettings.card > 50, JSON.stringify(visibleSettings));
    fs.writeFileSync(path.join(artifacts, 'settings-workspace.png'), (await settingsUI().capturePage()).toPNG());
    await until(() => settingsUI().executeJavaScript('!!document.querySelector("#settings-integrations") && !!document.querySelector("#settings-advanced")'));
    for (const [width, height] of [[900, 600], [1680, 950]]) {
      win.window.setContentSize(width, height);
      await delay(50);
      for (const theme of ['light', 'dark']) {
        await settingsUI().executeJavaScript(`document.documentElement.dataset.theme = '${theme}'`);
        for (const category of ['overview', 'model', 'appearance', 'assistant', 'browsing', 'integrations', 'updates', 'advanced']) {
          const fits = await settingsUI().executeJavaScript(`(() => {
            document.querySelector('[aria-controls="settings-${category}"]').click();
            const panel = document.querySelector('#settings-${category}');
            const content = document.querySelector('.settings-content');
            return !panel.hidden && panel.getBoundingClientRect().height > 0 && content.scrollWidth <= content.clientWidth;
          })()`);
          assert.ok(fits, `${category} fits ${width}x${height} ${theme}`);
        }
      }
    }
    await settingsUI().executeJavaScript(`document.documentElement.dataset.theme = 'light'; document.querySelector('[aria-controls="settings-overview"]').click()`);
    console.log('PASS all settings categories fit small/large windows in light/dark mode');
    await settingsUI().executeJavaScript('document.querySelector(".setup-banner").click()');
    await until(() => settingsUI().executeJavaScript('document.querySelector("#view-onboarding").classList.contains("active")'));
    assert.equal(await settingsUI().executeJavaScript('!!document.querySelector(".welcome-illustration[role=img]")'), true);
    win.window.setContentSize(900, 600);
    await delay(100);
    assert.equal(await settingsUI().executeJavaScript(`(() => {
      const skip = document.querySelector('[data-action=skip]').getBoundingClientRect();
      return skip.top >= 0 && skip.bottom <= innerHeight;
    })()`), true, 'first-use choices are visible without scrolling on a small browser window');
    win.window.setContentSize(1680, 950);
    await delay(150);
    fs.writeFileSync(path.join(artifacts, 'settings-welcome.png'), (await settingsUI().capturePage()).toPNG());
    for (const step of [1, 2]) {
      await settingsUI().executeJavaScript(`document.querySelector('[data-guide-step="${step}"]').click()`);
      await delay(80);
      fs.writeFileSync(path.join(artifacts, `getting-started-${step}.png`), (await settingsUI().capturePage()).toPNG());
    }
    await settingsUI().executeJavaScript('document.querySelector("#guide-tab-0").click()');

    await settingsUI().executeJavaScript('document.querySelector("[data-action=local]").click()');
    await until(() => browserTab.view.getVisible());
    await until(() => win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value === "What can you help me do in this browser?"'));
    assert.equal(provider.requests.length, 0, 'setup prefills a prompt without sending it');
    assert.equal(settings.get().provider, 'local', 'setup selects the built-in provider');
    settings.set({ provider: 'anthropic' });
    await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value = ""');
    assert.equal(win.assistant.view.getVisible(), true, 'return restores attached assistant');
    assert.equal(win.tabs.activeTabId, browserTab.id, 'settings preserves the active tab');
    console.log('PASS full settings workspace, category search, visual setup, and return preserve browser state');
    await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value="Existing draft";document.querySelector("#voice-toggle").click()');
    await until(()=>!!voiceEmit);
    voiceEmit!({type:'text',text:'నమస్కారం'});
    await until(()=>win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value === "Existing draft నమస్కారం"'));
    assert.equal(provider.requests.length,0,'dictation never sends automatically');
    await win.assistant.webContents.executeJavaScript('document.querySelector("#voice-toggle").click()');
    await until(()=>voiceStops===1);
    voiceEmit!({type:'text',text:'late words'});
    await delay(50);
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value'),'Existing draft నమస్కారం');
    fs.writeFileSync(path.join(artifacts,'assistant-voice.png'),(await win.assistant.webContents.capturePage()).toPNG());
    await win.assistant.webContents.executeJavaScript('document.querySelector("#voice-language").value="te-IN";document.querySelector("#voice-toggle").click()');
    await until(()=>win.assistant.webContents.executeJavaScript('document.querySelector("#voice-status").textContent.startsWith("Listening")'));
    await win.assistant.webContents.executeJavaScript('document.querySelector("#view-chat").classList.remove("active")');
    await until(()=>voiceStops===2);
    voiceEmit!({type:'text',text:'hidden chat output'});
    await delay(40);
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value'),'Existing draft నమస్కారం');
    await win.assistant.webContents.executeJavaScript('document.querySelector("#view-chat").classList.add("active")');
    await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value=""');
    console.log('PASS microphone control appends multilingual words to the draft without sending; Stop ignores late recognizer output');
    win.openWorkspace('settings');
    win.toggleSidebar(true);
    await until(() => settingsUI().executeJavaScript('document.querySelector("#workspace").hidden'));
    assert.equal(win.assistant.view.getVisible(), true, 'approval requests can reveal the assistant');
    await win.assistant.webContents.executeJavaScript('document.querySelector("#assistant-detach").click()');
    await until(() => win.assistant.isVisible());
    assert.equal(sessionCount(), 1, 'only the assistant creates a chat');
    assert.equal(win.contentBounds.width, win.window.getContentSize()[0], 'browser retains its full width');
    assert.equal(await win.assistant.webContents.executeJavaScript('getComputedStyle(document.querySelector("#topchrome")).display'), 'none');
    console.log('PASS separate assistant window and full-width browser');

    const welcomeUI=win.assistant.webContents;
    const welcomeTheme=await welcomeUI.executeJavaScript('document.documentElement.getAttribute("data-theme")');
    for(const theme of ['light','dark']) {
      await welcomeUI.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for(const [width,zoom] of [[560,1],[380,1],[560,2]]) {
        win.assistant.setSize(width,820);welcomeUI.setZoomFactor(zoom);await delay(150);
        const layout=await welcomeUI.executeJavaScript(`(() => {
          const cards=[...document.querySelectorAll('[data-starter]')];
          const input=document.querySelector('#prompt').getBoundingClientRect();
          const send=document.querySelector('#send').getBoundingClientRect();
          const bounds=document.querySelector('#transcript').getBoundingClientRect();
          return {count:cards.length,overflow:document.documentElement.scrollWidth>innerWidth,
            cardsFit:cards.every(card=>{const r=card.getBoundingClientRect();return r.left>=bounds.left&&r.right<=bounds.right}),
            composerFits:input.left>=0&&input.right<=innerWidth&&send.right<=innerWidth&&send.bottom<=innerHeight};
        })()`);
        assert.equal(layout.count,4);assert.equal(layout.overflow,false,JSON.stringify({theme,width,zoom,layout}));
        assert.ok(layout.cardsFit&&layout.composerFits,JSON.stringify({theme,width,zoom,layout}));
        if(zoom===1)fs.writeFileSync(path.join(artifacts,`chat-welcome-${theme}-${width}.png`),(await welcomeUI.capturePage()).toPNG());
      }
    }
    welcomeUI.setZoomFactor(1);win.assistant.setSize(560,820);
    await welcomeUI.executeJavaScript(`document.documentElement.${welcomeTheme?'setAttribute("data-theme",'+JSON.stringify(welcomeTheme)+')':'removeAttribute("data-theme")'}`);
    for(const id of ['research','action','files','summary']) {
      await welcomeUI.executeJavaScript(`document.querySelector('[data-starter="${id}"]').click()`);
      const draft=await welcomeUI.executeJavaScript('document.querySelector("#prompt").value');
      assert.ok(draft.length>30);assert.equal(provider.requests.length,0,'task cards only fill a draft');
      assert.equal(await welcomeUI.executeJavaScript('document.activeElement===document.querySelector("#prompt")'),true);
      assert.equal(await welcomeUI.executeJavaScript('document.querySelectorAll("[data-starter][aria-pressed=true]").length'),1);
    }
    console.log('PASS action-focused welcome and composer fit light/dark, narrow windows and 200% zoom; all four cards prefill without executing');
    await win.assistant.webContents.executeJavaScript('document.querySelector("[data-starter=summary]").click()');
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Summarize this page in three short bullet points.');
    assert.equal(provider.requests.length, 0, 'starter questions never send a request automatically');
    await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value = ""');
    await win.assistant.webContents.executeJavaScript('document.querySelector("#assistant-menu summary").click()');
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelector("#assistant-menu").open'), true);
    const compactHeader = await win.assistant.webContents.executeJavaScript(`(() => {
      const head = document.querySelector('#sidebar-head').getBoundingClientRect();
      const zoom = document.querySelector('#assistant-zoom').getBoundingClientRect();
      const options = document.querySelector('.assistant-options').getBoundingClientRect();
      return { height: head.height, zoom: zoom.height, fits: options.left >= 0 && options.right <= innerWidth };
    })()`);
    assert.ok(compactHeader.height < 55, JSON.stringify(compactHeader));
    assert.ok(compactHeader.zoom > 0 && compactHeader.fits);
    for (const zoom of [0.75, 2]) {
      win.assistant.webContents.setZoomFactor(zoom);
      const fits = await win.assistant.webContents.executeJavaScript(`(() => {
        const menu = document.querySelector('.assistant-options').getBoundingClientRect();
        const head = document.querySelector('.assistant-titlebar');
        return menu.left >= 0 && menu.right <= innerWidth && head.scrollWidth <= head.clientWidth;
      })()`);
      assert.ok(fits, `assistant header and menu fit at ${zoom * 100}% zoom`);
    }
    win.assistant.webContents.setZoomFactor(1);
    await win.assistant.webContents.executeJavaScript('document.querySelector("#assistant-menu summary").focus()');
    win.assistant.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.assistant.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(() => win.assistant.webContents.executeJavaScript('!document.querySelector("#assistant-menu").open'));
    await delay(150);
    fs.writeFileSync(path.join(artifacts, 'assistant-clean-header.png'), (await win.assistant.webContents.capturePage()).toPNG());
    console.log('PASS compact assistant header keeps zoom and tools in a keyboard-dismissible overflow menu');
    await win.assistant.webContents.executeJavaScript('document.querySelector(".starter-tour").click()');
    await until(() => win.shell.webContents.executeJavaScript('document.querySelector("#view-onboarding").classList.contains("active")'));
    await win.shell.webContents.executeJavaScript('document.querySelector("[data-action=skip]").click()');
    await until(() => !win.state.sidebarOpen);
    assert.equal(await win.shell.webContents.executeJavaScript('document.querySelector("#workspace").hidden'), true);
    assert.equal(settings.get().provider, 'anthropic', 'browsing without the assistant preserves the selected provider');
    win.toggleSidebar(true);
    await until(() => win.assistant.isVisible());
    console.log('PASS first-use examples require Send and browse-only setup leaves the assistant closed');
    await win.assistant.webContents.executeJavaScript('document.querySelector(".starter-tour").click()');
    await until(() => win.shell.webContents.executeJavaScript('document.querySelector("#view-onboarding").classList.contains("active")'));
    const draft = await win.shell.webContents.executeJavaScript(`(() => {
      document.querySelector('#guide-tab-1').click();
      document.querySelector('[data-guide-example="2"]').click();
      const prompt = document.querySelector('#guide-prompt').textContent;
      document.querySelector('[data-action=example]').click();
      return prompt;
    })()`);
    await until(() => win.assistant.webContents.executeJavaScript(`document.querySelector('#prompt').value === ${JSON.stringify(draft)}`));
    assert.equal(settings.get().provider, 'anthropic');
    assert.equal(provider.requests.length, 0, 'guide examples never send a task automatically');
    assert.equal(await win.shell.webContents.executeJavaScript('document.querySelector("#workspace").hidden'), true);
    console.log('PASS task guide opens the chosen draft with the current assistant without running it');


    await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value = "Preserved draft"; document.querySelector("#assistant-zoom-in").click()');
    await until(() => settings.get().assistantZoom === 1.1);
    const assistantContentsId = win.assistant.webContents.id;
    await win.assistant.webContents.executeJavaScript('document.querySelector("#assistant-detach").click()');
    await until(() => !settings.get().assistantDetached);
    assert.equal(win.assistant.isVisible(), false);
    assert.equal(win.window.contentView.children.includes(win.assistant.view), true);
    assert.equal(win.contentBounds.width, win.window.getContentSize()[0] - win.state.sidebarWidth - 3);
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Preserved draft');
    win.resizeSidebar(480);
    assert.equal(win.assistant.view.getBounds().width, win.state.sidebarWidth);
    win.toggleSidebar(false);
    assert.equal(win.assistant.view.getVisible(), false);
    assert.equal(win.contentBounds.width, win.window.getContentSize()[0]);
    win.toggleSidebar(true);
    assert.equal(win.assistant.view.getVisible(), true);
    await win.assistant.webContents.executeJavaScript('document.querySelector("#assistant-detach").click()');
    await until(() => settings.get().assistantDetached);
    assert.equal(win.assistant.webContents.id, assistantContentsId, 'mode switches keep the same renderer');
    assert.equal(win.assistant.contentView.children.includes(win.assistant.view), true);
    assert.equal(win.contentBounds.width, win.window.getContentSize()[0]);
    console.log('PASS attach/detach preserves renderer, draft and zoom; attached resize and hide restore browser space');
    assert.equal(win.shell.webContents.getZoomFactor(), 1, 'assistant zoom leaves browser chrome unchanged');
    win.assistant.close();
    assert.equal(win.assistant.isDestroyed(), false);
    assert.equal(win.assistant.isVisible(), false);
    win.toggleSidebar(true);
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Preserved draft');
    settings.flush();
    assert.equal(new SettingsStore().get().assistantZoom, 1.1);
    assert.equal(new SettingsStore().get().assistantDetached, true);
    for (let i = 0; i < 20; i++) win.zoomAssistant(0.1);
    assert.equal(win.assistant.webContents.getZoomFactor(), 2);
    win.assistant.setSize(380, 820);
    await delay(100);
    assert.equal(await win.assistant.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true, 'largest zoom fits a narrow assistant');
    for (let i = 0; i < 20; i++) win.zoomAssistant(-0.1);
    assert.equal(win.assistant.webContents.getZoomFactor(), 0.75);
    win.zoomAssistant(null);
    assert.equal(win.assistant.webContents.getZoomFactor(), 1);
    win.assistant.webContents.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] });
    await until(() => settings.get().assistantZoom === 1.1);
    win.assistant.webContents.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] });
    await until(() => settings.get().assistantZoom === 1);
    win.assistant.setSize(560, 820);
    console.log('PASS hide/reopen preserves draft; independent zoom persists, clamps and resets');


    const folderScope=fs.readdirSync(path.join(tmp,'sessions')).find(name=>name.endsWith('.json'))!.slice(0,-5);
    await win.assistant.webContents.executeJavaScript('document.querySelector("#choose-local-folder").click()');
    await until(()=>localStore.list(folderScope).length===1);
    await until(()=>win.assistant.webContents.executeJavaScript('document.querySelector("#local-folder-access").textContent.includes("Read only")'));
    assert.equal(localStore.list(folderScope)[0].mode,'read');
    await delay(100);
    fs.writeFileSync(path.join(artifacts,'assistant-local-folder.png'),(await win.assistant.webContents.capturePage()).toPNG());
    for(const theme of ['light','dark']) {
      await win.assistant.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      win.assistant.setSize(380,820);win.assistant.webContents.setZoomFactor(2);await delay(80);
      const folderLayout=await win.assistant.webContents.executeJavaScript(`(() => {
        document.querySelector('#stop').hidden=false;
        document.querySelector('#send .send-label').textContent='Send next';
        document.querySelector('#stop').focus();
        const stop=document.querySelector('#stop').getBoundingClientRect();
        return {overflow:document.documentElement.scrollWidth>innerWidth,stopVisible:stop.top>=0&&stop.bottom<=innerHeight&&stop.right<=innerWidth};
      })()`);
      assert.equal(folderLayout.overflow,false,JSON.stringify({theme,folderLayout}));
      assert.equal(folderLayout.stopVisible,true,JSON.stringify({theme,folderLayout}));
    }
    win.assistant.webContents.setZoomFactor(1);win.assistant.setSize(560,820);
    await win.assistant.webContents.executeJavaScript('document.documentElement.dataset.theme="light";document.querySelector("#stop").hidden=true;document.querySelector("#send .send-label").textContent="Send"');
    folderChoice=null;
    await until(()=>win.assistant.webContents.executeJavaScript('!document.querySelector("#choose-local-folder").disabled'));
    await win.assistant.webContents.executeJavaScript('document.querySelector("#choose-local-folder").click()');
    await until(()=>win.assistant.webContents.executeJavaScript('document.querySelector("#local-folder-status").textContent.includes("No new folder")'));
    assert.equal(localStore.list(folderScope).length,1,'cancelled chooser preserves earlier access');
    await win.assistant.webContents.executeJavaScript('document.querySelector("#local-folder-access button").click()');
    await until(()=>localStore.list(folderScope).length===0);
    await until(()=>win.assistant.webContents.executeJavaScript('document.querySelector("#local-folder-access").hidden'));
    console.log('PASS folder button opens chat-bound access, shows read-only mode and location, cancellation adds nothing, and Disconnect revokes it');

    const permissionSession=fs.readdirSync(path.join(tmp,'sessions')).find(name=>name.endsWith('.json'))!.slice(0,-5);
    const evaluate=defineTool({name:'browser_evaluate',description:'permission fixture',risk:'dangerous',properties:{}},async()=> 'ok');
    approvals.setEmitter(req=>win.send(CH.agentApprovalRequest,req));
    const requestPermission=()=>approvals.request(evaluate,{script:'document.title'},new AbortController().signal,{sessionId:permissionSession,origin:'https://fixture.example'});
    let permission=requestPermission();
    await until(()=>win.assistant.webContents.executeJavaScript('!!document.querySelector(".session-approval-choice input")'));
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelector(".session-approval-choice input").checked'),false,'session auto-allow is opt-in');
    await win.assistant.webContents.executeJavaScript('document.querySelector(".approval .primary").click()');
    assert.equal(await permission,true);
    assert.equal(approvals.grantsForSession(permissionSession).length,0,'Allow alone grants only this call');
    permission=requestPermission();
    await until(()=>win.assistant.webContents.executeJavaScript('!!document.querySelector(".session-approval-choice input")'));
    await win.assistant.webContents.executeJavaScript('document.querySelector(".session-approval-choice input").click();document.querySelector(".approval .primary").click()');
    assert.equal(await permission,true);
    await until(()=>win.assistant.webContents.executeJavaScript('!!document.querySelector("#session-tool-grants input:checked")'));
    await delay(150);
    fs.writeFileSync(path.join(artifacts,'assistant-session-permissions.png'),(await win.assistant.webContents.capturePage()).toPNG());
    assert.equal(await requestPermission(),true,'next call needs no approval card');
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelectorAll(".approval").length'),0);
    await win.assistant.webContents.executeJavaScript('document.querySelector("#session-tool-grants input").click()');
    await until(()=>approvals.grantsForSession(permissionSession).length===0);
    permission=requestPermission();
    await until(()=>win.assistant.webContents.executeJavaScript('!!document.querySelector(".session-approval-choice input")'));
    await win.assistant.webContents.executeJavaScript('document.querySelector(".session-approval-choice input").click();[...document.querySelectorAll(".approval button")].find(button=>button.textContent==="Deny").click()');
    assert.equal(await permission,false);
    assert.equal(approvals.grantsForSession(permissionSession).length,0,'Deny never creates a session grant');
    console.log('PASS session permission checkbox defaults off, Allow once, repeat tool approval suppression, visible revocation and Deny');

    const submitPrompt = (text: string) => win.assistant.webContents.executeJavaScript(`document.querySelector('#prompt').value = ${JSON.stringify(text)}; document.querySelector('#attach-page').checked = false; document.querySelector('#send').click()`);
    await submitPrompt('First queued test');
    await until(() => provider.requests.length === 1);
    await submitPrompt('Cancel this future prompt');
    await submitPrompt('Run this future prompt');
    await submitPrompt('Run this last');
    await until(() => win.assistant.webContents.executeJavaScript('document.querySelectorAll(".queued-prompt").length === 3'));
    assert.equal(provider.requests.length, 1, 'future prompts wait for the current turn');
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelector("#transcript").textContent.includes("Cancel this future prompt")'), false);
    const queuedSessionId = sessions.list()[0].id;
    assert.equal(JSON.stringify(sessions.load(queuedSessionId)).includes('Cancel this future prompt'), false, 'pending prompts are not in model history');
    await win.assistant.webContents.executeJavaScript('document.querySelector(".queued-prompt button").click()');
    await until(() => win.assistant.webContents.executeJavaScript('document.querySelectorAll(".queued-prompt").length === 2'));
    win.assistant.close();
    win.toggleSidebar(true);
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelectorAll(".queued-prompt").length'), 2);
    win.setAssistantDetached(false);
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelectorAll(".queued-prompt").length'), 2);
    win.setAssistantDetached(true);
    provider.finish!();
    await until(() => provider.requests.length === 2);
    assert.equal(provider.requests[1].includes('Run this future prompt'), true);
    const activeCannotBeCancelled = await win.assistant.webContents.executeJavaScript(`(async () => {
      const state = await window.nabsun.agent.queue(${JSON.stringify(queuedSessionId)});
      return window.nabsun.agent.cancelQueued(state.sessionId, state.active.id);
    })()`);
    assert.equal(activeCannotBeCancelled, false, 'a picked-up prompt requires Stop');
    provider.finish!();
    await until(() => provider.requests.length === 3);
    assert.equal(provider.requests[2].includes('Run this last'), true);
    assert.equal(provider.requests.some(request => request.includes('Cancel this future prompt')), false);
    await submitPrompt('Discard this on Stop');
    await until(() => win.assistant.webContents.executeJavaScript('document.querySelectorAll(".queued-prompt").length === 1'));
    await win.assistant.webContents.executeJavaScript('document.querySelector("#stop").click()');
    await until(() => !agent.isRunning(queuedSessionId));
    await until(() => win.assistant.webContents.executeJavaScript('document.querySelectorAll(".queued-prompt").length === 0 && document.querySelector("#stop").hidden'));
    assert.equal(provider.requests.length, 3, 'Stop does not launch a pending prompt');
    assert.equal(JSON.stringify(sessions.load(queuedSessionId)).includes('Discard this on Stop'), false);
    console.log('PASS follow-ups run in order; cancellation removes pending prompts before model history; Stop clears the queue');
    await until(()=>win.assistant.webContents.executeJavaScript('document.querySelector("#transcript").textContent.includes("pressed Stop")'));
    assert.equal(sessions.load(queuedSessionId)!.messages.at(-1)!.stopReason,'user_stop');
    await agent.send(queuedSessionId,'Deadline explanation fixture.',{attachPage:false,budget:{steps:2,tokens:128000,timeMs:1000}});
    await until(()=>win.assistant.webContents.executeJavaScript('document.querySelector("#transcript").textContent.includes("time limit (1 second)")'));
    assert.equal(sessions.load(queuedSessionId)!.messages.at(-1)!.stopReason,'time_limit');
    await win.assistant.webContents.executeJavaScript('document.querySelector(".session-item").click()');
    await until(()=>win.assistant.webContents.executeJavaScript('document.querySelector("#transcript .notice")?.textContent.includes("pressed Stop")'));
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelector("#transcript").textContent.includes("time limit (1 second)")'),true,'deadline explanation survives reopening the conversation');
    console.log('PASS live Stop/time-limit notices explain their cause and persist when reopening chat');


    await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value = "Switching chat test"');
    await win.assistant.webContents.executeJavaScript('document.querySelector("#attach-page").checked = false; document.querySelector("#send").click()');
    await until(() => win.assistant.webContents.executeJavaScript('document.querySelector("#transcript").textContent.includes("Working until Stop.")'));
    const runningId = sessions.list()[0].id;
    await win.assistant.webContents.executeJavaScript('document.querySelector("#new-chat").click()');
    await until(() => sessionCount() === 2);
    await win.assistant.webContents.executeJavaScript('document.querySelector("#stop").click()');
    await until(() => !agent.isRunning(runningId));
    assert.equal(JSON.stringify(sessions.load(runningId)).includes('SHOULD NOT APPEAR'), false);
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelector("#stop").hidden'), true);
    console.log('PASS Stop cancels the running chat after switching sessions and drops late output');

    provider.finish=null;
    await submitPrompt('Delete this running chat');
    await until(()=>provider.finish!==null);
    const deletedId=sessions.list()[0].id;
    assert.equal(agent.isRunning(deletedId),true);
    await win.assistant.webContents.executeJavaScript(`window.nabsun.sessions.remove(${JSON.stringify(deletedId)})`);
    await until(()=>!agent.isRunning(deletedId));
    assert.equal(sessions.load(deletedId),null);
    assert.throws(()=>sessions.upsert(deletedId,{id:'late-result',role:'assistant',createdAt:Date.now(),blocks:[{type:'text',text:'late text'}]}),/deleted/);
    assert.throws(()=>sessions.appendBestEffort(deletedId,{id:'late-user',role:'user',createdAt:Date.now(),blocks:[{type:'text',text:'queued text'}]}),/deleted/);
    assert.equal(sessions.load(deletedId),null,'late history writes cannot resurrect a deleted chat');
    assert.equal(fs.existsSync(path.join(tmp,'sessions',deletedId+'.json')),false);
    console.log('PASS deleting an active chat cancels its work and late writes cannot recreate its history');

    win.toggleSidebar(false);
    win.send(CH.overlayCommand, { command: 'open-downloads' });
    await until(() => win.assistant.webContents.executeJavaScript('document.querySelector("#view-downloads").classList.contains("active")'));
    assert.equal(win.assistant.isVisible(), true);
    console.log('PASS browser commands reopen and target the assistant');

    // A CLI wrapper whose child inherits its pipes reproduced the stuck Stop.
    fs.writeFileSync(path.join(tmp, 'cli.cjs'), `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true});fs.writeFileSync(${JSON.stringify(path.join(tmp, 'pids.json'))},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const fixture = new FixtureCli(() => ({ url: 'http://127.0.0.1:1', token: 'fixture', serverScript: '' }), () => '');
    const stream = fixture.stream({ model: '', system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }], tools: [], maxTokens: 10, thinking: false, signal: controller.signal });
    const consuming = (async () => { try { for await (const _ of stream) {} return false; } catch { return controller.signal.aborted; } })();
    await until(() => fs.existsSync(path.join(tmp, 'pids.json')));
    const pids: number[] = JSON.parse(fs.readFileSync(path.join(tmp, 'pids.json'), 'utf8'));
    controller.abort();
    assert.equal(await Promise.race([consuming, delay(2000).then(() => false)]), true, 'cancellation does not wait for inherited pipes to close');
    await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }));
    console.log('PASS CLI cancellation returns promptly and terminates wrapper and child');
    const closedState = win.state;
    const closedBounds = win.contentBounds;
    let lateUpdates = 0;
    const countLateUpdate = () => lateUpdates++;
    win.tabs.on('update', countLateUpdate);
    // Reproduce a Chromium update queued immediately before the window closes.
    win.tabs.emitUpdate();
    win.window.destroy();
    assert.doesNotThrow(() => {
      win.pushState();
      win.layout();
      win.send(CH.windowState, closedState);
      win.send(CH.agentApprovalRequest, {});
      win.openWorkspace('settings');
      win.readyShell();
      win.readyAssistant();
      win.toggleSidebar(true);
      win.setAssistantDetached(false);
      win.zoomAssistant(0.1);
      win.showOverlay('omnibox', {});
      win.hideOverlay();
      win.applySettings(settings.get());
      win.tabs.emitUpdate();
      win.tabs.pageDevTools('toggle');
    }, 'late UI callbacks after destruction must be harmless');
    assert.deepEqual(win.state, closedState, 'closed windows expose their last safe state');
    assert.deepEqual(win.contentBounds, closedBounds, 'late coordinate reads do not touch a destroyed window');
    await delay(80);
    assert.equal(lateUpdates, 0, 'teardown cancels coalesced updates and prevents rescheduling');
    win.tabs.off('update', countLateUpdate);
    console.log('PASS close during a pending update cancels timers and safely ignores late window callbacks');
  } finally {
    agent.stop();
    if (!win.window.isDestroyed()) win.window.destroy();
    settings.flush();
    history.flush();
    await mcp.shutdown();
  }
}
void main().then(() => app.exit(0), err => { console.error(err); app.exit(1); });
