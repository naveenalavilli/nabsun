import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CH, type ShellApi } from '../shared/ipc';

/** Subscribes and returns an unsubscribe function, so views can clean up. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ShellApi = {
  voice:{availability:()=>ipcRenderer.invoke(CH.voiceAvailability),start:(sessionId,requestId,language)=>ipcRenderer.invoke(CH.voiceStart,sessionId,requestId,language),stop:requestId=>ipcRenderer.send(CH.voiceStop,requestId),onEvent:callback=>on(CH.voiceEvent,callback)},
  activity:{list:day=>ipcRenderer.invoke(CH.activityList,day),export:day=>ipcRenderer.invoke(CH.activityExport,day)},
  platform: process.platform,
  updates: {
    check: manual => ipcRenderer.invoke(CH.updateCheck, manual),
    open: () => ipcRenderer.invoke(CH.updateOpen),
  },
  onWindowState: (cb) => on(CH.windowState, cb),
  onAgentEvent: (cb) => on(CH.agentEvent, cb),
  onApprovalRequest: (cb) => on(CH.agentApprovalRequest, cb),
  onQuestion: (cb) => on(CH.agentQuestion, cb),
  onSettingsChanged: (cb) => on(CH.settingsChanged, cb),
  onFindResult: (cb) => on(CH.findResult, cb),
  onCommand: (cb) =>
    on<{ command: string; arg?: unknown }>(CH.overlayCommand, (p) => cb(p.command, p.arg)),

  ready: () => ipcRenderer.send(CH.shellReady),

  tabs: {
    create: (url, opts) => ipcRenderer.invoke(CH.tabNew, url, opts),
    close: (id) => ipcRenderer.send(CH.tabClose, id),
    activate: (id) => ipcRenderer.send(CH.tabActivate, id),
    reorder: (id, index) => ipcRenderer.send(CH.tabReorder, id, index),
    navigate: (id, input) => ipcRenderer.send(CH.tabNavigate, id, input),
    back: (id) => ipcRenderer.send(CH.tabBack, id),
    forward: (id) => ipcRenderer.send(CH.tabForward, id),
    reload: (id, hard) => ipcRenderer.send(CH.tabReload, id, hard),
    stop: (id) => ipcRenderer.send(CH.tabStop, id),
    mute: (id, muted) => ipcRenderer.send(CH.tabMute, id, muted),
    pin: (id, pinned) => ipcRenderer.send(CH.tabPin, id, pinned),
    duplicate: (id) => ipcRenderer.send(CH.tabDuplicate, id),
  },

  window: {
    minimize: () => ipcRenderer.send(CH.winMinimize),
    maximize: () => ipcRenderer.send(CH.winMaximize),
    close: () => ipcRenderer.send(CH.winClose),
    toggleSidebar: (open) => ipcRenderer.send(CH.sidebarToggle, open),
    resizeSidebar: (width) => ipcRenderer.send(CH.sidebarResize, width),
    prefillAssistant: prompt => ipcRenderer.send(CH.starterPrompt, prompt),
    openWorkspace: name => ipcRenderer.send(CH.workspace, name),
    openAssistantView: name => ipcRenderer.send(CH.assistantView, name),
    zoomAssistant: delta => ipcRenderer.send(CH.assistantZoom, delta),
    detachAssistant: detached => ipcRenderer.send(CH.assistantDetach, detached),
    pageDevTools: action => ipcRenderer.send(CH.pageDevTools, action),
    showOverlay: (kind, payload) => ipcRenderer.send(CH.overlayShow, kind, payload),
  },

  find: {
    start: (query) => ipcRenderer.send(CH.findStart, query),
    next: (forward) => ipcRenderer.send(CH.findNext, forward),
    stop: () => ipcRenderer.send(CH.findStop),
  },

  omnibox: {
    suggest: (query) => ipcRenderer.invoke(CH.omniboxSuggest, query),
  },

  agent: {
    send: (sessionId, text, opts) => ipcRenderer.send(CH.agentSend, sessionId, text, opts),
    abort: (sessionId) => ipcRenderer.send(CH.agentAbort, sessionId),
    queue: sessionId => ipcRenderer.invoke(CH.agentQueue, sessionId),
    cancelQueued: (sessionId, id) => ipcRenderer.invoke(CH.agentCancelQueued, sessionId, id),
    tools: () => ipcRenderer.invoke(CH.agentTools),
    resolveApproval: (id, decision) => ipcRenderer.send(CH.agentApprovalResolve, id, decision),
    sessionGrants: sessionId => ipcRenderer.invoke(CH.agentSessionGrants, sessionId),
    revokeSessionTool: (sessionId,toolName,source) => ipcRenderer.invoke(CH.agentRevokeSessionTool, sessionId,toolName,source),
    answer: (id, text) => ipcRenderer.send(CH.agentAnswer, id, text),
  },

  workflows:{
    open:(scope,workflowId)=>ipcRenderer.invoke(CH.dataOpen,scope,workflowId),
    context:()=>ipcRenderer.invoke(CH.dataContext),
    onScope:cb=>on(CH.workflowScope,cb),
    onChanged:cb=>on(CH.batchChanged,cb),
    datasets:scope=>ipcRenderer.invoke(CH.dataList,scope),
    preview:(scope,id)=>ipcRenderer.invoke(CH.dataPreview,scope,id),
    attach:scope=>ipcRenderer.invoke(CH.dataAttach,scope),
    paste:(scope,text,name)=>ipcRenderer.invoke(CH.dataPaste,scope,text,name),
    list:()=>ipcRenderer.invoke(CH.workflowList),
    trace:scope=>ipcRenderer.invoke(CH.workflowTrace,scope),
    saveTrace:(scope,name,successText,datasetId,variables)=>ipcRenderer.invoke(CH.workflowSave,scope,name,successText,datasetId,variables),
    update:workflow=>ipcRenderer.invoke(CH.workflowUpdate,workflow),
    import:()=>ipcRenderer.invoke(CH.workflowImport),
    export:id=>ipcRenderer.invoke(CH.workflowExport,id),
    batches:scope=>ipcRenderer.invoke(CH.batchList,scope),
    start:spec=>ipcRenderer.invoke(CH.batchStart,spec),
    control:(scope,id,action)=>ipcRenderer.invoke(CH.batchControl,scope,id,action),
    report:(scope,id)=>ipcRenderer.invoke(CH.batchReport,scope,id),
    exportReport:(scope,id,format)=>ipcRenderer.invoke(CH.batchExport,scope,id,format),
  },

  sitePermissions:{list:()=>ipcRenderer.invoke(CH.sitePermissionsList),revoke:origin=>ipcRenderer.invoke(CH.sitePermissionsRevoke,origin)},
  localFolders:{
    choose:sessionId=>ipcRenderer.invoke(CH.localFolderChoose,sessionId),
    list:sessionId=>ipcRenderer.invoke(CH.localFolderList,sessionId),
    revoke:(sessionId,id)=>ipcRenderer.invoke(CH.localFolderRevoke,sessionId,id),
    onChanged:callback=>on(CH.localFolderChanged,callback),
  },
  files:{
    preview:(sessionId,id)=>ipcRenderer.invoke(CH.filePreview,sessionId,id),
    attach:sessionId=>ipcRenderer.invoke(CH.fileAttach,sessionId),
    list:sessionId=>ipcRenderer.invoke(CH.fileList,sessionId),
    remove:(sessionId,fileId)=>ipcRenderer.invoke(CH.fileRemove,sessionId,fileId),
  },

  sessions: {
    list: () => ipcRenderer.invoke(CH.sessionList),
    load: (id) => ipcRenderer.invoke(CH.sessionLoad, id),
    create: () => ipcRenderer.invoke(CH.sessionNew),
    remove: (id) => ipcRenderer.invoke(CH.sessionDelete, id),
    rename: (id, title) => ipcRenderer.invoke(CH.sessionRename, id, title),
  },

  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (patch) => ipcRenderer.invoke(CH.settingsSet, patch),
    credentialStatus: () => ipcRenderer.invoke(CH.credsStatus),
    setCredential: (provider, key) => ipcRenderer.invoke(CH.credsSet, provider, key),
    clearCredential: (provider) => ipcRenderer.invoke(CH.credsClear, provider),
  },

  config: {
    export: () => ipcRenderer.invoke(CH.configExport),
    import: () => ipcRenderer.invoke(CH.configImport),
    reset: () => ipcRenderer.invoke(CH.configReset),
    paths: () => ipcRenderer.invoke(CH.configPaths),
    openFolder: () => ipcRenderer.send(CH.configOpenFolder),
    openSoul: () => ipcRenderer.send(CH.soulOpen),
    bridge: () => ipcRenderer.invoke(CH.bridgeInfo),
  },

  extensions: {
    onChanged: (cb) => on(CH.extChanged, cb),
    list: () => ipcRenderer.invoke(CH.extList),
    add: () => ipcRenderer.invoke(CH.extAdd),
    remove: (p) => ipcRenderer.invoke(CH.extRemove, p),
    setEnabled: (p, enabled) => ipcRenderer.invoke(CH.extToggle, p, enabled),
    reload: () => ipcRenderer.invoke(CH.extReload),
    openFolder: (p) => ipcRenderer.send(CH.extOpenFolder, p),
    openAction: (id, anchorX) => ipcRenderer.send(CH.extAction, id, anchorX),
  },

  accounts: {
    onEvent: (cb) => on(CH.acctEvent, cb),
    status: (p) => ipcRenderer.invoke(CH.acctStatus, p),
    connect: (p, mode, apiKey) => ipcRenderer.send(CH.acctLogin, p, mode, apiKey),
    disconnect: (p) => ipcRenderer.invoke(CH.acctLogout, p),
    cancel: (p) => ipcRenderer.send(CH.acctCancel, p),
  },

  agentExtensions: {
    list: () => ipcRenderer.invoke(CH.agentExtList),
    activate: (id) => ipcRenderer.invoke(CH.agentExtActivate, id),
  },

  integrations: {
    mcpStatus: () => ipcRenderer.invoke(CH.mcpStatus),
    mcpReload: () => ipcRenderer.invoke(CH.mcpReload),
    mcpApprove:(name,fingerprint)=>ipcRenderer.invoke(CH.mcpApprove,name,fingerprint),
    mcpRevoke:name=>ipcRenderer.invoke(CH.mcpRevoke,name),
    pluginStatus: () => ipcRenderer.invoke(CH.pluginStatus),
    pluginReload: () => ipcRenderer.invoke(CH.pluginReload),
    pluginApprove:(id,fingerprint)=>ipcRenderer.invoke(CH.pluginApprove,id,fingerprint),
    pluginRevoke:id=>ipcRenderer.invoke(CH.pluginRevoke,id),
    openPluginFolder: () => ipcRenderer.send(CH.pluginOpenFolder),
  },

  downloads: {
    onChanged: (cb) => on(CH.downloadsChanged, cb),
    list: () => ipcRenderer.invoke(CH.downloadsList),
    cancel: (id) => ipcRenderer.send(CH.downloadsCancel, id),
    togglePause: (id) => ipcRenderer.send(CH.downloadsPause, id),
    open: (id) => ipcRenderer.send(CH.downloadsOpen, id),
    reveal: (id) => ipcRenderer.send(CH.downloadsReveal, id),
    clearFinished: () => ipcRenderer.send(CH.downloadsClear),
    openFolder: () => ipcRenderer.send(CH.downloadsFolder),
  },

  /** Messages the user must see, such as a save that refused to write. */
  onNotice: (cb) => on(CH.notice, cb),

  passwords: {
    onPrompt: (cb) => on(CH.pwPrompt, cb),
    list: () => ipcRenderer.invoke(CH.pwList),
    reveal: (id) => ipcRenderer.invoke(CH.pwReveal, id),
    remove: (id) => ipcRenderer.invoke(CH.pwRemove, id),
    confirmSave: () => ipcRenderer.send(CH.pwSave),
    dismissPrompt: () => ipcRenderer.send(CH.pwDismiss),
  },

  data: {
    historySearch: (q, limit) => ipcRenderer.invoke(CH.historySearch, q, limit),
    historyClear: () => ipcRenderer.invoke(CH.historyClear),
    bookmarks: () => ipcRenderer.invoke(CH.bookmarkList),
    addBookmark: (url, title) => ipcRenderer.invoke(CH.bookmarkAdd, url, title),
    removeBookmark: (id) => ipcRenderer.invoke(CH.bookmarkRemove, id),
    updateBookmark: (id, patch) => ipcRenderer.invoke(CH.bookmarkUpdate, id, patch),
    reorderBookmark: (id, index) => ipcRenderer.invoke(CH.bookmarkReorder, id, index),
    bookmarkFolders: () => ipcRenderer.invoke(CH.bookmarkFolders),
    onBookmarksChanged: (cb) => on(CH.bookmarksChanged, cb),
    toggleBookmarksBar: (visible) => ipcRenderer.send(CH.bookmarkBarToggle, visible),
    clear: (request) => ipcRenderer.invoke(CH.dataClear, request),
  },
};

contextBridge.exposeInMainWorld('nabsun', api);





