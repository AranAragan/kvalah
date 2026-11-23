# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.8.0] - 2026-11-23

### Added
- **Settings → Devices** (also *kvalah → Devices…* in the desktop menu): use any number of computers on your local network.
- **Pool memory:** split one GGUF model across several devices with llama.cpp RPC, so models that don't fit on one machine can run. Choose the workers and, optionally, this computer's GPU; pick a model from the Ollama store or a `.gguf` file; kvalah starts `llama-server --rpc …`, shows per-device memory, traffic and log, and can switch the agent to the pool (OpenAI-compatible, real context size from llama-server). One click downloads the pinned prebuilt llama.cpp build (b12651, SHA-256 verified) or uses your own; mismatched builds are refused. Bigger models, not faster: Ethernet recommended.
- **Distribute tasks:** two new agent tools, offered only while the mode is on. `parallel_tasks` runs up to 8 read-only helper agents in parallel. `batch_files` applies one instruction to up to 300 files; edits are proposed remotely and applied locally in order with a hash check, checkpoint and undo, and `verify_project` is still required. The scheduler picks the least-loaded healthy device with the model, retries failures on another device (up to 4 attempts) and falls back to this computer.
- Node registry: paired kvalah devices, bare Ollama and OpenAI-compatible servers, with health checks, per-device model, parallelism limit, latency and failure tracking.
- **Share this device:** pairing code (12 characters, rate-limited), 256-bit tokens stored hashed on the worker, revocable; LAN auto-discovery (UDP 47318) and manual add by `IP:port`. A single LAN port (default 47317) serves the authenticated peer API and the token-checked RPC tunnel; `ggml-rpc-server` and `llama-server` listen on `127.0.0.1` only. Cloud API keys are never lent.
- [docs/DISTRIBUTED.md](docs/DISTRIBUTED.md): setup, security model, firewall ports and limitations.

### Changed
- Release workflow: no new `microsoft/winget-pkgs` pull request is opened while an earlier one for `AranAragan.Kvalah` is still open (repository variable `WINGET_SUBMIT=false` turns submission off). Scoop and winget manifests are still committed automatically.

## [0.7.0] - 2026-11-23

First public release.

### Added
- Cross-platform packages built with electron-builder: Windows NSIS installer (per-user, `%LOCALAPPDATA%\Programs\kvalah`) and portable zip, macOS dmg/zip (x64 + arm64), Linux AppImage and deb.
- Auto-update from GitHub Releases (electron-updater): check at startup and every 6 hours, background download, an in-app notice “Update X is available — Restart and install” in all 10 languages, *Settings → Check for updates automatically*, *Help → Check for updates…*. Portable zip, deb and unsigned macOS builds show a download link instead of self-updating.
- GitHub Actions: CI (syntax check, tests on Node 22/24, packaged smoke test) and a tag-driven release workflow that builds all platforms, publishes `latest*.yml` update feeds and `SHA256SUMS.txt`.
- Windows code signing in CI, activated by secrets: SignPath (two-stage: app executable, then installer) or Azure Trusted Signing. Optional macOS signing and notarization.
- Package manager manifests: winget (`AranAragan.Kvalah`) with automatic submission via `wingetcreate`, and a Scoop bucket in this repository.

### Changed
- PDF text extraction uses `pdfjs-dist` from npm instead of a vendored copy; no DOMMatrix polyfill is needed for text.
- The installer upgrades installations made by the previous custom `Setup.exe` in place and removes its leftovers; chats and settings are kept.
- Installed (NSIS/Scoop) copies no longer create desktop/Start-menu shortcuts on first run — the installer does.

### Removed
- The custom Windows installer (`tools/windows-installer`, C#) and `tools/package_windows.py`, replaced by electron-builder.
- `START.cmd` / `START.vbs` (use `npm start`).

## [0.6.1] - 2026-11-23

### Added
- Interface localization: Русский, English, Українська, Deutsch, Français, Español, Português (Brasil), 简体中文, Türkçe, 日本語 (`public/i18n/<lang>.json`, plural rules via `Intl.PluralRules`).
- Language switcher next to the theme toggle (and *View → Language*); switches live without a restart.
- First launch follows the OS language; “System default” returns to auto-detection.
- Server, Electron menu and dialog messages are localized; the model replies in the UI language by default (*Settings → Model reply language*).

### Changed
- Packaging keeps only Chromium locale packs for supported languages.

## [0.6.0] - 2026-11-23

### Fixed
- Tool results were silently cut to 3500 characters while `write_file` treated the file as fully read, which could corrupt files on overwrite. Truncated results are now valid and never count as a full read.
- The local API token was exposed by `GET /api/state`; it is now passed to the window over IPC and required on all API routes.
- Context: old steps no longer drop out in fragments; an interrupted turn keeps the actions it already performed. Turns cut by the generation limit (`done_reason: length`) no longer execute partial tool calls.
- The task contract is no longer frozen on the first message; project verification honours `.gitignore`.
- Chats are stored one file per chat with atomic writes (automatic migration from `chats.json`).

### Added
- Open an existing folder or Git repository as a project; `AGENTS.md` support.
- Code search tools: `search_code` (ripgrep or built-in), `find_files`, `outline_file`.
- Approval modes *Ask* / *Auto* / *Full access* and per-project “always allow” rules.
- Robust tool-call parsing: native calls or text (`<tool_call>`, `[TOOL_CALLS]`, Harmony, fenced JSON) with JSON repair; tool-calling mode *Auto* / *Native* / *Text protocol*.
- Cache-friendly prompt layout and context compaction with a digest of older steps.
- `apply_patch` (Codex patch format or unified diff), `append_file`, `edit_file` with `replace_all`; CRLF and BOM preserved.
- `git_status`, `git_diff`, `git_commit`; shadow-Git checkpoint before every turn with “restore files to the start of the turn”.
- OpenAI-compatible servers (llama.cpp, LM Studio, vLLM, …) with streaming tool calls.
- Test suite (`npm test`) with end-to-end runs against mock Ollama/OpenAI servers.

## [0.5.0]

- Initial private version: Windows desktop agent for Ollama with inspect → plan → edit → verify workflow.

[Unreleased]: https://github.com/AranAragan/kvalah/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/AranAragan/kvalah/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/AranAragan/kvalah/releases/tag/v0.7.0
