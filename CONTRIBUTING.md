# Contributing to kvalah

Thanks for helping! kvalah is a small, dependency-light project; please keep it that way.

## Setup

```bash
npm ci
npm test          # node:test, includes end-to-end runs against a mock model server
npm run check     # node --check on every source file
npm run desktop   # start the Electron app
```

Node.js 22+ is required. No build step: the app runs straight from the sources.

## Layout

| Path | What |
|---|---|
| `desktop.cjs`, `preload.cjs`, `updater.cjs` | Electron shell: window, menu, IPC, auto-update |
| `server.mjs` | local HTTP backend and the agent loop (runs as a separate Node process) |
| `providers.mjs` | Ollama and OpenAI-compatible clients |
| `toolcalls.mjs`, `agent-state.mjs`, `workflow.mjs` | tool-call parsing/repair, context compaction, inspect → plan → edit → verify contract |
| `patch.mjs`, `search.mjs`, `git.mjs`, `command-policy.mjs` | edits and diffs, code search, Git and checkpoints, command approval policy |
| `public/` | UI (plain HTML/CSS/JS) and `public/i18n/<lang>.json` dictionaries |
| `test/` | tests |
| `electron-builder.cjs`, `packaging/`, `bucket/`, `.github/workflows/` | packaging, signing, package managers, CI/release |

## Pull requests

- One topic per PR; describe what changed and how you tested it (model + server if it is agent behaviour).
- `npm test` must pass. Add a test for bug fixes where practical.
- **UI strings** go into `public/i18n/en.json` *and every other locale* (the i18n test checks keys, placeholders and plural forms). If you cannot translate, copy the English text and say so in the PR.
- No new runtime dependencies without discussion; no network calls except to the user-configured model server and the update check.
- Changes to `.github/workflows/`, `electron-builder.cjs`, `packaging/` and `scripts/` affect signed releases and get extra review.
- Add a line to `CHANGELOG.md` under *Unreleased*.

## Reporting bugs

Use the issue templates. Include OS, kvalah version (Settings, bottom-left), the model server and the model, and the relevant part of `logs/desktop.log` from the data folder (Help → Data folder). Remove anything private first.
