import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpManager } from '../main/integrations/mcp';
import { mcpEnvironment } from '../main/integrations/mcpIntegrity';
import type { ToolContext } from '../main/ai/tools/types';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    if (
      process.platform === 'linux' &&
      fs
        .readFileSync(`/proc/${pid}/stat`, 'utf8')
        .split(') ')[1]
        .startsWith('Z')
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
async function gone(pid: number) {
  const deadline = Date.now() + 4000;
  while (alive(pid) && Date.now() < deadline) await delay(25);
  assert.equal(alive(pid), false, 'Owned MCP process must stop: ' + pid);
}
async function main() {
  const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nabsun-integration-trust-'),
    ),
    script = path.join(root, 'server.cjs'),
    pidFile = path.join(root, 'server.pid'),
    childFile = path.join(root, 'child.pid');
  fs.writeFileSync(
    script,
    `const fs=require('node:fs');fs.writeFileSync(process.env.NABSUN_TEST_PID_FILE,String(process.pid));const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(process.env.NABSUN_TEST_CHILD_FILE,String(child.pid));process.on('SIGTERM',()=>{});require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.id===undefined)return;let result;if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(message.method==='tools/list')result={tools:[{name:'inspect',description:'Fixture environment',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]};else if(message.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({keys:Object.keys(process.env),privateInherited:!!process.env.NABSUN_PRIVATE_FIXTURE,explicit:process.env.NABSUN_TEST_EXPLICIT})}]};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n')});setInterval(()=>{},1000);`,
  );
  const config = {
    command: process.execPath,
    args: [script],
    enabled: true,
    env: {
      NABSUN_TEST_PID_FILE: pidFile,
      NABSUN_TEST_CHILD_FILE: childFile,
      NABSUN_TEST_EXPLICIT: 'fixture',
    },
  };
  let enabled = true;
  const manager = new McpManager(root, () => enabled),
    oldPrivate = process.env.NABSUN_PRIVATE_FIXTURE;
  process.env.NABSUN_PRIVATE_FIXTURE = 'fixture-secret';
  try {
    await manager.reload({ fixture: config });
    const unapproved = manager.status({ fixture: config })[0];
    assert.equal(unapproved.connected, false);
    assert.equal(fs.existsSync(pidFile), false);
    assert.ok(unapproved.fingerprint);
    await manager.approve('fixture', unapproved.fingerprint!, config);
    await manager.reload({ fixture: config });
    assert.equal(manager.status({ fixture: config })[0].connected, true);
    const context = { signal: new AbortController().signal } as ToolContext,
      tool = manager.tools[0];
    const environment = JSON.parse(String(await tool.handler({}, context)));
    assert.equal(environment.privateInherited, false);
    assert.equal(environment.explicit, 'fixture');
    const allowed = new Set(Object.keys(mcpEnvironment(config.env)));
    for (const key of environment.keys)
      assert.ok(allowed.has(key), 'Unexpected inherited variable: ' + key);
    console.log(
      'PASS an MCP server cannot start before its exact source/config approval; the child sees only allowlisted and explicitly configured environment variables',
    );
    let parentPid = Number(fs.readFileSync(pidFile, 'utf8')),
      childPid = Number(fs.readFileSync(childFile, 'utf8'));
    fs.appendFileSync(script, '\n// modified server\n');
    await assert.rejects(tool.handler({}, context), /source changed/);
    await gone(parentPid);
    await gone(childPid);
    const changed = manager.status({ fixture: config })[0];
    assert.equal(changed.approved, false);
    assert.notEqual(changed.fingerprint, unapproved.fingerprint);
    await assert.rejects(
      manager.approve('fixture', unapproved.fingerprint!, config),
      /changed/,
    );
    await manager.approve('fixture', changed.fingerprint!, config);
    await manager.reload({ fixture: config });
    const reapproved = manager.tools[0];
    assert.equal(manager.status({ fixture: config })[0].connected, true);
    parentPid = Number(fs.readFileSync(pidFile, 'utf8'));
    childPid = Number(fs.readFileSync(childFile, 'utf8'));
    enabled = false;
    await manager.reload({ fixture: config });
    assert.equal(manager.tools.length, 0);
    await assert.rejects(reapproved.handler({}, context), /enabled|connected/);
    await gone(parentPid);
    await gone(childPid);
    console.log(
      'PASS changed MCP source and stale hashes refuse execution; reapproval restores it; disabling kills the server and its SIGTERM-resistant child',
    );
  } finally {
    if (oldPrivate === undefined) delete process.env.NABSUN_PRIVATE_FIXTURE;
    else process.env.NABSUN_PRIVATE_FIXTURE = oldPrivate;
    await manager.shutdown();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
