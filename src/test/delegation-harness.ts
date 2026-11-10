import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BaseWindow } from 'electron';
import { BrowserBridgeServer } from '../main/bridge/server';
import { Agent } from '../main/ai/agent';
import { ApprovalManager } from '../main/ai/approvals';
import { SessionStore } from '../main/ai/sessions';
import { SettingsStore } from '../main/store';
import { HistoryStore } from '../main/history';
import { TabManager } from '../main/tabs';
import type { Provider, StreamRequest, StreamEvent } from '../main/ai/provider';
import type { Tool } from '../main/ai/tools/types';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-delegation-'));
app.setPath('userData', profile);
async function main() {
  await app.whenReady();
  const settings = new SettingsStore();
  settings.save({
    provider: 'codex-cli',
    personalContext: false,
    memoryEnabled: false,
    autoApprove: { safe: true, write: false, dangerous: false },
  });
  const history = new HistoryStore(),
    sessions = new SessionStore(profile),
    window = new BaseWindow({ show: false });
  const tabs = new TabManager({
    window,
    history,
    partition: 'delegation-fixture',
    preloadPath: path.join(__dirname, '../preload/page.js'),
    homepage: 'about:blank',
    onFindResult: () => {},
  });
  const approvals = new ApprovalManager(settings),
    chat = sessions.create();
  let effects = 0;
  const tool: Tool = {
    name: 'test_scoped_action',
    description: 'Fixture action',
    inputSchema: { type: 'object', properties: {} },
    risk: 'safe',
    source: 'fixture',
    handler: async (_input, ctx) => {
      assert.equal(ctx.fileScope, chat.id);
      effects++;
      return 'owned action';
    },
  };
  const bridge = new BrowserBridgeServer({
    listTools: () => [],
    callTool: async () => {
      throw Error('Global bridge access is forbidden in this fixture.');
    },
  });
  await bridge.start();
  let last: StreamRequest | undefined,
    mode: 'budget' | 'stop' | 'timeout' = 'budget',
    results: { content: string; isError?: boolean }[] = [];
  const provider: Provider = {
    id: 'codex-cli',
    label: 'Delegated fixture',
    supportsVision: () => false,
    listModels: async () => ['fixture'],
    async *stream(req): AsyncGenerator<StreamEvent> {
      last = req;
      assert.ok(req.browserBridge);
      assert.notEqual(req.browserBridge.token, bridge.token);
      if (mode === 'timeout') {
        await new Promise<void>((resolve) =>
          req.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return;
      }
      for (let call = 0; call < (mode === 'budget' ? 3 : 1); call++) {
        const response = await fetch(req.browserBridge.url + '/call', {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + req.browserBridge.token,
            'x-nabsun-client': 'different-chat',
          },
          body: JSON.stringify({ name: tool.name, arguments: {} }),
        });
        results.push(
          (await response.json()) as { content: string; isError?: boolean },
        );
      }
      yield { type: 'stop', reason: 'end_turn' };
    },
  };
  const agent = new Agent({
    settings,
    history,
    sessions,
    tabs,
    approvals,
    providers: new Map([['codex-cli', provider]]),
    getTools: () => [tool],
    userDataPath: profile,
    emit: () => {},
    issueTaskBridge: (access) => {
      const capability = bridge.issue(access);
      return {
        info: {
          url: bridge.url,
          token: capability.token,
          serverScript: 'fixture',
        },
        revoke: capability.revoke,
      };
    },
  });
  try {
    await agent.send(chat.id, 'Run the fixture actions.', {
      budget: { steps: 2, tokens: 128000, timeMs: 5000 },
    });
    assert.equal(effects, 2);
    assert.equal(results.length, 3);
    assert.equal(results[2]!.isError, true);
    assert.match(results[2]!.content, /action budget/);
    assert.equal(
      sessions
        .load(chat.id)!
        .messages.at(-1)!
        .blocks.filter((block) => block.type === 'tool_call').length,
      3,
    );
    assert.equal(
      (
        await fetch(last!.browserBridge!.url + '/tools', {
          headers: { authorization: 'Bearer ' + last!.browserBridge!.token },
        })
      ).status,
      401,
    );
    console.log(
      'PASS delegated CLI uses chat-owned scope, enforces host action budget, records every result and revokes credentials on completion',
    );
    mode = 'stop';
    tool.risk = 'write';
    results = [];
    approvals.setEmitter(() => {
      setImmediate(() => agent.abort(chat.id));
    });
    await agent.send(chat.id, 'Try an action needing approval.');
    assert.equal(effects, 2);
    assert.equal(results[0]?.isError, true);
    assert.equal(
      (
        await fetch(last!.browserBridge!.url + '/tools', {
          headers: { authorization: 'Bearer ' + last!.browserBridge!.token },
        })
      ).status,
      401,
    );
    console.log(
      'PASS Stop cancels delegated approval, prevents the action, and revokes the CLI credential',
    );
    mode = 'timeout';
    const started = Date.now();
    await agent.send(chat.id, 'Wait without performing an action.', {
      budget: { steps: 2, tokens: 128000, timeMs: 1000 },
    });
    assert.ok(Date.now() - started < 4000);
    assert.equal(
      (
        await fetch(last!.browserBridge!.url + '/tools', {
          headers: { authorization: 'Bearer ' + last!.browserBridge!.token },
        })
      ).status,
      401,
    );
    console.log(
      'PASS host timeout ends an idle delegated CLI and revokes its browser access',
    );
  } finally {
    agent.abortAll();
    bridge.stop();
    tabs.destroyAll();
    window.destroy();
    settings.flush();
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
