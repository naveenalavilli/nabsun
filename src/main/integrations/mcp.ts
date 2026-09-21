import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

  async reload(servers: Record<string, McpServerConfig>): Promise<void> {
    const generation = ++this.generation;
    await this.closeConnections();
    if (generation !== this.generation) return;
    this.disabled.clear();

    const entries = Object.entries(servers).filter(([, cfg]) => cfg.enabled !== false);
    // Servers are independent; one that fails to start must not block the rest.
    await Promise.all(entries.map(([name, cfg]) => this.connect(name, cfg, generation)));
  }

  private async connect(name: string, cfg: McpServerConfig, generation: number): Promise<void> {
    let client: Client | undefined;
    let transport: StdioClientTransport | undefined;
    try {
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
        stderr: 'pipe',
      });
      // Consume diagnostics so a chatty server cannot fill its stderr pipe.
      transport.stderr?.on('data', () => {});
      client = new Client(
        { name: 'nabsun', version: '0.1.0' },
        { capabilities: {} },
      );
      this.connecting.add(client);
      await client.connect(transport);

      const listed = await client.listTools();
      if (generation !== this.generation) throw new Error('MCP configuration changed during startup');
      const tools = listed.tools.map((t) => this.wrap(name, client!, t));
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
        const res = await client.callTool({ name: tool.name, arguments: input }, undefined, { signal: ctx.signal });
        return renderMcpResult(res);
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
        enabled: cfg.enabled !== false,
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
