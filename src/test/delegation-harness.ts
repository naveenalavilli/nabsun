import type { AgentEvent } from '../shared/types';
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
    mode: 'budget' | 'stop' | 'timeout' | 'failure' | 'normal' | 'pending' | 'response-limit' | 'high-usage' | 'action-cap' = 'budget',
    results: { content: string; isError?: boolean }[] = [];
  let highUsageCalls=0;
  const provider: Provider = {
    id: 'codex-cli',
    label: 'Delegated fixture',
    supportsVision: () => false,
    listModels: async () => ['fixture'],
    async *stream(req): AsyncGenerator<StreamEvent> {
      last = req;
      assert.ok(req.browserBridge);
      assert.notEqual(req.browserBridge.token, bridge.token);
      if(mode==='high-usage'){
        if(highUsageCalls++===0){
          yield {type:'usage',usage:{inputTokens:200000,outputTokens:1000,cacheReadTokens:190000}};
          yield {type:'tool_use',id:'high-usage-action',name:tool.name,input:{}};
          yield {type:'stop',reason:'tool_use'};return;
        }
        const result=req.messages.flatMap(m=>m.content).find(b=>b.type==='tool_result'&&b.toolUseId==='high-usage-action');
        assert.ok(result&&result.type==='tool_result'&&!result.isError,'work continues after the high-usage request');
        yield {type:'text',delta:'Finished the requested work.'};yield {type:'stop',reason:'end_turn'};return;
      }
      if(mode==='action-cap'){
        results=[];
        for(let count=0;count<101;count++){
          const response=await fetch(req.browserBridge.url+'/call',{method:'POST',headers:{authorization:'Bearer '+req.browserBridge.token},body:JSON.stringify({name:tool.name,arguments:{}})});
          results.push(await response.json() as {content:string;isError?:boolean});
        }
        yield {type:'stop',reason:'end_turn'};return;
      }
      if(mode==='failure'){yield {type:'text',delta:'Partial answer stays.'};throw Error('Fixture connection lost.');}
      if(mode==='response-limit'){yield {type:'text',delta:'Partial response.'};yield {type:'stop',reason:'max_tokens'};return;}
      if(mode==='normal'){
        const clock=Date.now;Date.now=()=>clock()+6*60*1000;
        try{const response=await fetch(req.browserBridge.url+'/tools',{headers:{authorization:'Bearer '+req.browserBridge.token}});assert.equal(response.status,200,'browser tools remain authorized beyond the old five-minute limit')}finally{Date.now=clock}
        yield {type:'text',delta:'Finished normally.'};yield {type:'stop',reason:'end_turn'};return;
      }
      if(mode==='pending'){
        void fetch(req.browserBridge.url+'/call',{method:'POST',headers:{authorization:'Bearer '+req.browserBridge.token},body:JSON.stringify({name:tool.name,arguments:{}})}).catch(()=>{});
        await new Promise<void>(resolve=>approvals.setEmitter(()=>resolve()));
        yield {type:'stop',reason:'end_turn'};return;
      }
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
  const events:AgentEvent[]=[];
  const agent = new Agent({
    settings,
    history,
    sessions,
    tabs,
    approvals,
    providers: new Map([['codex-cli', provider]]),
    getTools: () => [tool],
    userDataPath: profile,
    emit: event => {events.push(event)},
    issueTaskBridge: (access,ttlMs) => {
      const capability = bridge.issue(access,ttlMs);
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
    assert.equal(sessions.load(chat.id)!.messages.at(-1)!.stopReason,'user_stop');
    assert.match(sessions.load(chat.id)!.messages.at(-1)!.stopMessage!,/pressed Stop/);
    assert.ok(events.some(e=>e.type==='aborted'&&e.message?.includes('pressed Stop')));
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
    const timedOut=new SessionStore(profile).load(chat.id)!.messages.at(-1)!;
    assert.equal(timedOut.stopReason,'time_limit');assert.match(timedOut.stopMessage!,/time limit \(1 second\)/);
    assert.ok(events.some(e=>e.type==='aborted'&&e.message?.includes('time limit')));
    assert.ok(!agent.recordedTask(chat.id).complete);
    mode='normal';
    const originalTimeout=global.setTimeout;const delays:number[]=[];
    global.setTimeout=((callback:Parameters<typeof setTimeout>[0],milliseconds?:number,...args:unknown[])=>{if(milliseconds&&milliseconds>=300000)delays.push(milliseconds);return originalTimeout(callback,milliseconds,...args)}) as typeof setTimeout;
    try{await agent.send(chat.id,'Run a normal interactive CLI task.')}finally{global.setTimeout=originalTimeout}
    assert.equal(delays[0],1800000,'interactive CLI timer uses 30 minutes instead of five');
    assert.equal(delays.length,2);assert.ok(delays[1]>1790000&&delays[1]<=1800000,'browser capability follows the remaining task deadline');
    assert.equal(sessions.load(chat.id)!.messages.at(-1)!.stopMessage,undefined);
    mode='failure';await agent.send(chat.id,'Simulate a provider failure.');
    const failed=new SessionStore(profile).load(chat.id)!.messages.at(-1)!;
    assert.equal(failed.stopReason,'error');assert.equal(failed.stopMessage,'Fixture connection lost.');assert.ok(JSON.stringify(failed.blocks).includes('Partial answer stays.'));
    mode='response-limit';await agent.send(chat.id,'Simulate a response limit.');
    assert.equal(sessions.load(chat.id)!.messages.at(-1)!.stopReason,'max_tokens');assert.match(sessions.load(chat.id)!.messages.at(-1)!.stopMessage!,/response-length limit/);
    mode='pending';await agent.send(chat.id,'End the provider with an approval pending.');
    assert.equal(sessions.load(chat.id)!.messages.at(-1)!.stopReason,'provider_ended');assert.match(sessions.load(chat.id)!.messages.at(-1)!.stopMessage!,/browser action was still pending/);
    assert.equal(effects,2,'interrupted pending calls never run');
    console.log('PASS Stop, deadlines, provider exits/errors and response limits have distinct persisted explanations; normal CLI tasks receive a 30-minute limit');
    tool.risk='safe';
    mode='high-usage';highUsageCalls=0;const beforeUsage=effects;
    await agent.send(chat.id,'Complete a normal task with substantial reused context.');
    assert.equal(highUsageCalls,2);assert.equal(effects,beforeUsage+1);
    const completed=new SessionStore(profile).load(chat.id)!.messages.at(-1)!;
    assert.equal(completed.stopReason,'end_turn');assert.equal(completed.stopMessage,undefined);
    assert.equal(completed.usage!.inputTokens,200000,'usage is still reported accurately');
    assert.equal(completed.usage!.cacheReadTokens,190000);
    mode='high-usage';highUsageCalls=0;const beforeExplicit=effects;
    await agent.send(chat.id,'Run a workflow with an explicit usage budget.',{budget:{steps:2,tokens:128000,timeMs:5000}});
    assert.equal(highUsageCalls,1);assert.equal(effects,beforeExplicit);
    assert.equal(sessions.load(chat.id)!.messages.at(-1)!.stopReason,'token_budget');
    mode='action-cap';const beforeActions=effects;
    await agent.send(chat.id,'Exercise the interactive browser action limit.');
    assert.equal(effects-beforeActions,100);assert.equal(results.length,101);assert.equal(results[100].isError,true);assert.match(results[100].content,/action budget/);
    console.log('PASS interactive CLI work continues beyond 128k reported tokens without a usage-limit notice; usage reporting, explicit workflow budgets and the 100-action limit remain enforced');


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
