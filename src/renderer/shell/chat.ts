import type {
  AgentEvent,
  AgentQuestion,
  ApprovalRequest,
  ChatMessage,
  ChatSession,
  ContentBlock,
  ToolCallStatus,
  TokenUsage,
} from '../../shared/types';
import { renderMarkdown } from './markdown';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

/** One streaming assistant turn's live DOM handles. */
interface LiveTurn {
  messageId: string;
  root: HTMLElement;
  body: HTMLElement;
  /** Accumulated text for the paragraph currently being written. */
  textBuffer: string;
  textEl: HTMLElement | null;
  thinkingEl: HTMLElement | null;
  activityEl: HTMLElement | null;
  tools: Map<string, HTMLElement>;
  renderQueued: boolean;
}

export class ChatView {
  private transcript = $('#transcript');
  private prompt = $<HTMLTextAreaElement>('#prompt');
  private sendBtn = $<HTMLButtonElement>('#send');
  private stopBtn = $<HTMLButtonElement>('#stop');
  private stepBadge = $('#step-badge');
  private busyBar = $('#busy-bar');
  private attachPage = $<HTMLInputElement>('#attach-page');

  private sessionId: string | null = null;
  private live: LiveTurn | null = null;
  private busy = false;
  /**
   * Questions waiting on an answer, keyed by id and tagged with their session.
   *
   * The manager blocks until one is answered, so the UI has to be able to show
   * it again after the user navigates away and back — and has to refuse to show
   * another chat's question in this one.
   */
  private pendingQuestions = new Map<string, AgentQuestion>();

  constructor(private readonly onSessionChanged: () => void) {
    this.wireComposer();
    window.nabsun.onAgentEvent((e) => this.handleEvent(e));
    window.nabsun.onApprovalRequest((r) => this.renderApproval(r));
    window.nabsun.onQuestion((q) => this.renderQuestion(q));
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  async start(): Promise<void> {
    const session = await window.nabsun.sessions.create();
    this.setSession(session);
  }

  async open(id: string): Promise<void> {
    const session = await window.nabsun.sessions.load(id);
    if (session) this.setSession(session);
  }

  private setSession(session: ChatSession) {
    this.sessionId = session.id;
    this.transcript.textContent = '';
    if (!session.messages.length) this.renderEmptyState();
    for (const msg of session.messages) this.transcript.appendChild(this.renderMessage(msg));
    // A question this chat is still waiting on is part of its state, so it
    // comes back when the chat does. Clearing the transcript used to be the end
    // of it, leaving the assistant blocked on a card that no longer existed.
    for (const pending of this.pendingQuestions.values()) {
      if (pending.sessionId === session.id) this.renderQuestion(pending);
    }
    this.scrollToEnd();
  }

  /** Pre-fills the composer, used by "Ask about page" and the omnibox. */
  ask(text: string, send = false) {
    this.prompt.value = text;
    this.autoGrow();
    this.prompt.focus();
    if (send) this.submit();
  }

  /* ------------------------------------------------------------ composer -- */

  private wireComposer() {
    this.sendBtn.addEventListener('click', () => this.submit());
    this.stopBtn.addEventListener('click', () => {
      if (this.sessionId) window.nabsun.agent.abort(this.sessionId);
    });
    this.prompt.addEventListener('input', () => this.autoGrow());
    this.prompt.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter is a newline, the convention everywhere else.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
  }

  private autoGrow() {
    this.prompt.style.height = 'auto';
    this.prompt.style.height = `${Math.min(this.prompt.scrollHeight, 160)}px`;
  }

  private submit() {
    const text = this.prompt.value.trim();
    if (!text || this.busy || !this.sessionId) return;

    this.transcript.querySelector('.empty-state')?.remove();
    const message: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      blocks: [{ type: 'text', text }],
      createdAt: Date.now(),
    };
    this.transcript.appendChild(this.renderMessage(message));
    this.scrollToEnd();

    window.nabsun.agent.send(this.sessionId, text, { attachPage: this.attachPage.checked });
    this.prompt.value = '';
    this.autoGrow();
    this.setBusy(true);
  }

  private setBusy(busy: boolean) {
    this.busyBar.hidden = !busy;
    this.busy = busy;
    this.sendBtn.hidden = busy;
    this.stopBtn.hidden = !busy;
    this.prompt.disabled = false;
    if (!busy) this.stepBadge.textContent = '';
  }

  /* -------------------------------------------------------------- events -- */

  private handleEvent(event: AgentEvent) {
    switch (event.type) {
      case 'turn_start':
        this.live = this.beginTurn(event.messageId);
        this.setActivity('Working');
        break;

      case 'text_delta':
        if (!this.live) break;
        this.live.textBuffer += event.delta;
        this.queueTextRender();
        break;

      case 'thinking_delta': {
        if (!this.live) break;
        if (!this.live.thinkingEl) {
          this.live.thinkingEl = document.createElement('div');
          this.live.thinkingEl.className = 'thinking';
          this.live.body.appendChild(this.live.thinkingEl);
        }
        this.live.thinkingEl.textContent += event.delta;
        this.scrollToEnd();
        break;
      }

      case 'step':
        this.stepBadge.textContent = event.step > 1 ? `step ${event.step}/${event.maxSteps}` : '';
        break;

      case 'tool_start': {
        if (!this.live) break;
        this.setActivity(humanizeTool(event.name));
        // A tool call ends the current paragraph; later prose starts a new one.
        this.flushText();
        const card = this.renderToolCard(event.name, event.input);
        this.live.tools.set(event.toolCallId, card);
        this.live.body.appendChild(card);
        this.scrollToEnd();
        break;
      }

      case 'tool_end': {
        const card = this.live?.tools.get(event.toolCallId);
        if (card) this.updateToolCard(card, event.status, event.result, event.durationMs);
        // Back to a neutral label: the next tool has not started yet, but the
        // turn is still running and the user should still see that.
        this.setActivity('Working');
        break;
      }

      case 'turn_end':
        this.flushText();
        this.clearActivity();
        this.live = null;
        this.setBusy(false);
        this.onSessionChanged();
        break;

      case 'aborted':
        this.flushText();
        this.clearActivity();
        // Stop cancels the question too, so the card must go with it — leaving
        // it on screen invited an answer to a task that no longer exists.
        this.dropQuestions(event.sessionId);
        this.appendNotice('Stopped.', 'muted');
        this.live = null;
        this.setBusy(false);
        break;

      case 'error':
        this.flushText();
        this.clearActivity();
        this.appendNotice(event.message, 'error');
        this.live = null;
        this.setBusy(false);
        break;

      case 'usage':
        if (this.live?.messageId === event.messageId) this.renderUsage(this.live.root, event.usage);
        break;
    }
  }

  private beginTurn(messageId: string): LiveTurn {
    const root = document.createElement('div');
    root.className = 'msg assistant';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = 'Assistant';
    const body = document.createElement('div');
    body.className = 'bubble';
    root.append(who, body);
    this.transcript.appendChild(root);
    this.scrollToEnd();
    return { messageId, root, body, textBuffer: '', textEl: null, tools: new Map(), thinkingEl: null, activityEl: null, renderQueued: false };
  }

  /**
   * Markdown is re-rendered from the accumulated buffer rather than appended
   * token by token, because a delta can land mid-syntax (half a code fence, an
   * unclosed bold). Batching to one frame keeps that affordable.
   */
  private queueTextRender() {
    if (!this.live || this.live.renderQueued) return;
    this.live.renderQueued = true;
    requestAnimationFrame(() => {
      if (!this.live) return;
      this.live.renderQueued = false;
      if (!this.live.textEl) {
        this.live.textEl = document.createElement('div');
        this.live.body.appendChild(this.live.textEl);
      }
      this.live.textEl.textContent = '';
      this.live.textEl.appendChild(renderMarkdown(this.live.textBuffer));
      this.scrollToEnd();
    });
  }

  private flushText() {
    if (!this.live) return;
    if (this.live.textBuffer && this.live.textEl) {
      this.live.textEl.textContent = '';
      this.live.textEl.appendChild(renderMarkdown(this.live.textBuffer));
    }
    this.live.textBuffer = '';
    this.live.textEl = null;
    this.live.thinkingEl = null;
  }

  /* ------------------------------------------------------------ activity -- */

  /**
   * A single line saying what the assistant is doing right now.
   *
   * This is what the user gets in place of the trace when verbose is off. It
   * is always built - CSS decides whether it or the detailed cards are shown -
   * so neither mode needs the other to be torn down first.
   */
  private setActivity(label: string) {
    if (!this.live) return;
    if (!this.live.activityEl) {
      const row = document.createElement('div');
      row.className = 'activity';
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      const text = document.createElement('span');
      text.className = 'activity-label';
      row.append(spinner, text);
      this.live.activityEl = row;
      this.live.body.appendChild(row);
    }
    const label_ = this.live.activityEl.querySelector<HTMLElement>('.activity-label');
    if (label_) label_.textContent = `${label}…`;
    // Always last, so it trails the answer as it streams in.
    this.live.body.appendChild(this.live.activityEl);
    this.scrollToEnd();
  }

  private clearActivity() {
    this.live?.activityEl?.remove();
    if (this.live) this.live.activityEl = null;
  }

  /* --------------------------------------------------------------- cards -- */

  private renderToolCard(name: string, input: unknown): HTMLElement {
    const card = document.createElement('div');
    card.className = 'tool running';

    const head = document.createElement('div');
    head.className = 'tool-head';

    const dot = document.createElement('span');
    dot.className = 'dot';

    const nameEl = document.createElement('span');
    nameEl.className = 'tool-name';
    nameEl.textContent = name;

    const summary = document.createElement('span');
    summary.className = 'tool-summary';
    summary.textContent = summarize(input);

    const time = document.createElement('span');
    time.className = 'tool-time';

    head.append(dot, nameEl, summary, time);

    const body = document.createElement('div');
    body.className = 'tool-body';
    body.hidden = true;
    body.append(section('Input', JSON.stringify(input, null, 2)));

    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
    });

    card.append(head, body);
    return card;
  }

  private updateToolCard(card: HTMLElement, status: ToolCallStatus, result: string, ms: number) {
    card.className = `tool ${status}`;
    const time = card.querySelector<HTMLElement>('.tool-time');
    if (time) time.textContent = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
    const body = card.querySelector<HTMLElement>('.tool-body');
    if (body) {
      body.appendChild(section(status === 'ok' ? 'Result' : 'Error', result));
      // Failures are worth seeing without a click; successes stay collapsed.
      if (status === 'error' || status === 'denied') body.hidden = false;
    }
    this.scrollToEnd();
  }

  private renderApproval(req: ApprovalRequest) {
    const box = document.createElement('div');
    box.className = 'approval';

    const title = document.createElement('h4');
    title.textContent = req.title;
    const risk = document.createElement('span');
    risk.className = `risk ${req.risk}`;
    risk.textContent = req.risk;
    title.appendChild(risk);

    const tool = document.createElement('div');
    tool.className = 'muted';
    tool.textContent = req.toolName;

    const detail = document.createElement('pre');
    detail.textContent = req.detail;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const decide = (decision: 'allow' | 'allow_always' | 'deny') => {
      window.nabsun.agent.resolveApproval(req.id, decision);
      box.remove();
      const note = document.createElement('div');
      note.className = 'muted';
      note.textContent =
        decision === 'deny' ? `Declined ${req.toolName}` : `Approved ${req.toolName}`;
      this.transcript.appendChild(note);
      this.scrollToEnd();
    };

    actions.append(
      button('Allow', 'primary', () => decide('allow')),
      button('Always allow this tool', 'ghost', () => decide('allow_always')),
      button('Deny', 'ghost', () => decide('deny')),
    );

    box.append(title, tool, detail, actions);
    this.transcript.appendChild(box);
    this.scrollToEnd();
  }

  /**
   * A question from the assistant, answered in place.
   *
   * Deliberately not the composer: the turn is still running, the composer is
   * disabled while it is, and the answer belongs to this question rather than
   * being a new instruction. Suggested options are buttons; anything else can
   * be typed.
   */
  private renderQuestion(q: AgentQuestion) {
    // Pending questions are kept per session, not just drawn.
    //
    // The card used to be appended straight to whatever transcript happened to
    // be on screen and forgotten: a question for chat A appeared in chat B,
    // switching away and back destroyed it permanently, and the assistant went
    // on waiting for an answer to a card nobody could see any more.
    this.pendingQuestions.set(q.id, q);
    if (q.sessionId !== this.sessionId) return;

    const box = document.createElement('div');
    box.className = 'approval question';
    box.dataset.questionId = q.id;

    const title = document.createElement('h4');
    title.textContent = 'The assistant is asking';

    const text = document.createElement('div');
    text.className = 'question-text';
    text.textContent = q.question;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Type your answer…';
    input.className = 'question-input';

    const answer = (value: string | null) => {
      window.nabsun.agent.answer(q.id, value);
      this.pendingQuestions.delete(q.id);
      box.remove();
      const note = document.createElement('div');
      note.className = 'muted';
      note.textContent = value === null ? 'Left unanswered' : `You answered: ${value}`;
      this.transcript.appendChild(note);
      this.scrollToEnd();
    };

    for (const option of q.options) {
      actions.appendChild(button(option, 'ghost', () => answer(option)));
    }
    actions.appendChild(
      button('Send', 'primary', () => {
        if (input.value.trim()) answer(input.value.trim());
      }),
    );
    actions.appendChild(button('Skip', 'ghost', () => answer(null)));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        answer(input.value.trim());
      }
    });

    box.append(title, text, input, actions);
    this.transcript.appendChild(box);
    this.scrollToEnd();
    input.focus();
  }

  /** Forgets a session's pending questions and removes any card on screen. */
  private dropQuestions(sessionId: string): void {
    for (const [id, q] of [...this.pendingQuestions]) {
      if (q.sessionId !== sessionId) continue;
      this.pendingQuestions.delete(id);
      this.transcript.querySelector(`[data-question-id="${id}"]`)?.remove();
    }
  }

  /* ------------------------------------------------------------ rendering -- */

  private renderMessage(msg: ChatMessage): HTMLElement {
    const root = document.createElement('div');
    root.className = `msg ${msg.role}`;

    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = msg.role === 'user' ? 'You' : 'Assistant';

    const body = document.createElement('div');
    body.className = 'bubble';

    for (const block of msg.blocks) this.appendBlock(body, block);

    root.append(who, body);
    if (msg.usage) this.renderUsage(root, msg.usage);
    return root;
  }

  private renderUsage(root: HTMLElement, usage: TokenUsage) {
    let row = root.querySelector<HTMLElement>('.token-usage');
    if (!row) {
      row = document.createElement('div');
      row.className = 'token-usage muted';
      root.appendChild(row);
    }
    row.textContent = `${usage.inputTokens.toLocaleString()} input · ${usage.outputTokens.toLocaleString()} output tokens` +
      (usage.cacheReadTokens ? ` · ${usage.cacheReadTokens.toLocaleString()} cached input` : '') +
      (usage.cacheWriteTokens ? ` · ${usage.cacheWriteTokens.toLocaleString()} cache writes` : '');
    row.title = 'Provider-reported totals for this task. Cached input and cache writes are included in input where reported; unavailable usage is not estimated.';
  }

  private appendBlock(parent: HTMLElement, block: ContentBlock) {
    switch (block.type) {
      case 'text': {
        const el = document.createElement('div');
        el.appendChild(renderMarkdown(block.text));
        parent.appendChild(el);
        break;
      }
      case 'thinking': {
        const el = document.createElement('div');
        el.className = 'thinking';
        el.textContent = block.text;
        parent.appendChild(el);
        break;
      }
      case 'tool_call': {
        const card = this.renderToolCard(block.name, block.input);
        this.updateToolCard(card, block.status, block.result ?? '', block.durationMs ?? 0);
        parent.appendChild(card);
        break;
      }
      case 'image': {
        const img = document.createElement('img');
        img.src = `data:${block.mediaType};base64,${block.data}`;
        img.style.maxWidth = '100%';
        img.style.borderRadius = '6px';
        parent.appendChild(img);
        break;
      }
    }
  }

  private appendNotice(text: string, kind: 'muted' | 'error') {
    const el = document.createElement('div');
    el.className = kind === 'error' ? 'error-box' : 'muted';
    el.textContent = text;
    this.transcript.appendChild(el);
    this.scrollToEnd();
  }

  private renderEmptyState() {
    const el = document.createElement('div');
    el.className = 'empty-state';
    const h = document.createElement('h3');
    h.textContent = 'Ask about this page, or hand me a task.';
    const p = document.createElement('div');
    p.textContent =
      'I can read what you are looking at, search, open tabs, fill forms and click through a flow. Actions that change something ask you first.';
    const p2 = document.createElement('div');
    p2.style.marginTop = '12px';
    p2.textContent = 'Ctrl+L address bar · Ctrl+Shift+P commands · Ctrl+Shift+A toggle this panel';
    el.append(h, p, p2);
    this.transcript.appendChild(el);
  }

  private scrollToEnd() {
    // Respect a user who has scrolled up to read something earlier.
    const nearBottom =
      this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 120;
    if (nearBottom) this.transcript.scrollTop = this.transcript.scrollHeight;
  }
}

function section(label: string, text: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'section';
  const h = document.createElement('h5');
  h.textContent = label;
  const pre = document.createElement('div');
  pre.textContent = text;
  wrap.append(h, pre);
  return wrap;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * A tool id turned into something worth showing a person.
 *
 * `mcp__nabsun__browser_read_text` becomes "Reading text" - the prefix is
 * routing information, and the underscores are an identifier convention. A
 * name that falls through the table still reads better unprefixed than raw.
 */
export function humanizeTool(name: string): string {
  const bare = name.replace(/^mcp__[a-z0-9-]+__/i, '').replace(/^browser_/, '');
  const known: Record<string, string> = {
    web_search: 'Searching the web',
    fetch_url: 'Fetching a page',
    read_text: 'Reading the page',
    snapshot: 'Looking at the page',
    navigate: 'Opening a page',
    tab_open: 'Opening a tab',
    click: 'Clicking',
    type: 'Typing',
    extract: 'Extracting data',
    screenshot: 'Taking a screenshot',
  };
  if (known[bare]) return known[bare];
  const words = bare.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Working';
}

/** One-line gist of a tool's arguments for the collapsed card header. */
function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of ['url', 'query', 'text', 'expression', 'selector', 'key', 'direction', 'ref']) {
    if (obj[key] !== undefined) {
      const value = String(obj[key]);
      return value.length > 70 ? `${value.slice(0, 70)}…` : value;
    }
  }
  const json = JSON.stringify(obj);
  return json.length > 70 ? `${json.slice(0, 70)}…` : json === '{}' ? '' : json;
}
