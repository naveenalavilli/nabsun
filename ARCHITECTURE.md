# Nabsun — Architecture

Nabsun is a **browser for AI**: Chromium as an execution environment that agents
run inside, rather than a browser with an assistant attached.

The runtime supplies four things — a way to observe a page, a tool surface to
act on it, an authorisation gate in front of every change, and a lifecycle that
can be stopped. Anything running in it gets exactly those, whether it is the
in-app assistant, a Codex or Claude Code process connected over MCP, or a
plugin. Which program is running is a configuration detail; what it may do is
not.

That is the organising idea behind most of the decisions below: why observation
is a stable ref contract rather than raw HTML, why every dispatch path funnels
through one gate, and why the provider abstraction is deliberately thin.

This document is the system reference: structure, contracts, invariants, and the
decisions that fix them.

---

## 1. Context and quality attributes

| Attribute | Target | Mechanism |
|---|---|---|
| Engine fidelity | Indistinguishable from Chromium for page rendering and web security | Electron embeds the same Blink/V8 and process model |
| Agent latency | No fixed per-turn overhead beyond the model | Cached CLI resolution, coalesced tab events, prompt-prefix caching |
| Authority containment | No tool call reaches a page without passing one gate | `ApprovalManager` on every dispatch path, in-app and external |
| Provider neutrality | A backend is one file | Normalised `StreamEvent` union behind a single `Provider` interface |
| Local operation | Runs with no account and no network beyond the model | Ollama backend, local stores, no telemetry |
| Testability offline | Full suite without an API key or internet | Real Electron against a throwaway local HTTP server |

The product constraint that shapes everything below: the agent acts inside
authenticated sessions the user already owns. Capability is cheap; *containment*
is the hard part.

---

## 2. Process and view topology

The system is an Electron embedding: the Chromium `content` layer plus a
privileged Node process. That second half is the premise the rest of this
document rests on — it hosts the agent loop, the tool implementations, MCP child
processes and plugins. Pages render under the same Blink, V8, multiprocess and
site-isolation model as any other Chromium browser.

Baseline: Electron 44.2 — Chromium 152, V8 15.2, Node 24.20 in the host process.

A source fork would be necessary only to change the engine itself: a new
rendering primitive, a patched network stack, a custom process model. Nothing
here requires one, and the agent, tools and UI target the embedder API rather
than Electron specifically.

```
┌─ Main process (Node, privileged) ────────────────────────────────────────────┐
│                                                                              │
│  AppWindow ─ window chrome geometry, overlay and popup lifecycle             │
│  TabManager ─ one WebContentsView per tab, navigation, zoom, find, bridge    │
│  Agent ─ streaming turn loop, tool dispatch, step budget, abort              │
│  ApprovalManager ─ the authorisation gate in front of every state change     │
│  Providers ─ Local (llama.cpp) | Anthropic | OpenAI | Ollama | CLI backends  │
│  BrowserBridgeServer ─ loopback control plane for external agents            │
│  Managers ─ downloads, Chrome extensions, MCP, plugins, CLI accounts         │
│  Stores ─ settings, OS-encrypted credentials and passwords, history,         │
│           bookmarks, chat sessions                                           │
│                                                                              │
└───────────────┬──────────────────────────────┬───────────────────────────────┘
                │ IPC (contextBridge)          │ isolated-world evaluation
                │                              │
   ┌────────────▼──────────────┐   ┌───────────▼──────────────────────────────┐
   │ Shell renderer            │   │ Tab renderers (one per page, sandboxed)  │
   │  tab strip, toolbar,      │   │  the real web page, normal web security  │
   │  bookmarks bar, find bar, │   │  + page preload (selection, autofill)    │
   │  password bar, AI sidebar │   │  + agent-bridge.js in isolated world     │
   │  (sandbox: false,         │   │  (sandbox: true, nodeIntegration: false) │
   │   contextIsolation: true) │   └──────────────────────────────────────────┘
   └───────────────────────────┘
   ┌───────────────────────────┐   ┌──────────────────────────────────────────┐
   │ Overlay renderer          │   │ Extension action popup                   │
   │  omnibox, command palette │   │  chrome-extension:// in the tab session  │
   │  attached only when open  │   │  attached only while open                │
   └───────────────────────────┘   └──────────────────────────────────────────┘
```

### View composition model

A `WebContentsView` is opaque and paints above every view added before it. The
page view therefore covers the shell's content region, and anything that must
appear *over* a page cannot be drawn by the shell. This partitions the UI:

- **Overlays** — omnibox dropdown, command palette, extension popups. Separate
  views, attached on demand, detached on close. An overlay left attached
  intercepts every click intended for the page.
- **Chrome rows** — find bar, bookmarks bar, password bar. Shell chrome that
  reduces the content rectangle, so they remain usable while the page scrolls
  beneath them.

```
contentHeight = window − (tabStrip + toolbar)
                       − bookmarksBar? − findBar? − passwordBar?
```

**Constraint.** The tab strip is the frameless window's drag handle
(`-webkit-app-region: drag`), and a drag region consumes mouse events at the OS
level. Controls inside it must opt out explicitly; the computed region is
asserted by test, since a swallowed control is invisible to DOM-level testing.

---

## 3. Page observation and actuation

`src/page/agent-bridge.ts` is bundled to an IIFE and injected into each tab's
**isolated world** (id 1729). Page scripts cannot observe or tamper with it, and
the page's own security boundaries are never relaxed to accommodate it.

The model receives an accessibility-derived outline, never raw HTML:

```
# Search results
- searchbox "Search" value="chromium embedding" [ref=k3f9a1b2-3]
- button "Search" [ref=k3f9a1b2-4]
## Results
- link "Chromium Embedded Framework" href=/cef [ref=k3f9a1b2-12]
  A framework for embedding Chromium-based browsers…
```

Every actionable node carries an opaque `[ref=…]` handle, and every action tool
takes that handle back verbatim.

| Approach | Cost | Failure mode |
|---|---|---|
| Raw HTML | ~10× tokens | Framework noise crowds out content |
| Model-authored CSS selectors | low | Misses constantly on real sites |
| Pixels + coordinates | vision round-trip | Scroll drift; useless for unrendered tabs |
| **Accessibility refs** | low | Staleness — made explicit, see below |

A handle is `<documentToken>-<n>`, and every part of that is load-bearing.
The counter never resets, so one snapshot's id is never reassigned by the next.
The token is per-document and random, so a handle cannot outlive the page that
issued it — the bridge is re-injected on navigation, and a bare counter restarted
at zero, letting a handle from the previous page address whatever inherited its
id. Each handle also records the element's identity when issued — tag, name,
link destination, input type — so a node that survives but has become something
else, or a link whose destination changed, fails instead of being acted on.
There is no bare-number form: accepting `0` as a convenience re-opened the
whole hole, since after a navigation `click("0")` addressed the new document
while the qualified handle from the old one was correctly refused.

Every failure mode here shares a shape: the action *succeeds* on the wrong
target and reports success. That is why identity is checked rather than assumed.

The contract stays **snapshot → act → snapshot**, and action tools return a
fresh snapshot in their result so a separate call is rarely needed. Every
mutating action resolves through `resolveActionable`, which additionally
requires the element to be visible and enabled: a control that has since been
hidden still matches its fingerprint and would otherwise accept a click no user
could have performed.

Actuation dispatches a full synthetic event sequence (`pointerdown`,
`mousedown`, `focus`, `pointerup`, `mouseup`, `click`) because real widgets
commit on different stages. Text entry goes through the native `value` setter so
React- and Vue-controlled inputs observe the change. `browser_press_key` bypasses
the DOM entirely via `webContents.sendInputEvent`, for UI that trusts only real
input.

Credentials are kept away from the model on every path out of the page, not just
the first one thought of: password values are excluded from snapshots, redacted
in structured extraction, and the agent cannot type into a password or
one-time-code field at all. A fill result reports how many characters were
entered rather than echoing them into the transcript.

---

## 4. The turn loop

```
user text
   └─> Agent.send
        ├─ persist the user message first          (a provider failure must not lose it)
        ├─ rebuild provider messages from the stored transcript
        ├─ append volatile context (open tabs, current page) to the USER turn
        │     ← never to the system prompt, which is a stable cached prefix
        └─ loop, up to maxAgentSteps:
             ├─ provider.stream(...) ──> text | thinking | tool_use | usage | stop
             ├─ no tool calls → done
             └─ per tool call:
                  ├─ ApprovalManager.request  → auto | always-allow | ask | deny
                  ├─ dispatch handler
                  └─ collect tool_result
                  ...all results returned in ONE user message
```

### Runs

Chats and external clients each execute inside a `Run`: an id, a kind, a
cancellation controller, and the tab that run is working in. Two properties
depend on it. Tab ownership is per-run, so one caller selecting a tab cannot
move another caller onto it. And **Stop reaches every run**, not only the chat
it was pressed in — an external client's pending write is waiting at a prompt in
the same sidebar, so leaving it live while the chat stops is a distinction the
user never made.

A run is per *client*, not per call. Isolating each external call from the next
kept clients from interfering, but also discarded the client's own tab between
requests, so an agent that selected a background tab was back on the user's tab
by its next call. Separation and continuity are different requirements, and the
run is where both live.

`Agent.dispatch` rechecks cancellation where an approved call becomes an action.
That is necessary but not sufficient: handlers *await* — highlighting an
element, waiting for a page to settle — and a Stop landing during that await was
ignored, so the click still went out afterwards. `assertLive` is therefore
called again immediately before each side effect, in every mutating tool. The
last thing checked before an action is whether the action is still wanted.

The turn record is written after *every* action, not once per batch and not once
at the end. Actions are real in the world the moment they run, and neither a
provider failure nor an interruption between two calls the model requested
together may erase the evidence — retrying against a transcript that has
forgotten a completed write is how a non-idempotent action gets duplicated.

### Invariants

| Invariant | Consequence if broken |
|---|---|
| Every `tool_use` has a matching `tool_result`, in a single message | The model stops issuing parallel tool calls |
| Cancellation is rechecked at each side effect, not only before the prompt or the handler | A Stop arriving while a handler awaits is lost, and the action lands afterwards |
| Every completed action is durable before the next one starts | An interruption mid-batch leaves no record to reconcile, inviting a duplicate retry |
| The system prompt is byte-stable across turns | Prefix cache misses; a long run costs full input every step |
| Volatile context lives in the user turn | Same |
| Tool failures return to the model, not the user | Recoverable states (stale ref, missing element) become hard errors |
| Denials return with an explicit non-circumvention instruction | The model routes around the gate |

Context is bounded at 80 messages, with replayed tool output truncated to 4 KB —
where essentially all the bulk lives.

**Built-in tools.** Sixteen `browser_*` (snapshot, navigate, click, type, select,
set_checked, hover, scroll, read_text, find_text, extract, screenshot, press_key,
back, wait, evaluate) and thirteen workspace tools (`tab_*`, `ask_user`,
`web_search`, `fetch_url`, `history_search`, `bookmark_*`, `memory_*`). Plugin
and MCP tools merge into the same list and are indistinguishable to the model.

### Working where the user is

The in-app assistant and the user share one screen, so they share one idea of
"this page": the assistant targets whatever tab the user is looking at, and a
tab it opens comes to the front. The alternative — a remembered tab that
survives the user switching away — meant the assistant could answer about a page
its user could not see, and do work they could not follow or take over.

That is a product decision with a cost, and the cost is real: switching tabs
mid-run moves the assistant with you. It is the right trade for a supervised
single-user browser, and the wrong one for unattended work.

External clients keep their own target instead. They have no shared screen, and
several of them competing for the foreground would fight both each other and the
user.

`ask_user` follows from the same reasoning. A question that ends the turn loses
the thread of what was being done; as a tool call it keeps the turn open, puts
the question in the sidebar, and returns the answer as the tool's result. An
unanswered question resolves to "not answered" rather than hanging, and Stop
releases it.

---

## 5. Provider abstraction

```ts
interface Provider {
  listModels(): Promise<string[]>;
  supportsVision(model: string): boolean;
  stream(req: StreamRequest): AsyncGenerator<StreamEvent>;
  readonly binaryPath?: string | null;   // CLI backends only
}
```

`StreamEvent` normalises to `text | thinking | tool_use | usage | stop`. The
agent loop is provider-agnostic; a new backend is one file.

Differences absorbed by adapters:

- **Anthropic** — `claude-opus-5` default, adaptive thinking
  (`{type:'adaptive', display:'summarized'}`; `budget_tokens` is rejected on this
  family), system prompt cached via `cache_control`, `finalMessage()` used to
  assemble streamed tool inputs rather than accumulating `input_json_delta` by
  hand.
- **OpenAI** — tool results are discrete `role:'tool'` messages that must precede
  user content; tool-call fragments arrive keyed by index.
- **Ollama** — NDJSON stream, local, no credentials. For a model the user has
  already pulled themselves, where `local` is the model the browser ships with.

Neither OpenAI nor Ollama can attach an image to a tool result, so
`splitToolResultImages` folds screenshots into a following user message rather
than discarding them.

Credentials are encrypted with the OS keychain via Electron `safeStorage` (DPAPI
on Windows), with environment variables as fallback.

### 5.1 The embedded model — the default backend

`local` is what a fresh install uses: llama.cpp and quantised weights shipped
inside the installer, no account, no key, no outbound request. Two reasons, and
the second is the one that matters in the field.

**Cost.** Routing every step of a task through a frontier model bills tokens for
"click the search box". The majority of an agent's actions in a browser are
routine, and paying frontier prices for them is the single largest waste in the
design.

**Reachability.** A browser that cannot function without calling a third-party
model is unusable inside networks where that call is not permitted — which is
precisely where an agentic browser would otherwise be most valuable. Local
inference makes the default path work with no route to the internet at all.

| Component | Choice | Size |
|---|---|---|
| Engine | llama.cpp `llama-server`, CPU build, pinned | 18 MB |
| Weights | Qwen3 1.7B, Q4_K_M, Apache 2.0 | 1.2 GB |

**Why a text model rather than a GUI-grounding one.** The obvious-sounding
choice is a vision-language-action model trained for GUI grounding — ShowUI,
Qwen-GUI. Those predict a *coordinate* from a screenshot, and §3 rejects
coordinates as the actuation primitive: they drift with scroll, need a vision
round-trip, and cannot address an unrendered tab. This browser hands the model a
text outline and takes back an opaque handle. A model whose output is `(x, y)`
has nothing to say to that interface. What the interface needs is tool calling
over text, which is what a small instruct model with a tool template does. The
GUI-grounding family becomes relevant only if the actuation primitive changes.

**Engine as a subprocess, not a linked library.** `llama-server` speaks the
OpenAI Chat Completions wire format, tool calls included, so the adapter is the
same streaming loop as §5 pointed at loopback. A native addon would mean an
ABI-matched rebuild on every Electron bump for no functional gain.

The process starts lazily on the first turn and is reused — loading 1.2 GB per
request would be absurd — and is killed on quit so nothing holds the weights
resident. Reasoning is disabled (`--reasoning off`): Qwen3 thinks before
answering by default, and for "click the search box" the thinking is longer than
the answer. Turning it off halved first-turn latency, 19.8s to 9.9s on CPU,
without losing the tool call.

**Limits, stated plainly.** A 1.7B model is not a frontier model. It handles
routine navigation; it will lose the thread on long multi-step research and
subtle reasoning. Every other backend remains one setting away, and the model
file, engine path, context size and thread count are all configurable — a larger
GGUF drops in without a code change.

Automatic escalation from the local model to a configured larger one — the
tiered routing this design is the first half of — is **not implemented**. Today
the choice is the user's, made in Settings. Doing it automatically needs a
signal for "this task is beyond the small model" that is worth trusting, and
guessing wrong in either direction is worse than asking.

### 5.2 CLI backends — delegated agents

`claude-cli` and `codex-cli` call no API. They spawn a locally installed agent
CLI and delegate the turn to it: the CLI carries its own login and its own
harness, so no key is stored here. This is the arrangement the Claude and Codex
extensions use inside an editor.

They satisfy the same `Provider` interface, but emit prose and progress and never
`tool_use` — so the agent loop runs exactly one iteration and yields control. The
CLI's internal tool activity surfaces as `thinking` lines (`▸ browser_click`), so
the sidebar still reflects what is happening. Browser tools reach the CLI over
MCP (§6), and every such call re-enters Nabsun's own approval gate.

**Process launch contract.**

| Constraint | Resolution |
|---|---|
| Node refuses to spawn `.cmd`/`.bat` without a shell (CVE-2024-27980 mitigation) | Read the npm shim and launch its target. A shell is inadmissible: the prompt would be shell-parsed |
| Wrapper scripts re-spawn their native binary without `windowsHide`, and spawn options do not reach a grandchild | `nativeBinaryFor()` locates the binary and launches it directly, hidden. Also removes a Node process per turn |
| Package layouts disagree (`vendor/<triple>/bin/codex.exe` vs `bin/claude.exe`) | Search breadth-first for the binary's *name* from the package root, bounded on depth and directories visited; verify each candidate by executing it |
| `spawn` throws synchronously on `EINVAL`/`ENOENT` rather than emitting `error` | Every spawn site catches and reports what was attempted |
| Prompt length and shell metacharacters | The prompt travels on stdin, never argv |
| Resolution walks a tree and executes a probe | Cached against each file's size and mtime; PATH lookups cached while the target exists, with a short negative window so a fresh install is picked up without restart |

**Codex specifics.** `-c` overrides parse as TOML, not JSON, contrary to the
CLI's own help text; MCP configuration is emitted as TOML literal strings, which
also sidesteps Windows backslash escaping, with a dotted key per environment
variable. Failures are reported as JSON on *stdout* with an empty stderr, so the
parser reads `error` / `turn.failed` explicitly.

Its approval model determines the invocation shape. `codex exec` pins
`approval_policy: never` and silently ignores `-c approval_policy=`; the only
switch that lifts it is `--approve-for-me`, which is mutually exclusive with
`--sandbox` (hence `-c sandbox_mode='read-only'`) and absent from `codex exec
resume`. Consequently Nabsun does not resume Codex threads: every turn is a
fresh `exec`, and `conversationPrompt()` replays the transcript the agent already
owns, bounded and truncated oldest-first. One code path, one flag set.

**Account lifecycle** uses the CLI's own `login` / `login --device-auth` /
`login --with-api-key` / `logout`, streaming output into the panel so a device
code appears where the user is. An API key is written to the child's stdin and
never appears in a command line or process listing.

---

## 6. External agent access

```
   Claude Code CLI ─┐
   Codex CLI ───────┤ spawn (stdio)
   VS Code ext ─────┘        │
                             ▼
              dist/bin/nabsun-mcp.js      (stdio MCP server)
                             │ HTTP + bearer token, 127.0.0.1 only
                             ▼
              BrowserBridgeServer  ──▶ ApprovalManager ──▶ the same tools
```

MCP clients spawn their servers and therefore cannot reach into a running
Electron process. The bridge closes that gap: a loopback HTTP control plane on an
ephemeral port behind a per-launch bearer token, fronted by a small stdio MCP
server that proxies to it.

`Agent.runToolForExternalAgent` is the single entry point and passes the *same*
approval gate. Connecting grants no authority the in-app assistant does not
already hold.

Because the surface is plain MCP, the same connection details work for Claude
Code or Codex running in an editor: the browser becomes a tool the user's coding
agent can call.

---

## 7. Authorisation model

Every tool declares a risk tier; every dispatch passes one gate.

| Risk | Examples | Default |
|---|---|---|
| `safe` | snapshot, read text, extract, search, screenshot | auto-run |
| `write` | click, type, navigate, open/close tab, bookmark | **ask** |
| `dangerous` | `browser_evaluate`, MCP tools flagged destructive | **ask** |

Approval is per call. "Always allow this tool" persists to settings.
**Autopilot** promotes the entire `write` tier to auto for a working session —
an explicit, revocable user decision. MCP tools that declare no risk are treated
as `write`: a server that says nothing about itself receives no benefit of the
doubt.

Prompt-level hardening carries the remainder: never enter credentials or one-time
codes, pause before irreversible actions even when unattended, and treat page
text as data — a page instructing the assistant is content to report, not a
command to obey. This is defence in depth behind the gate, not a substitute for
it.

---

## 8. Browser surface

An agent is worthless in a browser nobody wants to use, so the conventional
surface is complete.

**Tabs.** One `WebContentsView` each, with coalesced state updates — Chromium
emits navigation events in bursts, and batching them into a frame prevents dozens
of shell re-renders per load. Drag-to-reorder, middle-click close, audio
indicators, `Ctrl+Shift+T` closed-tab stack, `Ctrl+Tab` cycling, `Ctrl+1..9`,
per-tab stepped zoom, debounced session restore.

**Error pages.** A failed navigation renders a page that names the problem and
offers retry. Two constraints fix the implementation: navigation from inside
`did-fail-load` aborts while Chromium is still tearing the failed navigation
down, and scripts do not run reliably inside Chromium's own error pages — so the
replacement is navigated on the next tick. A failed *first* navigation commits no
entry, leaving `getURL()` empty, so `Tab.failedUrl` retains the address for the
omnibox. The render guard tests what the tab is *showing* — empty URL,
`chrome-error://`, our own error page, or the failed address — rather than
counting navigation events, which a failed load emits extras of.

**Downloads.** Downloads folder with `name (2).ext` de-duplication, progress,
pause/cancel/open/reveal, toolbar badge and panel.

**Context menus.** Assembled from Chromium's `context-menu` params as Chrome
does: link, image and media items, editing with spellcheck suggestions, selection
actions, page actions, view source, inspect element — plus *"Ask the assistant
about this"* where useful.

**Passwords.** Per-origin, OS-keychain encrypted, never written in plaintext.
Autofill lives in the *page preload* rather than the agent bridge, because it
must run automatically on every page before interaction, whereas the bridge is
injected on demand. Matching is on full origin, so a credential saved for
`https://example.com` is never offered to `http://example.com` or a subdomain.
Capture listens for form submit, Enter, and submit-button clicks, since many
sign-in pages never fire a form submit. Nothing is stored before the user answers
the prompt.

**Bookmarks.** Folders, a bar under the toolbar, rename/move/reorder, favourites
on the new tab page (bar bookmarks first, then most-visited, one tile per host).

**Internal pages.** `nabsun://home`, `nabsun://about`, `nabsun://history`, served by
a protocol handler with token substitution, as these pages have no IPC bridge.
The handler must be registered on the *tab partition's* session — the global
`protocol` module covers only the default session, and a tab in a named partition
would treat `nabsun://` as an unknown scheme and hand it to the OS.

---

## 9. Extensibility

Three independent mechanisms converge on one tool list.

**Chrome extensions** load unpacked into the tab session, so content scripts run
in the pages the user is looking at. Electron implements a substantial subset of
the Chrome API — content scripts, `chrome.storage`, `chrome.runtime`, much of
`chrome.tabs` and `chrome.webRequest`. Chromium draws no toolbar buttons or
popups, so the browser does: the action icon is read from disk as a data URL (the
shell cannot fetch `chrome-extension://`), and the popup is a view anchored under
its button. Two platform constraints: extensions cannot load into a
non-persistent session, and Chromium does not persist them across runs, so
enabled extensions are re-loaded on launch.

**Plugins** (`userData/plugins/<id>/`) are CommonJS modules exporting
`activate(api)`. They register tools indistinguishable from built-ins and receive
a narrow `PagePluginContext` rather than internals. As with VS Code extensions
they run with full host privilege — an explicit trust decision, stated at the
install boundary.

**MCP servers** are configured in settings, spawned over stdio, and namespaced
`mcp_<server>_<tool>`.

Plugin and MCP tools are re-read every turn, so reloading an integration takes
effect without a restart.

---

## 10. Verification

Six harnesses, **241 checks**, no API key, no internet. They drive real Electron
with real Chromium against a throwaway local HTTP server.

| Harness | Scope |
|---|---|
| `verify:browse` | Browser as browser: navigation, history, background tabs, error pages, zoom, tab model, downloads landing on disk with correct bytes, extensions loading and running a content script, autofill against a real sign-in form, passwords never on disk in plaintext |
| `verify:page` | Page bridge against element shapes that defeat naive automation: accessible names from labels, `aria-label`, nested SVG titles, `display:none` exclusion, stale-ref errors, filling a controlled input |
| `verify:agent` | The real agent loop driving a real tab with a scripted stub model: snapshot → read refs → type → click → assert the page changed; approval gating, denial semantics, `tool_use`/`tool_result` pairing |
| `verify:mcp` | External-agent path with a real MCP client: auth rejection, tool advertisement, schema fidelity, declined action surfacing as an error |
| `verify:local` | The embedded model end to end: llama.cpp starts, the bundled weights load, and the model calls a browser tool with the right argument. Skips when the weights are absent, which is the state of a fresh clone |
| `verify:cli` | Launcher resolution and CLI argument construction: that the raw `.cmd` is genuinely unspawnable, that both CLIs resolve to native binaries, that resolution is cached, and the Codex flag set and transcript replay |

`codex-live` and `codex-tools-live` are opt-in end-to-end checks behind
`NABSUN_TEST_LIVE_CLI=1`, excluded from `verify` so the suite never spends
model quota. The tool-path check asserts a browser tool is actually invoked
through MCP; the conversation check asserts a fact planted in turn one is
recalled in turn two.

**Not covered:** a live API model turn. Provider adapters are type-checked and
exercised to the network boundary; the streaming paths themselves are not run
against a real API in CI.

---

## 11. Source layout

```
src/
  shared/       types.ts, ipc.ts          contract shared by every process
  page/         agent-bridge.ts           injected into tabs' isolated world
  mcp-server/   main.ts                   stdio MCP server (bundled standalone)
  main/
    index.ts          bootstrap, protocol, session policy, menu
    appWindow.ts      BaseWindow + shell/overlay/tab views, chrome geometry
    tabs.ts           TabManager, navigation, zoom, find, bridge, error pages
    ipc.ts            every IPC route in one place
    internalPages.ts  nabsun:// handler with token substitution
    contextMenu.ts    right-click menus
    downloads.ts      download manager
    store.ts          settings + OS-encrypted credentials
    passwords.ts      saved logins, per-origin, OS-encrypted
    history.ts        history, bookmarks, omnibox ranking, URL resolution
    bridge/server.ts  loopback control plane for external agents
    ai/
      agent.ts        the turn loop
      provider.ts     the normalised provider interface
      providers/      local.ts (llama.cpp), anthropic.ts, openai.ts,
                      ollama.ts, cli.ts
      tools/          browser.ts, workspace.ts, types.ts
      approvals.ts    the authorisation gate
      prompt.ts       system prompt + per-turn context
      sessions.ts     chat persistence
    integrations/
      extensions.ts       Chrome extension host
      agentExtensions.ts  the assistant catalogue
      cliAccounts.ts      connect/disconnect for CLI logins
      mcp.ts              MCP stdio host
      plugins.ts          plugin host
  preload/      shell.ts, overlay.ts, page.ts (selection + autofill)
  renderer/
    shell/      main.ts, chat.ts, settings.ts, extensions.ts, vault.ts, markdown.ts
    overlay/    omnibox and command palette
  pages/        nabsun://home, about, history, error
  test/         browsing, agent, bridge and cli harnesses
                + codex-live, codex-tools-live (opt-in)
scripts/
  verify-bridge.cjs   the page-bridge harness, run under Electron
  electron-run.mjs    entry shim (see §13)
  build.mjs           the four-target esbuild pipeline
  make-icon.mjs       PNG encoder for the app icon
  fetch-local-model.mjs  pulls llama.cpp + weights into vendor/ (gitignored)
```

Build targets differ by constraint, not by preference: CJS for main and preload
with `electron` external, ESM for the renderers, an IIFE for the page bridge
(injected as a source string, so a module bundle would fail on its import
statement), and a self-contained CJS bundle for the MCP server, which a packaged
app must spawn without `node_modules`.

---

## 12. Security posture

- Web pages run sandboxed with `contextIsolation`, `nodeIntegration: false` and
  normal web security. The agent reaches them through an isolated world, never by
  relaxing the page's boundaries.
- Shell and overlay renderers have no Node integration and a restrictive CSP.
- Model output is never assigned to `innerHTML`. The Markdown renderer builds DOM
  nodes; text reaches the document only via `textContent`, and the only attribute
  set from model output is a scheme-checked `href`.
- Non-web schemes are handed to the OS rather than opened in-app;
  `setWindowOpenHandler` converts popups into managed tabs.
- **Site capabilities are denied by default.** `applyPermissionPolicy` grants
  only capabilities that reach neither the user nor their devices (fullscreen,
  pointer lock, sanitised clipboard writes); camera, microphone, screen capture,
  geolocation, clipboard reads and device pickers are refused, as is any
  permission a future Chromium adds. Both the request and the check handler are
  installed, so `permissions.query()` cannot report a capability the browser
  will refuse.
- Certificate errors are refused outright, with no click-through.
- **Secrets are OS-keychain encrypted or not stored at all.** There is no
  reversible fallback: when `safeStorage` has no real backend — including
  Linux's `basic_text`, which encrypts with a fixed key — a secret is held for
  the session and the caller is told, rather than written somewhere recoverable.
- **The agent does not handle credentials.** It cannot type into password or
  one-time-code fields, structured extraction redacts their values, and a fill
  result reports a length rather than echoing what was typed.
- **`fetch_url` has a destination policy.** It runs host-side, outside the
  origin model, so loopback, link-local (cloud metadata), private and
  carrier-grade-NAT ranges are refused — after resolving the name, since a
  public hostname can point at a private address, and failing closed when a name
  cannot be resolved at all. Addresses are normalised before classification:
  `[::ffff:127.0.0.1]` is rewritten by URL parsing into hexadecimal, and a check
  that understood only the dotted spelling reached a local service. Redirects
  are returned rather than followed, and the byte ceiling and deadline are
  fixed rather than scaled by anything the model asks for.
- **An imported configuration cannot start a program or redirect a
  credential.** Nested fields are validated by type, so a string `"false"`
  cannot land where a boolean is read; `cliPaths` and `baseUrls` — which name an
  executable and a credential destination — are refused outright; MCP servers
  and Chrome extensions always arrive disabled.
- **Exports keep flag names and drop every value.** Matching argument names by
  pattern is not a control: `--authorization=Bearer.x`, a URL with `?token=`, a
  JWT-shaped bare argument and `['--token', '-LOOKS_LIKE_A_FLAG']` each slipped
  past one. An exported config therefore has to be filled in again, which is the
  honest trade against claiming a sanitised export that quietly misses a case.
- **A stored key is bound to its endpoint.** It is not sent anywhere but the
  endpoint it was saved against, and a key with no recorded binding is usable
  only at the provider's default — inheriting an old key into a custom endpoint
  would grant exactly the redirect this prevents.
- **A refused save is visible.** When there is no keychain, the key is held for
  the session only and the UI says so. An outcome nothing displays is
  indistinguishable from success.
- No telemetry.

### Trust boundaries

These are real, deliberate, and stated plainly rather than mitigated away:

| Boundary | Nature |
|---|---|
| Plugins | Full Node privilege in the host process. Same trust model as VS Code extensions |
| `browser_evaluate` | Arbitrary script execution in a page. Gated `dangerous`, but it exists |
| Bridge token | Any local process that can read it may request browser control — and is surfaced in the sidebar for approval |
| Prompt injection | An agent acting in authenticated sessions can be steered by page content. The approval gate is the load-bearing control; prompt hardening is defence in depth. **Autopilot disables that control** for the `write` tier |
| Grant scope | An "always allow" grant is by tool name, with no task, origin or expiry, and external clients inherit it. Approval is also not yet bound to a specific tab and document revision |
| Approval binding | An approval names a tool and its arguments, but the target tab is resolved inside the handler *after* the user answers, so what was authorised and what executes can still differ |
| Plugin and MCP isolation | Both run with the privileges of the process that hosts them; MCP servers inherit the full environment. Fault and capability isolation would need a separate host process |

See [SECURITY.md](SECURITY.md) for the full threat model, and §14 for what is
known-outstanding.

---

## 13. Packaging and distribution

`electron-builder.yml` produces NSIS and portable builds for Windows, DMG and ZIP
for macOS (x64 and arm64), and an AppImage for Linux.

- **`node_modules` is not shipped.** esbuild inlines every dependency into
  `dist/`; the payload is the bundle plus Electron.
- **`dist/bin/` is unpacked from the asar.** A child process cannot be spawned
  from inside an archive, and the MCP server is spawned by the agent CLIs.
- The icon is generated by `scripts/make-icon.mjs` — a 512×512 PNG from a
  hand-rolled encoder, so there is no binary asset in the repo and no image
  dependency. electron-builder derives `.ico` and `.icns` from it.
- macOS builds require macOS. The configuration is complete, including
  hardened-runtime entitlements for V8's JIT and for spawning helpers. All builds
  are currently unsigned.

**Host environment constraint.** VS Code, Cursor and other Electron hosts export
`ELECTRON_RUN_AS_NODE=1` to child processes. Inherited, it starts `electron.exe`
as plain Node, so `require('electron')` yields the npm shim's path string instead
of the API and the app dies on its first API call. Every entry point goes through
`scripts/electron-run.mjs`, which strips it. The same variable is set
*deliberately* — with `ELECTRON_NO_ATTACH_CONSOLE` — where Electron is used as
the Node runtime for a child process.

---

## 14. Known gaps and direction

### Outstanding, in priority order

These are known, reproduced, and not yet fixed. They are listed because a
security posture that omits its own gaps is not a posture.

| Gap | Why it matters | Shape of the fix |
|---|---|---|
| **Approval is not bound to a target** | The tool resolves its target *after* approval, so what the user authorised and what executes can still differ | Bind each request to run, tab, frame, origin and document revision; revalidate immediately before the side effect |
| **`Run` is not yet a full run context** | Runs now carry identity, cancellation and tab ownership, but not authorised origins, budgets or scoped grants, and dispatch is still spread across the Agent rather than one broker | Widen `Run` into the `RunContext` the review describes and funnel every entry point through a single `ToolBroker.execute` |
| **CLI runs are one step** | A delegated CLI's internal tool calls are not counted against `maxAgentSteps`, and there is no elapsed-time or action budget for them | Host-side action and time budgets enforced at the broker, independent of what the CLI's own harness decides |
| **Grants outlive their task** | "Always allow" is by tool name, with no scope or expiry; Autopilot persists across sessions; external clients inherit both | Task-scoped grants by default; persistent ones must state their scope; pin integration identity so a replaced tool cannot inherit approval |
| **Typed tool output is flattened** | Structured results collapse to text at the agent and MCP boundaries, so a screenshot cannot reach a vision-capable runtime, and the `vision` setting is not consulted on the execution path | Preserve typed content blocks end to end; enforce vision capability where tools are exposed |
| **Plugins and MCP servers are trusted code** | Plugins execute in the privileged main process; MCP servers inherit the full environment, and their own `readOnlyHint` is promoted to an auto-approved tier | A separate extension host with brokered access; minimal child environments; treat server annotations as input to policy, never as its source |
| **IPC senders are unverified** | Privileged channels — password reveal, settings, approval resolution — do not check sender identity or frame | Per-channel sender allowlist and runtime schema validation |
| **Observation is single-frame** | The walker skips iframe content and shadow roots, and readiness is inferred from fixed waits rather than postconditions | Frame-aware observation, shadow traversal, explicit postconditions with bounded recovery |
| **No reconciliation after an interruption** | Completed actions now survive a failure, but nothing verifies an ambiguous outcome before a retry, and a non-idempotent action could be repeated | Postconditions per action, and an explicit reconcile step before retrying anything that may already have happened |
| **External actions have no journal** | Only chat turns are recorded. A tool run by an external client leaves no durable trace, so there is nothing to reconcile against after a crash | One action ledger, written by the broker, covering every caller |
| **Unsigned, and no update path** | Executable, installer and portable build all report `NotSigned`, and there is no updater | Signing identity and CI signature verification; a tested update channel before this is a daily browser |

### Direction, with the seams already in place

| Direction | Existing seam |
|---|---|
| Task as the unit of work — objective, scope, budget, progress, Stop | The agent loop and approval gate already exist per session; they need a supervisor above them |
| Split `Provider` into `ModelAdapter` and `AgentRuntime` | CLI backends already bypass the host loop; the distinction is real but not yet named in the types |
| Additional providers (Gemini, Bedrock, Azure) | `Provider` + `StreamEvent`; one file each |
| Signed and notarised builds | electron-builder config complete; signing identity absent |
| Multi-window | `AppWindow` owns geometry per window; `TabManager` is per-window already |
| Policy-managed deployment | Settings store is a single typed document; an admin layer would overlay it |
