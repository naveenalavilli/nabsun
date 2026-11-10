import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { app, BaseWindow } from 'electron';
import { PluginHost } from '../main/integrations/pluginHost';
import { PluginManager } from '../main/integrations/plugins';
import {
  inspectPlugin,
  validatePluginStorage,
} from '../main/integrations/pluginIntegrity';
import { Agent } from '../main/ai/agent';
import { ApprovalManager } from '../main/ai/approvals';
import { SessionStore } from '../main/ai/sessions';
import { SettingsStore } from '../main/store';
import { HistoryStore } from '../main/history';
import { TabManager, delay } from '../main/tabs';
import { browserTools } from '../main/ai/tools/browser';
import { defineTool } from '../main/ai/tools/types';
const profile = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nabsun-plugin-profile-'),
);
app.setPath('userData', profile);
async function main() {
  await app.whenReady();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-plugin-source-')),
    storage = path.join(profile, 'plugin-storage');
  fs.mkdirSync(storage);
  const secret = path.join(profile, 'private-fixture.txt');
  fs.writeFileSync(secret, 'PRIVATE_FIXTURE_MUST_NOT_LEAVE_PROFILE');
  const entry = path.join(root, 'index.cjs');
  fs.writeFileSync(
    entry,
    `exports.activate=api=>{
  api.registerTool({name:'probe',description:'Fixture',handler:async input=>{
   const fs=require('node:fs'),result={};
   try{fs.readFileSync(input.secret);result.read='ALLOWED'}catch(e){result.read=e.code}
   try{fs.writeFileSync(__dirname+'/changed','blocked');result.sourceWrite='ALLOWED'}catch(e){result.sourceWrite=e.code}
   try{require('node:child_process').spawnSync('whoami');result.child='ALLOWED'}catch(e){result.child=e.code}
   try{fs.linkSync(__filename,api.storagePath+'/source-alias');fs.writeFileSync(api.storagePath+'/source-alias','changed');result.sourceAlias='ALLOWED'}catch(e){result.sourceAlias=e.code}
   try{fs.symlinkSync(input.profile,api.storagePath+'/escape','junction');fs.readFileSync(api.storagePath+'/escape/private-fixture.txt');result.symlink='ALLOWED'}catch(e){result.symlink=e.code}
   fs.writeFileSync(api.storagePath+'/own.txt','own storage');result.own=fs.readFileSync(api.storagePath+'/own.txt','utf8');
   result.inheritedSecret=!!process.env.NABSUN_PRIVATE_FIXTURE;
   return result;
  }});
  api.registerTool({name:'pending',description:'Fixture pending approval',handler:async(_input,page)=>page.evaluate('window.pluginExecuted=true')});
 };`,
  );
  process.env.NABSUN_PRIVATE_FIXTURE = 'fixture-only';
  const host = new PluginHost(
    root,
    entry,
    storage,
    'fixture',
    '1.0.0',
    path.join(__dirname, '../main/plugin-worker.js'),
  );
  const specs = await host.start();
  assert.equal(specs.length, 2);
  const server = http.createServer((_req, res) =>
    res.end('<!doctype html><title>Plugin fixture</title>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const settings = new SettingsStore();
  settings.save({ autoApprove: { safe: true, write: true, dangerous: false } });
  const history = new HistoryStore(),
    window = new BaseWindow({ show: false, width: 900, height: 700 });
  window.showInactive();
  const tabs = new TabManager({
    window,
    history,
    partition: 'plugin-isolation-fixture',
    preloadPath: path.join(__dirname, '../preload/page.js'),
    homepage: 'about:blank',
    onFindResult: () => {},
  });
  tabs.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  const approvals = new ApprovalManager(settings);
  let approvalId = '';
  approvals.setEmitter((request) => {
    approvalId = request.id;
  });
  const tools = specs.map((spec) =>
    defineTool(
      {
        name: 'plugin_fixture_' + spec.name,
        description: spec.description,
        risk: 'write',
        properties: {},
      },
      async (input, ctx) =>
        JSON.stringify(await host.call(spec.name, input, ctx)),
    ),
  );
  const agent = new Agent({
    settings,
    history,
    tabs,
    approvals,
    sessions: new SessionStore(profile),
    providers: new Map(),
    getTools: () => [...browserTools(), ...tools],
    userDataPath: profile,
    emit: () => {},
  });
  try {
    const tab = tabs.create(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    await tabs.waitForSettled(tab, 5000);
    const result = JSON.parse(
      await agent.runToolForExternalAgent(
        'plugin_fixture_probe',
        { secret, profile, tabId: tab.id },
        'fixture',
      ),
    );
    for (const key of [
      'read',
      'sourceWrite',
      'child',
      'symlink',
      'sourceAlias',
    ])
      assert.equal(result[key], 'ERR_ACCESS_DENIED', key);
    assert.equal(result.own, 'own storage');
    assert.equal(result.inheritedSecret, false);
    console.log(
      'PASS isolated plugin host refuses profile reads, source writes, child processes and symlink escape; own storage works and parent secrets are absent',
    );
    const call = agent.runToolForExternalAgent(
      'plugin_fixture_pending',
      { tabId: tab.id },
      'fixture',
    );
    const outcome = call.then(
      () => false,
      () => true,
    );
    const deadline = Date.now() + 10000;
    while (!approvalId && Date.now() < deadline) await delay(20);
    assert.ok(approvalId, 'nested page JavaScript must ask');
    host.close('Fixture host termination');
    assert.equal(await outcome, true);
    approvals.resolve(approvalId, 'allow');
    await delay(100);
    assert.notEqual(
      await tab.wc.executeJavaScript('window.pluginExecuted'),
      true,
    );
    console.log(
      'PASS plugin page JavaScript uses the shared approval gate; host termination cancels the task and a late approval cannot execute it',
    );
    {
      const directory = path.join(profile, 'plugins'),
        plugin = path.join(directory, 'fixture');
      fs.mkdirSync(plugin, { recursive: true });
      fs.copyFileSync(entry, path.join(plugin, 'index.cjs'));
      fs.writeFileSync(
        path.join(plugin, 'plugin.json'),
        JSON.stringify({
          id: 'fixture',
          name: 'Fixture plugin',
          version: '1.0.0',
          main: 'index.cjs',
        }),
      );
      let enabled = true;
      const manager = new PluginManager(directory, () => enabled);
      try {
        await manager.reload();
        const initial = manager.status().find((item) => item.id === 'fixture')!;
        assert.equal(initial.loaded, false);
        assert.equal(initial.approved, false);
        assert.ok(initial.fingerprint);
        await manager.approve('fixture', initial.fingerprint!);
        assert.equal(
          manager.status().find((item) => item.id === 'fixture')?.loaded,
          true,
        );
        fs.appendFileSync(
          path.join(plugin, 'index.cjs'),
          '\n// changed fixture source\n',
        );
        await manager.reload();
        const changed = manager.status().find((item) => item.id === 'fixture')!;
        assert.equal(changed.loaded, false);
        assert.notEqual(changed.fingerprint, initial.fingerprint);
        assert.equal(manager.tools.length, 0);
        await assert.rejects(
          manager.approve('fixture', initial.fingerprint!),
          /changed/,
        );
        await manager.approve('fixture', changed.fingerprint!);
        assert.equal(
          manager.status().find((item) => item.id === 'fixture')?.loaded,
          true,
        );
        enabled = false;
        await manager.reload();
        assert.equal(manager.tools.length, 0);
        assert.equal(
          manager.status().find((item) => item.id === 'fixture')?.enabled,
          false,
        );
        fs.linkSync(secret, path.join(plugin, 'linked-private.txt'));
        assert.throws(() => inspectPlugin(plugin), /links/);
        fs.unlinkSync(path.join(plugin, 'linked-private.txt'));
        fs.linkSync(
          secret,
          path.join(plugin, '.storage', 'linked-private.txt'),
        );
        assert.throws(
          () => validatePluginStorage(path.join(plugin, '.storage')),
          /links/,
        );
        fs.unlinkSync(path.join(plugin, '.storage', 'linked-private.txt'));
        console.log(
          'PASS new and changed plugin source stays unloaded until its exact hash is approved; stale approvals, hard-linked source and the plugin kill switch refuse loading',
        );
      } finally {
        manager.shutdown();
      }
    }
  } finally {
    delete process.env.NABSUN_PRIVATE_FIXTURE;
    host.close();
    agent.abortAll();
    approvals.denyAll();
    tabs.destroyAll();
    window.destroy();
    settings.flush();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
