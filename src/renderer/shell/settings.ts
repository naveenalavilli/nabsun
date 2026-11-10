import type { ProviderId, ProviderStatus, Settings } from '../../shared/types';
import { isOnDevice } from '../../shared/types';
import { modelPicker } from './model-picker';
import { appearanceSelector } from './appearance';
import { updatesSection } from './updates';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
};

let fieldId = 0;
function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', { className: 'field' });
  const caption = el('label', { textContent: label });
  const input = control.matches('input, select, textarea') ? control : control.querySelector('input, select, textarea');
  if (input) { input.id ||= `setting-field-${++fieldId}`; caption.htmlFor = input.id; }
  wrap.append(caption, control);
  if (hint) wrap.append(el('div', { className: 'hint', textContent: hint }));
  return wrap;
}

function checkbox(
  label: string,
  checked: boolean,
  hint: string,
  onChange: (v: boolean) => void,
): HTMLElement {
  const input = el('input', { type: 'checkbox', checked });
  input.className = 'settings-toggle';
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => onChange(input.checked));
  const text = el('div', {}, [el('span', { textContent: label })]);
  if (hint) text.append(el('div', { className: 'hint', textContent: hint }));
  return el('label', { className: 'check' }, [input, text]);
}

export class SettingsView {
  private root = document.querySelector<HTMLElement>('#settings-body')!;
  private settings: Settings | null = null;
  private credentials: ProviderStatus[] = [];
  private paintAbort = new AbortController();
  private activeCategory = 'overview';
  private searchQuery = '';
  private saveError = '';
  private paintGeneration = 0;
  private approvalSave: Promise<void> = Promise.resolve();
  private integrationSave:Promise<void>=Promise.resolve();
  private setIntegrationControl(key:'plugins'|'mcp'|'extensions',value:boolean){
    this.integrationSave=this.integrationSave.then(async()=>{
      const current=this.settings;if(!current)return;
      try{this.settings=await window.nabsun.settings.set({integrationControls:{plugins:true,mcp:true,extensions:true,...current.integrationControls,[key]:value}});this.onChanged(this.settings)}catch{this.settings=await window.nabsun.settings.get().catch(()=>this.settings);this.saveError='The change could not be fully applied. Check integration status and try again.';this.paint()}
    });
  }

  private setAutoApprove(key: keyof Settings['autoApprove'], value: boolean) {
    // Serialize edits so even rapid toggles merge with the preceding save.
    this.approvalSave = this.approvalSave.then(() =>
      this.patch({ autoApprove: { ...this.settings!.autoApprove, [key]: value } }));
  }
  /**
   * What happened to the last credential save, per provider.
   *
   * A failed or session-only save has to outlive the redraw that follows it,
   * or the UI shows "Key stored" for a key that reached nothing.
   */
  private saveOutcomes = new Map<string, { message: string; sessionOnly: boolean }>();

  constructor(private readonly onChanged: (s: Settings) => void) {}

  async render(): Promise<void> {
    try {
      this.settings = await window.nabsun.settings.get();
      this.credentials = await window.nabsun.settings.credentialStatus();
      this.paint();
    } catch {
      const error = el('p', { className: 'settings-save-error', textContent: 'Could not load settings. Please try again.' });
      error.setAttribute('role', 'alert');
      const retry = el('button', { className: 'ghost', textContent: 'Try again' });
      retry.addEventListener('click', () => void this.render());
      this.root.replaceChildren(error, retry);
    }
  }

  private async patch(patch: Partial<Settings>) {
    try {
      this.settings = await window.nabsun.settings.set(patch);
      this.saveError = '';
      this.root.querySelector('.settings-save-error')?.remove();
      this.onChanged(this.settings);
    } catch {
      this.saveError = 'Could not save settings. Your previous settings are still active. Please try again.';
      this.paint();
    }
  }

  private paint() {
    this.paintAbort.abort();
    this.paintAbort = new AbortController();
    const generation = ++this.paintGeneration;
    const s = this.settings;
    if (!s) return;
    this.root.textContent = '';
    if (this.saveError) {
      const error = el('p', { className: 'settings-save-error', textContent: this.saveError });
      error.setAttribute('role', 'alert');
      this.root.append(error);
    }
    const layout = el('div', { className: 'settings-layout' });
    const rail = el('nav', { className: 'settings-rail' });
    rail.setAttribute('aria-label', 'Settings categories');
    rail.append(el('p', { className: 'settings-eyebrow', textContent: 'MAKE IT YOURS' }), el('h1', { textContent: 'Settings' }));
    const search = el('input', { type: 'search', placeholder: 'Find a setting', value: this.searchQuery });
    search.setAttribute('aria-label', 'Find a setting');
    rail.append(search);
    const content = el('div', { className: 'settings-content', id: 'settings-content' });
    content.tabIndex = -1;
    const categories: [string, string, string, string][] = [
      ['overview', 'Getting started', 'A good place to begin', 'start welcome setup'],
      ['model', 'Assistant choice', 'Choose the helper you want to use', 'provider api key local ollama codex claude token engine'],
      ['appearance', 'Appearance', 'Make Nabsun feel like home', 'theme color light dark style'],
      ['assistant', 'Assistant & permissions', 'Decide how your assistant works', 'approval autopilot privacy memory soul reasoning steps screenshots'],
      ['browsing', 'Browsing & data', 'Your everyday browser preferences', 'homepage search downloads passwords clear history cookies cache'],
      ['integrations', 'Advanced connections', 'Optional tools for experienced users', 'mcp plugins bridge external agents'],
      ['updates', 'App updates', 'Keep your browser current', 'version release download'],
      ['advanced', 'Advanced settings', 'Files and advanced preferences', 'paths profile config reset'],
    ];
    const panels = new Map<string, HTMLElement>();
    const buttons = new Map<string, HTMLButtonElement>();
    const overview = el('div', { className: 'settings-overview' });
    overview.append(el('p', { className: 'settings-eyebrow', textContent: 'YOUR BROWSER, YOUR WAY' }),
      el('h2', { textContent: 'A little setup. A lot of possibility.' }),
      el('p', { className: 'settings-lead', textContent: 'Start with the essentials, then make this space your own. Changes save as you go.' }));
    const welcome = el('button', { className: 'setup-banner', textContent: 'New here? Take the visual getting-started tour \u2192' });
    welcome.addEventListener('click', () => window.dispatchEvent(new Event('nabsun:welcome')));
    overview.append(welcome);
    const cards = el('div', { className: 'settings-cards' });
    const select = (id: string, focus = false) => {
      this.activeCategory = id;
      for (const [key, panel] of panels) panel.hidden = key !== id;
      for (const [key, button] of buttons) button.setAttribute('aria-current', key === id ? 'page' : 'false');
      content.scrollTop = 0;
      if (focus) content.focus();
    };
    const mount = (id: string, node: HTMLElement) => {
      const info = categories.find(c => c[0] === id)!;
      const panel = el('section', { className: 'settings-category', id: `settings-${id}` });
      panel.setAttribute('aria-label', info[1]);
      if (id !== 'overview') panel.append(el('h2', { textContent: info[1] }), el('p', { className: 'settings-lead', textContent: info[2] }));
      panel.append(node);
      panels.set(id, panel);
      content.append(panel);
      panel.hidden = this.activeCategory !== id;
    };
    for (const [id, title, description] of categories) {
      const button = el('button', { textContent: title });
      button.setAttribute('aria-controls', `settings-${id}`);
      button.addEventListener('click', () => select(id, true));
      buttons.set(id, button); rail.append(button);
      if (id !== 'overview' && id !== 'advanced') {
        const card = el('button', { className: 'settings-card' }, [el('span', { className: 'settings-card-mark', textContent: String(cards.childElementCount + 1).padStart(2, '0') }), el('strong', { textContent: title }), el('span', { textContent: description }), el('span', { className: 'settings-card-link', textContent: 'Explore \u2192' })]);
        card.addEventListener('click', () => select(id, true)); cards.append(card);
      }
    }
    const empty = el('p', { className: 'hint', textContent: 'No categories match. Try model, theme, or privacy.', hidden: true });
    rail.append(empty, el('p', { className: 'hint', textContent: 'Your preferences save automatically. Accounts and browser actions keep their existing permission controls.' }));
    const filter = () => {
      this.searchQuery = search.value;
      const query = search.value.trim().toLowerCase();
      let matches = 0;
      for (const [id, title, description, keywords] of categories) {
        const match = `${title} ${description} ${keywords}`.toLowerCase().includes(query);
        buttons.get(id)!.hidden = !match;
        if (match) matches++;
      }
      empty.hidden = matches > 0;
    };
    search.addEventListener('input', filter);
    search.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const first = [...buttons].find(([, b]) => !b.hidden); if (first) select(first[0], true); }
    });
    overview.append(cards);
    mount('overview', overview);
    mount('updates', updatesSection());
    mount('appearance', appearanceSelector(s, next => { this.settings = next; this.onChanged(next); }));
    mount('model', this.modelSection(s));
    mount('assistant', this.behaviourSection(s));
    mount('browsing', this.browsingSection(s));
    layout.append(rail, content); this.root.append(layout);
    // Expose category selection for commands such as Clear browsing data.
    this.root.addEventListener('settings:reveal', event => select((event as CustomEvent<string>).detail, true), { signal: this.paintAbort.signal });
    select(this.activeCategory); filter();
    void this.integrationsSection().then(node => {
      if (generation !== this.paintGeneration) return;
      mount('integrations', node);
    }).catch(() => {
      if (generation === this.paintGeneration) mount('integrations', el('p', { textContent: 'Could not load integrations. Reopen Settings to try again.' }));
    });
    void this.advancedSection().then(node => {
      if (generation === this.paintGeneration) mount('advanced', node);
    }).catch(() => {
      if (generation === this.paintGeneration) mount('advanced', el('p', { textContent: 'Could not load configuration. Reopen Settings to try again.' }));
    });
  }

  /* ---------------------------------------------------------------- model */

  private modelSection(s: Settings): HTMLElement {
    const set = el('fieldset');
    set.append(el('legend', { textContent: 'Model' }));

    const providerSelect = el('select');
    for (const p of this.credentials) {
      providerSelect.append(el('option', { value: p.id, textContent: p.label, selected: s.provider === p.id }));
    }
    providerSelect.addEventListener('change', async () => {
      await this.patch({ provider: providerSelect.value as ProviderId });
      this.paint();
    });
    set.append(field('Assistant', providerSelect));

    const current = this.credentials.find((c) => c.id === s.provider);

    // CLI backends use their own login; model choices still apply per turn.
    if (current?.kind === 'cli') {
      const status = el('div', { className: 'status-line' }, [
        el('span', { className: `dot ${current.hasCredentials ? 'on' : 'off'}` }),
        el('span', {
          textContent: current.hasCredentials ? 'Installed' : 'Not found',
        }),
        el('span', { className: 'muted', textContent: current.detail ?? '' }),
      ]);

      const pathInput = el('input', {
        type: 'text',
        value: s.cliPaths[current.id as 'claude-cli' | 'codex-cli'] ?? '',
        placeholder: 'Leave blank to find it on PATH',
      });
      pathInput.addEventListener('change', async () => {
        await this.patch({
          cliPaths: { ...s.cliPaths, [current.id]: pathInput.value.trim() },
        });
        await this.render();
      });

      const modelInput = modelPicker(s, next => {
        this.settings = next;
        this.onChanged(next);
      });

      set.append(
        field(
          'Status',
          status,
          'Connect in Extensions. Nabsun handles setup and account sign-in for you.',
        ),
        field('Executable path', pathInput, 'Only needed when the CLI is not on your PATH.'),
        field('Model', modelInput),
      );

      const connect = el('button', { className: 'primary', textContent: 'Manage connection' });
      connect.addEventListener('click', () => document.querySelector<HTMLElement>('#extensions-btn')?.click());
      set.append(connect);

      set.append(
        field(
          'Browser tools',
          el('div', {
            className: 'hint',
            textContent:
              'The CLI gets this browser as an MCP tool server, so it can read pages, click and type here. Its own file and shell tools stay disabled. Every browser action still goes through the approval gate below.',
          }),
        ),
      );
      return set;
    }
    // The built-in model needs no key and no model list; what it does have is
    // a file on disk that can be missing, and knobs that cost RAM.
    if (current?.kind === 'local') {
      const status = el('div', { className: 'status-line' }, [
        el('span', { className: `dot ${current.hasCredentials ? 'on' : 'off'}` }),
        el('span', { textContent: current.hasCredentials ? 'Ready' : 'Model missing' }),
        el('span', { className: 'muted', textContent: current.detail ?? '' }),
      ]);

      const localInput = (
        key: 'serverPath' | 'modelPath',
        placeholder: string,
      ): HTMLInputElement => {
        const input = el('input', { type: 'text', value: s.localModel[key], placeholder });
        input.addEventListener('change', async () => {
          await this.patch({ localModel: { ...s.localModel, [key]: input.value.trim() } });
          await this.render();
        });
        return input;
      };

      const numberInput = (
        key: 'contextSize' | 'threads',
        min: number,
        hint: string,
      ): HTMLInputElement => {
        const input = el('input', { type: 'number', value: String(s.localModel[key]) });
        input.min = String(min);
        input.title = hint;
        input.addEventListener('change', () => {
          const parsed = Number(input.value);
          if (!Number.isFinite(parsed)) return;
          void this.patch({
            localModel: { ...s.localModel, [key]: Math.max(min, Math.round(parsed)) },
          });
        });
        return input;
      };

      set.append(
        field(
          'Status',
          status,
          current.hasCredentials
            // Scoped to inference on purpose. The browser still browses:
            // navigation, search, fetch_url and any enabled integration all
            // reach the network, and claiming otherwise here would be read as a
            // guarantee about the whole application.
            ? 'Answers are generated on your computer. Your questions and included page text are not sent to an online AI service. Browsing websites still uses the internet.'
            : 'The built-in assistant files could not be found. Reinstall Nabsun from the official release, or choose another assistant above. If you built Nabsun from source, see the setup instructions in the README.',
        ),
        field(
          'When to switch',
          el('div', {
            className: 'hint',
            textContent:
              'The built-in assistant is best for short, simple tasks. For longer research or more demanding questions, choose a more capable assistant above — your settings for it are kept.',
          }),
        ),
      );
      const advanced = el('details', { className: 'settings-advanced' });
      advanced.append(el('summary', { textContent: 'Advanced settings for the built-in assistant' }));
      advanced.append(
        field(
          'Model file',
          localInput('modelPath', 'Leave blank to use the bundled model'),
          'Any GGUF llama.cpp can load. A larger model is slower but more capable.',
        ),
        field(
          'Engine path',
          localInput('serverPath', 'Leave blank to use the bundled llama-server'),
          'Only needed to run your own build of llama.cpp.',
        ),
        field(
          'Context size',
          numberInput('contextSize', 2048, 'Tokens held in the window'),
          'Tokens the model can see at once. A page snapshot is most of it. Higher costs RAM.',
        ),
        field(
          'CPU threads',
          numberInput('threads', 0, 'Threads; 0 lets llama.cpp choose'),
          '0 lets llama.cpp choose based on your CPU.',
        ),
      );
      set.append(advanced);
      return set;
    }

    const modelInput = el('input', { type: 'text', value: s.models[s.provider] ?? '' });
    const datalistId = 'model-options';
    modelInput.setAttribute('list', datalistId);
    const datalist = el('datalist', { id: datalistId });
    for (const m of current?.models ?? []) datalist.append(el('option', { value: m }));
    modelInput.addEventListener('change', () => {
      void this.patch({ models: { ...s.models, [s.provider]: modelInput.value.trim() } });
    });
    set.append(
      field(
        'Model',
        el('div', {}, [modelInput, datalist]),
        current?.models.length
          ? 'Pick from the list, or type any model id your account can reach.'
          : 'Add an API key to load the model list. You can type an id in the meantime.',
      ),
    );

    // Credentials, one row per provider.
    for (const provider of this.credentials) {
      // Ollama needs no key; CLI backends carry their own login.
      if (provider.id === 'ollama' || provider.kind === 'cli') continue;
      const row = el('div', { className: 'inline' });
      const input = el('input', {
        type: 'password',
        placeholder: provider.hasCredentials ? '•••••••••• (saved)' : 'Paste an API key',
      });
      // Shown only when a save did not do what it looked like.
      // Held in view state, not in this DOM node.
      //
      // The warning used to be written straight into the note and then wiped by
      // the `render()` on the next line, leaving "Key stored" on screen for a
      // key that had not been stored. A redraw must be able to reconstruct the
      // outcome, so the outcome lives where a redraw can see it.
      const outcome = this.saveOutcomes.get(provider.id);
      const note = el('div', { className: 'hint error' });
      note.hidden = !outcome;
      if (outcome) note.textContent = outcome.message;

      const save = el('button', { className: 'ghost', textContent: 'Save' });
      save.addEventListener('click', async () => {
        if (!input.value.trim()) return;
        // The result is not decorative: without a keychain the key is kept for
        // this session only, and clearing the field and redrawing as if it were
        // saved is exactly how someone ends up trusting a key that is not there.
        const result = await window.nabsun.settings.setCredential(provider.id, input.value.trim());
        if (result?.ok === false) {
          this.saveOutcomes.set(provider.id, {
            message:
              result.error ?? 'That key could not be saved and is only held for this session.',
            sessionOnly: result.sessionOnly === true,
          });
          if (!result.sessionOnly) {
            // Nothing was stored at all; keep the typed value so it is not lost.
            note.textContent = this.saveOutcomes.get(provider.id)!.message;
            note.hidden = false;
            return;
          }
        } else {
          this.saveOutcomes.delete(provider.id);
        }
        input.value = '';
        await this.render();
      });
      const clear = el('button', { className: 'ghost', textContent: 'Clear' });
      clear.addEventListener('click', async () => {
        await window.nabsun.settings.clearCredential(provider.id);
        this.saveOutcomes.delete(provider.id);
        await this.render();
      });
      row.append(input, save, clear);

      // A key held only for this session is not "stored", and saying so is the
      // whole point of the outcome surviving the redraw.
      const stateLabel = outcome?.sessionOnly
        ? 'Held for this session only — not saved'
        : provider.hasCredentials
          ? 'Key stored'
          : 'No key configured';
      const status = el('div', { className: 'status-line' }, [
        el('span', {
          className: `dot ${outcome?.sessionOnly ? 'warn' : provider.hasCredentials ? 'on' : 'off'}`,
        }),
        el('span', { textContent: stateLabel }),
      ]);

      set.append(
        field(
          `${provider.label} API key`,
          el('div', {}, [status, row, note]),
          'Encrypted with the OS keychain, and bound to the endpoint it is saved for. ' +
            'If no keychain is available it is not written to disk at all. ' +
            'Environment variables are used as a fallback.',
        ),
      );
    }

    const ollamaUrl = el('input', { type: 'text', value: s.baseUrls.ollama });
    ollamaUrl.addEventListener('change', () => {
      void this.patch({ baseUrls: { ...s.baseUrls, ollama: ollamaUrl.value.trim() } });
    });
    set.append(field('Ollama endpoint', ollamaUrl, 'For running local models. No key needed.'));

    const openaiUrl = el('input', { type: 'text', value: s.baseUrls.openai });
    openaiUrl.addEventListener('change', () => {
      void this.patch({ baseUrls: { ...s.baseUrls, openai: openaiUrl.value.trim() } });
    });
    set.append(
      field('OpenAI-compatible endpoint', openaiUrl, 'Change this to point at any OpenAI-compatible API.'),
    );

    return set;
  }

  /* ------------------------------------------------------------ behaviour */

  private behaviourSection(s: Settings): HTMLElement {
    const set = el('fieldset');
    set.append(el('legend', { textContent: 'Assistant behaviour' }));

    set.append(
      checkbox(
        'Show reasoning',
        s.extendedThinking,
        'Streams a summary of the model’s reasoning above its answer.',
        (v) => void this.patch({ extendedThinking: v }),
      ),
      checkbox(
        'Verbose mode',
        s.verbose,
        'Shows the reasoning trace and every tool call. Off by default: without it you get a progress line while the assistant works.',
        (v) => void this.patch({ verbose: v }),
      ),
      checkbox(
        'Allow screenshots',
        s.vision,
        'Lets the assistant look at the page visually when layout matters.',
        (v) => void this.patch({ vision: v }),
      ),
    );

    const steps = el('input', { type: 'number', value: String(s.maxAgentSteps), min: '1', max: '200' });
    steps.addEventListener('change', () => {
      void this.patch({ maxAgentSteps: Math.max(1, Number(steps.value) || 40) });
    });
    set.append(
      field('Maximum steps per task', steps, 'How many tool rounds one request may take before stopping to check in.'),
    );

    set.append(el('legend', { textContent: 'Permissions' }));
    const inputBudget = el('input', { type: 'number', value: String(s.inputTokenBudget), min: '8000', max: '128000', step: '1000' });
    inputBudget.addEventListener('change', () => void this.patch({ inputTokenBudget: Math.max(8000, Math.min(128000, Number(inputBudget.value) || 24000)) }));
    set.append(field('Input token budget per request', inputBudget, 'Estimated limit for hosted API requests. Stops oversized requests without silently forgetting your instructions. Native CLI agents manage their own context.'));
    set.append(checkbox('Use saved agent notes', s.memoryEnabled,
      'Retrieve short relevant notes from agent-notes.json in your profile. Ask the assistant to remember, find, or delete a note.',
      v => void this.patch({ memoryEnabled: v })));
    set.append(checkbox('Keep agent notes local', s.memoryLocalOnly,
      'Only on-device models can read or change saved notes. Turn off to share relevant notes with cloud models and external agents. This is separate from soul.md sharing.',
      v => void this.patch({ memoryLocalOnly: v })));
    const memoryPath = el('div', { className: 'hint' });
    set.append(memoryPath);
    void window.nabsun.config.paths().then(paths => {
      const separator = paths.userData.includes('\\') ? '\\' : '/';
      memoryPath.textContent = `Saved notes: ${paths.userData}${separator}agent-notes.json`;
    }).catch(() => { memoryPath.textContent = 'Saved notes are in agent-notes.json in your profile folder.'; });

    set.append(
      checkbox(
        'Run read-only actions automatically',
        s.autoApprove.safe,
        'Reading pages, searching, extracting data. Nothing is changed.',
        (v) => this.setAutoApprove('safe', v),
      ),
      checkbox(
        'Autopilot — run page actions without asking',
        s.autoApprove.write,
        'Applies to one site in each task. Changing sites asks again. Uploads and page JavaScript always ask.',
        (v) => this.setAutoApprove('write', v),
      ),
    );

    set.append(this.soulField(s));
    const activity=el('button',{className:'ghost',textContent:'Review assistant activity'});
    activity.addEventListener('click',()=>window.nabsun.window.openWorkspace('activity'));
    const retention=el('select');for(const days of [7,30,90,365])retention.append(el('option',{value:String(days),textContent:days+' days'}));retention.value=String(s.auditRetentionDays??30);
    retention.addEventListener('change',()=>void this.patch({auditRetentionDays:Number(retention.value)}));
    set.append(field('Activity journal',activity,'Actions are recorded locally. Typed values are hashed. If recording fails, further actions stop.'),field('Keep activity for',retention,'Older days are removed before the next action after the retention period. Export anything you need to keep.'));

    if (s.approvalMigrationNotice) {
      const notice=el('p',{className:'muted',textContent:'For your safety, old global always-allow permissions were removed. You can now allow an action once, for this task on this site, or on this site for 24 hours.'});
      const dismiss=el('button',{className:'ghost',textContent:'Got it'});
      dismiss.addEventListener('click',()=>void this.patch({approvalMigrationNotice:false}));
      set.append(notice,dismiss);
    }
    if (s.siteToolGrants?.length) {
      const reset = el('button', {
        className: 'ghost',
        textContent: `Revoke all ${s.siteToolGrants.length} site permissions`,
      });
      reset.addEventListener('click', () => void this.patch({ siteToolGrants: [] }));
      set.append(
        field('Site action permissions', reset, s.siteToolGrants.map(grant=>`${grant.tool} on ${grant.origin} until ${new Date(grant.expiresAt).toLocaleString()}`).join('; ')),
      );
    }

    return set;
  }

  /* ------------------------------------------------------------- browsing */

  private sitePermissionsField(){
    const body=el('div');
    const refresh=async()=>{
      body.replaceChildren();
      const decisions=await window.nabsun.sitePermissions.list();
      if(!decisions.length)body.append(el('p',{className:'hint',textContent:'No remembered choices. Websites ask before using your camera, microphone, location, notifications, or clipboard.'}));
      for(const origin of [...new Set(decisions.map(item=>item.origin))]){
        const row=el('div',{className:'settings-field'});
        row.append(el('p',{textContent:origin}),el('p',{className:'hint',textContent:decisions.filter(item=>item.origin===origin).map(item=>`${item.capability}: ${item.allowed?'allowed':'blocked'}`).join('; ')}));
        const reset=el('button',{className:'ghost',textContent:'Reset permissions'});
        reset.addEventListener('click',()=>{void window.nabsun.sitePermissions.revoke(origin).then(refresh).catch(()=>{body.append(el('p',{textContent:'Could not reset permissions. Try again.'}))})});
        row.append(reset);body.append(row);
      }
    };
    void refresh().catch(()=>body.append(el('p',{className:'hint',textContent:'Could not read site permissions.'})));
    return field('Website permissions',body,'Only you can answer permission prompts. The assistant cannot approve them.');
  }

  private networkField(s:Settings){
    const config=s.browserNetwork??{mode:'system',pacUrl:'',proxy:'',integratedDomains:''};
    const details=el('details'),summary=el('summary',{textContent:'Network and work sign-in'}),body=el('div');details.append(summary,body);
    body.append(el('p',{className:'hint',textContent:'Most people can keep system settings. Your workplace may provide a proxy or sign-in domain. These settings apply to browser tabs.'}));
    const mode=el('select');for(const [value,label] of [['system','Use system settings'],['direct','Connect directly'],['pac','Use a PAC configuration URL'],['manual','Use a proxy server']])mode.append(el('option',{value,textContent:label}));mode.value=config.mode;
    const pac=el('input',{type:'url',value:config.pacUrl,placeholder:'https://work.example/proxy.pac'}),proxy=el('input',{type:'text',value:config.proxy,placeholder:'proxy.work.example:8080'}),domains=el('input',{type:'text',value:config.integratedDomains,placeholder:'portal.work.example, *.trusted.work.example'});
    const update=()=>{pac.disabled=mode.value!=='pac';proxy.disabled=mode.value!=='manual'};mode.addEventListener('change',update);update();
    body.append(field('Connection',mode),field('PAC URL',pac),field('Proxy host and port',proxy),field('Integrated Windows sign-in domains',domains,'Only listed domains may use your Windows sign-in automatically. Leave empty to ask for credentials. A global wildcard is not allowed.'));
    const apply=el('button',{className:'ghost',textContent:'Apply network settings'}),status=el('p',{className:'hint'});
    apply.addEventListener('click',()=>{apply.disabled=true;void window.nabsun.settings.set({browserNetwork:{mode:mode.value as 'system'|'direct'|'pac'|'manual',pacUrl:pac.value,proxy:proxy.value,integratedDomains:domains.value}}).then(next=>{this.settings=next;this.onChanged(next);status.textContent='Network settings saved.'},()=>{status.textContent='Could not apply these settings. Check the URL, host:port, and domain list.'}).finally(()=>apply.disabled=false)});
    body.append(apply,status);return details;
  }

  private browsingSection(s: Settings): HTMLElement {
    const set = el('fieldset');
    set.append(el('legend', { textContent: 'Browsing' }));

    const home = el('input', { type: 'text', value: s.homepage });
    home.addEventListener('change', () => void this.patch({ homepage: home.value.trim() }));
    set.append(field('Homepage', home));

    const engine = el('select');
    for (const name of ['duckduckgo', 'google', 'bing'] as const) {
      engine.append(el('option', { value: name, textContent: name, selected: s.searchEngine === name }));
    }
    engine.addEventListener('change', () => {
      void this.patch({ searchEngine: engine.value as Settings['searchEngine'] });
    });
    set.append(field('Search engine', engine));

    set.append(
      checkbox(
        'Block common trackers',
        s.blockAds,
        'Blocks requests to a small list of well-known ad and analytics hosts.',
        (v) => void this.patch({ blockAds: v }),
      ),
      checkbox(
        'Offer to save passwords',
        s.savePasswords,
        'Offers to save credentials typed into sign-in forms, and fills them back in on the same site. Stored encrypted with the OS keychain.',
        (v) => void this.patch({ savePasswords: v }),
      ),
      this.sitePermissionsField(),
      checkbox(
        'Show the bookmarks bar',
        s.bookmarksBarVisible,
        'The strip of bookmarks under the address bar (Ctrl+Shift+B).',
        (v) => {
          window.nabsun.data.toggleBookmarksBar(v);
          void this.patch({ bookmarksBarVisible: v });
        },
      ),
    );

    set.append(this.clearDataBlock());
    set.append(this.networkField(s));
    return set;
  }

  /** Chrome-style "clear browsing data", scoped by category. */
  private clearDataBlock(): HTMLElement {
    // Ctrl+Shift+Delete scrolls here, so it needs to be addressable.
    const wrap = el('div', { id: 'clear-data-block' });
    const boxes: Record<string, HTMLInputElement> = {};

    for (const [key, label] of [
      ['history', 'Browsing history'],
      ['cookies', 'Cookies and site data'],
      ['cache', 'Cached files'],
      ['passwords', 'Saved passwords'],
      ['bookmarks', 'Bookmarks'],
    ] as const) {
      const input = el('input', { type: 'checkbox', checked: key === 'history' });
      boxes[key] = input;
      wrap.append(el('label', { className: 'check' }, [input, el('span', { textContent: label })]));
    }

    const status = el('div', { className: 'hint' });
    const button = el('button', { className: 'ghost', textContent: 'Clear now' });
    let armed = false;

    button.addEventListener('click', async () => {
      const request = {
        history: boxes.history.checked,
        cookies: boxes.cookies.checked,
        cache: boxes.cache.checked,
        passwords: boxes.passwords.checked,
        bookmarks: boxes.bookmarks.checked,
      };
      if (!Object.values(request).some(Boolean)) {
        status.textContent = 'Nothing selected.';
        return;
      }
      // Two-step: this is not undoable.
      if (!armed) {
        armed = true;
        button.textContent = 'Click again to confirm';
        button.className = 'danger';
        setTimeout(() => {
          armed = false;
          button.textContent = 'Clear now';
          button.className = 'ghost';
        }, 4000);
        return;
      }
      await window.nabsun.data.clear(request);
      status.textContent = 'Cleared.';
      armed = false;
      button.textContent = 'Clear now';
      button.className = 'ghost';
    });

    return field(
      'Clear browsing data',
      el('div', {}, [wrap, el('div', { className: 'inline' }, [button]), status]),
      'Signing out of sites and losing saved passwords cannot be undone.',
    );
  }

  /* --------------------------------------------------------- integrations */

  private async integrationsSection(): Promise<HTMLElement> {
    const s = this.settings!;
    const set = el('fieldset');
    set.append(el('legend', { textContent: 'Integrations' }));
    const controls=s.integrationControls??{plugins:true,mcp:true,extensions:true};
    set.append(checkbox('Enable approved plugins',controls.plugins,'Disabling stops plugin hosts and blocks their tools.',value=>this.setIntegrationControl('plugins',value)),checkbox('Enable approved external MCP servers',controls.mcp,'Disabling closes their processes and blocks their tools.',value=>this.setIntegrationControl('mcp',value)),checkbox('Enable unpacked browser extensions',controls.extensions,'Disabling unloads extensions. Reload websites to remove scripts they already injected.',value=>this.setIntegrationControl('extensions',value)));

    const plugins = await window.nabsun.integrations.pluginStatus();
    const pluginList = el('div');
    if (!plugins.length) {
      pluginList.append(el('div', { className: 'hint', textContent: 'No plugins installed.' }));
    }
    for (const p of plugins) {
      const line = el('div', { className: 'status-line' }, [
        el('span', { className: `dot ${p.loaded ? 'on' : 'off'}` }),
        el('span', { textContent: `${p.name} ${p.version}` }),
        el('span', {
          className: 'muted',
          textContent: p.loaded ? `${p.toolNames.length} tool(s)` : (p.error ?? 'failed'),
        }),
      ]);
      pluginList.append(line);
      if(!p.approved&&p.fingerprint){const approve=el('button',{className:'ghost',textContent:'Review and approve'});approve.addEventListener('click',()=>{approve.disabled=true;void window.nabsun.integrations.pluginApprove(p.id,p.fingerprint!).then(()=>this.render()).catch(()=>{approve.disabled=false;approve.textContent='Could not approve. Reload and review again.'})});line.append(approve)}
      if(p.approved){const revoke=el('button',{className:'ghost',textContent:'Revoke approval'});revoke.addEventListener('click',()=>{revoke.disabled=true;void window.nabsun.integrations.pluginRevoke(p.id).then(()=>this.render()).catch(()=>{revoke.disabled=false;revoke.textContent='Could not revoke. Try again.'})});line.append(revoke)}
    }
    const pluginButtons = el('div', { className: 'inline' });
    const reloadPlugins = el('button', { className: 'ghost', textContent: 'Reload plugins' });
    reloadPlugins.addEventListener('click', async () => {
      await window.nabsun.integrations.pluginReload();
      await this.render();
    });
    const openFolder = el('button', { className: 'ghost', textContent: 'Open plugins folder' });
    openFolder.addEventListener('click', () => window.nabsun.integrations.openPluginFolder());
    pluginButtons.append(reloadPlugins, openFolder);

    set.append(
      field(
        'Plugins',
        el('div', {}, [pluginList, pluginButtons]),
        'Plugins need approval for their exact source. They run in a separate host with restricted filesystem access and can use the network and their own storage. Browser helpers use the shared approval gate. Changed source must be reviewed again.',
      ),
    );

    const mcpStatus = await window.nabsun.integrations.mcpStatus();
    const mcpList = el('div');
    for (const m of mcpStatus) {
      const line=el('div', { className: 'status-line' }, [
          el('span', { className: `dot ${m.connected ? 'on' : 'off'}` }),
          el('span', { textContent: m.name }),
          el('span', {
            className: 'muted',
            textContent: m.connected ? `${m.toolNames.length} tool(s)` : (m.error ?? 'not connected'),
          }),
        ]);mcpList.append(line);
      if(!m.approved&&m.fingerprint){const approve=el('button',{className:'ghost',textContent:'Review and approve'});approve.addEventListener('click',()=>{approve.disabled=true;void window.nabsun.integrations.mcpApprove(m.name,m.fingerprint!).then(()=>this.render()).catch(()=>{approve.disabled=false;approve.textContent='Could not approve. Reload and review again.'})});line.append(approve)}
      if(m.approved){const revoke=el('button',{className:'ghost',textContent:'Revoke approval'});revoke.addEventListener('click',()=>{revoke.disabled=true;void window.nabsun.integrations.mcpRevoke(m.name).then(()=>this.render()).catch(()=>{revoke.disabled=false;revoke.textContent='Could not revoke. Try again.'})});line.append(revoke)}
    }

    const mcpJson = el('textarea', { value: JSON.stringify(s.mcpServers, null, 2) });
    const saveMcp = el('button', { className: 'ghost', textContent: 'Save and reconnect' });
    const mcpError = el('div', { className: 'hint' });
    saveMcp.addEventListener('click', async () => {
      try {
        const parsed = JSON.parse(mcpJson.value || '{}') as Settings['mcpServers'];
        mcpError.textContent = 'Reconnecting…';
        await this.patch({ mcpServers: parsed });
        await window.nabsun.integrations.mcpReload();
        await this.render();
      } catch (err) {
        mcpError.textContent = `Could not parse: ${err instanceof Error ? err.message : String(err)}`;
      }
    });

    set.append(
      field(
        'MCP servers',
        el('div', {}, [mcpList, mcpJson, el('div', { className: 'inline' }, [saveMcp]), mcpError]),
        'Choose a locally installed server: {"tools":{"command":"node","args":["/absolute/path/to/server.js"],"enabled":true}}. Approve its source after saving. Dynamic package runners such as npx are not loaded.',
      ),
    );

    // The reverse direction: let an agent running elsewhere drive this browser.
    const bridge = await window.nabsun.config.bridge();
    const bridgeStatus = el('div', { className: 'status-line' }, [
      el('span', { className: `dot ${bridge.running ? 'on' : 'off'}` }),
      el('span', { textContent: bridge.running ? `Listening on ${bridge.url}` : 'Not running' }),
    ]);

    const snippet = el('textarea', { value: bridge.configJson, readOnly: true });
    const copyBtn = el('button', { className: 'ghost', textContent: 'Copy config' });
    const copied = el('span', { className: 'hint' });
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(bridge.configJson);
      copied.textContent = 'Copied. Paste it into your MCP client config.';
    });

    set.append(
      field(
        'Connect an external agent',
        el('div', {}, [bridgeStatus, snippet, el('div', { className: 'inline' }, [copyBtn]), copied]),
        'Point Claude Code, Codex or any MCP client at this to let it drive your browser — including the extensions in VS Code. The token changes each time Nabsun starts, and every call still asks you for approval.',
      ),
    );

    return set;
  }

  /* --------------------------------------------------------- personal context */

  /**
   * soul.md — what the assistant knows about the person using it.
   *
   * The path is shown rather than hidden behind a button because the honest
   * answer to "where does this live?" is a path on this machine, and seeing it
   * is the reassurance. The hint says what actually happens to the contents:
   * the file stays here, but it reaches whichever model is selected the same
   * way the rest of the conversation does. Promising more than that would be a
   * lie the app cannot keep.
   */
  private soulField(s: Settings): HTMLElement {
    const wrap = el('div', {});

    wrap.append(
      checkbox(
        'Tell the assistant about you',
        s.personalContext,
        'Reads soul.md and gives it to the assistant as background, so you are not introducing yourself every session.',
        (v) => void this.patch({ personalContext: v }),
      ),
    );

    const pathRow = el('div', { className: 'hint' });
    pathRow.append(el('strong', { textContent: 'File: ' }), document.createTextNode('…'));
    void window.nabsun.config.paths().then((paths) => {
      pathRow.textContent = '';
      pathRow.append(
        el('strong', { textContent: 'File: ' }),
        document.createTextNode(paths.soulFile),
      );
    });

    const openBtn = el('button', { className: 'ghost', textContent: 'Edit soul.md' });
    openBtn.addEventListener('click', () => window.nabsun.config.openSoul());

    wrap.append(
      checkbox(
        'Only share it with models on this machine',
        s.personalContextLocalOnly,
        'The built-in model and a local Ollama server see it. Cloud providers and signed-in CLIs do not.',
        (v) => void this.patch({ personalContextLocalOnly: v }),
      ),
    );

    // Say what is happening right now, for the provider actually selected.
    // A guarantee nobody can see the effect of is just a sentence.
    const onDevice = isOnDevice(s.provider, s.baseUrls);
    const sharing = !s.personalContext
      ? 'Switched off — the assistant is told nothing about you.'
      : s.personalContextLocalOnly && !onDevice
        ? `Withheld from ${s.provider}: it does not run on this machine. Untick the box above to send it anyway.`
        : `Shared with ${s.provider}${onDevice ? ', which runs on this machine' : ' — it leaves this machine with your turn'}.`;
    const status = el('div', { className: 'hint', textContent: sharing });

    const note = el('div', {
      className: 'hint',
      textContent:
        'Nothing uploads this file. With the box above ticked it only ever reaches a model running on your own hardware. Keep passwords, card numbers and one-time codes out of it regardless.',
    });

    wrap.append(
      field(
        'Personal context',
        el('div', {}, [pathRow, status, el('div', { className: 'inline' }, [openBtn]), note]),
      ),
    );
    return wrap;
  }

  /* -------------------------------------------------------------- advanced */

  private async advancedSection(): Promise<HTMLElement> {
    const set = el('fieldset');
    set.append(el('legend', { textContent: 'Configuration' }));

    const status = el('div', { className: 'hint' });
    const buttons = el('div', { className: 'inline' });

    const exportBtn = el('button', { className: 'ghost', textContent: 'Export…' });
    exportBtn.addEventListener('click', async () => {
      const res = await window.nabsun.config.export();
      if (res.cancelled) return;
      status.textContent = res.ok ? `Saved to ${res.path}` : `Export failed: ${res.error}`;
    });

    const importBtn = el('button', { className: 'ghost', textContent: 'Import…' });
    importBtn.addEventListener('click', async () => {
      const res = await window.nabsun.config.import();
      if (res.cancelled) return;
      if (res.ok) {
        status.textContent = `Imported from ${res.path}`;
        await this.render();
      } else {
        status.textContent = `Import failed: ${res.error}`;
      }
    });

    // Two-step, because this discards everything the user has configured.
    const resetBtn = el('button', { className: 'ghost', textContent: 'Reset to defaults' });
    let armed = false;
    resetBtn.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        resetBtn.textContent = 'Click again to confirm';
        resetBtn.className = 'danger';
        setTimeout(() => {
          armed = false;
          resetBtn.textContent = 'Reset to defaults';
          resetBtn.className = 'ghost';
        }, 4000);
        return;
      }
      try {
        await window.nabsun.config.reset();
        this.saveError = '';
        status.textContent = 'Settings restored to defaults. API keys were left untouched.';
        await this.render();
      } catch {
        status.textContent = 'Could not reset settings. Your previous settings are still active. Please try again.';
      }
    });

    buttons.append(exportBtn, importBtn, resetBtn);
    set.append(
      field(
        'Backup and restore',
        el('div', {}, [buttons, status]),
        'Exported files contain your settings but never your API keys.',
      ),
    );

    const paths = await window.nabsun.config.paths();
    const pathList = el('div');
    for (const [label, value] of [
      ['Config file', paths.configFile],
      ['Profile folder', paths.userData],
      ['Plugins', paths.pluginsDir],
      ['Chats', paths.sessionsDir],
      ['About you (soul.md)', paths.soulFile],
    ] as const) {
      const row = el('div', { className: 'hint' });
      row.append(el('strong', { textContent: `${label}: ` }), document.createTextNode(value));
      pathList.append(row);
    }
    const openBtn = el('button', { className: 'ghost', textContent: 'Open profile folder' });
    openBtn.addEventListener('click', () => window.nabsun.config.openFolder());

    set.append(field('Where things live', el('div', {}, [pathList, el('div', { className: 'inline' }, [openBtn])])));

    const aboutBtn = el('button', { className: 'ghost', textContent: 'About Nabsun' });
    aboutBtn.addEventListener('click', () => void window.nabsun.tabs.create('nabsun://about'));
    set.append(field('About', aboutBtn, 'Version, engine details and where your data is stored.'));

    return set;
  }
}
