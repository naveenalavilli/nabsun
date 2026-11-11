const fs = require('node:fs');
const path = require('node:path');

function prepareBranchRelease({ event, ref, optIn, version, notes }) {
  if (event !== 'workflow_dispatch' || optIn !== 'true' || !ref?.startsWith('refs/heads/') || ['refs/heads/main', 'refs/heads/master'].includes(ref))
    throw Error('Branch publication requires an explicit manual request on a non-main branch.');
  if (!/^\d+\.\d+\.\d+-(?:[a-zA-Z0-9]+)(?:[.-][a-zA-Z0-9]+)*$/.test(version))
    throw Error('Branch releases require a prerelease version, such as 1.0.1-rc.1.');
  const lines = notes.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('## ' + version + ' - '));
  if (start < 0) throw Error('Add this version to RELEASE_NOTES.md before publishing.');
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const entry = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
  if (!entry) throw Error('Release notes must describe the changes.');
  const files = ['Nabsun-' + version + '-x64-setup.exe', 'Nabsun-' + version + '-portable.exe', 'Nabsun-' + version + '-arm64.zip', 'SHA256SUMS.txt'];
  const body = entry + '\n\n### Downloads\n\n'
    + '- **Windows:** ' + files[0] + ' (installer), or ' + files[1] + ' (portable).\n'
    + '- **macOS, Apple silicon:** ' + files[2] + '. No Intel build is included.\n'
    + '- **Checksums:** SHA256SUMS.txt covers all three downloads.\n\n'
    + 'These preview builds are unsigned. Follow the [installation instructions](https://github.com/naveenalavilli/nabsun/blob/v' + version + '/README.md#install) and verify downloads before running them.\n\n'
    + 'Built from a feature branch without merging to main. This prerelease does not replace the latest stable release.\n';
  return { tag: 'v' + version, body, files };
}

module.exports = { prepareBranchRelease };
if (require.main === module) {
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const release = prepareBranchRelease({ event: process.env.RELEASE_EVENT, ref: process.env.RELEASE_REF, optIn: process.env.RELEASE_OPT_IN, version, notes: fs.readFileSync('RELEASE_NOTES.md', 'utf8') });
  for (const file of release.files) {
    const stat = fs.statSync(path.join('release', file));
    if (!stat.isFile() || !stat.size) throw Error('Missing or empty release asset: ' + file);
  }
  fs.writeFileSync('release/BRANCH_RELEASE_NOTES.md', release.body);
  if (!process.env.GITHUB_OUTPUT) throw Error('Missing GitHub Actions output file.');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'tag=' + release.tag + '\n');
}
