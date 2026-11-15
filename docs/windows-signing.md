# Windows signing

SignPath application submitted November 14, 2026; approval is pending. Existing
public Windows builds are unsigned. See the [code signing policy](../CODE_SIGNING.md)
and [privacy notice](../PRIVACY.md).

## SignPath setup after approval

1. Confirm the Foundation accepts the proposed installer-only scope and the
   one-maintainer role arrangement. Enable MFA and link its GitHub integration.
2. Review `build/signpath/installers.xml` with SignPath. It selects only the setup
   and portable EXEs, with exact product/version restrictions. Configure a signing
   policy requiring manual approval and verified GitHub-hosted build origin.
3. Create the GitHub environment `signpath`, restrict its allowed branches, and
   configure required reviewers. Add `SIGNPATH_API_TOKEN` as an environment secret.
4. Add the environment variables below using the approved account values.

| Variable | Value |
| --- | --- |
| `SIGNPATH_ORGANIZATION_ID` | Organization UUID |
| `SIGNPATH_PROJECT` | Project slug |
| `SIGNPATH_POLICY` | Signing policy slug |
| `SIGNPATH_CONFIGURATION` | Reviewed artifact-configuration slug |
| `SIGNPATH_PUBLISHER` | Exact certificate publisher name |
| `SIGNPATH_APPROVED_SCOPE` | `installer-envelopes-only`, after scope approval |

After the workflow is reviewed and merged, dispatch **Windows signed candidate**
on a reviewed ref with `signpath` selected. It runs Windows regression checks,
uploads the unsigned inputs, requests signing and waits up to 30 minutes.

The returned files are verified for Authenticode validity, publisher, timestamp
and unchanged installer payloads. Final checksums and `SIGNING-REPORT.json` go
into a separate candidate artifact. No release is published automatically.

This signs installer envelopes only. It does not sign the embedded application,
uninstaller or upstream binaries. Full application signing needs an approved
build sequence; do not present this candidate as a fully signed product.

## Optional Azure path

The `azure` workflow selection uses `electron-builder.windows-signed.cjs` and the
protected `windows-signing` environment. It requires a validated Microsoft Public
Trust profile and OIDC identity. Configure `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `WINDOWS_SIGNING_ENDPOINT`, `WINDOWS_SIGNING_ACCOUNT`,
`WINDOWS_SIGNING_PROFILE` and the exact `WINDOWS_SIGNING_PUBLISHER` as environment
variables. Its signing scope includes packaged EXEs/DLLs and differs from SignPath.

## Verification before production

Run the local packaging checks:

```powershell
node --test scripts/verify-windows-signing.cjs scripts/verify-signpath.cjs scripts/verify-ci-publishing.cjs scripts/verify-ci-artifacts.cjs
```

Artifact checks require PowerShell 7. Synthetic signature tests do not establish
public certificate trust. Complete these checks in a disposable Windows VM:

- Download from the intended distribution URL; verify hashes, publisher and actual
  SmartScreen behavior with normal Windows protections.
- Install fresh, inspect the license/privacy notice, launch and run local inference.
- Upgrade the current release using sample data; verify bookmarks, chats, settings
  and folder-access behavior. Test the portable build separately.
- Inspect installed application and uninstaller signatures. Uninstall/reinstall and
  verify shortcut cleanup and the documented preservation of profile data.
- Record OS version, source commit, package hashes and failures. Update public
  signing claims only after a real approved signing run and these checks pass.

References: [SignPath GitHub integration](https://docs.signpath.io/trusted-build-systems/github)
and [Microsoft Artifact Signing setup](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart).
