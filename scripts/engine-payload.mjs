import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const MANIFEST_SCHEMA = 2;

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Record links themselves, rather than silently omitting dylib aliases. */
export async function buildEngineManifest(dir, metadata) {
  const files = {};
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (rel === '.manifest.json') continue;
      if (entry.isDirectory()) await visit(full);
      else if (entry.isSymbolicLink()) files[rel] = { link: await fs.readlink(full) };
      else if (entry.isFile()) files[rel] = { bytes: (await fs.stat(full)).size, sha256: await digest(full) };
    }
  }
  await visit(dir);
  return { ...metadata, schema: MANIFEST_SCHEMA, files };
}

export async function verifyEngineManifest(dir, manifest, { linksOnly = false } = {}) {
  if (manifest.schema !== MANIFEST_SCHEMA || !Object.keys(manifest.files ?? {}).length) {
    return ['engine manifest is outdated or empty; run npm run fetch:model'];
  }
  const canonicalDir = await fs.realpath(dir);
  const problems = [];
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const full = path.join(dir, rel);
    try {
      if ('link' in expected) {
        if (await fs.readlink(full) !== expected.link) throw new Error('link target changed');
        const resolved = await fs.realpath(full);
        const relative = path.relative(canonicalDir, resolved);
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
          throw new Error('link leaves engine directory');
        }
        if (!(await fs.stat(full)).isFile()) throw new Error('link is not a file');
      } else if (!linksOnly) {
        const stat = await fs.stat(full);
        if (!stat.isFile() || stat.size !== expected.bytes || await digest(full) !== expected.sha256) {
          throw new Error('file contents changed');
        }
      }
    } catch (err) {
      problems.push(`${rel}: ${err.message}`);
    }
  }
  return problems;
}

/** Exercise the native loader, including dependencies not listed explicitly. */
export function assertEngineStarts(server) {
  // A freshly signed Mac payload can spend tens of seconds in the OS loader
  // on its first launch, before llama.cpp has executed any application code.
  execFileSync(server, ['--version'], { timeout: 60_000, windowsHide: true, stdio: 'pipe' });
}

/** Weights remain usable with a manually installed engine on other platforms. */
export async function preparePayload({ engineAvailable, fetchEngine, fetchModel, fetchLicenses }) {
  if (engineAvailable) await fetchEngine();
  await fetchModel();
  await fetchLicenses();
  return engineAvailable;
}
