const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { getConfig } = require('app-builder-lib/out/util/config/config');
const { createPublisher, getPublishConfigs, getAppUpdatePublishConfiguration } = require('app-builder-lib/out/publish/PublishManager');
const { createYargs, configureBuildCommand, normalizeOptions } = require('electron-builder/out/builder');

const root = path.resolve(__dirname, '..');

test('the normal build configuration also disables publisher destinations', async () => {
  const config = await getConfig(root, 'electron-builder.yml', null);
  assert.equal(config.publish, null);
  assert.equal(await getPublishConfigs({ config, platformSpecificBuildOptions: config.win }, null, 1, true), null);
});

test('CI command passes never as the CLI policy, not a publisher destination', () => {
  const command = require('../package.json').scripts['dist:win:ci'].split('&&').at(-1).trim();
  const args = command.split(/\s+/);
  assert.equal(args.shift(), 'electron-builder');
  const options = normalizeOptions(configureBuildCommand(createYargs()).parse(args));
  assert.equal(options.publish, 'never');
  assert.equal(options.config, 'electron-builder.ci.yml');
});

test('merged CI configuration resolves no publisher for the app or either installer', async () => {
  const config = await getConfig(root, 'electron-builder.ci.yml', null);
  const packager = { config, platformSpecificBuildOptions: config.win };
  assert.equal(config.publish, null);
  assert.equal(config.win.publish, null);
  assert.equal(await getAppUpdatePublishConfiguration(packager, null, 1, false), null);
  for (const target of [null, config.nsis, config.portable]) {
    if (target) assert.equal(target.publish, null);
    assert.equal(await getPublishConfigs(packager, target, 1, true), null);
  }
});

test('never used as a provider reproduces the reported module-resolution failure', async () => {
  await assert.rejects(
    createPublisher({}, '0.0.0', { provider: 'never' }, {}, { buildResourcesDir: path.join(root, 'build') }),
    /Cannot find module for publisher "never"/,
  );
});
