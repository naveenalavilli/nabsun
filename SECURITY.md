# Security

Nabsun is a developer preview with no independent security audit. Its assistant
can act in signed-in browser sessions, so approval settings and integration
trust directly affect what it can do.

## Report a vulnerability

Use the repository's **Security → Report a vulnerability** option for sensitive
reports, if available. Avoid posting credentials or exploit details in public
issues. Include reproduction steps, affected version, and expected behavior.
Responses are best-effort; there is no bug bounty.

## Security controls

| Area | Control |
| --- | --- |
| Web pages | Chromium sandbox, context isolation, no Node integration, normal TLS validation |
| Application IPC | Expected UI contents, main frame, document, and channel checks |
| UI navigation | Privileged renderers cannot navigate to websites or open popups |
| Tool execution | Shared approval gate, target revalidation, cancellation before side effects |
| Model output | DOM-based rendering and scheme-checked links |
| API keys | OS-backed encryption when available; otherwise session memory only |
| Passwords | Secure storage required; saving needs consent; autofill matches the full origin |
| External agent bridge | Loopback binding and a fresh bearer token for each launch |
| Hosted CLI task bridge | Temporary credentials bound to the chat run; revoked on Stop or completion |
| Activity journal | Durable intent/result records, hashed values, integrity checks and fail-closed recording |

Certificate errors are refused. Sensitive site capabilities such as camera,
microphone, location, and clipboard reading require a user-only, per-origin
decision. Site choices can be reset in Settings. Cross-origin frames cannot
borrow the top site's device grant. Websites need a separate confirmation before
opening another application.

## Approvals and prompt injection

Page content can contain malicious instructions aimed at the model. System
instructions discourage following them, but do not reliably prevent prompt injection.

By default, read tools run automatically; write and dangerous tools ask first.
Old global **Always allow this tool** grants are revoked during migration.
Approvals can allow an action once, for the current task on a site, or for that
tool and site for 24 hours. Settings can revoke saved site grants. A separate,
unchecked **Auto-allow this tool for this chat session** checkbox grants that
tool (and integration source) permission across sites and follow-up prompts in
the current chat. This includes uploads, arbitrary page JavaScript and detected
cross-origin submissions; without this explicit session choice they require
individual approval. Active session grants appear below the conversation and
can be unchecked to ask again. They are memory-only, disappear on chat deletion
or app shutdown, and never bypass host policy, credential guards or Stop. Stop
cancels the current task; session choices remain for later prompts in that chat. Legacy automatic-write mode is restricted to the first
site in a run; it does not permit arbitrary cross-origin writes.

Targets are captured before approval and revalidated before dispatch. Stop cancels
pending work, but cannot reverse an action that already completed. Hosted CLI
interactive chats have a 100-browser-action and 30-minute default limit.
Explicit workflow budgets remain capped at five minutes. Delegated browser
credentials expire with the remaining task deadline and are revoked immediately
on cancellation. CLI-internal
activity outside Nabsun's tools is not an OS sandbox, and unreported internal
token use cannot be strictly limited by Nabsun.

## Local folder access

Only the trusted native picker and confirmation dialog issue local-folder
capabilities. The user chooses both the folder and read-only/read-and-change
mode. Tool inputs cannot supply an authorized absolute path, session identity,
or access mode. Grants stay in memory and are bound to the host chat. Deleting
a chat or closing the app revokes them; Disconnect also cancels its queued and
active work. A stopped/deleted chat cannot gain access from late consent.

Built-in local operations share policy, action budgets, approvals and the
hashed activity journal. Browser-origin grants and browser automatic-action
settings do not approve filesystem writes. Explicit per-tool chat approval can
suppress repeat prompts, but never upgrades a read-only folder. Unbound external
clients cannot claim a chat's access. Hosted CLI tasks use their host-owned chat
scope. Plugins' browser-helper API does not expose these file capabilities.

Relative paths reject traversal, absolute/drive paths, alternate streams and
reserved names. Symbolic links/junctions are not followed; hard-linked files
are refused. Nabsun profile files are protected even when an ancestor folder
is approved. Reads use bounded file handles and identity/version checks.
Edits require a current content hash, keep a backup inside the chosen folder,
and stage the replacement before committing it. New destinations must not
already exist. The model cannot alter internal backups or staging files through
these tools. Deletion uses the operating system Trash API for individual regular files,
requires a current file hash and read/write authority, keeps an original backup
before invoking Trash, and has no permanent-delete fallback. Append uses the same revision and backup checks as editing.
This feature has no shell execution or permanent-delete tool.

These are host application scope checks, not an OS sandbox against another
program running as the same user. Directory replacement races by such a program
are not eliminated by Node's path-based rename/link APIs. Do not treat a folder
actively manipulated by untrusted local code as an isolated security boundary.
Read data can reach the selected model and remain in chat history; disconnecting
prevents future access and does not erase data already shared. Document/image
parsing uses the existing bounded workers/previews without importing copies into
the attachment index. DOCX body-text replacement/appending and XLSX cell updates
use a bounded worker (25 seconds, 256 MB JS heap, no native addons), validated
ZIP members (20 MB package, 8 MB per part, 64 MB expanded total, 1000 members),
and XML parsing that refuses DTD/entities. It never extracts archives to disk
or follows external Office relationships. Unchanged package parts retain their
bytes; edits keep backups and require current hashes. Encrypted, macro/ActiveX,
protected and signed-document edits are refused. XLSX formulas are explicit and
limited to a function subset; leading-equals strings remain literal text. Nabsun
does not calculate formulas or execute Office code. Existing manual calculation
mode remains intact. Desktop-app automation is outside this feature. Browser-only workflow recording refuses tasks that modify
local files rather than saving unusable folder capabilities into a replay.

## Credentials and private content

The browser sends assistant context to the selected provider. Bundled inference
stays on-device; Ollama is local only when configured with a loopback endpoint.
Cloud providers and signed-in CLIs use their respective services.

- API keys are bound to their configured endpoints.
- Password and one-time-code values are excluded from structured page extraction;
  assistant typing into those fields is blocked.
- Arbitrary page JavaScript can access the page DOM. Approving
  `browser_evaluate` can bypass the protections of structured tools.
- Saved passwords have no separate master password. A person using your unlocked
  OS account and the app can reveal them.
- CLI credentials remain in the CLI's own store. Connecting may install or update
  the official native CLI; signing out also affects its use outside Nabsun.
- `soul.md` is shared only with local providers by default; changing that setting
  allows it to reach the selected remote provider.
- Chats and other profile files can contain sensitive content; they are not a
  separately encrypted vault.

The desktop browser has no product analytics. The separate marketing website
uses Google Analytics.

## Trusted integrations

Plugins run in a separate Node process with filesystem permission restrictions,
their own storage, bounded messages and explicit browser helper calls through the
shared approval gate. Source changes require renewed native approval. This is not
a complete OS sandbox: network access remains available. Only approve code you trust.

MCP servers remain trusted native child processes with filesystem and network
access. They receive an OS/login/path environment allowlist plus explicitly
configured variables, rather than all parent secrets. Approval pins the executable,
local entry files and configuration; this does not attest every transitive
dependency. Source changes require review. Dynamic package runners such as `npx`
are refused: install the server locally and configure its executable or entry
script. MCP risk annotations influence approval classification.

Plugins, MCP servers and unpacked extensions have independent enable switches.
Disabling an extension requires reloading open websites to remove code already
injected into those documents.

Unpacked Chrome extensions run in the browser session and can access sites
according to their permissions. There is no Chrome Web Store review or installation
flow in Nabsun.

A local process that obtains the bridge token can request browser tools. The
approval gate still applies, but the token is not protection against a compromised
OS user account.

## Configuration and network boundaries

Configuration imports validate nested values, reject executable and provider
endpoint overrides, and disable imported MCP servers and Chrome extensions.
Exports omit credentials and strip integration argument values.

The host-side `fetch_url` tool rejects private and local destinations after DNS
resolution, pins the validated destination, limits response size and duration,
and does not follow redirects. This policy applies to that tool, not to normal
browser navigation or trusted plugin code.

## Limits

Release checks contact GitHub's public API at startup and every 24 hours, with
short-lived caching for repeated checks. No account, browsing history, or local
settings are sent. GitHub receives the request's IP address. Notifications link
to Nabsun's official release page; the app does not download or execute updates.

The local activity journal is not a central enterprise audit service, and the
shared policy hook does not implement enterprise policy administration. There
is no complete OS integration sandbox, separate password-vault unlock, or
automatic updater. Windows packages
are unsigned; macOS builds use ad-hoc signing without notarization.
Tracker blocking is a small built-in list rather than a full filtering engine.

See [Architecture](ARCHITECTURE.md) for implementation boundaries and remaining gaps.
