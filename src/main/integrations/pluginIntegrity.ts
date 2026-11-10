import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PluginManifest } from '../../shared/types';
export interface PluginSource {
  dir: string;
  manifest: PluginManifest;
  fingerprint: string;
  files: string[];
}
export function validatePluginStorage(dir: string) {
  let entries = 0;
  const walk = (folder: string, depth = 0) => {
    if (depth > 64 || fs.lstatSync(folder).isSymbolicLink())
      throw Error('Plugin storage cannot contain links or excessive nesting.');
    const directory = fs.opendirSync(folder);
    try {
      for (
        let entry = directory.readSync();
        entry;
        entry = directory.readSync()
      ) {
        if (++entries > 10000)
          throw Error('Plugin storage contains too many files.');
        const file = path.join(folder, entry.name),
          stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink > 1))
          throw Error('Plugin storage cannot contain symbolic or hard links.');
        if (stat.isDirectory()) walk(file, depth + 1);
        else if (!stat.isFile())
          throw Error('Unsupported plugin storage entry.');
      }
    } finally {
      directory.closeSync();
    }
  };
  walk(dir);
}
export function inspectPlugin(dir: string): PluginSource {
  if (fs.lstatSync(dir).isSymbolicLink())
    throw Error('Plugin directories cannot be links.');
  dir = fs.realpathSync(dir);
  let bytes = 0,
    entries = 0;
  const files: string[] = [];
  const walk = (folder: string, depth = 0) => {
    if (depth > 64) throw Error('Plugin directory nesting is too deep.');
    const directory = fs.opendirSync(folder),
      children: fs.Dirent[] = [];
    try {
      for (
        let entry = directory.readSync();
        entry;
        entry = directory.readSync()
      ) {
        if (++entries > 10000)
          throw Error('Plugin source contains too many directory entries.');
        children.push(entry);
      }
    } finally {
      directory.closeSync();
    }
    for (const entry of children.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (folder === dir && entry.name === '.storage') continue;
      const file = path.join(folder, entry.name),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (stat.nlink > 1 && !stat.isDirectory()))
        throw Error('Plugin files cannot be symbolic or hard links.');
      if (stat.isDirectory()) walk(file, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 50 * 1024 * 1024 || files.length >= 5000)
          throw Error('Plugin source exceeds 50 MB or 5000 files.');
        files.push(path.relative(dir, file));
      } else throw Error('Unsupported plugin file type.');
    }
  };
  walk(dir);
  const fingerprint = hashFiles(dir, files);
  const manifest = JSON.parse(
    readSource(path.join(dir, 'plugin.json'), 65536).toString('utf8'),
  ) as PluginManifest;
  if (
    !manifest ||
    typeof manifest.id !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,63}$/i.test(manifest.id) ||
    typeof manifest.name !== 'string' ||
    !manifest.name ||
    manifest.name.length > 120 ||
    typeof manifest.version !== 'string' ||
    manifest.version.length > 50 ||
    typeof manifest.main !== 'string' ||
    path.isAbsolute(manifest.main)
  )
    throw Error('Invalid plugin manifest.');
  const entry = path.resolve(dir, manifest.main);
  if (
    !entry.startsWith(dir + path.sep) ||
    !files.includes(path.relative(dir, entry))
  )
    throw Error('Plugin entry must be a contained source file.');
  return { dir, manifest, fingerprint, files };
}
function hashFiles(dir: string, files: string[]) {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const name of files) {
    const data = readSource(path.join(dir, name), 50 * 1024 * 1024 - bytes);
    bytes += data.length;
    hash.update(JSON.stringify(name.replaceAll('\\', '/')));
    hash.update('\0');
    hash.update(String(data.length));
    hash.update('\0');
    hash.update(data);
  }
  return hash.digest('hex');
}
function readSource(file: string, budget: number) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1 || stat.size > budget)
      throw Error('Plugin source changed or exceeds its limit.');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!count) throw Error('Plugin source changed while reading.');
      offset += count;
    }
    if (fs.fstatSync(fd).size !== stat.size)
      throw Error('Plugin source changed while reading.');
    return data;
  } finally {
    fs.closeSync(fd);
  }
}
/** Immutable source snapshot: the plugin only receives a separate storage grant. */
export function stagePlugin(cache: string, source: PluginSource) {
  const stage = path.join(cache, randomUUID());
  fs.mkdirSync(stage, { recursive: true });
  let bytes = 0;
  for (const name of source.files) {
    const target = path.join(stage, name),
      data = readSource(path.join(source.dir, name), 50 * 1024 * 1024 - bytes);
    bytes += data.length;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: 0o600, flag: 'wx' });
  }
  const snapshot = inspectPlugin(stage);
  if (snapshot.fingerprint !== source.fingerprint)
    throw Error(
      'Plugin changed while preparing its isolated host. Review it again.',
    );
  return snapshot;
}
