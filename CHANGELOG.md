# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.10.0-compute.3.dev.1] - 2026-11-26

- Fixed central tokenization for MistralCommonBackend. Complete SFT conversations use finetuning mode and assistant targets are checked against serving-mode prefixes.
- Added verified import of local MLX conversions, with separate records for verified official BF16 weights and the administrator's local conversion attestation.
- Added dialogue-group checks across Train, Validation and Test, held-out evaluation of the final adapter, and continuation from a saved global checkpoint.
- Fixed a rare encoding failure when creating a coordinator TLS certificate.
- Existing installations reuse their Compute state, Python environments and local model files.

## [0.10.0-compute.2.dev.2] - 2026-11-26

- Redesigned Compute with separate contribution and lab modes, participation presets, contextual status and locally translated errors.
- Added invitation-driven setup with approval, discovery, verified optional downloads and governed preflight.
- Added automatic local lab setup, device readiness and a standard three-device Smoke launch.

Verified on Windows with an RTX 5070 using an existing runtime and model, and with a three-worker CPU Smoke that committed both rounds. Setup on an OS without Python or a model, end-to-end downloads, and the three-device hardware trial are still pending. [UX acceptance report](https://github.com/AranAragan/kvalah/blob/v0.10.0-compute.2.dev.2/docs/compute/UX-ONBOARDING.md).

## [0.10.0-compute.2.dev.1] - 2026-11-26

Development build for local verification. GPU and hardware acceptance are pending.

- Keep task leases alive during artifact downloads, training, sealing the local result and delivering it to the coordinator. Reconcile lost upload replies against server status.
- Check the memory policy before task claim, reuse verified artifacts by hash and persist the payload traffic budget.
- Persist atomic local checkpoint generations and track run-specific checkpoint lineage even when two runs produce identical bytes.
- Bind new experiments to registered model digests, check the model before loading and export structured diagnostics from the Compute tab.

## [0.10.0-compute.1] - 2026-11-26

> **Pre-release — NOT tested on real GPUs or Apple Silicon Metal.**
> Verified on the Linux build box on CPU only (`torch-cpu-test` and CPU-MLX on tiny random models, protocol/coordinator/governor/UI/CLI suites). Hardware runs on ENVERDASH (RTX 5070), ROG (RTX 2070) and MacBook M1 Pro are pending — see [docs/compute/HW-TEST.md](https://github.com/AranAragan/kvalah/blob/v0.10.0-compute.1/docs/compute/HW-TEST.md).

### Added
- **Kvalah Compute v0.2** (experimental, **off by default**): new *Compute* section in the sidebar with *Participation*, *Devices*, *Training Lab*, *Monitoring* and *Models & data* (English and Russian). The existing *Devices → Compute* tab (Offload GPU queue) and chat/agent/local inference workflows are unchanged.
- **Process isolation & Node control (`compute/`):** separate `compute/host.mjs` process started only when enabled (exits on close); Node owns the coordinator (SQLite WAL + CAS), worker, resource governor, pinned self-signed TLS, one-time pairing, per-device Ed25519 identities, admin approval/revoke, and FP64 FedAvg aggregation.
- **FFA-LoRA & SFT engine:** canonical coordinator-generated frozen A, B-only absolute updates weighted by coordinator-counted assistant-only supervised tokens, central tokenization (`fix_mistral_regex=True`, fixed system prompt), trusted validation NLL evaluator, report export + offline `verify-report`, PEFT adapter export, model registry with pinned revisions + Hugging Face provenance check, and a read-only `experiment-v01.zip` import reproducing v0.1 bit-exactly.
- **Local Resource Governor:** versioned consent per project/endpoint/fingerprint, GPU/CPU time share sliders, daily wall-time budget persisted across restarts, idle/AC/Windows game/local AI/full-screen/thermal/memory/quiet-hours/traffic limits; missing sensors pause with an explicit reason.
- **CLI:** `compute/cli.mjs` (`npm run compute -- --help` or `ELECTRON_RUN_AS_NODE=1` with packaged builds).

### Known Limitations
- **Hardware untested:** CUDA NF4 (RTX 5070 BF16 / RTX 2070 FP16), Metal MLX (M1 Pro), 3-device LAN runs, memory/throughput benchmarks, and real-model PEFT loading have **not** been executed yet.
- **Model provenance & quantization:** the community MLX 4-bit model remains `unverified` (its card lists `Base` rather than `Instruct`); mixed CUDA NF4 vs MLX 4-bit quantization is a confounder and is reported rather than hidden.
- **Sensors & background mode:** game detection exists only on Windows (`SHQueryUserNotificationState`), so macOS/Linux users should untick *Pause when games start* if needed; closing the Kvalah window stops Compute (no tray/background mode in v0.2); energy consumption is not measured.
- **Runtime & pairing:** Python 3.12 runtime and model folders are prepared manually using `compute/runtime/requirements-{cuda,mlx}.txt` (no auto-installer or hash pinning yet); changing coordinator bind IP or port regenerates the TLS certificate and requires re-pairing; device keys use `0600` file storage where Electron `safeStorage` is unavailable (Linux `basic_text` / CLI).

### Fixed
- `test/mac-updater.test.mjs`: the corrupted-sha512 case could equal the real digest (1 in 64 runs).

## [0.9.1] - 2026-11-25

### Added
- **Compute tab** in *Devices* (after *Pool*): a shared GPU queue with Kvalah Compute Offload. When the optional Compute Service is running, the kvalah chat and other agents take turns on the GPU instead of loading a model at the same time and filling VRAM. Without the service, kvalah works as before, and the tab reports that the service is not running. The tab is translated into all 10 languages. Checked on ENVERDASH (RTX 5070 Laptop): the tab is visible; cancelling a chat task unloads the model in Ollama (`ollama ps` empty, GPU utilization back to 0%).

## [0.9.0] - 2026-11-23

### Added
- **Live activity indicator** in the left sidebar, above *On your computer*, on every kvalah: what this computer does right now (*Idle*, *Pool host · devices: N*, *Memory node for …*, *Running tasks for …*, *Distributing tasks*), CPU and RAM use, GPU and its memory (NVIDIA via `nvidia-smi`, AMD on Linux via sysfs, shared memory on a Mac), network ↑/↓ of the peer traffic with a pulsing dot and a small graph, and tok/s while generating. Updated every second; a click opens *Devices*. Light and dark themes, all 10 languages.
- Workers report the same live stats over the token-authenticated API (`/peer/activity`); the host shows per-device activity in *Network devices* and in the *Pool memory* tab (per-worker traffic and load), so it is visible that work really runs on every device.
- **Thunderbolt / USB4 networking:** Thunderbolt Bridge on macOS (`networksetup`), *USB4(TM) P2P Network Adapter* / *Thunderbolt(TM) Networking* on Windows (`Get-NetAdapter`) and `thunderbolt-net` on Linux are recognised. Every address is labelled **Thunderbolt**, **Ethernet** or **Wi-Fi**.
- Discovery runs on all private interfaces, including link-local `169.254.x.x` (Thunderbolt cables without DHCP). The shared port starts listening on addresses that appear later (a cable plugged in) without dropping tunnels.
- Paired devices keep all their addresses; kvalah uses the fastest link (Thunderbolt > Ethernet > Wi-Fi) and fails over to the next one when a link goes away. The link in use is shown in *Network devices* and *Pool memory*; mixed setups (some laptops on cables, others on Wi-Fi) work.
- **Measure links**: round-trip time and throughput to every paired device (`/peer/ping`, `/peer/speedtest`), also measured when a pool starts.
- *This device*: the list of GPUs lent to the pool and **Also lend integrated GPUs**. *Pool memory*: **Skip integrated GPUs (recommended)**.

### Changed
- **Pool speed:** integrated GPUs (e.g. AMD Radeon 610M, Intel UHD) next to a discrete GPU no longer get layers by default: workers lend only their discrete GPUs (`rpc-server -d`) and the host passes an explicit `--device` list. A computer with only an integrated GPU still uses it. Layers stay split by free memory (`-ngl 999`).
- The pool warns when a worker is on Wi-Fi or on a slow link (> 4 ms or < 40 MB/s) and when the context is above 16K with workers.
- Pool device rows map each `RPCn` device to its worker and GPU name (a worker with two GPUs shows two rows).
- README (EN/RU): the *Several computers* guide got Thunderbolt setup for Mac/Windows/Linux, the indicator, link measurement, iGPU options, a speed section with expected figures and new troubleshooting rows; docs/DISTRIBUTED.md describes links, failover and live activity.

## [0.8.5] - 2026-11-23

### Fixed
- **Pool memory on Apple Silicon Macs: the Mac's GPU was never used** (“llama.cpp did not find a Metal GPU… devices: BLAS (Accelerate)”). When kvalah itself runs as the Intel build under Rosetta, it downloaded the **macOS x64** llama.cpp, and that build has no Metal backend at all: under Rosetta it lists only `BLAS: Accelerate`. Confirmed on a GitHub Apple Silicon runner (x64 build: `BLAS` only; arm64 build: `MTL0` + `BLAS`). kvalah now detects the Mac's real CPU (`sysctl.proc_translated` / `hw.optional.arm64`) and always installs the arm64 llama.cpp there (an arm64 binary runs natively even when started from a translated app).
- An already installed Intel llama.cpp on Apple Silicon is recognised (Mach-O CPU type) and re-downloaded automatically at startup; *Devices → This device* shows the build's architecture and a warning with the *Download* button until it is fixed.
- **Model loading could hang forever** (“Loading the model onto the devices…”, 0 MB of traffic). If llama-server prints nothing and nothing is sent to the devices for 3 minutes, the pool shows a warning with the last log lines; after 10 minutes without progress it stops with an error and the log instead of loading endlessly.

### Added
- The Mac self-updater picks the zip for the Mac's real CPU, and an Intel build running on Apple Silicon switches itself to the arm64 build of the same version (a note in *Devices → This device* explains it).
- llama-server errors (Metal/ggml init failures, `failed to load`, etc.) and, when no local GPU is found, the relevant `--list-devices` lines are written to the journal.
- After installing llama.cpp on macOS the quarantine attribute is cleared from its folder.

## [0.8.4] - 2026-11-23

### Fixed
- **Pool memory on Macs:** the device list showed `BLAS · 0.0 of 0.0 GB free` as a used local device. BLAS (Apple Accelerate) is a CPU helper that holds no layers and reports no memory; it is now marked *not used* with “memory not reported”. The Metal GPU (`MTL0`, from the macOS arm64/x64 llama.cpp build, which includes Metal) is the device that gets layers. Checked against the real `llama-server --list-devices` output of b12651 on macOS.
- Devices that report no memory show “memory not reported” instead of “0.0 of 0.0 GB”; a Metal GPU without a figure gets an estimate of its share of unified memory (marked ≈).

### Added
- If this computer's GPU is selected but llama.cpp finds none (no Metal on a Mac, a CPU-only build elsewhere), the pool shows a warning, and *Devices found by llama.cpp* shows the raw `--list-devices` output.
- A worker whose GPUs are busy with its own local pool is marked “GPUs busy with its own local pool”; a computer that lends its GPU to another host sees a note before starting its own pool.

### Changed
- Settings: the *Open “Devices”…* button uses the accent (primary) style, so it no longer blends into the card (light and dark themes).

## [0.8.3] - 2026-11-23

### Fixed
- **Pool memory → From Ollama:** the list could stay empty when the models are not in the folder kvalah scans (`OLLAMA_MODELS` or `~/.ollama/models`), e.g. when Ollama's model location was changed in the Ollama app or set only for the Ollama service. kvalah now also asks Ollama's API (at the Ollama URL from Settings, not the chat provider's URL, so it works while the chat uses the pool or another OpenAI-compatible server) and finds those models' GGUF files through `/api/show`. Without Ollama running, the folder scan still works.
- The list is reloaded every time Devices opens, and a ↻ button refreshes it (it used to be loaded once per window).

### Changed
- Picking a model in *From Ollama* fills the *GGUF file* field with the model's file path, so you see exactly what llama-server will load. The choice and path are kept after starting the pool.
- An empty list says why: “Ollama is not running at …” and/or “No Ollama models found in …”.
- New endpoint `POST /api/devices/gguf/resolve` (local UI only).

## [0.8.2] - 2026-11-23

### Added
- **Auto-update on macOS without a Developer ID.** The unsigned (ad-hoc signed) Mac build no longer just links to the release page: it downloads the zip for your CPU (arm64/x64) in the background with progress, verifies SHA-512 from `latest-mac.yml` and SHA-256 from `SHA256SUMS.txt`, unpacks it with `ditto`, removes the quarantine flag and checks the signature (ad-hoc signing it if needed), then offers *Restart and install*. A helper waits for kvalah to quit, swaps `kvalah.app` in place (asking for an administrator password only if the folder isn't writable), relaunches it, and rolls back if the new version doesn't start. Log: `~/Library/Application Support/kvalah/updates/install.log`.
- If kvalah runs from the disk image, Downloads or App Translocation, the notice asks to move it to Applications first, with a download link.
- CI: a macOS job builds an unsigned zip and runs the real update helper (`ditto`, `codesign`, `open`) against an installed copy.

### Note
- **macOS users on 0.8.1 or older need to install 0.8.2 manually once** (download the `.dmg` and replace the app). From 0.8.2 on, updates are automatic. Windows and Linux are unchanged.

## [0.8.1] - 2026-11-23

### Fixed
- **Pool memory:** a model picked in *From Ollama* was lost when the Devices screen refreshed (every 2.5 s, as soon as focus left the list, e.g. after ticking a device), so *Start pool* sent no model and failed with “Choose an existing GGUF model file” on Windows and macOS. Choices on the Pool tab now survive refreshes, and the model is sent by its Ollama name and resolved on the host.
- The Ollama model list now also loads when the Devices screen opens straight on the Pool tab.

### Changed
- Ollama model → GGUF resolution reads the manifest (`$OLLAMA_MODELS` or `~/.ollama/models`, `%USERPROFILE%\.ollama\models` on Windows; namespaced names and the default `latest` tag), with Ollama's `/api/show` as a fallback. When nothing is found, the error names every path that was checked.
- Clearer model errors: missing file, relative path, or a file that isn't GGUF are reported separately, with the path. The Pool tab shows where Ollama keeps model files, for *Browse…*.
- When llama-server stops while loading, the pool shows its error lines (for example `unknown model architecture`) instead of only the last lines of the log.

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
