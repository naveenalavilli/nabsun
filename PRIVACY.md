# Privacy notice

Updated November 14, 2026. Applies to the Nabsun desktop browser and identifies
the separate website's data handling. Nabsun is maintained by Naveen Alavilli.
Questions: code@naveenalavilli.dev. Do not send passwords or private files in a
public issue.

## On your device

Nabsun stores browser history, cookies, site storage, bookmarks, settings, chats,
attachments and activity records in your local application profile. Approved
file edits can create local backups. Some credentials use operating-system
protection; the profile and chat files are not a separately encrypted vault.
Private browsing does not make online requests anonymous to websites or services.

The optional local model performs inference on your computer once installed. The desktop browser
has no product analytics or automatic crash-report upload. This does not mean
the whole browser is offline or that every configured integration runs locally.

## Websites and routine connections

Websites you open communicate with their operators, receive network information
such as your IP address, and may store cookies. Search queries go to the selected
search engine. Website permissions are managed separately from assistant access.

Nabsun checks GitHub for a newer release at startup and periodically (currently
every 24 hours). This request exposes ordinary connection information to GitHub;
the update checker does not include chat text or local file content. Update
downloads open in your default browser and installation is manual. Development
setup downloads the engine/model and dependencies from their respective sources.
Choosing the in-app Local AI download contacts Hugging Face and its approved
content-delivery hosts. Nabsun verifies the pinned file before making it available.

## Optional online assistants

Choosing Claude, OpenAI/Codex or another remote endpoint sends requests to that
service. These may include your message, conversation context, tab information,
attached page text, images, files, saved notes if enabled, and tool results needed
for the task. A locally installed agent CLI can still use a cloud model. File
access approval controls which files Nabsun can access; it does not guarantee
that their contents stay on-device when a remote assistant uses them.

The provider's terms govern retention, processing and possible training use.
Nabsun does not promise that remote requests have zero retention, zero training,
or complete automatic redaction. To keep model inference local, use the downloaded
local model or an independently verified local endpoint and avoid remote tools.
Changing providers or disconnecting a folder does not recall data already sent.

## Integrations and sharing

Enable only plugins, extensions and MCP servers you trust. They may have their
own filesystem/network access and privacy practices. A local bridge connects
authorized clients to Nabsun tools; the connected client may use remote services.
The approval mode you choose affects when actions require confirmation. Review
content before posting, uploading, submitting forms or sharing diagnostic logs.

Provider references: [Anthropic](https://privacy.claude.com/),
[OpenAI](https://openai.com/policies/privacy-policy/),
[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
Custom endpoints, websites and integrations have their own policies.

## Control and removal

You can choose a local assistant, disable integrations, disconnect approved
folders, and remove chats/site data through the available app controls. Local
backups, downloads and files outside the profile may remain. Uninstalling Nabsun
preserves its profile by default so an upgrade does not erase your information.
Removing local data does not delete copies already held by external services;
use the relevant service's deletion process for those copies.

## The nabsun.com website

The marketing website uses Google Analytics on production domains. The test
hosting site disables that integration. Website analytics is separate from the
desktop application. Hosting and analytics providers receive ordinary web request
information; [Google's privacy policy](https://policies.google.com/privacy) applies
to its processing. Links to GitHub, LinkedIn and other services take you to their
respective policies. Requests you send to the maintainer are used to address the
request; do not include more personal information than necessary.
