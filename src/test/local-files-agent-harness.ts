import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { app, BaseWindow } from 'electron';
import { Agent, shapeRequest } from '../main/ai/agent';
import { ApprovalManager } from '../main/ai/approvals';
import { SessionStore } from '../main/ai/sessions';
import { SettingsStore } from '../main/store';
import { HistoryStore } from '../main/history';
import { TabManager } from '../main/tabs';
import { LocalFolderStore, FolderAccessController } from '../main/localFiles';
import { localFileTools } from '../main/ai/tools/localFiles';
import type { Provider, StreamRequest, StreamEvent } from '../main/ai/provider';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-local-agent-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-local-work-'));
app.setPath('userData', profile);
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

class FileProvider implements Provider {
  readonly id = 'anthropic' as const;
  readonly label = 'File task fixture';
  readonly contextTokens = 16000;
  step = 0;
  async listModels() { return ['fixture']; }
  supportsVision() { return false; }
  private result(req: StreamRequest, id: string) {
    const block = req.messages.flatMap(message => message.content).find(block => block.type === 'tool_result' && block.toolUseId === id);
    assert.ok(block && block.type === 'tool_result', id);
    assert.ok(!block.isError, block.content);
    return JSON.parse(block.content);
  }
  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    const step = this.step++;
    let name = '', input: Record<string, unknown> = {};
    if (step === 0) {
      assert.ok(!req.tools.some(tool => tool.name === 'local_edit'), 'lean catalogue waits for a chosen folder');
      name = 'local_folders';
    } else if (step === 1) {
      assert.deepEqual(this.result(req, 'step-0'), { folders: [] });
      name = 'local_request_folder'; input = { reason: 'Update a note and organize the result' };
    } else if (step === 2) {
      const folder = this.result(req, 'step-1');assert.equal(folder.path, undefined);
      assert.ok(req.tools.some(tool => tool.name === 'local_edit'), 'tools become available after native consent');
      name = 'local_read'; input = { folderId: folder.id, path: 'note.txt' };
    } else if (step === 3) {
      name = 'local_edit'; input = { folderId: this.result(req, 'step-1').id, path: 'note.txt', oldText: 'old', newText: 'new', expectedHash: this.result(req, 'step-2').hash };
    } else if (step === 4) {
      name = 'local_mkdir'; input = { folderId: this.result(req, 'step-1').id, path: 'Reports' };
    } else if (step === 5) {
      name = 'local_copy'; input = { folderId: this.result(req, 'step-1').id, from: 'note.txt', to: 'Reports/note.txt', expectedHash: this.result(req, 'step-3').hash };
    } else if (step === 6) {
      name = 'local_read'; input = { folderId: this.result(req, 'step-1').id, path: 'Reports/note.txt' };
    } else if (step === 7) {
      assert.equal(this.result(req, 'step-6').text, 'new note\n');
      yield { type: 'text', delta: 'The note is updated and copied.' };
      yield { type: 'stop', reason: 'end_turn' };return;
    } else if (step === 8) {
      name = 'local_read'; input = { folderId: this.result(req, 'step-1').id, path: 'note.txt' };
    } else if (step === 9) {
      name = 'local_edit'; input = { folderId: this.result(req, 'step-1').id, path: 'note.txt', oldText: 'new', newText: 'final', expectedHash: this.result(req, 'step-8').hash };
    } else if (step === 10) {
      name='local_append';input={folderId:this.result(req,'step-1').id,path:'note.txt',text:'appended\n',expectedHash:this.result(req,'step-9').hash};
    } else if (step === 11) {
      name='local_read';input={folderId:this.result(req,'step-1').id,path:'Reports/note.txt'};
    } else if (step === 12) {
      name='local_trash';input={folderId:this.result(req,'step-1').id,path:'Reports/note.txt',expectedHash:this.result(req,'step-11').hash};
    } else {
      assert.ok(this.result(req, 'step-9').backup);
      assert.equal(this.result(req,'step-12').trashed,true);
      yield { type: 'stop', reason: 'end_turn' };return;
    }
    yield { type: 'tool_use', id: 'step-' + step, name, input };
    yield { type: 'stop', reason: 'tool_use' };
  }
}
class OfficeProvider implements Provider {
  readonly id='anthropic' as const;readonly label='Office fixture';readonly contextTokens=32000;step=0;
  async listModels(){return ['fixture']} supportsVision(){return false}
  result(req:StreamRequest,id:number){const block=req.messages.flatMap(m=>m.content).find(b=>b.type==='tool_result'&&b.toolUseId==='office-'+id);assert.ok(block&&block.type==='tool_result');assert.ok(!block.isError,block.content);return JSON.parse(block.content)}
  async *stream(req:StreamRequest):AsyncGenerator<StreamEvent>{
    const step=this.step++;let name='',input:Record<string,unknown>={};
    const folder=step?this.result(req,0).folders[0].id:undefined;
    if(step===0)name='local_folders';
    else if(step===1){assert.ok(req.tools.some(t=>t.name==='local_word_create'));name='local_word_create';input={folderId:folder,path:'plan.docx',paragraphs:[{text:'Draft plan'}]}}
    else if(step===2){name='local_office_read';input={folderId:folder,path:'plan.docx'}}
    else if(step===3){name='local_word_edit';input={folderId:folder,path:'plan.docx',expectedHash:this.result(req,2).hash,replacements:[{oldText:'Draft',newText:'Final'}],append:[{text:'Next steps',style:'heading1'}]}}
    else if(step===4){name='local_excel_create';input={folderId:folder,path:'budget.xlsx',sheets:[{name:'Budget',rows:[['Amount'],[5],[{formula:'SUM(A2:A2)'}]]}]}}
    else if(step===5){name='local_office_read';input={folderId:folder,path:'budget.xlsx',sheet:'Budget'}}
    else if(step===6){name='local_excel_edit';input={folderId:folder,path:'budget.xlsx',sheet:'Budget',expectedHash:this.result(req,5).hash,changes:[{cell:'A2',value:10}]}}
    else if(step===7){name='local_office_read';input={folderId:folder,path:'budget.xlsx',sheet:'Budget'}}
    else if(step===8){assert.equal(this.result(req,7).cells.find((c:{cell:string})=>c.cell==='A2').value,10);name='local_office_read';input={folderId:folder,path:'plan.docx'}}
    else {assert.equal(this.result(req,8).paragraphs[0].text,'Final plan');yield {type:'stop',reason:'end_turn'};return}
    yield {type:'tool_use',id:'office-'+step,name,input};yield {type:'stop',reason:'tool_use'};
  }
}
async function main() {
  await app.whenReady();
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'old note\n');
  const server = http.createServer((_request, response) => response.end('<p>Unrelated browser page</p>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const window = new BaseWindow({ show: false });
  const settings = new SettingsStore();
  settings.save({ provider: 'anthropic', personalContext: false, memoryEnabled: false, autoApprove: { safe: true, write: true, dangerous: false } });
  const history = new HistoryStore(), sessions = new SessionStore(profile), approvals = new ApprovalManager(settings);
  const tabs = new TabManager({ window, history, homepage: 'about:blank', partition: 'local-agent-fixture', preloadPath: path.join(__dirname, '../preload/page.js'), onFindResult: () => {} });
  const tab = tabs.create('http://127.0.0.1:' + (server.address() as { port: number }).port);
  await tabs.waitForSettled(tab, 5000);
  const store = new LocalFolderStore([profile],async file=>{assert.equal(file,path.join(fs.realpathSync(workspace),'Reports/note.txt'));fs.renameSync(file,path.join(workspace,'trash-fixture.txt'))}), chat = sessions.create();
  let choices = 0, prompts = 0;
  const access = new FolderAccessController(store, { exists: scope => !!sessions.load(scope), choose: async () => { choices++;return workspace; }, confirm: async () => 'read-write', changed: () => {} });
  approvals.setEmitter(request => {
    prompts++;
    assert.equal(request.source, 'local-files');assert.equal(request.origin, undefined, 'browser autoplay/site permissions do not approve file writes');
    assert.equal(request.sessionId, chat.id);assert.equal(request.allowSession, true);
    assert.ok(request.title.includes(workspace), 'user sees the actual folder in the approval UI');
    approvals.resolve(request.id, 'allow_session');
  });
  const provider = new FileProvider(), tools = localFileTools();
  const providerMap=new Map<string,Provider>([['anthropic',provider]]);
  const agent = new Agent({ localFiles: store, requestFolderAccess: (scope, reason, signal) => access.request(scope, reason, signal), providers: providerMap, settings, sessions, history, tabs, approvals, userDataPath: profile, getTools: () => tools, emit: () => {} });
  try {
    await agent.send(chat.id, 'Please update and organize my note.', { attachPage: false });
    assert.equal(provider.step, 8);
    assert.equal(choices, 1);assert.equal(prompts, 3);
    assert.equal(fs.readFileSync(path.join(workspace, 'Reports/note.txt'), 'utf8'), 'new note\n');
    assert.equal(store.list(chat.id).length, 1);
    assert.equal(store.list(sessions.create().id).length, 0);
    await agent.send(chat.id, 'Make the last adjustment.', { attachPage: false });
    assert.equal(provider.step, 14);assert.equal(prompts, 5, 'prior edit permission survives follow-up turns; append and Trash have their own approval');
    assert.equal(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf8'), 'final note\nappended\n');
    assert.equal(fs.existsSync(path.join(workspace,'Reports/note.txt')),false);
    assert.equal(fs.readFileSync(path.join(workspace,'trash-fixture.txt'),'utf8'),'new note\n');
    const officeProvider=new OfficeProvider();providerMap.set('anthropic',officeProvider);
    await agent.send(chat.id,'Create a Word plan and Excel budget, then update them.',{attachPage:false});
    assert.equal(officeProvider.step,10);assert.equal(prompts,9);assert.equal(choices,1);
    console.log('PASS real agent creates, reads and edits Word/Excel with hash-bound saves and independent tool approvals');
    await assert.rejects(agent.runToolForExternalAgent('local_folders', {}, 'unbound-client'), /owning chat/);
    const journal = agent.activityStore().records(new Date().toISOString().slice(0, 10));
    assert.ok(journal.some(record => record.event.tool === 'local_edit' && record.event.approver === 'session'));
    assert.ok(!JSON.stringify(journal).includes('old note'));
    const hidden = shapeRequest({ tools, vision: false, contextTokens: 16000, localFilesEnabled: false });
    assert.equal(hidden.tools.length, 0);
    console.log('PASS real agent requests native folder consent, discovers tools dynamically, reads/edits/organizes files, preserves backups and uses scoped follow-up approvals');
    console.log('PASS browser autoplay cannot authorize filesystem writes, unrelated chats/external clients have no access, and local actions retain journal redaction');
  } finally {
    agent.abortAll();store.clear();approvals.denyAll();settings.flush();tabs.destroyAll();window.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
main().then(() => app.exit(0), error => { console.error(error);app.exit(1); });
