import type { AgentExtension, ProviderId, Settings } from '../../shared/types';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { stopCliProcess } from './nativeCli';
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
      'Connect your OpenAI account to use Codex in Nabsun. Setup is automatic; no terminal commands needed.',
    capabilities: [
      'Sign in with your ChatGPT account',
      'Read pages, click, type, and extract information',
      'Browser actions follow your approval settings',
    ],
    docsUrl: 'https://developers.openai.com/codex/cli',
  },
  {
    id: 'claude-cli',
    name: 'Claude Code',
    publisher: 'Anthropic',
    kind: 'cli',
    summary:
      'Connect your Anthropic account to use Claude Code in Nabsun. Setup is automatic; no terminal commands needed.',
    capabilities: [
      'Sign in with your Claude account',
      'Read pages, click, type, and extract information',
      'Browser actions follow your approval settings',
    ],
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
const versionCache = new Map<ProviderId, { key: string; value: Promise<string | null>; at: number }>();
const VERSION_TTL_MS = 60_000;

function cliVersion(id: ProviderId, provider: Provider | undefined): Promise<string | null> {
  const launcher = (provider as { launcher?: Launcher | null } | undefined)?.launcher;
  if (!launcher) return Promise.resolve(null);
  const key = JSON.stringify(launcher);
  const cached = versionCache.get(id);
  if (cached?.key === key && Date.now() - cached.at < VERSION_TTL_MS) return cached.value;
  const value = new Promise<string | null>(resolve => {
    const child = spawn(launcher.command, [...launcher.args, '--version'], {
      cwd: os.tmpdir(), windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, ...launcherEnv(launcher) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    const timer = setTimeout(() => stopCliProcess(child), 5000);
    const finish = (ok: boolean) => { clearTimeout(timer); resolve(ok ? /([0-9]+\.[0-9]+\.[0-9]+)/.exec(text)?.[1] ?? null : null); };
    const collect = (chunk: Buffer) => { text = (text + chunk.toString('utf8')).slice(-2048); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', () => finish(false));
    child.on('close', code => finish(code === 0));
  }).catch(() => null);
  versionCache.set(id, { key, value, at: Date.now() });
  return value;
}

export async function listAgentExtensions(
  settings: Settings,
  providers: Map<ProviderId, Provider>,
  secrets: SecretStore,
): Promise<AgentExtension[]> {
  return Promise.all(CATALOG.map(async (entry) => {
    const provider = providers.get(entry.id);
    let installed = false;
    let detail: string | undefined;

    if (entry.kind === 'cli') {
      // "Installed" means the binary is actually on this machine.
      const binary = provider?.binaryPath ?? null;
      installed = Boolean(binary);
      const version = binary ? await cliVersion(entry.id, provider) : null;
      detail = binary ? (version ? `Version ${version}` : 'Ready on this device') : 'Set up automatically when you connect';
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
  }));
}

