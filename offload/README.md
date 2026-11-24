# Kvalah Compute Offload v0.4

An MCP server that lets cloud coding agents (Claude Code, Codex, Cursor and others) push bulky, read-only work onto **the user's own machine**. It uses an algorithm where one is enough and the local model only where text has to be read.

| Level | What runs | Examples | Cloud cost |
|---|---|---|---|
| **1. Deterministic** (`kvalah_compute`) | AST, grep, hashing, import graph (worker thread with time/memory limits) | find a definition, importers, cycles, TODOs, hashes, line stats | the call and its (bounded) result; `references` is textual, `deps` reports `complete:false` when imports are dynamic or unresolved |
| **2. Local LLM** (`kvalah_delegate`, `kvalah_batch`) | Ollama / LM Studio / llama.cpp on this PC, or allow-listed LAN peers | triage a large CI log, summarize docs, draft tests/docs, first-pass review | the call and the short result; an unverified draft |
| **3. Cloud** (router decision) | the cloud agent itself | small inputs, content already in context, security decisions, overload | n/a |

`kvalah_auto` takes a goal in plain words, picks the level and returns `route.reason`.

> **Why `paths` matter:** savings come only from content the cloud model never reads. Pasting a file into `context` has already been paid for. Give Kvalah `paths` and let it read the files itself. All savings figures Kvalah reports are **estimates**; no measured savings are published for v0.4 (see `bench/RESULTS-real.md`, `docs/V04-REPORT.md`).

## What's new in v0.4 (security, shared compute, honest economics)
Details, evidence and the readiness table: [docs/V04-REPORT.md](docs/V04-REPORT.md); architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Security:** the secret filter never returns raw data past its depth limit and runs on MCP, IPC, cache, dashboard and logs; no HTTP redirects for any model provider (also in overlay mode); LAN connections pinned to the verified IP (no DNS rebinding); config errors and logs filtered; IPC validated by Zod schemas with connection/in-flight/subscriber/pending limits.
- **One Compute Service per machine:** `KVALAH_SERVICE=auto` elects one host among MCP clients (lock file + socket), so N agents never start N engines; the Kvalah desktop app joins the same queue through `lease`/`release` (patch: `docs/kvalah-integration.patch`); background work ages instead of starving; cancel stops generation end to end.
- **Economics:** benchmark verdicts PASS/FAIL/INCOMPLETE/INVALID/NOT_MEASURED (missing pairs or mismatched conditions never pass); usage adapters per provider (no double counting of cached/reasoning tokens); failed attempts, retries, fallback and verification billed; Skill + MCP tool-description overhead counted; estimated and measured kept apart everywhere.
- **Routing/scheduling:** devices compared by measured tok/s and TTFT; the router decides on expected savings (failure rate, verification cost, files already read, MCP overhead).
- **Cache:** cross-process disk quota (lock + shared ledger), checksummed entries. **MCP:** per-client content/structuredContent behaviour documented ([docs/mcp-clients.md](docs/mcp-clients.md)).
- **Dashboard:** agents, queue, device load/speed, errors and cancelled operations. **Skill** synced with the API and Agensi packaging rules.

## What was new in v0.3 (stabilization)
- **Security:** one secret policy on every input and output path (model, cache, logs, dashboard, errors; `KVALAH_SECRET_POLICY=redact|block`); case-insensitive workspace deny rules and Windows path checks (UNC, drive, ADS, reserved names); LAN only for allow-listed nodes on private addresses with verified https; cloud-backed models refused by default; findings verified per file and line range (`quoteVerified`, `pathMismatch`, `ambiguous`).
- **Context:** strict budgets including all prompt overhead, refusal instead of silent truncation, coverage from merged character ranges (`sourceCoverage`, `selectedCoverage`, `skipped`), exact-overflow re-planning.
- **Resources:** deterministic ops in a worker thread (timeout, memory limit, terminate on cancel); queue timer re-armed on retries, per-request deadline, pending-call limit, cancellation that stops queued and running work.
- **Shared Compute Service** (`kvalah-offload-service`): one engine for the Kvalah GUI and any number of MCP clients over authenticated local IPC, with fair scheduling, priority, backpressure, dedupe, cancel and graceful shutdown.
- **Cache:** key covers schema/prompt version, workspace, policy, model digest and node capability; atomic writes, strict disk quota, real LRU, 0600 files, per-workspace clear; results of tasks with secrets stay in memory unless allowed.
- **Router / economics:** decisions on net tokens; USD only when prices are configured (no default prices); selective-reading baseline; per kind@model stats; a paired benchmark harness with 54 scenarios and pre-declared gates.
- **MCP:** compact descriptions, payload mode and size cap, stack-free errors. **Dashboard:** cancel and cache clear with token + Origin checks; estimated vs measured cost shown separately.
- **Skill Lite** (`skill/`), CI matrix (`.github/workflows/ci.yml`), `engines` aligned with Babel 8 (`^22.18.0 || >=24.11.0`).

## Install

Requirements: Node.js ^22.18.0 or >=24.11.0 and a local inference server (Ollama, LM Studio, or llama.cpp `llama-server`).

**Standalone:**
```bash
git clone … && cd kvalah-offload && npm install     # or: npm i -g kvalah-offload (once published)
KVALAH_MODEL=qwen3.5:9b KVALAH_WORKSPACE=$PWD npx kvalah-offload   # smoke test; Ctrl+C
```
**Inside a kvalah checkout:** put this package in `kvalah/offload/` and run `npm install` there. It then picks up kvalah's own `providers.mjs`, `scheduler.mjs` and `nodes.mjs` automatically (`kvalah_status` → `kvalah.mode: "overlay"`). You can also set `KVALAH_HOME=/path/to/kvalah`.

### Claude Code
```bash
claude mcp add kvalah --scope user -e KVALAH_MODEL=qwen3.5:9b -e KVALAH_WORKSPACE=/abs/project \
  -- node /abs/kvalah-offload/mcp/server.mjs
```
### Codex (`~/.codex/config.toml`)
```toml
[mcp_servers.kvalah]
command = "node"
args = ["C:/tools/kvalah-offload/mcp/server.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 600
[mcp_servers.kvalah.env]
KVALAH_MODEL = "qwen3.5:9b"
KVALAH_WORKSPACE = "C:/projects/my-app"
```
### Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`)
```json
{ "mcpServers": { "kvalah": { "command": "node", "args": ["/abs/kvalah-offload/mcp/server.mjs"],
  "env": { "KVALAH_MODEL": "qwen3.5:9b", "KVALAH_WORKSPACE": "${workspaceFolder}" } } } }
```
Then install the skill (`skill/README.md`) so the agent knows when to use each tool.

Client configuration formats follow each client's documentation; they were **not verified against current client versions** in this release. Full install, update, uninstall, rollback and troubleshooting: [docs/INSTALL.md](docs/INSTALL.md).

## Modes
- **Standalone** (default for the npm package): vendored scheduler/registry and lite providers.
- **Overlay**: inside a kvalah checkout (or `KVALAH_HOME`), kvalah's own `providers.mjs`, `scheduler.mjs`, `nodes.mjs` are used (`kvalah_status` → `kvalah.mode: "overlay"`). `KVALAH_STANDALONE=1` forces standalone.
- **Service**: one engine per machine. With `KVALAH_SERVICE=auto` (default) the first MCP server takes an exclusive lock and hosts the service in-process; the others connect to it, and if the host dies one of them takes over (election). `connect` = v0.3 behaviour (use a running service, else own engine), `required` = connect only (fail closed), `off` = in-process only. `kvalah-offload-service` (or `npm run service`) runs a standalone host. Clients with a different config fingerprint are refused (`ServiceMismatchError`). IPC: Unix socket (0600, directory 0700) or Windows named pipe, plus a 0600 token file rotated on every start; clients must name the same workspace. No TCP port is opened. The Kvalah desktop GUI can connect as an `interactive` client with the same protocol (see `compute/service.mjs` header); the Electron integration is delivered as `docs/kvalah-integration.patch` (see `docs/kvalah-integration.md`).

## Configuration
| Variable | Default | Meaning |
|---|---|---|
| `KVALAH_MODEL` | required | Local model name or ID |
| `KVALAH_PROVIDER` | `ollama` | `ollama` or `openai` (LM Studio, llama.cpp, vLLM) |
| `KVALAH_LOCAL_URL` | `http://127.0.0.1:11434` / `:1234/v1` | Loopback only |
| `KVALAH_ALLOW_CLOUD_MODELS` | off | `1` allows `-cloud`/`:cloud` models (they send data off the machine) |
| `KVALAH_WORKSPACE` | off | Read-only root for `paths` and `kvalah_compute` |
| `KVALAH_CONTEXT` | `16384` | Requested context, capped by the detected model maximum |
| `KVALAH_MAX_TOKENS` | `2048` | Output budget per call (thinking disabled) |
| `KVALAH_MAX_CHUNKS` | `24` | Map-reduce chunk limit before an explicit error (or retrieval with `query`) |
| `KVALAH_MAX_PARALLEL` | `1` | Local slots (match `OLLAMA_NUM_PARALLEL`) |
| `KVALAH_TIMEOUT_MS` / `KVALAH_QUEUE_TIMEOUT_MS` | `90000` / `120000` | Execution timeout per call / maximum queue wait |
| `KVALAH_REQUEST_DEADLINE_MS` | `900000` | Deadline for a whole request (reads, queue, all calls) |
| `KVALAH_MAX_PENDING_CALLS` | `64` | Pending model calls before `OverloadError` |
| `KVALAH_SECRET_POLICY` | `redact` | `redact` or `block` |
| `KVALAH_SECRET_DENY` / `KVALAH_SECRET_ALLOW` | empty | Extra regexes to treat as secret / to exempt (comma-separated) |
| `KVALAH_STRUCTURED` | `1` | JSON-schema output with verified findings (`0` = plain text) |
| `KVALAH_CACHE` / `KVALAH_CACHE_DIR` / `KVALAH_CACHE_TTL_HOURS` / `KVALAH_CACHE_MAX_MB` | on / OS cache dir / `168` / `64` | Result cache (`KVALAH_CACHE=off` disables disk cache and stats file) |
| `KVALAH_CACHE_DISK` | `1` | `0` keeps results in memory only |
| `KVALAH_CACHE_SENSITIVE` | off | `1` allows results of tasks that contained secrets on disk |
| `KVALAH_DET_WORKER` / `KVALAH_DET_TIMEOUT_MS` / `KVALAH_DET_MEMORY_MB` | `1` / `20000` / `256` | Deterministic worker thread (`0` = in-process, debugging only), its timeout and heap limit |
| `KVALAH_PRICE_INPUT` / `KVALAH_PRICE_OUTPUT` | unset | USD per 1M tokens of **your** cloud model. Unset ⇒ USD fields are `null` ("unknown") |
| `KVALAH_PRICE_CACHED_INPUT` / `KVALAH_PRICE_REASONING` / `KVALAH_PRICE_LOCAL` / `KVALAH_PRICE_KWH` | unset / unset / `0` / unset | Optional price components |
| `KVALAH_BASELINE` | `selective` | Savings baseline: `selective` (agent greps and reads parts) or `full` (upper bound) |
| `KVALAH_ROUTER_MIN_TOKENS` / `KVALAH_ROUTER_MIN_SAVINGS_USD` | `2000` / `0` | Router: smaller inputs go to Level 3 / minimum predicted saving |
| `KVALAH_MCP_PAYLOAD` / `KVALAH_MCP_MAX_CHARS` | `both` / `60000` | `both`, `structured` or `text`; result size cap (truncation is flagged) |
| `KVALAH_LAN` / `KVALAH_DATA_DIR` | off / kvalah desktop data dir | Use paired LAN devices from `devices.json` |
| `KVALAH_LAN_ALLOW` | empty | Required with LAN: node ids/names allowed to receive source code |
| `KVALAH_LAN_ALLOW_PLAINTEXT` | off | `1` allows plain http to allow-listed private peers |
| `KVALAH_DASHBOARD` / `KVALAH_DASHBOARD_PORT` / `KVALAH_DASHBOARD_SHOW_PATHS` | off / random / off | Loopback dashboard (URL with token printed to stderr only); show task paths |
| `KVALAH_SERVICE` | `auto` | `auto` (connect, or win the election and host the shared service), `connect` (v0.3 auto: connect if running, else in-process), `required` (connect only, fail closed) or `off` |
| `KVALAH_SERVICE_SOCKET` / `KVALAH_SERVICE_TOKEN_FILE` | data dir | Override IPC endpoint and token file |
| `KVALAH_SERVICE_MAX_ACTIVE` / `KVALAH_SERVICE_MAX_QUEUE` / `KVALAH_SERVICE_MAX_QUEUE_PER_CLIENT` | maxParallel + LAN capacity / `64` / `16` | Service concurrency and backpressure |
| `KVALAH_HOME` / `KVALAH_STANDALONE` | auto / off | Overlay location / force standalone |
| `KVALAH_BENCH_RESULTS` | unset | JSON from `bench/paired.mjs analyze --json`; only a **measured** analysis fills `metrics.measured` (otherwise `available:false`) |
| `KVALAH_SCHED_PERF` | on | `0` → v0.3 device scoring (last-job wall time); default compares devices by measured tok/s and TTFT |
| `KVALAH_SCHED_REF_PROMPT` / `KVALAH_SCHED_REF_OUTPUT` | 1000 / 200 | reference job (prompt/output tokens) used to compare device speed |
| `KVALAH_SERVICE_AGING_MS` | min(30000, queue timeout/2) | background jobs waiting this long are served before interactive ones (no starvation) |
| `KVALAH_SKILL_FILE` | `skill/SKILL.md` | Skill file counted as session overhead in estimated savings |

## Tools
- `kvalah_status`: health, effective context, features, limits, prices, LAN nodes (no tokens), dashboard address.
- `kvalah_compute {op, …}`: Level 1 operations; check `precision`, `complete`, `truncated`.
- `kvalah_delegate {kind, instruction, paths|context, query?, strategy?, tailBytes?}` returns `summary`, `draft`, `findings[{text, quote, path, line, quoteVerified, pathMismatch?, ambiguous?}]`, `coverage{sourceCoverage, selectedCoverage, skipped, tokenCount}`, `checks{quoteVerifiedFindings, warnings, outputAssessment:"unassessed"}`, `secretsRedacted`, `cost` (estimated), `cached`.
- `kvalah_batch {tasks[≤4]}`, `kvalah_auto {goal, paths?, context?, query?, kind?, prefer?, contextAlreadyLoaded?, alreadyRead?}` (returns `route.expected`: estimated failure rate, verification and MCP overhead), `kvalah_metrics` (outcomes, queue/exec time, MCP payload sizes, estimated savings, service metrics when connected).

`quoteVerified:true` means the quote occurs verbatim in that file at the reported lines. It does not mean the finding is correct.

## Benchmarks
```bash
npm run bench                          # mock, single-call estimate (bench/RESULTS-mock.md)
node bench/paired.mjs mock             # 54 paired scenarios through the real pipeline, mock model (bench/RESULTS-mock-paired.md)
node bench/paired.mjs plan --reps 3    # schedule for real paired agent runs
node bench/paired.mjs analyze --records runs.jsonl --price-in 3 --price-out 15
```
Mock runs check the pipeline; their cloud figures are heuristic estimates. Only paired runs with usage reported by the agent/API count as measured; the procedure and gates are in `bench/RESULTS-real.md`. No real runs have been made for v0.4; `analyze` returns `verdict` (PASS only with ≥50 complete pairs under identical conditions).

## Security and privacy (summary)
Read-only access inside `KVALAH_WORKSPACE` with descriptor-checked opening; secrets redacted or blocked before any model, cache, log or dashboard; local model output treated as untrusted data; LAN off by default and allow-listed; dashboard loopback-only with token, Host and Origin checks; service IPC authenticated and workspace-bound. Regex secret detection reduces but does not remove risk. Details and residual risks: [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Tests
`npm test` runs the whole suite (unit, integration, MCP over the official SDK client in-memory and stdio, service IPC). `npm run check` syntax-checks every `.mjs`. CI matrix: Linux, macOS, Windows × Node 22.18 / 22.x / 24.11 / 24.x.

License: MIT.
