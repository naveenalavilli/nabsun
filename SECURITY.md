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

Certificate errors are refused. Sensitive site capabilities such as camera,
microphone, location, and clipboard reading are denied by default. Websites need
a separate confirmation before opening another application.

## Approvals and prompt injection

Page content can contain malicious instructions aimed at the model. System
instructions discourage following them, but do not reliably prevent prompt injection.

By default, read tools run automatically; write and dangerous tools ask first.
**Always allow this tool** persists a grant. **Autopilot** enables automatic write
actions. These settings also affect external agents, so review them before
letting an assistant work in sensitive sessions.

Targets are captured before approval and revalidated before dispatch. Stop cancels
pending work, but cannot reverse an action that already completed. Persistent
grants are not scoped to a particular task, origin, or integration version.

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

Plugins run with full Node privileges in the main process. They can read files,
access stored data, and use the network. MCP servers are local child processes
and inherit environment variables; their risk annotations influence auto-approval.
Only enable code and servers you trust.

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

There is no central action audit log, enterprise policy enforcement, plugin
sandbox, separate password-vault unlock, or automatic updater. Windows packages
are unsigned; macOS builds use ad-hoc signing without notarization.
Tracker blocking is a small built-in list rather than a full filtering engine.

See [Architecture](ARCHITECTURE.md) for implementation boundaries and remaining gaps.
