import type {DataWorkspace} from './data/workspace';
import type {SitePermissions} from './sitePermissions';
import {VoiceManager} from './voice';
import {applyBrowserNetwork,defaultNetwork,validateNetwork} from './browserNetwork';
import {csvReport} from './data/batches';
import {readJson} from './data/storage';
import type {Workflow} from '../shared/workflows';
import fs from 'node:fs';
import path from 'node:path';
import { app, dialog, session, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import { uiIpc } from './uiSecurity';
import { UpdateChecker, RELEASE_PAGE } from './updates';
import { CH } from '../shared/ipc';
import { approvalMode, approvalSettings } from '../shared/assistantSettings';
import type {
  ApprovalDecision,
  Bookmark,
  BridgeInfo,
  ChromeExtensionEntry,
  ClearDataRequest,
  ConfigActionResult,
  ConfigPaths,
  McpServerConfig,
  ProviderId,
  ProviderStatus,
  Settings,
} from '../shared/types';
import { CLI_PROVIDERS } from '../shared/types';
import { DEFAULT_SETTINGS, NoSecureStorageError } from './store';
import { SoulStore, soulPath } from './soul';
import type { Agent } from './ai/agent';
import { PromptQueue } from './ai/promptQueue';
import type { ApprovalManager } from './ai/approvals';
import type { QuestionManager } from './ai/questions';
import type { Provider } from './ai/provider';
import type { SessionStore } from './ai/sessions';
import type { AppWindow } from './appWindow';
import { buildSuggestions, resolveNavigationInput, type HistoryStore } from './history';
import type { McpManager } from './integrations/mcp';
import type { DownloadManager } from './downloads';
import { listAgentExtensions } from './integrations/agentExtensions';
import type { CliAccountManager } from './integrations/cliAccounts';
import type { ChromeExtensionManager } from './integrations/extensions';
import type { PluginManager } from './integrations/plugins';
import type { PasswordStore } from './passwords';
import type { SecretStore, SettingsStore } from './store';

export interface IpcDeps {
  folderAccess?:import('./localFiles').FolderAccessController;
  voice?:VoiceManager;
  sitePermissions?:SitePermissions;
  win: AppWindow;
  dataWorkspace?:DataWorkspace;
  settings: SettingsStore;
  secrets: SecretStore;
  history: HistoryStore;
  sessions: SessionStore;
  agent: Agent;
  approvals: ApprovalManager;
  questions: QuestionManager;
  mcp: McpManager;
  plugins: PluginManager;
  downloads: DownloadManager;
  extensions: ChromeExtensionManager;
  accounts: CliAccountManager;
  passwords: PasswordStore;
  providers: Map<ProviderId, Provider>;
  reloadIntegrations: () => Promise<void>;
  /** Connection details for external agents; see BrowserBridgeServer. */
  bridgeInfo: () => { running: boolean; url: string; token: string; serverScript: string };
}

export function registerIpc(deps: IpcDeps): void {
  const { win, settings, secrets, history, sessions, agent, approvals, questions, mcp, plugins, providers, downloads, extensions, accounts, passwords } =
    deps;
  const ipcMain = uiIpc([
    {
      contents: win.assistant.webContents,
      url: pathToFileURL(path.join(__dirname, '..', 'renderer', 'shell', 'index.html')).href,
    },
    {
      contents: win.shell.webContents,
      url: pathToFileURL(path.join(__dirname, '..', 'renderer', 'shell', 'index.html')).href,
    },
    {
      contents: win.overlay.webContents,
      url: pathToFileURL(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html')).href,
      channels: new Set([CH.omniboxSuggest, CH.overlayCommand, CH.overlayClose]),
    },
  ]);

  const updates = new UpdateChecker(app.getVersion());
  const voice=deps.voice??new VoiceManager();
  for(const contents of [win.assistant.webContents,win.shell.webContents]){const owner=contents.id;contents.once('destroyed',()=>voice.stop(owner))}
  win.window.once('closed',()=>voice.stop());
  win.assistant.on('hide',()=>voice.stop());
  win.assistant.on('minimize',()=>voice.stop());
  win.window.on('minimize',()=>voice.stop());
  ipcMain.handle(CH.voiceAvailability,()=>voice.availability());
  ipcMain.handle(CH.voiceStart,async(event,sessionId:string,requestId:string,language:string)=>{
    if(!sessions.load(sessionId))throw Error('Open a chat before starting dictation.');
    await voice.start(event.sender.id,sessionId,requestId,language,payload=>{if(!event.sender.isDestroyed())event.sender.send(CH.voiceEvent,payload)},async()=>{
      const choice=await dialog.showMessageBox({type:'question',title:'Use microphone for this chat?',message:'Speak to draft your message',detail:'Nabsun will use Windows speech recognition on this computer for up to one minute. Audio is not sent to your AI provider or saved by Nabsun. Review the words and press Send yourself.',buttons:['Cancel','Start dictation'],defaultId:0,cancelId:0,noLink:true});
      return choice.response===1&&!!sessions.load(sessionId)&&!event.sender.isDestroyed();
    });
  });
  ipcMain.on(CH.voiceStop,(event,requestId:string)=>voice.stop(event.sender.id,requestId));
  ipcMain.handle(CH.updateCheck, (_event, manual?: boolean) => updates.check(manual === true));
  ipcMain.handle(CH.updateOpen, () => shell.openExternal(RELEASE_PAGE));

  /* ---------------------------------------------------------------- tabs */

  ipcMain.handle(CH.tabNew, (_e, url?: string, opts?: { background?: boolean }) => {
    if (!opts?.background && _e.sender === win.shell.webContents) win.openWorkspace(null);
    return win.tabs.create(url, { background: opts?.background }).id;
  });
  ipcMain.on(CH.tabClose, (_e, id: string) => win.tabs.close(id));
  ipcMain.on(CH.tabActivate, (_e, id: string) => {
    win.openWorkspace(null);
    win.tabs.activate(id);
    // The user moved: a running assistant follows them rather than staying on
    // a tab it picked earlier.
    agent.userSwitchedTab();
  });
  ipcMain.on(CH.tabReorder, (_e, id: string, index: number) => win.tabs.reorder(id, index));
  ipcMain.on(CH.tabNavigate, (_e, id: string, input: string) => {
    if(typeof input==='string'&&/^nabsun:\/\/activity\/?$/i.test(input.trim())){win.openWorkspace('activity');return}
    win.openWorkspace(null);
    win.tabs.navigate(id, resolveNavigationInput(input, settings.get().searchEngine));
  });
  ipcMain.on(CH.tabBack, (_e, id: string) => {
    const wc = win.tabs.byId(id)?.wc;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  });
  ipcMain.on(CH.tabForward, (_e, id: string) => {
    const wc = win.tabs.byId(id)?.wc;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  });
  ipcMain.on(CH.tabReload, (_e, id: string, hard?: boolean) => {
    const wc = win.tabs.byId(id)?.wc;
    if (hard) wc?.reloadIgnoringCache();
    else wc?.reload();
  });
  ipcMain.on(CH.tabStop, (_e, id: string) => win.tabs.byId(id)?.wc.stop());
  ipcMain.on(CH.tabMute, (_e, id: string, muted: boolean) => {
    win.tabs.byId(id)?.wc.setAudioMuted(muted);
    win.tabs.emitUpdate();
  });
  ipcMain.on(CH.tabPin, (_e, id: string, pinned: boolean) => {
    const tab = win.tabs.byId(id);
    if (tab) {
      tab.pinned = pinned;
      win.tabs.emitUpdate();
    }
  });
  ipcMain.on(CH.tabDuplicate, (_e, id: string) => win.tabs.duplicate(id));

  /* -------------------------------------------------------------- window */

  ipcMain.on(CH.winMinimize, () => win.window.minimize());
  ipcMain.on(CH.winMaximize, () => {
    if (win.window.isMaximized()) win.window.unmaximize();
    else win.window.maximize();
  });
  ipcMain.on(CH.winClose, () => win.window.close());
  ipcMain.on(CH.sidebarToggle, (_e, open?: boolean) => {voice.stop();win.toggleSidebar(open)});
  ipcMain.on(CH.sidebarResize, (_e, width: number) => win.resizeSidebar(width));
  ipcMain.on(CH.starterPrompt, (_e, prompt: unknown) => {
    if (typeof prompt === 'string' && prompt.length <= 2000) win.showAssistantCommand({ command: 'prefill-prompt', arg: prompt });
  });
  ipcMain.on(CH.workspace, (_e, name: unknown) => {
    voice.stop();
    if (name === null || name === 'settings' || name === 'onboarding' || name === 'workflows' || name === 'activity') win.openWorkspace(name);
  });
  ipcMain.on(CH.pageDevTools, (_e, action: unknown) => {
    if (action === 'toggle' || action === 'detach') {
      win.openWorkspace(null);
      win.tabs.pageDevTools(action);
    }
  });
  ipcMain.on(CH.assistantView, (_e, name: string) => {
    if (['chat', 'history', 'settings', 'extensions', 'bookmarks', 'passwords', 'downloads', 'onboarding'].includes(name)) {
      win.showAssistantCommand({ command: 'show-view', arg: name });
    }
  });
  ipcMain.on(CH.assistantZoom, (_e, delta: number | null) => {
    if (delta === null || delta === 0.1 || delta === -0.1) win.zoomAssistant(delta);
  });
  ipcMain.on(CH.assistantDetach, (_e, detached: boolean) => {
    if (typeof detached === 'boolean') win.setAssistantDetached(detached);
  });
  ipcMain.on(CH.shellReady, (event) => {
    if (event.sender === win.assistant.webContents) win.readyAssistant();
    else win.readyShell();
  });

  /* ---------------------------------------------------------------- find */

  ipcMain.on(CH.findStart, (_e, query: string) => {
    win.setFindOpen(true);
    win.tabs.find(query, true, false);
  });
  ipcMain.on(CH.findNext, (_e, forward: boolean) => win.tabs.find('', forward, true));
  ipcMain.on(CH.findStop, () => win.setFindOpen(false));

  /* ------------------------------------------------------------- omnibox */

  ipcMain.handle(CH.omniboxSuggest, (_e, query: string) =>
    buildSuggestions(query, history, settings.get()),
  );

  ipcMain.on(CH.overlayShow, (_e, kind: 'omnibox' | 'palette', payload?: unknown) => {
    win.showOverlay(kind,kind==='palette'?{...(payload&&typeof payload==='object'?payload:{}),workflows:deps.dataWorkspace?.workflows.list().map(({id,name})=>({id,name}))??[]}:payload??{});
  });
  ipcMain.on(CH.overlayClose, () => win.hideOverlay());
  ipcMain.on(CH.overlayCommand, (_e, command: string, arg?: unknown) => {
    win.hideOverlay();
    handleCommand(deps, command, arg);
  });

  /* --------------------------------------------------------------- agent */

  const promptQueue = new PromptQueue({
    send: (sessionId, prompt) => agent.send(sessionId, prompt.text, { attachPage: prompt.attachPage }),
    changed: state => win.send(CH.agentEvent, { type: 'queue_changed', state }),
    started: (sessionId, prompt) => win.send(CH.agentEvent, { type: 'prompt_started', sessionId, prompt }),
  });

  ipcMain.on(CH.agentSend, (_e, sessionId: string, text: string, opts?: { attachPage?: boolean }) => {
    if (!sessions.load(sessionId) || typeof text !== 'string') return;
    promptQueue.submit(sessionId, text, opts?.attachPage === true);
  });
  ipcMain.on(CH.agentAbort, () => {
    promptQueue.clear();
    agent.stop();
  });
  ipcMain.handle(CH.agentQueue, (_e, sessionId: string) => promptQueue.get(sessionId));
  ipcMain.handle(CH.agentCancelQueued, (_e, sessionId: string, id: string) => promptQueue.cancel(sessionId, id));
  ipcMain.handle(CH.agentTools, () => agent.toolSpecs());
  ipcMain.on(CH.agentApprovalResolve, (_e, id: string, decision: ApprovalDecision) => {
    approvals.resolve(id, decision);
  });
  ipcMain.handle(CH.agentSessionGrants, (_event,sessionId:string) => sessions.load(sessionId)?approvals.grantsForSession(sessionId):[]);
  ipcMain.handle(CH.agentRevokeSessionTool, (_event,sessionId:string,toolName:string,source?:string) => {
    if(typeof sessionId!=='string'||typeof toolName!=='string'||(source!==undefined&&typeof source!=='string'))throw Error('Invalid permission.');
    approvals.revokeSessionTool(sessionId,toolName,source);
  });
  ipcMain.on(CH.agentAnswer, (_e, id: string, text: string | null) => {
    questions.answer(id, typeof text === 'string' ? text : null);
  });

  ipcMain.handle(CH.localFolderList,(_event,scope:string)=>sessions.load(scope)?deps.folderAccess?.store.list(scope,true)??[]:[]);
  ipcMain.handle(CH.localFolderChoose,async(event,scope:string)=>{
    if(!sessions.load(scope)||!deps.folderAccess)throw Error('Open a chat before choosing a folder.');
    const controller=new AbortController(),abort=()=>controller.abort();
    event.sender.once('destroyed',abort);
    try{return await deps.folderAccess.request(scope,'Work with files in this chat',controller.signal)}
    finally{if(!event.sender.isDestroyed())event.sender.removeListener('destroyed',abort)}
  });
  ipcMain.handle(CH.localFolderRevoke,(_event,scope:string,id:string)=>{
    if(!sessions.load(scope)||!deps.folderAccess)return;
    deps.folderAccess.store.revoke(scope,id);promptQueue.clear(scope);agent.cancelScope(scope);
    win.send(CH.localFolderChanged,{sessionId:scope});
  });
  ipcMain.handle(CH.fileList,(_event,sessionId:string)=>sessions.load(sessionId)?agent.files?.list(sessionId)??[]:[]);
  ipcMain.handle(CH.filePreview,(_event,sessionId:string,id:string)=>{
    if(!sessions.load(sessionId)||!agent.files)throw Error('Chat not found.');
    if(!agent.files.isImage(sessionId,id))return null;
    const image=agent.files.image(sessionId,id,true);return `data:${image.mediaType};base64,${image.data}`;
  });
  ipcMain.handle(CH.fileAttach,async(_event,sessionId:string)=>{
    if(!sessions.load(sessionId)||!agent.files)throw Error('Open a chat before attaching files.');
    const selection=await dialog.showOpenDialog({title:'Attach files to this chat',properties:['openFile','multiSelections']});
    if(!selection.canceled)for(const file of selection.filePaths){if(!sessions.load(sessionId))throw Error('This chat was closed.');agent.files.attach(sessionId,file)}
    return agent.files.list(sessionId);
  });
  ipcMain.handle(CH.fileRemove,(_event,sessionId:string,id:string)=>{if(!sessions.load(sessionId))throw Error('Chat not found.');agent.files?.remove(sessionId,id)});

  const data=()=>{if(!deps.dataWorkspace)throw Error('Data workspace is unavailable.');return deps.dataWorkspace};
  ipcMain.handle(CH.dataOpen,async(_event,scope:string,workflowId?:string)=>{await data().open(scope);win.send(CH.workflowScope,{scope,workflowId});win.openWorkspace('workflows')});
  ipcMain.handle(CH.dataContext,()=>deps.dataWorkspace?.scope??null);
  ipcMain.handle(CH.dataList,(_event,scope:string)=>{data().check(scope);return data().datasets.list(scope)});
  ipcMain.handle(CH.dataPreview,(_event,scope:string,id:string)=>{data().check(scope);return data().datasets.get(scope,id).rows.slice(0,5)});
  ipcMain.handle(CH.dataAttach,async(_event,scope:string)=>{
    data().check(scope);if(!agent.files)throw Error('Attachments are unavailable.');
    const selected=await dialog.showOpenDialog({title:'Add a table',properties:['openFile'],filters:[{name:'Tables',extensions:['csv','tsv','xlsx']}]});
    if(selected.canceled)return null;const file=agent.files.attach(scope,selected.filePaths[0]);
    try{return await data().datasets.fromFile(scope,file.id)}finally{agent.files.remove(scope,file.id)}
  });
  ipcMain.handle(CH.dataPaste,(_event,scope:string,text:string,name:string)=>{data().check(scope);if(typeof text!=='string'||typeof name!=='string')throw Error('Invalid pasted table.');return data().datasets.paste(scope,text,name)});
  ipcMain.handle(CH.workflowList,()=>deps.dataWorkspace?.workflows.list()??[]);
  ipcMain.handle(CH.sitePermissionsList,()=>deps.sitePermissions?.list()??[]);
  ipcMain.handle(CH.activityList,(_event,day?:string)=>{const store=agent.activityStore();store.verify();const days=store.days();return {days,records:days.length?store.records(day??days.at(-1)!):[]}});
  ipcMain.handle(CH.activityExport,async(_event,day:string)=>{const store=agent.activityStore();if(!store.days().includes(day))throw Error('Activity day not found.');const selected=await dialog.showSaveDialog({title:'Export activity journal',defaultPath:'nabsun-activity-'+day+'.jsonl',filters:[{name:'Activity journal',extensions:['jsonl']}]});if(!selected.canceled&&selected.filePath)store.exportDay(day,selected.filePath)});
  ipcMain.handle(CH.sitePermissionsRevoke,(_event,origin?:string)=>{if(origin!==undefined&&typeof origin!=='string')throw Error('Invalid origin.');deps.sitePermissions?.revoke(origin)});
  ipcMain.handle(CH.workflowTrace,(_event,scope:string)=>{data().check(scope);return agent.recordedTask(scope)});
  ipcMain.handle(CH.workflowSave,(_event,scope:string,name:string,successText:string,datasetId?:string,variables?:Record<string,string>)=>data().saveTrace(scope,name,successText,datasetId,variables));
  ipcMain.handle(CH.workflowUpdate,(_event,workflow:Workflow)=>data().workflows.save(workflow));
  ipcMain.handle(CH.workflowImport,async()=>{const selected=await dialog.showOpenDialog({title:'Import workflow',properties:['openFile'],filters:[{name:'Workflow JSON',extensions:['json']}]});if(selected.canceled)return null;return data().workflows.import(readJson(selected.filePaths[0],1024*1024))});
  ipcMain.handle(CH.workflowExport,async(_event,id:string)=>{const workflow=data().workflows.get(id);const selected=await dialog.showSaveDialog({title:'Export workflow',defaultPath:'nabsun-workflow.json',filters:[{name:'Workflow JSON',extensions:['json']}]});if(!selected.canceled&&selected.filePath)await fs.promises.writeFile(selected.filePath,JSON.stringify(workflow,null,2),{mode:0o600})});
  ipcMain.handle(CH.batchList,(_event,scope:string)=>{data().check(scope);return data().batches.list(scope)});
  ipcMain.handle(CH.batchStart,(_event,spec:Parameters<DataWorkspace['start']>[0])=>{data().check(spec.scope);win.openWorkspace(null);try{return data().start(spec)}catch(error){win.openWorkspace('workflows');throw error}});
  ipcMain.handle(CH.batchControl,async(_event,scope:string,id:string,action:string)=>{data().check(scope);switch(action){case 'pause':return data().runner.pause(scope,id);case 'resume':win.openWorkspace(null);try{return data().runner.resume(scope,id)}catch(error){win.openWorkspace('workflows');throw error}case 'stop':return data().runner.stop(scope,id);case 'skip':return data().runner.skip(scope,id);case 'complete':return data().runner.markComplete(scope,id);case 'review-skip':return data().runner.reconcile(scope,id,'skip');case 'retry':return data().runner.reconcile(scope,id,'retry');default:throw Error('Unknown batch action.')}});
  ipcMain.handle(CH.batchReport,(_event,scope:string,id:string)=>{data().check(scope);const batch=data().batches.get(scope,id);const start=Math.max(0,Math.min(batch.cursor-10,batch.rowCount-50));const rows=Array.from({length:Math.min(50,batch.rowCount)},(_,index)=>data().batches.row(batch,start+index+1)??{row:start+index+1,status:'pending',steps:0,durationMs:0,inputTokens:0,outputTokens:0,modelCalls:0,repairs:0,targets:[]});return {batch,rows:rows.map(row=>({...row,entries:('entries' in row?row.entries:undefined)?.map(entry=>({...entry,value:entry.value.slice(0,500)}))}))}});
  ipcMain.handle(CH.batchExport,async(_event,scope:string,id:string,format:string)=>{
    data().check(scope);if(!['csv','json'].includes(format))throw Error('Unsupported report format.');const batch=data().batches.get(scope,id),chunks:string[]=[];let bytes=0;
    for(let row=1;row<=batch.rowCount;row++){
      const file=path.join(data().batches.dir,batch.id,'rows',row+'.json');let record:unknown;
      try{record=JSON.parse(await fs.promises.readFile(file,'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;record={row,status:'pending',steps:0,durationMs:0,inputTokens:0,outputTokens:0,modelCalls:0,repairs:0,targets:[]}}
      const chunk=format==='csv'?csvReport({batch,rows:[record as ReturnType<DataWorkspace['batches']['report']>['rows'][0]]}).split('\n').slice(row===1?0:1).filter(Boolean).join('\n')+'\n':JSON.stringify(record);
      bytes+=Buffer.byteLength(chunk);if(bytes>50*1024*1024)throw Error('Report exceeds the 50 MB export limit.');chunks.push(chunk);
    }
    const text=format==='csv'?chunks.join(''):'{"batch":'+JSON.stringify(batch)+',"rows":['+chunks.join(',')+']}';
    const selected=await dialog.showSaveDialog({title:'Export run report',defaultPath:'nabsun-run.'+format,filters:[{name:'Run report',extensions:[format]}]});if(!selected.canceled&&selected.filePath)await fs.promises.writeFile(selected.filePath,text,{mode:0o600});
  });

  /* ------------------------------------------------------------ sessions */

  ipcMain.handle(CH.sessionList, () => sessions.list());
  ipcMain.handle(CH.sessionLoad, (_e, id: string) => {const loaded=sessions.load(id);if(loaded&&deps.dataWorkspace&&_e.sender===win.assistant.webContents)deps.dataWorkspace.scope=id;return loaded});
  ipcMain.handle(CH.sessionNew, (_e) => {const created=sessions.create();if(deps.dataWorkspace&&_e.sender===win.assistant.webContents)deps.dataWorkspace.scope=created.id;return created});
  ipcMain.handle(CH.sessionDelete, (_e, id: string) => {
    voice.stopSession(id);
    approvals.clearSession(id);
    deps.folderAccess?.store.clear(id);
    promptQueue.clear(id);
    agent.cancelScope(id,'Stopped because this chat was deleted.');
    sessions.remove(id);
    win.send(CH.localFolderChanged,{sessionId:id});
  });
  ipcMain.handle(CH.sessionRename, (_e, id: string, title: string) => sessions.rename(id, title));

  /* ------------------------------------------------------------ settings */

  ipcMain.handle(CH.settingsGet, () => settings.get());
  ipcMain.handle(CH.settingsSet, async (_e, patch: Partial<Settings>) => {
    if(patch.integrationControls&&(['plugins','mcp','extensions'].some(key=>typeof (patch.integrationControls as unknown as Record<string,unknown>)[key]!=='boolean')||Object.keys(patch.integrationControls).some(key=>!['plugins','mcp','extensions'].includes(key))))throw Error('Invalid integration controls.');
    if(patch.auditRetentionDays!==undefined&&(!Number.isInteger(patch.auditRetentionDays)||patch.auditRetentionDays<7||patch.auditRetentionDays>365))throw Error('Choose 7 to 365 activity retention days.');
    const before = settings.get();
    if (patch.showApprovalMessages !== undefined && typeof patch.showApprovalMessages !== 'boolean') throw Error('Invalid approval display setting.');
    if (patch.approvalMode !== undefined) {
      if (!['ask', 'automatic', 'full'].includes(patch.approvalMode)) throw Error('Invalid approval mode.');
      patch = { ...patch, ...approvalSettings(patch.approvalMode) };
    } else if (patch.autoApprove) {
      // Legacy controls cannot accidentally preserve unrestricted access.
      patch = { ...patch, approvalMode: patch.autoApprove.write ? 'automatic' : 'ask', autoApprove: { ...patch.autoApprove, dangerous: false } };
    }
    if (patch.approvalMode && patch.approvalMode !== approvalMode(before)) patch.siteToolGrants = [];
    if(patch.browserNetwork){patch={...patch,browserNetwork:validateNetwork(patch.browserNetwork)};await applyBrowserNetwork(session.fromPartition('persist:nabsun'),patch.browserNetwork!)}
    let next:Settings;
    try{next=settings.save(patch)}catch(error){if(patch.browserNetwork)await applyBrowserNetwork(session.fromPartition('persist:nabsun'),before.browserNetwork??defaultNetwork);throw error}
    if (patch.approvalMode && patch.approvalMode !== approvalMode(before)) approvals.resetGrants();
    win.applySettings(next);
    if (patch.mcpServers && JSON.stringify(before.mcpServers) !== JSON.stringify(next.mcpServers)) {
      await deps.reloadIntegrations();
    }
    if(patch.integrationControls&&JSON.stringify(before.integrationControls)!==JSON.stringify(next.integrationControls)){await deps.reloadIntegrations();win.hideExtensionPopup();await extensions.loadAll();win.send(CH.extChanged,extensions.status())}
    return next;
  });

  ipcMain.handle(CH.credsStatus, async (): Promise<ProviderStatus[]> => {
    const out: ProviderStatus[] = [];
    for (const [id, provider] of providers) {
      if (CLI_PROVIDERS.includes(id)) {
        // A CLI backend needs no key: it authenticates with its own login.
        const found = provider.binaryPath ?? null;
        out.push({
          id,
          label: provider.label,
          kind: 'cli',
          hasCredentials: Boolean(found),
          models: [],
          detail: found ?? 'Not found',
        });
        continue;
      }
      if (id === 'local') {
        // Nothing to authenticate. What it does need is the weights on disk, so
        // report that instead — it is the thing that can actually be missing.
        const local = provider as {
          installed?: boolean;
          modelPath?: string | null;
          pendingRestart?: string[];
        };
        const ready = local.installed === true;
        // Settings that have been changed but are not in force. Saying so beats
        // displaying a value the running server is not using.
        const pending = local.pendingRestart ?? [];
        out.push({
          id,
          label: provider.label,
          kind: 'local',
          hasCredentials: ready,
          models: ready ? await provider.listModels().catch(() => []) : [],
          detail: !ready
            ? 'Model not downloaded — run `npm run fetch:model`'
            : pending.length
              ? `Running. ${pending.join(', ')} changed — restart Nabsun to apply.`
              : (local.modelPath ?? 'Ready'),
        });
        continue;
      }
      const hasCredentials = id === 'ollama' ? true : secrets.has(id);
      out.push({
        id,
        label: provider.label,
        kind: 'api',
        hasCredentials,
        // Only probe the network for a provider we can actually authenticate to.
        models: hasCredentials ? await provider.listModels().catch(() => []) : [],
      });
    }
    return out;
  });

  ipcMain.handle(CH.bridgeInfo, (): BridgeInfo => {
    const info = deps.bridgeInfo();
    const config = {
      mcpServers: {
        nabsun: {
          command: 'node',
          args: [info.serverScript],
          env: {
            NABSUN_BRIDGE_URL: info.url,
            NABSUN_BRIDGE_TOKEN: info.token,
          },
        },
      },
    };
    return { ...info, configJson: JSON.stringify(config, null, 2) };
  });
  // Returns the outcome rather than throwing: without a keychain the key is
  // held for the session only, and the user needs to be told that, not shown a
  // failed IPC call.
  ipcMain.handle(CH.credsSet, (_e, provider: ProviderId, key: string) => {
    const endpoint = endpointFor(settings, provider);
    try {
      secrets.set(provider, key, endpoint);
      return { ok: true };
    } catch (err) {
      if (err instanceof NoSecureStorageError) {
        return { ok: false, sessionOnly: true, error: err.message };
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(CH.credsClear, (_e, provider: ProviderId) => secrets.clear(provider));

  /* ----------------------------------------------------------- config file */

  const configPaths = (): ConfigPaths => ({
    userData: app.getPath('userData'),
    configFile: path.join(app.getPath('userData'), 'settings.json'),
    pluginsDir: plugins.directory,
    sessionsDir: path.join(app.getPath('userData'), 'sessions'),
    soulFile: soulPath(app.getPath('userData')),
  });

  ipcMain.handle(CH.configPaths, () => configPaths());
  ipcMain.on(CH.configOpenFolder, () => void shell.openPath(app.getPath('userData')));

  // Opening soul.md writes the starter file first: the point of the button is
  // to land the user in an editor, and opening a path that does not exist does
  // nothing at all on every platform.
  ipcMain.on(CH.soulOpen, () => {
    const soul = new SoulStore(app.getPath('userData'));
    soul.ensure();
    void shell.openPath(soul.file);
  });

  ipcMain.handle(CH.configExport, async (): Promise<ConfigActionResult> => {
    const result = await dialog.showSaveDialog(win.window, {
      title: 'Export Nabsun configuration',
      defaultPath: `nabsun-config-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    try {
      // Credentials are deliberately excluded: an exported file is meant to be
      // copied between machines, and secrets should not travel in plaintext.
      // API keys were never in `settings`, but MCP server `env` blocks are, and
      // that is exactly where a token for such a server lives.
      const payload = {
        _comment:
          'Nabsun configuration. Secrets are NOT included: MCP environment values and ' +
          'ALL command-line argument values are blanked, so you must fill them in after ' +
          'importing. Executable paths and provider endpoints are not imported at all, and ' +
          'MCP servers and Chrome extensions arrive disabled.',
        version: app.getVersion(),
        exportedAt: new Date().toISOString(),
        settings: withoutSecrets(settings.get()),
      };
      fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(CH.configImport, async (): Promise<ConfigActionResult> => {
    const result = await dialog.showOpenDialog(win.window, {
      title: 'Import Nabsun configuration',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
    try {
      const raw = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8')) as {
        settings?: Partial<Settings>;
      };
      // Accept either a wrapped export or a bare settings object.
      const incoming = raw.settings ?? (raw as Partial<Settings>);
      const clean = sanitizeSettings(incoming);
      if (!Object.keys(clean).length) {
        return { ok: false, error: 'That file contains no recognisable settings.' };
      }
      const next = settings.save(clean);
      win.applySettings(next);
      await deps.reloadIntegrations();
      return { ok: true, path: result.filePaths[0], settings: next };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(CH.configReset, async () => {
    const next = settings.reset();
    win.applySettings(next);
    await deps.reloadIntegrations();
    return next;
  });

  /* ----------------------------------------------------------- extensions */

  const pushExtensions = () => win.send(CH.extChanged, extensions.status());

  ipcMain.handle(CH.extList, () => extensions.status());

  ipcMain.handle(CH.extAdd, async () => {
    const result = await dialog.showOpenDialog(win.window, {
      title: 'Add an unpacked extension',
      message: 'Choose the folder containing the extension’s manifest.json',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };

    const dir = result.filePaths[0];
    const current = settings.get().chromeExtensions;
    if (current.some((e) => e.path === dir)) {
      return { ok: false, error: 'That extension has already been added.' };
    }

    const loaded = await extensions.add(dir);
    if (!loaded.ok) return loaded;

    settings.set({ chromeExtensions: [...current, { path: dir, enabled: true }] });
    pushExtensions();
    return loaded;
  });

  ipcMain.handle(CH.extRemove, async (_e, extPath: string) => {
    const ext = extensions.status().find((s) => s.path === extPath);
    if (ext?.id) extensions.remove(ext.id);
    settings.set({
      chromeExtensions: settings.get().chromeExtensions.filter((e) => e.path !== extPath),
    });
    pushExtensions();
    return extensions.status();
  });

  ipcMain.handle(CH.extToggle, async (_e, extPath: string, enabled: boolean) => {
    settings.set({
      chromeExtensions: settings
        .get()
        .chromeExtensions.map((e) => (e.path === extPath ? { ...e, enabled } : e)),
    });
    // Chromium has no "disable" — enabling and disabling is load and unload.
    await extensions.loadAll();
    pushExtensions();
    return extensions.status();
  });

  ipcMain.handle(CH.extReload, async () => {
    await extensions.loadAll();
    pushExtensions();
    return extensions.status();
  });

  ipcMain.on(CH.extOpenFolder, (_e, extPath: string) => void shell.openPath(extPath));

  ipcMain.on(CH.extAction, (_e, id: string, anchorX: number) => {
    win.showExtensionPopup(id, anchorX);
  });

  /* ---------------------------------------------------- agent extensions */

  ipcMain.handle(CH.agentExtList, () =>
    listAgentExtensions(settings.get(), providers, secrets),
  );

  ipcMain.handle(CH.agentExtActivate, (_e, id: ProviderId) => {
    settings.set({ provider: id });
    return listAgentExtensions(settings.get(), providers, secrets);
  });

  /* -------------------------------------------------------------- accounts */

  ipcMain.handle(CH.acctStatus, (_e, id: ProviderId) => accounts.status(id));
  ipcMain.on(CH.acctLogin, (_e, id: ProviderId, mode: 'browser' | 'device' | 'apiKey' | 'repair', key?: string) => {
    void accounts.login(id, mode, key);
  });
  ipcMain.handle(CH.acctLogout, (_e, id: ProviderId) => accounts.logout(id));
  ipcMain.on(CH.acctCancel, (_e, id: ProviderId) => accounts.cancel(id));

  /* -------------------------------------------------------- integrations */

  ipcMain.handle(CH.mcpStatus, () => mcp.status(settings.get().mcpServers));
  ipcMain.handle(CH.mcpApprove,async(_event,name:string,fingerprint:string)=>{
    const server=mcp.status(settings.get().mcpServers).find(server=>server.name===name);
    if(!server||server.fingerprint!==fingerprint||!fingerprint)throw Error('MCP configuration changed. Reload and review it again.');
    const answer=await dialog.showMessageBox({type:'question',title:'Approve MCP server',message:`Allow ${name} to run?`,detail:`Executable: ${server.resolvedCommand}\nSource/configuration SHA-256: ${fingerprint}\n\nReview its command, arguments and environment in Settings. This server runs as your user and may access your files and network. Only approve code you trust. Reconnecting stops active MCP calls.`,buttons:['Cancel','Approve and connect'],defaultId:0,cancelId:0,noLink:true});
    if(answer.response===1){const config=settings.get().mcpServers[name];if(!config)throw Error('MCP server removed.');await mcp.approve(name,fingerprint,config);await mcp.reload(settings.get().mcpServers)}return mcp.status(settings.get().mcpServers);
  });
  ipcMain.handle(CH.mcpRevoke,async(_event,name:string)=>{mcp.revoke(name);await mcp.reload(settings.get().mcpServers);return mcp.status(settings.get().mcpServers)});
  ipcMain.handle(CH.mcpReload, async () => {
    await deps.reloadIntegrations();
    return mcp.status(settings.get().mcpServers);
  });
  ipcMain.handle(CH.pluginStatus, () => plugins.status());
  ipcMain.handle(CH.pluginApprove,async(_event,id:string,fingerprint:string)=>{
    const plugin=plugins.status().find(plugin=>plugin.id===id);
    if(!plugin||plugin.fingerprint!==fingerprint||!fingerprint)throw Error('Plugin changed. Reload and review it again.');
    const answer=await dialog.showMessageBox({type:'question',title:'Approve plugin source',message:`Allow ${plugin.name} ${plugin.version}?`,detail:`Source: ${plugin.path}\nSHA-256: ${fingerprint}\n\nThe plugin can use the network and its own storage. Profile files and child processes are restricted. Browser actions use your approval settings; page JavaScript asks unless explicitly auto-allowed for the current chat. Only approve code you trust. Approving reloads plugins and stops any active plugin tasks.`,buttons:['Cancel','Approve this source'],defaultId:0,cancelId:0,noLink:true});
    if(answer.response===1)await plugins.approve(id,fingerprint);return plugins.status();
  });
  ipcMain.handle(CH.pluginRevoke,async(_event,id:string)=>{await plugins.revoke(id);return plugins.status()});
  ipcMain.handle(CH.pluginReload, async () => {
    await plugins.reload();
    return plugins.status();
  });
  ipcMain.on(CH.pluginOpenFolder, () => void shell.openPath(plugins.directory));

  /* ------------------------------------------------------------ downloads */

  ipcMain.handle(CH.downloadsList, () => downloads.list());
  ipcMain.on(CH.downloadsCancel, (_e, id: string) => downloads.cancel(id));
  ipcMain.on(CH.downloadsPause, (_e, id: string) => downloads.togglePause(id));
  ipcMain.on(CH.downloadsOpen, (_e, id: string) => downloads.open(id));
  ipcMain.on(CH.downloadsReveal, (_e, id: string) => downloads.reveal(id));
  ipcMain.on(CH.downloadsClear, () => downloads.clearFinished());
  ipcMain.on(CH.downloadsFolder, () => downloads.openFolder());

  /* ------------------------------------------------------------ passwords */

  ipcMain.handle(CH.pwList, () => passwords.list());
  ipcMain.handle(CH.pwReveal, (_e, id: string) => passwords.reveal(id));
  ipcMain.handle(CH.pwRemove, (_e, id: string) => {
    passwords.remove(id);
    return passwords.list();
  });

  // The credential offered by the last capture, held only until the user
  // answers the prompt. It is never written to disk before they say yes.
  ipcMain.on(CH.pwSave, () => {
    const pending = win.pendingLogin;
    if (!pending) return;
    try {
      passwords.save(pending.origin, pending.username, pending.password);
    } catch (err) {
      // Saving now refuses rather than writing a recoverable secret. That has
      // to reach the user: in an `ipcMain.on` listener the throw would vanish
      // into the event loop and the prompt would simply appear to succeed.
      const message =
        err instanceof NoSecureStorageError
          ? err.message
          : `The password could not be saved: ${err instanceof Error ? err.message : String(err)}`;
      win.send(CH.notice, { kind: 'error', message });
    } finally {
      win.pendingLogin = null;
      win.send(CH.pwPrompt, null);
    }
  });
  ipcMain.on(CH.pwDismiss, () => {
    win.pendingLogin = null;
    win.send(CH.pwPrompt, null);
  });

  /* ------------------------------------------------------- browsing data */

  ipcMain.handle(CH.dataClear, async (_e, request: ClearDataRequest) => {
    history.clearData({ history: request.history, bookmarks: request.bookmarks });
    if (request.passwords) passwords.clearAll();

    const ses = session.fromPartition('persist:nabsun');
    if (request.cookies) {
      await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb'] });
    }
    if (request.cache) await ses.clearCache();

    if (request.bookmarks) win.send(CH.bookmarksChanged, history.bookmarks());
  });

  /* ----------------------------------------------------------------- data */

  ipcMain.handle(CH.historySearch, (_e, q: string, limit?: number) => history.search(q ?? '', limit ?? 50));
  ipcMain.handle(CH.historyClear, () => history.clear());
  ipcMain.handle(CH.bookmarkList, () => history.bookmarks());
  ipcMain.handle(CH.bookmarkAdd, (_e, url: string, title: string) => {
    const bm = history.addBookmark(url, title);
    win.send(CH.bookmarksChanged, history.bookmarks());
    return bm;
  });
  ipcMain.handle(CH.bookmarkRemove, (_e, id: string) => {
    history.removeBookmark(id);
    win.send(CH.bookmarksChanged, history.bookmarks());
  });
  ipcMain.handle(CH.bookmarkUpdate, (_e, id: string, patch: Partial<Bookmark>) => {
    history.updateBookmark(id, patch);
    const list = history.bookmarks();
    win.send(CH.bookmarksChanged, list);
    return list;
  });
  ipcMain.handle(CH.bookmarkReorder, (_e, id: string, index: number) => {
    history.reorderBookmark(id, index);
    const list = history.bookmarks();
    win.send(CH.bookmarksChanged, list);
    return list;
  });
  ipcMain.handle(CH.bookmarkFolders, () => history.folders());
  ipcMain.on(CH.bookmarkBarToggle, (_e, visible?: boolean) => win.toggleBookmarksBar(visible));
}

/**
 * Keeps only keys that exist in the schema, with the right primitive type.
 * An imported file is user-supplied data, so it never gets to introduce new
 * keys or replace a nested object with a string.
 *
 * Top-level shape alone is not enough. `mcpServers` and `chromeExtensions`
 * describe *executables*, and an imported file that merely looks like an object
 * could otherwise name any command and have it spawned the moment integrations
 * reload. Those two are validated field by field and forced to arrive disabled,
 * so importing a config can never start a program on its own.
 */
export function sanitizeSettings(incoming: Partial<Settings>): Partial<Settings> {
  const clean: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in incoming)) continue;
    if(key==='browserNetwork'||key==='siteToolGrants'||key==='approvalVersion'||key==='approvalMigrationNotice'||key==='integrationControls'||key==='approvalMode'||key==='usageAgreementRequired'||key==='usageAgreementVersion')continue;
    const value = (incoming as Record<string, unknown>)[key];
    if (value === null || value === undefined) continue;
    // Imported configuration cannot authorize disclosure of existing local notes.
    if (key === 'memoryLocalOnly' && value !== true) continue;

    if (key === 'mcpServers') {
      clean[key] = sanitizeMcpServers(value);
      continue;
    }
    if (key === 'chromeExtensions') {
      clean[key] = sanitizeChromeExtensions(value);
      continue;
    }
    // Fields that name a program to run or a host to send credentials to are
    // not settings in the ordinary sense, and an imported file does not get to
    // choose them. Dropped entirely; the user sets them in the UI.
    if (namesSomethingToRun(key)) continue;

    if (Array.isArray(fallback)) {
      // Element types matter: alwaysAllowTools is a grant list.
      if (isStringArray(value)) clean[key] = value;
      continue;
    }

    if (typeof fallback === 'object') {
      const nested = sanitizeNested(value, fallback as Record<string, unknown>);
      if (nested) clean[key] = nested;
      continue;
    }

    // Primitives must match exactly. The string "false" is truthy, and the
    // approval gate reads autoApprove.write as a boolean — so an imported
    // `"false"` silently switched auto-approval *on*.
    if (typeof value === typeof fallback) clean[key] = value;
  }
  return clean as Partial<Settings>;
}

/**
 * Whether a settings key names something to execute, read from disk, or send
 * credentials to. Such fields are never taken from an imported file.
 *
 * This is a rule about the *shape* of a key name, not a list of known keys, and
 * that is the point. The list version held exactly `cliPaths` and `baseUrls`;
 * when `localModel.serverPath` was added it sailed through validation, and an
 * imported config could once again choose an executable for the browser to
 * spawn. A denylist only covers the settings that existed when it was written,
 * and the failure is silent. Anything ending in path/command/url/binary is
 * refused wherever it appears, at any depth, including keys added later.
 *
 * A false positive costs the user retyping one field in the UI, which is where
 * these belong anyway.
 */
function namesSomethingToRun(key: string): boolean {
  return /(path|paths|command|commands|cmd|exe|executable|binary|bin|url|urls|endpoint|endpoints|dir|directory|file|files)$/i.test(
    key,
  );
}

/** The endpoint a provider's key will actually be sent to. */
function endpointFor(settings: SettingsStore, provider: ProviderId): string {
  const urls = settings.get().baseUrls as Record<string, string>;
  return urls?.[provider] ?? '';
}

/**
 * Validates a nested object field by field against the default's own types,
 * rejecting unknown keys. Returns null when nothing survives.
 */
function sanitizeNested(
  value: unknown,
  fallback: Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, expected] of Object.entries(fallback)) {
    // The same rule as the top level, applied here too: `localModel.serverPath`
    // is nested, and nesting is exactly how it slipped past.
    if (namesSomethingToRun(key)) continue;
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    if (typeof v === typeof expected && typeof v !== 'object') out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Strips values that are secrets by nature before a config leaves the machine.
 *
 * The env block of an MCP server is where its token lives, so the names are
 * kept — they document what the server needs — and the values are not.
 */
export function withoutSecrets(settings: Settings): Settings {
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(settings.mcpServers ?? {})) {
    const env: Record<string, string> = {};
    for (const key of Object.keys(server.env ?? {})) env[key] = '';
    mcpServers[name] = { ...server, env, args: redactArgs(server.args ?? []) };
  }
  return { ...settings, mcpServers };
}

/**
 * Removes secret *values* from a command line, by omitting all of them.
 *
 * A heuristic over arbitrary arguments cannot be made safe: matching flag names
 * still leaked `--authorization=Bearer.X`, a URL carrying `?token=…`, a
 * JWT-shaped bare argument, and `['--token', '-LOOKS_LIKE_A_FLAG']`. Each of
 * those is a rule that could be added, and the next spelling is another one.
 *
 * So the rule is inverted: flag *names* are kept, because they document what
 * the server expects, and every value is replaced with an empty string. An
 * exported config therefore needs its values filled in again, which is the
 * honest outcome — the alternative is claiming a sanitised export while a
 * classifier quietly misses a case.
 */
export function redactArgs(args: string[]): string[] {
  // Every value is dropped, unconditionally.
  //
  // Two heuristics have now failed here. Matching "looks like a flag" kept
  // `-secret-token-value` and `-psecretvalue`, because a secret is free to be
  // shaped like a flag and an attached short-option value is indistinguishable
  // from one. Casing does not separate them either. There is no reliable way to
  // tell a flag from a secret in an arbitrary command line, so the export
  // stops guessing: the number of arguments is preserved, so the shape of the
  // command is still visible, and the strings are not.
  //
  // The cost is that the user retypes the arguments after an import. That is
  // the right side to be wrong on, and it is stated in the export file itself.
  return args.map(() => '');
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

function sanitizeMcpServers(value: unknown): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;

  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.command !== 'string' || !entry.command.trim()) continue;
    if (entry.args !== undefined && !isStringArray(entry.args)) continue;

    const env: Record<string, string> = {};
    if (typeof entry.env === 'object' && entry.env !== null && !Array.isArray(entry.env)) {
      for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
    }

    out[name] = {
      command: entry.command,
      args: isStringArray(entry.args) ? entry.args : [],
      env,
      // Imported servers always arrive disabled, whatever the file claims.
      // Running one is a decision the user makes here, not in a file they were
      // sent.
      enabled: false,
    };
  }
  return out;
}

function sanitizeChromeExtensions(value: unknown): ChromeExtensionEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ChromeExtensionEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.path !== 'string' || !entry.path.trim()) continue;
    out.push({ ...(entry as unknown as ChromeExtensionEntry), path: entry.path, enabled: false });
  }
  return out;
}

/**
 * A filename for "save page as", the way a browser offers one: the page's
 * title if it has a usable one, otherwise the last path segment.
 */
export function suggestedFileName(url: string, title: string): string {
  // Only what a filename genuinely cannot contain: the Windows-reserved
  // characters and control codes. Spaces are kept on purpose — a browser
  // offers "My Page Title.html", and stripping them gives the run-together
  // names nobody wants.
  const illegal = /[<>:"/\\|?*\u0000-\u001f]/g;
  const fromTitle = title.replace(illegal, '').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
  if (fromTitle) return `${fromTitle}.html`;

  // A path is only meaningful for a real web URL. `about:blank` has a
  // pathname of "blank", which would otherwise be offered as "blank.html".
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const last = parsed.pathname.split('/').filter(Boolean).pop();
      if (last) return /\.[a-z0-9]{1,5}$/i.test(last) ? last : `${last}.html`;
    }
  } catch {
    // Fall through to the generic name.
  }
  return 'page.html';
}

/** Commands dispatched from the overlay (omnibox / palette) and the menu. */
export function handleCommand(deps: IpcDeps, command: string, arg?: unknown): void {
  const { win, settings } = deps;
  const active = win.tabs.activeTabId;

  switch (command) {
    case 'navigate': {
      const url = resolveNavigationInput(String(arg ?? ''), settings.get().searchEngine);
      if (active) win.tabs.navigate(active, url);
      else win.tabs.create(url);
      break;
    }
    case 'navigate-new-tab':
      win.tabs.create(resolveNavigationInput(String(arg ?? ''), settings.get().searchEngine));
      break;
    case 'ask-ai':
      win.toggleSidebar(true);
      win.send(CH.overlayCommand, { command: 'ask-ai', arg });
      break;
    case 'new-tab':
      win.tabs.create();
      break;
    case 'close-tab':
      if (active) win.tabs.close(active);
      break;
    case 'reload':
      win.tabs.byId(active ?? '')?.wc.reload();
      break;

    /* The ordinary navigation a browser is expected to have. The toolbar had
       buttons for these; the keyboard and the mouse's side buttons did not. */
    case 'back': {
      const wc = win.tabs.byId(active ?? '')?.wc;
      if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      break;
    }
    case 'forward': {
      const wc = win.tabs.byId(active ?? '')?.wc;
      if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      break;
    }
    case 'stop':
      win.tabs.byId(active ?? '')?.wc.stop();
      break;
    case 'home': {
      const home = settings.get().homepage || 'nabsun://home';
      if (active) win.tabs.navigate(active, home);
      else win.tabs.create(home);
      break;
    }

    case 'view-source': {
      const url = win.tabs.byId(active ?? '')?.wc.getURL();
      // Chromium serves this itself; a `view-source:` of an internal or
      // already-source URL is refused rather than opening a confusing tab.
      if (url && /^https?:/i.test(url)) win.tabs.create(`view-source:${url}`);
      break;
    }

    case 'save-page': {
      const tab = win.tabs.byId(active ?? '');
      if (!tab) break;
      void (async () => {
        const suggested = suggestedFileName(tab.wc.getURL(), tab.wc.getTitle());
        const result = await dialog.showSaveDialog(win.window, {
          title: 'Save page as',
          defaultPath: path.join(app.getPath('downloads'), suggested),
          filters: [{ name: 'Web page, complete', extensions: ['html'] }],
        });
        if (result.canceled || !result.filePath) return;
        // "Complete" writes a `_files` directory beside the page, which is what
        // makes the saved copy readable offline — Chrome's own default. Only
        // this one is offered: the dialog result does not report which filter
        // was chosen, so a second entry would be a control that does nothing.
        try {
          await tab.wc.savePage(result.filePath, 'HTMLComplete');
        } catch (err) {
          win.send(CH.notice, {
            kind: 'error',
            message: `Could not save the page: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })();
      break;
    }

    case 'clear-data':
      win.send(CH.overlayCommand, { command: 'open-clear-data' });
      break;
    case 'toggle-sidebar':
      win.toggleSidebar();
      break;
    case 'open-workflows':
    case 'run-workflow': {
      const data=deps.dataWorkspace;if(!data)break;
      const scope=data.scope??deps.sessions.list()[0]?.id??deps.sessions.create().id;
      void data.open(scope).then(()=>{const workflowId=command==='run-workflow'?data.workflows.get(String(arg)).id:undefined;win.send(CH.workflowScope,{scope,workflowId});win.openWorkspace('workflows')}).catch(()=>{void dialog.showMessageBox({type:'info',message:'Could not open the workflow.',detail:'Open Data & workflows from Assistant options and try again.'})});
      break;
    }
    case 'open-settings':
      win.send(CH.overlayCommand, { command: 'open-settings' });
      break;
    case 'open-bookmarks':
      win.toggleSidebar(true);
      win.send(CH.overlayCommand, { command: 'open-bookmarks' });
      break;
    case 'open-passwords':
      win.toggleSidebar(true);
      win.send(CH.overlayCommand, { command: 'open-passwords' });
      break;
    case 'open-downloads':
      win.toggleSidebar(true);
      win.send(CH.overlayCommand, { command: 'open-downloads' });
      break;
    // History is a page rather than a panel, so this matches what the menu and
    // Ctrl+H already do instead of inventing a second place for it to live.
    case 'open-history':
      win.tabs.create('nabsun://history');
      break;
    case 'bookmark-page': {
      const tab = win.tabs.active;
      if (!tab) break;
      const url = tab.wc.getURL();
      if (!/^https?:/i.test(url)) break;
      const existing = deps.history.bookmarks().find((b) => b.url === url);
      // Ctrl+D toggles, matching every other browser's star.
      if (existing) deps.history.removeBookmark(existing.id);
      else deps.history.addBookmark(url, tab.wc.getTitle());
      win.send(CH.bookmarksChanged, deps.history.bookmarks());
      break;
    }
    case 'find':
      win.setFindOpen(true);
      win.send(CH.overlayCommand, { command: 'focus-find' });
      break;
    case 'devtools':
    case 'devtools-detached':
      win.openWorkspace(null);
      win.tabs.pageDevTools(command === 'devtools-detached' ? 'detach' : 'toggle');
      break;
    default:
      win.send(CH.overlayCommand, { command, arg });
  }
}





