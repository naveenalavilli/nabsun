import type { AgentExtension, ProviderId, Settings } from '../../shared/types';
import { spawnSync } from 'node:child_process';
import type { Provider } from '../ai/provider';
import { launcherEnv, type Launcher } from '../ai/providers/cli';
import type { SecretStore } from '../store';

/**
 * The catalogue behind the Extensions panel.
 *
 * AI backends are presented as things you *add*, not settings you configure,
 * because that is how they actually behave: Codex and Claude Code are separate
 * programs you install and sign into once, after which the browser drives them.
 * Adding one here makes it the assistant's backend; the browser hands it the
 * page tools over MCP and never sees its credentials.
 */
const CATALOG: Omit<AgentExtension, 'installed' | 'active' | 'detail'>[] = [
  {
    id: 'codex-cli',
    name: 'Codex',
    publisher: 'OpenAI',
    kind: 'cli',
    summary:
      'Runs the Codex CLI as the assistant, using the account you are already signed into there. No API key is stored in the browser.',
    capabilities: [
      'Uses your existing Codex login (ChatGPT plan or API key)',
      'Gets this browser as an MCP tool server â€” read pages, click, type, extract',
      'Its own shell tools stay sandboxed read-only',
      'Every page action still goes through the approval gate',
    ],
    installCommand: 'npm install -g @openai/codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
  },
  {
    id: 'claude-cli',
    name: 'Claude Code',
    publisher: 'Anthropic',
    kind: 'cli',
    summary:
      'Runs the Claude Code CLI as the assistant, using the login you already have there. No API key is stored in the browser.',
    capabilities: [
      'Uses your existing Claude Code login (subscription or API key)',
      'Gets this browser as an MCP tool server',
      'Its file and shell tools stay disabled',
      'Every page action still goes through the approval gate',
    ],
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://code.claude.com/docs',
  },
  {
    id: 'anthropic',
    name: 'Claude API',
    publisher: 'Anthropic',
    kind: 'api',
    summary:
      'Talks to the Claude API directly with a key you provide. The browser runs the agent loop itself.',
    capabilities: [
      'Claude Opus 5 and the rest of the Claude family',
      'Streaming, adaptive thinking, prompt caching',
      'Key encrypted with the OS keychain',
    ],
    docsUrl: 'https://console.anthropic.com',
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    publisher: 'OpenAI',
    kind: 'api',
    summary:
      'Talks to the OpenAI API (or any OpenAI-compatible endpoint) with a key you provide.',
    capabilities: [
      'GPT-5.1 and other chat-completions models',
      'Works against any OpenAI-compatible base URL',
      'Key encrypted with the OS keychain',
    ],
    docsUrl: 'https://platform.openai.com',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    publisher: 'Ollama',
    kind: 'local',
    summary: 'Runs a model locally through Ollama. Nothing leaves the machine, and no key is needed.',
    capabilities: ['Local models, no account', 'Tool calling on models that support it'],
    installCommand: 'Download from https://ollama.com, then: ollama pull llama3.1',
    docsUrl: 'https://ollama.com',
  },
];

/**
 * Cached `--version` output. A stale CLI is a common and confusing failure â€”
 * an old Codex is rejected outright by newer accounts â€” so the panel shows the
 * version rather than leaving the user to guess.
 */
const versionCache = new Map<ProviderId, { value: string | null; at: number }>();
const VERSION_TTL_MS = 60_000;

function cliVersion(id: ProviderId, provider: Provider | undefined): string | null {
  const cached = versionCache.get(id);
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.value;

  let value: string | null = null;
  const launcher = (provider as { launcher?: Launcher | null } | undefined)?.launcher;
  if (launcher) {
    try {
      const res = spawnSync(launcher.command, [...launcher.args, '--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        env: {
          ...process.env,
          ...launcherEnv(launcher),
        },
      });
      const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      value = /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
    } catch {
      value = null;
    }
  }
  versionCache.set(id, { value, at: Date.now() });
  return value;
}

export function listAgentExtensions(
  settings: Settings,
  providers: Map<ProviderId, Provider>,
  secrets: SecretStore,
): AgentExtension[] {
  return CATALOG.map((entry) => {
    const provider = providers.get(entry.id);
    let installed = false;
    let detail: string | undefined;

    if (entry.kind === 'cli') {
      // "Installed" means the binary is actually on this machine.
      const binary = provider?.binaryPath ?? null;
      installed = Boolean(binary);
      const version = binary ? cliVersion(entry.id, provider) : null;
      detail = binary ? (version ? `${version} â€” ${binary}` : binary) : 'Not found on PATH';
    } else if (entry.kind === 'local') {
      installed = true;
      detail = settings.baseUrls.ollama;
    } else {
      installed = secrets.has(entry.id);
      detail = installed ? 'API key stored' : 'No API key yet';
    }

    return {
      ...entry,
      installed,
      active: settings.provider === entry.id,
      detail,
    };
  });
}

