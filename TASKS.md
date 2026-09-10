# Nabsun — Build Plan

Status legend: `[x]` done · `[~]` in progress · `[ ]` not started

---

## Phase 0 — Foundation

- [x] Verify runtimes (Node 26.5, npm, git) and registry access
- [x] `package.json`, dependency set, Electron 44 binary installed
- [x] Upgrade `@anthropic-ai/sdk` to 0.124 (0.71 lacked adaptive-thinking types)
- [x] `src/shared/types.ts` — the contract every process compiles against
- [x] `src/shared/ipc.ts` — channel constants + the `window.nabsun` API surface
- [x] `tsconfig.json`, esbuild build script, `npm run dev` watch loop
- [x] `scripts/electron-run.mjs` — strips inherited `ELECTRON_RUN_AS_NODE`

## Phase 1 — The browser

- [x] `TabManager` — one `WebContentsView` per tab, lifecycle, coalesced updates
- [x] Navigation, back/forward/reload/stop, mute, pin, duplicate, reorder
- [x] Popup handling via `setWindowOpenHandler`; external schemes to the OS
- [x] Find-in-page plumbing (`found-in-page` → shell)
- [x] `AppWindow` — frameless `BaseWindow`, shell/overlay/tab view geometry
- [x] History + bookmarks with frecency ranking; omnibox suggestion builder
- [x] URL-vs-search resolution (`resolveNavigationInput`)
- [x] Session policy: tracker blocklist, permission handler, Chrome UA
- [x] `nabsun://` internal protocol handler, with token substitution
- [x] `nabsun://home` new-tab page
- [x] Shell renderer: tab strip, toolbar, find bar, window controls
- [x] Overlay renderer: omnibox and command palette
- [x] Sidebar resize by drag

## Phase 2 — Making pages legible to a model

- [x] `agent-bridge.ts` injected into an isolated world (id 1729)
- [x] Accessibility-style snapshot with `[ref=N]` handles + budget truncation
- [x] Accessible-name computation (aria-labelledby / label / placeholder / alt)
- [x] Actions: click, fill, select, setChecked, hover, scroll
- [x] Full synthetic event sequences + native value setter for React/Vue inputs
- [x] `readText` (semantic-container preferring), `findText`, `extract`
- [x] Visual highlight of the element the agent is acting on
- [x] `waitForSettled` — document + network idle heuristic
- [x] Screenshot capture with downscaling

## Phase 3 — The agent runtime

- [x] Normalised `Provider` interface + `StreamEvent` union
- [x] Anthropic adapter (adaptive thinking, prompt caching, `finalMessage()`)
- [x] OpenAI/Codex adapter (indexed tool-call fragments, `role:'tool'` results)
- [x] Ollama adapter (NDJSON stream, local)
- [x] `splitToolResultImages` for backends that can't attach images to results
- [x] OS-keychain credential storage (`safeStorage`) + env fallback
- [x] System prompt (stable prefix) + per-turn volatile context
- [x] Turn loop: streaming, parallel tool calls, step budget, abort
- [x] Transcript ↔ provider-message reconstruction preserving step boundaries
- [x] Context pruning (message cap + replayed tool-result truncation)
- [x] `ApprovalManager` — risk tiers, always-allow, abort-safe pending dialogs
- [x] Session persistence (one file per chat, auto-titling)
- [ ] **Verify a real turn against a live model** — blocked: no credentials, no
      local Ollama, no `claude` CLI on this machine; running the installed Codex
      CLI would spend the user's quota, so it was not invoked

## Phase 4 — Tools

- [x] `browser_snapshot`, `browser_navigate`, `browser_click`, `browser_type`
- [x] `browser_select`, `browser_set_checked`, `browser_hover`, `browser_scroll`
- [x] `browser_read_text`, `browser_find_text`, `browser_extract`
- [x] `browser_screenshot`, `browser_press_key`, `browser_back`, `browser_wait`
- [x] `browser_evaluate` (gated `dangerous`)
- [x] `tab_list`, `tab_open`, `tab_close`, `tab_focus`
- [x] `web_search` (real tab, so JS-rendered results are included), `fetch_url`
- [x] `history_search`, `bookmark_list`, `bookmark_add`
- [x] `memory_list` / `memory_read` / `memory_write` — cross-session notes

## Phase 5 — Extensibility

- [x] MCP stdio host; tools namespaced and risk-mapped from annotations
- [x] Plugin extension host + narrow `PagePluginContext` ABI
- [x] Example plugin written on first run
- [x] Live reload of both without restarting the browser
- [x] Settings UI for MCP servers and plugin status

## Phase 6 — The AI sidebar

- [x] HTML structure and design system (dark, accent `#7c5cff`)
- [x] Streaming transcript renderer (text, thinking, tool cards, errors)
- [x] Safe Markdown renderer (builds DOM nodes; never `innerHTML`)
- [x] Inline approval cards with allow / always-allow / deny
- [x] Composer: include-page toggle, Autopilot toggle, stop button, step badge
- [x] Chat history view (list, switch, delete)
- [x] Settings view: provider, model, API keys, risk policy, MCP, plugins

## Phase 7 — Integration and verification

- [x] Build the whole tree; type check clean
- [x] Launch and confirm the window paints and a page loads
- [x] Fix: `nabsun://` registered on the default session, not the tab partition
- [x] Fix: inherited `ELECTRON_RUN_AS_NODE` made Electron start as plain Node
- [x] `verify:page` — 14 checks on the page bridge under a real renderer
- [x] `verify:agent` — 12 checks driving a real tab with a stub model
- [x] `README.md`, `ARCHITECTURE.md`

## Phase 8 — Configuration and About

- [x] Export configuration (API keys deliberately excluded)
- [x] Import configuration, schema-validated against the defaults
- [x] Reset to defaults (two-step; credentials untouched)
- [x] Show and open the profile / config / plugins / chats locations
- [x] `nabsun://about` with live version, engine, model and integration counts
- [x] Token substitution in the internal-page protocol handler
- [x] Help menu entries for About and the profile folder

## Phase 9 — Agent CLIs, the way VS Code uses them

- [x] `claude-cli` and `codex-cli` providers spawning the local CLI
- [x] Reuse the CLI's own login — no API key stored in the browser
- [x] Session continuity via `conversationKey` → the CLI's own session id
- [x] Surface the CLI's internal tool activity as progress in the transcript
- [x] Windows shim resolution, so no `shell: true` with user text on the cmdline
- [x] `BrowserBridgeServer` — loopback control plane, per-launch bearer token
- [x] `dist/bin/nabsun-mcp.js` — stdio MCP server proxying to the bridge
- [x] External calls run through the same `ApprovalManager` as the sidebar
- [x] Settings: CLI detection, path override, copyable MCP config for VS Code
- [x] `verify:mcp` — 10 checks over a real MCP client → stdio server → bridge
- [ ] Exercise a real `claude`/`codex` run (see Phase 3 — needs credentials)

## Phase 10 — Installers

- [x] `scripts/make-icon.mjs` — 512×512 PNG from a hand-rolled encoder
- [x] `electron-builder.yml` for Windows, macOS and Linux
- [x] Ship without `node_modules`; unpack `dist/bin` so it can be spawned
- [x] macOS hardened-runtime entitlements (V8 JIT, child processes, network)
- [x] **Built and launched**: `Nabsun-0.1.0-x64-setup.exe` (NSIS) and
      `Nabsun-0.1.0-portable.exe`, both 106 MB
- [ ] **macOS DMG/ZIP** — configured but not built: requires macOS tooling
- [ ] Code signing (unsigned builds warn on SmartScreen and Gatekeeper)

## Phase 11 — Making it a browser you can actually live in

An audit found the AI layer solid but everyday browsing hollow: no right-click
menu, no downloads, no zoom, no tab shortcuts, no error pages, no session restore.

- [x] Full right-click context menu — links, images, media, selection, editing,
      spellcheck suggestions, page actions, view source, inspect element
- [x] "Ask the assistant about this" on a selection, image, or the whole page
- [x] Downloads: auto-save to Downloads with `name (2).ext` de-duplication,
      progress/pause/cancel/open/reveal, toolbar badge, sidebar panel
- [x] Zoom in / out / reset with Chrome-style stepping (Ctrl +/-/0)
- [x] Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1..8, Ctrl+9, Ctrl+Shift+T (reopen closed)
- [x] Hard reload, stop, print, Ctrl+H history, Ctrl+J downloads
- [x] Friendly error pages mapping Chromium error codes to plain language
- [x] Tab drag-and-drop reordering with a drop indicator
- [x] Session restore on launch, snapshotted on a debounce
- [x] Certificate errors refused rather than silently clicked through
- [x] HTTP basic-auth cancelled cleanly instead of hanging on a prompt
- [x] `nabsun://history` page with day grouping and search
- [x] `verify:browse` — 28 checks over real HTTP against a throwaway server

Bugs this phase found and fixed:

- [x] **The new-tab (+) button did nothing.** The tab strip is the frameless
      window's drag handle, and a `-webkit-app-region: drag` region swallows
      mouse events at the OS level. `#tabs`, `.tab` and `#window-controls` each
      opted out; `#new-tab` never did, so the button was inert while Ctrl+T
      worked fine. Now every control in the strip opts out by rule, and
      `verify:browse` asserts the computed region — the one signal of this that
      is visible from the DOM.

- [x] `did-fail-load` navigating synchronously is aborted mid-teardown, leaving
      Chromium's default error page in place
- [x] A failed first navigation commits no entry, so `getURL()` is empty —
      `Tab.failedUrl` now keeps the address for the omnibox
- [x] Loading the error page cleared the very error it was reporting
- [x] Two harness fidelity gaps that produced false results: an unregistered
      `nabsun://` scheme, and a content assertion that matched Chromium's own
      error page rather than ours

## Phase 12 — Extensions

- [x] `ChromeExtensionManager` — load unpacked extensions into the tab session
- [x] Persist the list in settings and re-load on every launch (Chromium does
      not remember them), with enable/disable, remove and reload-all
- [x] Read `action` / `browser_action` / `page_action` across MV2 and MV3
- [x] Toolbar action buttons drawn by the browser, with the icon read off disk
      as a data URL (the shell cannot fetch `chrome-extension://`)
- [x] Action popups rendered as a native view anchored under the button,
      dismissed on blur or Escape
- [x] Extensions panel (🧩) with both assistants and browser extensions
- [x] **Codex installable as an assistant**: detected on PATH, "Use this
      assistant" to activate, install command shown when missing
- [x] Same treatment for Claude Code, Claude API, OpenAI and Ollama
- [x] Test fixture extension (MV3, content script, popup, icon) + 8 checks

Bugs and constraints this phase found:

- [x] **Extensions cannot be loaded into a non-persistent session.** Electron
      rejects them outright. The app already used `persist:nabsun`;
      `attach()` now refuses a temporary session loudly instead of failing every
      load with a confusing message.
- [x] **The error-page guard compared URLs.** A failed navigation reports
      `chrome-error://chromewebdata/`, so the guard skipped and Chromium's
      default error page stayed. Replaced with a per-tab navigation counter.

## Phase 13 — Making the CLI backends actually run

Reported symptom: **"spawn EINVAL" whenever you talk to the assistant.**

- [x] **Root cause: Windows cannot spawn an npm `.cmd` shim.** Since the
      CVE-2024-27980 mitigation, Node refuses `.cmd`/`.bat` without
      `shell: true`, and throws EINVAL. A shell was not an option — the prompt
      would become part of a command line. `resolveLauncher()` now reads the
      shim and runs what it wraps (`node <pkg>/bin/codex.js`).
- [x] **`spawn` throws synchronously** for EINVAL/ENOENT rather than emitting
      `error`, so a bare "spawn EINVAL" escaped to the user. All three spawn
      sites now catch it and explain what was tried.
- [x] The prompt moved from argv to **stdin** — it never reaches a command line
      and cannot hit the argument-length limit.
- [x] **Codex's `-c` values are TOML, not JSON**, despite its help. The MCP
      config was silently read as a string ("expected a map"). Now emitted as
      TOML literal strings with a dotted key per env var, verified against the
      real CLI.
- [x] **Codex reports failures as JSON on stdout with an empty stderr**, so its
      real error was swallowed and only "exited with code 1" surfaced. The
      parser now reads `error` / `turn.failed` and reports them, adding the
      upgrade command when the CLI says it is too old.
- [x] Session continuity by replaying the transcript in the prompt. `codex exec
      resume` was the obvious route, but it has no `--approve-for-me`, so a
      resumed turn can never approve a browser tool call.
- [x] Connect / disconnect accounts: `login`, `login --device-auth`,
      `login --with-api-key` (over stdin), `logout`, `login status`.
- [x] CLI version shown in the Extensions panel.
- [x] `verify:cli` — proves the raw shim really is unspawnable, and that the
      resolved launcher runs. Skips cleanly when a CLI is absent.
- [x] `codex-live` — opt-in end-to-end check behind
      `NABSUN_TEST_LIVE_CLI=1`, kept out of `verify` so it never spends
      model quota.

## Phase 14 — The rest of the bells and whistles

- [x] **Password manager**: per-origin storage encrypted with the OS keychain,
      never plaintext on disk
- [x] Autofill from the page preload — runs on every page automatically, unlike
      the agent bridge which is injected on demand
- [x] Username-field inference (nearest preceding text input, name/type hints)
- [x] Native-setter fill, so framework-controlled inputs actually notice
- [x] Capture on submit, Enter, and submit-button click — many sign-in pages
      never fire a form submit at all
- [x] "Save password?" bar under the toolbar; nothing is written before consent
- [x] Manager: show, copy, delete, delete-all; list carries metadata only
- [x] **Exact-origin matching** — scheme, host and port must all agree
- [x] **Bookmarks**: bar under the toolbar, folders, rename, move, show/hide on
      bar, reorder, delete; Ctrl+D toggles, Ctrl+Shift+O opens, Ctrl+Shift+B
      toggles the bar
- [x] **Favourites** on the new tab page: bar bookmarks, then top sites, one
      tile per host
- [x] **Clear browsing data** by category: history, cookies, cache, passwords,
      bookmarks
- [x] Full screen (F11)
- [x] 20 new checks, including autofill into a real sign-in form and capture on
      submit, plus "never written to disk in plaintext" and the cross-origin
      refusal

Bug found and fixed:

- [x] **The error page appeared only sometimes.** The guard counted navigation
      events, but a failed load emits extra ones of its own (Chromium's error
      commit), so the counter had already moved and the deferred load was
      skipped at random. Replaced with a check of what the tab is actually
      showing, treating an empty URL, `chrome-error://`, our error page, and the
      failed address itself as "still failed". Stable over three consecutive
      runs where it previously failed roughly one in three.

## Deferred (explicitly out of scope for this pass)

- Auto-update (`electron-updater`)
- Chrome extension (`chrome.*` API) compatibility
- Multi-window support — one window today; `AppWindow` is already a class
- Profiles / multi-account containers
- Vertical tabs, tab groups, split view
- Downloads manager UI (downloads work; there is no panel for them)
- Sync
