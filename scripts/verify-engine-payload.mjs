import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildEngineManifest, verifyEngineManifest, assertEngineStarts, preparePayload } from './engine-payload.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nabsun-engine-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('changed engine files and old manifests are rejected', async t => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, 'engine'), 'original');
  const manifest = await buildEngineManifest(dir, { target: 'test', version: 'test' });
  assert.deepEqual(await verifyEngineManifest(dir, manifest), []);
  await fs.writeFile(path.join(dir, 'engine'), 'modified');
  assert.match((await verifyEngineManifest(dir, manifest)).join(), /engine/);
  assert.match((await verifyEngineManifest(dir, { files: manifest.files })).join(), /outdated/);
});

test('missing, redirected and dangling dylib aliases are rejected', { skip: process.platform === 'win32' }, async t => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, 'lib.1.dylib'), 'library');
  const alias = path.join(dir, 'lib.dylib');
  await fs.symlink('lib.1.dylib', alias);
  const manifest = await buildEngineManifest(dir, { target: 'test', version: 'test' });
  assert.deepEqual(await verifyEngineManifest(dir, manifest), []);
  await fs.unlink(alias);
  assert.match((await verifyEngineManifest(dir, manifest)).join(), /lib.dylib/);
  await fs.writeFile(path.join(dir, 'other.dylib'), 'library');
  await fs.symlink('other.dylib', alias);
  assert.match((await verifyEngineManifest(dir, manifest)).join(), /link target changed/);
  await fs.unlink(alias);
  await fs.symlink('lib.1.dylib', alias);
  await fs.unlink(path.join(dir, 'lib.1.dylib'));
  // Packaged Mach-O bytes can change during signing, but links must still work.
  assert.match((await verifyEngineManifest(dir, manifest, { linksOnly: true })).join(), /lib.dylib/);
});

test('the startup probe catches a missing native macOS dependency', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fixture(t);
  const dir = path.join(root, 'vendor', 'llama');
  await fs.mkdir(dir, { recursive: true });
  const source = path.join(dir, 'fixture.c');
  const library = path.join(dir, 'libfixture.dylib');
  const server = path.join(dir, 'llama-server');
  await fs.writeFile(source, 'int fixture(void) { return 0; }');
  execFileSync('cc', ['-dynamiclib', source, '-o', library, '-Wl,-install_name,@loader_path/libfixture.dylib']);
  await fs.writeFile(source, 'extern int fixture(void); int main(void) { return fixture(); }');
  execFileSync('cc', [source, library, '-o', server]);
  assert.doesNotThrow(() => assertEngineStarts(server));
  // A complete source payload must fail the real release gate when a required
  // dylib alias disappears, even though all of the versioned files remain.
  const backing = path.join(dir, 'libfixture.1.dylib');
  await fs.rename(library, backing);
  await fs.symlink('libfixture.1.dylib', library);
  await fs.mkdir(path.join(root, 'scripts'));
  for (const name of ['check-release-payload.mjs', 'engine-payload.mjs']) {
    await fs.copyFile(new URL(name, import.meta.url), path.join(root, 'scripts', name));
  }
  const files = {
    'vendor/llama/libllama-server-impl.dylib': 1_000_000,
    'vendor/llama/libggml-base.dylib': 100_000,
    'vendor/llama/LICENSE-llama.cpp.txt': 1_000,
    'vendor/models/Qwen3-1.7B-Q4_K_M.gguf': 1_000_000_000,
    'vendor/models/LICENSE-Apache-2.0.txt': 6_000,
    'vendor/models/MODEL-LICENSE.txt': 1_000,
    'THIRD-PARTY-NOTICES.md': 1_000,
    'LICENSE': 1_000,
  };
  for (const [rel, size] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, '');
    await fs.truncate(full, size); // sparse fixture; no model download required
  }
  const manifest = await buildEngineManifest(dir, { version: 'fixture', target: `${process.platform}-${process.arch}` });
  await fs.writeFile(path.join(dir, '.manifest.json'), JSON.stringify(manifest));
  const gate = () => spawnSync(process.execPath, [path.join(root, 'scripts/check-release-payload.mjs')], { encoding: 'utf8' });
  let result = gate();
  assert.equal(result.status, 0, result.stderr);
  await fs.unlink(library);
  assert.throws(() => assertEngineStarts(server));
  result = gate();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /libfixture.dylib/);
  // An unlisted dependency is still caught by the loader probe.
  delete manifest.files['libfixture.dylib'];
  await fs.writeFile(path.join(dir, '.manifest.json'), JSON.stringify(manifest));
  result = gate();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /engine cannot start/);
});

test('unsupported platforms still fetch portable weights and licences', async () => {
  const calls = [];
  const complete = await preparePayload({
    engineAvailable: false,
    fetchEngine: async () => { throw new Error('must not fetch a foreign engine'); },
    fetchModel: async () => calls.push('model'),
    fetchLicenses: async () => calls.push('licences'),
  });
  assert.equal(complete, false);
  assert.deepEqual(calls, ['model', 'licences']);
});

test('supported platforms fetch the engine before weights and licences', async () => {
  const calls = [];
  assert.equal(await preparePayload({
    engineAvailable: true,
    fetchEngine: async () => calls.push('engine'),
    fetchModel: async () => calls.push('model'),
    fetchLicenses: async () => calls.push('licences'),
  }), true);
  assert.deepEqual(calls, ['engine', 'model', 'licences']);
});
