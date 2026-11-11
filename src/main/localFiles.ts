import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { LocalFolder, LocalFolderMode } from '../shared/localFiles';

const MAX_READ = 20 * 1024 * 1024;
const MAX_WRITE = 2 * 1024 * 1024;
const BACKUPS = '.nabsun-backups';
const internalTemporary = (name: string) => /^\.nabsun-[a-f0-9-]{36}\.tmp$/i.test(name);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identity = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a:fs.BigIntStats,b:fs.BigIntStats) => identity(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
function syncDirectory(directory: string) {
  if (process.platform === 'win32') return; // Node cannot fsync Windows directory handles.
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
export function localText(bytes: Buffer): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw Error('This is not a plain-text file.');
  return text;
}
interface Selection { root: string; stat: fs.BigIntStats }
interface Grant extends Selection { id: string; scope: string; mode: LocalFolderMode }

/** In-memory, host-issued capabilities. Tool input can never create a grant. */
export class LocalFolderStore {
  private grants = new Map<string, Grant>();
  private queues = new Map<string, Promise<unknown>>();
  private protectedPaths: string[];
  constructor(protectedPaths: string[] = [], private trashItem?: (file: string) => Promise<void>) {
    this.protectedPaths = protectedPaths.map(p => fs.realpathSync(p));
  }
  private protect(target: string) {
    if (this.protectedPaths.some(p => inside(p, target)))
      throw Error('Nabsun profile files cannot be accessed through folder permissions.');
  }
  inspect(selectedPath: string): Selection {
    const root = fs.realpathSync(selectedPath);
    this.protect(root);
    if (root.split(path.sep).some(part => part.toLowerCase() === BACKUPS || internalTemporary(part)))
      throw Error('Backup and staging folders are protected. Choose the parent folder instead.');
    if (root === path.parse(root).root) throw Error('Choose a specific folder rather than an entire drive.');
    const stat = fs.lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Choose a regular folder.');
    return { root, stat };
  }
  grant(scope: string, selection: Selection, mode: LocalFolderMode): LocalFolder {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(scope) || !['read', 'read-write'].includes(mode)) throw Error('Invalid folder permission.');
    const current = this.inspect(selection.root);
    if (current.root !== selection.root || !identity(current.stat, selection.stat)) throw Error('The folder changed. Choose it again.');
    const prior = [...this.grants.values()].find(g => g.scope === scope && g.root === selection.root);
    if (prior?.mode === mode && identity(prior.stat, current.stat)) return this.info(prior, true);
    if (this.list(scope).length >= 10 && !prior) throw Error('A chat can use up to ten folders. Disconnect one first.');
    if (prior) this.grants.delete(prior.id);
    const grant = { ...current, scope, mode, id: randomUUID() };
    this.grants.set(grant.id, grant);
    return this.info(grant, true);
  }
  private info(grant: Grant, includePath = false): LocalFolder {
    return { id: grant.id, name: path.basename(grant.root), mode: grant.mode, ...(includePath ? { path: grant.root } : {}) };
  }
  list(scope: string, includePaths = false): LocalFolder[] {
    return [...this.grants.values()].filter(g => g.scope === scope).map(g => this.info(g, includePaths));
  }
  revoke(scope: string, id: string) {
    if (this.grants.get(id)?.scope === scope) this.grants.delete(id);
  }
  clear(scope?: string) {
    for (const grant of this.grants.values()) if (!scope || grant.scope === scope) this.grants.delete(grant.id);
  }
  check(scope: string, id: string, signal?: AbortSignal, write = false): Grant {
    if (signal?.aborted) throw Error('Stopped before accessing local files.');
    const grant = this.grants.get(id);
    if (!grant || grant.scope !== scope) throw Error('Folder access is unavailable in this chat. Ask the user to choose a folder.');
    if (write && grant.mode !== 'read-write') throw Error('This folder is read-only. Ask the user for permission to change it.');
    const current = this.inspect(grant.root);
    if (current.root !== grant.root || !identity(current.stat, grant.stat)) throw Error('The approved folder changed. Choose it again.');
    return grant;
  }
  private parts(relative: string, allowRoot: boolean): string[] {
    if (allowRoot && (relative === '.' || relative === '')) return [];
    if (typeof relative !== 'string' || relative.length > 1024 || /[\x00-\x1f\x7f:]/.test(relative) || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative))
      throw Error('Use a relative path inside the chosen folder.');
    const parts = relative.split(/[\\/]/);
    if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || p.toLowerCase() === BACKUPS || internalTemporary(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) || parts.length > 32)
      throw Error('This path is not allowed inside the chosen folder.');
    return parts;
  }
  private target(grant: Grant, relative: string, allowRoot = false, missingLeaf = false) {
    const parts = this.parts(relative, allowRoot);
    let target = grant.root;
    for (let i = 0; i < parts.length; i++) {
      target = path.join(target, parts[i]);
      this.protect(target);
      let stat: fs.BigIntStats;
      try { stat = fs.lstatSync(target, { bigint: true }); }
      catch (error) {
        if (missingLeaf && i === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return { path: target, stat: undefined };
        throw error;
      }
      if (stat.isSymbolicLink()) throw Error('Links and shortcuts to other folders are not followed.');
      const real = fs.realpathSync(target);
      if (!inside(grant.root, real)) throw Error('The file is outside the chosen folder.');
      this.protect(real);
      if (i < parts.length - 1 && !stat.isDirectory()) throw Error('The parent path is not a folder.');
      if (i === parts.length - 1) return { path: target, stat };
    }
    return { path: target, stat: grant.stat };
  }
  private async serial<T>(scope: string, id: string, signal: AbortSignal | undefined, action: (grant: Grant) => Promise<T>, write = false): Promise<T> {
    const key = this.check(scope, id, signal, write).root;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => action(this.check(scope, id, signal, write)));
    this.queues.set(key, next);
    try { return await next; }
    finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  async entries(scope: string, id: string, relative = '.', offset = 0, limit = 100, signal?: AbortSignal) {
    const grant = this.check(scope, id, signal);
    const target = this.target(grant, relative, true);
    if (!target.stat?.isDirectory()) throw Error('Choose a folder to list.');
    offset = Number.isFinite(offset) ? Math.max(0, Math.min(10000, Math.floor(offset))) : 0;
    limit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 100;
    const dir = await fs.promises.opendir(target.path);
    const entries: { name: string; kind: string }[] = [];
    let index = 0, more = false;
    try {
      while (true) {
        this.check(scope, id, signal);
        const entry = await dir.read();
        if (!entry) break;
        if (entry.name.toLowerCase() === BACKUPS || internalTemporary(entry.name)) continue;
        if (index++ < offset) continue;
        if (entries.length === limit) { more = true; break; }
        entries.push({ name: entry.name, kind: entry.isSymbolicLink() ? 'link-not-followed' : entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : 'unavailable' });
      }
    } finally { await dir.close(); }
    this.check(scope, id, signal);
    const after = this.target(grant, relative, true);
    if (!after.stat || !identity(after.stat, target.stat)) throw Error('The folder changed while listing it.');
    const next = offset + entries.length;
    return { entries, nextOffset: more && next <= 10000 ? next : null, truncated: more && next > 10000 };
  }
  private async readGrant(grant: Grant, relative: string, signal?: AbortSignal) {
    const target = this.target(grant, relative);
    if (!target.stat?.isFile() || target.stat.nlink !== 1n || target.stat.size > BigInt(MAX_READ))
      throw Error('Choose a regular file, without hard links, no larger than 20 MB.');
    const handle = await fs.promises.open(target.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!identity(before, target.stat) || before.nlink !== 1n || !before.isFile()) throw Error('The file changed before reading it.');
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= MAX_READ) {
        this.check(grant.scope, grant.id, signal);
        const chunk = Buffer.alloc(Math.min(65536, MAX_READ + 1 - total));
        const result = await handle.read(chunk);
        if (!result.bytesRead) break;
        total += result.bytesRead;
        chunks.push(chunk.subarray(0, result.bytesRead));
      }
      const after = await handle.stat({ bigint: true });
      this.check(grant.scope, grant.id, signal);
      const current = this.target(grant, relative).stat;
      if (total > MAX_READ || !current || !sameVersion(current, after) || current.nlink !== 1n || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.size !== BigInt(total))
        throw Error('The file changed while reading it. Read it again before continuing.');
      const bytes = Buffer.concat(chunks, total);
      return { bytes, hash: hash(bytes), stat: after };
    } finally { await handle.close(); }
  }
  read(scope: string, id: string, relative: string, signal?: AbortSignal) {
    return this.serial(scope, id, signal, grant => this.readGrant(grant, relative, signal));
  }
  private async stage(parent: string, bytes: Buffer, mode = 0o600) {
    const temporary = path.join(parent, '.nabsun-' + randomUUID() + '.tmp');
    const handle = await fs.promises.open(temporary, 'wx', mode);
    try { await handle.writeFile(bytes); await handle.sync(); }
    catch (error) { await handle.close(); await fs.promises.unlink(temporary).catch(() => {}); throw error; }
    await handle.close();
    return temporary;
  }
  private async backup(grant:Grant,relative:string,bytes:Buffer,signal?:AbortSignal) {
    const directory=path.join(grant.root,BACKUPS);
    this.check(grant.scope,grant.id,signal,true);
    if(!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});
    const stat=fs.lstatSync(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(directory)!==directory)throw Error('The backup folder is unavailable. No original was changed.');
    const name=path.basename(relative).replace(/[\x00-\x1f\x7f]/g,'_').slice(0,50);
    const backup=BACKUPS+'/'+Date.now()+'-'+randomUUID()+'-'+name+'.bak';
    const staged=await this.stage(directory,bytes);
    try{this.check(grant.scope,grant.id,signal,true);fs.linkSync(staged,path.join(grant.root,backup))}
    finally{fs.unlinkSync(staged)}
    syncDirectory(directory);syncDirectory(grant.root);
    return backup;
  }
  write(scope:string,id:string,relative:string,text:string,expectedHash:string|undefined,signal?:AbortSignal) {
    return this.save(scope,id,relative,Buffer.from(text,'utf8'),expectedHash,signal,false);
  }
  saveOffice(scope:string,id:string,relative:string,bytes:Buffer,expectedHash:string|undefined,signal?:AbortSignal) {
    if(!/\.(docx|xlsx)$/i.test(relative)||bytes[0]!==0x50||bytes[1]!==0x4b)throw Error('Use the Office editor to save a valid .docx or .xlsx document.');
    return this.save(scope,id,relative,bytes,expectedHash,signal,true);
  }
  private async save(scope: string, id: string, relative: string, payload:Buffer, expectedHash: string | undefined, signal:AbortSignal|undefined,office:boolean) {
    return this.serial(scope, id, signal, async grant => {
      const extension = path.extname(relative).toLowerCase();
      if (!office && /^\.(pdf|xlsx?|xlsm|docx?|pptx?|od[ts]|png|jpe?g|gif|webp|bmp|ico|avif|heic|zip|7z|rar|tar|gz|bz2|mp[34]|mov|avi|wav|flac|ogg|exe|dll|so|dylib|bin|wasm|sqlite3?|db|ttf|woff2?|otf)$/.test(extension))
        throw Error('Save changes as a text, CSV or code file. Binary documents cannot be overwritten by this tool.');
      let bytes = payload;
      const maximum=office?MAX_READ:MAX_WRITE;
      if(bytes.length>maximum)throw Error(office?'Office files are limited to 20 MB.':'Text changes are limited to 2 MB per file.');
      if(!office)localText(bytes);
      const target = this.target(grant, relative, false, true);
      let original: Awaited<ReturnType<LocalFolderStore['readGrant']>> | undefined;
      let backup: string | undefined;
      if (target.stat) {
        if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) throw Error('Read this file first and supply its current hash before changing it.');
        original = await this.readGrant(grant, relative, signal);
        if(!office)localText(original.bytes);
        if (original.hash !== expectedHash) throw Error('This file has changed. Read it again before saving.');
        if (!office && original.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && !bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
          bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
      } else if (expectedHash) throw Error('The original file is missing. Review it before saving.');
      if(bytes.length>maximum)throw Error(office?'Office files are limited to 20 MB.':'Text changes are limited to 2 MB per file.');
      if (original) backup=await this.backup(grant,relative,original.bytes,signal);
      this.check(scope, id, signal, true);
      this.target(grant, relative, false, true);
      const temporary = await this.stage(path.dirname(target.path), bytes, original ? Number(original.stat.mode & 0o777n) : 0o600);
      try {
        let commitStat=original?.stat;
        if (original) {
          const latest = await this.readGrant(grant, relative, signal);
          if (latest.hash !== original.hash || !identity(latest.stat, original.stat)) throw Error('The file changed before saving. No changes were applied.');
          commitStat=latest.stat;
        }
        this.check(scope, id, signal, true);
        const current = this.target(grant, relative, false, true);
        if (original) {
          if (!current.stat || !sameVersion(current.stat, commitStat!)) throw Error('The file changed before saving.');
          fs.renameSync(temporary, target.path);
        } else fs.linkSync(temporary, target.path); // Exclusive creation: never overwrite a new arrival.
        syncDirectory(path.dirname(target.path));
        return { path: relative, hash: hash(bytes), bytes: bytes.length, backup };
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }, true);
  }
  async mkdir(scope: string, id: string, relative: string, signal?: AbortSignal) {
    return this.serial(scope, id, signal, async grant => {
      const target = this.target(grant, relative, false, true);
      if (target.stat) throw Error('A file or folder already exists with that name.');
      this.check(scope, id, signal, true);
      fs.mkdirSync(target.path, { mode: 0o700 });
      syncDirectory(path.dirname(target.path));
      return { path: relative, created: true };
    }, true);
  }
  async edit(scope: string, id: string, relative: string, oldText: string, newText: string, expectedHash: string, signal?: AbortSignal) {
    this.check(scope, id, signal, true);
    const original = await this.read(scope, id, relative, signal);
    if (original.hash !== expectedHash) throw Error('The file changed. Read it again before editing.');
    const text = localText(original.bytes), index = text.indexOf(oldText);
    if (!oldText || index < 0 || text.indexOf(oldText, index + oldText.length) >= 0)
      throw Error('Choose an exact piece of text that appears once in this file.');
    return this.write(scope, id, relative, text.slice(0, index) + newText + text.slice(index + oldText.length), expectedHash, signal);
  }
  async append(scope: string, id: string, relative: string, text: string, expectedHash: string, signal?: AbortSignal) {
    this.check(scope, id, signal, true);
    const original = await this.read(scope, id, relative, signal);
    if (original.hash !== expectedHash) throw Error('The file changed. Read it again before adding text.');
    if (!text) return { path: relative, hash: original.hash, bytes: original.bytes.length, backup: undefined, unchanged: true };
    return this.write(scope, id, relative, localText(original.bytes) + text, expectedHash, signal);
  }
  async trash(scope: string, id: string, relative: string, expectedHash: string, signal?: AbortSignal) {
    return this.serial(scope, id, signal, async grant => {
      if (!this.trashItem) throw Error('Recycle Bin/Trash is unavailable in this build.');
      const original = await this.readGrant(grant, relative, signal);
      if (original.hash !== expectedHash) throw Error('The file changed. Read it again before moving it to Trash.');
      const backup=await this.backup(grant,relative,original.bytes,signal);
      this.check(scope, id, signal, true);
      const target = this.target(grant, relative);
      if (!target.stat || !sameVersion(target.stat, original.stat)) throw Error('The file changed before moving it to Trash.');
      try { await this.trashItem(target.path); }
      catch { throw Error('Could not confirm the move to Recycle Bin/Trash. A backup is kept at '+backup+'. Check the original folder and Trash before retrying.'); }
      return { path: relative, trashed: true, backup };
    }, true);
  }
  async copyOrMove(scope: string, id: string, from: string, to: string, expectedHash: string, move: boolean, signal?: AbortSignal) {
    return this.serial(scope, id, signal, async grant => {
      const original = await this.readGrant(grant, from, signal);
      if (original.hash !== expectedHash) throw Error('The file changed. Read it again before moving or copying it.');
      const destination = this.target(grant, to, false, true);
      if (destination.stat) throw Error('The destination already exists. Choose another name.');
      this.check(scope, id, signal, true);
      this.target(grant, from);
      if (move) {
        const source = this.target(grant, from);
        if (!source.stat || !sameVersion(source.stat, original.stat)) throw Error('The source file changed.');
        fs.linkSync(source.path, destination.path);
        try { fs.unlinkSync(source.path); }
        catch (error) { fs.unlinkSync(destination.path); throw error; }
        syncDirectory(path.dirname(source.path));
      } else {
        const temporary = await this.stage(path.dirname(destination.path), original.bytes, Number(original.stat.mode & 0o777n));
        try { this.check(scope, id, signal, true); this.target(grant, to, false, true); fs.linkSync(temporary, destination.path); }
        finally { fs.unlinkSync(temporary); }
      }
      syncDirectory(path.dirname(destination.path));
      return { from, to, moved: move, hash: original.hash };
    }, true);
  }
}

export interface FolderAccessUI {
  choose(): Promise<string | null>;
  confirm(folder: string, reason: string, scope: string): Promise<LocalFolderMode | null>;
  exists(scope: string): boolean;
  changed(scope: string): void;
}
export class FolderAccessController {
  private busy = false;
  constructor(readonly store: LocalFolderStore, private ui: FolderAccessUI) {}
  async request(scope: string, reason: string, signal?: AbortSignal): Promise<LocalFolder | null> {
    const live = () => { if (signal?.aborted || !this.ui.exists(scope)) throw Error('This chat or folder request has stopped.'); };
    live();
    if (this.busy) throw Error('Another folder request is open. Finish it first.');
    this.busy = true;
    try {
      const chosen = await this.ui.choose();
      live();
      if (!chosen) return null;
      const selection = this.store.inspect(chosen);
      const mode = await this.ui.confirm(selection.root, reason.slice(0, 500), scope);
      live();
      if (!mode) return null;
      const grant = this.store.grant(scope, selection, mode);
      this.ui.changed(scope);
      return grant;
    } finally { this.busy = false; }
  }
}
