/**
 * Nabsun MCP server.
 *
 * Exposes the running browser's tools — snapshot a page, click, type, extract,
 * search, manage tabs — over MCP, so any MCP client can drive the browser: the
 * Claude Code or Codex CLI that Nabsun spawns for its own sidebar, or the
 * same extensions running in VS Code.
 *
 * It is a thin proxy. The tools live in the browser process; this process just
 * forwards calls to its loopback control plane. Every call still passes through
 * Nabsun's approval gate, so connecting here grants no more authority
 * than using the assistant inside the app.
 *
 * Bundled to a single self-contained file so a packaged app can run it without
 * node_modules present.
 *
 * Required environment:
 *   NABSUN_BRIDGE_URL    e.g. http://127.0.0.1:53124
 *   NABSUN_BRIDGE_TOKEN  bearer token minted by the running browser
 *
 * Both are shown in Nabsun under Settings → Integrations → Connect an
 * external agent.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Identifies this connected agent for the life of the process.
 *
 * The browser keys a run off this, so the tab this client selects is still its
 * tab on the next call — while remaining separate from every other client.
 */
const CLIENT_ID = `mcp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

// The former names are still accepted. An MCP config generated before the
// rename lives in the user's editor settings, not in this repository, and
// silently failing to connect after an update is a poor way to learn about a
// rebrand.
const BASE = process.env.NABSUN_BRIDGE_URL ?? process.env.SMARTBROWSER_BRIDGE_URL;
const TOKEN = process.env.NABSUN_BRIDGE_TOKEN ?? process.env.SMARTBROWSER_BRIDGE_TOKEN;

interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: 'safe' | 'write' | 'dangerous';
}

async function bridge<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      // One id per server process, so this client's tab selection persists
      // across its calls and stays separate from any other connected agent.
      'x-nabsun-client': CLIENT_ID,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? 'Nabsun rejected the token. Copy a fresh one from Settings → Integrations.'
        : `Nabsun bridge returned ${res.status}. Is the browser still running?`,
    );
  }
  return (await res.json()) as T;
}

async function main() {
  if (!BASE || !TOKEN) {
    // stderr, never stdout: stdout is the MCP transport itself.
    console.error(
      'nabsun-mcp: NABSUN_BRIDGE_URL and NABSUN_BRIDGE_TOKEN must be set. ' +
        'Find them in Nabsun under Settings -> Integrations.',
    );
    process.exit(1);
  }

  const server = new Server(
    { name: 'nabsun', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await bridge<{ tools: BridgeTool[] }>('/tools');
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: {
          // Lets the calling agent see which tools only read the page.
          readOnlyHint: t.risk === 'safe',
          destructiveHint: t.risk === 'dangerous',
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await bridge<{ content?: string; isError?: boolean }>('/call', {
      method: 'POST',
      body: JSON.stringify({
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      }),
    });
    return {
      content: [{ type: 'text', text: String(result.content ?? '') }],
      isError: Boolean(result.isError),
    };
  });

  await server.connect(new StdioServerTransport());
  console.error('nabsun-mcp: connected to', BASE);
}

void main().catch((err: unknown) => {
  console.error('nabsun-mcp:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
