**Codex and Claude connection review — September 20, 2026**

Reviewed the native installer, executable resolution, account commands, Codex app-server protocol, process cleanup, privileged IPC wiring, automatic provider activation, Extensions and Settings UI, build wiring, documentation, and regression tests. Earlier unrelated working-tree changes were preserved.

The review found and fixed the following issues:

| Priority | Finding and consequence | Fix |
| --- | --- | --- |
| High | Cancel immediately released the operation while its installer or Codex callback server could still be running. Retry could overlap installation or compete for the callback port. | Account operations retain ownership until cleanup finishes; queued retries wait for completion. Codex login settles only after its child closes. See [cliAccounts.ts](src/main/integrations/cliAccounts.ts) and [codexLogin.ts](src/main/integrations/codexLogin.ts). |
| Medium | Account status checks ignored login cancellation. Standalone checks and sign-out could survive application shutdown. | Propagate cancellation into status processes and use a shared shutdown signal for status and logout. Add a forced termination fallback on Unix. See [cliAccounts.ts](src/main/integrations/cliAccounts.ts) and [nativeCli.ts](src/main/integrations/nativeCli.ts). |
| Medium | Catalogue version probes ran synchronously on Electron's main thread, potentially freezing the browser for ten seconds per CLI. Cached versions also survived executable changes. | Use asynchronous, bounded probes; cache by launcher identity as well as provider. See [agentExtensions.ts](src/main/integrations/agentExtensions.ts). |
| Medium | Re-scanning multiple authentication URLs could re-emit previous URLs. Interleaved stderr output could corrupt a partial stdout URL. Missing Codex login metadata could leave the UI waiting for the ten-minute timeout. | Deduplicate URLs for the whole operation, parse output streams independently, and reject incomplete protocol responses immediately. See [cliAccounts.ts](src/main/integrations/cliAccounts.ts) and [codexLogin.ts](src/main/integrations/codexLogin.ts). |
| Medium | Changing the executable setting during sign-in could activate a provider using a different executable from the one authenticated. | Check the captured setting before and after final verification; do not activate if it changed. See [cliAccounts.ts](src/main/integrations/cliAccounts.ts). |
| Medium | Slow or rejected account checks could hide the entire panel; failed sign-in tabs caused unhandled rejections. Sign-out exposed a Cancel button that did nothing, and stale status messages survived external reconnection. | Render the catalogue before account checks finish, handle failures independently, offer tab/catalogue retries, invalidate stale responses, and correct busy/status controls. See [extensions.ts](src/renderer/shell/extensions.ts). |

Additional cleanup: use the absolute Windows taskkill path, cancel unsuccessful HTTP response bodies, and decode installer stdout/stderr independently.

Validation:

- TypeScript check and production build passed.
- The full `npm run verify` suite passed: payload, installed CLI compatibility, connection flow, security regressions, browsing, page bridge, agent, MCP, and the bundled local model.
- All 55 final focused checks passed (33 backend/installer checks and 22 Electron UI checks). They also cover old CLI repair, old Codex protocol recovery, executable selection, failed updates, overlapping sign-out/sign-in, and descendant-process cleanup.
- Tests use isolated fixture credentials and processes. Real provider credentials were not changed.

Follow-up fixes and verification:

- Added automatic repair for unsupported account commands and older Codex account protocols. Repair runs at most once per connection attempt; account/network errors do not cause reinstall loops.
- Added **Repair / update** to both assistant cards. It installs the official native CLI, verifies startup before selecting it, persists its exact executable path, and reuses existing credentials. Failed installation leaves the previous selection intact, and user edits made during setup are preserved.
- Serialized sign-in behind pending sign-out. On Unix, cancellation also kills descendants when their parent exits before them or ignores termination.
- Ran both real official native installers on Windows: Codex 0.155.1 and Claude Code 2.1.278. Verified executable startup, Codex app-server initialization and read-only account access, and Claude login-command availability and structured authentication status. No OAuth consent or sign-out was requested.
- Added a Windows/macOS/Linux CI matrix that runs connection regressions, the Electron UI tests, and real native installers. Both release packaging jobs now depend on it. All 10 local CI configuration/artifact checks passed using a checksum-verified temporary PowerShell 7 runtime. Mac/Linux execution must take place on those runners; it is not claimed as completed on this Windows machine.
- The user deferred interactive provider sign-in. The remaining manual check is completing real OAuth consent and confirming the callback in Nabsun; automated protocol tests do not substitute for it. Claude may also open the system browser through its own login command.

No installer was published and no deployment was performed during this review.
