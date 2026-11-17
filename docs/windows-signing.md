# Windows signing

The SignPath Foundation application was not approved. Existing public Windows
builds remain unsigned until an exact release candidate completes the Microsoft
Artifact Signing path below. See the [code signing policy](../CODE_SIGNING.md)
and [privacy notice](../PRIVACY.md).

## Microsoft Artifact Signing setup

1. Create the Artifact Signing account in a supported region, complete Public
   Trust identity validation, and create a Public Trust certificate profile.
2. Create a dedicated Microsoft Entra application and a GitHub federated
   credential with subject
   `repo:naveenalavilli@11617914/nabsun@1363438512:environment:windows-signing`.
   The immutable owner and repository IDs prevent a renamed or transferred
   repository from inheriting this signing trust.
3. Grant that service principal **Artifact Signing Certificate Profile Signer**
   on only the intended certificate profile (or account when profile scope is
   unavailable). Do not create a client secret.
4. Create the protected GitHub environment `windows-signing`, restrict it to
   `main`, and require maintainer approval. Configure these environment variables:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Dedicated Entra application's client ID |
| `AZURE_TENANT_ID` | Azure tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Subscription containing the signing account |
| `WINDOWS_SIGNING_ENDPOINT` | Regional `https://*.codesigning.azure.net` endpoint |
| `WINDOWS_SIGNING_ACCOUNT` | Artifact Signing account name |
| `WINDOWS_SIGNING_PROFILE` | Public Trust certificate profile name |
| `WINDOWS_SIGNING_PUBLISHER` | Exact certificate subject/publisher returned by Azure |

Dispatch **Windows signed candidate** on the reviewed commit with `azure`
selected. Verification completes before the protected signing job asks for
environment approval. GitHub OIDC provides a short-lived token, and
electron-builder signs the generated application, setup, portable executable,
and packaged DLLs without exporting a private key.

CI rejects a candidate unless the expected files have a valid Authenticode
signature, the exact publisher, and a trusted timestamp. It also checks packaged
resources before hashing the final signed bytes. The candidate is uploaded as a
separate, seven-day artifact; no release is published automatically.

The historical SignPath option is retained only for a future approved
reapplication. It is not an active production route.

## Verification before production

Run the local packaging checks:

```powershell
node --test scripts/verify-windows-signing.cjs scripts/verify-ci-publishing.cjs scripts/verify-ci-artifacts.cjs
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

References: [Microsoft Artifact Signing setup](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
and [Artifact Signing roles](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-resources-roles).
