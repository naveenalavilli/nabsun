const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const yaml = require('js-yaml');
const { windowsSigningConfig } = require('./windows-signing-config.cjs');

const root = path.resolve(__dirname, '..');
const settings = {
  WINDOWS_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
  WINDOWS_SIGNING_ACCOUNT: 'nabsun-test', WINDOWS_SIGNING_PROFILE: 'public-test',
  WINDOWS_SIGNING_PUBLISHER: 'Example Publisher',
};

test('signing requires all settings and accepts only regional public Azure endpoints', () => {
  for (const name of Object.keys(settings)) {
    const env = { ...settings }; delete env[name];
    assert.throws(() => windowsSigningConfig(env), new RegExp(name));
  }
  for (const endpoint of ['http://eus.codesigning.azure.net', 'https://evil.example',
    'https://eus.codesigning.azure.net.evil.example', 'https://user@eus.codesigning.azure.net',
    'https://eus.codesigning.azure.net/path', 'https://eus.codesigning.azure.net?x=1']) {
    assert.throws(() => windowsSigningConfig({ ...settings, WINDOWS_SIGNING_ENDPOINT: endpoint }));
  }
  assert.throws(() => windowsSigningConfig({ ...settings, WINDOWS_SIGNING_PROFILE: "bad'; value" }));
});

test('signed configuration validates against installed builder and preserves both targets without publishing', async () => {
  const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { DebugLogger } = require('builder-util');
  const previous = {};
  let config;
  try {
    for (const [key, value] of Object.entries(settings)) {
      previous[key] = process.env[key]; process.env[key] = value;
    }
    config = await getConfig(root, 'electron-builder.windows-signed.cjs', null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  await validateConfiguration(config, new DebugLogger(false));
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.publish, null);
  assert.equal(config.win.publish, null);
  assert.deepEqual(config.win.target.map(target => target.target), ['nsis', 'portable']);
  assert.deepEqual(config.win.signExts, ['.dll']);
  assert.equal(config.win.azureSignOptions.publisherName, settings.WINDOWS_SIGNING_PUBLISHER);
  assert.equal(config.win.azureSignOptions.timestampDigest, 'SHA256');
  const development = await getConfig(root, 'electron-builder.ci.yml', null);
  assert.equal(development.forceCodeSigning, undefined);
  assert.equal(development.win.azureSignOptions, undefined);
});

const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/windows-signed.yml'), 'utf8'));
test('signed candidates require verification, scoped identity and explicit dispatch, and cannot publish a release', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.jobs.verify.permissions, undefined);
  const job = workflow.jobs.sign;
  assert.equal(job.needs, 'verify');
  assert.equal(job.environment, 'windows-signing');
  assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' });
  assert(workflow.jobs.verify.steps.some(step => step.run === 'npm run verify'));
  const build = job.steps.findIndex(step => step.name === 'Build signed setup and portable packages');
  const check = job.steps.findIndex(step => step.run === './scripts/verify-windows-signatures.ps1');
  const upload = job.steps.findIndex(step => step.uses === 'actions/upload-artifact@v4');
  assert(build < check && check < upload);
  assert.match(job.steps[build].run, /--publish never/);
  assert(!job.steps.some(step => /action-gh-release/.test(step.uses ?? '')));
});

// Windows tests exercise the actual PowerShell verification gate. Successful
// signatures are mocked; public-trust signing still needs the Azure identity.
const windows = process.platform === 'win32';
const quote = value => "'" + value.replace(/'/g, "''") + "'";
const version = require('../package.json').version;
const names = [`Nabsun-${version}-x64-setup.exe`, `Nabsun-${version}-portable.exe`];
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-signing-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(directory, 'win-unpacked/resources/vendor/llama'), { recursive: true });
  for (const name of [...names, 'win-unpacked/Nabsun.exe', 'win-unpacked/resources/vendor/llama/llama-server.exe',
    'win-unpacked/resources/vendor/llama/ggml.dll']) fs.writeFileSync(path.join(directory, name), name);
  return directory;
}
function run(directory, scenario) {
  const script = `
    $ErrorActionPreference = 'Stop'
    . ${quote(path.join(__dirname, 'verify-windows-signatures.ps1'))}
    ${scenario === 'real' ? '' : `
      function Get-AuthenticodeSignature {
        param([string]$LiteralPath)
        $certificate = [PSCustomObject]@{ Name = 'Example Publisher' }
        $certificate | Add-Member ScriptMethod GetNameInfo { param($kind, $issuer) return $this.Name }
        $status = 'Valid'
        $timestamp = [PSCustomObject]@{ Subject = 'Test timestamp' }
        if (${quote(scenario)} -eq 'wrong-publisher') { $certificate.Name = 'Someone Else' }
        if (${quote(scenario)} -eq 'no-timestamp') { $timestamp = $null }
        if (${quote(scenario)} -eq 'tampered-nested' -and $LiteralPath.EndsWith('ggml.dll')) { $status = 'HashMismatch' }
        return [PSCustomObject]@{ Status = $status; SignerCertificate = $certificate; TimeStamperCertificate = $timestamp }
      }
    `}
    Test-NabsunWindowsRelease ${quote(directory)} 'Example Publisher'
  `;
  const shell = process.env.NABSUN_TEST_PWSH || (process.env.CI ? 'pwsh' : 'powershell.exe');
  return spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
}

test('signature gate rejects real unsigned files and mocked wrong publisher, missing timestamp and tampered nested DLL', { skip: !windows }, t => {
  for (const scenario of ['real', 'wrong-publisher', 'no-timestamp', 'tampered-nested']) {
    const directory = fixture(t);
    const result = run(directory, scenario);
    assert.notEqual(result.status, 0, scenario);
    assert.match(result.stderr, /Invalid Authenticode|Publisher mismatch|Trusted timestamp missing/, result.stderr);
    assert.equal(fs.existsSync(path.join(directory, 'SHA256SUMS.txt')), false);
  }
});

test('signature gate rejects missing portable package and hashes final bytes only after all checks', { skip: !windows }, t => {
  const directory = fixture(t);
  const portable = path.join(directory, names[1]);
  fs.unlinkSync(portable);
  const missing = run(directory, 'valid');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Signed file missing/);
  assert.equal(fs.existsSync(path.join(directory, 'SHA256SUMS.txt')), false);
  fs.writeFileSync(portable, 'final signed bytes fixture');
  const valid = run(directory, 'valid');
  assert.equal(valid.status, 0, valid.stderr || String(valid.error));
  const sums = fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'ascii');
  for (const name of names) assert(sums.includes(`${createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')}  ${name}`));
});
