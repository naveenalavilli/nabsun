const assert = require('node:assert/strict');
const { test } = require('node:test');
const { macSigningConfig } = require('./macos-signing-config.cjs');
const settings = { APPLE_TEAM_ID: 'ABC1234567', MAC_SIGNING_IDENTITY: 'Developer ID Application: Example LLC (ABC1234567)',
  CSC_LINK:'test-encrypted-p12',CSC_KEY_PASSWORD:'test-password',APPLE_API_KEY:'/temporary/test.p8',APPLE_API_KEY_ID:'TESTKEY123',APPLE_API_ISSUER:'test-issuer' };
test('macOS release configuration rejects missing credentials and ad-hoc/mismatched identities', () => {
  for(const name of Object.keys(settings)) { const env={...settings}; delete env[name]; assert.throws(()=>macSigningConfig(env)); }
  for(const identity of ['-', 'Apple Development: Example LLC (ABC1234567)', 'Developer ID Application: Example LLC (ZZZ1234567)']) {
    assert.throws(()=>macSigningConfig({...settings,MAC_SIGNING_IDENTITY:identity}));
  }
});
test('macOS signed configuration overrides the ad-hoc identity and requires notarization', async () => {
  const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { DebugLogger } = require('builder-util');
  const path = require('node:path'), previous = {};
  let config;
  try {
    for(const [name,value] of Object.entries(settings)){previous[name]=process.env[name];process.env[name]=value;}
    config=await getConfig(path.resolve(__dirname,'..'),'electron-builder.macos-signed.cjs',null);
  }finally{for(const [name,value] of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
  await validateConfiguration(config,new DebugLogger(false));
  assert.equal(config.mac.identity,'Example LLC (ABC1234567)');
  // Exercise the installed builder's identity selector: a prefixed name throws
  // before keychain discovery, while this qualifier is accepted.
  const signer = require('app-builder-lib/out/codeSign/macCodeSign');
  const previousIdentities = signer.findIdentityRawResult;
  try {
    signer.findIdentityRawResult = Promise.resolve([]);
    assert.throws(() => signer.findIdentity('Developer ID Application', settings.MAC_SIGNING_IDENTITY), /Please remove prefix/);
    assert.equal(await signer.findIdentity('Developer ID Application', config.mac.identity), null);
  } finally {
    signer.findIdentityRawResult = previousIdentities;
  }
  assert.equal(config.mac.notarize,true); assert.equal(config.mac.hardenedRuntime,true); assert.equal(config.forceCodeSigning,true);
  assert.equal(config.publish,null);
  const development=await getConfig(path.resolve(__dirname,'..'),'electron-builder.ci.yml',null);
  assert.equal(development.mac.identity,'-');
});
test('signed macOS job is manual, protected and distinct from ordinary macOS release artifacts', () => {
  const fs = require('node:fs'), path = require('node:path'), yaml = require('js-yaml');
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname,'../.github/workflows/verify.yml'),'utf8'));
  const job = workflow.jobs['package-macos-signed'];
  assert.match(job.if,/workflow_dispatch/); assert.match(job.if,/MAC_SIGNING_ENABLED/);
  assert.match(job.if,/inputs.mac_signed_candidate/);
  assert.match(workflow.jobs.package.if,/!inputs.mac_signed_candidate/);
  assert.match(workflow.jobs['package-macos'].if,/!inputs.mac_signed_candidate/);
  assert.equal(job.environment,'mac-signing');
  assert(job.needs.includes('verify-macos') && job.needs.includes('verify-action-workflows'));
  const verify=job.steps.findIndex(step=>step.name==='Verify distributed notarized archive');
  const upload=job.steps.findIndex(step=>step.name==='Upload verified notarized macOS candidate');
  assert(verify>=0 && verify<upload);
  assert.match(job.steps[verify].run,/ditto -x -k/);
  assert.match(job.steps[verify].run,/verify-macos-signatures.sh/);
  assert.match(job.steps[verify].run,/smoke-macos-app.sh/);
  assert.match(job.steps[upload].with.name,/^nabsun-notarized-macos-/);
  assert(!job.steps.some(step=>step.uses?.includes('action-gh-release')));
  assert(job.steps.some(step=>step.if==='always()' && step.run.includes('nabsun-notarization.p8')));
});
