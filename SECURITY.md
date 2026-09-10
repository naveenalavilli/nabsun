# Security

Nabsun is a browser that an AI agent can operate, in your real, logged-in
sessions, and it stores passwords. That combination deserves a straight
description of what it does, what it protects, and what it does not.

**Status: this is a personal project, not audited software.** It has not had a
third-party security review. Read the threat model below before pointing it at
accounts you care about.

## Reporting a vulnerability

Open a GitHub issue for anything non-sensitive. For something you would rather
not post publicly, use GitHub's **private vulnerability reporting** on this
repository (Security → Report a vulnerability). Please include what you did, what
happened, and what you expected.

There is no bug bounty. Expect a best-effort response from one person.

---

## What is protected, and how

| Asset | Protection |
|---|---|
| API keys | Encrypted with the OS keychain (DPAPI / Keychain / libsecret) via Electron `safeStorage`; falls back to obfuscated-at-rest only when no keychain exists, and says so |
| Saved passwords | Same mechanism. Never written in plaintext. Autofill matches the **full origin** — scheme, host and port |
| Page content | Sent only to the provider you configured. With Ollama it never leaves the machine |
| Telemetry | There is none. Nothing is reported anywhere |
| Web pages | Sandboxed, `contextIsolation`, `nodeIntegration: false`, normal web security. The agent reads them through a separate isolated world rather than by weakening the page |
| Model output | Never assigned to `innerHTML`. Markdown is rendered by building DOM nodes; the only attribute set from model output is a scheme-checked `href` |
| State-changing actions | Default-deny. `write` and `dangerous` tools ask every time until you say otherwise |

Chromium's own protections are untouched: site isolation, the sandbox, and the
normal web security model all apply. Certificate errors are refused outright,
with no click-through.

---

## Threat model

### 1. Prompt injection — the one that matters most

**An agent acting in your authenticated sessions can be steered by the content of
the pages it reads.** A page can contain text addressed to the model telling it
to ignore its instructions, visit a URL, or exfiltrate what it can see. This is
an unsolved problem across the entire industry, and this project does not solve
it either.

What mitigates it here:

- **The approval gate is the load-bearing control.** Anything that changes state
  is denied by default and asks you, showing the tool and its arguments. An
  injected instruction still has to get past you.
- The system prompt tells the model to treat page text as data, never as
  instructions, and to report rather than obey. This is defence in depth, and
  should be assumed bypassable on its own.
- Denials are final: the model is explicitly told not to route around one.

**Autopilot turns the load-bearing control off.** It flips the whole `write` tier
to automatic so the agent can click and type without asking. That is a
deliberate, useful mode — and it is the mode in which a prompt-injection attack
succeeds silently. Do not leave it on while browsing pages you do not trust.

### 2. Plugins run with full privilege

Plugins are CommonJS modules loaded into the privileged main process. They can do
anything the browser can do: read your files, reach the network, read the stores.
This is the same trust model as VS Code extensions, and it is deliberate — but it
means **installing a plugin is equivalent to running an arbitrary program.**
Only install ones you have read or trust.

### 3. The external-agent bridge

The browser exposes its tools over a loopback HTTP server on an ephemeral port,
behind a bearer token minted fresh each launch, so that an external agent (Claude
Code, Codex, an editor extension) can drive it over MCP.

- It binds `127.0.0.1` only, and is never reachable off the machine.
- Every call goes through the **same approval gate** as the in-app assistant, so
  connecting grants no extra authority.
- **But:** any local process running as your user that can read the token can ask
  the browser to act. On a shared or compromised machine, treat that as browser
  control at user privilege. The mitigation is the approval prompt, which is the
  same one you would get from the sidebar.

### 4. `browser_evaluate`

There is a tool that runs arbitrary JavaScript in the current page. It is
classified `dangerous` and asks every time by default. It exists because some
things cannot be expressed by the structured tools. If you enable auto-approval
for `dangerous`, you have given the model arbitrary script execution in whatever
site you are logged into.

### 5. Chrome extensions

Extensions are loaded unpacked from a folder you choose, into the same session
your tabs use, so their content scripts run in your pages. They are ordinary
Chrome extensions with ordinary Chrome extension power. There is no store
review in front of them — you are the review.

### 6. Passwords

- Autofill will not cross an origin boundary: a credential saved for
  `https://example.com` is never offered to `http://example.com`, nor to a
  subdomain.
- When more than one credential is stored for an origin, nothing is filled
  automatically, because guessing which one you meant is worse than doing
  nothing.
- Nothing is saved until you answer the prompt.
- The assistant is instructed never to type credentials itself. Passwords are the
  browser's job, not the model's — but note that a filled password *is* present
  in the DOM, so a page snapshot taken afterwards could contain it. Password
  field values are excluded from snapshots for this reason.
- Anyone with your OS user session and a running copy of the app can reveal a
  saved password from the manager. There is no separate master password.

### 7. What an attacker on the network cannot do

Nothing here weakens TLS, disables certificate validation, or opens a remote
port. The only listening socket is on loopback.

---

## Deliberate non-goals

These are absent by choice, and their absence is not a bug:

- **No sandboxing of plugins.** They are trusted by definition.
- **No master password / separate vault unlock.** Saved passwords are protected
  by your OS account, like Chrome's default configuration.
- **No anti-fingerprinting or tracker blocking beyond a small host list.** Use
  Brave or Tor if that is your requirement.
- **No enterprise policy layer.** There is no way to force settings, lock
  Autopilot off, or produce an audit log. See the README for what that would take.

---

## If you are evaluating this for an organisation

Read [ARCHITECTURE.md](ARCHITECTURE.md) §12, and understand that the gaps above
are real. In particular, the absence of a **central audit log** of agent actions,
and the absence of **managed policy** to lock Autopilot off, are likely blockers
for deploying an agentic browser inside a company. Both are tractable; neither is
built.
