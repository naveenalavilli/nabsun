/** Refuse to bundle an inference engine built for a different target. */
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ packager, electronPlatformName, arch }) => {
  const architectures = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
  const target = `${electronPlatformName}-${architectures[arch]}`;
  const manifest = JSON.parse(fs.readFileSync(path.join(packager.info.appDir, 'vendor/llama/.manifest.json'), 'utf8'));
  if (manifest.target !== target) {
    throw new Error(`Bundled engine is ${manifest.target}, but app target is ${target}. Run fetch:model and dist on the matching host architecture.`);
  }
};
