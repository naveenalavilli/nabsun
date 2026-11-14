# Nabsun

**An AI browser for getting things done across your tabs and files.** Find
information, prepare forms, create a Word document, or update an Excel sheet.
Choose the access, review the work, and use Stop whenever you need to.

The latest stable release is [1.0.1](https://github.com/naveenalavilli/nabsun/releases/tag/v1.0.1),
with Windows x64 and Apple-silicon Mac downloads. Free and open source under the
MIT license. Optional online AI services may require an account and charge fees.

[Website](https://nabsun.com) · [Downloads](https://github.com/naveenalavilli/nabsun/releases/latest) · [Release notes](RELEASE_NOTES.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

[![Watch the Nabsun demo on YouTube](https://i.ytimg.com/vi/mCyKPYy7OHw/hqdefault.jpg)](https://www.youtube.com/watch?v=mCyKPYy7OHw)

## Install

Get an available build for your platform from [GitHub Releases](https://github.com/naveenalavilli/nabsun/releases/latest).

- **Windows x64:** choose `Nabsun-<version>-x64-setup.exe` to install, or
  `Nabsun-<version>-portable.exe` to run without installing.
- **Mac with an Apple M-series chip:** choose `Nabsun-<version>-arm64.zip`.
  There is no Intel Mac installer in the current release.
- **Linux:** no published installer; source builds require manual engine setup.

### Windows

1. Open the downloaded setup file and follow the installer.
2. If Windows shows **Windows protected your PC**, choose **More info**. If you
   trust the official download, choose **Run anyway**.
3. Open **Nabsun** from the Start menu. The portable build opens directly.

Windows builds are unsigned. Some managed computers or security policies do not
offer an exception; ask your administrator rather than disabling protection.

### Mac

1. Check **Apple menu > About This Mac** for an Apple M-series chip.
2. Open the downloaded ZIP and drag **Nabsun.app** to **Applications**.
3. Open Nabsun. If macOS cannot verify the developer, dismiss the message. If
   you trust the official download, use **System Settings > Privacy & Security >
   Open Anyway**, then confirm the opening.

Mac builds are ad-hoc signed, without an Apple Developer ID signature or
notarization. A damage or malware warning needs investigation; do not treat it
as an ordinary publisher warning. See the [illustrated installation steps](https://nabsun.com/#download).

### Local AI and download checks

The bundled Qwen3 1.7B model runs on your CPU without an account or API key.
Downloads are about 1.4 GB because they include the model. Local inference
works offline; accessing websites and cloud assistants requires internet access.

Windows builds are unsigned; Mac builds use ad-hoc signing without notarization.
Compare your download with the release's `SHA256SUMS.txt`, for example:

```powershell
Get-FileHash .\Nabsun-<version>-x64-setup.exe -Algorithm SHA256
```

On Mac, use `shasum -a 256` followed by the downloaded ZIP's path. A matching
checksum confirms the file matches that release; it does not establish publisher
identity or guarantee safety.

## Use the assistant

1. Review the first-use acknowledgement, then choose the built-in assistant
   in the getting-started guide. No account or
   API key is needed; you can also choose to browse without the assistant.
2. Open a website, then open the assistant. Choose **Use this page** when you
   want to include page context.
3. Type a task or choose an editable example, review it, and press **Send**.
   Approve requested actions and check the result.

Try "Find this store's return policy," "Compare these open tabs," or "Prepare
this form and let me review it before submitting." The video above shows an
earlier version; current releases also work with approved local folders.

Nabsun checks for new releases at startup and every 24 hours. Click **Update
available** in the toolbar to download one, or use **Settings > App updates** to
check manually. Updates require downloading and running the new installer.

The first-run guide lets you try the built-in assistant, connect Codex or Claude,
or start browsing without opening the assistant. Reopen it from **Settings → Getting started**.

Open **Settings** with the browser toolbar gear or from **Assistant options**. Settings
and the visual getting-started guide use the full browser content area. Choose
a category from the left, or search for a category such as model, theme, or
privacy and press Enter. Advanced local-model file paths and tuning controls
stay collapsed until requested. Preferences save as you change them. Use **Back to
browser** or Escape to return to the same tab; your chat and assistant layout
are preserved. The setup tour is available from **Getting started**.

Open the assistant with **Ctrl+Shift+A** (**Cmd+Shift+A** on Mac) and ask about a page or give it a task.
Open **Assistant options (⋯)** for **Detach assistant** to move it into a separate
window, or **Attach assistant** to bring it back. Your choice is saved. Use the
header's **Hide assistant** button or close the
detached window to hide the assistant; reopening preserves your chat and draft.
Use **Text size** in Assistant options or **Ctrl/Cmd + Plus, Minus, or 0** to enlarge, shrink,
or reset the assistant text. The zoom level is saved independently of website zoom.
**Stop** cancels active assistant work and browser tool calls, including CLI subprocesses.
Interactive Codex/Claude CLI chats have a 30-minute default time limit and a
100-action limit for Nabsun tools; workflows can have shorter explicit budgets.
Ordinary interactive CLI chats have no extra cumulative token cap; provider
limits still apply. Automatic interruptions explain their cause
and keep that explanation in chat history. Review completed actions before
asking the assistant to continue.
Send more prompts while a reply is running to queue follow-ups in the same chat.
They run in order; use **Cancel** beside any queued prompt to remove it before
it starts. **Stop** also clears queued prompts. Queues remain available when you
switch chats or hide the assistant, and last until the app closes. **Use this page**
uses the page open when that queued prompt starts.
For a first try, choose an example question in the empty chat. It fills the
message box without sending it; edit it and press Send when ready. Use the
Getting started guide link whenever you need a refresher. The built-in assistant
is best for short, simple tasks. Optional account connections and advanced
preferences remain in Settings.

Chat history, Settings, Extensions, Bookmarks, and Saved passwords are also in
Assistant options. New chat and Hide remain directly in the compact header.

### Permissions and attachments

Choose an approval mode under **Settings > Assistant & permissions**:

- **Ask for approval:** read automatically; ask before changing pages or files.
- **Approve routine actions:** allow routine actions on the first site in a
  task; ask for other sites, uploads, page scripts, and file changes.
- **Full access:** after explicit confirmation, run tools without repeat
  approval prompts. This also applies to connected external agents. Folder
  selection, read-only limits, credential guards, and host policy still apply.

Changing modes clears earlier task, site, and chat auto-allow choices. The
composer shows your current mode. **Show approval messages in chat** is off by
default and independent of Verbose mode; pending requests and declined actions
remain visible, and the activity journal is still recorded.

Read tools run automatically by default; actions that change a page ask first.
Approval choices can apply once, to a task on a site, or to a tool/site for 24
hours. Old global grants are revoked during migration.

The optional **Auto-allow this tool for this chat session** checkbox reduces
repeat prompts for that tool across sites and follow-up messages in this chat.
It can include powerful tools such as page JavaScript and uploads. Uncheck the
grant below the conversation to ask again. Choices last in memory until
revoked, the chat is deleted, or the app closes; Stop cancels the task but keeps
them for later prompts. They do not grant folder access, upgrade a read-only
folder, or bypass host policy. See [Security](SECURITY.md).

Attach files or images beside the message box. Image understanding requires a
vision-capable model. Dictation is temporarily hidden while its reliability is
improved; its microphone control cannot start the service from chat.

### Work with files on your computer

Click **Folder** beside the message box, choose a folder, and select **Read only**
or **Read and make changes**. You can also ask Nabsun to work with local files;
it will ask you to choose and approve a folder when needed.

For example: "Read the reports in this folder and save a summary as a Markdown
file," or "Organize these files into a new subfolder." Access applies to this
chat until you disconnect the folder, delete the chat, or close Nabsun.
**Disconnect** cancels active and queued work. Files you read may be shared with
your selected AI service and remain in chat history after access is revoked.

Create and edit text, CSV and code files, Word (.docx) documents, and Excel
(.xlsx) workbooks. Ask "Create a Word project plan" or "Update the expenses in
this spreadsheet." Word supports body-text replacements and new paragraphs or
headings. Excel supports values and explicit formulas in named sheets.
Unchanged package parts, such as images and charts, are preserved. Formula
results are calculated by Excel when opened; manual calculation settings are
preserved. Protected documents, macros, signed-document edits, old .doc/.xls
formats and advanced structural edits are unsupported. PDFs and supported
images can be read. Copying/renaming preserves the file's bytes. You can append text and move files
to Recycle Bin/Trash; there is no permanent-delete operation.
Edits and Trash operations save an original backup in the chosen folder's
**.nabsun-backups** subfolder. To restore one, copy the backup to another
location and rename it with its original extension (for example, `.docx` or
`.xlsx` instead of `.bak`). Keep the current file until you confirm the restored
copy is correct.
Files are limited to 20 MB for reading/copying and 2 MB for text changes.
See the [local files guide](https://nabsun.com/local-files) for examples.

## Developer tools

Use **Developer → Toggle Page Developer Tools**, **F12**, or
**Ctrl+Shift+I** on Windows/Linux (**Option+Command+I** on Mac) to toggle
Chromium DevTools for the active webpage. Inspect HTML/CSS in Elements, run
JavaScript in Console, and use Network, Sources, Performance, Memory, and
Application tools supplied by the bundled Chromium version.

DevTools opens docked on the right. Its own dock controls let you change the
layout; **Developer → Open Page Developer Tools in a Separate Window** opens
it separately. Right-click a page and choose **Inspect element** to inspect
that location. View Page Source remains available with **Ctrl/Cmd+U**.
**Developer → Inspect Nabsun Browser UI** is a separate action for debugging
Nabsun itself; normal page shortcuts do not inspect the browser UI.

These are Chromium's tools, rather than Firefox-specific tooling. Extension
and panel availability depends on the Electron/Chromium version.

## Connect an assistant

To connect **Codex** or **Claude Code**:

1. Open **Extensions → Assistants**.
2. Click **Connect Codex** or **Connect Claude Code**.
3. Complete provider sign-in and wait for **Connected** or **Active**.

Nabsun installs the official native CLI when needed and reuses existing sign-ins.
No terminal commands, npm packages, or separate Node.js installation are required.
Your provider account must have access to the assistant. Use **Repair / update**
if the connection needs fixing.

Choose a provider and model in **Settings → Model**. Each provider remembers
its selection for your next message. **Default** uses the CLI's own settings;
**Other model…** accepts a specific model ID. Availability depends on your account.

Credentials remain in the provider CLI's store. **Sign out** also signs that CLI
out outside Nabsun. Claude Code may open your system browser during sign-in.

For Anthropic, OpenAI, Ollama, or a different local model, choose a provider in
**Settings**. Cloud API providers require an API key.

## Features and controls

- **Settings → Appearance:** Classic, Playful, Blossom, or Ocean, with light, dark,
  or device color mode. Themes change the look, not content or safety settings.
- Tabs, bookmarks, history, downloads, session restore, and encrypted saved passwords.
- Page reading, research, form filling, and browser actions in your existing tabs.
- Approval prompts for clicks, typing, navigation, and page code by default.
  Approvals can apply once, to the task on that site, or to that tool/site for
  24 hours. Old global grants are revoked with a migration notice.
- Chat image and file attachments, with image previews and vision-model support.
  Documents and data support text, CSV, TSV, XLSX and text-based PDF reading.
- A first-use acknowledgement explains AI mistakes, permission choices,
  shared context, and the early open-source release before the setup guide.
  Existing profiles are not recorded as having accepted it during migration.
- A full data workspace for datasets, saved workflows, batch replay and per-row
  reports. Uncertain rows pause for review before another attempt. Tasks that
  modify local files cannot yet be saved as browser-only workflows.
- A local activity journal with integrity checks and export.
- Optional personal context in `soul.md`, shared only with local models by default.
- Plugins, MCP servers, and unpacked Chrome extensions. Chrome API support is partial;
  there is no Chrome Web Store installation flow.

To let an external agent use Nabsun, copy the MCP configuration from
**Settings → Integrations → Connect an external agent**. Browser tools use the
same approval settings as the sidebar. Only install plugins and MCP servers you trust.
External clients cannot claim an existing chat's folder permissions or
chat-session grants. Hosted Codex/Claude tasks instead receive temporary
credentials bound to the owning chat and its permitted tools.
New or changed integrations require source review. MCP servers must be installed
locally and configured through their executable or entry script; dynamic package
runners such as `npx` are no longer accepted. Plugins, MCP and unpacked extensions
can be disabled independently in Settings.
See [Security](SECURITY.md) for permissions, credential handling, and limitations.

The [implementation and evidence record](docs/improvement-status.md) tracks
remaining release work and evaluation limits. Scripted browser-tool success is
not a model-quality guarantee. A stable release designation does not imply
independent security certification or reliable completion on every website.

## Develop

Use Node.js 22 (the CI version) and npm. From the repository root:

```bash
npm ci
npm run fetch:model
npm start
```

Run `npm run setup` if Electron did not download during installation.
`fetch:model` downloads and verifies the engine, model weights, and licenses.
On Linux, it downloads the weights but exits with manual engine setup instructions.

```bash
npm run dev        # Watch source files and launch
npm run typecheck
npm run verify     # Automated checks, including bundled local inference
```

## Build installers

After the setup above, build on the target operating system:

```bash
npm run dist:win   # Windows x64 installer and portable executable
npm run dist:mac   # DMG and ZIP for the current Mac architecture
```

Output goes to `release/`. Packaging verifies the bundled engine, model, and
licenses. macOS packaging requires a Mac; public signed distribution also requires
a Developer ID certificate and notarization.

Current public Mac downloads are Apple silicon ZIPs; building a DMG locally
does not publish a release. All updates to `main` go through a PR and required
checks. The protected [`releases/v-0-x`](https://github.com/naveenalavilli/nabsun/tree/releases/v-0-x)
branch preserves **0.1.13** and is locked against updates and deletion.
See the [CI guide](.github/README-CICD.md) for previews and draft publication.

## Current limits

Nabsun is an early open-source product. There is no automatic update installation, profile sync, or
private browsing mode. The small local model can struggle with long tasks, and
website compatibility varies. Review actions before approving them.
Prompt injection remains a risk. Plugins and MCP servers are trusted native
code, not a complete OS sandbox. Trusted publisher signing and Apple
notarization remain unfinished; see [Security](SECURITY.md).

[Architecture](ARCHITECTURE.md) · [MIT license](LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)

Created by [Naveen Alavilli](https://github.com/naveenalavilli).
