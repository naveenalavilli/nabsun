# Nabsun release notes

This is the maintained release history. New changes go into the unreleased
version below; the matching entry can be copied into a GitHub release when it
is published. Installation instructions live in the [README](README.md#install).

Historical entries were reconstructed from GitHub releases, tags and commit
history. **Published** dates use America/Chicago. A tag, a draft release or a
package-version change is not treated as proof of publication. Earlier versions
are marked accordingly, and their behavior may differ from the current product.

## Unreleased

No additional changes yet.

## 1.0.1 - Published November 11, 2026

Promotes the approved Windows rc.4 preview to the stable release.
Published after the Windows/macOS release checks and benchmarks passed, with
Windows x64 setup/portable executables, an Apple-silicon Mac ZIP, and verified
SHA-256 checksums. See the [published release](https://github.com/naveenalavilli/nabsun/releases/tag/v1.0.1).

### New and improved

- A clearer chat welcome, larger composer, and everyday task examples.
- Optional per-tool permissions for the current chat, with visible revocation.
  These choices do not grant folder access or upgrade a read-only folder.
- Connect a local folder with read-only or read-and-change access. Read,
  create, edit, append, copy, rename and organize supported files. Individual
  deletions use Recycle Bin/Trash, with no permanent-delete fallback.
- Create Word (.docx) documents, replace body text and append sections. Create
  Excel (.xlsx) workbooks and update cell values or explicit formulas. Edits
  preserve unrelated package parts and save original backups. Excel calculates
  formula results when opened. Unsupported protected/advanced formats refuse
  editing rather than overwriting them as text.
- Folder permissions belong to the chat and expire on disconnect or app exit.
  Revision checks detect conflicting edits; profile, path and link checks
  constrain operations to approved folders.

### Fixes

- Interactive Codex/Claude CLI tasks have a 30-minute default deadline and
  matching browser-access lifetime, replacing the silent five-minute cutoff.
- Remove the implicit 128,000-token cap from interactive CLI chats so reused
  context does not cause premature usage-limit stops. Usage reporting,
  provider limits, the 100-action limit and explicit workflow budgets remain.
- Distinct interruption reasons explain Stop, deadlines, disconnected access,
  integrations and provider failures. Explanations remain in reopened chats.
- Browser Stop still cancels pending work immediately and revokes delegated
  access. A provider exiting with an action pending cannot leave it running.

Builds remain unsigned on Windows and ad-hoc signed without Apple
notarization on macOS. See the README for installation steps and known limits.

## 1.0.1-rc.4 - Windows test preview

Windows x64 installer only, for testing before a production Windows/macOS
release. Includes the features and interruption fixes from 1.0.1-rc.3.

- Remove the implicit 128,000-token cap from interactive Codex/Claude chats.
  Reused context no longer triggers a premature AI usage-limit stop. Usage
  reporting, provider limits, 30-minute timeouts, the 100-action limit, and
  explicitly budgeted workflows remain unchanged.

## 1.0.1-rc.3 - Assistant interruption fixes

Includes the local-file and Word/Excel features from 1.0.1-rc.2. Built from
`fix/assistant-stop-reasons`, without merging to main.

- Interactive Codex/Claude CLI chats now have a 30-minute task limit instead of
  silently ending after five minutes. Browser-access credentials follow the
  same deadline; explicit workflow time limits remain unchanged.
- Interrupted turns explain whether Stop, a time limit, disconnected access,
  an integration, or a provider failure ended the task. The reason remains
  visible when reopening chat. AI usage/response limits also show an explanation.

## 1.0.1-rc.2 - Local files branch preview

Prepared from `feature/local-folder-access`, without merging to main. Includes
the chat and session-permission improvements from 1.0.1-rc.1.

- Choose a local folder for the current chat, with read-only or read-and-change
  access. The assistant can request access through a native folder picker and
  permission dialog; it cannot choose paths or grant itself access.
- Read text/code, CSV/TSV, XLSX, text PDFs and supported images. Create or edit
  UTF-8 text/CSV/code, append text, create subfolders, copy or rename regular
  files, and move files to Recycle Bin/Trash without permanent deletion.
  Binary document formats are not overwritten as text.
- Create Word (.docx) documents with headings and paragraphs, replace body text,
  and append new sections. Create Excel (.xlsx) workbooks and update cell values
  or explicit formulas. Unrelated package parts, including images and charts,
  are preserved. Formula results require recalculation in Excel. Unsupported
  protected, signed and advanced document structures are refused. Locked Word
  content controls and enclosing tracked revisions are also protected.
- Original text and Office files are backed up before edits. File hashes detect stale
  changes; path/link checks keep tool operations inside approved folders and
  protect Nabsun profile data. Activity records keep the existing redaction.
- Connected folders show their location and access level in chat. Disconnect
  revokes access and stops current work. Grants are memory-only, chat-bound,
  and expire on deletion or app shutdown.

## 1.0.1-rc.1 - Branch preview

Prepared from the session-permissions branch, independently of main. This is a
prerelease for review, with the broader 1.0 roadmap and release certification
still incomplete.

- New chat now starts with visual examples for finding and comparing options,
  getting help on websites, using files or images, and understanding a page.
- A larger message box keeps file attachments, microphone and Send together.
  Page context and automatic-action choices remain within reach.
- Everyday wording, light/dark layouts, narrow windows and 200% zoom support.
  Starter cards fill a draft; nothing runs until you send it.
- Optionally auto-allow an individual tool for the current chat, including page
  JavaScript. This covers follow-up prompts and websites in that chat. Turn it
  off below the conversation; grants reset on chat deletion or app shutdown.
  Other chats, tools and integration sources remain separate. Host policy,
  action limits, cancellation and structured credential checks still apply.

## 1.0.0 - Prerelease 2026-11-10

[GitHub prerelease](https://github.com/naveenalavilli/nabsun/releases/tag/v1.0.0),
from [PR #23](https://github.com/naveenalavilli/nabsun/pull/23).
These notes describe implemented changes, not certification of the full roadmap.

### Fixes

- Dictation can be closed with its Close button, Escape or a second microphone
  click, including during startup, after errors and when only system dictation
  guidance is available. Closing cancels capture and ignores late speech.

### New

- Attach images and files to a chat. Supported readers include text, CSV, TSV,
  XLSX and text-based PDF. Images have previews and can be read by compatible
  vision models. Attachments belong to their conversation.
- Dictate into the chat draft on Windows using installed desktop speech
  languages. Recording asks for consent, stops on request and never sends a
  message automatically. macOS/Linux provide system dictation guidance.
- Import or paste datasets, save parameterized workflows, and replay data-entry
  rows without a model when the workflow still matches the page.
- Pause, resume and review batch work, with durable checkpoints, per-row results,
  failure screenshots and CSV/JSON reports. Uncertain rows require review before
  another attempt.
- Upload chat-attached files to approved website fields and read downloads owned
  by the running chat.
- Review assistant activity in a full workspace with integrity checks, export,
  retention controls and fingerprinted page/typed values.
- Choose site permissions and configure network authentication, proxies and PAC
  URLs through application-owned controls.

### Improvements and fixes

- More reliable mouse and keyboard actions, with hit testing, cancellation,
  credential protection, iframe routing and open shadow-root support.
- More approachable Getting started guide, consistently sized desktop toolbar
  controls, and a brighter transparent half-sun icon.
- Task-bound CLI browser access, host action/time limits, per-action history and
  credential revocation on Stop or completion.
- Isolated plugin processes, source/configuration review for integrations,
  filtered inherited environment variables, and independent integration switches.
- Fixed inactive-window input on Linux, native dropdown selection on macOS,
  macOS plugin path aliases, stale PAC configuration, and late callbacks that
  could recreate a deleted chat.
- Expanded regression coverage across Windows, macOS and Linux. The scripted
  browser-task benchmark improved from 63/111 to 111/111 attempts. A forced-close
  workflow test resumed after row 20 and completed exactly 50 submissions without
  duplicates or model calls. These are fixture results, not a general model
  accuracy score.

### Upgrade notes

- Old global "always allow" grants are revoked with a migration notice. New
  approvals can apply once, to the current task on a site, or to a tool/site for
  24 hours; saved site grants can be revoked in Settings.
- New or changed plugins and MCP configurations require review. MCP servers must
  use an installed executable or entry script; dynamic runners such as `npx`
  are no longer accepted. MCP servers remain trusted native code.
- Visual image analysis requires a compatible model with image support enabled.
  Dictation language choices depend on installed Windows speech recognizers.
- Native macOS dropdowns use character type-ahead. Ambiguous labels and some
  other controls use explicitly reported DOM compatibility fallbacks.

### Still pending

Bundled-model task reliability, tiered routing/model evaluation, profiles/private
mode, slimmer distribution and wider release certification remain unfinished.
Production installer/signing/notarization and licensing decisions are deferred.
See the [implementation and verification record](docs/improvement-status.md).

## 0.1.13 - Published 2026-11-03

- Fixed destroyed-window exceptions caused by timers and callbacks completing
  during shutdown.
- Simplified the assistant header and made everyday controls easier to find.
- Added page-focused Chromium DevTools controls for developers.
- Improved first-use guidance and kept advanced controls available.
- Fixed cold macOS packaged-engine verification and preserved valid package
  signatures during verification.
- Included the full-window Settings and visual setup changes prepared for 0.1.12.

[GitHub release](https://github.com/naveenalavilli/nabsun/releases/tag/v0.1.13)
and [changes since the previous published version](https://github.com/naveenalavilli/nabsun/compare/v0.1.11...v0.1.13).

## 0.1.12 - Draft only

No public publication date or remote version tag was found. A draft GitHub
release exists; these changes subsequently appeared in published 0.1.13.

- Replaced the sliding Settings panel with a full browser workspace and visual
  first-use setup.
- Modernized controls with accessible switches and consistent styling.
- Aligned window controls with Windows conventions and native macOS traffic lights.

Sources: [Settings workspace PR #19](https://github.com/naveenalavilli/nabsun/pull/19)
and [version preparation PR #20](https://github.com/naveenalavilli/nabsun/pull/20).

## 0.1.11 - Published 2026-10-25

- Let the assistant remain attached or move into a detached window.
- Added independent assistant text zoom from 75% to 200%.
- Added queued follow-up prompts with cancellation before they start.
- Fixed Stop handling for running tasks, pending prompts and CLI processes.
- Preserved chat state and drafts across assistant visibility/window changes.

[GitHub release](https://github.com/naveenalavilli/nabsun/releases/tag/v0.1.11)
and [changes](https://github.com/naveenalavilli/nabsun/compare/v0.1.10...v0.1.11).

## 0.1.10 - Published 2026-10-14

- Simplified the Assistant panel and kept model selection in Settings.
- Made color-mode selection consistent with the rest of the interface.

[GitHub release](https://github.com/naveenalavilli/nabsun/releases/tag/v0.1.10)
and [changes](https://github.com/naveenalavilli/nabsun/compare/v0.1.9...v0.1.10).

## 0.1.9 - Published 2026-10-12

- Added first-run onboarding and a refreshed model picker with search, custom
  model IDs and remembered choices.
- Added Classic, Playful, Blossom and Ocean appearances with light, dark or
  system color mode.
- Added update notifications at startup and every 24 hours, with a manual check
  in Settings. Update installation remained manual.
- Improved address-bar editing, keyboard navigation and suggestions.
- Made Settings report save failures and preserve previous values; fixed
  duplicate sections during overlapping refreshes.
- Removed inconsistent browser-identity overrides to improve site compatibility.

[GitHub release](https://github.com/naveenalavilli/nabsun/releases/tag/v0.1.9)
and [changes](https://github.com/naveenalavilli/nabsun/compare/v0.1.8...v0.1.9).

## 0.1.8 - Published 2026-09-23

- Reduced page snapshots and added paginated text reads.
- Compacted older observations and stale screenshots while preserving action
  records, with a configurable hosted-request input-token budget.
- Added searchable on-device memory with bounded notes, deletion and local-only
  sharing by default.
- Displayed token totals in chat and preserved them across restarts.
- Improved Anthropic caching and provider usage accounting.

[GitHub release](https://github.com/naveenalavilli/nabsun/releases/tag/v0.1.8)
and [changes](https://github.com/naveenalavilli/nabsun/compare/v0.1.7...v0.1.8).

## 0.1.7 - Published 2026-09-22

- Added macOS Apple silicon archive distribution and strengthened native payload
  checks and file hashing.
- Improved Codex/Claude installation, sign-in, account status and cancellation.
- Fixed OAuth login popups returning users to the original sign-in screen by
  preserving their connection to the originating tab, shared sessions, POST data
  and referrers.
- Improved application IPC boundaries, external-link handling and documentation.

[GitHub release](https://github.com/naveenalavilli/nabsun/releases/tag/v0.1.7)
and [changes](https://github.com/naveenalavilli/nabsun/compare/v0.1.6...v0.1.7).

## 0.1.6 - Published 2026-09-21

- Hardened macOS builds, platform-specific engine checks and release verification.
- Made signature verification distinguish certificate-signed releases from
  unsigned verification builds.
- Added the version-bump release helper and CI draft-release workflow.

[GitHub release](https://github.com/naveenalavilli/nabsun/releases/tag/v0.1.6)
and [changes](https://github.com/naveenalavilli/nabsun/compare/v0.1.5...v0.1.6).

## 0.1.5 - Published 2026-09-17

- Added optional personal context through `soul.md`, with local-only sharing by
  default and Settings controls for editing/sharing it.
- Added release automation and refined documentation and browser controls.
- Included the personal-context work prepared under development version 0.1.4.

[GitHub release](https://github.com/naveenalavilli/nabsun/releases/tag/v0.1.5)
and [changes](https://github.com/naveenalavilli/nabsun/compare/v0.1.3...v0.1.5).

## 0.1.4 - Development snapshot

The package version appeared during personal-context development. No matching
release or version tag was found; this is not recorded as a separate public release.
The work was included in 0.1.5.

Source: [personal-context implementation](https://github.com/naveenalavilli/nabsun/commit/c60aa55baf6b21d7e07263737cfa947c78abd11d).

## 0.1.3 - Historical tag

The remote tag exists, but no published GitHub release was found in the current
release records. A publication date is therefore not assigned.

- Updated the application icon.
- Reduced verbose assistant output by default and added controls for detailed traces.
- Changed browser identity headers and site-compatibility settings. These older
  overrides were subsequently removed in 0.1.9.
- Included the earlier preview's visual, session-recovery and CI fixes.

[Tagged source history](https://github.com/naveenalavilli/nabsun/commits/v0.1.3/).

## 0.1.2 - Local historical tag only

A local tag identifies commit `a906669`, but no remote tag or GitHub release was
found. That commit is not an ancestor of the 0.1.3 tag; it is not treated as proof
that a public 0.1.2 release shipped.

- Fixed migration from the earlier profile name, using a completion marker and
  staging interrupted copies instead of treating an empty directory as migrated.
- Retained failed session writes in memory so later recovery could preserve
  both the user's request and the assistant's response.

Source: the local `v0.1.2` tag and its commit message. No public source URL is
claimed for this local-only record.

## 0.1.1 - Historical tag

The remote tag exists; no published GitHub release or publication date was found.

- Kept an assistant turn from failing solely because its history could not be
  written, preserving the visible answer despite a persistence error.

[Tagged source history](https://github.com/naveenalavilli/nabsun/commits/v0.1.1/).

## Beta - Historical preview tag

The remote `Beta` tag points to a snapshot whose package version is 0.1.1. It is
listed separately because it contains changes after the `v0.1.1` tag. No published
GitHub release or publication date was found for this tag.

- Refreshed the color palette and internal pages.
- Normalized internal-page Content Security Policy hashes across line endings.
- Improved profile migration, session persistence and Windows CI artifact uploads.

[Tagged source history](https://github.com/naveenalavilli/nabsun/commits/Beta/).

## 0.1.0 - Initial historical tag

The remote tag exists; no published GitHub release or publication date was found.

- Initial Chromium-based browser with tabs, bookmarks, history, downloads and
  saved-password support.
- Built-in local inference, cloud-provider adapters, Codex/Claude CLI connections,
  and an external MCP bridge with approval-gated browser tools.
- Plugin/MCP integration and partial unpacked Chrome-extension support.
- Refreshed browser chrome and corrected dark mode on internal pages.

[Tagged source history](https://github.com/naveenalavilli/nabsun/commits/v0.1.0/).

## Maintaining this file

1. Add user-visible changes to the unreleased version as they are implemented.
2. When bumping `package.json`, add or update the matching entry here. Keep
   unfinished work and compatibility changes explicit.
3. Before publishing a GitHub draft, copy its matching entry into the release
   description while retaining the platform/download instructions.
4. Once published, record its actual publication date in America/Chicago and link
   the GitHub release. A merge, successful CI run or tag alone does not mark it published.
5. Preserve historical entries. Add corrections with evidence, and do not invent
   missing versions, publication dates or verification results.
