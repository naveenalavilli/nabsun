/**
 * Drives the real agent loop against a real Chromium tab, with a scripted stub
 * standing in for the model. This covers everything between "the model emitted
 * a tool call" and "the page changed" — tool dispatch, the approval gate, the
 * snapshot→act cycle, tool_result plumbing and the event stream — without
 * needing an API key or a network round trip.
 *
 * Run: node_modules/electron/dist/electron.exe dist/test/agent-harness.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseWindow, app } from 'electron';
import type { AgentEvent, AgentQuestion, ProviderId, ToolSpec } from '../shared/types';
import type { ModelMessage } from '../main/ai/provider';
import { Agent, estimateTokens, fitToContext } from '../main/ai/agent';
import { ApprovalManager } from '../main/ai/approvals';
import { QuestionManager } from '../main/ai/questions';
import type { Provider, StreamEvent, StreamRequest } from '../main/ai/provider';
import { SessionStore } from '../main/ai/sessions';
import { browserTools } from '../main/ai/tools/browser';
import { assertLive, type Tool } from '../main/ai/tools/types';
import { assertFetchAllowed, tabTools, webTools } from '../main/ai/tools/workspace';
import { redactArgs, sanitizeSettings, withoutSecrets } from '../main/ipc';
import { HistoryStore } from '../main/history';
import { SecretStore, SettingsStore } from '../main/store';
import { TabManager } from '../main/tabs';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

/**
 * Runs one real tool call, then fails the way a provider outage does.
 *
 * The tool has genuinely happened by the time the failure arrives, which is the
 * case where losing the record is worst.
 */
class FailAfterToolProvider implements Provider {
  readonly id = 'anthropic' as ProviderId;
  readonly label = 'Fails after a tool call';
  toolRan = false;
  private turn = 0;

  async listModels() {
    return ['stub'];
  }
  supportsVision() {
    return false;
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    if (this.turn++ === 0) {
      yield { type: 'tool_use', id: 'call_x', name: 'tab_open', input: { url: 'about:blank' } };
      yield { type: 'stop', reason: 'tool_use' };
      this.toolRan = true;
      return;
    }
    throw new Error('the provider went away mid-turn');
  }
}

/** Calls one named tool, then stops. */
class SingleToolProvider implements Provider {
  readonly id = 'anthropic' as ProviderId;
  readonly label = 'One tool call';
  private done = false;

  constructor(
    private readonly tool: string,
    private readonly input: Record<string, unknown> = {},
  ) {}

  async listModels() {
    return ['stub'];
  }
  supportsVision() {
    return false;
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    if (this.done) {
      yield { type: 'stop', reason: 'end_turn' };
      return;
    }
    this.done = true;
    yield { type: 'tool_use', id: 'only', name: this.tool, input: this.input };
    yield { type: 'stop', reason: 'tool_use' };
  }
}

/** Emits two writes in one batch: the first commits, the second is interrupted. */
class TwoWriteProvider implements Provider {
  readonly id = 'anthropic' as ProviderId;
  readonly label = 'Two writes in one batch';

  async listModels() {
    return ['stub'];
  }
  supportsVision() {
    return false;
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    yield { type: 'tool_use', id: 'batch_1', name: 'test_first_write', input: {} };
    yield { type: 'tool_use', id: 'batch_2', name: 'test_write', input: { mark: 'batch-second' } };
    yield { type: 'stop', reason: 'tool_use' };
  }
}

/** Polls until a condition holds, so a test never waits on a fixed sleep. */
async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

type Lookup = (host: string) => Promise<string[]>;

/** The destination policy said no. */
async function refuses(url: string, lookup?: Lookup): Promise<boolean> {
  try {
    await assertFetchAllowed(url, lookup ?? (async () => []));
    return false;
  } catch {
    return true;
  }
}

async function allows(url: string, lookup?: Lookup): Promise<boolean> {
  try {
    await assertFetchAllowed(url, lookup ?? (async () => []));
    return true;
  } catch {
    return false;
  }
}

/** A model that replays a fixed script of turns. */
class StubProvider implements Provider {
  readonly id = 'anthropic' as ProviderId;
  readonly label = 'Stub';
  turn = 0;
  /** Captured so we can assert on what the loop actually sent back. */
  lastRequest: StreamRequest | null = null;

  async listModels() {
    return ['stub'];
  }
  supportsVision() {
    return false;
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    this.lastRequest = req;
    const turn = this.turn++;

    if (turn === 0) {
      yield { type: 'text', delta: 'Let me look at the page.' };
      yield { type: 'tool_use', id: 'call_1', name: 'browser_snapshot', input: {} };
      yield { type: 'stop', reason: 'tool_use' };
      return;
    }

    if (turn === 1) {
      // Find the refs the snapshot just produced, the way the model would.
      const results = lastToolResults(req);
      const emailRef = refFor(results, 'Email address');
      const submitRef = refFor(results, 'Create account');
      yield {
        type: 'tool_use',
        id: 'call_2',
        name: 'browser_type',
        input: { ref: emailRef, text: 'agent@example.com' },
      };
      yield { type: 'tool_use', id: 'call_3', name: 'browser_click', input: { ref: submitRef } };
      yield { type: 'stop', reason: 'tool_use' };
      return;
    }

    if (turn === 2) {
      yield { type: 'tool_use', id: 'call_4', name: 'browser_evaluate', input: { expression: '1+1' } };
      yield { type: 'stop', reason: 'tool_use' };
      return;
    }

    yield { type: 'text', delta: 'Done.' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'stop', reason: 'end_turn' };
  }
}

function lastToolResults(req: StreamRequest): string {
  const last = req.messages[req.messages.length - 1];
  return last.content
    .filter((b) => b.type === 'tool_result')
    .map((b) => (b as { content: string }).content)
    .join('\n');
}

/** Reads a handle out of the outline exactly as the model would: verbatim. */
function refFor(text: string, name: string): string {
  const match = new RegExp(`"${name}"[^\\n]*\\[ref=([^\\]]+)\\]`).exec(text);
  if (!match) throw new Error(`no ref found for ${name} in:\n${text.slice(0, 800)}`);
  return match[1];
}

app.whenReady().then(async () => {
  // Keep the harness out of the real profile.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-harness-'));
  app.setPath('userData', tmp);

  const settings = new SettingsStore();
  settings.set({
    // Pinned, not inherited from the product default: this harness supplies a
    // scripted stub under the 'anthropic' id, and it should keep working
    // whichever backend the app happens to ship as its default.
    provider: 'anthropic',
    // Autopilot on: we are asserting the loop, not the dialog.
    autoApprove: { safe: true, write: true, dangerous: false },
    maxAgentSteps: 10,
  });

  const history = new HistoryStore();
  const sessions = new SessionStore(tmp);
  const approvals = new ApprovalManager(settings);

  const window = new BaseWindow({ show: false, width: 1200, height: 800 });
  const tabs = new TabManager({
    window,
    preloadPath: path.join(__dirname, '..', 'preload', 'page.js'),
    partition: 'harness',
    history,
    homepage: 'about:blank',
    onFindResult: () => {},
  });
  tabs.setBounds({ x: 0, y: 0, width: 1200, height: 800 });

  const events: AgentEvent[] = [];
  const approvalPrompts: string[] = [];
  approvals.setEmitter((req) => {
    approvalPrompts.push(req.toolName);
    // Deny, so we also prove a denial stops the action rather than proceeding.
    approvals.resolve(req.id, 'deny');
  });

  // A write whose only effect is a flag here, so "did it run?" cannot be
  // confused by which tab an action landed in. A side effect observed in the
  // wrong place is how a cancellation check passed while the write still ran.
  const sideEffects: string[] = [];
  /** Tools registered here but defined further down, next to their probe. */
  const extraTools: Tool[] = [];
  const probeTool: Tool = {
    name: 'test_write',
    description: 'Records that a write executed.',
    inputSchema: { type: 'object', properties: { mark: { type: 'string' } }, required: ['mark'] },
    // `dangerous`, because this harness runs with the write tier auto-approved
    // and the point of the test is to sit at the prompt while Stop is pressed.
    risk: 'dangerous',
    source: 'tabs',
    handler: async (input) => {
      sideEffects.push(String(input.mark));
      return `recorded ${String(input.mark)}`;
    },
  };

  /** Reports the calling run's own tab target, to prove runs stay separate. */
  const targetTool: Tool = {
    name: 'test_target',
    description: 'Returns the tab this run is working in.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'safe',
    source: 'tabs',
    handler: async (_input, ctx) => ctx.getAgentTabId() ?? 'none',
  };

  const provider = new StubProvider();
  const agent = new Agent({
    providers: new Map<string, Provider>([['anthropic', provider]]),
    settings,
    sessions,
    tabs,
    history,
    approvals,
    userDataPath: tmp,
    getTools: () => [...browserTools(), ...tabTools(), probeTool, targetTool, ...extraTools],
    emit: (e) => events.push(e),
  });

  try {
    const fixture = path.join(__dirname, '..', '..', 'scripts', 'fixtures', 'form.html');
    const tab = tabs.create(`file:///${fixture.replace(/\\/g, '/')}`);
    await tabs.waitForSettled(tab, 15_000);

    const session = sessions.create();
    await agent.send(session.id, 'Fill in the form and submit it.');

    const toolEnds = events.filter((e) => e.type === 'tool_end') as Extract<
      AgentEvent,
      { type: 'tool_end' }
    >[];

    check('the loop ran every scripted tool call', toolEnds.length === 4, `got ${toolEnds.length}`);

    const byName = (n: string) =>
      toolEnds.find(
        (e) =>
          (events.find(
            (s) => s.type === 'tool_start' && s.toolCallId === e.toolCallId,
          ) as Extract<AgentEvent, { type: 'tool_start' }> | undefined)?.name === n,
      );

    check('browser_snapshot succeeded', byName('browser_snapshot')?.status === 'ok');
    check('browser_type succeeded', byName('browser_type')?.status === 'ok', byName('browser_type')?.result);
    check('browser_click succeeded', byName('browser_click')?.status === 'ok', byName('browser_click')?.result);

    // The page's own script only updates #result on a genuine event sequence.
    const committed = await tabs.callBridge<string>(
      tab,
      'document.getElementById("result").textContent',
    );
    check(
      'the agent actually changed the page',
      committed === 'submitted:agent@example.com|agree=false|plan=free',
      `#result = ${JSON.stringify(committed)}`,
    );

    check(
      'a dangerous tool was gated for approval',
      approvalPrompts.includes('browser_evaluate'),
      JSON.stringify(approvalPrompts),
    );
    check('the denied tool reports denied', byName('browser_evaluate')?.status === 'denied');
    check(
      'a denial is fed back to the model as an error result',
      /declined/i.test(byName('browser_evaluate')?.result ?? ''),
    );

    check('the turn ended cleanly', events.some((e) => e.type === 'turn_end'));

    // The transcript must round-trip into provider messages with every
    // tool_use matched by a tool_result, or tool calling degrades over time.
    const reloaded = sessions.load(session.id);
    const assistant = reloaded?.messages.find((m) => m.role === 'assistant');
    const toolBlocks = assistant?.blocks.filter((b) => b.type === 'tool_call') ?? [];
    check('the transcript persisted all tool calls', toolBlocks.length === 4, `got ${toolBlocks.length}`);

    const req = provider.lastRequest!;
    const toolUses = req.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_use')).length;
    const toolResults = req.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result')).length;
    check(
      'every tool_use has a matching tool_result',
      toolUses === toolResults && toolUses > 0,
      `${toolUses} uses vs ${toolResults} results`,
    );

    check(
      'volatile page context rides on the user turn, not the system prompt',
      !req.system.includes('form.html') &&
        JSON.stringify(req.messages).includes('<browser_context>'),
    );

    // --- Stop must reach an external agent's pending call -------------------
    // An external request sits at the approval prompt for as long as the user
    // takes to answer. Its controller was never registered, so Stop could not
    // reach it and the action ran when the user finally approved.
    let pendingApprovalId: string | null = null;
    approvals.setEmitter((r) => {
      pendingApprovalId = r.id;
    });

    let externalError: string | null = null;
    const external = agent
      .runToolForExternalAgent('test_write', { mark: 'external-after-stop' })
      .catch((err: unknown) => {
        externalError = err instanceof Error ? err.message : String(err);
        return null;
      });

    await waitFor(() => pendingApprovalId !== null, 5_000);
    check('an external tool call is gated for approval', pendingApprovalId !== null);

    // The Stop the user actually presses: the UI aborts a chat session id.
    // Testing abortAll() here hid the bug, because abortAll only runs on quit —
    // the visible Stop reached the chat and left the external write pending.
    agent.abort(session.id);
    // Approve *after* the stop: the late answer must not resurrect the action.
    if (pendingApprovalId) approvals.resolve(pendingApprovalId, 'allow');
    await external;

    check(
      'the Stop button cancels an external call approved afterwards',
      !sideEffects.includes('external-after-stop'),
      `side effects: ${JSON.stringify(sideEffects)} · call reported: ${externalError ?? '(resolved)'}`,
    );
    check(
      'the cancelled external call reports why it did not run',
      /stopped|declined/i.test(externalError ?? ''),
      externalError ?? '(no error)',
    );

    // --- two runs must not retarget one another -----------------------------
    // A single shared agent tab meant the second caller to pick a tab moved the
    // first caller's target with it.
    const tabA = tabs.create('about:blank');
    const tabB = tabs.create('about:blank');
    await tabs.waitForSettled(tabA, 5_000);
    await tabs.waitForSettled(tabB, 5_000);

    approvals.setEmitter((r) => approvals.resolve(r.id, 'allow'));

    // Each connected client keeps its own tab across calls — an agent that
    // selects a background tab and then acts must still be in that tab — while
    // remaining invisible to any other client.
    await agent.runToolForExternalAgent('tab_focus', { tabId: tabA.id }, 'client-a');
    await agent.runToolForExternalAgent('tab_focus', { tabId: tabB.id }, 'client-b');

    const aSees = await agent.runToolForExternalAgent('test_target', {}, 'client-a');
    const bSees = await agent.runToolForExternalAgent('test_target', {}, 'client-b');
    check(
      'a client keeps its own tab between calls',
      aSees === tabA.id,
      `client-a saw ${aSees}, expected ${tabA.id}`,
    );
    check(
      'and another client does not move it',
      bSees === tabB.id && aSees !== bSees,
      `client-a=${aSees} client-b=${bSees}`,
    );
    const freshSees = await agent.runToolForExternalAgent('test_target', {}, 'client-c');
    check(
      'a client that has chosen nothing inherits no one else\'s tab',
      freshSees === 'none',
      `client-c saw ${freshSees}`,
    );

    // --- the assistant works where the user is looking -----------------------
    // A remembered tab meant "this page" could be a page the user had navigated
    // away from, so the assistant answered about something invisible to them.
    const userTab = tabs.create('about:blank');
    await tabs.waitForSettled(userTab, 5_000);
    tabs.activate(userTab.id);

    const chatSees = await new Promise<string | null>((resolve) => {
      const probe: Tool = {
        name: 'test_chat_target',
        description: 'Reports the chat run\'s target tab.',
        inputSchema: { type: 'object', properties: {} },
        risk: 'safe',
        source: 'tabs',
        handler: async (_input, ctx) => {
          resolve(ctx.getAgentTabId());
          return 'ok';
        },
      };
      extraTools.push(probe);
      void new Agent({
        providers: new Map<string, Provider>([['anthropic', new SingleToolProvider('test_chat_target')]]),
        settings,
        sessions,
        tabs,
        history,
        approvals,
        userDataPath: tmp,
        getTools: () => [...browserTools(), ...tabTools(), ...extraTools],
        emit: () => {},
      }).send(sessions.create().id, 'What is on this page?');
    });
    check(
      'the assistant works in the tab the user is looking at',
      chatSees === userTab.id,
      `assistant targeted ${chatSees}, user is on ${userTab.id}`,
    );

    // --- an opened tab is brought to the front ------------------------------
    // The user is meant to follow along and take over on the page, which they
    // cannot do while the work happens in a tab they cannot see.
    const openResult = await agent.runToolForExternalAgent(
      'tab_open',
      { url: 'about:blank#opened' },
      'client-open',
    );
    const openedId = /\[([^\]]+)\]/.exec(openResult)?.[1];
    check(
      'a tab the assistant opens becomes the visible tab',
      Boolean(openedId) && tabs.activeTabId === openedId,
      `opened ${openedId}, active is ${tabs.activeTabId}`,
    );
    check('and it says so, rather than leaving the user to notice', /switched to it/.test(openResult), openResult);

    const bgResult = await agent.runToolForExternalAgent(
      'tab_open',
      { url: 'about:blank#quiet', background: true },
      'client-open',
    );
    check(
      'background:true still opens out of the way when asked for',
      tabs.activeTabId === openedId,
      `active is ${tabs.activeTabId} after ${bgResult}`,
    );

    // --- background really means background, for a chat run too ---------------
    // The chat path activated whatever tab was assigned as the target, which
    // overrode `background: true` and moved the user anyway — while the tool's
    // own result claimed the tab was in the background.
    const watching = tabs.create('about:blank#watching');
    await tabs.waitForSettled(watching, 5_000);
    tabs.activate(watching.id);

    const bgAgent = new Agent({
      providers: new Map<string, Provider>([
        [
          'anthropic',
          new SingleToolProvider('tab_open', { url: 'about:blank#quiet', background: true }),
        ],
      ]),
      settings,
      sessions,
      tabs,
      history,
      approvals,
      userDataPath: tmp,
      getTools: () => [...browserTools(), ...tabTools(), ...webTools()],
      emit: () => {},
    });
    await bgAgent.send(sessions.create().id, 'Look something up quietly.');
    check(
      'a background tab opened by the assistant does not steal the foreground',
      tabs.activeTabId === watching.id,
      `user was on ${watching.id}, active is ${tabs.activeTabId}`,
    );

    // ...and the assistant must still be able to work in it, which is the half
    // that breaks if "the current tab" is only ever the user's tab.
    const bgTarget = tabs.all.find((t) => t.wc.getURL().includes('#quiet'));
    check('and the assistant can still act in it', Boolean(bgTarget), String(bgTarget?.id));

    // --- a replaced external run is not deleted by its predecessor ------------
    // A late-finishing call from a stopped run deleted the entry its
    // replacement had installed under the same id, losing live work's target.
    const holdTool: Tool = {
      name: 'test_hold',
      description: 'Blocks until released.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'safe',
      source: 'tabs',
      handler: async () => {
        await new Promise((r) => setTimeout(r, 300));
        return 'released';
      },
    };
    extraTools.push(holdTool);

    const held = agent
      .runToolForExternalAgent('test_hold', {}, 'client-race')
      .catch((err: Error) => err.message);
    await new Promise((r) => setTimeout(r, 50));
    agent.abort('external:client-race');
    const replacement = tabs.create('about:blank#replacement');
    await tabs.waitForSettled(replacement, 5_000);
    await agent.runToolForExternalAgent('tab_focus', { tabId: replacement.id }, 'client-race');
    await held;
    const stillTargeted = await agent.runToolForExternalAgent('tab_list', {}, 'client-race');
    check(
      "a stopped run finishing does not discard its replacement's target",
      stillTargeted.includes(replacement.id),
      stillTargeted.slice(0, 200),
    );

    // --- the assistant can ask, and the user can answer ----------------------
    // Ending the turn to ask loses the thread of what was being done. A
    // question keeps the turn open and the answer returns as the tool result.
    const questions = new QuestionManager();
    const pending: AgentQuestion[] = [];
    questions.setEmitter((q) => pending.push(q));

    const askAgent = new Agent({
      providers: new Map<string, Provider>([['anthropic', new SingleToolProvider('ask_user', { question: 'Which flight?', options: ['9am', '5pm'] })]]),
      settings,
      sessions,
      tabs,
      history,
      approvals,
      questions,
      userDataPath: tmp,
      getTools: () => [...browserTools(), ...tabTools(), ...webTools()],
      emit: () => {},
    });

    const askSession = sessions.create();
    const asking = askAgent.send(askSession.id, 'Book the cheaper one.');

    await waitFor(() => pending.length > 0, 5_000);
    check('the assistant can put a question to the user', pending.length === 1, JSON.stringify(pending));
    questions.answer(pending[0].id, 'the 9am flight');
    await asking;

    const askTranscript = JSON.stringify(sessions.load(askSession.id));
    check(
      'the answer comes back to the model as the tool result',
      askTranscript.includes('the 9am flight'),
      askTranscript.slice(0, 300),
    );
    check(
      'and the turn stayed open rather than ending to ask',
      askTranscript.includes('tool_call'),
      askTranscript.slice(0, 300),
    );

    // Skipping must be an outcome the model is told about, not a hang.
    pending.length = 0;
    const skipAgent = new Agent({
      providers: new Map<string, Provider>([['anthropic', new SingleToolProvider('ask_user', { question: 'Which flight?', options: ['9am', '5pm'] })]]),
      settings,
      sessions,
      tabs,
      history,
      approvals,
      questions,
      userDataPath: tmp,
      getTools: () => [...browserTools(), ...tabTools(), ...webTools()],
      emit: () => {},
    });
    const skipSession = sessions.create();
    const skipping = skipAgent.send(skipSession.id, 'Pick one.');
    await waitFor(() => pending.length > 0, 5_000);
    questions.answer(pending[0].id, null);
    await skipping;
    check(
      'skipping a question tells the model to proceed rather than hanging',
      /did not answer/.test(JSON.stringify(sessions.load(skipSession.id))),
    );

    // Stop must release a question, or the turn waits for an answer forever.
    pending.length = 0;
    const stopAgent = new Agent({
      providers: new Map<string, Provider>([['anthropic', new SingleToolProvider('ask_user', { question: 'Which flight?', options: ['9am', '5pm'] })]]),
      settings,
      sessions,
      tabs,
      history,
      approvals,
      questions,
      userDataPath: tmp,
      getTools: () => [...browserTools(), ...tabTools(), ...webTools()],
      emit: () => {},
    });
    const stopSession = sessions.create();
    const stopping = stopAgent.send(stopSession.id, 'Pick one.');
    await waitFor(() => pending.length > 0, 5_000);
    stopAgent.abort(stopSession.id);
    const released = await Promise.race([
      stopping.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
    ]);
    check('Stop releases a pending question instead of leaving the turn stuck', released);

    // --- Stop must win a race it is inside of -------------------------------
    // Checking cancellation only before the handler is entered is not enough:
    // handlers await (highlighting, settling), and a Stop landing during that
    // await still produced the click afterwards.
    let releaseHandler: (() => void) | null = null;
    const slowTool: Tool = {
      name: 'test_slow_write',
      description: 'Waits, then records a write — like a handler that awaits before acting.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'safe', // auto-approved: the race under test is inside the handler.
      source: 'tabs',
      handler: async (_input, ctx) => {
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
        // Exactly what a real handler does immediately before mutating.
        assertLive(ctx, 'this write');
        sideEffects.push('slow-write');
        return 'wrote';
      },
    };
    extraTools.push(slowTool);

    let slowError: string | null = null;
    const slowSession = sessions.create();
    const slow = agent
      .runToolForExternalAgent('test_slow_write', {}, 'client-slow')
      .catch((err: unknown) => {
        slowError = err instanceof Error ? err.message : String(err);
        return null;
      });

    await waitFor(() => releaseHandler !== null, 5_000);
    agent.abort(slowSession.id); // the Stop button, while the handler is mid-await
    releaseHandler!();
    await slow;

    check(
      'a handler that was awaiting when Stop arrived does not then act',
      !sideEffects.includes('slow-write'),
      `side effects: ${JSON.stringify(sideEffects)} · reported: ${slowError ?? '(resolved)'}`,
    );

    // The same guarantee in the *real* handlers, which the synthetic tool above
    // cannot prove. A handler awaits before acting, so a Stop landing during
    // that await must be seen at the action. Driving each handler with an
    // already-stopped signal tests exactly that boundary, and covers every
    // mutating tool rather than the one that happened to be reported.
    const raceTab = tabs.create(`file:///${fixture.replace(/\\/g, '/')}`);
    await tabs.waitForSettled(raceTab, 15_000);
    const raceSnapshot = await agent.runToolForExternalAgent(
      'browser_snapshot',
      { tabId: raceTab.id },
      'client-race',
    );

    const stopped = new AbortController();
    stopped.abort();
    const stoppedCtx = {
      tabs,
      history,
      settings,
      getAgentTabId: () => raceTab.id,
      setAgentTabId: () => {},
      status: () => {},
      signal: stopped.signal,
      userDataPath: tmp,
    };

    const mutating: [string, Record<string, unknown>][] = [
      ['browser_click', { ref: refFor(raceSnapshot, 'Create account') }],
      ['browser_type', { ref: refFor(raceSnapshot, 'Email address'), text: 'x', submit: true }],
      ['browser_set_checked', { ref: refFor(raceSnapshot, 'I agree to the terms'), checked: true }],
      ['browser_navigate', { url: 'https://example.com/' }],
      ['browser_press_key', { key: 'Enter' }],
      ['browser_evaluate', { expression: 'document.title = "ran-after-stop"' }],
    ];

    for (const [name, args] of mutating) {
      const tool = browserTools().find((t) => t.name === name)!;
      let message = '(no error)';
      try {
        await tool.handler({ ...args, tabId: raceTab.id }, stoppedCtx);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      check(
        `${name} refuses to act once the run is stopped`,
        /Stopped before/.test(message),
        message,
      );
    }

    const raceResult = await tabs.callBridge<string>(
      raceTab,
      'document.getElementById("result").textContent',
    );
    const raceTitle = await tabs.callBridge<string>(raceTab, 'document.title');
    check(
      'and none of them changed the page',
      raceResult === '' && raceTitle !== 'ran-after-stop',
      `#result=${JSON.stringify(raceResult)} title=${JSON.stringify(raceTitle)}`,
    );

    // --- host-side fetch destination policy ---------------------------------
    for (const [label, url] of [
      ['loopback', 'http://127.0.0.1:8080/admin'],
      ['localhost by name', 'http://localhost:3000/'],
      ['link-local metadata', 'http://169.254.169.254/latest/meta-data/'],
      ['private LAN', 'http://192.168.1.1/'],
      ['IPv6 loopback', 'http://[::1]:9000/'],
      ['a non-web scheme', 'file:///etc/passwd'],
      // URL parsing rewrites this to its hexadecimal form, which the first
      // version of the policy did not recognise — it reached a local service.
      ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]:8080/'],
      ['IPv4-mapped IPv6 in hex form', 'http://[::ffff:7f00:1]:8080/'],
      ['IPv4-mapped private range', 'http://[::ffff:10.0.0.1]/'],
      ['IPv4-compatible loopback', 'http://[::127.0.0.1]/'],
    ] as const) {
      check(`fetch_url refuses ${label}`, await refuses(url), url);
    }
    check(
      'fetch_url fails closed when a name cannot be resolved',
      await refuses('https://nx.example/', async () => []),
    );
    check(
      'fetch_url still allows an ordinary public host',
      await allows('https://example.com/', async () => ['93.184.216.34']),
    );
    check(
      'fetch_url refuses a public name that resolves to a private address',
      await refuses('https://rebind.example/', async () => ['10.0.0.5']),
    );

    // --- imported configuration cannot start a program ----------------------
    const imported = sanitizeSettings({
      mcpServers: {
        evil: { command: 'calc.exe', args: ['--now'], enabled: true },
        ok: { command: 'node', args: ['server.js'], env: { TOKEN: 'abc' }, enabled: true },
      },
      // Nested junk that the old top-level shape check would have waved through.
      chromeExtensions: [{ path: 'C:/tmp/ext', enabled: true }],
    } as never);

    check(
      'an imported MCP server arrives disabled',
      Object.values(imported.mcpServers ?? {}).every((s) => !s.enabled),
      JSON.stringify(imported.mcpServers),
    );
    check(
      'an imported Chrome extension arrives disabled',
      (imported.chromeExtensions ?? []).every((e) => !e.enabled),
      JSON.stringify(imported.chromeExtensions),
    );
    check(
      'a malformed MCP entry is dropped rather than coerced',
      !('bad' in (sanitizeSettings({ mcpServers: { bad: { args: 'nope' } } } as never).mcpServers ?? {})),
    );

    const exported = withoutSecrets({
      ...settings.get(),
      mcpServers: {
        one: {
          command: 'node',
          args: ['server.js', '--token', 'FAKE_TOKEN', '--api-key=FAKE_INLINE'],
          env: { API_TOKEN: 'super-secret' },
          enabled: true,
        },
      },
    });
    check(
      'an exported config keeps env names but not their values',
      !JSON.stringify(exported).includes('super-secret') &&
        'API_TOKEN' in (exported.mcpServers.one.env ?? {}),
      JSON.stringify(exported.mcpServers),
    );
    // Every spelling the reviewer got through a name-matching heuristic. The
    // rule is now inverted — flag names are kept, all values are dropped — so
    // there is no spelling left to find.
    const leaky = withoutSecrets({
      ...settings.get(),
      mcpServers: {
        one: {
          command: 'node',
          args: [
            'server.js',
            '--token',
            'FAKE_TOKEN',
            '--api-key=FAKE_INLINE',
            '--authorization=Bearer.FAKE_BEARER',
            'https://api.example/x?token=FAKE_QUERY',
            'eyJhbGciOi.FAKE_JWT.sig',
            '--token',
            '-FAKE_FLAGLIKE',
          ],
          env: {},
          enabled: true,
        },
      },
    });
    const serialised = JSON.stringify(leaky);
    for (const secret of [
      'FAKE_TOKEN',
      'FAKE_INLINE',
      'FAKE_BEARER',
      'FAKE_QUERY',
      'FAKE_JWT',
      'FAKE_FLAGLIKE',
    ]) {
      check(`an export drops ${secret}`, !serialised.includes(secret), serialised);
    }
    // Keeping "flag names" was the old contract and it leaked: a secret is free
    // to look like a flag (`-secret-token-value`), and an attached short-option
    // value (`-psecretvalue`) is indistinguishable from one. Nothing in an
    // arbitrary command line separates the two, so every value goes.
    check(
      'an export blanks every argument value, flag-shaped or not',
      leaky.mcpServers.one.args.every((a) => a === ''),
      JSON.stringify(leaky.mcpServers.one.args),
    );
    check(
      'and keeps the count, so the shape of the command is still visible',
      leaky.mcpServers.one.args.length === 9,
      String(leaky.mcpServers.one.args.length),
    );
    for (const flagShaped of ['-secret-token-value', '-psecretvalue', '--authorization=Bearer.X']) {
      check(
        `a flag-shaped value like ${flagShaped} does not survive`,
        !JSON.stringify(redactArgs([flagShaped])).includes(flagShaped.replace(/^-+/, '')),
        JSON.stringify(redactArgs([flagShaped])),
      );
    }

    /* ------------------------------------- Stop, at the bridge boundary -- */
    // Cancellation checked in the tool handler is checked one layer too high:
    // `callBridge` then awaits the isolated-world presence check, and possibly
    // injection, before it submits the mutation. A Stop landing in either of
    // those still ended with the click being dispatched. This drives the real
    // `callBridge` with a controlled executor, so it fails if the check moves
    // back above that boundary.
    {
      const submitted: string[] = [];
      let releasePresenceCheck: () => void = () => {};
      const paused = new Promise<void>((resolve) => {
        releasePresenceCheck = resolve;
      });

      const controller = new AbortController();
      const fakeTab = {
        wc: {
          async executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]) {
            const code = scripts[0]?.code ?? '';
            if (code.includes('__nabsunAgent !== "undefined"')) {
              // Hold here, exactly where the reviewer's probe held it.
              await paused;
              return true;
            }
            submitted.push(code);
            return { ok: true, value: 'clicked' };
          },
        },
      } as unknown as Parameters<TabManager['callBridge']>[0];

      const call = tabs.callBridge(
        fakeTab,
        'window.__nabsunAgent.click("x-1")',
        controller.signal,
      ).then(
        () => 'resolved',
        (err: Error) => err.message,
      );

      await new Promise((r) => setTimeout(r, 50));
      controller.abort();
      releasePresenceCheck();
      const outcome = await call;

      check(
        'Stop during the bridge presence check prevents the mutation',
        submitted.length === 0,
        `submitted: ${JSON.stringify(submitted)}`,
      );
      check(
        'and the caller is told why',
        /Stopped before this action reached the page/.test(String(outcome)),
        String(outcome),
      );
    }

    /* --------------------------------------------- fitting a request in -- */
    // Every one of these was a way the old fitter produced a request that was
    // invalid, oversized, or both, while reporting success.

    const tinyTools: ToolSpec[] = [
      { name: 't', description: 'x', inputSchema: { type: 'object', properties: {} }, risk: 'safe', source: 'tabs' },
    ];
    const fitSmall = (msgs: ModelMessage[], window = 4000) =>
      fitToContext(msgs, 'sys', tinyTools, window);

    // Dropping two array entries is not dropping an exchange: a user turn
    // carrying several tool results is one message, so the count-based cut left
    // a tool_result first with no tool_use to match it.
    const withTools: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'a'.repeat(6000) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'A', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'A', content: 'a'.repeat(6000) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'B', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'B', content: 'b'.repeat(200) }] },
    ];
    const fittedTools = fitSmall(withTools);
    const firstBlock = fittedTools.messages[0]?.content[0];
    check(
      'trimming history never leaves a tool_result without its tool_use',
      firstBlock?.type !== 'tool_result',
      `first block is ${firstBlock?.type}`,
    );

    // Only the last message used to be trimmed, so a huge earlier one survived.
    const hugeEarlier: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(93_000) }] },
      { role: 'user', content: [{ type: 'text', text: 'and now a short question' }] },
    ];
    const fittedEarlier = fitSmall(hugeEarlier);
    check(
      'an oversized earlier message is trimmed too, not just the last one',
      JSON.stringify(fittedEarlier.messages).length < 40_000,
      `${JSON.stringify(fittedEarlier.messages).length} chars survived`,
    );

    // Many small blocks add up; a 500-character floor skipped all of them.
    const manySmall: ModelMessage[] = [
      {
        role: 'user',
        content: Array.from({ length: 180 }, () => ({ type: 'text' as const, text: 'y'.repeat(300) })),
      },
    ];
    const fittedSmall = fitSmall(manySmall);
    check(
      'a batch of small blocks is trimmed, not waved through',
      JSON.stringify(fittedSmall.messages).length < 30_000,
      `${JSON.stringify(fittedSmall.messages).length} chars survived`,
    );

    // The estimator has to be a bound, not an average: dense Unicode costs
    // more tokens than characters, and length/3.4 claimed the opposite.
    const cjk = '取消操作'.repeat(2500);
    check(
      'the token estimate is an upper bound for non-ASCII text',
      estimateTokens(cjk) >= cjk.length,
      `${estimateTokens(cjk)} tokens estimated for ${cjk.length} characters`,
    );
    check(
      'and still close to the usual ratio for ASCII',
      Math.abs(estimateTokens('a'.repeat(3400)) - 1000) < 50,
      String(estimateTokens('a'.repeat(3400))),
    );

    // A string is not a boolean, and "false" is truthy — an imported config
    // that set autoApprove.write to the string "false" switched auto-approval
    // *on* while appearing to turn it off.
    const coerced = sanitizeSettings({ autoApprove: { write: 'false', safe: true } } as never);
    check(
      'a string is not accepted where the schema wants a boolean',
      coerced.autoApprove?.write === undefined,
      JSON.stringify(coerced.autoApprove),
    );
    check(
      'a correctly typed nested value still imports',
      coerced.autoApprove?.safe === true,
      JSON.stringify(coerced.autoApprove),
    );

    // The nested case, and the reason the rule is structural rather than a
    // list: `localModel.serverPath` was added after the list was written, went
    // straight through nested validation, and let an imported file choose an
    // executable for the browser to spawn. Any key naming a path, command,
    // binary or endpoint is refused at any depth — including ones added later.
    const nestedExe = sanitizeSettings({
      localModel: {
        serverPath: 'C:/fixture/untrusted.exe',
        modelPath: 'C:/fixture/untrusted.gguf',
        contextSize: 4096,
        threads: 2,
      },
    } as never);
    check(
      'an imported config cannot choose the local engine executable',
      nestedExe.localModel?.serverPath === undefined,
      JSON.stringify(nestedExe.localModel),
    );
    check(
      'nor the model file it loads',
      nestedExe.localModel?.modelPath === undefined,
      JSON.stringify(nestedExe.localModel),
    );
    check(
      'but ordinary tuning in the same object still imports',
      nestedExe.localModel?.contextSize === 4096 && nestedExe.localModel?.threads === 2,
      JSON.stringify(nestedExe.localModel),
    );

    // These name a program to run, or a host that will receive a credential.
    const executables = sanitizeSettings({
      cliPaths: { 'codex-cli': 'C:/evil.exe', 'claude-cli': '' },
      baseUrls: { openai: 'http://attacker.example', ollama: '', anthropic: '' },
    } as never);
    check(
      'an imported config cannot set a CLI executable path',
      executables.cliPaths === undefined,
      JSON.stringify(executables.cliPaths),
    );
    check(
      'an imported config cannot redirect a provider endpoint',
      executables.baseUrls === undefined,
      JSON.stringify(executables.baseUrls),
    );

    // --- a key is only usable where it was saved ----------------------------
    // Exempting unbound keys meant a credential entered before bindings existed
    // stayed usable at any endpoint — the redirect this is meant to prevent.
    const secrets = new SecretStore();
    check(
      'an unbound key is usable at the provider default',
      secrets.boundTo('openai', 'https://api.openai.com/v1', 'https://api.openai.com/v1'),
    );
    check(
      'an unbound key is refused at a different endpoint',
      !secrets.boundTo('openai', 'http://attacker.example', 'https://api.openai.com/v1'),
    );
    check(
      'endpoint comparison ignores a trailing slash rather than treating it as a new host',
      secrets.boundTo('openai', 'https://api.openai.com/', 'https://api.openai.com/v1'),
    );

    // --- a committed action must survive a later provider failure -----------
    // Actions are real the moment they run. A turn that writes and then fails
    // used to persist only the user's message, leaving nothing to reconcile
    // against and inviting a duplicate retry.
    const failing = new FailAfterToolProvider();
    const failAgent = new Agent({
      providers: new Map<string, Provider>([['anthropic', failing]]),
      settings,
      sessions,
      tabs,
      history,
      approvals,
      userDataPath: tmp,
      getTools: () => [...browserTools(), ...tabTools()],
      emit: () => {},
    });
    approvals.setEmitter((r) => approvals.resolve(r.id, 'allow'));

    const failSession = sessions.create();
    await failAgent.send(failSession.id, 'Open a tab, then fail.');

    const failReloaded = sessions.load(failSession.id);
    const roles = (failReloaded?.messages ?? []).map((m) => m.role);
    const toolCalls = (failReloaded?.messages ?? [])
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'tool_call');
    check(
      'a provider failure after a tool call still records the assistant turn',
      roles.includes('assistant'),
      JSON.stringify(roles),
    );
    check(
      'and the completed action is in the durable record',
      toolCalls.length === 1 && failing.toolRan,
      `blocks=${toolCalls.length} ran=${failing.toolRan}`,
    );

    // Journalling once per *batch* was not enough: with two calls in a batch,
    // the first committing and the second interrupted, the whole batch — the
    // completed write included — was still unwritten when the turn unwound.
    const batchAgent = new Agent({
      providers: new Map<string, Provider>([['anthropic', new TwoWriteProvider()]]),
      settings,
      sessions,
      tabs,
      history,
      approvals,
      userDataPath: tmp,
      getTools: () => [...browserTools(), ...tabTools(), probeTool, targetTool, ...extraTools],
      emit: () => {},
    });

    const batchSession = sessions.create();
    // The first call cancels the run from inside the batch, standing in for a
    // Stop pressed between two actions the model asked for together.
    extraTools.push({
      name: 'test_first_write',
      description: 'Records a write and then stops the run.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'safe',
      source: 'tabs',
      handler: async () => {
        sideEffects.push('batch-first');
        batchAgent.abort(batchSession.id);
        return 'first write committed';
      },
    });

    await batchAgent.send(batchSession.id, 'Do two things.');

    const batchReloaded = sessions.load(batchSession.id);
    const batchCalls = (batchReloaded?.messages ?? [])
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'tool_call');
    check(
      'a write completed earlier in a batch survives an interruption later in it',
      sideEffects.includes('batch-first') && batchCalls.length >= 1,
      `ran=${sideEffects.includes('batch-first')} recorded=${batchCalls.length} ` +
        `roles=${JSON.stringify((batchReloaded?.messages ?? []).map((m) => m.role))}`,
    );
  } catch (err) {
    check('harness completed', false, err instanceof Error ? err.stack : String(err));
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  app.exit(failures ? 1 : 0);
});
