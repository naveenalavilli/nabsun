import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import type { PluginManifest, PluginStatus, RiskLevel } from '../../shared/types';
import { defineTool, type Tool, type ToolContext } from '../ai/tools/types';

/** The surface a plugin sees. Deliberately narrow — this is the plugin ABI. */
export interface PluginApi {
  readonly id: string;
  readonly version: string;
  registerTool(spec: {
    name: string;
    description: string;
    risk?: RiskLevel;
    parameters?: Record<string, unknown>;
    required?: string[];
    handler: (input: Record<string, unknown>, page: PagePluginContext) => Promise<unknown> | unknown;
  }): void;
  registerCommand(spec: { id: string; title: string; run: () => Promise<void> | void }): void;
  log(...args: unknown[]): void;
  storagePath: string;
}

/** What a plugin tool can do with the browser, without handing it the internals. */
export interface PagePluginContext {
  url(): string;
  title(): string;
  navigate(url: string): Promise<void>;
  readText(selector?: string): Promise<string>;
  snapshot(): Promise<string>;
  evaluate<T>(expression: string): Promise<T>;
  openTab(url: string, background?: boolean): Promise<string>;
  status(message: string): void;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  tools: Tool[];
  commands: { id: string; title: string; run: () => Promise<void> | void }[];
  error?: string;
}

const SAMPLE_PLUGIN_ID = 'example-page-stats';

/**
 * Extension host. Plugins are plain CommonJS modules loaded into the privileged
 * process — the same trust model as VS Code extensions: full capability, so
 * only install ones you trust.
 */
export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();

  constructor(private readonly rootDir: string) {}

  get directory(): string {
    return this.rootDir;
  }

  reload(): void {
    this.plugins.clear();
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.ensureSamplePlugin();

    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.rootDir, entry.name);
      try {
        this.load(dir);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[plugins] ${entry.name} failed:`, message);
        this.plugins.set(entry.name, {
          manifest: { id: entry.name, name: entry.name, version: '0.0.0', main: '' },
          dir,
          tools: [],
          commands: [],
          error: message,
        });
      }
    }
  }

  private load(dir: string) {
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) throw new Error('plugin.json is missing');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest;
    if (!manifest.id || !manifest.main) throw new Error('plugin.json needs both "id" and "main"');

    const entry = path.join(dir, manifest.main);
    if (!fs.existsSync(entry)) throw new Error(`entry file ${manifest.main} not found`);

    // Drop any cached copy so "Reload plugins" genuinely re-reads from disk.
    const resolved = require.resolve(entry);
    delete (Module as unknown as { _cache: Record<string, unknown> })._cache[resolved];

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(entry) as { activate?: (api: PluginApi) => void };
    if (typeof mod.activate !== 'function') throw new Error('module does not export activate(api)');

    const loaded: LoadedPlugin = { manifest, dir, tools: [], commands: [] };
    const storagePath = path.join(dir, '.storage');

    const api: PluginApi = {
      id: manifest.id,
      version: manifest.version,
      storagePath,
      log: (...args) => console.log(`[plugin:${manifest.id}]`, ...args),
      registerCommand: (spec) => loaded.commands.push(spec),
      registerTool: (spec) => {
        loaded.tools.push(
          defineTool(
            {
              name: `plugin_${sanitize(manifest.id)}_${sanitize(spec.name)}`,
              description: spec.description,
              risk: spec.risk ?? 'write',
              source: `plugin:${manifest.id}`,
              properties: spec.parameters ?? {},
              required: spec.required ?? [],
            },
            async (input, ctx) => {
              const value = await spec.handler(input, makePageContext(ctx));
              return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            },
          ),
        );
      },
    };

    mod.activate(api);
    this.plugins.set(manifest.id, loaded);
    console.log(`[plugins] loaded ${manifest.id} (${loaded.tools.length} tool(s))`);
  }

  get tools(): Tool[] {
    return [...this.plugins.values()].flatMap((p) => p.tools);
  }

  status(): PluginStatus[] {
    return [...this.plugins.values()].map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name ?? p.manifest.id,
      version: p.manifest.version ?? '0.0.0',
      path: p.dir,
      enabled: true,
      loaded: !p.error,
      error: p.error,
      toolNames: p.tools.map((t) => t.name),
    }));
  }

  /** Writes a working example the first time, so the ABI is discoverable. */
  private ensureSamplePlugin() {
    const dir = path.join(this.rootDir, SAMPLE_PLUGIN_ID);
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify(
        {
          id: SAMPLE_PLUGIN_ID,
          name: 'Example: Page Stats',
          version: '1.0.0',
          description: 'Sample plugin showing the Nabsun plugin ABI.',
          main: 'index.js',
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `/**
 * Nabsun plugin example.
 *
 * A plugin is a CommonJS module exporting activate(api). Tools you register
 * here appear to the AI exactly like the built-in ones.
 *
 * Plugins run with full Node privileges in the browser's main process — the
 * same trust model as VS Code extensions. Only install plugins you trust.
 */
exports.activate = (api) => {
  api.registerTool({
    name: 'page_stats',
    description:
      'Report reading statistics for the current page: word count, estimated reading time, link and image counts.',
    risk: 'safe',
    parameters: {},
    handler: async (_input, page) => {
      const text = await page.readText();
      const words = text.split(/\\s+/).filter(Boolean).length;
      const counts = await page.evaluate(
        '({ links: document.links.length, images: document.images.length })'
      );
      return {
        url: page.url(),
        title: page.title(),
        words,
        readingTimeMinutes: Math.max(1, Math.round(words / 220)),
        links: counts.links,
        images: counts.images,
      };
    },
  });

  api.log('ready');
};
`,
      'utf8',
    );
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
}

function makePageContext(ctx: ToolContext): PagePluginContext {
  const tab = () => ctx.tabs.resolveTarget(ctx.getAgentTabId() ?? undefined);
  return {
    url: () => tab().wc.getURL(),
    title: () => tab().wc.getTitle(),
    status: (message) => ctx.status(message),
    navigate: async (url) => {
      const t = tab();
      ctx.tabs.navigate(t.id, url);
      await ctx.tabs.waitForSettled(t);
    },
    readText: async (selector) => {
      const res = await ctx.tabs.callBridge<{ text: string }>(
        tab(),
        `window.__nabsunAgent.readText(${selector ? JSON.stringify(selector) : 'undefined'})`,
      );
      return res.text;
    },
    snapshot: async () => {
      const snap = await ctx.tabs.callBridge<{ text: string }>(
        tab(),
        'window.__nabsunAgent.snapshot({})',
      );
      return snap.text;
    },
    evaluate: <T,>(expression: string) =>
      ctx.tabs.callBridge<T>(tab(), `(() => (${expression}))()`),
    openTab: async (url, background = true) => {
      const t = ctx.tabs.create(url, { background, byAgent: true });
      await ctx.tabs.waitForSettled(t);
      return t.id;
    },
  };
}
