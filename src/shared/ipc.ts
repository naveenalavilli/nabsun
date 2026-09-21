import type {
  AgentEvent,
  AccountStatus,
  AgentExtension,
  AgentQuestion,
  ApprovalDecision,
  ApprovalRequest,
  Bookmark,
  BridgeInfo,
  ChatSession,
  ConfigActionResult,
  ClearDataRequest,
  ConfigPaths,
  DownloadEntry,
  ExtensionStatus,
  HistoryEntry,
  McpStatus,
  OmniboxSuggestion,
  PasswordPrompt,
  PluginStatus,
  ProviderId,
  ProviderStatus,
  SavedLogin,
  Settings,
  ToolSpec,
  WindowState,
} from './types';

/** Renderer -> main, request/response. */
export const CH = {
  // shell lifecycle
  shellReady: 'shell:ready',
  windowState: 'window:state', // main -> renderer push

  // tabs
  tabNew: 'tab:new',
  tabClose: 'tab:close',
  tabActivate: 'tab:activate',
  tabReorder: 'tab:reorder',
  tabNavigate: 'tab:navigate',
  tabBack: 'tab:back',
  tabForward: 'tab:forward',
  tabReload: 'tab:reload',
  tabStop: 'tab:stop',
  tabMute: 'tab:mute',
  tabPin: 'tab:pin',
  tabDuplicate: 'tab:duplicate',

  // window chrome
  winMinimize: 'win:minimize',
  winMaximize: 'win:maximize',
  winClose: 'win:close',
  sidebarToggle: 'sidebar:toggle',
  sidebarResize: 'sidebar:resize',

  // find in page
  findStart: 'find:start',
  findNext: 'find:next',
  findStop: 'find:stop',
  findResult: 'find:result', // main -> renderer push

  // omnibox
  omniboxSuggest: 'omnibox:suggest',

  // agent
  agentSend: 'agent:send',
  agentAbort: 'agent:abort',
  agentEvent: 'agent:event', // main -> renderer push
  agentTools: 'agent:tools',
  agentApprovalRequest: 'agent:approval-request', // main -> renderer push
  agentApprovalResolve: 'agent:approval-resolve',
  agentQuestion: 'agent:question', // main -> renderer push
  agentAnswer: 'agent:answer',
  agentAttachPage: 'agent:attach-page',

  // sessions
  sessionList: 'session:list',
  sessionLoad: 'session:load',
  sessionNew: 'session:new',
  sessionDelete: 'session:delete',
  sessionRename: 'session:rename',

  // settings + credentials
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChanged: 'settings:changed', // main -> renderer push
  credsStatus: 'creds:status',
  credsSet: 'creds:set',
  credsClear: 'creds:clear',

  // configuration file management
  configExport: 'config:export',
  configImport: 'config:import',
  configReset: 'config:reset',
  configPaths: 'config:paths',
  configOpenFolder: 'config:open-folder',
  soulOpen: 'soul:open',

  // external agent bridge
  bridgeInfo: 'bridge:info',

  // downloads
  downloadsChanged: 'downloads:changed', // main -> renderer push
  downloadsList: 'downloads:list',
  downloadsCancel: 'downloads:cancel',
  downloadsPause: 'downloads:pause',
  downloadsOpen: 'downloads:open',
  downloadsReveal: 'downloads:reveal',
  downloadsClear: 'downloads:clear',
  downloadsFolder: 'downloads:folder',

  // extensions
  extList: 'ext:list',
  extAdd: 'ext:add',
  extRemove: 'ext:remove',
  extToggle: 'ext:toggle',
  extReload: 'ext:reload',
  extOpenFolder: 'ext:open-folder',
  extAction: 'ext:action', // open an extension's toolbar popup
  extChanged: 'ext:changed', // main -> renderer push
  agentExtList: 'agent-ext:list',
  acctStatus: 'acct:status',
  acctLogin: 'acct:login',
  acctLogout: 'acct:logout',
  acctCancel: 'acct:cancel',
  acctEvent: 'acct:event', // main -> renderer push
  agentExtActivate: 'agent-ext:activate',

  // integrations
  mcpStatus: 'mcp:status',
  mcpReload: 'mcp:reload',
  pluginStatus: 'plugin:status',
  pluginReload: 'plugin:reload',
  pluginOpenFolder: 'plugin:open-folder',

  // passwords
  pwList: 'pw:list',
  pwReveal: 'pw:reveal',
  pwRemove: 'pw:remove',
  pwSave: 'pw:save',
  pwPrompt: 'pw:prompt', // main -> renderer push
  pwDismiss: 'pw:dismiss',
  /** main -> renderer: something the user must be told about, e.g. a save that refused. */
  notice: 'ui:notice',

  // browsing data
  dataClear: 'data:clear',

  // history / bookmarks
  historySearch: 'history:search',
  historyClear: 'history:clear',
  bookmarkList: 'bookmark:list',
  bookmarkAdd: 'bookmark:add',
  bookmarkRemove: 'bookmark:remove',
  bookmarkUpdate: 'bookmark:update',
  bookmarkReorder: 'bookmark:reorder',
  bookmarkFolders: 'bookmark:folders',
  bookmarksChanged: 'bookmark:changed', // main -> renderer push
  bookmarkBarToggle: 'bookmark:bar-toggle',

  // overlay
  overlayShow: 'overlay:show',
  overlayOpen: 'overlay:open',
  overlayClose: 'overlay:close',
  overlayCommand: 'overlay:command',
} as const;

/** A message the user has to see, because an action did not do what it looked like. */
export interface UiNotice {
  kind: 'error' | 'info';
  message: string;
}

/**
 * What happened to a credential save.
 *
 * Not `void`: without a keychain the key is held for this session only, and a
 * caller that ignores the outcome would show a saved-looking UI for something
 * that will be gone on restart.
 */
export interface CredentialSaveResult {
  ok: boolean;
  /** Kept in memory for this session, but not written to disk. */
  sessionOnly?: boolean;
  error?: string;
}

/** The surface exposed on `window.nabsun` inside the shell renderer. */
export interface ShellApi {
  onWindowState(cb: (state: WindowState) => void): () => void;
  onAgentEvent(cb: (event: AgentEvent) => void): () => void;
  onApprovalRequest(cb: (req: ApprovalRequest) => void): () => void;
  onQuestion(cb: (question: AgentQuestion) => void): () => void;
  onSettingsChanged(cb: (settings: Settings) => void): () => void;
  onFindResult(cb: (r: { activeMatch: number; matches: number }) => void): () => void;
  onCommand(cb: (command: string, arg?: unknown) => void): () => void;
  onNotice(cb: (notice: UiNotice) => void): () => void;

  ready(): void;

  tabs: {
    create(url?: string, opts?: { background?: boolean }): Promise<string>;
    close(id: string): void;
    activate(id: string): void;
    reorder(id: string, toIndex: number): void;
    navigate(id: string, input: string): void;
    back(id: string): void;
    forward(id: string): void;
    reload(id: string, hard?: boolean): void;
    stop(id: string): void;
    mute(id: string, muted: boolean): void;
    pin(id: string, pinned: boolean): void;
    duplicate(id: string): void;
  };

  window: {
    minimize(): void;
    maximize(): void;
    close(): void;
    toggleSidebar(open?: boolean): void;
    resizeSidebar(width: number): void;
    /** Asks the main process to attach the overlay view (omnibox / palette). */
    showOverlay(kind: 'omnibox' | 'palette', payload?: unknown): void;
  };

  find: {
    start(query: string, forward?: boolean): void;
    next(forward: boolean): void;
    stop(): void;
  };

  omnibox: {
    suggest(query: string): Promise<OmniboxSuggestion[]>;
  };

  agent: {
    send(sessionId: string, text: string, opts?: { attachPage?: boolean }): void;
    abort(sessionId: string): void;
    tools(): Promise<ToolSpec[]>;
    resolveApproval(id: string, decision: ApprovalDecision): void;
    /** Answers a question from the assistant; null means the user skipped it. */
    answer(id: string, text: string | null): void;
  };

  sessions: {
    list(): Promise<{ id: string; title: string; updatedAt: number }[]>;
    load(id: string): Promise<ChatSession | null>;
    create(): Promise<ChatSession>;
    remove(id: string): Promise<void>;
    rename(id: string, title: string): Promise<void>;
  };

  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
    credentialStatus(): Promise<ProviderStatus[]>;
    setCredential(provider: ProviderId, key: string): Promise<CredentialSaveResult>;
    clearCredential(provider: ProviderId): Promise<void>;
  };

  config: {
    /** Writes the current configuration to a file the user picks. */
    export(): Promise<ConfigActionResult>;
    /** Reads a configuration file the user picks and applies it. */
    import(): Promise<ConfigActionResult>;
    reset(): Promise<Settings>;
    paths(): Promise<ConfigPaths>;
    openFolder(): void;
    /** Opens soul.md in the user's editor, creating it first if absent. */
    openSoul(): void;
    /** Connection details so an external agent can drive this browser. */
    bridge(): Promise<BridgeInfo>;
  };

  extensions: {
    onChanged(cb: (items: ExtensionStatus[]) => void): () => void;
    list(): Promise<ExtensionStatus[]>;
    /** Opens a folder picker and loads the unpacked extension it contains. */
    add(): Promise<{ ok: boolean; error?: string; name?: string; cancelled?: boolean }>;
    remove(path: string): Promise<ExtensionStatus[]>;
    setEnabled(path: string, enabled: boolean): Promise<ExtensionStatus[]>;
    reload(): Promise<ExtensionStatus[]>;
    openFolder(path: string): void;
    /** Shows the extension's toolbar popup, anchored under the given x. */
    openAction(id: string, anchorX: number): void;
  };

  accounts: {
    onEvent(cb: (e: {
      provider: ProviderId;
      message?: string;
      chunk?: string;
      /** A sign-in URL the browser should open in a tab. */
      url?: string;
      /** A device code for the user to enter on the sign-in page. */
      code?: string;
      done?: boolean;
      ok?: boolean;
      error?: string;
    }) => void): () => void;
    status(provider: ProviderId): Promise<AccountStatus>;
    connect(provider: ProviderId, mode: 'browser' | 'device' | 'apiKey' | 'repair', apiKey?: string): void;
    disconnect(provider: ProviderId): Promise<{ ok: boolean; error?: string }>;
    cancel(provider: ProviderId): void;
  };

  agentExtensions: {
    list(): Promise<AgentExtension[]>;
    /** Makes this backend the one the assistant uses. */
    activate(id: ProviderId): Promise<AgentExtension[]>;
  };

  integrations: {
    mcpStatus(): Promise<McpStatus[]>;
    mcpReload(): Promise<McpStatus[]>;
    pluginStatus(): Promise<PluginStatus[]>;
    pluginReload(): Promise<PluginStatus[]>;
    openPluginFolder(): void;
  };

  downloads: {
    onChanged(cb: (items: DownloadEntry[]) => void): () => void;
    list(): Promise<DownloadEntry[]>;
    cancel(id: string): void;
    togglePause(id: string): void;
    open(id: string): void;
    reveal(id: string): void;
    clearFinished(): void;
    openFolder(): void;
  };

  passwords: {
    onPrompt(cb: (p: PasswordPrompt) => void): () => void;
    list(): Promise<SavedLogin[]>;
    reveal(id: string): Promise<string | null>;
    remove(id: string): Promise<SavedLogin[]>;
    /** Confirms the save offered by onPrompt. */
    confirmSave(): void;
    dismissPrompt(): void;
  };

  data: {
    historySearch(q: string, limit?: number): Promise<HistoryEntry[]>;
    historyClear(): Promise<void>;
    bookmarks(): Promise<Bookmark[]>;
    addBookmark(url: string, title: string): Promise<Bookmark>;
    removeBookmark(id: string): Promise<void>;
    updateBookmark(id: string, patch: Partial<Bookmark>): Promise<Bookmark[]>;
    reorderBookmark(id: string, toIndex: number): Promise<Bookmark[]>;
    bookmarkFolders(): Promise<string[]>;
    onBookmarksChanged(cb: (items: Bookmark[]) => void): () => void;
    toggleBookmarksBar(visible?: boolean): void;
    clear(request: ClearDataRequest): Promise<void>;
  };
}

declare global {
  interface Window {
    nabsun: ShellApi;
  }
}






