import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CH, type ShellApi } from '../shared/ipc';

/** Subscribes and returns an unsubscribe function, so views can clean up. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ShellApi = {
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
    tools: () => ipcRenderer.invoke(CH.agentTools),
    resolveApproval: (id, decision) => ipcRenderer.send(CH.agentApprovalResolve, id, decision),
    answer: (id, text) => ipcRenderer.send(CH.agentAnswer, id, text),
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
    pluginStatus: () => ipcRenderer.invoke(CH.pluginStatus),
    pluginReload: () => ipcRenderer.invoke(CH.pluginReload),
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





