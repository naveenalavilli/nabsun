const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function exact(handle, size, position) {
  const buffer = Buffer.alloc(size);
  const { bytesRead } = await handle.read(buffer, 0, size, position);
  if (bytesRead !== size) throw Error('Truncated PE file');
  return buffer;
}
async function pe(handle, size) {
  const dos = await exact(handle, 64, 0);
  if (dos.toString('ascii', 0, 2) !== 'MZ') throw Error('Not a PE file');
  const offset = dos.readUInt32LE(60);
  if (offset < 64 || offset > size - 26) throw Error('Invalid PE header offset');
  const header = await exact(handle, 26, offset);
  if (header.readUInt32LE(0) !== 0x4550) throw Error('Invalid PE signature');
  const optionalSize = header.readUInt16LE(20), magic = header.readUInt16LE(24);
  const directoryStart = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
  if (!directoryStart || optionalSize < directoryStart + 40 || offset + 24 + optionalSize > size) throw Error('Invalid PE optional header');
  const optional = await exact(handle, optionalSize, offset + 24);
  if (optional.readUInt32LE(directoryStart - 4) < 5) throw Error('PE security directory missing');
  const security = offset + 24 + directoryStart + 32;
  return { checksum: offset + 24 + 64, security,
    certificate: optional.readUInt32LE(directoryStart + 32),
    certificateSize: optional.readUInt32LE(directoryStart + 36) };
}

/** Only Authenticode metadata and an aligned end-of-file certificate may change. */
async function compareInstallerPayload(original, signed) {
  for (const file of [original, signed]) {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Installer must be a regular file');
  }
  const left = await fsp.open(original, 'r');
  let right;
  try {
    right = await fsp.open(signed, 'r');
    const originalSize = (await left.stat()).size, signedSize = (await right.stat()).size;
    const before = await pe(left, originalSize), after = await pe(right, signedSize);
    if (before.certificate || before.certificateSize) throw Error('Expected unsigned input installer');
    if (before.checksum !== after.checksum || before.security !== after.security) throw Error('PE layout changed');
    if (!after.certificate || after.certificate % 8 || after.certificateSize < 8 ||
        after.certificate + after.certificateSize !== signedSize ||
        after.certificate < originalSize || after.certificate > Math.ceil(originalSize / 8) * 8) {
      throw Error('Invalid appended certificate range');
    }
    const padding = await exact(right, after.certificate - originalSize, originalSize);
    if (padding.some(byte => byte !== 0)) throw Error('Nonzero data appended before certificate');
    const certificate = await exact(right, 8, after.certificate);
    if (certificate.readUInt32LE(0) < 8 || certificate.readUInt32LE(0) > after.certificateSize ||
        certificate.readUInt16LE(4) !== 0x200 || certificate.readUInt16LE(6) !== 2) throw Error('Invalid certificate header');
    for (let position = 0; position < originalSize; position += 1024 * 1024) {
      const size = Math.min(1024 * 1024, originalSize - position);
      const a = await exact(left, size, position), b = await exact(right, size, position);
      for (const [start, length] of [[before.checksum, 4], [before.security, 8]]) {
        const first = Math.max(start, position) - position;
        const last = Math.min(start + length, position + size) - position;
        if (last > first) { a.fill(0, first, last); b.fill(0, first, last); }
      }
      if (!a.equals(b)) throw Error('Installer payload changed during signing');
    }
  } finally {
    await left.close();
    if (right) await right.close();
  }
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function verifySignPathPayload(originalDir, signedDir, version) {
  if (path.resolve(originalDir) === path.resolve(signedDir)) throw Error('Signed output must be separate from unsigned input');
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw Error('Invalid package version');
  const names = [`Nabsun-${version}-x64-setup.exe`, `Nabsun-${version}-portable.exe`];
  const extras = (await fsp.readdir(signedDir)).filter(name => !names.includes(name) && !['SHA256SUMS.txt', 'SIGNING-REPORT.json'].includes(name));
  if (extras.length) throw Error('Unexpected files in signed output');
  const files = [];
  for (const name of names) {
    const original = path.join(originalDir, name), signed = path.join(signedDir, name);
    await compareInstallerPayload(original, signed);
    files.push({ name, unsignedSha256: await sha256(original), signedSha256: await sha256(signed) });
  }
  const report = { version, scope: 'installer-envelopes-only', sourceCommit: process.env.GITHUB_SHA ?? null, files };
  await fsp.writeFile(path.join(signedDir, 'SHA256SUMS.txt'), files.map(file => `${file.signedSha256}  ${file.name}\n`).join(''));
  await fsp.writeFile(path.join(signedDir, 'SIGNING-REPORT.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
module.exports = { compareInstallerPayload, verifySignPathPayload };
if (require.main === module) {
  verifySignPathPayload(process.argv[2], process.argv[3], require('../package.json').version)
    .then(() => console.log('Verified signed installer payloads; final checksums recorded.'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
