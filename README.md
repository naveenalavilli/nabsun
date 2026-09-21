# Nabsun

**A browser with an AI assistant built in.** Read pages, compare tabs, and complete
browser tasks using a bundled local model, a cloud provider, Codex, or Claude Code.

[Website](https://nabsun.com) · [Downloads](https://github.com/naveenalavilli/nabsun/releases/latest) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

[![Watch the Nabsun demo on YouTube](https://i.ytimg.com/vi/mCyKPYy7OHw/hqdefault.jpg)](https://www.youtube.com/watch?v=mCyKPYy7OHw)

## Install

Get an available build for your platform from [GitHub Releases](https://github.com/naveenalavilli/nabsun/releases/latest).

- **Windows x64:** choose `Nabsun-<version>-x64-setup.exe` to install, or
  `Nabsun-<version>-portable.exe` to run without installing.
- **macOS:** check the release assets for your architecture, or build on a Mac.
  Apple silicon has been tested locally; Intel remains unverified.
- **Linux:** release packaging is not yet supported.

The bundled Qwen3 1.7B model runs on your CPU without an account or API key.
Windows downloads are about 1.4 GB because they include the model. Local inference
works offline; accessing websites and cloud assistants requires internet access.

Windows builds are unsigned; Mac builds use ad-hoc signing without notarization.
Compare your download with the release's `SHA256SUMS.txt`, for example:

```powershell
Get-FileHash .\Nabsun-<version>-x64-setup.exe -Algorithm SHA256
```

## Use the assistant

Open the assistant with **Ctrl+Shift+A** and ask about a page or give it a task.
The built-in model is suitable for simple tasks; use a larger model for complex work.

To connect **Codex** or **Claude Code**:

1. Open **Extensions → Assistants**.
2. Click **Connect Codex** or **Connect Claude Code**.
3. Complete provider sign-in and wait for **Connected** or **Active**.

Nabsun installs the official native CLI when needed and reuses existing sign-ins.
No terminal commands, npm packages, or separate Node.js installation are required.
Your provider account must have access to the assistant. Use **Repair / update**
if the connection needs fixing.

Credentials remain in the provider CLI's store. **Sign out** also signs that CLI
out outside Nabsun. Claude Code may open your system browser during sign-in.

For Anthropic, OpenAI, Ollama, or a different local model, choose a provider in
**Settings**. Cloud API providers require an API key.

## Features and controls

- Tabs, bookmarks, history, downloads, session restore, and encrypted saved passwords.
- Page reading, research, form filling, and browser actions in your existing tabs.
- Approval prompts for clicks, typing, navigation, and page code by default.
  **Always allow this tool** and **Autopilot** change those permissions.
- Optional personal context in `soul.md`, shared only with local models by default.
- Plugins, MCP servers, and unpacked Chrome extensions. Chrome API support is partial;
  there is no Chrome Web Store installation flow.

To let an external agent use Nabsun, copy the MCP configuration from
**Settings → Integrations → Connect an external agent**. Browser tools use the
same approval settings as the sidebar. Only install plugins and MCP servers you trust.
See [Security](SECURITY.md) for permissions, credential handling, and limitations.

## Develop

With Node.js and npm installed, run these commands from the repository root:

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

## Current limits

Nabsun is a developer preview. There is no automatic update, profile sync, or
private browsing mode. The small local model can struggle with long tasks, and
website compatibility varies. Review actions before approving them.

[Architecture](ARCHITECTURE.md) · [MIT license](LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)

Created by [Naveen Alavilli](https://github.com/naveenalavilli).
