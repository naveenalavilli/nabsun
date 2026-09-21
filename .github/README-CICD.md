# CI and releases

[verify.yml](workflows/verify.yml) runs on main/master pushes, pull requests,
`v*` tags, and manual dispatches. Jobs use Node.js 22.

## Verification and packaging

| Job | Purpose |
| --- | --- |
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

## Download artifacts

Open a successful **verify** run in GitHub Actions and use its **Artifacts** list.
The combined upload contains Windows setup and portable executables, the Mac
arm64 ZIP, and `SHA256SUMS.txt`. Artifacts require GitHub access and expire after
seven days. Failed uploads fail the package job.

These artifacts are separate from public GitHub Releases.

## Release behavior

electron-builder runs with `--publish never`; publish destinations are YAML
`null`. Do not set `publish: never` in builder configuration: it is interpreted
as a publisher name.

After successful packaging, a push to `main` whose package version has no
existing tag creates that tag and a **draft GitHub release** with the artifacts.
A maintainer must publish the draft. Pull requests, ordinary tag-triggered runs,
and manual workflow runs do not take this release path.

`scripts/release.mjs` prepares a version-bump branch and pull request. Inspect
its `--dry-run` output before using it; local installer generation alone does
not create a release.

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
