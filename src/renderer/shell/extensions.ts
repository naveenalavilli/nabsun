import type { AccountStatus, AgentExtension, ExtensionStatus, ProviderId } from '../../shared/types';

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

/**
 * The Extensions panel.
 *
 * Two lists, because there are genuinely two kinds. Assistants are backends you
 * add and switch between — Codex and Claude Code among them. Browser extensions
 * are Chrome-compatible packages loaded unpacked from a folder.
 */
export class ExtensionsView {
  private root = document.querySelector<HTMLElement>('#extensions-body')!;
  private agents: AgentExtension[] = [];
  private browserExts: ExtensionStatus[] = [];
  private accounts = new Map<ProviderId, AccountStatus>();
  private accountErrors = new Map<ProviderId, string>();
  private connections = new Map<ProviderId, { busy: boolean; signingOut?: boolean; message: string; url?: string; code?: string; error?: string }>();
  private generation = 0;

  constructor(private readonly onProviderChanged: () => void) {
    // Subscribe once: repainting must not open duplicate sign-in tabs.
    window.nabsun.accounts.onEvent(event => {
      const state = this.connections.get(event.provider) ?? { busy: true, message: '' };
      if (event.message) state.message = event.message;
      if (event.error) state.error = event.error;
      if (event.code) state.code = event.code;
      if (event.url && event.url !== state.url) {
        state.url = event.url;
        void this.openSignIn(event.provider, event.url);
      }
      if (event.done) {
        state.busy = false;
        state.url = undefined;
        state.code = undefined;
        if (event.ok) {
          state.error = undefined;
          state.message = '';
          this.accounts.set(event.provider, { provider: event.provider, supported: true, connected: true, detail: 'Connected' });
          this.onProviderChanged();
        }
        void this.render();
      }
      this.connections.set(event.provider, state);
      this.paint();
    });
    window.nabsun.extensions.onChanged((items) => {
      this.browserExts = items;
      if (this.root.offsetParent !== null) this.paint();
    });
  }

  async render(): Promise<void> {
    const generation = ++this.generation;
    let agents: AgentExtension[], extensions: ExtensionStatus[];
    try {
      [agents, extensions] = await Promise.all([
        window.nabsun.agentExtensions.list(), window.nabsun.extensions.list(),
      ]);
    } catch {
      if (generation !== this.generation) return;
      this.root.textContent = 'Could not load extensions. ';
      const retry = el('button', { textContent: 'Try again' });
      retry.addEventListener('click', () => void this.render());
      this.root.append(retry);
      return;
    }
    if (generation !== this.generation) return;
    this.agents = agents;
    this.browserExts = extensions;
    this.paint();
    // A slow or broken CLI must not hide the other assistant or the whole panel.
    await Promise.all((['codex-cli', 'claude-cli'] as const).map(async id => {
      let status: AccountStatus;
      let error: string | undefined;
      try { status = await window.nabsun.accounts.status(id); }
      catch {
        error = 'Could not check this account. Try connecting again.';
        status = { provider: id, supported: true, connected: false, detail: error };
      }
      if (generation !== this.generation) return;
      if (error) this.accountErrors.set(id, error); else this.accountErrors.delete(id);
      this.accounts.set(id, status);
      this.paint();
    }));
  }

  private async openSignIn(id: ProviderId, url: string): Promise<void> {
    try {
      await window.nabsun.tabs.create(url);
      const state = this.connections.get(id);
      if (state?.url === url && state.error?.startsWith('Could not open sign-in.')) {
        state.error = undefined;
        this.paint();
      }
    }
    catch {
      const state = this.connections.get(id);
      if (state?.busy && state.url === url) {
        state.error = 'Could not open sign-in. Use Open sign-in page to try again.';
        this.paint();
      }
    }
  }

  private paint() {
    this.root.textContent = '';
    this.root.append(this.assistantsSection(), this.browserSection());
  }

  /* ------------------------------------------------------ AI assistants -- */

  private assistantsSection(): HTMLElement {
    const set = el('fieldset');
    set.append(el('legend', { textContent: 'Assistants' }));
    set.append(
      el('div', {
        className: 'hint',
        textContent:
          'Choose an assistant and connect your account. Nabsun handles Codex and Claude setup for you.',
      }),
    );

    for (const agent of this.agents) {
      set.append(this.agentCard(agent));
    }
    return set;
  }

  private agentCard(agent: AgentExtension): HTMLElement {
    const connected = this.accounts.get(agent.id)?.connected ?? false;
    const active = agent.active && (agent.kind !== 'cli' || connected);
    const card = el('div', { className: `ext-card${active ? ' active' : ''}` });

    const head = el('div', { className: 'ext-head' });
    const icon = el('div', { className: 'ext-icon', textContent: agent.name.charAt(0) });
    const titles = el('div', { className: 'ext-titles' });
    titles.append(
      el('div', { className: 'ext-name', textContent: agent.name }),
      el('div', { className: 'ext-pub', textContent: `${agent.publisher} · ${agent.kind.toUpperCase()}` }),
    );
    head.append(icon, titles);

    if (active) {
      head.append(el('span', { className: 'ext-badge on', textContent: 'Active' }));
    } else if (connected) {
      head.append(el('span', { className: 'ext-badge on', textContent: 'Connected' }));
    } else if (agent.installed) {
      head.append(el('span', { className: 'ext-badge', textContent: 'Installed' }));
    }
    card.append(head);

    card.append(el('div', { className: 'ext-summary', textContent: agent.summary }));

    const caps = el('ul', { className: 'ext-caps' });
    for (const c of agent.capabilities) caps.append(el('li', { textContent: c }));
    card.append(caps);

    const status = el('div', { className: 'status-line' }, [
      el('span', { className: `dot ${agent.installed ? 'on' : 'off'}` }),
      el('span', { className: 'muted', textContent: agent.detail ?? '' }),
    ]);
    card.append(status);

    // Account connect/disconnect, for CLI backends that expose it.
    if (agent.kind === 'cli') card.append(this.accountBlock(agent));

    const actions = el('div', { className: 'inline' });

    if (agent.installed && agent.kind !== 'cli') {
      if (!agent.active) {
        const use = el('button', { className: 'primary', textContent: 'Use this assistant' });
        use.addEventListener('click', async () => {
          this.agents = await window.nabsun.agentExtensions.activate(agent.id);
          this.onProviderChanged();
          this.paint();
        });
        actions.append(use);
      }
    } else if (agent.installCommand) {
      // Not installed: show the command, because we cannot install it for them.
      const cmd = el('code', { className: 'ext-cmd', textContent: agent.installCommand });
      const copy = el('button', { className: 'ghost', textContent: 'Copy command' });
      copy.addEventListener('click', () => void navigator.clipboard.writeText(agent.installCommand!));
      const recheck = el('button', { className: 'ghost', textContent: 'Check again' });
      recheck.addEventListener('click', () => void this.render());
      card.append(el('div', { className: 'ext-install' }, [cmd]));
      actions.append(copy, recheck);
    }

    if (agent.kind === 'api' && !agent.installed) {
      const openSettings = el('button', { className: 'ghost', textContent: 'Add API key' });
      openSettings.addEventListener('click', () => {
        document.querySelector<HTMLElement>('#settings-btn')?.click();
      });
      actions.append(openSettings);
    }

    if (agent.docsUrl) {
      const docs = el('button', { className: 'ghost', textContent: 'Docs' });
      docs.addEventListener('click', () => void window.nabsun.tabs.create(agent.docsUrl!));
      actions.append(docs);
    }

    if (actions.childElementCount) card.append(actions);
    return card;
  }

  /* ----------------------------------------------------------- accounts -- */

  private accountBlock(agent: AgentExtension): HTMLElement {
    const box = el('div', { className: 'ext-account' });
    const state = this.connections.get(agent.id);
    const connected = this.accounts.get(agent.id)?.connected ?? false;
    const busy = state?.busy ?? false;
    const text = state?.error || this.accountErrors.get(agent.id) || (busy ? state?.message : connected ? 'Connected' : state?.message)
      || this.accounts.get(agent.id)?.detail || 'Connect to get started';
    box.append(el('div', { className: 'status-line', role: 'status', ariaLive: 'polite' }, [
      el('span', { className: 'dot ' + (connected ? 'on' : 'off') }), el('span', { textContent: text }),
    ]));
    const actions = el('div', { className: 'inline' });
    if (busy) {
      const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
      cancel.addEventListener('click', () => window.nabsun.accounts.cancel(agent.id));
      actions.append(el('button', { className: 'primary', disabled: true, textContent: state?.signingOut ? 'Signing out...' : 'Connecting...' }));
      if (!state?.signingOut) actions.append(cancel);
      if (state?.url) {
        const open = el('button', { className: 'ghost', textContent: 'Open sign-in page' });
        open.addEventListener('click', () => void this.openSignIn(agent.id, state.url!));
        actions.append(open);
      }
      if (state?.code) box.append(el('div', { className: 'signin-code', textContent: 'Enter this code: ' + state.code }));
    } else {
      const repair = el('button', { className: 'ghost', textContent: 'Repair / update', title: 'Install the latest official CLI and use it for this assistant.' });
      repair.addEventListener('click', () => {
        ++this.generation;
        this.accountErrors.delete(agent.id);
        this.connections.set(agent.id, { busy: true, message: 'Updating your assistant...' });
        this.paint();
        window.nabsun.accounts.connect(agent.id, 'repair');
      });
      actions.append(repair);
      if (!connected || !agent.active) {
        const connect = el('button', {
          className: 'primary',
          textContent: connected ? 'Use ' + agent.name : state?.error ? 'Retry connection' : 'Connect ' + agent.name,
        });
        connect.addEventListener('click', () => {
          ++this.generation;
          this.accountErrors.delete(agent.id);
          this.connections.set(agent.id, { busy: true, message: 'Preparing your connection...' });
          this.paint();
          window.nabsun.accounts.connect(agent.id, 'browser');
        });
        actions.append(connect);
      }
      if (connected) {
        const disconnect = el('button', { className: 'ghost', textContent: 'Sign out', title: 'Signs the CLI out on this device, including other apps that use it.' });
        disconnect.addEventListener('click', async () => {
          ++this.generation;
          this.connections.set(agent.id, { busy: true, signingOut: true, message: 'Signing out...' });
          this.paint();
          try {
            const result = await window.nabsun.accounts.disconnect(agent.id);
            this.connections.set(agent.id, { busy: false, message: result.ok ? 'Signed out' : '', error: result.error });
          } catch { this.connections.set(agent.id, { busy: false, message: '', error: 'Sign-out failed. Try again.' }); }
          await this.render();
        });
        actions.append(disconnect);
      }
    }
    box.append(actions);
    if (!connected && !busy) box.append(el('div', {
      className: 'hint', textContent: 'Downloads the official native CLI if needed. Your account must include access to this assistant.',
    }));
    return box;
  }

  /* -------------------------------------------------- browser extensions -- */

  private browserSection(): HTMLElement {
    const set = el('fieldset');
    set.append(el('legend', { textContent: 'Browser extensions' }));

    const add = el('button', { className: 'primary', textContent: 'Load unpacked extension…' });
    const feedback = el('div', { className: 'hint' });
    add.addEventListener('click', async () => {
      const res = await window.nabsun.extensions.add();
      if (res.cancelled) return;
      feedback.textContent = res.ok
        ? `Added ${res.name}.`
        : `Could not add it: ${res.error}`;
      await this.render();
    });

    const reload = el('button', { className: 'ghost', textContent: 'Reload all' });
    reload.addEventListener('click', async () => {
      this.browserExts = await window.nabsun.extensions.reload();
      this.paint();
    });

    set.append(
      el('div', { className: 'inline' }, [add, reload]),
      feedback,
      el('div', {
        className: 'hint',
        textContent:
          'Chrome-compatible extensions, loaded from a folder containing manifest.json. Electron implements a subset of the Chrome APIs: content scripts, storage, runtime, much of tabs and webRequest. There is no Web Store install flow.',
      }),
    );

    if (!this.browserExts.length) {
      set.append(el('div', { className: 'hint', textContent: 'No extensions added yet.' }));
      return set;
    }

    for (const ext of this.browserExts) set.append(this.browserCard(ext));
    return set;
  }

  private browserCard(ext: ExtensionStatus): HTMLElement {
    const card = el('div', { className: 'ext-card' });

    const head = el('div', { className: 'ext-head' });
    if (ext.iconDataUrl) {
      head.append(el('img', { className: 'ext-icon-img', src: ext.iconDataUrl, alt: '' }));
    } else {
      head.append(el('div', { className: 'ext-icon', textContent: ext.name.charAt(0).toUpperCase() }));
    }

    const titles = el('div', { className: 'ext-titles' });
    titles.append(
      el('div', { className: 'ext-name', textContent: ext.name }),
      el('div', {
        className: 'ext-pub',
        textContent: [ext.version && `v${ext.version}`, ext.manifestVersion && `MV${ext.manifestVersion}`]
          .filter(Boolean)
          .join(' · '),
      }),
    );
    head.append(titles);

    const toggle = el('input', { type: 'checkbox', checked: ext.enabled });
    toggle.addEventListener('change', async () => {
      this.browserExts = await window.nabsun.extensions.setEnabled(ext.path, toggle.checked);
      this.paint();
    });
    head.append(toggle);
    card.append(head);

    if (ext.description) {
      card.append(el('div', { className: 'ext-summary', textContent: ext.description }));
    }

    card.append(
      el('div', { className: 'status-line' }, [
        el('span', { className: `dot ${ext.loaded ? 'on' : ext.enabled ? 'off' : ''}` }),
        el('span', {
          className: 'muted',
          textContent: ext.loaded
            ? `Loaded${ext.hasAction ? ' · has a toolbar button' : ''}`
            : ext.enabled
              ? (ext.error ?? 'Failed to load')
              : 'Disabled',
        }),
      ]),
    );

    card.append(el('div', { className: 'hint ext-path', textContent: ext.path }));

    const actions = el('div', { className: 'inline' });
    const folder = el('button', { className: 'ghost', textContent: 'Open folder' });
    folder.addEventListener('click', () => window.nabsun.extensions.openFolder(ext.path));
    const remove = el('button', { className: 'ghost', textContent: 'Remove' });
    remove.addEventListener('click', async () => {
      this.browserExts = await window.nabsun.extensions.remove(ext.path);
      this.paint();
    });
    actions.append(folder, remove);
    card.append(actions);

    return card;
  }
}
