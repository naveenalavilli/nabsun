# Nabsun 0.1.6 — Codex sign-in fix

Fixed npm-installed Codex when Finder does not provide Node on PATH. The
launcher resolves Unix symlinks, prefers the native CLI, and uses the app's
bundled runtime for JavaScript-only launchers.

Validation: 51 CLI checks passed (one skip: Claude unavailable), TypeScript
passed, and the packaged app reported Codex connected with PATH limited to
`/usr/bin:/bin:/usr/sbin:/sbin`. No new login or model completion was needed.

The updated app is installed at `/Applications/Nabsun.app`. DMG, ZIP and
checksums are in `release/0.1.6/`. The initial Mac assessment follows.

## PR validation follow-up

The engine cache now records dylib aliases and rejects missing, redirected or
broken links. Both setup and release validation probe `llama-server --version`
so missing native dependencies fail before packaging. Old cache manifests are
refetched once. Release checks allow signing to change Mach-O bytes while still
checking library links and native startup.

Unsupported platforms retain portable model and licence downloads, followed by
manual engine instructions and an incomplete-setup exit code. A macOS CI job
runs launcher tests under Node and Electron, browser and inference checks, and
signed app payload validation. Release packaging now waits for both Windows
and Mac verification.

Follow-up validation passed locally: 322 existing harness checks, five payload
regression tests, CLI launching under Electron, TypeScript, and four publishing
configuration tests. A Linux-platform simulation verified the weights-only
fallback. A freshly packaged app passed deep signature verification and the new
payload startup check. GitHub-hosted Windows and macOS jobs remain to be run.

# Nabsun 0.1.5 — macOS release assessment

Nabsun is an Electron/Chromium browser with an integrated agent sidebar. Its
main distinction is that the sidebar and external agents use the same browser
tools and approval policy. It includes a local Qwen3 1.7B model through
llama.cpp, plus adapters for cloud models, Ollama, and agent CLIs. Browser
features include tabs, history, bookmarks, downloads and a password store.

The architecture is suitable for a local desktop release: page content runs in
isolated Chromium views, the privileged main process owns browser state, and
external agents connect through an authenticated loopback bridge. The small
bundled model is useful for basic requests and tool calls; complex tasks need a
more capable provider. This build is a working local release, not evidence of
cloud-provider compatibility or a complete security audit. Plugins run with
main-process privileges, and agent approval remains an important boundary.

## Fixed for this release

- Electron launch scripts now resolve the macOS application binary correctly.
- Model setup downloads the native macOS engine with pinned size and SHA-256,
  and distinguishes cached engines by platform and architecture.
- Release validation checks native engine files, executable permissions, model
  weights and licenses. Packaging rejects a mismatched engine architecture.
- macOS builds target the host architecture instead of putting one engine into
  both Intel and Apple silicon apps.
- Ad-hoc signing produces a valid local Apple silicon application signature.
- Closing the Mac window retains the runtime; Dock activation restores it.
- A native application menu restores standard Mac actions, and history uses
  Command-Y so it does not conflict with Command-H (Hide).

## Validation

Tested on Apple silicon macOS with Electron 44.2.0:

- TypeScript checks pass; dependency installation reports zero vulnerabilities.
- Full existing verification suite: 314 passing checks, three CLI availability
  checks skipped. Local inference was required, not skipped.
- Packaged app launches, renders browser chrome and connects its preload API.
- Packaged app uses its bundled engine and model to answer a chat request
  ("Hello!") successfully, without cloud credentials.
- Closing and activating the packaged app preserves one window and reopens it.
- Deep, strict code-signature verification passes for both the unpacked app and
  the app inside the mounted DMG. DMG checksum and packaged payload checks pass.
- Build-target guard accepts arm64 and rejects an x64 target with an arm64 engine.

## Run it

Open `release/Nabsun-0.1.5-arm64.dmg`, drag Nabsun into Applications and launch it.
Alternatively, open `release/mac-arm64/Nabsun.app` directly. The ZIP contains the
same app. Both archives include the offline model and are approximately 1.3 GB.
Checksums are in `release/SHA256SUMS.txt`.

This release is for Apple silicon Macs. Intel download support is configured but
has not been runtime-tested. The app is ad-hoc signed, not Developer ID signed
or Apple-notarized. Downloaded copies may require System Settings → Privacy &
Security → Open Anyway. Cloud provider calls and signed-in CLI agent turns were
not exercised. There is no automatic updater.

To rebuild on this Mac: `npm ci`, `npm run setup`, `npm run fetch:model`, then
`npm run dist:mac`. These commands create local artifacts and do not publish them.
