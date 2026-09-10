/**
 * Opt-in live check that Codex can actually *call a browser tool*.
 *
 * This is the gap that let a real bug ship: the other live check only asked for
 * a text reply, so the entire MCP tool path went untested and every browser
 * action was refused by Codex's own approval review.
 *
 * It runs a real BrowserBridgeServer with stub tools — no browser needed — and
 * asserts the tool was actually invoked. Gated behind an env flag because it
 * spends model quota.
 *
 *   set NABSUN_TEST_LIVE_CLI=1
 *   node dist/test/codex-tools-live.js [extraFlag...]
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { buildCodexArgs, resolveLauncher } from '../main/ai/providers/cli';
import { BrowserBridgeServer } from '../main/bridge/server';
import type { ToolSpec } from '../shared/types';

const TOOLS: ToolSpec[] = [
  {
    name: 'tab_open',
    description: 'Open a URL in a new browser tab. Use this to open any web page.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to open' } },
      required: ['url'],
      additionalProperties: false,
    },
    risk: 'write',
    source: 'tabs',
  },
];

async function main() {
  if (process.env.NABSUN_TEST_LIVE_CLI !== '1') {
    console.log('SKIP  live Codex tool check (set NABSUN_TEST_LIVE_CLI=1)');
    return;
  }

  const launcher = resolveLauncher('codex', '');
  if (!launcher) {
    console.log('SKIP  codex is not installed');
    return;
  }

  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const bridge = new BrowserBridgeServer({
    listTools: () => TOOLS,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return `Opened ${String(args.url)} in a new tab (id: tab-1).`;
    },
  });
  await bridge.start();

  // Whatever the app would pass, plus any flag being trialled.
  const extra = process.argv.slice(2);
  const args = [
    ...launcher.args,
    ...buildCodexArgs({
      model: '',
      bridge: { url: bridge.url, token: bridge.token, serverScript: serverScriptPath() },
      mcpCommand: process.execPath,
    }),
  ];

  // Insert trial flags right after `exec` so they attach to the subcommand.
  const execAt = args.indexOf('exec');
  args.splice(execAt + 1, 0, ...extra);

  console.log(`flags under test: ${extra.length ? extra.join(' ') : '(none)'}`);

  const child = spawn(launcher.command, args, {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      NO_COLOR: '1',
      ...(launcher.runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    windowsHide: true,
  });

  child.stdin.end('Use the nabsun tab_open tool to open https://example.com. Then reply DONE.');

  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
  child.stderr.on('data', (b: Buffer) => (out += b.toString('utf8')));

  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });

  bridge.stop();

  // Any text the model produced, for the transcript.
  const said = [...out.matchAll(/"type":"agent_message","text":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1])
    .join(' ');

  console.log(`\nexit=${code}`);
  console.log(`tool calls reaching the browser: ${JSON.stringify(calls)}`);
  console.log(`assistant said: ${said.slice(0, 300) || '(nothing)'}`);

  const blocked = /approval|blocked|not permitted|policy/i.test(out);
  console.log(`\n${calls.length ? 'PASS' : 'FAIL'}  Codex actually invoked the browser tool`);
  if (!calls.length && blocked) {
    console.log('      (output mentions approval/policy — the tool was refused, not missing)');
  }
  if (!calls.length) {
    // Argument errors and startup failures never reach the JSONL, so show raw.
    const raw = out.split('\n').filter((l) => !l.startsWith('{')).join('\n').trim();
    if (raw) console.log(`\n--- non-JSON output ---\n${raw.slice(0, 600)}`);
  }
  process.exit(calls.length ? 0 : 1);
}

function serverScriptPath(): string {
  // dist/test/... -> dist/bin/nabsun-mcp.js
  return require('node:path').join(__dirname, '..', 'bin', 'nabsun-mcp.js');
}

void main();
