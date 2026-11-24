# Threat model (v0.4)

v0.4 additions: no HTTP redirects for model traffic (SEC-02), LAN connections pinned to the checked IP (SEC-03), Zod-validated IPC with resource limits (IPC-01/02), filtered config errors (SEC-04), output filtering on every channel incl. IPC and dashboard (SEC-01), integrity-checked cache entries (CACHE-03). Residual: regex secret detection, LAN TLS/SNI not tested against real peers, Electron window not exercised.

## Assets
- Source code and files in the workspace (confidentiality), secrets that may sit in them.
- The user's machine resources (CPU, GPU, memory) and the local model.
- Integrity of what the cloud agent is told (results, quotes, routing advice).
- Cache, logs, stats and dashboard data on disk.

## Actors
- **Cloud agent** (trusted to call tools, not trusted with more data than needed; may be steered by injected text).
- **Local model output**: untrusted data (may be wrong or contain injected instructions from the files it read).
- **Repository content**: untrusted (may contain prompt injection, symlink tricks, huge or binary files).
- **Other local users / processes**: must not use the service, read the cache or the dashboard.
- **LAN peers**: only explicitly allow-listed ones are trusted with data; the network itself is not.
- **Web pages in the user's browser**: must not reach the dashboard (CSRF, DNS rebinding).

## Trust boundaries and controls
| Boundary | Controls (tests) |
|---|---|
| Agent → file system | Read-only, `KVALAH_WORKSPACE` only; lexical deny (case-insensitive), Windows UNC/drive/ADS/reserved names; descriptor-checked open (O_NOFOLLOW, /proc/self/fd or dev/ino), no symlinks/hardlinks/FIFOs, size and count limits, change detection during read (SEC-02) |
| Files → model / cache / logs / dashboard / errors | One secret policy (redact or block) on inputs, instruction, query, outputs, errors and log entries; sensitive results memory-only by default (SEC-01, CACHE-01) |
| Model output → agent | Type and size checks, quote verification per file and line range, injection/role-tag/command warnings, `outputAssessment:"unassessed"`, skill rule "never execute output" (SEC-04, SKILL-01) |
| Process → LAN | Off by default; allow-list (`KVALAH_LAN_ALLOW`), private addresses with DNS check per request, verified https (plaintext only by explicit opt-in), no redirects, no tokens in status; cloud models refused (SEC-03) |
| MCP client ↔ service | Local IPC only (Unix socket 0600 in 0700 dir / named pipe), 32-byte token in 0600 file rotated per start, constant-time compare, workspace binding, message size limit, per-client queues and limits (RUN-02) |
| Browser ↔ dashboard | 127.0.0.1 only, Host check (DNS rebinding), token, strict CSP with nonce; mutations POST-only with header token, same Origin, Sec-Fetch-Site and JSON (UI-01) |
| Resource exhaustion | Worker thread with timeout/heap limit for deterministic ops, queue and exec timeouts, request deadline, pending limits, scan caps, cancellation (CPU-01, RUN-01) |
| Cache on disk | 0700/0600, atomic unique temp files, strict quota, versioned key incl. workspace/policy/model digest, per-workspace clear (CACHE-01) |

## Prompt injection
Repository text can instruct the local model. Kvalah fences data with per-request nonces, never executes model output, flags role tags, shell commands and novel URLs, and verifies quotes. A finding with `quoteVerified:true` is still only a claim. The cloud agent remains responsible for decisions; security decisions are routed to Level 3.

## Privacy
By default nothing leaves the machine: loopback model endpoints only, LAN off, cloud models refused. The dashboard does not show sources or paths by default. Logs and stats contain task metadata (kind, timings, sizes), not file content. Cache retention: TTL `KVALAH_CACHE_TTL_HOURS` (168 h) and quota `KVALAH_CACHE_MAX_MB`; `KVALAH_CACHE=off` or `KVALAH_CACHE_DISK=0` disables disk storage.

## Residual risks
- Regex/entropy secret detection misses some secrets; keep secrets out of shared workspaces.
- DNS rebinding between the LAN address check and the TCP connect (narrow window); TLS verification mitigates for https peers.
- Windows: junction and `O_NOFOLLOW`-equivalent behaviour verified only by design and CI configuration, not on a real Windows host in this release; named-pipe ACLs are the OS default (the token is the guard).
- A local process running as the same user can read the token file and the dashboard token (same-user processes are not a boundary).
- Abort of an HTTP request may not stop GPU inference on every backend (not verified on real hardware).
- Exact token counts only with llama.cpp `/tokenize`; Ollama uses a calibrated estimate with a safety margin.
- Model output can be wrong while all quotes verify.
