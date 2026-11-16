# Code signing policy

Updated November 14, 2026.

## Current status

Nabsun has applied for free Windows signing through SignPath Foundation. The
application is pending. Existing public Windows releases are unsigned. macOS
builds use ad-hoc signing and are not notarized. A prepared workflow or successful
application submission is not evidence that a download has been signed.

Only a release explicitly identifying its verified signing status should be
treated as signed. Verify the downloaded file's signature and checksums. Windows
SmartScreen and managed-device policies can still warn about a signed download.

## Maintainer roles

- Author and reviewer: [Naveen Alavilli](https://github.com/naveenalavilli).
- Release/signing approver: Naveen Alavilli.

Nabsun currently has one maintainer. SignPath must confirm acceptance of this role
arrangement. Maintainer accounts involved in signing must use MFA. Main updates
go through pull requests and required checks; signing permission must be limited
to reviewed source and protected CI environments. Signing requests require manual
release approval. Secrets and signing credentials must not appear in source,
logs, artifacts or contributor pull-request environments.

## Proposed Windows signing scope

The prepared SignPath candidate submits only Nabsun's generated setup and
portable installer files. It neither re-signs Electron/Chromium/llama.cpp binaries
nor claims that the application or uninstaller inside these files has been
signed. This scope itself requires SignPath approval before it can be used.

Signed candidates must pass regression checks, artifact-origin checks, publisher
and timestamp verification, and a comparison proving that signing changed only
the outer PE signature/checksum fields and appended certificate data. Checksums
are calculated after signing. The signed output is kept separate from unsigned
builds. Candidate workflows cannot publish a production release automatically.

Full application/uninstaller signing and clean-machine install/upgrade testing
remain prerequisites for a production signing claim. Approved upstream signatures
must be preserved; upstream files must not be represented as our own code.

## Attribution after acceptance

If SignPath accepts Nabsun and signs a release, its signing notice will include:
Free code signing provided by [SignPath.io](https://signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

This is planned attribution, not a claim of current sponsorship or signed builds.
The Foundation's certificate publisher is distinct from the Nabsun product name.

## Privacy and reporting

See the [privacy notice](PRIVACY.md) and [security documentation](SECURITY.md) for
local storage, network connections and optional cloud services. Report a suspicious
release privately to code@naveenalavilli.dev or through GitHub's private security
reporting option if available. Include the release URL and SHA256 digest, without
sharing credentials or private files.
