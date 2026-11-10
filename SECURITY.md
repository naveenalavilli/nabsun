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
tasks have a 100-browser-action and five-minute default limit. CLI-internal
activity outside Nabsun's tools is not an OS sandbox, and unreported internal
token use cannot be strictly limited by Nabsun.

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
