# Nabsun

**A browser for AI.**

Chromium as an execution environment for agents. The browser is the runtime: it
supplies the tools, the page state, the permissions and the lifecycle. The agent
is the program. The live, signed-in web is what it operates on.

That framing is the point. Most AI browsers bolt an assistant onto a browser and
expose a chat box. Here the browsing surface *is* the API — the same tools, the
same authorisation gate and the same tab state are available to the assistant in
the sidebar, to a Codex or Claude Code process running in your editor, and to a
plugin you wrote yourself. What changes is which program is running, not what it
can do or what it must ask permission for.

You can still use it as an ordinary browser, and it behaves like one.

What makes it different:

- **It works out of the box, offline.** A small model ships inside the app and
  runs on your CPU — no account, no API key, no outbound request, so it also
  works on a network with no route to the internet. Point it at something
  larger whenever you want.
- **It doesn't pick your model for you.** Claude, OpenAI, a local Ollama model —
  or hand the whole turn to the Codex / Claude Code CLI you are already signed
  into, so no API key is stored here at all.
- **It works in both directions.** It is also an MCP server, so Claude Code or
  Codex in your editor can drive your real, logged-in browser — through the same
  approval gate the sidebar uses.
- **It can run entirely offline.** On the built-in model — or your own Ollama —
  no page content leaves the machine. There is no telemetry anywhere in the
  codebase.

Built the way VS Code is built: Chromium renders the web, a privileged host
process hosts the runtime, and plugins, MCP servers and Chrome extensions extend
what programs running in it can do.

[![verify](https://github.com/naveenalavilli/nabsun/actions/workflows/verify.yml/badge.svg)](https://github.com/naveenalavilli/nabsun/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Status:** working, and honestly documented. 241 automated checks run against
> real Electron on every push. A live model turn has not been exercised in CI —
> see [Verification](#verification). Read [SECURITY.md](SECURITY.md) before
> pointing it at accounts you care about.

[Architecture](ARCHITECTURE.md) · [Security](SECURITY.md) ·
[Contributing](CONTRIBUTING.md) · [Status](TASKS.md) ·
[Third-party notices](THIRD-PARTY-NOTICES.md)

---

## Quick start

```bash
npm install
npm run setup       # only if the Electron binary did not download during install
npm run fetch:model # the built-in model: llama.cpp + weights, ~1.2 GB
npm run build
npm start
```

That is the whole setup — no account and no API key. `fetch:model` pulls the
inference engine and the model into `vendor/`, which is gitignored and bundled
into the installer at package time, so an installed copy needs no download.

To use something larger, open the sidebar (**Ctrl+Shift+A**) → **⚙ Settings →
Model** and pick a provider. Keys are encrypted with the OS keychain (DPAPI on
Windows) via Electron `safeStorage`; `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` work
as a fallback if you prefer environment variables.

| Provider | Default model | Needs |
|---|---|---|
| **Built-in (local)** — default | `Qwen3-1.7B-Q4_K_M` | nothing; runs on your CPU |
| Anthropic | `claude-opus-5` | API key |
| OpenAI / Codex | `gpt-5.1` | API key |
| Ollama | `llama3.1` | a local Ollama server, no key |
| **Claude Code (CLI)** | the CLI's own default | `claude` installed and signed in |
| **Codex (CLI)** | the CLI's own default | `codex` installed and signed in |

The built-in model is small — 1.7B parameters. It handles ordinary navigation
and page questions and costs nothing to run, and it will lose the thread on long
multi-step research. Switch providers for that; your settings for each are kept
separately. The model file, engine path, context size and thread count are all
configurable, so any GGUF you already have drops in.

The model field is free text, so any id your account can reach works even if it
is not in the dropdown.

### Using Claude Code or Codex, like the VS Code extensions

If you already use the Claude Code or Codex CLI, pick it as your provider and
Nabsun will run it for each request — **using the login you already have
there, so no API key is stored in the browser.** This is the same arrangement as
those tools' VS Code extensions: the CLI brings its own agent loop and its own
auth, and the editor (here, the browser) supplies the tools.

```bash
npm i -g @anthropic-ai/claude-code   # then: claude   (sign in once)
npm i -g @openai/codex               # then: codex    (sign in once)
```

Nabsun hands the CLI this browser as an MCP tool server, so it can snapshot
pages, click, type and extract here. The CLI's own file and shell tools stay
disabled, and every browser action still goes through the approval gate.

### Driving this browser from VS Code

The same connection works in reverse. **Settings → Integrations → Connect an
external agent** shows a ready-to-paste MCP config:

```json
{
  "mcpServers": {
    "nabsun": {
      "command": "node",
      "args": ["<path>/dist/bin/nabsun-mcp.js"],
      "env": {
        "NABSUN_BRIDGE_URL": "http://127.0.0.1:<port>",
        "NABSUN_BRIDGE_TOKEN": "<token>"
      }
    }
  }
}
```

Point Claude Code, Codex, or any MCP client at that — including the ones in your
editor — and your agent there can drive this browser. The bridge listens on
loopback only, the token is regenerated every launch, and each call still asks you
for approval in the sidebar.

### Development

```bash
npm run dev        # esbuild watch + launch
npm run typecheck
npm run verify     # all six harnesses below
```

> **If the app exits immediately with no window**, check whether
> `ELECTRON_RUN_AS_NODE=1` is set — VS Code and Cursor export it to terminals
> they spawn, and it makes `electron.exe` start as plain Node. Every npm script
> here goes through `scripts/electron-run.mjs`, which strips it; a bare
> `electron .` will not.

---

## What it can do

**Ask about what you're reading.** The sidebar sees the current page, so
"summarise this", "what's the catch in section 4", "compare this to the other tab"
work without any setup.

**Hand it a task.** It snapshots the page, finds the elements, types and clicks,
and re-reads the result — the same loop a person runs.

**Watch it work.** The assistant acts in the tab you are looking at, and tabs it
opens come to the front, so you can follow along and take the page over at any
point. When something is genuinely your call — which result you meant, what to
put in a field — it asks in the sidebar and waits for your answer instead of
guessing.

**Research without losing your place.** It opens background tabs, extracts
structured data from result lists in one call, and can keep notes across sessions.

## As a browser

**Saved passwords.** Sign in to a site and Nabsun offers to save the
credential; come back and it fills it in. Passwords are encrypted with your
operating system's keychain (DPAPI on Windows, Keychain on macOS, libsecret on
Linux) — never written in plaintext — and autofill matches the **exact origin**,
so a credential saved for `https://example.com` is never offered to
`http://example.com` or to a subdomain. Manage them from the key button in the sidebar: show,
copy, delete, or delete everything. Turn the whole feature off in Settings.

The assistant **cannot** type credentials — password and one-time-code fields
refuse it, and their values are redacted from everything the model can read.
Passwords are the browser's job, not the model's. If your OS has no working
keychain, nothing is saved rather than being written somewhere recoverable.

**Bookmarks.** ☆ or **Ctrl+D** to save, with a bookmarks bar under the address
bar (**Ctrl+Shift+B** to toggle). The ★ button opens the manager: rename, move
between folders, show or hide on the bar, delete.

**Favourites on the new tab page** — bookmarks you keep on the bar, then your
most-visited sites, one tile per site.

**Clear browsing data** — history, cookies and site data, cached files, saved
passwords and bookmarks, each independently, in Settings.

The rest of what you'd notice if it were missing:

- **Right-click menus** for links, images, media, selected text and editable
  fields — open in new tab, copy address, save image, search the selection,
  spelling suggestions, view source, inspect element — plus *"Ask the assistant
  about this"* on a selection, an image, or the whole page.
- **Downloads** save to your Downloads folder without a dialog, de-duplicating
  `report.pdf` into `report (2).pdf`. A toolbar badge and sidebar panel show
  progress, and let you pause, cancel, open, or reveal in the folder.
- **Session restore** — reopen and your tabs come back.
- **Error pages** that say "This site can't be found" and what to try, rather
  than leaving you on a blank page, with the address preserved for a retry.
- **Tab drag-to-reorder**, middle-click to close, audio indicators, and
  Ctrl+Shift+T to undo a close.
- Bad TLS certificates are refused rather than offering a click-through.

### Keyboard

| | |
|---|---|
| **Ctrl+L** | Address bar (an overlay palette, with history and bookmarks) |
| **Ctrl+Shift+P** | Command palette |
| **Ctrl+Shift+A** | Toggle the assistant |
| **Ctrl+T / Ctrl+W** | New / close tab |
| **Ctrl+Shift+T** | Reopen the last closed tab |
| **Ctrl+Tab / Ctrl+Shift+Tab** | Next / previous tab |
| **Ctrl+1…8 / Ctrl+9** | Jump to tab / last tab |
| **Ctrl+R / Ctrl+Shift+R** | Reload / hard reload |
| **Ctrl+ + / − / 0** | Zoom in, out, actual size |
| **Ctrl+F** | Find in page |
| **Ctrl+H / Ctrl+J** | History / downloads |
| **Ctrl+D** | Bookmark this page |
| **Ctrl+Shift+O** | Bookmarks manager |
| **Ctrl+Shift+B** | Show or hide the bookmarks bar |
| **F11** | Full screen |
| **Ctrl+P** | Print |
| **F12** | Dev tools for the page · **Ctrl+Shift+I** for the browser's own UI |

---

## Permissions

The assistant is driving a browser signed into your real accounts, so every tool
declares a risk level:

| Risk | Examples | Default |
|---|---|---|
| `safe` | read the page, search, extract, screenshot | runs automatically |
| `write` | click, type, navigate, open/close tabs | **asks you** |
| `dangerous` | run JavaScript in a page | **asks you** |

Approvals appear inline in the chat with **Allow**, **Always allow this tool**, and
**Deny**. The **Autopilot** toggle in the composer flips the whole `write` tier to
automatic for a working session.

A denial is final: the assistant is told not to route around it. It is also
instructed never to enter credentials or one-time codes, to pause before anything
irreversible, and to treat page text as data — a page telling it to ignore its
instructions is content to report, not a command to follow.

---

## Extending it

### Plugins

Drop a folder in the plugins directory (**Settings → Integrations → Open plugins
folder**). An example is written there on first run.

```
my-plugin/
  plugin.json     { "id": "my-plugin", "name": "…", "version": "1.0.0", "main": "index.js" }
  index.js
```

```js
exports.activate = (api) => {
  api.registerTool({
    name: 'headings',
    description: 'List the headings on the current page.',
    risk: 'safe',
    parameters: { depth: { type: 'number', description: 'Max heading level' } },
    handler: async ({ depth = 3 }, page) => {
      const sel = Array.from({ length: depth }, (_, i) => `h${i + 1}`).join(',');
      return page.evaluate(
        `Array.from(document.querySelectorAll('${sel}')).map(h => h.innerText)`
      );
    },
  });
};
```

Registered tools appear to the model exactly like built-in ones. The `page`
argument gives you `url()`, `title()`, `navigate()`, `readText()`, `snapshot()`,
`evaluate()`, `openTab()` and `status()`.

> Plugins run with full Node privileges in the host process — the same trust
> model as VS Code extensions. Install only ones you trust.

### MCP servers

**Settings → Integrations → MCP servers**:

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"],
    "enabled": true
  }
}
```

Their tools are namespaced `mcp_<server>_<tool>` and merged into the same list.
A server that does not annotate a tool as read-only is treated as `write`, so it
lands behind the approval gate.

---

## Extensions

The **🧩 button** in the toolbar opens the Extensions panel, which holds two
kinds of thing.

### Assistants — including Codex

The AI backend is presented as something you *add*, because that is how it
behaves. Open Extensions, find **Codex**, and press **Use this assistant**.

Nabsun detects the CLI on your PATH and shows where it found it. If it
isn't installed, the card shows the command to install it and a **Check again**
button. Once active, the assistant runs Codex for every request — using the
account you are already signed into there, with no API key kept in the browser —
and hands it this browser as an MCP tool server so it can read pages, click and
type. Its own shell tools stay sandboxed read-only, and every page action still
goes through the approval gate.

Claude Code, the Claude API, OpenAI and Ollama sit in the same list and switch
the same way.

### Connecting and disconnecting accounts

CLI assistants keep their own credentials — the browser never sees them — so the
Extensions panel drives that tool's own login. Each installed CLI card shows
whether an account is connected and offers:

- **Connect account** — runs the CLI's browser sign-in.
- **Use a code instead** — the device-code flow, which prints a code and URL
  directly in the panel. Use this when handing over the browser doesn't work.
- **Use an API key** — sent to the CLI over stdin, so it never appears in a
  command line or a process listing, and is never stored by the browser.
- **Disconnect account** — runs the CLI's logout, removing its stored
  credentials.

The card also shows the detected CLI **version**, because a stale CLI is a
common and otherwise baffling failure: an older Codex is rejected outright by
accounts whose default model it does not know.

### Browser extensions

**Load unpacked extension…** takes a folder containing a `manifest.json`.
Electron implements a substantial subset of the Chrome Extensions API on the
same Chromium engine, so content scripts, `chrome.storage`, `chrome.runtime`,
much of `chrome.tabs` and `chrome.webRequest` work. Extensions with a toolbar
action get a button in the toolbar, and their popup is rendered anchored under
it.

Honest limits: there is **no Chrome Web Store install flow** — extensions are
loaded unpacked from a folder. Chromium does not persist them between runs, so
Nabsun re-loads the enabled ones on every launch. Not every Chrome API is
implemented; an extension leaning on an unimplemented one will fail at the point
it calls it.

---

## Configuration

Everything lives in one JSON file, and **Settings → Configuration** manages it:

- **Export…** writes your settings to a file you pick. API keys are deliberately
  excluded, so an exported config is safe to copy between machines.
- **Import…** validates a file against the schema before applying it — unknown
  keys and wrong types are dropped rather than trusted.
- **Reset to defaults** restores factory settings (two-step; keys are untouched).
- **Open profile folder** shows where the config, chats and plugins live.

`nabsun://about` (Help → About Nabsun) reports the version, the Chromium,
Electron, Node and V8 versions, the active model, how many tools, plugins and MCP
servers are loaded, and every path the app writes to.

---

## Building installers

```bash
npm run dist:win     # NSIS installer + portable .exe
npm run dist:mac     # DMG + ZIP, x64 and arm64
npm run dist:linux   # AppImage
```

Output lands in `release/`. Builds are unsigned; Windows SmartScreen and macOS
Gatekeeper will warn until you add signing certificates to
`electron-builder.yml`.

**macOS builds must run on macOS** — the DMG and codesigning steps need Apple
tooling, so `dist:mac` cannot be produced from Windows or Linux. The
configuration is complete, including hardened-runtime entitlements.

---

## Verification

```bash
npm run verify
```

Five harnesses, 99 checks, no API key required:

- **`verify:browse`** — the browser as a browser, over real HTTP against a
  throwaway local server: navigation, back/forward, history recording,
  background tabs, error pages, zoom, tab cycling and reordering, reopening a
  closed tab, session snapshots, and a download landing on disk with the right
  bytes and filename.

- **`verify:page`** — the page bridge against a fixture built from the element
  shapes that break naive automation: accessible names from labels, `aria-label`
  and nested SVG titles, `display:none` exclusion, extraction, stale-ref errors,
  and filling a *controlled* input that only trusts real input events.
- **`verify:agent`** — the real agent loop driving a real tab with a scripted stub
  model: snapshot → read refs → type → click → assert the page actually changed,
  plus approval gating, denial semantics, transcript round-tripping, and that
  every `tool_use` gets a matching `tool_result`.
- **`verify:mcp`** — the external-agent path with a real MCP client talking to the
  real stdio server and bridge: auth rejection, tool advertisement, schema
  fidelity, argument round-tripping, and a declined action surfacing as an error.

### Not yet verified

**A live model turn has not been exercised end to end.** This machine has no
provider credentials, no local Ollama, and no `claude` CLI, so the network paths —
streaming, each provider's tool schema, prompt caching — are written against the
current SDKs and type-checked but never run. The Codex CLI is installed here, but
running it would spend your quota, so it was not invoked either.

Concretely, what remains unproven: the four provider adapters
(`anthropic`, `openai`, `ollama`, `claude-cli`, `codex-cli`) past the point where
they hand off to the network or spawn a process. Everything up to that boundary,
and everything after a tool call comes back, is covered above. Add a key or sign
into a CLI and send one message to close the gap.

---

## Known limits

- One window. `AppWindow` is a class, but nothing creates a second one yet.
- Builds are unsigned, and there is no auto-update.
- macOS installers are configured but have not been built (needs macOS).
- Chrome extensions (`chrome.*`) are not supported; use plugins or MCP.
- No tab groups, split view, profiles, sync, or private/incognito windows.
- Autofill covers passwords only — not addresses or payment methods.
- No bookmark import from another browser yet.
- HTTP basic-auth sites are cancelled rather than prompting for credentials.
- Screenshots in a transcript are not persisted across restarts.
- Tracker blocking is a small built-in host list, not a full filter-list engine.



