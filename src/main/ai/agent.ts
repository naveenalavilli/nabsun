import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ChatMessage,
  ContentBlock,
  Settings,
  ToolCallBlock,
  ToolSpec,
} from '../../shared/types';
import { isOnDevice } from '../../shared/types';
import type { HistoryStore } from '../history';
import type { SettingsStore } from '../store';
import type { TabManager } from '../tabs';
import { ApprovalManager } from './approvals';
import { compactSystemPrompt, systemPrompt, turnContext } from './prompt';
import { SoulStore } from '../soul';
import { MissingCredentialsError, type ModelBlock, type ModelMessage, type Provider } from './provider';
import type { QuestionManager } from './questions';
import type { SessionStore } from './sessions';
import type { Tool, ToolContext, ToolResult } from './tools/types';

export interface AgentDeps {
  providers: Map<string, Provider>;
  settings: SettingsStore;
  sessions: SessionStore;
  tabs: TabManager;
  history: HistoryStore;
  approvals: ApprovalManager;
  /** Absent in harnesses and anywhere there is no user to ask. */
  questions?: QuestionManager;
  /** Re-evaluated each turn so plugins and MCP servers can be reloaded live. */
  getTools: () => Tool[];
  userDataPath: string;
  emit: (event: AgentEvent) => void;
}

/**
 * What a small local model gets instead of the whole catalogue.
 *
 * Twenty-three tool schemas cost ~2,900 prompt tokens, which on a CPU backend
 * is roughly ninety seconds of processing before the model has read the
 * question. These are the ones an ordinary browsing task actually uses; the
 * rest — memory, bookmarks, history, extraction, screenshots, evaluate — are
 * still there for a backend with room for them.
 *
 * Fewer tools also helps the model itself: a 1.7B choosing between twenty-three
 * options chooses badly.
 */
const CORE_TOOLS = new Set([
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_navigate',
  'browser_read_text',
  'browser_back',
  'tab_open',
  'web_search',
  'ask_user',
]);

/**
 * Chooses the prompt and tool set for a backend.
 *
 * Exported so the latency harness measures the request the app actually sends.
 * It previously built its own, which is how a measurement can keep reporting a
 * number the product no longer produces.
 */
/**
 * A small context is a latency budget, not only a capacity limit: on a CPU
 * backend prompt tokens are the dominant wait. Exported so the caller deciding
 * how much of soul.md to read uses the same threshold the prompt does.
 */
export const isLeanBackend = (contextTokens?: number): boolean =>
  (contextTokens ?? Infinity) <= 16_000;

export function shapeRequest(opts: {
  contextTokens?: number;
  tools: ToolSpec[];
  vision: boolean;
  /** `soul.md`, when the user keeps one and has not switched it off. */
  soul?: string | null;
}): { system: string; tools: ToolSpec[]; lean: boolean } {
  const lean = isLeanBackend(opts.contextTokens);
  const tools = opts.tools
    // Screenshots are pure cost where they cannot be seen: the bytes are
    // dropped downstream, and the schema is not free. `supportsVision()`
    // existed and nothing consulted it.
    .filter((t) => t.name !== 'browser_screenshot' || opts.vision)
    .filter((t) => !lean || CORE_TOOLS.has(t.name));
  return {
    system: lean ? compactSystemPrompt(opts.soul) : systemPrompt(opts.soul),
    tools,
    lean,
  };
}

/** Older tool output is truncated when replayed, to bound context growth. */
const REPLAY_TOOL_RESULT_CHARS = 4_000;
const MAX_HISTORY_MESSAGES = 80;

/**
 * One unit of work holding the browser.
 *
 * Chats and external clients both run through this, so cancellation and tab
 * ownership mean the same thing for each. `tabId` lives here rather than on the
 * Agent because a single shared target let two runs retarget one another: A
 * selected tab A, B selected tab B, and A then acted on B.
 */
interface Run {
  id: string;
  kind: 'chat' | 'external';
  controller: AbortController;
  /** The tab this run is working in, chosen by its own tool calls. */
  tabId: string | null;
  /** Calls currently inside this run, so a cancelled run is cleaned up once. */
  pending: number;
  /**
   * Whether "the current tab" means the tab the *user* is looking at.
   *
   * True for the in-app assistant: the user and the assistant share one screen,
   * the assistant works in the open, and the user is expected to follow along
   * and take over on the page. Anchoring to a remembered tab instead makes the
   * assistant answer about a page the user cannot see.
   *
   * False for external clients, which have no shared screen and would otherwise
   * fight each other and the user for the foreground.
   */
  followsUser: boolean;
}

/**
 * The target an action was approved against.
 *
 * Approval and execution are separated by however long the user takes, and the
 * browser does not hold still in between — they can switch tabs, and the page
 * can navigate. Recording what was shown at approval time is what lets the
 * action refuse to land somewhere else.
 */
interface TargetBinding {
  tabId: string | null;
  url: string | null;
}

export class Agent {
  private runs = new Map<string, Run>();

  constructor(private readonly deps: AgentDeps) {}

  /**
   * Whether soul.md may go to the backend this turn will use.
   *
   * Checked per turn rather than per session: switching provider mid-chat has
   * to change the answer, or the guarantee lasts only until someone changes a
   * dropdown.
   */
  private shareSoulWith(config: Settings): boolean {
    if (!config.personalContext) return false;
    if (!config.personalContextLocalOnly) return true;
    return isOnDevice(config.provider, config.baseUrls);
  }

  /**
   * Reads `soul.md` out of the profile folder.
   *
   * Built lazily from the path the agent already carries, so harnesses that
   * construct an Agent keep working unchanged and an absent file simply reads
   * as null. It cannot be a field initializer: those run before the
   * constructor assigns `deps`.
   */
  private soulStore: SoulStore | null = null;
  private get soul(): SoulStore {
    this.soulStore ??= new SoulStore(this.deps.userDataPath);
    return this.soulStore;
  }

  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  private startRun(id: string, kind: Run['kind']): Run {
    const run: Run = {
      id,
      kind,
      controller: new AbortController(),
      tabId: null,
      pending: 0,
      followsUser: kind === 'chat',
    };
    this.runs.set(id, run);
    return run;
  }

  /**
   * Stops a chat *and* every external call in flight.
   *
   * Stop means "stop acting on my browser". An external client's pending write
   * is waiting at a prompt in the same sidebar, so leaving it running while the
   * chat stops is not a distinction the user made — and previously the Stop
   * button reached only the chat, so approving that prompt afterwards still
   * performed the write.
   */
  abort(sessionId: string) {
    this.runs.get(sessionId)?.controller.abort();
    for (const [id, run] of [...this.runs]) {
      if (run.kind !== 'external') continue;
      run.controller.abort();
      // Discard it so the client's next request starts clean rather than
      // arriving into an already-cancelled run.
      if (run.pending === 0) this.runs.delete(id);
    }
  }

  /**
   * The user changed tabs themselves.
   *
   * That drops any explicit target a chat run had chosen, so the assistant goes
   * back to working on whatever the user is now looking at. Only the user's own
   * switches call this — a tab the assistant focuses is its own explicit
   * choice and must not clear itself.
   */
  userSwitchedTab(): void {
    for (const run of this.runs.values()) {
      if (run.followsUser) run.tabId = null;
    }
  }

  abortAll() {
    for (const run of this.runs.values()) run.controller.abort();
    this.runs.clear();
  }

  toolSpecs(): ToolSpec[] {
    return this.deps.getTools().map(({ name, description, inputSchema, risk, source }) => ({
      name,
      description,
      inputSchema,
      risk,
      source,
    }));
  }

  /**
   * Entry point for an agent running outside this process — the Claude Code or
   * Codex CLI, or an editor extension connected over MCP. It goes through the
   * same approval gate as the built-in assistant, so connecting grants no extra
   * authority.
   */
  async runToolForExternalAgent(
    name: string,
    input: Record<string, unknown>,
    clientId = 'anonymous',
  ): Promise<string> {
    const tool = this.deps.getTools().find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool "${name}".`);

    // One run per *client*, not per call. A run per call kept clients from
    // interfering with each other but also threw away the client's own tab
    // between requests, so an agent that selected a background tab and then
    // acted found itself back on whatever the user was looking at.
    const run = this.externalRun(clientId);
    run.pending++;

    try {
      // Bound before the prompt, like the chat path: an external client's write
      // is approved against a specific tab and page too.
      const binding = this.bindTarget(run, input);
      const approved = await this.deps.approvals.request(tool, input, run.controller.signal);
      if (!approved) throw new Error('The user declined this action in Nabsun.');
      const raw = await this.dispatch(tool, input, run, binding);
      return typeof raw === 'string' ? raw : raw.content;
    } finally {
      run.pending--;
      // The run outlives a single call so its tab survives, but not a Stop:
      // a cancelled run is discarded once nothing is still inside it.
      //
      // Identity, not id. After a Stop, the next call from the same client
      // installs a *new* run under the same id; a late-finishing call from the
      // old one then deleted its replacement, leaving live work untracked and
      // its tab lost. Only remove the entry if it is still this run.
      if (
        run.controller.signal.aborted &&
        run.pending === 0 &&
        this.runs.get(run.id) === run
      ) {
        this.runs.delete(run.id);
      }
    }
  }

  /** The client's run, resumed if it is still live, or a fresh one. */
  private externalRun(clientId: string): Run {
    const id = `external:${clientId}`;
    const existing = this.runs.get(id);
    if (existing && !existing.controller.signal.aborted) return existing;
    return this.startRun(id, 'external');
  }

  /**
   * The single point where an approved call becomes an action.
   *
   * Cancellation is rechecked here, not only before the approval prompt:
   * approval takes as long as the user takes, and a Stop during it has to win.
   * Every path — chat loop and external client — goes through this, because
   * the check existing on only one of them is how the API loop kept executing
   * writes after an abort.
   */
  private async dispatch(
    tool: Tool,
    input: Record<string, unknown>,
    run: Run,
    binding?: TargetBinding,
  ) {
    if (run.controller.signal.aborted) throw new Error('Stopped before this action ran.');

    // The target is revalidated after approval, not only chosen before it.
    // Approval takes as long as the user takes, and switching tabs during it
    // used to silently move the action: they approved a write against the page
    // they were reading and it landed on the one they switched to.
    if (binding && tool.risk !== 'safe') {
      const now = this.bindTarget(run, input);
      if (binding.tabId && now.tabId !== binding.tabId) {
        throw new Error(
          'The target tab changed while this was waiting for approval, so it was not run. ' +
            'Re-check the page and ask again if you still want it.',
        );
      }
      const tab = binding.tabId ? this.deps.tabs.byId(binding.tabId) : null;
      if (binding.tabId && !tab) {
        throw new Error('The tab this action was approved for has been closed.');
      }
      if (tab && binding.url && tab.wc.getURL() !== binding.url) {
        throw new Error(
          `That page navigated while this was waiting for approval (was ${binding.url}). ` +
            'Take a fresh snapshot before acting.',
        );
      }
    }

    return tool.handler(input, this.toolContext(run, binding));
  }

  /**
   * The tab an action is about to act on, captured so approval and execution
   * cannot disagree. An explicit `tabId` argument wins, as the handlers use it.
   */
  private bindTarget(run: Run, input: Record<string, unknown>): TargetBinding {
    const explicit = typeof input.tabId === 'string' ? input.tabId : null;
    const chosen = explicit ?? this.toolContext(run).getAgentTabId();
    const tab = chosen ? this.deps.tabs.byId(chosen) : null;
    return { tabId: chosen, url: tab ? tab.wc.getURL() : null };
  }

  private toolContext(run: Run, binding?: TargetBinding): ToolContext {
    return {
      tabs: this.deps.tabs,
      history: this.deps.history,
      settings: this.deps.settings,
      // Two ways a chat run can have a target, in priority order.
      //
      // An *explicit* one, set by a tool that opened or focused a tab, wins:
      // without it a background tab could never be worked on at all, because
      // the default would keep pointing at whatever the user was reading.
      // `tab_open(background: true)` was doing exactly that — reporting a
      // background tab while acting on the user's foreground one.
      //
      // Otherwise the tab the user is looking at, so "this page" means what
      // someone watching the browser thinks it means. A user-initiated tab
      // switch clears the explicit target (see userSwitchedTab), which is the
      // signal that they have moved the work somewhere else.
      //
      // External runs have no shared screen and always use their own target.
      getAgentTabId: () => {
        // A bound call keeps the target it was approved against, so the user
        // switching tabs mid-action cannot move where it lands.
        if (binding?.tabId && this.deps.tabs.byId(binding.tabId)) return binding.tabId;
        if (!run.followsUser) return run.tabId;
        if (run.tabId && this.deps.tabs.byId(run.tabId)) return run.tabId;
        return this.deps.tabs.activeTabId;
      },
      setAgentTabId: (id) => {
        run.tabId = id;
        // Deliberately no activation here. Bringing the user along is the job
        // of the tool that knows whether that was asked for — `tab_open`
        // honours `background`, `tab_focus` always focuses — and doing it in
        // the setter overrode both.
        const owned = new Set(
          [...this.runs.values()].map((r) => r.tabId).filter((t): t is string => t !== null),
        );
        for (const t of this.deps.tabs.all) t.agentControlled = owned.has(t.id);
        this.deps.tabs.emitUpdate();
      },
      status: () => {},
      // Only a chat run has someone watching who can answer; an external client
      // has no sidebar, and a question there would hang until it timed out.
      ask:
        run.kind === 'chat' && this.deps.questions
          ? (question, options) =>
              this.deps.questions!.ask(run.id, question, options, run.controller.signal)
          : undefined,
      signal: run.controller.signal,
      userDataPath: this.deps.userDataPath,
    };
  }

  async send(sessionId: string, text: string, opts: { attachPage?: boolean } = {}): Promise<void> {
    if (this.runs.has(sessionId)) {
      this.deps.emit({ type: 'error', sessionId, message: 'This chat is already working on something.' });
      return;
    }

    const run = this.startRun(sessionId, 'chat');
    const messageId = randomUUID();

    try {
      await this.runTurn(sessionId, messageId, text, opts, run);
    } catch (err) {
      if (run.controller.signal.aborted) {
        this.deps.emit({ type: 'aborted', sessionId });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[agent] turn failed:', err);
        this.deps.emit({ type: 'error', sessionId, message });
      }
    } finally {
      this.runs.delete(sessionId);
      this.clearAgentBadges();
    }
  }

  /** Clears badges for tabs no surviving run still owns. */
  private clearAgentBadges() {
    const owned = new Set(
      [...this.runs.values()].map((r) => r.tabId).filter((t): t is string => t !== null),
    );
    for (const tab of this.deps.tabs.all) tab.agentControlled = owned.has(tab.id);
    this.deps.tabs.emitUpdate();
  }

  private async runTurn(
    sessionId: string,
    messageId: string,
    text: string,
    opts: { attachPage?: boolean },
    run: Run,
  ): Promise<void> {
    const signal = run.controller.signal;
    const { settings, sessions, tabs, emit } = this.deps;
    const config = settings.get();
    const provider = this.deps.providers.get(config.provider);
    if (!provider) throw new Error(`Unknown provider "${config.provider}".`);

    const tools = this.deps.getTools();
    const toolsByName = new Map(tools.map((t) => [t.name, t]));

    // Persist the user's message before any model call, so an API failure never
    // loses what they typed.
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      blocks: [{ type: 'text', text }],
      createdAt: Date.now(),
    };
    // Best-effort: see the method, and `journal` below. An unwritable
    // history must not stop the turn before it starts.
    const session = sessions.appendBestEffort(sessionId, userMessage);

    const working: ModelMessage[] = rebuildHistory(session.messages.slice(0, -1));
    const context = turnContext({
      tabs: tabs.states,
      activeTabId: tabs.activeTabId,
      toolNames: tools.map((t) => t.name),
      autopilot: config.autoApprove.write,
    });

    const userBlocks: ModelBlock[] = [
      { type: 'text', text: `${text}\n\n<browser_context>\n${context}\n</browser_context>` },
    ];

    // "Attach page" pulls the current page's outline in up front, so simple
    // questions about what the user is looking at need no tool round-trip.
    if (opts.attachPage) {
      const attached = await this.attachCurrentPage().catch((err: Error) => `(could not read the page: ${err.message})`);
      userBlocks.push({ type: 'text', text: `<attached_page>\n${attached}\n</attached_page>` });
    }

    working.push({ role: 'user', content: userBlocks });

    run.tabId = tabs.activeTabId;
    emit({ type: 'turn_start', sessionId, messageId });

    const assistantBlocks: ContentBlock[] = [];
    const maxSteps = Math.max(1, config.maxAgentSteps);
    let stopReason = 'end_turn';

    /**
     * Writes the turn record so far, so a later failure cannot erase it.
     *
     * Never throws. `SessionStore.save` already retries the contended rename
     * that made this fail in practice, but the guarantee worth stating here is
     * the one about priority: the answer the user is watching arrive matters
     * more than the record of it. Letting a history write abort the turn
     * inverted the point of journalling - the writes meant to preserve the
     * turn were the thing destroying it.
     *
     * A dropped write is made good by the next successful one, because the
     * store keeps the unwritten session and prefers it on reload. Only a
     * turn's final write can actually go missing.
     */
    const journal = (reason?: string) => {
      if (!assistantBlocks.length && !reason) return;
      try {
        sessions.upsert(sessionId, {
          id: messageId,
          role: 'assistant',
          blocks: assistantBlocks,
          createdAt: Date.now(),
          stopReason: reason ?? 'interrupted',
        });
      } catch (err) {
        console.error('[agent] could not write the turn to history:', err);
      }
    };

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) throw new Error('aborted');
      emit({ type: 'step', messageId, step: step + 1, maxSteps });

      const pendingCalls: { id: string; name: string; input: unknown }[] = [];
      let stepText = '';
      let stepThinking = '';

      const model = config.models[config.provider];
      // A small-context backend gets a correspondingly smaller slice of
      // soul.md: on a CPU model the file would otherwise eat the budget the
      // page itself needs.
      const leanBackend = isLeanBackend(provider.contextTokens);
      const { system, tools: usableTools } = shapeRequest({
        contextTokens: provider.contextTokens,
        tools: this.toolSpecs(),
        vision: config.vision && provider.supportsVision(model),
        soul: this.shareSoulWith(config) ? this.soul.read({ lean: leanBackend }) : null,
      });
      const budget = fitToContext(
        pruneHistory(working),
        system,
        usableTools,
        provider.contextTokens,
      );

      const stream = provider.stream({
        model,
        system,
        messages: budget.messages,
        tools: usableTools,
        maxTokens: budget.maxOutputTokens,
        thinking: config.extendedThinking,
        signal,
        conversationKey: sessionId,
      });

      for await (const event of stream) {
        switch (event.type) {
          case 'text':
            stepText += event.delta;
            emit({ type: 'text_delta', messageId, delta: event.delta });
            break;
          case 'thinking':
            stepThinking += event.delta;
            emit({ type: 'thinking_delta', messageId, delta: event.delta });
            break;
          case 'tool_use':
            pendingCalls.push({ id: event.id, name: event.name, input: event.input });
            break;
          case 'usage':
            emit({ type: 'usage', messageId, usage: event.usage });
            break;
          case 'stop':
            stopReason = event.reason;
            break;
        }
      }

      if (stepThinking) assistantBlocks.push({ type: 'thinking', text: stepThinking });
      if (stepText) assistantBlocks.push({ type: 'text', text: stepText });

      const assistantContent: ModelBlock[] = [];
      if (stepText) assistantContent.push({ type: 'text', text: stepText });
      for (const call of pendingCalls) {
        assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      if (assistantContent.length) working.push({ role: 'assistant', content: assistantContent });

      if (!pendingCalls.length) break;

      // Every tool_use must get a matching tool_result in one user message —
      // splitting or dropping them teaches the model to stop calling tools.
      const resultBlocks: ModelBlock[] = [];
      for (const call of pendingCalls) {
        if (signal.aborted) throw new Error('aborted');
        // Only what was advertised this turn can be dispatched. The lean tool
        // set narrowed what the model was *shown*, while the registry it was
        // looked up in stayed complete — so a model that named an unadvertised
        // tool, from habit or from a page's suggestion, would still have run it.
        const offered = usableTools.some((t) => t.name === call.name)
          ? toolsByName.get(call.name)
          : undefined;
        const outcome = await this.runTool(messageId, call, offered, assistantBlocks, run);
        resultBlocks.push(outcome);
        // After *each* action, not after the batch. A two-call batch where the
        // first committed and the second was interrupted left no record of the
        // first at all — the state that most invites a duplicate retry.
        journal();
      }
      working.push({ role: 'user', content: resultBlocks });
      journal();

      if (step === maxSteps - 1) {
        const note = `Stopped after ${maxSteps} steps without finishing. Ask me to continue if you want me to keep going.`;
        assistantBlocks.push({ type: 'text', text: `\n\n_${note}_` });
        emit({ type: 'text_delta', messageId, delta: `\n\n_${note}_` });
        stopReason = 'max_steps';
      }
    }

    journal(stopReason);
    emit({ type: 'turn_end', sessionId, messageId, stopReason });
  }

  private async attachCurrentPage(): Promise<string> {
    const tab = this.deps.tabs.active;
    if (!tab) return '(no page is open)';
    const snap = await this.deps.tabs.callBridge<{ url: string; title: string; text: string }>(
      tab,
      'window.__nabsunAgent.snapshot({})',
    );
    return `URL: ${snap.url}\nTitle: ${snap.title}\n\n${snap.text}`;
  }

  /** Runs one tool call end-to-end, emitting UI events and returning its result block. */
  private async runTool(
    messageId: string,
    call: { id: string; name: string; input: unknown },
    tool: Tool | undefined,
    assistantBlocks: ContentBlock[],
    run: Run,
  ): Promise<ModelBlock> {
    const signal = run.controller.signal;
    const { emit } = this.deps;
    const input = (call.input ?? {}) as Record<string, unknown>;
    const started = Date.now();

    const block: ToolCallBlock = {
      type: 'tool_call',
      id: call.id,
      name: call.name,
      input,
      status: 'running',
    };
    assistantBlocks.push(block);
    emit({ type: 'tool_start', messageId, toolCallId: call.id, name: call.name, input });

    const finish = (
      status: ToolCallBlock['status'],
      content: string,
      images?: { mediaType: string; data: string }[],
    ): ModelBlock => {
      const durationMs = Date.now() - started;
      block.status = status;
      block.result = content.slice(0, 4_000);
      block.durationMs = durationMs;
      emit({ type: 'tool_end', messageId, toolCallId: call.id, status, result: block.result, durationMs });
      return {
        type: 'tool_result',
        toolUseId: call.id,
        content,
        isError: status === 'error' || status === 'denied',
        ...(images?.length ? { images } : {}),
      };
    };

    if (!tool) {
      return finish('error', `Unknown tool "${call.name}". It may belong to a plugin or MCP server that is not loaded.`);
    }

    // The target is captured *before* the prompt, so the action the user is
    // shown is the action that runs.
    const binding = this.bindTarget(run, input);

    const approved = await this.deps.approvals.request(tool, input, signal);
    if (!approved) {
      return finish(
        'denied',
        'The user declined this action. Do not attempt the same thing another way — explain what you wanted to do and stop.',
      );
    }

    try {
      const raw = await this.dispatch(tool, input, run, binding);
      const result: ToolResult = typeof raw === 'string' ? { content: raw } : raw;
      return finish('ok', result.content, result.images);
    } catch (err) {
      if (signal.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      // Tool failures are reported back to the model, which can usually
      // recover (re-snapshot, try a different element) without human help.
      return finish('error', message);
    }
  }
}

/** Rebuilds provider messages from a stored transcript, preserving step order. */
function rebuildHistory(messages: ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = msg.blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text) out.push({ role: 'user', content: [{ type: 'text', text }] });
      continue;
    }
    if (msg.role !== 'assistant') continue;

    // One stored assistant message can span several model turns. Flush a turn
    // whenever prose follows tool calls, which is where the boundary was.
    let assistant: ModelBlock[] = [];
    let results: ModelBlock[] = [];

    const flush = () => {
      if (assistant.length) out.push({ role: 'assistant', content: assistant });
      if (results.length) out.push({ role: 'user', content: results });
      assistant = [];
      results = [];
    };

    for (const block of msg.blocks) {
      if (block.type === 'text') {
        if (results.length) flush();
        if (block.text) assistant.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_call') {
        assistant.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        results.push({
          type: 'tool_result',
          toolUseId: block.id,
          content: block.result ?? '(no output)',
          isError: block.status === 'error' || block.status === 'denied',
        });
      }
      // Thinking blocks are not replayed: their signatures are not persisted,
      // and providers reject or ignore unsigned ones.
    }
    flush();
  }

  return out;
}

/**
 * An upper bound on tokens, not an average.
 *
 * `length / 3.4` is the familiar rule of thumb for English and it is not a
 * bound: 10,000 characters of dense Unicode measured 16,000 tokens on the
 * bundled tokenizer — more tokens than characters — so a request that "fit"
 * was rejected by the server. The rule holds for ASCII and fails exactly where
 * a browser meets it, on a non-English page.
 *
 * So the two are counted separately. ASCII keeps the 3.4 ratio. Every
 * non-ASCII code point is charged a whole token, and astral characters — emoji,
 * which tokenize into several pieces — are charged per UTF-16 unit, which is
 * how the surrogate pairs are already counted here.
 *
 * The cost of being wrong is asymmetric: overestimating wastes some context,
 * underestimating produces a failed turn.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 3.4) + wide;
}

function messageTokens(msg: ModelMessage): number {
  let total = 8; // role and framing overhead
  for (const block of msg.content) {
    if (block.type === 'text') total += estimateTokens(block.text);
    else if (block.type === 'tool_result') total += estimateTokens(block.content) + 8;
    else if (block.type === 'tool_use') total += estimateTokens(JSON.stringify(block.input)) + 12;
    else total += 8;
  }
  return total;
}

/** How much room the request has, and what fits in it. */
interface ContextFit {
  messages: ModelMessage[];
  maxOutputTokens: number;
}

/**
 * Fits a request into the backend's context window.
 *
 * Message *count* was the only bound, which says nothing about size: with the
 * bundled 8k model, the full tool catalogue plus one ordinary page snapshot was
 * rejected outright — 8,920 tokens into 8,192 — so the default backend failed
 * on the default action. Counting messages cannot catch that; counting tokens
 * can.
 *
 * Backends that do not declare a window keep the previous generous behaviour,
 * because for them this arithmetic is a no-op with a real cost if the estimate
 * is wrong.
 */
export function fitToContext(
  messages: ModelMessage[],
  system: string,
  tools: ToolSpec[],
  contextTokens?: number,
): ContextFit {
  if (!contextTokens) return { messages, maxOutputTokens: 16_000 };

  // Enough to answer and to emit a tool call, but a small window cannot afford
  // to reserve much; a quarter of it, capped, leaves room to see the page.
  const maxOutputTokens = Math.max(512, Math.min(2_048, Math.floor(contextTokens / 4)));
  const fixed =
    estimateTokens(system) + estimateTokens(JSON.stringify(tools.map((t) => t.inputSchema))) +
    tools.reduce((n, t) => n + estimateTokens(`${t.name}${t.description}`), 0);

  const room = contextTokens - fixed - maxOutputTokens;
  if (room <= 0) {
    // Nothing sensible to trim: the fixed cost alone does not fit.
    throw new Error(
      `The selected model's context (${contextTokens} tokens) is too small for the browser's ` +
        'tool set. Raise "Context size" in Settings → Models, or choose a larger model.',
    );
  }

  // Drop from the front in *exchanges*, not in pairs of array entries.
  //
  // Splicing two entries at a time assumed the transcript alternates neatly.
  // It does not: one assistant turn can be followed by a user message carrying
  // several tool results, so the count-based cut left a `tool_result` as the
  // first message with no `tool_use` to match — a request the provider is
  // entitled to reject outright.
  let kept = [...messages];
  let used = totalTokens(kept);
  while (used > room && kept.length > 2) {
    const next = dropOldestExchange(kept);
    if (next.length === kept.length) break;
    kept = next;
    used = totalTokens(kept);
  }

  // Still over: something in what remains is itself too big. Trim from the
  // newest backwards, because the live observation is the part worth keeping
  // most of — but every message is a candidate. Trimming only the last one let
  // a 93,000-character penultimate message straight through.
  // Repeat until it fits or nothing more can be cut. A single pass left a
  // request marginally over the limit and then threw, because each trim adds
  // its own explanatory note back and the first estimate does not account for
  // that. The guard bounds it: `trimMessage` returns null once a message has
  // nothing left worth cutting, so this terminates on its own.
  for (let pass = 0; used > room && pass < 20; pass++) {
    let progressed = false;
    for (let i = kept.length - 1; i >= 0 && used > room; i--) {
      const trimmed = trimMessage(kept[i], used - room);
      if (!trimmed) continue;
      kept[i] = trimmed;
      used = totalTokens(kept);
      progressed = true;
    }
    if (!progressed) break;
  }

  // Recomputed, not assumed. The previous version subtracted a fixed
  // `overflow` figure calculated once and never checked the result, so a batch
  // of small blocks — each below its 500-character threshold — sailed through
  // with ~54,000 characters intact.
  if (used > room) {
    throw new Error(
      `This request does not fit the model's ${contextTokens}-token context even after ` +
        'trimming. Ask about a smaller part of the page, or switch to a larger model in ' +
        'Settings → Models.',
    );
  }

  return { messages: kept, maxOutputTokens };
}

const totalTokens = (messages: ModelMessage[]): number =>
  messages.reduce((n, m) => n + messageTokens(m), 0);

/**
 * Removes the oldest complete exchange, keeping tool-call groups together.
 *
 * An exchange is a user turn plus everything that answers it, up to the next
 * user turn that is not merely carrying tool results. The last two messages are
 * the live step and are never dropped.
 */
function dropOldestExchange(messages: ModelMessage[]): ModelMessage[] {
  const limit = messages.length - 2;
  if (limit <= 0) return messages;

  const isToolResultOnly = (m: ModelMessage) =>
    m.role === 'user' && m.content.length > 0 && m.content.every((b) => b.type === 'tool_result');

  let end = 1;
  // Consume the assistant reply and any tool-result turns that belong with it,
  // so a `tool_use` and its `tool_result` are always dropped together.
  while (end < limit && (messages[end].role === 'assistant' || isToolResultOnly(messages[end]))) {
    end++;
  }
  return messages.slice(Math.min(end, limit));
}

/**
 * Shortens the largest text in a message by roughly `overflowTokens`.
 *
 * Returns null when there is nothing worth trimming, so the caller can move on
 * to an older message rather than looping on this one.
 */
function trimMessage(message: ModelMessage, overflowTokens: number): ModelMessage | null {
  const note =
    "\n…[trimmed to fit this model's context; ask for a specific part of the page, or switch to a larger model]";
  // No 500-character floor: many small blocks add up to the same problem as one
  // large one, and skipping them is how 54,000 characters survived.
  let budget = Math.ceil(overflowTokens * 3.4);
  // The note is added once per *message*, and never twice.
  //
  // Appending it per block made trimming self-defeating — 180 small blocks
  // meant 180 notes. Re-appending it on each pass was worse: the note is longer
  // than a pass typically removes, so the message *grew*, and trimming
  // converged to a plateau just above the limit instead of under it.
  let noted = message.content.some((b) => {
    const text = b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : '';
    return text.endsWith(note);
  });
  let changed = false;

  const content = message.content.map((block) => {
    if (budget <= 0) return block;
    const raw = block.type === 'text' ? block.text : block.type === 'tool_result' ? block.content : null;
    if (raw === null) return block;

    // Trim the content, not the explanation appended to it last time.
    const hadNote = raw.endsWith(note);
    const text = hadNote ? raw.slice(0, -note.length) : raw;
    if (text.length <= 1) return block;

    const remove = Math.min(budget, text.length - 1);
    const kept = text.slice(0, Math.max(1, text.length - remove));
    const cut = hadNote || !noted ? `${kept}${note}` : kept;
    noted = true;
    budget -= remove;
    changed = true;
    if (block.type === 'text') return { ...block, text: cut };
    return { ...block, content: cut };
  });

  return changed ? { ...message, content } : null;
}

/**
 * Keeps the conversation inside a sane budget: trims the oldest exchanges and
 * shortens replayed tool output, which is where nearly all the bulk lives.
 */
function pruneHistory(messages: ModelMessage[]): ModelMessage[] {
  const trimmed = messages.length > MAX_HISTORY_MESSAGES
    ? messages.slice(messages.length - MAX_HISTORY_MESSAGES)
    : messages;

  // The last two entries are the live step; never shorten those.
  const cutoff = trimmed.length - 2;
  return trimmed.map((msg, i) => {
    if (i >= cutoff) return msg;
    return {
      ...msg,
      content: msg.content.map((block) => {
        if (block.type !== 'tool_result') return block;
        if (block.content.length <= REPLAY_TOOL_RESULT_CHARS) return block;
        return {
          ...block,
          content: `${block.content.slice(0, REPLAY_TOOL_RESULT_CHARS)}\n…[earlier output truncated]`,
          images: undefined,
        };
      }),
    };
  });
}

export { MissingCredentialsError };
