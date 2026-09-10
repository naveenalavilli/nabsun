/**
 * Verifies the external-agent path: BrowserBridgeServer <- bin/nabsun-mcp.mjs
 * <- a real MCP client. This is the route the Claude Code and Codex CLIs take,
 * and the same one VS Code's extensions would take.
 *
 * Runs under plain Node — the bridge deliberately has no Electron dependency.
 *
 *   node dist/test/bridge-harness.js
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolSpec } from '../shared/types';
import { BrowserBridgeServer } from '../main/bridge/server';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

const TOOLS: ToolSpec[] = [
  {
    name: 'browser_snapshot',
    description: 'Read the current page.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    risk: 'safe',
    source: 'browser',
  },
  {
    name: 'browser_click',
    description: 'Click an element.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'number' } },
      required: ['ref'],
    },
    risk: 'write',
    source: 'browser',
  },
];

async function main() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];

  const bridge = new BrowserBridgeServer({
    listTools: () => TOOLS,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'browser_click' && args.ref === 99) {
        throw new Error('The user declined this action in Nabsun.');
      }
      return `ran ${name} with ${JSON.stringify(args)}`;
    },
  });
  await bridge.start();
  check('bridge binds a loopback port', bridge.running && bridge.url.startsWith('http://127.0.0.1:'));

  // An unauthenticated caller must be rejected before reaching any tool.
  const unauth = await fetch(`${bridge.url}/tools`);
  check('bridge rejects a request with no token', unauth.status === 401);

  const badToken = await fetch(`${bridge.url}/tools`, {
    headers: { authorization: 'Bearer wrong' },
  });
  check('bridge rejects a wrong token', badToken.status === 401);

  const serverScript = path.join(__dirname, '..', 'bin', 'nabsun-mcp.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: {
      ...(process.env as Record<string, string>),
      NABSUN_BRIDGE_URL: bridge.url,
      NABSUN_BRIDGE_TOKEN: bridge.token,
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'harness', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    check('an MCP client connects to the browser', true);

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    check(
      'the browser tools are advertised over MCP',
      names.includes('browser_snapshot') && names.includes('browser_click'),
      JSON.stringify(names),
    );

    const snapshotTool = listed.tools.find((t) => t.name === 'browser_snapshot');
    check(
      'read-only tools are annotated as such for the calling agent',
      snapshotTool?.annotations?.readOnlyHint === true,
      JSON.stringify(snapshotTool?.annotations),
    );
    check(
      'the input schema survives the hop',
      JSON.stringify(
        listed.tools.find((t) => t.name === 'browser_click')?.inputSchema,
      ).includes('ref'),
    );

    const result = (await client.callTool({
      name: 'browser_click',
      arguments: { ref: 7 },
    })) as { content: { type: string; text?: string }[]; isError?: boolean };

    check(
      'a tool call reaches the browser with its arguments intact',
      calls.length === 1 && calls[0].name === 'browser_click' && calls[0].args.ref === 7,
      JSON.stringify(calls),
    );
    check(
      'the result comes back to the agent',
      result.content[0]?.text?.includes('ran browser_click') === true,
      JSON.stringify(result),
    );

    const denied = (await client.callTool({
      name: 'browser_click',
      arguments: { ref: 99 },
    })) as { content: { text?: string }[]; isError?: boolean };

    check(
      'a declined action is reported to the external agent as an error',
      denied.isError === true && /declined/i.test(denied.content[0]?.text ?? ''),
      JSON.stringify(denied),
    );
  } catch (err) {
    check('harness completed', false, err instanceof Error ? err.stack : String(err));
  } finally {
    await client.close().catch(() => {});
    bridge.stop();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

void main();
