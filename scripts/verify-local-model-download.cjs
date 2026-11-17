const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, session } = require('electron');
const { build } = require('esbuild');
const modelPin = require('../src/shared/localModel.json');

async function main() {
  const packaging = fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf8');
  assert.match(packaging, /!models\/\*\.gguf/, 'release packaging must exclude optional GGUF weights');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-model-download-'));
  app.setPath('userData', root);
  const bundle = await build({
    entryPoints: [path.join(__dirname, '../src/main/localModelDownload.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  const modulePath = path.join(root, 'local-model-download.cjs');
  fs.writeFileSync(modulePath, bundle.outputFiles[0].contents);
  const { LocalModelDownload, safeDownloadHost } = require(modulePath);
  await app.whenReady();

  assert.equal(safeDownloadHost('https://huggingface.co/model'), true);
  assert.equal(safeDownloadHost('https://cdn-lfs.huggingface.co/file'), true);
  assert.equal(safeDownloadHost('https://us.aws.cdn.hf.co/file?token=fixture'), true);
  assert.equal(safeDownloadHost('https://cas-bridge.xethub.hf.co/file?token=fixture'), true);
  for (const url of ['http://huggingface.co/model', 'https://huggingface.co.evil.test/model', 'https://cdn.hf.co.evil.test/file', 'https://user@huggingface.co/model', 'file:///tmp/model']) {
    assert.equal(safeDownloadHost(url), false, url);
  }

  let existing = null;
  const manager = new LocalModelDownload(root, session.defaultSession, () => existing);
  assert.equal(manager.status().state, 'available');
  fs.writeFileSync(manager.partialPath, 'partial verified only after completion');
  assert.equal(manager.status().downloadedBytes, 38);
  assert.equal(manager.providerModelPath().endsWith('.not-installed'), true);
  await manager.remove();
  assert.equal(fs.existsSync(manager.partialPath), false);

  const custom = path.join(root, 'custom.gguf');
  fs.writeFileSync(custom, 'custom');
  existing = { path: custom, source: 'custom' };
  assert.equal(manager.status().source, 'custom');
  await assert.rejects(() => manager.remove(), /bundled or custom/);
  existing = null;

  fs.mkdirSync(manager.directory, { recursive: true });
  fs.writeFileSync(manager.modelPath, '');
  fs.truncateSync(manager.modelPath, modelPin.bytes);
  fs.writeFileSync(`${manager.modelPath}.verified.json`, JSON.stringify({
    file: modelPin.file, bytes: modelPin.bytes,
    sha256: modelPin.sha256, revision: modelPin.revision,
  }));
  const restored = new LocalModelDownload(root, session.defaultSession, () => null);
  assert.equal(restored.status().state, 'ready');
  assert.equal(restored.status().source, 'managed');
  assert.equal(restored.providerModelPath(), restored.modelPath);

  fs.writeFileSync(`${manager.modelPath}.verified.json`, '{}');
  const unverified = new LocalModelDownload(root, session.defaultSession, () => null);
  assert.equal(unverified.status().state, 'available');
  assert.equal(unverified.providerModelPath().endsWith('.not-installed'), true);
  console.log('PASS optional model status, compatibility priority, verified receipt, safe fallback, removal and redirect allowlist');
  for (const file of [manager.modelPath, `${manager.modelPath}.verified.json`, custom, modulePath]) {
    fs.rmSync(file, { force: true });
  }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
