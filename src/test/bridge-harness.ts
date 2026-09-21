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
import fs from 'node:fs';
import os from 'node:os';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolSpec } from '../shared/types';
import { BrowserBridgeServer } from '../main/bridge/server';
import { McpManager } from '../main/integrations/mcp';
import type { ToolContext } from '../main/ai/tools/types';

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
  let slowStarted: (() => void) | undefined;
  let finishSlow: (() => void) | undefined;

  const bridge = new BrowserBridgeServer({
    listTools: () => TOOLS,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (args.ref === 88) {
        slowStarted?.();
        await new Promise<void>((resolve) => { finishSlow = resolve; });
      }
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

  for (const body of ['{', 'null', '{"name":17}', '{"name":"browser_click","arguments":[]}', '{"name":"browser_click","arguments":null}']) {
    const response = await fetch(`${bridge.url}/call`, {
      method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body,
    });
    check(`bridge rejects invalid call ${body}`, response.status === 400 && calls.length === 0);
  }
  const large = await fetch(`${bridge.url}/call`, {
    method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: 'x'.repeat(4_000_001),
  });
  check('bridge bounds request bytes without dispatching a tool', large.status === 413 && calls.length === 0);
  const unicode = '\u20ac\uD83D\uDE80\u0C28';
  const encoded = Buffer.from(JSON.stringify({ name: 'browser_click', arguments: { text: unicode } }));
  const split = encoded.indexOf(Buffer.from(unicode)) + 1;
  await new Promise<void>((resolve, reject) => {
    const req = request(`${bridge.url}/call`, {
      method: 'POST', headers: { authorization: `Bearer ${bridge.token}` },
    }, (res) => { res.resume(); res.on('end', resolve); res.on('error', reject); });
    req.on('error', reject);
    req.write(encoded.subarray(0, split));
    setTimeout(() => req.end(encoded.subarray(split)), 30);
  });
  check('bridge preserves Unicode split across network chunks', calls.at(-1)?.args.text === unicode);
  calls.length = 0;

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
  const manager = new McpManager();

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
    await manager.reload({ review: { command: process.execPath, args: [serverScript], enabled: true,
      env: { NABSUN_BRIDGE_URL: bridge.url, NABSUN_BRIDGE_TOKEN: bridge.token } } });
    const tool = manager.tools.find((tool) => tool.name.endsWith('_browser_click'));
    if (!tool) throw new Error('MCP host did not discover the fixture tool');
    const stopped = new AbortController();
    stopped.abort();
    const previousCalls = calls.length;
    const preAborted = await tool.handler({ ref: 88 }, { signal: stopped.signal } as ToolContext).then(() => false, () => true);
    check('MCP host does not dispatch an already-cancelled call', preAborted && calls.length === previousCalls);
    const started = new Promise<void>((resolve) => { slowStarted = resolve; });
    const controller = new AbortController();
    const pending = tool.handler({ ref: 88 }, { signal: controller.signal } as ToolContext).then(() => false, () => true);
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('MCP tool did not start')), 5000))]);
    controller.abort();
    const cancelled = await Promise.race([pending, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000))]);
    check('Stop interrupts an active MCP tool request', cancelled);
    finishSlow?.();

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-mcp-review-'));
    const pidFile = path.join(fixtureDir, 'child.pid');
    const brokenServer = `
      require('fs').writeFileSync(process.env.NABSUN_TEST_PID_FILE, String(process.pid));
      require('readline').createInterface({input:process.stdin}).on('line', line => {
        const msg=JSON.parse(line); if(msg.id===undefined)return;
        const reply=msg.method==='initialize'
          ? {result:{protocolVersion:msg.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'broken',version:'1'}}}
          : {error:{code:-32603,message:'injected tools/list failure'}};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,...reply})+'\\n');
      });
      setInterval(()=>{},1000);
    `;
    await manager.reload({ broken: { command: process.execPath, args: ['-e', brokenServer], enabled: true,
      env: { NABSUN_TEST_PID_FILE: pidFile } } });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    check('a server that fails discovery leaves no child process behind', !alive);
    if (alive) process.kill(pid);

    const delayedServer = `
      const fs=require('fs');
      fs.writeFileSync(process.env.NABSUN_TEST_PID_FILE, String(process.pid));
      require('readline').createInterface({input:process.stdin}).on('line', line => {
        const msg=JSON.parse(line); if(msg.id===undefined)return;
        const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
        if(msg.method==='initialize') send({protocolVersion:msg.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'reload-fixture',version:'1'}});
        else if(msg.method==='tools/list') {
          fs.writeFileSync(process.env.NABSUN_TEST_READY_FILE,'ready');
          setTimeout(()=>send({tools:[{name:process.env.NABSUN_TEST_TOOL,inputSchema:{type:'object',properties:{}}}]}),Number(process.env.NABSUN_TEST_DELAY));
        }
      });
      setInterval(()=>{},1000);
    `;
    const config = (name: string, delay: number) => ({ review: {
      command: process.execPath, args: ['-e', delayedServer], enabled: true,
      env: { NABSUN_TEST_PID_FILE: path.join(fixtureDir, name + '.pid'),
        NABSUN_TEST_READY_FILE: path.join(fixtureDir, name + '.ready'),
        NABSUN_TEST_TOOL: name, NABSUN_TEST_DELAY: String(delay) },
    } });
    const older = manager.reload(config('older', 5000));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(fixtureDir, 'older.ready')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!fs.existsSync(path.join(fixtureDir, 'older.ready'))) throw new Error('slow MCP fixture did not start');
    await manager.reload(config('newer', 0));
    await older;
    check('a newer MCP configuration wins over an overlapping slow startup',
      manager.tools.length === 1 && manager.tools[0].name === 'mcp_review_newer');
    const oldPid = Number(fs.readFileSync(path.join(fixtureDir, 'older.pid'), 'utf8'));
    let oldAlive = true;
    try { process.kill(oldPid, 0); } catch { oldAlive = false; }
    check('reloading closes a server still in discovery', !oldAlive);
    if (oldAlive) process.kill(oldPid);
  } catch (err) {
    check('harness completed', false, err instanceof Error ? err.stack : String(err));
  } finally {
    finishSlow?.();
    await manager.shutdown();
    await client.close().catch(() => {});
    bridge.stop();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

void main();
