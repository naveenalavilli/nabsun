const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const yaml = require('js-yaml');

const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/verify.yml'), 'utf8'));
const job = workflow.jobs.package;
const installers = job.steps.find(step => step.id === 'installers');
const upload = job.steps.find(step => step.id === 'upload-installers');
const summary = job.steps.find(step => step.name === 'Show package download');

test('releases wait for real native connection checks on all supported operating systems', () => {
  const connections = workflow.jobs['verify-connections'];
  assert.deepEqual(connections.strategy.matrix.os, ['windows-2022', 'macos-latest', 'ubuntu-latest']);
  assert(connections.steps.some(step => step.run === 'npm run verify:connections:native'));
  assert(connections.steps.some(step => step.run?.includes('connection-harness.js')));
  assert(connections.steps.some(step => step.run?.includes('xvfb-run')));
  for (const name of ['package', 'package-macos']) assert([workflow.jobs[name].needs].flat().includes('verify-connections'));
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-artifact-test-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, 'release'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.0.0-ci' }));
  return dir;
}

function runStep(dir, step, env = {}) {
  const script = path.join(dir, 'step.ps1');
  fs.writeFileSync(script, "$ErrorActionPreference = 'Stop'\n" + step.run);
  return spawnSync(process.env.NABSUN_TEST_PWSH || 'pwsh', ['-NoProfile', '-File', script], {
    cwd: dir, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, ...env, GITHUB_OUTPUT: path.join(dir, 'outputs.txt'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') },
  });
}

test('successful package jobs must upload both installers and checksums on every trigger', () => {
  // `needs` is a bare string with one dependency and a list with several, so
  // adding a platform to the gate changed its type and failed a test that is
  // really about uploads. What matters is that packaging waits for the
  // verification jobs, not how many there are.
  const needs = [job.needs].flat();
  assert.ok(
    needs.includes('verify'),
    `package must wait for the verify job; needs = ${JSON.stringify(job.needs)}`,
  );
  assert.equal(upload.if, undefined);
  assert.notEqual(upload['continue-on-error'], true);
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.match(upload.with.path, /-x64-setup\.exe/);
  assert.match(upload.with.path, /-portable\.exe/);
  assert.match(upload.with.path, /SHA256SUMS\.txt/);
  assert.ok(job.steps.indexOf(installers) < job.steps.indexOf(upload));
});

/** Everything a release ships, as the checksum step expects to find it. */
const ARTIFACTS = [
  'Nabsun-0.0.0-ci-x64-setup.exe',
  'Nabsun-0.0.0-ci-portable.exe',
  // Built on the macOS runner and downloaded into release/ before this step.
  'Nabsun-0.0.0-ci-arm64.zip',
];

test('the workflow generates correct checksums for every artifact it ships', t => {
  const dir = fixture(t);
  for (const name of ARTIFACTS) fs.writeFileSync(path.join(dir, 'release', name), name);
  const result = runStep(dir, installers);
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const hashes = fs.readFileSync(path.join(dir, 'release/SHA256SUMS.txt'), 'utf8');
  for (const name of ARTIFACTS) {
    assert.ok(
      hashes.includes(`${createHash('sha256').update(name).digest('hex')}  ${name}`),
      `no checksum for ${name} in:\n${hashes}`,
    );
  }
  assert.match(fs.readFileSync(path.join(dir, 'outputs.txt'), 'utf8'), /version=0\.0\.0-ci/);
});

test('a missing or empty portable installer fails even if setup exists', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'release/Nabsun-0.0.0-ci-x64-setup.exe'), 'setup');
  for (const empty of [false, true]) {
    if (empty) fs.writeFileSync(path.join(dir, 'release/Nabsun-0.0.0-ci-portable.exe'), '');
    const result = runStep(dir, installers);
    assert.equal(result.status, 1, String(result.error));
    assert.match(result.stderr, empty ? /Installer is empty/ : /Expected installer missing/);
    assert.equal(fs.existsSync(path.join(dir, 'outputs.txt')), false);
  }
});

test('a missing macOS archive fails the release, like a missing installer', t => {
  // The archive is built on another runner and downloaded in. If that job is
  // removed or its upload silently stops matching, the release must fail rather
  // than quietly go out Windows-only.
  const dir = fixture(t);
  for (const name of ARTIFACTS.filter(n => n.endsWith('.exe'))) {
    fs.writeFileSync(path.join(dir, 'release', name), name);
  }
  const result = runStep(dir, installers);
  assert.equal(result.status, 1, String(result.error));
  assert.match(result.stderr, /Expected installer missing/);
  assert.match(result.stderr, /arm64\.zip/);
});

test('the summary links successful uploads and reports failed uploads honestly', t => {
  for (const outcome of ['success', 'failure']) {
    const dir = fixture(t);
    const url = 'https://github.com/example/test/actions/runs/1/artifacts/2';
    const result = runStep(dir, summary, { UPLOAD_OUTCOME: outcome, INSTALLER_URL: url, PACKAGE_VERSION: '0.0.0-ci' });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const markdown = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
    if (outcome === 'success') assert.ok(markdown.includes(`](${url})`));
    else {
      assert.match(markdown, /No downloadable package was uploaded/);
      assert.equal(markdown.includes(url), false);
    }
  }
});
