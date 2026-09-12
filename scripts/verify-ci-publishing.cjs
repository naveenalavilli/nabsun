const assert = require('node:assert/strict');
const path = require('node:path');
const { Writable } = require('node:stream');
const { test, after } = require('node:test');
const { log } = require('builder-util');
const { getConfig } = require('app-builder-lib/out/util/config/config');
const { createPublisher, getPublishConfigs, getAppUpdatePublishConfiguration } = require('app-builder-lib/out/publish/PublishManager');
const { createYargs, configureBuildCommand, normalizeOptions } = require('electron-builder/out/builder');

const root = path.resolve(__dirname, '..');

// Node 22's test-worker decoder can misread non-ASCII stdout interleaved with
// serialized test events (nodejs/node#65934). electron-builder writes Unicode
// markers directly to its logger stream. Capture only that logger's output;
// do not replace process.stdout or suppress the test runner's failure reports.
const builderLogs = [];
const originalLogStream = log.stream;
const capturedLogStream = new Writable({
  write(chunk, encoding, callback) {
    builderLogs.push(chunk.toString('utf8'));
    callback();
  },
});
log.stream = capturedLogStream;
after(() => {
  log.stream = originalLogStream;
  capturedLogStream.end();
});

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
  assert.match(builderLogs.join(''), /unable to find publish provider in build resources/);
});
