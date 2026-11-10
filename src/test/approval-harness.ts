import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { SettingsStore } from '../main/store';
import { ApprovalManager } from '../main/ai/approvals';
import { defineTool } from '../main/ai/tools/types';
import type { ApprovalDecision } from '../shared/types';
import { integrationPolicy } from '../main/ai/policy';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-approvals-'));
app.setPath('userData', profile);
async function main() {
  await app.whenReady();
  fs.writeFileSync(
    path.join(profile, 'settings.json'),
    JSON.stringify({ alwaysAllowTools: ['browser_click'] }),
  );
  const settings = new SettingsStore();
  assert.deepEqual(settings.get().alwaysAllowTools, []);
  assert.equal(settings.get().approvalMigrationNotice, true);
  settings.save({
    autoApprove: { safe: true, write: false, dangerous: false },
  });
  const approvals = new ApprovalManager(settings);
  let prompts = 0,
    decision: ApprovalDecision = 'allow_always';
  approvals.setEmitter((request) => {
    prompts++;
    approvals.resolve(request.id, decision);
  });
  const click = defineTool(
    {
      name: 'browser_click',
      description: 'fixture',
      risk: 'write',
      properties: {},
    },
    async () => 'ok',
  );
  const first = new AbortController(),
    second = new AbortController();
  const request = (
    signal: AbortSignal,
    origin = 'https://one.example',
    tool = click,
  ) => approvals.request(tool, {}, signal, { origin });
  assert.equal(await request(first.signal), true);
  assert.equal(await request(first.signal), true);
  assert.equal(prompts, 1);
  assert.equal(await request(second.signal), true);
  assert.equal(prompts, 2);
  assert.equal(await request(first.signal, 'https://two.example'), true);
  assert.equal(prompts, 3);
  first.abort();
  assert.equal(await request(first.signal), false);
  assert.equal(prompts, 3);
  console.log(
    'PASS task grants require the same live task, tool, and origin; Stop revokes authority',
  );
  decision = 'allow_site';
  assert.equal(await request(second.signal), true); // Existing task grant avoids a prompt.
  const third = new AbortController();
  assert.equal(await request(third.signal), true);
  assert.equal(prompts, 4);
  assert.equal(await request(new AbortController().signal), true);
  assert.equal(prompts, 4);
  settings.save({
    siteToolGrants: settings
      .get()
      .siteToolGrants!.map((grant) => ({
        ...grant,
        expiresAt: Date.now() - 1,
      })),
  });
  decision = 'deny';
  assert.equal(await request(new AbortController().signal), false);
  assert.equal(prompts, 5);
  console.log(
    'PASS site grants expire and can be revoked without retaining global tool grants',
  );
  settings.save({
    autoApprove: { safe: true, write: true, dangerous: true },
    siteToolGrants: [],
  });
  const auto = new AbortController();
  assert.equal(await request(auto.signal), true);
  assert.equal(await request(auto.signal, 'https://two.example'), false);
  const evaluate = defineTool(
    {
      name: 'browser_evaluate',
      description: 'fixture',
      risk: 'dangerous',
      properties: {},
    },
    async () => 'ok',
  );
  decision = 'allow_always';
  assert.equal(
    await request(auto.signal, 'https://one.example', evaluate),
    false,
  );
  decision = 'allow';
  assert.equal(
    await request(auto.signal, 'https://one.example', evaluate),
    true,
  );
  const before = prompts;
  assert.equal(
    await request(auto.signal, 'https://one.example', evaluate),
    true,
  );
  assert.equal(prompts, before + 1);
  console.log(
    'PASS autopilot stays on one origin per task; JavaScript requires individual approval',
  );
  decision = 'deny';
  const beforeSubmit = prompts;
  assert.equal(
    await approvals.request(click, {}, auto.signal, {
      origin: 'https://one.example',
      crossOriginSubmit: true,
    }),
    false,
  );
  assert.equal(prompts, beforeSubmit + 1);
  const enter = defineTool(
    {
      name: 'browser_press_key',
      description: 'fixture',
      risk: 'write',
      properties: {},
    },
    async () => 'ok',
  );
  assert.equal(
    await approvals.request(enter, { key: 'Enter' }, auto.signal, {
      origin: 'https://one.example',
    }),
    false,
  );
  settings.save({
    integrationControls: { plugins: false, mcp: false, extensions: false },
  });
  const plugin = defineTool(
    {
      name: 'plugin_fixture_read',
      description: 'fixture',
      risk: 'safe',
      source: 'plugin:fixture',
      properties: {},
    },
    async () => 'ok',
  );
  await assert.rejects(
    approvals.request(plugin, {}, auto.signal, {
      origin: 'https://one.example',
    }),
    /disabled/,
  );
  const policy = integrationPolicy(settings);
  for (const source of ['plugin:fixture', 'mcp:fixture', 'extension:fixture'])
    assert.equal(
      policy.evaluate({ tool: 'fixture', risk: 'safe', source, input: {} })
        .allowed,
      false,
    );
  console.log(
    'PASS cross-origin submission and Enter require individual approval; disabled integrations are denied through the shared PolicyProvider',
  );
  approvals.denyAll();
  settings.flush();
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
