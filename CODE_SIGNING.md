# Code signing policy

Updated November 16, 2026.

## Current status

Nabsun's SignPath Foundation application was not approved. Existing public
Windows releases are unsigned. Version 1.0.5 is being prepared with a Microsoft
Artifact Signing Public Trust profile. The protected macOS candidate workflow
uses Developer ID signing and Apple notarization. A configured workflow, cloud
account, draft release, or version number is not evidence that a download was
signed.

Only a release explicitly identifying its verified signing status should be
treated as signed. Verify the downloaded file's signature and checksums. Windows
SmartScreen and managed-device policies can still warn about a signed download.

## Maintainer roles

- Author and reviewer: [Naveen Alavilli](https://github.com/naveenalavilli).
- Release/signing approver: Naveen Alavilli.

Nabsun currently has one maintainer. Maintainer accounts involved in signing
must use MFA. Main updates
go through pull requests and required checks; signing permission must be limited
to reviewed source and protected CI environments. Signing requests require manual
release approval. Secrets and signing credentials must not appear in source,
logs, artifacts or contributor pull-request environments.

## Windows signing scope

The Microsoft Artifact Signing candidate builds and signs the application,
generated setup and portable executables, and packaged DLLs through
electron-builder. The Azure signer receives only digests; its certificate and
private key are not exported to the build runner. Upstream signatures must be
preserved and must not be represented as Nabsun's own code.

Signed candidates must pass regression checks, packaged-resource checks, exact
publisher and timestamp verification, and Authenticode checks for the expected
application and installer files. Checksums are calculated after signing. The
signed output is kept separate from unsigned builds. Candidate workflows cannot
publish a production release automatically.

Clean-machine install, upgrade, portable launch and uninstall testing remain
prerequisites for a production signing claim.

## Signing identity

The Windows workflow uses a dedicated Microsoft Entra application with a GitHub
OIDC federated credential restricted to the repository's protected
`windows-signing` environment. Its Azure role is limited to **Artifact Signing
Certificate Profile Signer** on the intended profile or account. The exact
certificate subject is checked in CI and will be listed in the release notes
only after a real candidate passes.

## Privacy and reporting

See the [privacy notice](PRIVACY.md) and [security documentation](SECURITY.md) for
local storage, network connections and optional cloud services. Report a suspicious
release privately to code@naveenalavilli.dev or through GitHub's private security
reporting option if available. Include the release URL and SHA256 digest, without
sharing credentials or private files.
