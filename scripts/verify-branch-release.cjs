const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const yaml = require('js-yaml');
const { prepareBranchRelease } = require('./prepare-branch-release.cjs');
const spec = { event:'workflow_dispatch', ref:'refs/heads/fix/session-tool-approvals', optIn:'true', version:'1.0.1-rc.1', notes:'## 1.0.1-rc.1 - Branch preview\n\n- New chat screen.\n\n## 1.0.0 - Prior release\n\nOlder changes.' };

test('branch publication requires explicit opt-in and cannot run from main, a tag, or a PR', () => {
  for (const patch of [{event:'push'}, {event:'pull_request'}, {optIn:'false'}, {ref:'refs/heads/main'}, {ref:'refs/heads/master'}, {ref:'refs/tags/v1.0.1-rc.1'}])
    assert.throws(() => prepareBranchRelease({...spec,...patch}), /explicit manual/);
  assert.throws(() => prepareBranchRelease({...spec,version:'1.0.1'}), /prerelease version/);
});
test('notes and filenames match the exact prerelease and omit older version entries', () => {
  const release = prepareBranchRelease(spec);
  assert.equal(release.tag,'v1.0.1-rc.1');
  assert.match(release.body,/New chat screen/);
  assert.doesNotMatch(release.body,/Older changes/);
  assert.match(release.body,/unsigned/);
  assert.equal(release.files.length,4);
  assert.throws(() => prepareBranchRelease({...spec,notes:'## 1.0.0 - Prior release'}), /RELEASE_NOTES/);
});
test('the actual workflow publishes only the verified commit and keeps prereleases away from latest stable', () => {
  const workflow=yaml.load(fs.readFileSync('.github/workflows/verify.yml','utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.branch_prerelease.default,false);
  const steps=workflow.jobs.package.steps;
  const gate=steps.find(step=>step.id==='branch_release');
  assert.match(gate.if,/inputs.branch_prerelease/);
  assert.match(gate.if,/workflow_dispatch/);
  assert.match(gate.run,/git ls-remote --tags/);
  const publish=steps.find(step=>step.name==='Publish branch prerelease');
  assert.equal(publish.with.prerelease,true);
  assert.equal(publish.with.make_latest,false);
  assert.equal(publish.with.target_commitish,'${{ github.sha }}');
  assert.match(publish.if,/branch_release.outputs.tag/);
  assert.deepEqual(workflow.jobs.package.needs,['verify','verify-macos','package-macos','verify-connections','verify-action-workflows']);
});
