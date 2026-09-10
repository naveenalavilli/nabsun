import type { AgentExtension, ExtensionStatus } from '../../shared/types';

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

  constructor(private readonly onProviderChanged: () => void) {
    window.nabsun.extensions.onChanged((items) => {
      this.browserExts = items;
      if (this.root.offsetParent !== null) this.paint();
    });
  }

  async render(): Promise<void> {
    this.agents = await window.nabsun.agentExtensions.list();
    this.browserExts = await window.nabsun.extensions.list();
    this.paint();
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
          'The backend the sidebar assistant runs on. CLI ones use the login you already have in that tool — no API key is kept here.',
      }),
    );

    for (const agent of this.agents) {
      set.append(this.agentCard(agent));
    }
    return set;
  }

  private agentCard(agent: AgentExtension): HTMLElement {
    const card = el('div', { className: `ext-card${agent.active ? ' active' : ''}` });

    const head = el('div', { className: 'ext-head' });
    const icon = el('div', { className: 'ext-icon', textContent: agent.name.charAt(0) });
    const titles = el('div', { className: 'ext-titles' });
    titles.append(
      el('div', { className: 'ext-name', textContent: agent.name }),
      el('div', { className: 'ext-pub', textContent: `${agent.publisher} · ${agent.kind.toUpperCase()}` }),
    );
    head.append(icon, titles);

    if (agent.active) {
      head.append(el('span', { className: 'ext-badge on', textContent: 'Active' }));
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
    if (agent.kind === 'cli' && agent.installed) card.append(this.accountBlock(agent));

    const actions = el('div', { className: 'inline' });

    if (agent.installed) {
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

  /**
   * Sign-in lives with the CLI, not with us — we never see the credentials.
   * Connecting runs that tool's own login command and shows what it prints,
   * which is how the device-code flow becomes usable from inside the browser.
   */
  private accountBlock(agent: AgentExtension): HTMLElement {
    const box = el('div', { className: 'ext-account' });
    const status = el('div', { className: 'status-line' }, [
      el('span', { className: 'dot' }),
      el('span', { className: 'muted', textContent: 'Checking account…' }),
    ]);

    // Where the sign-in URL and device code surface once the CLI prints them.
    const signin = el('div', { className: 'ext-signin' });
    signin.hidden = true;

    const output = el('pre', { className: 'ext-output' });
    output.hidden = true;
    const actions = el('div', { className: 'inline' });
    box.append(status, signin, output, actions);

    const setStatus = (connected: boolean | null, text: string) => {
      const dot = status.querySelector('.dot')!;
      dot.className = `dot ${connected === null ? '' : connected ? 'on' : 'off'}`;
      status.querySelector('.muted')!.textContent = text;
    };

    const refresh = async () => {
      const acct = await window.nabsun.accounts.status(agent.id);
      if (!acct.supported) {
        setStatus(null, acct.detail);
        actions.textContent = '';
        return;
      }
      setStatus(acct.connected, acct.connected ? `Connected — ${acct.detail}` : acct.detail);
      actions.textContent = '';

      if (acct.connected) {
        const disconnect = el('button', { className: 'ghost', textContent: 'Disconnect account' });
        disconnect.addEventListener('click', async () => {
          disconnect.disabled = true;
          const res = await window.nabsun.accounts.disconnect(agent.id);
          if (!res.ok) setStatus(false, res.error ?? 'Sign-out failed');
          await refresh();
        });
        actions.append(disconnect);
      } else {
        const begin = (mode: 'browser' | 'device', note: string) => {
          signin.hidden = true;
          signin.textContent = '';
          output.hidden = false;
          output.textContent = `${note}\n`;
          window.nabsun.accounts.connect(agent.id, mode);
        };

        const connect = el('button', { className: 'primary', textContent: `Sign in to ${agent.publisher}` });
        connect.addEventListener('click', () => begin('browser', 'Starting sign-in…'));

        // The device flow prints a code and a URL, which we can present far
        // better than a terminal can.
        const device = el('button', { className: 'ghost', textContent: 'Sign in with a code' });
        device.addEventListener('click', () => begin('device', 'Requesting a sign-in code…'));

        const withKey = el('button', { className: 'ghost', textContent: 'Use an API key' });
        withKey.addEventListener('click', () => {
          const key = prompt(`Paste an API key for ${agent.name}. It is sent to the CLI, not stored here.`);
          if (!key) return;
          output.hidden = false;
          output.textContent = 'Signing in with the key…\n';
          window.nabsun.accounts.connect(agent.id, 'apiKey', key);
        });

        actions.append(connect, device, withKey);
      }
    };

    window.nabsun.accounts.onEvent((event) => {
      if (event.provider !== agent.id) return;

      // A device code the user has to type on the sign-in page.
      if (event.code) {
        signin.hidden = false;
        const codeRow = el('div', { className: 'signin-code' });
        const value = el('code', { textContent: event.code });
        const copy = el('button', { className: 'ghost', textContent: 'Copy code' });
        copy.addEventListener('click', async () => {
          await navigator.clipboard.writeText(event.code!);
          copy.textContent = 'Copied';
        });
        codeRow.append(el('span', { textContent: 'Enter this code:' }), value, copy);
        signin.append(codeRow);
      }

      // This is a browser, so sign in here rather than handing the user off to
      // whatever their default browser happens to be. The CLI's callback is a
      // local server, so it does not care which browser completes the flow.
      if (event.url) {
        signin.hidden = false;
        const open = el('button', { className: 'primary', textContent: 'Open the sign-in page' });
        const openTab = () => void window.nabsun.tabs.create(event.url!);
        open.addEventListener('click', openTab);

        const link = el('div', { className: 'signin-url', textContent: event.url });
        signin.append(el('div', { className: 'inline' }, [open]), link);
        openTab();
      }

      if (event.chunk) {
        output.hidden = false;
        output.textContent += event.chunk;
        output.scrollTop = output.scrollHeight;
      }
      if (event.done) {
        if (event.error) output.textContent += `\n${event.error}\n`;
        if (event.ok) {
          signin.hidden = true;
          signin.textContent = '';
        }
        void refresh();
      }
    });

    void refresh();
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
