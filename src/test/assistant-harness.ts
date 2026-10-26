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

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-assistant-test-'));
app.setPath('userData', tmp);
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
  const agent = new Agent({ providers, settings, sessions, tabs: win.tabs, history, approvals, questions,
    getTools: () => [], userDataPath: tmp, emit: event => win.send(CH.agentEvent, event) });
  const mcp = new McpManager();
  registerIpc({ win, settings, sessions, history, providers, approvals, questions, agent, mcp,
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
    await until(() => win.assistant.isVisible());
    const sessionCount = () => fs.readdirSync(path.join(tmp, 'sessions')).filter(name => name.endsWith('.json')).length;
    assert.equal(sessionCount(), 1, 'only the assistant creates a chat');
    assert.equal(win.contentBounds.width, win.window.getContentSize()[0], 'browser retains its full width');
    assert.equal(await win.assistant.webContents.executeJavaScript('getComputedStyle(document.querySelector("#topchrome")).display'), 'none');
    console.log('PASS separate assistant window and full-width browser');

    await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value = "Preserved draft"; document.querySelector("#assistant-zoom-in").click()');
    await until(() => settings.get().assistantZoom === 1.1);
    assert.equal(win.shell.webContents.getZoomFactor(), 1, 'assistant zoom leaves browser chrome unchanged');
    win.assistant.close();
    assert.equal(win.assistant.isDestroyed(), false);
    assert.equal(win.assistant.isVisible(), false);
    win.toggleSidebar(true);
    assert.equal(await win.assistant.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Preserved draft');
    settings.flush();
    assert.equal(new SettingsStore().get().assistantZoom, 1.1);
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
  } finally {
    agent.stop();
    win.window.destroy();
    settings.flush();
    history.flush();
    await mcp.shutdown();
  }
}
void main().then(() => app.exit(0), err => { console.error(err); app.exit(1); });
