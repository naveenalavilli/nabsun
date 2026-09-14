/**
 * Shared type contract between the main process, preload bridges and renderers.
 * This file must not import anything from `electron` or `node:*` so that it can
 * be bundled into the sandboxed renderer as well as the privileged host.
 */

/* ------------------------------------------------------------------ tabs -- */

export interface TabState {
  id: string;
  url: string;
  /** The URL currently shown in the omnibox (may differ while the user types). */
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  muted: boolean;
  pinned: boolean;
  /** Set when the last navigation failed, cleared on the next successful load. */
  error: string | null;
  /** True while the agent is driving this tab, so the UI can badge it. */
  agentControlled: boolean;
}

export interface WindowState {
  tabs: TabState[];
  activeTabId: string | null;
  sidebarOpen: boolean;
  sidebarWidth: number;
  findOpen: boolean;
  bookmarksBarVisible: boolean;
}

/* ------------------------------------------------------------------ chat -- */

export type ToolCallStatus = 'running' | 'ok' | 'error' | 'denied';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
  status: ToolCallStatus;
  /** Human-readable summary rendered in the transcript. */
  result?: string;
  durationMs?: number;
}

export interface ImageBlock {
  type: 'image';
  mediaType: string;
  data: string; // base64, no data: prefix
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: ContentBlock[];
  createdAt: number;
  /** Present on assistant messages once the turn is finished. */
  stopReason?: string;
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

/* ---------------------------------------------------------------- agent --- */

export type RiskLevel = 'safe' | 'write' | 'dangerous';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: RiskLevel;
  /** e.g. "browser", "tabs", "mcp:github", "plugin:jira" */
  source: string;
}

export type AgentEvent =
  | { type: 'turn_start'; sessionId: string; messageId: string }
  | { type: 'text_delta'; messageId: string; delta: string }
  | { type: 'thinking_delta'; messageId: string; delta: string }
  | { type: 'tool_start'; messageId: string; toolCallId: string; name: string; input: unknown }
  | {
      type: 'tool_end';
      messageId: string;
      toolCallId: string;
      status: ToolCallStatus;
      result: string;
      durationMs: number;
    }
  | { type: 'step'; messageId: string; step: number; maxSteps: number }
  | { type: 'usage'; messageId: string; usage: TokenUsage }
  | { type: 'turn_end'; sessionId: string; messageId: string; stopReason: string }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'aborted'; sessionId: string };

export interface ApprovalRequest {
  id: string;
  toolName: string;
  risk: RiskLevel;
  title: string;
  detail: string;
  input: unknown;
}

export type ApprovalDecision = 'allow' | 'allow_always' | 'deny';

/**
 * A question the assistant is waiting on an answer to.
 *
 * Distinct from an approval: an approval asks whether an action may proceed, a
 * question asks for information only the user has. The turn stays open either
 * way.
 */
export interface AgentQuestion {
  id: string;
  sessionId: string;
  question: string;
  /** Suggested answers, offered as buttons. The user can always type instead. */
  options: string[];
}

/* -------------------------------------------------------------- settings -- */

/**
 * `local` is the default: weights bundled with the app, run by an embedded
 * llama.cpp, no account and no network. `claude-cli` and `codex-cli` delegate
 * the whole turn to a locally installed agent CLI, reusing the login you
 * already have there — the same arrangement as the Claude and Codex extensions
 * in VS Code. The others call an API directly.
 */
export type ProviderId = 'local' | 'anthropic' | 'openai' | 'ollama' | 'claude-cli' | 'codex-cli';

export const CLI_PROVIDERS: ProviderId[] = ['claude-cli', 'codex-cli'];

/** Backends that need no credential: nothing to enter, nothing to store. */
export const KEYLESS_PROVIDERS: ProviderId[] = ['local', 'ollama'];

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface Settings {
  provider: ProviderId;
  models: Record<ProviderId, string>;
  baseUrls: { openai: string; ollama: string; anthropic: string };
  /** Optional explicit paths to the agent CLIs, when they are not on PATH. */
  cliPaths: Record<'claude-cli' | 'codex-cli', string>;
  /** The built-in model. Empty paths mean "use the bundled engine and weights". */
  localModel: {
    /** Path to a llama-server executable, to override the bundled one. */
    serverPath: string;
    /** Path to a .gguf file, to run a different model than the bundled one. */
    modelPath: string;
    /** Context window in tokens. Bigger costs RAM. */
    contextSize: number;
    /** CPU threads; 0 lets llama.cpp decide. */
    threads: number;
  };
  homepage: string;
  searchEngine: 'google' | 'duckduckgo' | 'bing';
  theme: 'dark' | 'light' | 'system';
  sidebarWidth: number;
  sidebarOpen: boolean;
  /** Risk levels the agent may run without asking. */
  autoApprove: Record<RiskLevel, boolean>;
  /** Tools the user chose "always allow" for, regardless of their risk level. */
  alwaysAllowTools: string[];
  maxAgentSteps: number;
  /** Send a screenshot alongside the DOM snapshot when the model supports it. */
  vision: boolean;
  extendedThinking: boolean;
  /**
   * Show the mechanics - reasoning trace and per-tool cards - in the
   * transcript.
   *
   * Distinct from `extendedThinking`, which asks the *model* for reasoning.
   * The CLI backends stream their reasoning whether or not it was asked for,
   * so the only way to keep the panel readable is to decide separately what
   * the transcript displays. Off by default: a wall of `mcp__nabsun__fetch_url`
   * lines tells the user nothing they wanted to know.
   */
  verbose: boolean;
  blockAds: boolean;
  bookmarksBarVisible: boolean;
  /** Offer to save passwords typed into sign-in forms. */
  savePasswords: boolean;
  mcpServers: Record<string, McpServerConfig>;
  /** Unpacked Chrome extensions, re-loaded on every launch. */
  chromeExtensions: ChromeExtensionEntry[];
}

export interface ConfigPaths {
  userData: string;
  configFile: string;
  pluginsDir: string;
  sessionsDir: string;
}

export interface ConfigActionResult {
  ok: boolean;
  /** Set when the user cancelled the file dialog rather than hitting an error. */
  cancelled?: boolean;
  path?: string;
  error?: string;
  settings?: Settings;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  /**
   * Whether this backend is ready to use: a key is stored for an API provider,
   * the binary is present for a CLI, the weights are on disk for the local one.
   */
  hasCredentials: boolean;
  models: string[];
  kind: 'api' | 'cli' | 'local';
  /** Where a CLI or model was found, or why it is unavailable. */
  detail?: string;
}

/** Everything an external agent needs to connect to this browser over MCP. */
export interface BridgeInfo {
  running: boolean;
  url: string;
  token: string;
  serverScript: string;
  /** Ready-to-paste MCP client configuration. */
  configJson: string;
}

/* -------------------------------------------------------- history / etc. -- */

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  visitedAt: number;
  visitCount: number;
}

export interface DownloadEntry {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  completedAt?: number;
  paused: boolean;
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  folder: string;
  /** Shown on the bookmarks bar under the toolbar. */
  onBar?: boolean;
}

/** A saved password, without the password. */
export interface SavedLogin {
  id: string;
  origin: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  timesUsed: number;
  lastUsedAt: number | null;
}

/** Offered when a sign-in is submitted with credentials we have not stored. */
export interface PasswordPrompt {
  origin: string;
  username: string;
  /** True when we already hold a different password for this origin+username. */
  isUpdate: boolean;
}

export interface ClearDataRequest {
  history: boolean;
  bookmarks: boolean;
  passwords: boolean;
  cookies: boolean;
  cache: boolean;
}

export interface OmniboxSuggestion {
  kind: 'search' | 'history' | 'bookmark' | 'url' | 'command' | 'ask';
  title: string;
  subtitle?: string;
  value: string;
  icon?: string;
}

/* --------------------------------------------------------------- plugins -- */

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Entry file relative to the plugin directory. */
  main: string;
  /** Declared capabilities, mirrors the VS Code contributes model. */
  contributes?: {
    tools?: { name: string; description: string; risk?: RiskLevel }[];
    commands?: { id: string; title: string }[];
  };
}

export interface PluginStatus {
  id: string;
  name: string;
  version: string;
  path: string;
  enabled: boolean;
  loaded: boolean;
  error?: string;
  toolNames: string[];
}

/* ------------------------------------------------------------ extensions -- */

export interface ChromeExtensionEntry {
  path: string;
  enabled: boolean;
}

export interface ExtensionStatus {
  id: string;
  name: string;
  version: string;
  description: string;
  path: string;
  enabled: boolean;
  loaded: boolean;
  error?: string;
  /** True when the extension contributes a toolbar button. */
  hasAction: boolean;
  popupPath?: string;
  /** Icon bytes as a data URL; the shell cannot fetch chrome-extension:// . */
  iconDataUrl?: string;
  manifestVersion: number;
}

/**
 * An AI backend presented as something you install, rather than a setting you
 * configure. Codex and Claude Code are the CLI-backed ones — adding them is
 * exactly the VS Code arrangement: the tool brings its own login, the browser
 * supplies the tools.
 */
export interface AgentExtension {
  id: ProviderId;
  name: string;
  publisher: string;
  summary: string;
  /** What it can do once added. */
  capabilities: string[];
  kind: 'cli' | 'api' | 'local';
  /** Installed = usable right now (CLI on PATH, or a key stored). */
  installed: boolean;
  /** True when this is the backend the assistant is currently using. */
  active: boolean;
  /** Where the CLI was found, or why it is not usable yet. */
  detail?: string;
  /** Shown when it is not installed. */
  installCommand?: string;
  docsUrl?: string;
}

/** Whether a CLI-backed assistant currently has an account connected. */
export interface AccountStatus {
  provider: ProviderId;
  /** False when this CLI has no non-interactive account commands. */
  supported: boolean;
  connected: boolean;
  detail: string;
}

export interface McpStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  error?: string;
  toolNames: string[];
}

/* ------------------------------------------------------------ page model -- */

/** One interactive element in a page snapshot, addressed by `ref` in tool calls. */
export interface PageElement {
  /** Opaque, document-qualified handle. Pass it back verbatim; never parse it. */
  ref: string;
  tag: string;
  role: string;
  name: string;
  value?: string;
  placeholder?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
  expanded?: boolean;
  rect: { x: number; y: number; w: number; h: number };
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Readable text content, already truncated to a token budget. */
  text: string;
  elements: PageElement[];
  scroll: { x: number; y: number; height: number; viewportHeight: number };
  truncated: boolean;
}



