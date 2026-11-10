import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {version} from '../../../package.json';
import {McpTransport} from './mcpTransport';
import {inspectMcp} from './mcpIntegrity';
import {ContentPins} from './contentPins';
import type { McpServerConfig, McpStatus, RiskLevel } from '../../shared/types';
import { defineTool, type Tool } from '../ai/tools/types';

interface Connection {
  name: string;
  client: Client;
  tools: Tool[];
  error?: string;
}

/**
 * Model Context Protocol host. Each configured server is a child process
 * speaking stdio; its tools are merged into the agent's tool list under an
 * `mcp:<server>` source, exactly as VS Code surfaces extension-contributed
 * commands alongside built-ins.
 */
export class McpManager {
  private connections = new Map<string, Connection>();
  private disabled = new Map<string, string>();
  private connecting = new Set<Client>();
  private generation = 0;
  private pins:ContentPins;
  private inspected=new Map<string,{command:string;fingerprint:string}>();
  constructor(profile:string,private enabled:()=>boolean=()=>true){this.pins=new ContentPins(profile,'mcp-trust.json')}
  async approve(name:string,hash:string,config:McpServerConfig){const source=await inspectMcp(config);if(source.fingerprint!==hash)throw Error('MCP source changed. Reload and review it again.');this.pins.approve(name,hash)}
  revoke(name:string){this.pins.revoke(name)}

  async reload(servers: Record<string, McpServerConfig>): Promise<void> {
    const generation = ++this.generation;
    await this.closeConnections();
    if (generation !== this.generation) return;
    this.disabled.clear();this.inspected.clear();

    const entries = Object.entries(servers).filter(([, cfg]) => cfg.enabled !== false);
    // Servers are independent; one that fails to start must not block the rest.
    await Promise.all(entries.map(([name, cfg]) => this.connect(name, cfg, generation)));
  }

  private async connect(name: string, cfg: McpServerConfig, generation: number): Promise<void> {
    let client: Client | undefined;
    let transport: McpTransport | undefined;
    try {
      const source=await inspectMcp(cfg);
      if(generation!==this.generation)return;
      this.inspected.set(name,source);
      if(!this.enabled())throw Error('External MCP servers are disabled in Settings.');
      if(!this.pins.matches(name,source.fingerprint))throw Error('Review and approve this MCP executable and configuration before connecting.');
      transport=new McpTransport(source.command,cfg.args??[],source.env);
      client = new Client(
        { name: 'nabsun', version },
        { capabilities: {} },
      );
      this.connecting.add(client);
      await client.connect(transport);

      const listed = await client.listTools();
      if (generation !== this.generation) throw new Error('MCP configuration changed during startup');
      if(listed.tools.length>200||JSON.stringify(listed.tools).length>1024*1024)throw Error('MCP tool catalogue exceeds its limit.');
      const tools = listed.tools.map((t) => this.wrap(name, client!, cfg, source.fingerprint, t));
      if(new Set(tools.map(tool=>tool.name)).size!==tools.length)throw Error('MCP tool names collide after normalization.');
      client.onclose=()=>{if(this.connections.get(name)?.client===client){this.connections.delete(name);this.disabled.set(name,'Server disconnected. Review its status and reconnect.')}};
      this.connections.set(name, { name, client, tools });
      console.log(`[mcp] ${name}: ${tools.length} tool(s)`);
    } catch (err) {
      await client?.close().catch(() => {});
      await transport?.close().catch(() => {});
      if (generation !== this.generation) return;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[mcp] failed to start ${name}:`, message);
      this.disabled.set(name, message);
    } finally {
      if (client) this.connecting.delete(client);
    }
  }

  private wrap(
    server: string,
    client: Client,
    config:McpServerConfig,
    fingerprint:string,
    tool: { name: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown> },
  ): Tool {
    const ann = tool.annotations ?? {};
    // MCP annotations are advisory; when a server says nothing we assume the
    // tool can write, so it lands behind the approval gate rather than around it.
    const risk: RiskLevel = ann.destructiveHint === true
      ? 'dangerous'
      : ann.readOnlyHint === true
        ? 'safe'
        : 'write';

    const schema = (tool.inputSchema ?? { type: 'object', properties: {} }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    return defineTool(
      {
        // Namespacing avoids collisions between servers that both expose e.g. `search`.
        name: `mcp_${sanitize(server)}_${sanitize(tool.name)}`,
        description: tool.description ?? `${tool.name} (from MCP server ${server})`,
        risk,
        source: `mcp:${server}`,
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      },
      async (input, ctx) => {
        ctx.signal.throwIfAborted();
        if(!this.enabled()||this.connections.get(server)?.client!==client)throw Error('MCP server is no longer enabled or connected.');
        const source=await inspectMcp(config,ctx.signal);ctx.signal.throwIfAborted();
        if(source.fingerprint!==fingerprint||!this.pins.matches(server,source.fingerprint)){
          this.inspected.set(server,source);
          await client.close();this.disabled.set(server,'MCP source changed. Review and approve it again.');throw Error('MCP source changed; this tool was not run.');
        }
        if(!this.enabled()||this.connections.get(server)?.client!==client)throw Error('MCP configuration changed before the action.');
        const cancel=()=>{void client.close().catch(()=>{})};ctx.signal.addEventListener('abort',cancel,{once:true});
        try{const res=await client.callTool({name:tool.name,arguments:input},undefined,{signal:ctx.signal});return renderMcpResult(res)}finally{ctx.signal.removeEventListener('abort',cancel)}
      },
    );
  }

  get tools(): Tool[] {
    return [...this.connections.values()].flatMap((c) => c.tools);
  }

  status(servers: Record<string, McpServerConfig>): McpStatus[] {
    return Object.entries(servers).map(([name, cfg]) => {
      const conn = this.connections.get(name);
      return {
        name,
        enabled: this.enabled() && cfg.enabled !== false,
        fingerprint:this.inspected.get(name)?.fingerprint,
        resolvedCommand:this.inspected.get(name)?.command,
        approved:!!this.inspected.get(name) && this.pins.matches(name,this.inspected.get(name)!.fingerprint),
        connected: Boolean(conn),
        error: this.disabled.get(name),
        toolNames: conn?.tools.map((t) => t.name) ?? [],
      };
    });
  }

  async shutdown(): Promise<void> {
    ++this.generation;
    await this.closeConnections();
  }

  private async closeConnections(): Promise<void> {
    // Detach before awaiting, so an older reload cannot clear newer connections.
    const clients = new Set([...this.connections.values()].map((connection) => connection.client));
    for (const client of this.connecting) clients.add(client);
    this.connections.clear();
    this.connecting.clear();
    await Promise.all([...clients].map((client) => client.close().catch(() => {})));
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
}

function renderMcpResult(res: unknown): string {
  const result = res as {
    isError?: boolean;
    content?: { type: string; text?: string; data?: string; mimeType?: string }[];
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'image') parts.push(`[image: ${block.mimeType ?? 'unknown'}]`);
    else if (block.type === 'resource') parts.push(`[resource: ${block.mimeType ?? ''}]`);
  }
  if (!parts.length && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const text = parts.join('\n') || '(no output)';
  if (result.isError) throw new Error(text);
  return text;
}
