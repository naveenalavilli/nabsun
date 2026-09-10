import type { ProviderId, ProviderStatus, Settings } from '../../shared/types';

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

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', { className: 'field' });
  wrap.append(el('label', { textContent: label }), control);
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
  input.addEventListener('change', () => onChange(input.checked));
  const text = el('div', {}, [el('span', { textContent: label })]);
  if (hint) text.append(el('div', { className: 'hint', textContent: hint }));
  return el('div', { className: 'check' }, [input, text]);
}

export class SettingsView {
  private root = document.querySelector<HTMLElement>('#settings-body')!;
  private settings: Settings | null = null;
  private credentials: ProviderStatus[] = [];
  /**
   * What happened to the last credential save, per provider.
   *
   * A failed or session-only save has to outlive the redraw that follows it,
   * or the UI shows "Key stored" for a key that reached nothing.
   */
  private saveOutcomes = new Map<string, { message: string; sessionOnly: boolean }>();

  constructor(private readonly onChanged: (s: Settings) => void) {}

  async render(): Promise<void> {
    this.settings = await window.nabsun.settings.get();
    this.credentials = await window.nabsun.settings.credentialStatus();
    this.paint();
  }

  private async patch(patch: Partial<Settings>) {
    this.settings = await window.nabsun.settings.set(patch);
    this.onChanged(this.settings);
  }

  private paint() {
    const s = this.settings;
    if (!s) return;
    this.root.textContent = '';
    this.root.append(this.modelSection(s), this.behaviourSection(s), this.browsingSection(s));
    void this.integrationsSection().then((node) => {
      this.root.append(node);
      void this.advancedSection().then((adv) => this.root.append(adv));
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
    set.append(field('Provider', providerSelect));

    const current = this.credentials.find((c) => c.id === s.provider);

    // A CLI backend runs its own agent loop under its own login, so the model
    // and key controls below do not apply to it.
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

      const modelInput = el('input', {
        type: 'text',
        value: s.models[current.id] ?? '',
        placeholder: "Leave blank to use the CLI's own default",
      });
      modelInput.addEventListener('change', () => {
        void this.patch({ models: { ...s.models, [current.id]: modelInput.value.trim() } });
      });

      set.append(
        field(
          'Status',
          status,
          current.hasCredentials
            ? 'Nabsun runs this CLI for each request, so it uses the login you already have there. No API key is stored here.'
            : `Install it and sign in, then reopen this panel. ${
                current.id === 'claude-cli'
                  ? 'npm i -g @anthropic-ai/claude-code'
                  : 'npm i -g @openai/codex'
              }`,
        ),
        field('Executable path', pathInput, 'Only needed when the CLI is not on your PATH.'),
        field('Model override', modelInput),
      );

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
            ? 'Runs on this machine: your prompts and page content are not sent to any model provider. The browser itself still uses the network for browsing, search and integrations.'
            : 'The weights are not on disk yet. Run `npm run fetch:model` in the source tree, or point the fields below at a llama-server and a .gguf file you already have.',
        ),
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
        field(
          'When to switch',
          el('div', {
            className: 'hint',
            textContent:
              'A 1.7B model handles routine navigation well and costs nothing to run. For long multi-step research or careful reasoning, switch the provider above to a larger model — your settings for it are kept.',
          }),
        ),
      );
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
    set.append(
      checkbox(
        'Run read-only actions automatically',
        s.autoApprove.safe,
        'Reading pages, searching, extracting data. Nothing is changed.',
        (v) => void this.patch({ autoApprove: { ...s.autoApprove, safe: v } }),
      ),
      checkbox(
        'Autopilot — run page actions without asking',
        s.autoApprove.write,
        'Clicking, typing, navigating, opening and closing tabs. The assistant is still told to pause before anything irreversible.',
        (v) => void this.patch({ autoApprove: { ...s.autoApprove, write: v } }),
      ),
      checkbox(
        'Run high-risk actions without asking',
        s.autoApprove.dangerous,
        'Includes executing arbitrary JavaScript in a page. Leave this off unless you know you want it.',
        (v) => void this.patch({ autoApprove: { ...s.autoApprove, dangerous: v } }),
      ),
    );

    if (s.alwaysAllowTools.length) {
      const reset = el('button', {
        className: 'ghost',
        textContent: `Forget ${s.alwaysAllowTools.length} always-allowed tool(s)`,
      });
      reset.addEventListener('click', () => void this.patch({ alwaysAllowTools: [] }));
      set.append(
        field('Always-allowed tools', reset, s.alwaysAllowTools.join(', ')),
      );
    }

    return set;
  }

  /* ------------------------------------------------------------- browsing */

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
      wrap.append(el('div', { className: 'check' }, [input, el('span', { textContent: label })]));
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
        'Each plugin is a folder with plugin.json and a CommonJS module exporting activate(api). Plugins run with full privileges — install only ones you trust.',
      ),
    );

    const mcpStatus = await window.nabsun.integrations.mcpStatus();
    const mcpList = el('div');
    for (const m of mcpStatus) {
      mcpList.append(
        el('div', { className: 'status-line' }, [
          el('span', { className: `dot ${m.connected ? 'on' : 'off'}` }),
          el('span', { textContent: m.name }),
          el('span', {
            className: 'muted',
            textContent: m.connected ? `${m.toolNames.length} tool(s)` : (m.error ?? 'not connected'),
          }),
        ]),
      );
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
        'Example: {"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","C:\\\\work"],"enabled":true}}',
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
      await window.nabsun.config.reset();
      status.textContent = 'Settings restored to defaults. API keys were left untouched.';
      await this.render();
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
