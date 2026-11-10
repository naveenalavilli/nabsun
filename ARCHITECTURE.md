# Architecture

Nabsun embeds Chromium through Electron. The main process owns browser state,
assistant execution, credentials, and integrations. Web pages and the application
UI run in separate renderers.

## Process boundaries

| Component | Responsibility |
| --- | --- |
| Main process | Tabs, stores, agent loop, approvals, providers, and child processes |
| Shell renderer | Toolbar, settings, chat, and integration controls |
| Overlay renderer | Omnibox and command palette |
| Tab renderers | Sandboxed web pages with no Node integration |
| Page bridge | Structured page tools in an isolated JavaScript world |
| MCP bridge | Authenticated loopback access for external agents |

Shell IPC accepts only the expected UI contents, main frame, and local document.
Overlays have a smaller channel allowlist. UI navigation and new windows are
blocked so privileged preloads cannot follow a web navigation.

Each tab uses a `WebContentsView`. Overlays and extension popups use separate
views above the page; toolbar rows reduce the page rectangle. Detach overlays
when closed, and keep clickable controls outside draggable window regions.

Internal `nabsun://` pages are registered on the persistent tab session.
Chrome extensions also load into that session and are restored from settings.

## Page tools

`src/page/agent-bridge.ts` produces an accessibility-derived page outline.
Actionable elements receive opaque references containing a per-document token.
Tools reject stale references and changed element identities instead of silently
acting on a different target.

The normal cycle is snapshot, action, then a fresh snapshot. Structured tools
cover reading, clicking, typing, selecting, scrolling, and extraction.
Input tools use serialized CDP mouse and keyboard operations with hit testing,
cancellation and credential checks. Date/time and multi-select compatibility
fallbacks are disclosed. Frame routing supplies isolated child-document refs and
maps pointer positions through the embedding frame; open shadow roots are included.
`browser_evaluate` permits page JavaScript and is classified as dangerous.

Password and one-time-code fields are excluded from structured credential
entry and value extraction. This is not a security boundary against arbitrary
page JavaScript or a trusted native plugin.

## Agent execution

`Agent.send` persists the user message, builds provider context, streams a
response, and dispatches requested tools until completion, cancellation, or the
step limit. Volatile page context belongs in the user turn; the system prompt
remains stable for caching.

Important invariants:

- Every tool call receives a result, including failures and denials.
- Completed actions are persisted before the next action starts.
- A run owns its cancellation controller and tab selection.
- The target is captured before approval and checked again before dispatch.
- Mutating handlers recheck cancellation immediately before side effects.
- Only tools offered to the provider may be dispatched.

The in-app assistant follows the user's selected tab. External clients retain
their own tab selection across calls. Stop cancels active runs and releases
pending approvals and questions. Cancellation cannot undo a completed action.

## Approvals

| Risk | Examples | Default |
| --- | --- | --- |
| `safe` | Read, snapshot, extract | Automatic |
| `write` | Click, type, navigate | Ask |
| `dangerous` | Page JavaScript, destructive MCP tools | Ask |

The sidebar and external MCP bridge use the same `ApprovalManager`.
Global per-tool grants are revoked during migration. New grants apply once,
to a task and origin, or to a tool and origin for 24 hours. Policy is checked
before approval and again before dispatch; sensitive actions force individual
approval. MCP annotations affect classification:
destructive tools are dangerous, read-only tools are safe, and unspecified tools
are write. Trust the server before enabling it.

## Providers and account connections

Providers normalize streaming text, reasoning, tool calls, usage, and stop events.
Adapters support Anthropic, OpenAI, Ollama, the bundled local model, and delegated
Codex/Claude Code agents.

The local adapter starts a bundled `llama-server` lazily, reuses it across turns,
and stops it on shutdown. It serves the bundled Qwen3 1.7B GGUF model over loopback.
Model and engine paths are configurable.

CLI providers delegate their internal loop and expose Nabsun through MCP.
Prompts travel over stdin. Launcher resolution supports native binaries, npm
shims, and Unix symlinks without passing user prompts through a shell.
Codex turns replay bounded conversation context; CLI tool calls still enter
Nabsun's approval path.
Each hosted CLI stream gets an opaque browser capability bound to the real chat
run, instead of selecting a run using a client-supplied id. Delegated browser
actions share approval, auditing and per-action transcript persistence. Completion,
Stop and time limits revoke the capability. Browser action and time limits are
host-enforced; CLI-internal token accounting remains dependent on reported usage.

Account setup is separate from conversation execution:

- `nativeCli.ts` downloads official installer scripts from allowed HTTPS hosts,
  validates redirects and size limits, and supports cancellation.
- `codexLogin.ts` handles Codex app-server login messages.
- `cliAccounts.ts` coordinates installation, sign-in, status, repair, and logout.
- The selected executable is updated only after it starts successfully.
- Cancel/retry and sign-out/sign-in wait for preceding process cleanup.

Existing CLI credentials are reused. Nabsun opens validated provider login URLs;
Claude Code may also open the system browser. Provider credentials stay in the
CLI's store. Signing out affects other uses of that same CLI account.

## Integrations and storage

External clients spawn `dist/bin/nabsun-mcp.js`, which forwards requests to a
loopback HTTP bridge using a per-launch bearer token. The standalone MCP bundle
is unpacked from `app.asar` so it can run as a child process.

Plugins execute CommonJS code in a separate Node permission-restricted process.
Approved source is staged separately, and page helpers reenter the shared agent
gate. Exact source pins require renewed review after edits. Configured MCP
servers remain trusted child processes with an explicit environment allowlist,
configuration/source fingerprints and process-tree cancellation. Their filesystem
and network access are not restricted by a complete OS sandbox. Dynamic package
runners are refused because their downloaded content is not pinned by this path.
Unpacked Chrome extensions have partial Electron API compatibility.

Chat attachments use opaque, chat-owned ids and integrity-checked copied bytes.
Text, table and PDF parsing runs in a bounded worker; supported images are
normalized for previews and vision models. Datasets, versioned workflows and
batch checkpoints live in separate stores. Replay checks postconditions and
pauses uncertain rows for review instead of automatically repeating a submission.

`AuditSink` records action intent and result before and after the shared action
path. The default local sink uses a daily hash chain and durable checkpoint,
redacts values to fingerprints and blocks further actions after recording failure.
Its viewer/export is available only to trusted application UI.

Windows chat dictation uses an explicitly approved, time-limited desktop speech
recognizer child process. Text events update only the owning chat draft. Other
platforms provide OS dictation guidance; no cloud transcription is used.

Settings, chats, history, bookmarks, and plugins live under the application
profile. API keys use Electron `safeStorage`; without secure storage they stay
in memory. Password saving requires secure storage and autofill matches the
complete origin. Optional `soul.md` context is restricted to local providers
by default. See [Security](SECURITY.md) for details.

## Source map

| Path | Contents |
| --- | --- |
| `src/main/appWindow.ts`, `tabs.ts` | View layout and tab lifecycle |
| `src/main/ipc.ts`, `uiSecurity.ts` | UI IPC and sender validation |
| `src/main/ai/` | Runs, providers, tools, approvals, and chat persistence |
| `src/main/bridge/` | External-agent HTTP bridge |
| `src/main/integrations/` | CLI accounts, plugins, MCP, and Chrome extensions |
| `src/page/`, `src/preload/` | Page tools and isolated renderer bridges |
| `src/renderer/` | Application UI |
| `src/shared/` | Shared types and IPC contracts |
| `src/test/`, `scripts/verify-*` | Automated checks |

## Build and verification

esbuild produces main/preload bundles, renderer assets, an injected page bridge,
and the standalone MCP server. electron-builder packages the app with the model,
native engine, and licenses. Engine manifests record platform, architecture,
file hashes, and library links; packaging also probes native startup.

Use the [contributor guide](CONTRIBUTING.md) for local commands and the
[CI guide](.github/README-CICD.md) for platform checks and release gates.

## Remaining limitations

- Bundled-model task planning has failed diagnostic form attempts; full model
  evaluation, constrained grounding and measured tier/token improvements remain open.
- Host limits cover delegated browser tools; CLI-internal unreported tokens and
  native process capabilities are not strictly constrained by these limits.
- Closed shadow roots and broader nested-frame cases still need coverage.
- Journal concurrency/export edge cases and external-client run lifecycles need
  wider verification; the local hash chain is not a central enterprise audit service.
- Interrupted actions do not have general postcondition-based reconciliation.
- Plugins and MCP servers are trusted native code.
- There is no managed enterprise policy or automatic update channel.
- Profiles/private mode, slim distribution and cross-platform release certification
  remain incomplete. See the [verification record](docs/improvement-status.md).

Prompt injection remains a risk even with approval controls. See the
[security model](SECURITY.md).
