const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { compareInstallerPayload, verifySignPathPayload } = require('./signpath-payload.cjs');
const { installerNotice, writeInstallerNotice } = require('./installer-notice.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-signpath-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function binaries({ wide = true, offset = 128, length = 1027 } = {}) {
  const original = Buffer.alloc(length, 0x31);
  original.write('MZ'); original.writeUInt32LE(offset, 60);
  original.writeUInt32LE(0x4550, offset);
  const optional = offset + 24, directory = wide ? 112 : 96;
  original.writeUInt16LE(wide ? 240 : 224, offset + 20);
  original.writeUInt16LE(wide ? 0x20b : 0x10b, optional);
  original.writeUInt32LE(16, optional + directory - 4);
  const checksum = optional + 64, security = optional + directory + 32;
  original.fill(0, security, security + 8);
  const certificate = Math.ceil(length / 8) * 8;
  const signed = Buffer.concat([original, Buffer.alloc(certificate - length + 16)]);
  signed.writeUInt32LE(0x1234, checksum);
  signed.writeUInt32LE(certificate, security); signed.writeUInt32LE(16, security + 4);
  signed.writeUInt32LE(16, certificate); signed.writeUInt16LE(0x200, certificate + 4); signed.writeUInt16LE(2, certificate + 6);
  return { original, signed, security, checksum, certificate };
}
function writePair(directory, data) {
  const original = path.join(directory, 'original.exe'), signed = path.join(directory, 'signed.exe');
  fs.writeFileSync(original, data.original); fs.writeFileSync(signed, data.signed);
  return [original, signed];
}
test('PE comparison accepts only signature/checksum changes for PE32, PE32+ and cross-chunk fields', async t => {
  for (const options of [{ wide: false }, { wide: true }, { offset: 1024 * 1024 - 90, length: 1024 * 1024 + 512 }]) {
    await compareInstallerPayload(...writePair(fixture(t), binaries(options)));
  }
});
test('PE comparison rejects changed code, appended noncertificate bytes, malformed layout and signed inputs', async t => {
  for (const mutation of [
    data => { data.signed[700] ^= 1; },
    data => { data.signed[data.original.length] = 1; },
    data => { data.signed.writeUInt32LE(data.certificate - 8, data.security); },
    data => { data.signed = Buffer.concat([data.signed, Buffer.from('extra')]); },
    data => { data.original.writeUInt32LE(512, data.security); },
    data => { data.signed.writeUInt32LE(0xffff, 60); },
    data => { data.signed.writeUInt16LE(0x123, data.certificate + 6); },
  ]) {
    const data = binaries(); mutation(data);
    await assert.rejects(compareInstallerPayload(...writePair(fixture(t), data)));
  }
});
test('payload reports describe exact final files and never imply application signing', async t => {
  const directory = fixture(t), original = path.join(directory, 'unsigned'), signed = path.join(directory, 'signed');
  fs.mkdirSync(original); fs.mkdirSync(signed);
  const names = ['Nabsun-0.0.0-x64-setup.exe', 'Nabsun-0.0.0-portable.exe'];
  for (const name of names) {
    const data = binaries(); fs.writeFileSync(path.join(original, name), data.original); fs.writeFileSync(path.join(signed, name), data.signed);
  }
  fs.writeFileSync(path.join(signed, 'unexpected.dll'), 'not allowed');
  await assert.rejects(verifySignPathPayload(original, signed, '0.0.0'), /Unexpected/);
  assert(!fs.existsSync(path.join(signed, 'SHA256SUMS.txt')));
  fs.unlinkSync(path.join(signed, 'unexpected.dll'));
  const report = await verifySignPathPayload(original, signed, '0.0.0');
  assert.equal(report.scope, 'installer-envelopes-only');
  assert.deepEqual(report.files.map(file => file.name), names);
  assert(report.files.every(file => file.unsignedSha256 !== file.signedSha256));
  assert.equal(fs.readFileSync(path.join(signed, 'SHA256SUMS.txt'), 'utf8').split('\n').filter(Boolean).length, 2);
  await assert.rejects(verifySignPathPayload(signed, signed, '0.0.0'), /separate/);
});
test('installer notice includes the actual MIT license and privacy text with UTF-8 BOM', t => {
  const root = path.resolve(__dirname, '..');
  const notice = installerNotice(root);
  assert.equal(notice.charCodeAt(0), 0xfeff);
  for (const name of ['LICENSE', 'PRIVACY.md']) assert(notice.includes(fs.readFileSync(path.join(root, name), 'utf8').replace(/\r?\n/g, '\r\n')));
  assert.match(notice, /locally installed agent CLI can still use a cloud model/);
  const directory = fixture(t);
  for (const name of ['LICENSE', 'PRIVACY.md']) fs.copyFileSync(path.join(root, name), path.join(directory, name));
  writeInstallerNotice(directory);
  assert.equal(fs.readFileSync(path.join(directory, 'build/installer-notice.txt'), 'utf8'), notice);
  const config = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  assert.equal(config.nsis.license, 'build/installer-notice.txt');
  assert(config.files.includes('PRIVACY.md') && config.files.includes('CODE_SIGNING.md'));
});
test('SignPath scope has exact names/metadata and no upstream wildcard signing', () => {
  const { DOMParser } = require('@xmldom/xmldom');
  const xml = fs.readFileSync(path.join(__dirname, '../build/signpath/installers.xml'), 'utf8');
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  const files = [...document.getElementsByTagName('pe-file')];
  assert.deepEqual(files.map(file => file.getAttribute('path')), ['Nabsun-${version}-x64-setup.exe', 'Nabsun-${version}-portable.exe']);
  assert(files.every(file => file.getAttribute('product-name') === 'Nabsun' && file.getAttribute('product-version') === '${version}'));
  assert.equal(document.getElementsByTagName('pe-file-set').length, 0);
});
test('SignPath job preserves build origin, service approval, separate outputs and verification before upload', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-signed.yml'), 'utf8'));
  const job = workflow.jobs.signpath;
  assert.equal(job.needs, 'verify'); assert.equal(job.environment, 'signpath');
  assert.equal(job['runs-on'], 'windows-2022');
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
  const request = job.steps.findIndex(step => step.uses?.startsWith('signpath/'));
  const input = job.steps.findIndex(step => step.id === 'signpath-input');
  const verify = job.steps.findIndex(step => step.run === './scripts/verify-signpath-installers.ps1');
  const output = job.steps.findIndex(step => step.name === 'Upload verified envelope-only candidates');
  assert(input < request && request < verify && verify < output);
  assert.equal(job.steps[request].with['wait-for-completion'], true);
  assert.equal(job.steps[request].with['output-artifact-directory'], 'release/signpath-signed');
  assert.match(job.steps[request].with['github-artifact-id'], /signpath-input.outputs.artifact-id/);
  assert(job.steps.some(step => step.run?.includes("SIGNPATH_APPROVED_SCOPE -ne 'installer-envelopes-only'")));
  assert(!job.steps.some(step => step.uses?.includes('action-gh-release')));
  assert.equal(job.steps[output].if, undefined);
});

test('PowerShell SignPath entry point retains its publisher and invokes payload verification', { skip: process.platform !== 'win32' }, t => {
  const directory = fixture(t), original = path.join(directory, 'unsigned'), signed = path.join(directory, 'signed');
  fs.mkdirSync(original); fs.mkdirSync(signed);
  const version = require('../package.json').version;
  for (const name of [`Nabsun-${version}-x64-setup.exe`, `Nabsun-${version}-portable.exe`]) {
    const data = binaries(); fs.writeFileSync(path.join(original, name), data.original); fs.writeFileSync(path.join(signed, name), data.signed);
  }
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const script = `
    $ErrorActionPreference = 'Stop'
    function Get-AuthenticodeSignature {
      param($LiteralPath)
      $certificate = [PSCustomObject]@{ Name = 'Test Foundation' }
      $certificate | Add-Member ScriptMethod GetNameInfo { param($kind, $issuer) return $this.Name }
      return [PSCustomObject]@{ Status = 'Valid'; SignerCertificate = $certificate; TimeStamperCertificate = $certificate }
    }
    & ${quote(path.join(__dirname,'verify-signpath-installers.ps1'))} -OriginalDir ${quote(original)} -SignedDir ${quote(signed)} -Publisher 'Test Foundation'
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    { encoding:'utf8', windowsHide:true, timeout:30000, env:{...process.env,WINDOWS_SIGNING_PUBLISHER:'Different Azure Publisher'} });
  assert.equal(result.status,0,result.stderr || String(result.error));
  assert.equal(JSON.parse(fs.readFileSync(path.join(signed,'SIGNING-REPORT.json'),'utf8')).scope,'installer-envelopes-only');
});
