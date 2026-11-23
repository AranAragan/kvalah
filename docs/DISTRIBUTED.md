# Multiple devices: Pool memory and Distribute tasks

kvalah 0.8 can use other computers on your local network. Both modes work with **any number of devices**, not just two. Open **Settings → Devices** (or **kvalah → Devices…** in the desktop app menu). For a step-by-step walkthrough with troubleshooting see [Several computers: setup guide](../README.md#several-computers-setup-guide) ([на русском](../README.ru.md#несколько-компьютеров-пошаговая-настройка)).

| | Pool memory | Distribute tasks |
|---|---|---|
| What it does | Splits **one** model across several devices (llama.cpp RPC), so a model that doesn't fit on one computer can run | Runs **independent sub-tasks** in parallel on other devices' models |
| Speed | Bigger models, **not faster**. Usually slower than one device | Faster for jobs that can run in parallel |
| Needs on each device | kvalah with "Share this device" and "Pool memory worker" on, plus the same llama.cpp build | kvalah (paired), a bare Ollama, or any OpenAI-compatible server |
| Network | Wired Ethernet strongly recommended | Wi-Fi is fine |

## 1. Pair the devices

On every **worker** (a computer that lends its resources):

1. Open **Settings → Devices → This device** and turn on **Share this device**.
2. Choose the port if you want (default **47317/TCP**). The tab shows the addresses and a pairing code such as `K7QM-2D9X-HF4R`.
3. Allow kvalah through the firewall when Windows/macOS asks, **on private networks only**.

On the **host** (the computer you work on), go to **Network devices**:

- Devices that share themselves are found automatically: UDP broadcast on **47318/UDP**, same subnet only. Enter the worker's code and click **Pair**.
- If discovery is blocked (VLANs, guest Wi-Fi, a strict firewall), use **Add manually** with `192.168.1.20:47317` and the code.
- You can also add a bare **Ollama** (`OLLAMA_HOST=0.0.0.0`, port 11434) or any **OpenAI-compatible** server (LM Studio, vLLM, llama-server) as a task node. These have no pairing; see *Security* below.

Pair as many workers as you like. Each paired device has a **Tasks** checkbox and a **Memory** checkbox, plus a per-device model and a limit on how many tasks it runs at a time.

## 2. Pool memory (one big model on several devices)

Requirements:

- **llama.cpp** on the host and on every worker. Click **Download** on the *This device* tab to fetch the pinned prebuilt build (**b12651**, verified by SHA-256) into kvalah's data folder. You can also point kvalah at your own build. All devices **must use the same build**, because the RPC protocol changes between versions. kvalah refuses to mix builds it knows about and warns about custom ones.
- **Backends:** Automatic (Metal on macOS, Vulkan elsewhere), CPU only, Vulkan (NVIDIA/AMD/Intel), CUDA (NVIDIA, Windows only, adds the CUDA runtime).
- On each worker, turn on **Pool memory worker** (it runs `ggml-rpc-server` on `127.0.0.1` only).

On the host, open **Pool memory**:

1. Tick the devices to include: any number of workers, plus optionally **This computer's GPU**. Free and total memory per device is shown once the pool is running.
2. Choose a GGUF model. kvalah lists models already downloaded by Ollama (it reads the Ollama blob store directly, so nothing is copied), or you can pick a `.gguf` file. The store is `$OLLAMA_MODELS` if set, otherwise `~/.ollama/models` (`%USERPROFILE%\.ollama\models` on Windows); the weights are the largest `sha256-…` file in its `blobs` folder. If llama.cpp can't load a model (for example an architecture the pinned build doesn't support), the pool shows llama-server's own error.
3. Set the context and click **Start pool**. kvalah opens an authenticated tunnel to each worker, checks them with `--list-devices`, and starts `llama-server --rpc …` on `127.0.0.1`. The model's layers are spread across the devices in proportion to their free memory.
4. Click **Use for the agent**. The agent switches to the pool (an OpenAI-compatible backend, model `pool`) with the real context size reported by llama-server. **Stop pool** switches back to your previous model server.

Only the host needs the model file: llama-server sends the weights to the workers over the network when the pool starts. Expect the first load of a 30 GB model over 1 Gbit/s Ethernet to take several minutes.

**Why it is not faster:** each token passes through every device in turn, so network latency adds up. On Wi-Fi this is often several times slower than Ethernet. Use the pool when a model doesn't fit on one machine, not to speed up one that does.

## 3. Distribute tasks (parallel sub-tasks)

Turn on **Distribute tasks** on the *Network devices* tab. While it is on, the agent gets two more tools:

- **`parallel_tasks`**: up to 8 independent sub-tasks (find usages, review a module, look for missing tests…). Each runs as a **read-only helper agent** with `read_file`, `search_code`, `find_files`, `outline_file` and `list_files` on the host's project. The tools run on the host; only the model calls go to the remote device. Reports come back in task order.
- **`batch_files`**: the same instruction applied to up to 300 files (by list or glob), in `report` or `edit` mode. In edit mode the devices only *propose* new file contents. The host applies them one by one, in input order, through the normal write path: checkpoint, undo and a hash check that refuses files changed in the meantime. Truncated or placeholder replies are rejected. The agent must still pass `verify_project` before `finish_task`.

Scheduling:

- Each sub-task goes to the least loaded healthy device that has the model (score = load × latency), limited by each device's "tasks at a time".
- If a device fails (timeout, error, went offline), the sub-task is retried on another device, up to 4 attempts. **This computer** is the last fallback. "This computer: only as a fallback" keeps local resources free unless no other device can take the job.
- A device that fails 3 times in a row is marked offline until the next successful health check (every 20 s while any device is enabled).
- The main agent loop stays on the host and stays sequential. Only independent, read-only work (and proposed edits) is distributed.

## Security

- **Nothing listens on the network until you turn on "Share this device".** kvalah binds only to private LAN addresses (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10 as used by Tailscale and other VPN overlays, IPv6 ULA/link-local) and drops connections from public addresses.
- Pairing uses a 12-character code with brute-force protection (5 wrong codes, then a 10-minute lockout). The host receives a random 256-bit token. The worker keeps only its SHA-256 hash, and you can revoke it at any time (*Paired with → Revoke*).
- Every peer request needs the token: the model proxy (`/peer/llm/*`, allowlisted chat/model routes only) and the RPC tunnel. `ggml-rpc-server` itself has no authentication, so kvalah runs it on `127.0.0.1` and exposes it only through the token-checked tunnel on the shared port.
- Workers lend their **local** model server only. Cloud API keys are never shared.
- **No encryption on the wire:** prompts, file contents and model weights travel unencrypted on your LAN. Use it only on networks you trust, not on public or guest Wi-Fi.
- A bare Ollama or OpenAI-compatible node has no kvalah pairing. Anyone on the network can use it, so add one only on a trusted network.

Firewall: allow kvalah on **private** networks. Ports: the share port (default **47317/TCP**) and **47318/UDP** for discovery. Discovery is optional; manual add works without UDP.

## Limitations

- Pool memory requires the same llama.cpp build on every device, and a working llama.cpp backend for each GPU. Prebuilt CUDA archives are published for Windows only. On Linux, use Vulkan or your own build.
- The pool runs one conversation at a time (`-np 1`) and is not used for distributed sub-tasks.
- Discovery works within one subnet (broadcast). Across subnets, add devices manually.
- Tunnel traffic is not encrypted (see Security).
- `parallel_tasks` helpers can't edit files or run commands, by design.

## Environment variables (advanced, for tests)

| Variable | Meaning |
|---|---|
| `KVALAH_PEER_BIND` | Comma-separated addresses to bind the shared port to (default: all private LAN IPv4 addresses) |
| `KVALAH_DISCOVERY_PORT` | UDP discovery port (default 47318) |
| `KVALAH_DISCOVERY_TARGET` | Address that discovery probes are sent to (default: subnet broadcast addresses) |
