# CI

`verify.yml` runs on main/master pushes, pull requests, `v*` tags and manual
dispatches. Both jobs use Windows Server 2022 and Node 22. The `package` job
requires `verify` to succeed; neither job publishes a GitHub release.

The verification job installs dependencies and Electron, then runs typechecking,
the build and each of the six harnesses as separate steps. The local inference
step requires the bundled model; missing weights fail rather than skip.

The publishing regression tests capture electron-builder's logger in memory.
Its Unicode stdout markers can trigger Node 22's test-worker deserialization
bug (nodejs/node#65934). Assertions and test-runner failure output remain active;
the capture also checks the expected invalid-publisher diagnostic.

Only model weights are cached. The fetch script verifies their pinned digest
after restoration. The smaller engine archive is fetched afresh and verified
against its pinned digest in each job. Verified weights are saved before the
inference test so a test failure does not force a second large download.

The package job uses `dist:win:ci`, which fixes `--publish never` in the build
command and loads `electron-builder.ci.yml`. That configuration explicitly sets
publish destinations to YAML `null` at application, Windows and installer levels.
Do not use `publish: never` in configuration: it names a publisher plugin called
`never`, rather than disabling publishing. PR publishing remains disabled.
The job builds both Windows installers, then
checks the shipped resources, including runtime DLLs and notices in `app.asar`.
Every successful package job uploads the setup installer, portable executable
and `SHA256SUMS.txt`, including PRs, main/master pushes, version tags and manual
runs. Both installers must exist and be nonempty before upload. Upload failures
fail the job; a green package job must mean downloadable files were uploaded.
Artifacts are kept for seven days and named with the version, run number and
attempt. The installers are already compressed, so artifact compression is disabled.

To download: open the repository's **Actions** tab, select the **verify** run,
then use the **Windows packages** link in its summary or the **Artifacts** list.
Sign in with repository access. These are Actions artifacts, not entries in the
GitHub Packages registry or GitHub Releases. Manual runs need no upload option.
Each upload is approximately 2.6 GB; the repository needs sufficient Actions
artifact storage. A storage-quota failure must be resolved before upload can succeed.

For failures, open the named failing step. `scripts/ci-run.ps1` streams npm
output to the Actions log and `ci-logs/`, preserving the npm exit code. Small
failure-log artifacts are attempted with seven-day retention; an upload quota
error cannot replace the original test result. Installation errors remain in
their own Actions step logs. No credentials or paid provider accounts are
required by the workflow.

Local reproduction on Windows with PowerShell 7:

```powershell
npm ci --include=dev
npm run setup
node --test scripts/verify-ci-publishing.cjs scripts/verify-ci-artifacts.cjs
./scripts/ci-run.ps1 typecheck
./scripts/ci-run.ps1 build
./scripts/ci-run.ps1 verify:browse # substitute the failing harness
./scripts/ci-run.ps1 fetch:model
$env:NABSUN_REQUIRE_LOCAL = '1'
./scripts/ci-run.ps1 verify:local
./scripts/ci-run.ps1 dist:win:ci
node scripts/check-release-payload.mjs --resources release/win-unpacked/resources
```
