# Contributing

Start with the [README](README.md) for installation and the
[architecture guide](ARCHITECTURE.md) for code structure.

## Local setup

Use Node.js 22 (the CI version) and npm:

```bash
npm ci
npm run fetch:model
npm run dev
```

Run `npm run setup` if Electron was not downloaded during installation.
The model setup verifies pinned downloads. Windows and macOS have bundled engines;
Linux requires manual engine setup.

Use the npm launch scripts. They clear an inherited `ELECTRON_RUN_AS_NODE`,
which can otherwise make Electron exit without opening a window.

## Validate changes

```bash
npm run typecheck
npm run verify
```

The suite covers browser behavior, page tools, agent approvals, MCP, CLI
connections, regressions, and local inference. Fetch the model first;
`NABSUN_REQUIRE_LOCAL=1` makes missing inference resources a failure.
Ordinary checks require no cloud account and do not spend provider quota.

Add a focused regression check for behavioral fixes. Documentation-only changes
need link and command checks, not the application test suite.

`npm run verify:connections:native` is separate: it runs the official Codex and
Claude Code installers and checks their authentication interfaces. It requires
network access and changes installed CLIs; it does not start OAuth or sign out.
Live provider tests are opt-in and may use account quota.

## Code conventions

- Keep `src/shared/` independent of Electron and Node runtime imports.
- Render untrusted content as text or safe DOM nodes, never raw HTML.
- Declare each tool's risk and preserve approval, target validation, and cancellation.
- Keep privileged IPC behind the trusted sender checks in `uiSecurity.ts`.
- Preserve UTF-8 when editing files.
- Keep pull requests focused; describe the behavior change and relevant validation.

Read [Security](SECURITY.md) before changing credentials, permissions, IPC,
plugins, or the external-agent bridge.

## Packaging

See [Build installers](README.md#build-installers) and the [CI guide](.github/README-CICD.md).
Build macOS artifacts on a Mac matching the target architecture. Apple silicon
has local runtime coverage; Intel remains unverified. Windows builds are unsigned;
Mac builds are ad-hoc signed and need Developer ID signing and notarization for
signed public distribution. Linux release packaging is not supported.

Local packages do not publish a release. CI creates a draft release when a new
package version lands on `main`; see the CI guide for the exact conditions.
