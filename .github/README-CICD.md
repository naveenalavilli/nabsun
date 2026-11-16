# CI and releases

[verify.yml](workflows/verify.yml) runs on main/master pushes, pull requests,
`v*` tags, and manual dispatches. Jobs use Node.js 22.

## Verification and packaging

| Job | Purpose |
| --- | --- |
| `verify-action-workflows` | Trusted input, frames, attachments, delegation, replay/recovery, approvals, audit and integration isolation on Windows, macOS and Linux |
| `verify-connections` | CLI installation, authentication interface, cleanup, and UI checks on Windows, macOS, and Linux |
| `verify` | Windows build, type checking, regression checks, and local inference |
| `verify-macos` | macOS verification, local inference, and packaged application checks |
| `package-macos` | Apple silicon ZIP; requires macOS and connection checks |
| `package` | Windows setup/portable builds and combined artifacts; requires Windows, macOS, Mac packaging, and connection checks |

The native connection checks run official installers but do not initiate OAuth
or sign out. They do not prove account consent or a live cloud model response.
Local inference must run with the bundled model; missing resources fail the CI step.

Model weights are cached and verified after restoration. Native engines use
pinned downloads. Packaging checks the shipped engine, weights, and licenses.
Linux connection checks do not imply Linux release support.

The separate [task-benchmark workflow](workflows/benchmark.yml) requires all 111
scripted attempts to pass on Windows and macOS for pull requests. Its scheduled
local-model run records actual planner performance; scripted success does not
establish model accuracy. Packaging also waits for the action-workflow matrix.

## Download artifacts

Open a successful **verify** run in GitHub Actions and use its **Artifacts** list.
The combined upload contains Windows setup and portable executables, the Mac
arm64 ZIP, and `SHA256SUMS.txt`. Artifacts require GitHub access and expire after
seven days. Failed uploads fail the package job.

These artifacts are separate from public GitHub Releases.

The manually dispatched **Windows signed candidate** workflow offers `signpath`
(installer envelopes only, pending Foundation scope approval) and `azure`
(Microsoft Artifact Signing) paths. Each requires a protected environment and
configured credentials. Neither publishes releases or changes normal unsigned
packaging. See [Windows signing](../docs/windows-signing.md) for setup and release checks.

### macOS signed candidates

Manual runs of `verify.yml` with `mac_signed_candidate=true` build a Developer
ID-signed, Apple-notarized arm64 ZIP when `MAC_SIGNING_ENABLED=true`. This mode
skips ordinary unsigned packaging. It requires native verification and the protected `mac-signing`
environment. The normal ad-hoc macOS package/release path is unchanged.

Environment variables: `APPLE_TEAM_ID`, `MAC_SIGNING_IDENTITY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`. Environment secrets: `CSC_LINK` (base64 encrypted P12),
`CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8` (dedicated team API key). Tokens/private keys
must never be committed. The temporary notarization key is removed after the job.

The candidate is built using `electron-builder.macos-signed.cjs`. Before upload,
CI extracts the distributed ZIP and checks Developer ID/team identity, hardened
runtime, native inference binaries, stapled notarization ticket, Gatekeeper
assessment, packaged resources and isolated-profile app/helper startup. Its `nabsun-notarized-macos-*` artifact is
separate from ordinary ad-hoc archives. It does not publish a release automatically;
verify the actual artifact and clean-Mac launch before attaching it to a release.

## Release behavior

electron-builder runs with `--publish never`; publish destinations are YAML
`null`. Do not set `publish: never` in builder configuration: it is interpreted
as a publisher name.

After successful packaging, a push to `main` whose package version has no
existing tag prepares a **draft GitHub release** with the artifacts and verified
commit as its target. A draft is not a public release, and its version tag may
not exist until publication. A maintainer verifies the assets/checksums and
publishes the draft. Pull requests, ordinary tag-triggered runs,
and ordinary manual workflow runs do not take this release path.

`main` updates require a PR, the existing `verify` status, and resolved review
threads. There are no bypass actors; direct pushes, force pushes, and deletion
are blocked. The protected `releases/v-0-x` branch preserves 0.1.13 and refuses
updates/deletion. It is not a release-preparation branch.

To publish a branch preview without merging, use a prerelease package version
(such as `1.0.1-rc.1`), add its entry to `RELEASE_NOTES.md`, and manually run
`verify.yml` on that branch with `branch_prerelease=true`. The normal checks and
Windows/macOS package jobs must pass first. The explicit branch path refuses
main/master, stable version numbers and existing tags. It publishes the exact
verified commit as a prerelease with installers and checksums, never as latest
stable. The main-branch release path remains unchanged.

[RELEASE_NOTES.md](../RELEASE_NOTES.md) is the maintained change history. The
workflow's generated commit list is supporting metadata; before publishing a
draft, use the matching maintained entry for its user-facing changes and keep
the download/platform instructions. Update the entry's publication status and
America/Chicago date only after the release is published.

`scripts/release.mjs` prepares a version-bump branch and pull request. Inspect
its `--dry-run` output before using it; local installer generation alone does
not create a release. That helper accepts stable `x.y.z` versions. For branch
previews use the manual workflow described above. Before promoting a preview
to main, set the intended stable version (for example,
`npm version 1.0.1 --no-git-tag-version`) in the reviewed release PR.

## Troubleshooting

Open the failing step first. Windows commands use `scripts/ci-run.ps1` to retain
the native exit code and stream logs to Actions and `ci-logs/`.
Failure-log uploads are best-effort; artifact storage quota may prevent uploads.

For local reproduction, follow [Contributing](../CONTRIBUTING.md), run the failing
npm script, and check CI configuration with:

```bash
node --test scripts/verify-ci-publishing.cjs scripts/verify-ci-artifacts.cjs
```

On Windows these CI script checks require PowerShell 7. Validate packaged resources
with `node scripts/check-release-payload.mjs --resources release/win-unpacked/resources`
(adjust the resources path for macOS or a custom output directory).
