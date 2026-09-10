import path from 'node:path';
import fs from 'node:fs';
import { BrowserWindow, Menu, app, ipcMain, protocol, session, shell } from 'electron';
import { CH } from '../shared/ipc';
import type { ProviderId } from '../shared/types';
import { Agent } from './ai/agent';
import { ApprovalManager } from './ai/approvals';
import { QuestionManager } from './ai/questions';
import type { Provider } from './ai/provider';
import { AnthropicProvider } from './ai/providers/anthropic';
import { ClaudeCodeProvider, CodexProvider } from './ai/providers/cli';
import { LocalProvider, bundledPaths } from './ai/providers/local';
import { OllamaProvider } from './ai/providers/ollama';
import { OpenAIProvider } from './ai/providers/openai';
import { SessionStore } from './ai/sessions';
import { browserTools } from './ai/tools/browser';
import type { Tool } from './ai/tools/types';
import { dataTools, memoryTools, tabTools, webTools } from './ai/tools/workspace';
import { AppWindow } from './appWindow';
import { attachContextMenu } from './contextMenu';
import { DownloadManager } from './downloads';
import { CliAccountManager } from './integrations/cliAccounts';
import { ChromeExtensionManager } from './integrations/extensions';
import { BrowserBridgeServer } from './bridge/server';
import { HistoryStore } from './history';
import { registerInternalProtocol } from './internalPages';
import { McpManager } from './integrations/mcp';
import { PluginManager } from './integrations/plugins';
import { handleCommand, registerIpc, type IpcDeps } from './ipc';
import { PasswordStore } from './passwords';
import { FORMER_SCHEME, migrateProfile, rewriteInternalUrl } from './rebrand';
import { applyPermissionPolicy } from './security';
import { DEFAULT_SETTINGS, SecretStore, SettingsStore } from './store';

/**
 * Electron's development security warnings are wrong for a browser.
 *
 * They inspect every renderer and complain about missing or weak CSP, insecure
 * resources, and so on. In an ordinary Electron app each renderer is the app's
 * own page, so that is useful advice. Here most renderers are *websites the
 * user chose to visit*, and their CSP is not ours to fix — so the console fills
 * with one warning per site and buries anything real.
 *
 * The warnings are replaced by checks rather than merely silenced: the shell
 * and overlay carry CSP meta tags, `nabsun://` pages are served a hash-based
 * policy with no 'unsafe-inline' (see internalPages.ts), and the browsing
 * harness asserts both. That is a stronger guarantee than a console notice
 * nobody can act on.
 */
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// Internal pages need a real scheme so they get an origin, storage, and fetch.
//
// The former `smart:` scheme is registered alongside it, because bookmarks,
// history and session restore hold URLs saved under the old name. It resolves
// to the same pages; nothing new is written with it.
protocol.registerSchemesAsPrivileged([
  { scheme: 'nabsun', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: FORMER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName('Nabsun');

let appWindow: AppWindow | null = null;

async function boot() {
  const userDataPath = app.getPath('userData');

  // Before any store opens a file: the profile still lives under the previous
  // product name, and every store below would otherwise start empty.
  migrateProfile(app.getPath('appData'), userDataPath);

  const settings = new SettingsStore();
  // A homepage saved as `smart://home` still resolves, but the address bar
  // would go on showing the old product name. Canonicalise it once.
  const savedHome = settings.get().homepage;
  const canonicalHome = rewriteInternalUrl(savedHome);
  if (canonicalHome !== savedHome) settings.set({ homepage: canonicalHome });

  const secrets = new SecretStore();
  const history = new HistoryStore();
  const sessions = new SessionStore(userDataPath);
  const approvals = new ApprovalManager(settings);
  const questions = new QuestionManager();
  const mcp = new McpManager();
  const plugins = new PluginManager(path.join(userDataPath, 'plugins'));
  const downloads = new DownloadManager();
  const passwords = new PasswordStore();
  const extensions = new ChromeExtensionManager(() => settings.get().chromeExtensions);
  const accounts = new CliAccountManager(
    (id) => (id === 'claude-cli' || id === 'codex-cli' ? settings.get().cliPaths[id] : ''),
    (event) => win.send(CH.acctEvent, event),
  );

  // Declared before the agent so providers can capture it; started once the
  // tool list and approval gate exist.
  let bridgeCall: (
    name: string,
    args: Record<string, unknown>,
    clientId: string,
  ) => Promise<string> = async () => {
    throw new Error('The browser is still starting up.');
  };
  const bridge = new BrowserBridgeServer({
    listTools: () => agent.toolSpecs(),
    // The client id is carried through, not dropped: it is what keeps each
    // connected agent's tab its own between calls.
    callTool: (name, args, clientId) => bridgeCall(name, args, clientId),
  });

  configureSession(settings);

  // Bundled alongside the main process. In a packaged build it ships unpacked,
  // because a child process cannot be spawned from inside an asar archive.
  const mcpServerScript = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'bin', 'nabsun-mcp.js')
    : path.join(__dirname, '..', 'bin', 'nabsun-mcp.js');

  const bridgeInfo = () =>
    bridge.running ? { url: bridge.url, token: bridge.token, serverScript: mcpServerScript } : null;

  /**
   * A stored key is only handed to the endpoint it was saved for.
   *
   * Without this, changing a base URL redirects an existing credential to the
   * new host — and a base URL is exactly the sort of thing an imported config
   * would try to set.
   */
  const keyForEndpoint = (store: SecretStore, provider: ProviderId, endpoint: string) => {
    const fallback = (DEFAULT_SETTINGS.baseUrls as Record<string, string>)[provider] ?? '';
    if (!store.boundTo(provider, endpoint, fallback)) {
      console.warn(
        `[security] refusing to send the ${provider} key to ${endpoint || '(default)'}: ` +
          'it was not saved for this endpoint. Re-enter it in Settings to bind it.',
      );
      return null;
    }
    return store.get(provider);
  };

  /**
   * The bundled engine and weights, overridable per setting.
   *
   * Packaged, these live in `resources/vendor` (unpacked from the asar — a
   * child process cannot be spawned from inside an archive, and llama.cpp
   * memory maps the weights). In the dev tree they are in `vendor/`.
   */
  const localPaths = () => {
    const configured = settings.get().localModel;
    const bundled = bundledPaths(
      app.isPackaged ? process.resourcesPath : null,
      path.join(__dirname, '..', '..'),
    );
    return {
      serverPath: configured.serverPath.trim() || bundled.serverPath,
      modelPath: configured.modelPath.trim() || bundled.modelPath,
    };
  };

  const local = new LocalProvider(localPaths, () => {
    const { contextSize, threads } = settings.get().localModel;
    return { contextSize, threads };
  });

  const providers = new Map<ProviderId, Provider>([
    ['local', local],
    [
      'anthropic',
      new AnthropicProvider(
        () => keyForEndpoint(secrets, 'anthropic', settings.get().baseUrls.anthropic),
        () => settings.get().baseUrls.anthropic,
      ),
    ],
    [
      'openai',
      new OpenAIProvider(
        () => keyForEndpoint(secrets, 'openai', settings.get().baseUrls.openai),
        () => settings.get().baseUrls.openai,
      ),
    ],
    ['ollama', new OllamaProvider(() => settings.get().baseUrls.ollama)],
    ['claude-cli', new ClaudeCodeProvider(bridgeInfo, () => settings.get().cliPaths['claude-cli'])],
    ['codex-cli', new CodexProvider(bridgeInfo, () => settings.get().cliPaths['codex-cli'])],
  ]);

  const win = new AppWindow(settings, history);
  appWindow = win;

  approvals.setEmitter((req) => win.send(CH.agentApprovalRequest, req));
  questions.setEmitter((q) => win.send(CH.agentQuestion, q));

  // The built-in tool set is fixed; plugin and MCP tools are re-read on every
  // turn so reloading an integration takes effect without a restart.
  const builtins: Tool[] = [
    ...browserTools(),
    ...tabTools(),
    ...webTools(),
    ...dataTools(),
    ...memoryTools(),
  ];

  const agent = new Agent({
    providers: providers as Map<string, Provider>,
    settings,
    sessions,
    tabs: win.tabs,
    history,
    approvals,
    questions,
    userDataPath,
    getTools: () => [...builtins, ...plugins.tools, ...mcp.tools],
    emit: (event) => win.send(CH.agentEvent, event),
  });

  bridgeCall = (name, args, clientId) => agent.runToolForExternalAgent(name, args, clientId);
  await bridge.start().catch((err: unknown) => {
    // The browser is fully usable without it; only the CLI backends and
    // external editor agents depend on the bridge.
    console.error('[bridge] failed to start:', err);
  });

  // Extensions live in the tab partition, so their content scripts run in the
  // pages the user actually looks at.
  extensions.attach(session.fromPartition('persist:nabsun'));
  win.setExtensionPopupResolver((id) => {
    const ext = extensions.byId(id);
    const status = extensions.status().find((s) => s.id === id);
    if (!ext || !status?.popupPath) return null;
    return { url: `${ext.url}${status.popupPath.replace(/^\/+/, '')}` };
  });

  const reloadIntegrations = async () => {
    plugins.reload();
    await mcp.reload(settings.get().mcpServers);
  };

  const deps: IpcDeps = {
    win,
    settings,
    secrets,
    history,
    sessions,
    agent,
    approvals,
    questions,
    mcp,
    plugins,
    providers,
    downloads,
    extensions,
    accounts,
    passwords,
    reloadIntegrations,
    bridgeInfo: () => ({
      running: bridge.running,
      url: bridge.url,
      token: bridge.token,
      serverScript: mcpServerScript,
    }),
  };

  registerInternalProtocol(session.fromPartition('persist:nabsun'), () => {
    const config = settings.get();
    return {
      // Internal pages read this off <html>. "system" resolves to an empty
      // string on purpose: the palette's prefers-color-scheme rule only
      // applies when neither explicit value is set.
      THEME: config.theme === 'system' ? '' : config.theme,
      APP_VERSION: app.getVersion(),
      CHROMIUM: process.versions.chrome,
      ELECTRON: process.versions.electron,
      NODE: process.versions.node,
      V8: process.versions.v8,
      PLATFORM: process.platform,
      ARCH: process.arch,
      PROVIDER: config.provider,
      MODEL: config.models[config.provider] ?? '(not set)',
      TOOL_COUNT: String(agent.toolSpecs().length),
      PLUGIN_COUNT: String(plugins.status().filter((p) => p.loaded).length),
      MCP_COUNT: String(mcp.status(config.mcpServers).filter((m) => m.connected).length),
      USER_DATA: userDataPath,
      CONFIG_FILE: path.join(userDataPath, 'settings.json'),
      PLUGINS_DIR: plugins.directory,
      // `</` is escaped so a page title can never close the script element.
      HISTORY_JSON: JSON.stringify(history.search('', 500)).replace(/<\//g, '<\\/'),
      TOP_SITES_JSON: JSON.stringify(favourites(history)).replace(/<\//g, '<\\/'),
    };
  });

  /* --------------------------------------------------- password autofill */

  // These come from the page preload, so the sender's own URL decides the
  // origin — never a value the page could choose for itself.
  ipcMain.handle('pw:for-origin', (event) => {
    if (!settings.get().savePasswords) return null;
    const origin = PasswordStore.originOf(event.sender.getURL());
    if (!origin) return null;
    const found = passwords.forOrigin(origin);
    return found.length ? found : null;
  });

  ipcMain.on('pw:used', (_e, id: string) => passwords.markUsed(id));

  ipcMain.on('pw:capture', (event, payload: { username: string; password: string }) => {
    if (!settings.get().savePasswords) return;
    const origin = PasswordStore.originOf(event.sender.getURL());
    if (!origin || !payload?.password) return;
    // Nothing to ask about if we already hold exactly this credential.
    if (passwords.isKnown(origin, payload.username ?? '', payload.password)) return;

    win.setPendingLogin({ origin, username: payload.username ?? '', password: payload.password });
    win.send(CH.pwPrompt, {
      origin,
      username: payload.username ?? '',
      isUpdate: passwords.isUpdate(origin, payload.username ?? ''),
    });
  });

  ipcMain.on('page:selection', () => {
    /* reserved for the selection-aware assistant actions */
  });

  /* ------------------------------------------- browsing behaviour wiring */

  downloads.attach(session.fromPartition('persist:nabsun'));
  downloads.on('change', () => win.send(CH.downloadsChanged, downloads.list()));

  const contextMenuDeps = {
    window: win.window,
    tabs: win.tabs,
    getSettings: () => settings.get(),
    contentBounds: () => win.contentBounds,
    askAssistant: (prompt: string) => {
      win.toggleSidebar(true);
      win.send(CH.overlayCommand, { command: 'ask-selection', arg: prompt });
    },
  };
  // Every tab gets a context menu, including ones opened later.
  win.tabs.on('tab-created', (tab) => attachContextMenu(contextMenuDeps, tab));
  for (const tab of win.tabs.all) attachContextMenu(contextMenuDeps, tab);

  registerIpc(deps);
  buildMenu(deps);

  settings.onChange((next) => win.send(CH.settingsChanged, next));

  // Restore the previous window, like every browser does. Falls back to the
  // homepage on a first run or after a crash left nothing to restore.
  const sessionFile = path.join(userDataPath, 'window-session.json');
  let restored = false;
  try {
    if (fs.existsSync(sessionFile)) {
      restored = win.tabs.restore(
        JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { urls: string[]; activeIndex: number },
      );
    }
  } catch (err) {
    console.error('[session] could not restore tabs:', err);
  }
  if (!restored) win.tabs.create(settings.get().homepage);

  // Written on a debounce as tabs change, so a hard kill still leaves a
  // recent snapshot behind.
  let saveTimer: NodeJS.Timeout | null = null;
  win.tabs.on('update', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(sessionFile, JSON.stringify(win.tabs.snapshot()), 'utf8');
      } catch {
        /* a failed snapshot must never interrupt browsing */
      }
    }, 1500);
  });

  // Integrations start in the background: a slow MCP server or extension must
  // not delay the first paint of the browser.
  void reloadIntegrations();
  void extensions.loadAll().then(() => win.send(CH.extChanged, extensions.status()));

  app.on('second-instance', () => {
    win.window.show();
    win.window.focus();
  });

  app.on('before-quit', () => {
    agent.abortAll();
    approvals.denyAll();
    questions.cancelAll();
    // A stranded llama-server would keep a gigabyte of weights resident.
    local.stop();
    settings.flush();
    history.flush();
    passwords.flush();
    bridge.stop();
    void mcp.shutdown();
  });
}

/**
 * Tiles for the new tab page: bookmarks the user put on the bar first, since
 * those are a deliberate choice, then most-visited sites to fill the grid.
 */
function favourites(history: HistoryStore): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  const seen = new Set<string>();

  for (const bm of history.bookmarks()) {
    if (bm.onBar === false || seen.has(bm.url)) continue;
    seen.add(bm.url);
    out.push({ url: bm.url, title: bm.title });
  }
  for (const site of history.topSites(12)) {
    if (seen.has(site.url)) continue;
    seen.add(site.url);
    out.push({ url: site.url, title: site.title });
  }
  return out.slice(0, 12);
}

/** A small, honest tracker blocklist plus a conservative permission policy. */
const BLOCKED_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googletagservices.com',
  'google-analytics.com',
  'googletagmanager.com',
  'adservice.google.com',
  'scorecardresearch.com',
  'adnxs.com',
  'criteo.com',
  'taboola.com',
  'outbrain.com',
  'quantserve.com',
  'moatads.com',
];


function configureSession(settings: SettingsStore) {
  const ses = session.fromPartition('persist:nabsun');

  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!settings.get().blockAds) return callback({});
    try {
      const host = new URL(details.url).hostname;
      const blocked = BLOCKED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
      return callback({ cancel: blocked });
    } catch {
      return callback({});
    }
  });

  applyPermissionPolicy(ses);

  // A bad certificate is not something to click through casually: refuse it and
  // let did-fail-load render the explanation page.
  app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
    event.preventDefault();
    console.warn(`[security] rejected certificate for ${url}: ${error}`);
    callback(false);
  });

  // Sites behind HTTP basic auth would otherwise hang on a prompt we never
  // show. Cancel cleanly so the page reports an error instead.
  app.on('login', (event, _wc, _details, _authInfo, callback) => {
    event.preventDefault();
    callback();
  });

  // Present as a normal Chrome build so sites don't serve degraded pages to an
  // unrecognised Electron UA string.
  const chromeVersion = process.versions.chrome;
  ses.setUserAgent(
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
  );
}

function zoomActive(deps: IpcDeps, direction: 'in' | 'out' | 'reset') {
  const id = deps.win.tabs.activeTabId;
  if (id) deps.win.tabs.zoom(id, direction);
}

/**
 * A tab change the *user* made, from the menu or a keyboard shortcut.
 *
 * The agent has to hear about it for the same reason a click does: it drops any
 * tab the assistant had chosen earlier, so "this page" keeps meaning the page
 * in front of the user. Clicking a tab went through IPC and told the agent;
 * Ctrl+Tab called TabManager directly and did not.
 */
function switchTab(deps: IpcDeps, change: () => void): void {
  change();
  deps.agent.userSwitchedTab();
}

function buildMenu(deps: IpcDeps) {
  const run = (command: string) => () => handleCommand(deps, command);
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: run('new-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: run('close-tab') },
        { type: 'separator' },
        { label: 'Save Page As…', accelerator: 'CmdOrCtrl+S', click: run('save-page') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => deps.win.tabs.active?.wc.print() },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: run('open-settings') },
        {
          label: 'Clear Browsing Data…',
          accelerator: 'CmdOrCtrl+Shift+Delete',
          click: run('clear-data'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Page', accelerator: 'CmdOrCtrl+F', click: run('find') },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        // Every one of these is the user changing which tab they are on, so
        // they notify the agent exactly as clicking a tab does. Going straight
        // to TabManager meant switching by mouse and by keyboard left the
        // assistant pointing at different tabs.
        {
          label: 'Next Tab',
          accelerator: 'Control+Tab',
          click: () => switchTab(deps, () => deps.win.tabs.cycle(1)),
        },
        {
          label: 'Previous Tab',
          accelerator: 'Control+Shift+Tab',
          click: () => switchTab(deps, () => deps.win.tabs.cycle(-1)),
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => switchTab(deps, () => deps.win.tabs.reopenLast()),
        },
        { type: 'separator' },
        // Ctrl+1..8 pick a tab by position; Ctrl+9 jumps to the last one,
        // matching every other browser.
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
          label: `Tab ${n}`,
          accelerator: `CmdOrCtrl+${n}`,
          click: () => switchTab(deps, () => deps.win.tabs.activateByIndex(n - 1)),
          visible: false,
        })),
        {
          label: 'Last Tab',
          accelerator: 'CmdOrCtrl+9',
          click: () => switchTab(deps, () => deps.win.tabs.activateByIndex(-1)),
          visible: false,
        },
        {
          label: 'Duplicate Tab',
          click: () => {
            const id = deps.win.tabs.activeTabId;
            if (id) deps.win.tabs.duplicate(id);
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        // Alt+Left/Right, as every browser binds them. The toolbar arrows were
        // the only way to go back, which is not where anyone reaches first.
        { label: 'Back', accelerator: 'Alt+Left', click: run('back') },
        { label: 'Forward', accelerator: 'Alt+Right', click: run('forward') },
        { label: 'Home', accelerator: 'Alt+Home', click: run('home') },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: run('reload') },
        {
          label: 'Hard Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => deps.win.tabs.active?.wc.reloadIgnoringCache(),
        },
        {
          label: 'Stop',
          accelerator: 'Escape',
          click: () => deps.win.tabs.active?.wc.stop(),
        },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => zoomActive(deps, 'in'),
        },
        // Chrome accepts both the shifted and unshifted key for zoom in.
        {
          label: 'Zoom In (=)',
          accelerator: 'CmdOrCtrl+=',
          click: () => zoomActive(deps, 'in'),
          visible: false,
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => zoomActive(deps, 'out'),
        },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => zoomActive(deps, 'reset'),
        },
        { type: 'separator' },
        {
          label: 'History',
          accelerator: 'CmdOrCtrl+H',
          click: () => deps.win.tabs.create('nabsun://history'),
        },
        {
          label: 'Bookmark This Page',
          accelerator: 'CmdOrCtrl+D',
          click: () => handleCommand(deps, 'bookmark-page'),
        },
        {
          label: 'Bookmarks',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => handleCommand(deps, 'open-bookmarks'),
        },
        {
          label: 'Show Bookmarks Bar',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => deps.win.toggleBookmarksBar(),
        },
        {
          label: 'Saved Passwords',
          click: () => handleCommand(deps, 'open-passwords'),
        },
        {
          label: 'Full Screen',
          accelerator: 'F11',
          click: () => deps.win.window.setFullScreen(!deps.win.window.isFullScreen()),
        },
        {
          label: 'Downloads',
          accelerator: 'CmdOrCtrl+J',
          click: () => {
            deps.win.toggleSidebar(true);
            deps.win.send(CH.overlayCommand, { command: 'open-downloads' });
          },
        },
        {
          label: 'View Source',
          accelerator: 'CmdOrCtrl+U',
          click: run('view-source'),
        },
        { type: 'separator' },
        {
          label: 'Open Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => deps.win.showOverlay('omnibox', { query: deps.win.tabs.active?.wc.getURL() ?? '' }),
        },
        {
          label: 'Command Palette',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => deps.win.showOverlay('palette', {}),
        },
        { type: 'separator' },
        { label: 'Toggle AI Sidebar', accelerator: 'CmdOrCtrl+Shift+A', click: run('toggle-sidebar') },
        { type: 'separator' },
        { label: 'Developer Tools (page)', accelerator: 'F12', click: run('devtools') },
        {
          label: 'Developer Tools (browser UI)',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => deps.win.shell.webContents.openDevTools({ mode: 'detach' }),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Nabsun', click: () => deps.win.tabs.create('nabsun://about') },
        { type: 'separator' },
        { label: 'Plugins Folder', click: () => void shell.openPath(deps.plugins.directory) },
        { label: 'Profile Folder', click: () => void shell.openPath(app.getPath('userData')) },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(boot).catch((err) => {
  console.error('[main] failed to start:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!appWindow && BrowserWindow.getAllWindows().length === 0) void boot();
});






