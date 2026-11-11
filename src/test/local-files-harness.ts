import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalFolderStore, FolderAccessController } from '../main/localFiles';
import { localFileTools } from '../main/ai/tools/localFiles';
import type { ToolContext } from '../main/ai/tools/types';

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-folder-test-'));
  const root = path.join(fixture, 'chosen'), outside = path.join(fixture, 'outside'), profile = path.join(fixture, 'profile');
  for (const directory of [root, outside, profile]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'first\nkeep this\nlast\n');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'not shared');
  fs.writeFileSync(path.join(root, 'sample.pdf'), '%PDF fixture for deferred parsing');
  const bin=path.join(fixture,'recycle');fs.mkdirSync(bin);
  let trashCalls=0,trashFailure=false;
  const store = new LocalFolderStore([profile],async file=>{
    trashCalls++;
    if(trashFailure)throw Error('Unavailable trash fixture');
    fs.renameSync(file,path.join(bin,String(trashCalls)+'-'+path.basename(file)));
  });
  const signal = new AbortController().signal;
  try {
    assert.throws(() => store.inspect(profile), /profile files/);
    assert.throws(() => store.inspect(path.parse(root).root), /entire drive/);
    const readOnly = store.grant('chat-a', store.inspect(root), 'read');
    const parentGrant = store.grant('parent-chat', store.inspect(fixture), 'read');
    await assert.rejects(store.read('parent-chat', parentGrant.id, 'profile/settings.json'), /profile files/);
    const id = readOnly.id;
    assert.equal(store.list('chat-b').length, 0);
    assert.equal(store.list('chat-a')[0].path, undefined);
    await assert.rejects(store.read('chat-b', id, 'notes.txt'), /unavailable/);
    assert.equal((await store.read('chat-a', id, 'notes.txt')).bytes.toString(), 'first\nkeep this\nlast\n');
    await assert.rejects(store.write('chat-a', id, 'new.txt', 'denied', undefined), /read-only/);
    await assert.rejects(store.append('chat-a',id,'notes.txt','no','0'.repeat(64)),/read-only/);
    await assert.rejects(store.trash('chat-a',id,'notes.txt','0'.repeat(64)),/read-only/);
    assert.equal(trashCalls,0);
    for (const relative of ['../outside/private.txt', '..\\outside\\private.txt', outside + '/private.txt', 'C:\\outside\\private.txt', 'notes.txt:stream', 'sub/../../outside', '.nabsun-backups/file', '.nabsun-00000000-0000-0000-0000-000000000000.tmp', 'NUL.txt'])
      await assert.rejects(store.read('chat-a', id, relative), /relative path|not allowed/);
    fs.symlinkSync(outside, path.join(root, 'linked-folder'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.read('chat-a', id, 'linked-folder/private.txt'), /not followed/);
    fs.linkSync(path.join(outside, 'private.txt'), path.join(root, 'hard-link.txt'));
    await assert.rejects(store.read('chat-a', id, 'hard-link.txt'), /hard links/);
    fs.symlinkSync(profile, path.join(root, 'profile-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.read('chat-a', id, 'profile-link/settings.json'), /not followed/);
    console.log('PASS native-selected folder capabilities, read-only mode, chat separation, traversal/drive/ADS rejection, junction/symlink and hard-link refusal');

    const grant = store.grant('chat-a', store.inspect(root), 'read-write');
    assert.notEqual(grant.id, id);
    await assert.rejects(store.read('chat-a', id, 'notes.txt'), /unavailable/);
    const original = await store.read('chat-a', grant.id, 'notes.txt');
    await assert.rejects(store.write('chat-a', grant.id, 'notes.txt', 'no hash', undefined), /Read this file first/);
    await assert.rejects(store.write('chat-a', grant.id, 'notes.txt', 'stale', '0'.repeat(64)), /has changed/);
    const edited = await store.edit('chat-a', grant.id, 'notes.txt', 'first', 'updated', original.hash);
    assert.equal(fs.readFileSync(path.join(root, edited.backup!), 'utf8'), original.bytes.toString());
    assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'updated\nkeep this\nlast\n');
    const nativeOpen = fs.promises.open;
    fs.promises.open = (async (...args: Parameters<typeof nativeOpen>) => {
      if (String(args[0]).includes('.nabsun-backups') && args[1] === 'wx')
        throw Object.assign(Error('Disk full fixture'), { code: 'ENOSPC' });
      return nativeOpen(...args);
    }) as typeof nativeOpen;
    try {
      await assert.rejects(store.write('chat-a', grant.id, 'notes.txt', 'must not replace', edited.hash), /Disk full/);
      assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'updated\nkeep this\nlast\n');
    } finally { fs.promises.open = nativeOpen; }
    await assert.rejects(store.read('chat-a', grant.id, edited.backup!), /not allowed/);
    assert.throws(()=>store.inspect(path.join(root,'.nabsun-backups')),/protected/);
    const beforeAppend=await store.read('chat-a',grant.id,'notes.txt');
    const appended=await store.append('chat-a',grant.id,'notes.txt','added\n',beforeAppend.hash);
    assert.equal(fs.readFileSync(path.join(root,'notes.txt'),'utf8'),'updated\nkeep this\nlast\nadded\n');
    assert.equal(fs.readFileSync(path.join(root,appended.backup!),'utf8'),'updated\nkeep this\nlast\n');
    await assert.rejects(store.append('chat-a',grant.id,'notes.txt','bad',beforeAppend.hash),/changed/);
    const disposable=await store.write('chat-a',grant.id,'discard.txt','recover me',undefined);
    await assert.rejects(store.trash('chat-a',grant.id,'discard.txt','0'.repeat(64)),/changed/);
    assert.equal(trashCalls,0);
    trashFailure=true;
    await assert.rejects(store.trash('chat-a',grant.id,'discard.txt',disposable.hash),/Could not confirm/);
    assert.equal(fs.readFileSync(path.join(root,'discard.txt'),'utf8'),'recover me','Trash failure never falls back to deleting the original');
    trashFailure=false;
    const trashed=await store.trash('chat-a',grant.id,'discard.txt',disposable.hash);
    assert.equal(fs.readFileSync(path.join(root,trashed.backup),'utf8'),'recover me');
    assert.equal(fs.existsSync(path.join(root,'discard.txt')),false);
    assert.equal(fs.readFileSync(path.join(bin,'2-discard.txt'),'utf8'),'recover me');
    console.log('PASS append preserves earlier contents and backups; Trash enforces read/write authority and revision hashes, and failure never falls back to permanent deletion');
    const created = await store.write('chat-a', grant.id, 'new.csv', 'a,b\n1,2\n', undefined);
    await assert.rejects(store.write('chat-a', grant.id, 'new.csv', 'overwrite', undefined), /Read this file first/);
    await assert.rejects(store.write('chat-a', grant.id, 'file.docx', 'not a document', undefined), /Binary documents/);
    await assert.rejects(store.write('chat-a', grant.id, 'too-big.txt', 'x'.repeat(2 * 1024 * 1024 + 1), undefined), /2 MB/);
    await store.mkdir('chat-a', grant.id, 'reports');
    await assert.rejects(store.trash('chat-a',grant.id,'reports','0'.repeat(64)),/regular file/);
    assert.equal(trashCalls,2);
    await store.copyOrMove('chat-a', grant.id, 'new.csv', 'reports/copy.csv', created.hash, false);
    await store.copyOrMove('chat-a', grant.id, 'reports/copy.csv', 'reports/final.csv', created.hash, true);
    assert.equal(fs.existsSync(path.join(root, 'reports/copy.csv')), false);
    assert.equal(fs.readFileSync(path.join(root, 'reports/final.csv'), 'utf8'), 'a,b\n1,2\n');
    await assert.rejects(store.copyOrMove('chat-a', grant.id, 'new.csv', 'reports/final.csv', created.hash, true), /already exists/);
    fs.writeFileSync(path.join(root, 'bom.txt'), Buffer.from('\ufeffhello\r\n', 'utf8'));
    const bom = await store.read('chat-a', grant.id, 'bom.txt');
    await store.edit('chat-a', grant.id, 'bom.txt', 'hello', 'world', bom.hash);
    assert.equal(fs.readFileSync(path.join(root, 'bom.txt'), 'utf8'), '\ufeffworld\r\n');
    const listed = await store.entries('chat-a', grant.id, '.', NaN, NaN);
    assert.ok(listed.entries.length < 100);
    assert.ok(!listed.entries.some(entry => entry.name === '.nabsun-backups'));
    const page = await store.entries('chat-a', grant.id, '.', 0, 2);
    assert.equal(page.entries.length, 2);assert.equal(page.nextOffset, 2);
    console.log('PASS exact UTF-8 edits preserve other text and BOM, original backups, conflict hashes, exclusive creation, binary refusal, copy/move and bounded listing');

    const stopped = new AbortController();stopped.abort();
    await assert.rejects(store.trash('chat-a',grant.id,'notes.txt',appended.hash,stopped.signal),/Stopped/);
    assert.equal(trashCalls,2);
    await assert.rejects(store.write('chat-a', grant.id, 'stopped.txt', 'no', undefined, stopped.signal), /Stopped/);
    const pending = store.write('chat-a', grant.id, 'revoked.txt', 'no', undefined);
    store.revoke('chat-a', grant.id);
    await assert.rejects(pending, /unavailable/);
    assert.equal(fs.existsSync(path.join(root, 'revoked.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'stopped.txt')), false);
    const duringWrite = store.grant('writing-chat', store.inspect(root), 'read-write');
    fs.promises.open = (async (...args: Parameters<typeof nativeOpen>) => {
      const handle = await nativeOpen(...args);
      if (args[1] === 'wx') store.revoke('writing-chat', duringWrite.id);
      return handle;
    }) as typeof nativeOpen;
    try {
      await assert.rejects(store.write('writing-chat', duringWrite.id, 'cancelled-stage.txt', 'not committed', undefined), /unavailable/);
      assert.equal(fs.existsSync(path.join(root, 'cancelled-stage.txt')), false);
      assert.ok(!fs.readdirSync(root).some(name => /^\.nabsun-.*\.tmp$/.test(name)));
    } finally { fs.promises.open = nativeOpen; }
    assert.equal(new LocalFolderStore([profile]).list('chat-a').length, 0);

    let selected: string | null = root, mode: 'read' | 'read-write' | null = null, exists = true, changes = 0;
    const controller = new FolderAccessController(store, { choose: async () => selected, confirm: async () => mode, exists: () => exists, changed: () => { changes++; } });
    assert.equal(await controller.request('chat-a', 'Read a report'), null);
    assert.equal(store.list('chat-a').length, 0);
    selected = null;mode = 'read-write';
    assert.equal(await controller.request('chat-a', 'Read a report'), null);
    selected = root;
    assert.ok(await controller.request('chat-a', 'Read a report'));assert.equal(changes, 1);
    store.clear('chat-a');
    let answer!: (mode: 'read') => void;
    const deferred = new FolderAccessController(store, { choose: async () => root, confirm: () => new Promise(resolve => { answer = resolve; }), exists: () => exists, changed: () => {} });
    const abort = new AbortController(), request = deferred.request('chat-a', 'Pending permission', abort.signal);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(deferred.request('chat-b', 'Second request'), /Another folder request/);
    abort.abort();answer('read');await assert.rejects(request, /stopped/);
    assert.equal(store.list('chat-a').length, 0);
    exists = false;await assert.rejects(controller.request('chat-a', 'Deleted chat'), /stopped/);
    console.log('PASS native picker/consent cancellation, late consent after Stop, deleted chat, single-dialog ownership, revocation and restart expiry');

    const cap = store.grant('chat-a', store.inspect(root), 'read');
    const tools = localFileTools();
    const context = { localFiles: store, fileScope: 'chat-a', signal } as ToolContext;
    const folders = await tools.find(t => t.name === 'local_folders')!.handler({}, context);
    assert.ok(!JSON.stringify(folders).includes(root));
    await assert.rejects(tools.find(t => t.name === 'local_read')!.handler({folderId:cap.id,path:'missing.txt'},context), error => {
      assert.ok(!(error as Error).message.includes(root));return /could not be found/.test((error as Error).message);
    });
    await assert.rejects(tools.find(t => t.name === 'local_read')!.handler({ folderId: cap.id, path: 'notes.txt' }, { ...context, fileScope: null }), /owning chat/);
    let finish!: (value: { kind: string; text: string }) => void;
    const parserContext = { ...context, files: { parseBytes: () => new Promise(resolve => { finish = resolve; }) } } as unknown as ToolContext;
    const late = tools.find(t => t.name === 'local_read')!.handler({ folderId: cap.id, path: 'sample.pdf' }, parserContext);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    store.revoke('chat-a', cap.id);finish({ kind: 'text', text: 'late private content' });
    await assert.rejects(late, /unavailable/);
    const selection = store.inspect(root), pinned = store.grant('pinned-chat', selection, 'read');
    const moved = path.join(outside, 'moved-folder');
    fs.renameSync(root, moved);
    fs.mkdirSync(root);
    assert.throws(() => store.grant('new-chat', selection, 'read'), /folder changed/);
    fs.rmdirSync(root);
    fs.symlinkSync(moved, root, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.entries('pinned-chat', pinned.id), /folder changed/);
    console.log('PASS model results omit absolute paths, external clients cannot claim folder access, and revoked parser results are suppressed');
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixture).startsWith('nabsun-folder-test-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
