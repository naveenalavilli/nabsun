import type {
  AgentEvent,
  AgentQuestion,
  ApprovalRequest,
  ApprovalDecision,
  ChatMessage,
  ChatSession,
  ContentBlock,
  ToolCallStatus,
  TokenUsage,
  PromptQueueState,
  QueuedPrompt,
} from '../../shared/types';
import { renderMarkdown } from './markdown';
import {LocalFoldersView} from './localFolders';
import {VoiceInput} from './voice';
import type { Batch } from '../../shared/workflows';

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
  private voice?:VoiceInput;
  private localFolders?:LocalFoldersView;
  private live: LiveTurn | null = null;
  private runningSessionId: string | null = null;
  private queues = new Map<string, PromptQueueState>();
  private queuePanel = $('#prompt-queue');
  /**
   * Questions waiting on an answer, keyed by id and tagged with their session.
   *
   * The manager blocks until one is answered, so the UI has to be able to show
   * it again after the user navigates away and back — and has to refuse to show
   * another chat's question in this one.
   */
  private sessionGrantRefresh=0;
  private pendingApprovals = new Map<string, ApprovalRequest>();
  private pendingQuestions = new Map<string, AgentQuestion>();

  constructor(private readonly onSessionChanged: () => void, enabled = true) {
    if (!enabled) return;
    this.wireComposer();
    this.wireFiles();
    this.voice=new VoiceInput(this.prompt,()=>this.sessionId);
    this.localFolders=new LocalFoldersView(()=>this.sessionId);
    window.nabsun.workflows?.onChanged(batch => {
      if (batch.scope === this.sessionId) this.renderBatch(batch);
    });
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
    this.voice?.stop();
    this.flushText();
    this.live = null;
    this.sessionId = session.id;
    this.transcript.textContent = '';
    $('#view-chat').classList.toggle('is-empty', !session.messages.length);
    if (!session.messages.length) this.renderEmptyState();
    for (const msg of session.messages) this.transcript.appendChild(this.renderMessage(msg));
    // A question this chat is still waiting on is part of its state, so it
    // comes back when the chat does. Clearing the transcript used to be the end
    // of it, leaving the assistant blocked on a card that no longer existed.
    for (const pending of this.pendingQuestions.values()) {
      if (pending.sessionId === session.id) this.renderQuestion(pending);
    }
    for (const pending of this.pendingApprovals.values()) {
      if (pending.sessionId === session.id) this.renderApproval(pending);
    }
    void this.localFolders?.refresh();
    void this.refreshSessionGrants();
    this.scrollToEnd();
    this.renderQueue();
    void this.refreshFiles().catch(()=>{ $('#attachment-status').textContent='Could not load attachments. Reopen this chat to try again.'; });
    void window.nabsun.workflows?.batches(session.id).then(batches => {
      if (this.sessionId === session.id) this.renderBatch(batches[0]);
    }).catch(() => {});
    void window.nabsun.agent.queue(session.id).then(state => {
      if (!this.queues.has(session.id)) this.queues.set(session.id, state);
      this.renderQueue();
    }).catch(() => { /* Live queue events still keep this view current. */ });
  }

  /** Pre-fills the composer, used by onboarding and the omnibox. */
  ask(text: string, send = false) {
    this.prompt.value = text;
    this.autoGrow();
    this.prompt.focus();
    if (send) this.submit();
  }

  /* ------------------------------------------------------------ composer -- */

  private renderBatch(batch?: Batch) {
    const root = $('#batch-progress');
    root.replaceChildren();
    root.hidden = !batch;
    if (!batch) return;
    const label = document.createElement('span');
    label.textContent = 'Batch ' + batch.state + ': ' + batch.successes + '/' + batch.rowCount + ' completed';
    const action = (text: string, run: () => Promise<unknown>) => {
      const button = document.createElement('button');
      button.textContent = text;
      button.addEventListener('click', () => {
        void run().catch(() => { label.textContent = 'Could not update the batch. Open Data & workflows to review it.'; });
      });
      return button;
    };
    root.append(label, action('View results', () => window.nabsun.workflows.open(batch.scope)));
    if (['running', 'pausing'].includes(batch.state)) {
      root.append(action('Pause', () => window.nabsun.workflows.control(batch.scope, batch.id, 'pause')));
      root.append(action('Stop', () => window.nabsun.workflows.control(batch.scope, batch.id, 'stop')));
    }
  }

  private async refreshFiles(){
    const sessionId=this.sessionId;if(!sessionId)return;
    const files=await window.nabsun.files?.list(sessionId)??[];
    if(this.sessionId!==sessionId)return;
    const list=$('#attached-files');list.replaceChildren();list.hidden=!files.length;
    for(const file of files){
      const item=document.createElement('span');item.className='attached-file';
      const name=document.createElement('span');name.textContent=`${file.name} (${Math.ceil(file.size/1024)} KB)`;name.title=file.name;
      const remove=document.createElement('button');remove.textContent='Remove';remove.setAttribute('aria-label',`Remove ${file.name}`);
      remove.addEventListener('click',async()=>{try{await window.nabsun.files.remove(sessionId,file.id);await this.refreshFiles()}catch{$('#attachment-status').textContent='Could not remove this file. Try again.'}});
      item.append(name,remove);list.append(item);
      if(/\.(png|jpe?g|webp|gif)$/i.test(file.name)){
        void window.nabsun.files.preview(sessionId,file.id).then(url=>{
          if(!url||this.sessionId!==sessionId||!item.isConnected)return;
          const preview=document.createElement('img');preview.src=url;preview.alt=`Preview of ${file.name}`;preview.className='attachment-preview';item.prepend(preview);
        }).catch(()=>{name.title+=' — Preview unavailable; the file is still attached.'});
      }
    }
  }
  private wireFiles(){
    const button=$<HTMLButtonElement>('#attach-files');
    button.addEventListener('click',async()=>{
      if(!this.sessionId)return;
      button.disabled=true;$('#attachment-status').textContent='';
      try{const files=await window.nabsun.files.attach(this.sessionId);await this.refreshFiles();if(files.some(file=>/\.(png|jpe?g|webp|gif)$/i.test(file.name)))$('#attachment-status').textContent='Images are attached. To discuss their contents, choose a vision-capable model with image support enabled in Settings.'}
      catch(error){$('#attachment-status').textContent=error instanceof Error?error.message:'Could not attach files.'}
      finally{button.disabled=false}
    });
  }

  private wireComposer() {
    this.sendBtn.addEventListener('click', () => this.submit());
    this.stopBtn.addEventListener('click', () => {
      this.voice?.stop();
      if (this.runningSessionId || this.sessionId) {
        window.nabsun.agent.abort(this.runningSessionId ?? this.sessionId!);
        this.setActivity('Stopping');
      }
    });
    this.prompt.addEventListener('input', () => {
      this.autoGrow();
      for (const card of this.transcript.querySelectorAll('[data-starter]')) card.removeAttribute('aria-pressed');
    });
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
    if (!text || !this.sessionId) return;
    this.voice?.stop();

    window.nabsun.agent.send(this.sessionId, text, { attachPage: this.attachPage.checked });
    this.prompt.value = '';
    this.autoGrow();
  }

  private setBusy(busy: boolean) {
    this.busyBar.hidden = !busy;
    this.sendBtn.hidden = false;
    this.stopBtn.hidden = !busy;
    this.prompt.disabled = false;
    if (!busy) this.stepBadge.textContent = '';
    this.renderQueue();
  }

  private renderQueue() {
    const working = this.runningSessionId !== null || [...this.queues.values()].some(queue => queue.active);
    this.stopBtn.hidden = !working;
    this.busyBar.hidden = !working;
    const state = this.sessionId ? this.queues.get(this.sessionId) : undefined;
    const sendLabel = this.sendBtn.querySelector('.send-label') ?? this.sendBtn;
    sendLabel.textContent = state?.active ? 'Send next' : 'Send';
    this.sendBtn.setAttribute('aria-label', state?.active ? 'Send after the current reply' : 'Send');
    this.sendBtn.title = state?.active ? 'Your message will wait until the current reply is finished.' : 'Send your message';
    this.stopBtn.title = 'Stop active work and cancel all queued prompts';
    if (!this.queuePanel) return;
    this.queuePanel.replaceChildren();
    this.queuePanel.hidden = !state?.pending.length;
    if (!state?.pending.length) return;
    const heading = document.createElement('strong');
    heading.textContent = `Up next (${state.pending.length})`;
    this.queuePanel.append(heading);
    for (const prompt of state.pending) {
      const row = document.createElement('div');
      row.className = 'queued-prompt';
      row.dataset.promptId = prompt.id;
      const text = document.createElement('span');
      text.textContent = prompt.text;
      text.title = prompt.text + (prompt.attachPage ? '\nIncludes page when this prompt starts.' : '');
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.setAttribute('aria-label', `Cancel queued prompt: ${prompt.text}`);
      cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        try {
          const removed = await window.nabsun.agent.cancelQueued(state.sessionId, prompt.id);
          if (!removed) cancel.title = 'This prompt has already started. Use Stop to cancel it.';
        } catch { cancel.textContent = 'Retry'; }
        finally { cancel.disabled = false; }
      });
      row.append(text, cancel);
      this.queuePanel.append(row);
    }
  }

  private renderStartedPrompt(prompt: QueuedPrompt) {
    this.transcript.querySelector('.empty-state')?.remove();
    $('#view-chat').classList.remove('is-empty');
    this.transcript.appendChild(this.renderMessage({
      id: prompt.id, role: 'user', blocks: [{ type: 'text', text: prompt.text }], createdAt: Date.now(),
    }));
    this.scrollToEnd();
  }

  /* -------------------------------------------------------------- events -- */

  private handleEvent(event: AgentEvent) {
    if (event.type === 'queue_changed') {
      this.queues.set(event.state.sessionId, event.state);
      this.renderQueue();
      return;
    }
    if (event.type === 'prompt_started') {
      this.runningSessionId = event.sessionId;
      this.setBusy(true);
      if (event.sessionId === this.sessionId) this.renderStartedPrompt(event.prompt);
      return;
    }
    if (event.type === 'turn_start') {
      this.runningSessionId = event.sessionId;
      this.setBusy(true);
    }
    if (event.type === 'turn_end' || event.type === 'aborted' || event.type === 'error') {
      for (const [id,request] of this.pendingApprovals) {
        if(request.sessionId===event.sessionId){
          this.pendingApprovals.delete(id);
          this.transcript.querySelector(`[data-approval-id="${CSS.escape(id)}"]`)?.remove();
        }
      }
      if (event.sessionId === this.runningSessionId) {
        this.runningSessionId = null;
        this.setBusy(false);
      }
    }
    if ('sessionId' in event && event.sessionId !== this.sessionId) return;
    if ('messageId' in event && event.type !== 'turn_start' && event.messageId !== this.live?.messageId) return;
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
        if(event.message)this.appendNotice(event.message,'muted');
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
        this.appendNotice(event.message ?? 'The task was interrupted. You can ask me to continue.', 'muted');
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

  private async refreshSessionGrants() {
    const generation = ++this.sessionGrantRefresh;
    const sessionId = this.sessionId;
    const root = $('#session-tool-grants');
    root.replaceChildren();
    root.hidden = true;
    if (!sessionId) return;
    try {
      const grants = await window.nabsun.agent.sessionGrants(sessionId);
      if (this.sessionId !== sessionId || generation !== this.sessionGrantRefresh) return;
      root.hidden = !grants.length;
      if (!grants.length) return;
      const title = document.createElement('p');
      title.className = 'hint';
      title.textContent = 'Auto-allowed in this chat until Nabsun closes. Uncheck to ask again.';
      root.append(title);
      for (const grant of grants) {
        const label = document.createElement('label');
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = true;
        const localNames:Record<string,string>={local_word_create:'Create Word documents',local_word_edit:'Edit Word documents',local_excel_create:'Create Excel workbooks',local_excel_edit:'Edit Excel cells',local_write:'Save local text files',local_edit:'Edit local text files',local_copy:'Copy local files',local_move:'Move or rename local files',local_mkdir:'Create local folders',local_append:'Add text to local files',local_trash:'Move local files to Recycle Bin/Trash'};
        const name = localNames[grant.toolName] ?? (grant.toolName === 'browser_evaluate'
          ? 'Run JavaScript in the page'
          : grant.toolName.replace(/^browser_/, '').replace(/_/g, ' '));
        const source = grant.source && !['browser','local-files'].includes(grant.source) ? ' (' + grant.source + ')' : '';
        label.append(toggle, document.createTextNode(name + source));
        toggle.addEventListener('change', () => {
          toggle.disabled = true;
          void window.nabsun.agent.revokeSessionTool(sessionId, grant.toolName, grant.source)
            .then(() => this.refreshSessionGrants())
            .catch(() => {
              toggle.disabled = false;
              toggle.checked = true;
              title.textContent = 'Could not turn off this permission. Try again.';
            });
        });
        root.append(label);
      }
    } catch {
      if (this.sessionId === sessionId && generation === this.sessionGrantRefresh) {
        root.hidden = false;
        root.textContent = 'Could not load chat permissions. Reopen this chat to try again.';
      }
    }
  }

  private renderApproval(req: ApprovalRequest) {
    this.pendingApprovals.set(req.id,req);
    if(req.sessionId&&req.sessionId!==this.sessionId)return;
    const box = document.createElement('div');
    box.className = 'approval';
    box.dataset.approvalId=req.id;

    const title = document.createElement('h4');
    title.textContent = req.title;
    const risk = document.createElement('span');
    risk.className = `risk ${req.risk}`;
    risk.textContent = req.risk;
    title.appendChild(risk);

    const tool = document.createElement('div');
    tool.className = 'muted';
    tool.textContent = req.source==='local-files'?'Local files in this chat':req.toolName+(req.source&&req.source!=='browser'?' ('+req.source+')':'');

    const detail = document.createElement('pre');
    detail.textContent = req.detail;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const remember=document.createElement('input');remember.type='checkbox';
    const sessionChoice=document.createElement('label');sessionChoice.className='session-approval-choice';
    sessionChoice.append(remember,document.createTextNode('Auto-allow this tool for this chat session'));
    const sessionHelp=document.createElement('p');sessionHelp.className='hint';sessionHelp.textContent='Allows this tool on any website in this chat, including follow-up prompts. Resets when Nabsun closes. Turn it off below the conversation.';
    const decide = (decision: ApprovalDecision) => {
      this.pendingApprovals.delete(req.id);
      window.nabsun.agent.resolveApproval(req.id, decision);
      box.remove();
      const note = document.createElement('div');
      note.className = 'muted';
      note.textContent =
        decision === 'deny' ? `Declined ${req.toolName}` : `Approved ${req.toolName}`;
      this.transcript.appendChild(note);
      if(decision==='allow_session')void this.refreshSessionGrants();
      this.scrollToEnd();
    };

    actions.append(
      button('Allow', 'primary', () => decide(req.allowSession&&remember.checked?'allow_session':'allow')),
      button('Deny', 'ghost', () => decide('deny')),
    );
    if(!req.forceOnce&&req.origin)actions.append(
      button('Allow for this task on this site','ghost',()=>decide('allow_always')),
      button('Allow on this site for 24 hours','ghost',()=>decide('allow_site')),
    );

    box.append(title, tool, detail);
    if(req.allowSession)box.append(sessionChoice,sessionHelp);
    box.append(actions);
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
    if(msg.stopMessage){const note=document.createElement('div');note.className='notice muted';note.textContent=msg.stopMessage;root.appendChild(note)}
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
    const el = document.createElement('section');
    el.className = 'empty-state chat-welcome';
    el.setAttribute('aria-label', 'Start a task with Nabsun');
    el.innerHTML = '<div class="welcome-brand"><span class="welcome-sun" aria-hidden="true"><svg viewBox="0 0 48 48"><defs><linearGradient id="chat-sun" x2="0" y2="1"><stop stop-color="#ffd781"/><stop offset="1" stop-color="#ff642e"/></linearGradient></defs><path d="M12 29a12 12 0 0 1 24 0Z" fill="url(#chat-sun)"/><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M24 7v5M9 14l4 4M3 27h5M39 14l-4 4M40 27h5M12 34h24M18 39h12"/></g></svg></span><span>NABSUN ASSISTANT</span></div><h2>Put your browser<br>to work.</h2><p class="welcome-intro">Find information, get help on websites, or make sense of a file.</p>';
    const examples = document.createElement('div');
    examples.className = 'starter-questions';
    const tasks = [
      { id: 'research', title: 'Find & compare', detail: 'Explore choices. Find what fits.', icon: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5M7 10h6M10 7v6"/>', prompt: 'Help me find and compare a few options. Ask what I am looking for and what matters to me, then show the choices with links and explain the differences in plain language.' },
      { id: 'action', title: 'Help with a task', detail: 'Fill in details. Follow the steps.', icon: '<path d="m5 3 14 9-7 2-3 7Z M14 15l5 5"/>', prompt: 'Help me with a task on this website. Ask what I want to do and which details to use, then guide me or help fill them in. Ask before sending anything.' },
      { id: 'files', title: 'Use a file or image', detail: 'Ask about a document, photo or table.', icon: '<path d="M14 3H5v18h14V8Z M14 3v6h5M8 13h8M8 17h5"/>', prompt: 'Help me with a file or image. Ask what I need to do, then help me add a file or choose a folder with the access you need. Ask before making changes.' },
      { id: 'summary', title: 'Understand a page', detail: 'Get the main points in plain language.', icon: '<path d="M4 4h16v16H4Z M8 8h8M8 12h8M8 16h4"/>', prompt: 'Summarize this page in three short bullet points.' },
    ];
    for (const task of tasks) {
      const card = document.createElement('button');
      card.type = 'button';
      card.dataset.starter = task.id;
      card.innerHTML = '<span class="starter-icon" aria-hidden="true"><svg viewBox="0 0 24 24">' + task.icon + '</svg></span><span class="starter-copy"><strong></strong><span></span></span><span class="starter-arrow" aria-hidden="true">&#8599;</span>';
      card.querySelector('strong')!.textContent = task.title;
      card.querySelector('.starter-copy > span')!.textContent = task.detail;
      card.addEventListener('click', () => {
        this.ask(task.prompt);
        for (const other of examples.querySelectorAll('button')) other.removeAttribute('aria-pressed');
        card.setAttribute('aria-pressed', 'true');
      });
      examples.append(card);
    }
    const footer = document.createElement('div');
    footer.className = 'welcome-footer';
    const hint = document.createElement('p');
    hint.className = 'starter-hint';
    hint.textContent = 'Choose an idea, or type what you need.';
    const tour = document.createElement('button');
    tour.type = 'button';
    tour.className = 'starter-tour';
    tour.innerHTML = 'A quick tour <span aria-hidden="true">&#8594;</span>';
    tour.addEventListener('click', () => window.dispatchEvent(new Event('nabsun:welcome')));
    footer.append(hint, tour);
    el.append(examples, footer);
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
