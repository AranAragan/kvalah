<p align="center"><img src="public/icon-256.png" width="96" alt="kvalah logo"></p>

<h1 align="center">kvalah</h1>

<p align="center"><b>A reliable coding agent for 7–32B open models on a single home GPU.</b><br>
Ollama · LM Studio · llama.cpp · vLLM — Windows, macOS, Linux</p>

<p align="center">
<a href="https://github.com/AranAragan/kvalah/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/AranAragan/kvalah"></a>
<a href="https://github.com/AranAragan/kvalah/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/AranAragan/kvalah/actions/workflows/ci.yml/badge.svg"></a>
<a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center"><a href="README.ru.md">Русская версия</a></p>

<p align="center"><img src="docs/images/main-en.png" width="820" alt="kvalah main window"></p>

Big cloud agents assume a frontier model and 64K+ of context. kvalah is built for the model you can actually run at home: a 7–32B open-weight model with 8–32K of context. It keeps the agent on rails — **inspect → plan → edit → verify** — and **refuses to call a task done until a real check (tests, build, run) has passed** on the current sources.

## Features

- **Works with any local model server.** Ollama natively; LM Studio, llama.cpp `llama-server`, vLLM, LocalAI, Jan through the OpenAI-compatible API.
- **Robust tool calling for small models.** Native tool calls when the model supports them, otherwise a text protocol. Accepts `<tool_call>`, `[TOOL_CALLS]`, Harmony and fenced JSON, and repairs broken JSON.
- **Cache-friendly context.** The prompt prefix stays stable between steps so the server's prompt cache is reused; older steps are compacted into a digest; token estimates are calibrated from server counts.
- **Open any folder or Git repository** as a project, or start in a fresh one. Honors `AGENTS.md` / `AGENTS.override.md`.
- **Code navigation:** `search_code` (ripgrep or a built-in fallback), `find_files` (glob), `outline_file` (symbols for JS/TS, Python, C#/Java/Kotlin, Go, Rust, C/C++, PowerShell, Markdown).
- **Safe edits:** exact-fragment `edit_file`, multi-file `apply_patch` (Codex `*** Begin Patch` or unified diff, validated before writing), `append_file`; CRLF and BOM preserved; full rewrites only after a complete read.
- **Checkpoints and rewind:** a shadow-Git snapshot before every agent turn (your `.git` is untouched), per-edit undo with conflict detection, real diffs in the project panel.
- **Approval modes:** *Ask*, *Auto* (read-only commands run freely) and *Full access*, plus “always allow” rules per project.
- **Git tools:** `git_status`, `git_diff`, `git_commit` (with confirmation).
- **Multiple devices** (any number, on your LAN): **Pool memory** splits one big GGUF model across several computers with llama.cpp RPC, so models too large for one machine still run; **Distribute tasks** runs independent sub-tasks (code search, review, per-file jobs) in parallel on other computers' models, with failover. Pairing by code, token-authenticated, LAN-only. Step by step: [Several computers: setup guide](#several-computers-setup-guide); technical reference: [docs/DISTRIBUTED.md](docs/DISTRIBUTED.md).
- **10 UI languages** (English, Русский, Українська, Deutsch, Français, Español, Português (Brasil), 简体中文, Türkçe, 日本語), auto-detected on first launch.
- **Auto-update** from GitHub Releases, with a quiet in-app notice — never a forced restart.

<p align="center"><img src="docs/images/project-panel-de.png" width="640" alt="Project panel: plan, checks, diffs, checkpoints"></p>

## Install

| Platform | How |
|---|---|
| Windows 10/11 x64 | [Installer `kvalah-<version>-win-x64-setup.exe`](https://github.com/AranAragan/kvalah/releases/latest) (per-user, no admin rights) · or `winget install AranAragan.Kvalah` · or Scoop (below) · or the portable zip |
| macOS 12+ (Intel / Apple Silicon) | [`kvalah-<version>-mac-arm64.dmg` / `-mac-x64.dmg`](https://github.com/AranAragan/kvalah/releases/latest) |
| Linux x64 | [`kvalah-<version>-linux-x86_64.AppImage`](https://github.com/AranAragan/kvalah/releases/latest) or the `.deb` package |

**Scoop**

```powershell
scoop bucket add kvalah https://github.com/AranAragan/kvalah
scoop install kvalah
```

**Checksums:** every release has `SHA256SUMS.txt`.

**Unsigned builds.** Until code signing is in place (see [Code signing policy](#code-signing-policy)):
- Windows SmartScreen may show “Windows protected your PC” → *More info* → *Run anyway*.
- macOS: the app is not notarized, see [macOS step by step](#macos-step-by-step).
- Linux AppImage: `chmod +x kvalah-*.AppImage`.

### macOS step by step

1. Check your chip:  → *About This Mac*. **Apple M1/M2/M3/M4** → download `kvalah-<version>-mac-arm64.dmg`; **Intel** → `kvalah-<version>-mac-x64.dmg` from [Releases](https://github.com/AranAragan/kvalah/releases/latest).
2. Open the `.dmg` and drag **kvalah** into **Applications**.
3. First launch: the app is not notarized yet, so macOS says it can't verify the developer. Either:
   - try to open kvalah once, then go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway** (on macOS 14 and earlier, right-click the app → *Open* also works), or
   - run in Terminal: `xattr -cr /Applications/kvalah.app`, then open it again.
4. Install a model runtime, e.g. [Ollama](https://ollama.com/download), and pull a model: `ollama pull qwen2.5-coder:14b` (16 GB RAM) or `ollama pull qwen2.5-coder:7b` (8 GB RAM). kvalah finds Ollama automatically.
5. Updates: from 0.8.2 on, kvalah updates itself on macOS too. It downloads the new version in the background and shows *“Restart and install”*; the app must be in **Applications** (not opened from the disk image or Downloads), and if that folder isn't writable macOS asks for an administrator password. **Coming from 0.8.1 or older, install 0.8.2 manually once** (the `.dmg` over the old app); after that updates are automatic. Chats and settings are kept.

### Updates

The installed Windows app and the Linux AppImage check GitHub Releases at startup and every 6 hours, download the update in the background and show *“Update X is available — Restart and install”*. The update is applied only when you click the button or quit the app. The unsigned macOS build (0.8.2+) does the same with its own updater: it downloads the zip for your Mac, checks its SHA-512/SHA-256, replaces `kvalah.app` in place after you click the button, relaunches it and rolls back if the new version doesn't start. The portable zip and `.deb` only show a notice with a download link. Turn checks off in **Settings → Check for updates automatically**, or check manually in **Help → Check for updates…**.

## Connect a model

kvalah needs a model server running locally (or on your LAN). Open **Settings → Model server**.

| Server | Setting | URL |
|---|---|---|
| [Ollama](https://ollama.com) | Ollama | `http://127.0.0.1:11434` |
| [LM Studio](https://lmstudio.ai) (Developer → Start server) | OpenAI-compatible | `http://127.0.0.1:1234/v1` |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server -m model.gguf -c 16384 --jinja` | OpenAI-compatible | `http://127.0.0.1:8080/v1` |
| [vLLM](https://docs.vllm.ai) `vllm serve <model> --enable-auto-tool-choice --tool-call-parser <parser>` | OpenAI-compatible | `http://127.0.0.1:8000/v1` |

- **API key** is optional (only for servers that require one); it is stored locally and never shown again in the UI.
- **Tool calls:** *Auto* uses native tool calls when the model supports them and the text protocol otherwise. Choose *Text protocol* for models that keep mangling the native format.
- **Context:** agent mode needs at least 8192 tokens; 16–32K is the sweet spot for 7–32B models. For Ollama, kvalah sets `num_ctx` itself.
- Good starting models: Qwen2.5-Coder 14B/32B, Qwen3 14B/32B, Devstral Small, GPT-OSS 20B, Mistral Small 24B.

**Several computers?** Settings → **Devices** pools memory across them for a model that doesn't fit on one machine (bigger, not faster; use Ethernet), or runs agent sub-tasks in parallel on them. See the [step-by-step setup guide](#several-computers-setup-guide) below and [docs/DISTRIBUTED.md](docs/DISTRIBUTED.md).

Optional: Git in `PATH` enables checkpoints and Git tools; `rg` (ripgrep) in `PATH` speeds up code search on large repositories.

## Several computers: setup guide

This section walks through setting up **Pool memory** (one big model split across several computers) and **Distribute tasks** (agent sub-tasks run in parallel on other computers). The labels below match the app's interface. For the technical details (protocol, scheduling, security, environment variables) see [docs/DISTRIBUTED.md](docs/DISTRIBUTED.md).

Terms used here: the **host** is the computer you work on, where the chat and the agent run. A **worker** is a computer that lends its model, GPU or RAM to the host. You can have any number of workers.

### 1. Requirements

- **The same kvalah version on every computer**, 0.8.5 or newer. Update all of them before pairing.
- **One local network.** All devices must be on the same LAN. Automatic discovery only works within one subnet; across subnets (VLANs, a second router, guest Wi-Fi) add devices by IP manually.
- **Wired Ethernet is recommended**, 1 Gbit/s or better. Wi-Fi works, but Pool memory over Wi-Fi is slow. Distribute tasks is fine on Wi-Fi.
- **Two Macs can use a Thunderbolt cable as the network.** Connect them, then use the Thunderbolt Bridge address (System Settings → Network → Thunderbolt Bridge, usually `169.254.x.x`) with **Add manually**.
- **Apple Silicon Macs (M1–M4) must run the Apple Silicon build**: `kvalah-<version>-mac-arm64.dmg`. The Intel build (`mac-x64`) runs under Rosetta and llama.cpp then can't use Metal. Since 0.8.5 kvalah detects this, downloads the right llama.cpp and offers to switch the app to the arm64 build, but installing the arm64 dmg from the start avoids the detour.
- For Pool memory: **llama.cpp build b12651** on the host and on every worker (kvalah downloads it for you, see below).

### 2. Set up each worker

On every worker, open **Settings → Devices → Open Devices…** (or **kvalah → Devices…** in the app menu), tab **This device**:

1. Turn on **Share this device**.
2. Set **Device name** (what the host will see) and, if needed, **Port** (default **47317**).
3. Note the **Pairing code** shown on the tab, for example `K7QM-2D9X-HF4R`. **New code** generates a different one. **Reachable at** lists this computer's addresses; the status should read **Listening**.
4. Choose what this computer offers:
   - **Run tasks for paired devices**: the host may use this computer's model (Ollama or another local server) for distributed sub-tasks. Cloud API keys are never shared.
   - **Pool memory worker (llama.cpp RPC server)**: lends this computer's GPU and RAM to a pooled model started on another device. The tab then shows **RPC server running**.
5. For Pool memory, install llama.cpp in the **llama.cpp** card: leave **Backend** on **Automatic** (Metal on a Mac, Vulkan elsewhere) or pick **Vulkan (NVIDIA, AMD, Intel)**, **CUDA (NVIDIA)** or **CPU only**, and click **Download**. When it finishes, the card shows **Installed: build b12651, …**. On a Mac it must say `metal` and `arm64`; on Windows/Linux with a GPU it should be `vulkan` or `cuda`, not `cpu`. Every device needs the same build (b12651).
6. Allow kvalah through the firewall when asked, **on private networks only**. Ports: **TCP 47317** (pairing, tasks, pool) and **UDP 47318** (discovery).
   - **Windows:** the network must have the **Private** profile (Settings → Network & internet → your Ethernet or Wi-Fi → Network profile type → Private). On a *Public* network the firewall blocks kvalah even after you allowed it.
   - **macOS:** answer **Allow** to “accept incoming network connections”. If you clicked Deny, change it in System Settings → Network → Firewall → Options.
   - **Linux:** open the ports if a firewall is active, e.g. `sudo ufw allow from 192.168.0.0/16 to any port 47317 proto tcp` and the same for `47318 proto udp`.

Under **Paired with** the worker later lists the hosts that paired with it; **Revoke** cuts one off.

### 3. Pair the workers on the host

On the host, open **Devices → Network devices**:

1. Under **Found on your network** the workers appear automatically (click **Search** to look again). Enter the worker's **Pairing code** and click **Pair**. You'll see “Device paired”.
2. If a worker isn't found (another subnet, Thunderbolt Bridge, a strict firewall), use **Add manually**: **Type** → **kvalah (paired)**, **Address** → `192.168.1.20:47317` (the worker's address from **Reachable at**), **Pairing code**, then **Add**.
3. Each paired device gets a row with its status (**Online**, latency, models, load) and two checkboxes:
   - **Tasks**: use this device for distributed sub-tasks. You can choose its model (**Same model as here** or a specific one) and **Tasks at a time**.
   - **Memory**: use this device in Pool memory. Its row shows **RPC ready** when the worker's RPC server runs, otherwise **RPC off**.
4. **Check now** re-checks all devices. **Remove** deletes a device; it must then be paired again.

You can also add a bare **Ollama** (it must listen on the network: `OLLAMA_HOST=0.0.0.0`) or an **OpenAI-compatible server** as a task device. These have no password, so add them only on a trusted network; pairing with kvalah is safer.

### 4. Distribute tasks

On the host, **Network devices**, turn on **Distribute tasks** and tick **Tasks** for the devices to use. **This computer** sets how much the host itself takes: **Only as a fallback**, **1 task at a time** or **2 tasks at a time**.

While it is on, the agent gets two extra tools:

- **`parallel_tasks`**: up to 8 independent sub-tasks (find usages, review a module, look for missing tests…). Each runs as a read-only helper agent on another device's model; the files are read on the host. The reports come back in order.
- **`batch_files`**: one instruction applied to many files (up to 300, by list or glob), in `report` mode (answers per file) or `edit` mode (devices propose new contents, the host applies them one by one with checkpoints and undo, and refuses files changed in the meantime).

The agent decides when to use them, but you can ask directly, for example:

- “Use parallel_tasks: review `src/server`, `src/ui` and `src/storage` separately for bugs and summarize the findings.”
- “Use batch_files in report mode on `src/**/*.ts`: list every exported function without tests.”
- “Use batch_files in edit mode on `docs/*.md`: fix spelling only, change nothing else.”

Fallback: a sub-task goes to the least loaded healthy device. If a device times out, errors or goes offline, the sub-task is retried on another device (up to 4 attempts), with **This computer** as the last resort. A device that fails 3 times in a row is marked **Offline** until the next successful check. Edits, commands and the final checks (`verify_project`) always stay on the host.

### 5. Pool memory (one model on several computers)

Before you start: on every worker **Pool memory worker** is on and llama.cpp b12651 is installed; on the host llama.cpp b12651 is installed too and those workers have **Memory** ticked.

On the host open **Devices → Pool memory**:

1. **Devices in the pool**: tick the workers to include and, if the host has a GPU, **This computer's GPU**. Rows show free memory (on Macs an estimate marked ≈, because the GPU shares RAM) and *used* / *not used*.
2. **Model**: pick a model under **From Ollama**; kvalah finds its GGUF file in Ollama's store and fills in the path. If the list is empty or stale, click ↻ (**Refresh the list**). Or set **Or a GGUF file** with **Browse…**. Only the host needs the model file; the weights are sent to the workers when the pool starts.
3. **Context**: start with 16384–32768. A bigger context needs more memory on every device.
4. Click **Start pool**. The status goes **Connecting to devices…** → **Loading the model across devices…** → **Running at …**. The **Traffic** line shows how much was sent to the workers; the first load of a 30 GB model over 1 Gbit/s takes several minutes. **Log** shows llama-server's output.
5. Click **Use for the agent**. The label changes to **The agent uses the pool**, and chats now run on the pooled model.
6. **Stop pool** stops it and switches the agent back to your previous model server.

Rules and expectations:

- **One pool per set of GPUs.** A worker that runs its own pool shows **GPUs busy with its own local pool**; a computer whose GPU is lent to another host warns before you start a local pool there, because both would share the same memory.
- **Bigger models, not faster.** Every generated token crosses the network, so a pool is usually slower than a single device. Use it when a model doesn't fit on one computer.
- The pool serves one conversation at a time and is not used for distributed sub-tasks.

### 6. Troubleshooting

| Symptom | What to do |
|---|---|
| The worker is not in **Found on your network** | Check that **Share this device** is on and shows **Listening**, both computers are on the same subnet, the firewall allows kvalah on private networks (Windows: network profile **Private**). Otherwise use **Add manually** with the address from **Reachable at**. |
| **Device … is not reachable.** / **Offline** | The worker is asleep, kvalah is closed there, its address changed (DHCP) or a firewall blocks TCP 47317. Click **Check now**; if the address changed, **Remove** the device and pair it again. |
| **Wrong pairing code.** / **Too many wrong codes. Try again in 10 minutes.** | Copy the code from the worker's **This device** tab. After 5 wrong codes pairing is locked for 10 minutes. |
| **From Ollama** list is empty (**No Ollama models found in …** or **Ollama is not running at …**) | Start Ollama and click ↻ (**Refresh the list**). If you moved Ollama's models, set `OLLAMA_MODELS` to that folder (or check **Settings → Ollama address**), or choose the file with **Browse…**: the model is the largest `sha256-…` file in the `blobs` folder. |
| **Choose a model from Ollama or a GGUF file.** / **GGUF file not found: …** | Pick a model in the list or select an existing `.gguf` file with **Browse…**; the path must be a full path on the host. |
| Mac: **llama.cpp found no Metal GPU on this Mac (devices: BLAS (Accelerate))**, the Mac row says *not used* | The Intel build of kvalah runs under Rosetta and installed the x64 llama.cpp, which has no Metal. Install `kvalah-<version>-mac-arm64.dmg` (or accept the switch offered by the update), then **Devices → This device → Download**. The card must show `metal · arm64`. |
| Stuck on **Loading the model across devices…** | After 3 minutes without new llama-server output or network traffic the pool shows a warning with the last log lines; after 10 minutes it stops with an error. Open **Log** to see why (out of memory, unsupported model, a worker that dropped). |
| **… uses llama.cpp …; all devices need the same build.** | Update kvalah and press **Download** on every device so all use b12651. |
| **OpenAI-compatible server is unreachable at http://127.0.0.1:8080/v1** (or another port) | The agent is still set to the pool, but the pool is stopped. Start the pool again, or switch **Settings → Model server** back to Ollama or your usual server. |

### 7. Security

- Nothing listens on the network until you turn on **Share this device**, and kvalah only accepts connections from private (LAN) addresses.
- Pairing gives the host a random token; every request and the RPC tunnel need it. The worker can **Revoke** it at any time. Five wrong codes lock pairing for 10 minutes.
- **Traffic is not encrypted:** prompts, file contents and model weights travel in plain form on your LAN. Use this only on networks you trust, never on public or guest Wi-Fi.
- Workers share only their local model server and hardware; cloud API keys never leave the computer.

## How it works

1. **Inspect** — the agent reads the tree, README/config files, scoped `AGENTS.md` and `git status`.
2. **Plan** — `update_plan` stores concrete steps and acceptance checks (`PLAN.md` / `STATUS.md`, or under `.kvalah/` if you already have such files).
3. **Edit** — file tools create checkpoints; every change has a diff and can be undone.
4. **Verify** — `verify_project` runs a real command and records a fingerprint of the sources it checked. `finish_task` refuses missing, failed or stale evidence.

Shell commands run with your user's permissions after the approval policy; this is **not an OS sandbox**. Read [SECURITY.md](SECURITY.md).

## Build from source

Requirements: Node.js 22+ and Git.

```bash
git clone https://github.com/AranAragan/kvalah.git
cd kvalah
npm ci
npm test               # unit + end-to-end tests with a mock model server
npm run desktop        # run the Electron app
npm start              # or: backend only, open the printed URL in a browser
```

Packages (output in `release/`):

```bash
npm run dist:linux     # AppImage + deb
npm run dist:win       # NSIS installer + portable zip (on Linux/macOS needs wine for NSIS)
npm run dist:mac       # dmg + zip, x64 + arm64 (macOS only)
```

Releases are built by GitHub Actions when a `v*` tag is pushed: see [docs/PUBLISHING.md](docs/PUBLISHING.md) (in Russian) and [.github/workflows/release.yml](.github/workflows/release.yml).

Data locations: settings, chats and logs are in the Electron user-data folder (`%APPDATA%\kvalah`, `~/Library/Application Support/kvalah`, `~/.config/kvalah`); new projects go to `Documents/kvalah`.

## Code signing policy

Windows releases are built and signed exclusively by the [release workflow](.github/workflows/release.yml) from this repository's source; the signing setup is described in [docs/SIGNING.md](docs/SIGNING.md).

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org) *(applies once the project is accepted into the SignPath Foundation program; until then releases are unsigned)*.

- Committers and reviewers: [Enver Abdullaev (@AranAragan)](https://github.com/AranAragan)
- Approvers: [Enver Abdullaev (@AranAragan)](https://github.com/AranAragan)

Every signing request is approved manually; only binaries built by GitHub Actions from a tagged commit of this repository are signed.

### Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. In particular:

- prompts, files and tool results are sent only to the model server **you** configure (by default a server on your own computer);
- the update check contacts GitHub (`api.github.com`, `github.com`, `objects.githubusercontent.com`) to read the latest release and download it; it sends no personal data beyond what any HTTPS request contains (IP address, app version in the User-Agent). It can be turned off in Settings;
- **Devices** (off by default): only after you turn on *Share this device*, kvalah listens on your local network and answers discovery broadcasts. Paired devices receive the prompts and file contents of the sub-tasks you send them, and pooled model weights are transferred to the pool's workers. *Download llama.cpp* fetches the build from `github.com/ggml-org/llama.cpp`;
- there is no telemetry, analytics or crash reporting.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Enver Abdullaev. Bundled third-party components keep their own licenses (Electron — MIT, pdf.js — Apache-2.0, electron-updater — MIT).
