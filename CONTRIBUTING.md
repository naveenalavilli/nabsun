# Contributing

Thanks for looking. This is a personal project, so expect a slow but genuine
response.

## Getting it running

```bash
npm install
npm run setup     # only if the Electron binary did not download during install
npm run dev       # esbuild watch + launch
```

If the app exits immediately with no window, check whether
`ELECTRON_RUN_AS_NODE=1` is set in your shell. VS Code and Cursor export it to
terminals they spawn, and it makes `electron.exe` start as plain Node. Every npm
script here goes through `scripts/electron-run.mjs`, which strips it; a bare
`electron .` will not.

## Before you open a pull request

```bash
npm run typecheck
npm run verify
```

`verify` runs six harnesses — 241 checks — against real Electron and a
throwaway local HTTP server. It needs no API key and calls no model. It should
be green before and after your change.

If you fix a bug, **add a check that fails without your fix.** Several of the
bugs already found here were invisible to ordinary testing — a dead button
caused by a window drag region, an error page that appeared one time in three —
and the tests that catch them are the reason they stay fixed.

## Things worth knowing

- **`src/shared/` must not import `electron` or `node:*`.** It is bundled into
  the sandboxed renderer as well as the privileged host.
- **Never assign model or page output to `innerHTML`.** The Markdown renderer
  builds DOM nodes deliberately.
- **New tools declare a risk level.** `safe` runs automatically; `write` and
  `dangerous` go through the approval gate. When in doubt, pick the stricter one.
- **Don't rewrite source files through PowerShell.** Windows PowerShell's
  `Set-Content -Encoding utf8` re-encodes existing UTF-8 and adds a BOM, which
  corrupts emoji and broke `package.json` here once.
  `scripts/fix-encoding.mjs` repairs the damage if it happens.

## Architecture

[ARCHITECTURE.md](ARCHITECTURE.md) explains the decisions, including the ones
that were tried and abandoned. Read §1 if you are wondering why this is Electron
rather than a Chromium fork, and §8 if you are about to touch error pages.

## Security

Please read [SECURITY.md](SECURITY.md) before working on anything that touches
the approval gate, the external-agent bridge, plugins, or saved passwords. Those
are the parts where a mistake matters.
