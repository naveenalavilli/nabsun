import fs from 'node:fs';
import path from 'node:path';
import {PluginHost} from './pluginHost';
import {inspectPlugin,stagePlugin,validatePluginStorage} from './pluginIntegrity';
import {JsonStore} from '../store';
import type { PluginManifest, PluginStatus, RiskLevel } from '../../shared/types';
import { defineTool, type Tool } from '../ai/tools/types';

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
  staged?:string;
  fingerprint?:string;
  approved?:boolean;
  host?:PluginHost;
  manifest: PluginManifest;
  dir: string;
  tools: Tool[];
  commands: { id: string; title: string; run: () => Promise<void> | void }[];
  error?: string;
}

const SAMPLE_PLUGIN_ID = 'example-page-stats';

/**
 * Approved modules run in a separate host with enforced filesystem permissions.
 * Network access remains available; this is not an OS security sandbox.
 * Browser helpers pass through the shared approval, cancellation and audit path.
 */
export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();

  private trust=new JsonStore<{pins:Record<string,string>}>('plugin-trust.json',{pins:{}});
  private generation=0;
  constructor(private readonly rootDir: string,private enabled:()=>boolean=()=>true) {}

  async approve(id:string,fingerprint:string){
    const plugin=this.plugins.get(id);if(!plugin)throw Error('Plugin not found.');
    const source=inspectPlugin(plugin.dir);if(source.manifest.id!==id||source.fingerprint!==fingerprint)throw Error('Plugin changed. Refresh and review it again.');
    this.trust.commit({pins:{...this.trust.get().pins,[id]:fingerprint}});await this.reload();
  }
  async revoke(id:string){const pins={...this.trust.get().pins};delete pins[id];this.trust.commit({pins});await this.reload()}
  shutdown(){for(const plugin of this.plugins.values()){plugin.host?.close();if(plugin.staged)this.discardStage(plugin.staged)}this.plugins.clear()}
  private discardStage(stage:string){
    const cache=path.resolve(path.dirname(this.rootDir),'plugin-hosts'),target=path.resolve(stage);
    if(path.dirname(target)!==cache||!/^[a-f0-9-]{36}$/.test(path.basename(target)))return;
    const cleanup=()=>{try{if(fs.lstatSync(target).isSymbolicLink()||!fs.realpathSync(target).startsWith(fs.realpathSync(cache)+path.sep))return;void fs.promises.rm(target,{recursive:true,force:true}).catch(()=>{})}catch{/* Already removed, or preserve anything outside the owned cache. */}};
    const timer=setTimeout(cleanup,500);timer.unref();
  }

  get directory(): string {
    return this.rootDir;
  }

  async reload(): Promise<void> {
    const generation=++this.generation;this.shutdown();
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.ensureSamplePlugin();

    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.rootDir, entry.name);
      try {
        if(generation!==this.generation)break;
        await this.load(dir,generation);
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

  private async load(dir:string,generation:number){
    const source=inspectPlugin(dir),manifest=source.manifest;
    if(this.plugins.has(manifest.id))throw Error('Duplicate plugin id.');
    const approved=this.trust.get().pins[manifest.id]===source.fingerprint;
    const loaded:LoadedPlugin={manifest,dir:source.dir,fingerprint:source.fingerprint,approved,tools:[],commands:[]};
    this.plugins.set(manifest.id,loaded);
    if(!this.enabled()){loaded.error='Plugins are disabled in Settings.';return}
    if(!approved){loaded.error='Review and approve this source before loading it.';return}
    try{
      const staged=stagePlugin(path.join(path.dirname(this.rootDir),'plugin-hosts'),source);
      loaded.staged=staged.dir;
      const storage=path.join(source.dir,'.storage');fs.mkdirSync(storage,{recursive:true});
      validatePluginStorage(storage);
      const host=new PluginHost(staged.dir,path.join(staged.dir,manifest.main),fs.realpathSync(storage),manifest.id,manifest.version);loaded.host=host;
      const specs=await host.start();
      if(generation!==this.generation||this.plugins.get(manifest.id)!==loaded||!this.enabled()){host.close();return}
      const names=new Set<string>();
      loaded.tools=specs.map(spec=>{
        const name=`plugin_${sanitize(manifest.id)}_${sanitize(spec.name)}`;
        if(names.has(name))throw Error('Plugin tool names collide after normalization.');names.add(name);
        return defineTool({name,description:spec.description,risk:'dangerous',source:`plugin:${manifest.id}`,properties:spec.parameters??{},required:spec.required??[]},async(input,ctx)=>{
          if(!this.enabled()||inspectPlugin(source.dir).fingerprint!==this.trust.get().pins[manifest.id]){host.close('Plugin source changed or was disabled.');throw Error('Plugin needs review before it can run again.')}
          const value=await host.call(spec.name,input,ctx);return typeof value==='string'?value:JSON.stringify(value,null,2);
        });
      });
    }catch(error){loaded.host?.close();loaded.error=error instanceof Error?error.message:String(error);loaded.tools=[]}
  }

  get tools(): Tool[] {
    return [...this.plugins.values()].flatMap((p) => p.host?.running ? p.tools : []);
  }

  status(): PluginStatus[] {
    return [...this.plugins.values()].map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name ?? p.manifest.id,
      version: p.manifest.version ?? '0.0.0',
      path: p.dir,
      enabled: this.enabled(),
      approved:p.approved,
      fingerprint:p.fingerprint,
      loaded: !!p.host?.running && !p.error,
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
 * Plugins run in a separate host. Profile access is restricted; browser helpers
 * use the shared approval gate. Only approve plugins you trust.
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
