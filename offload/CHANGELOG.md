# Changelog

## 0.4.0 — 2026-11-24 (security, shared compute, honest economics; not published)
Each item has a regression test `test/v04-*.test.mjs`, logs in `docs/logs/v04-*`; evidence and remaining risks in `docs/V04-REPORT.md`.
### P0
- SEC-01: secret filter is cycle-safe and never returns raw data past the depth limit; applied to MCP, IPC results/errors, cache, dashboard state and logs.
- SEC-02: one network policy (`compute/netpolicy.mjs`): no redirects for any model request (Ollama, OpenAI-compatible, llama.cpp tokenizer, discovery); overlay mode now also uses the guarded providers.
### P1
- SEC-03: LAN connections pinned to the checked IP (no second DNS resolution). SEC-04: config/diagnostic errors and logs filtered (no regex patterns, URL credentials or tokens).
- IPC-01: Zod schemas for every IPC message; malformed input → `ProtocolError`/close, never a crash. IPC-02: limits for connections, in-flight per client, subscribers per job, total pending.
- COMPUTE-01: host election — N MCP clients share one engine, re-election after a crash, config fingerprint. COMPUTE-02: `lease`/`release` + `device` scope; Kvalah desktop patch (`docs/kvalah-integration.patch`). COMPUTE-03: end-to-end cancel verified (test only, no defect).
- BENCH-01..06: verdicts with completeness and condition checks (≥50 complete pairs for PASS), per-provider usage adapters, failed attempts/retries/fallback/verification billed, Skill + MCP overhead, estimated vs measured separated (`KVALAH_BENCH_RESULTS`).
- MCP-01: per-client channel behaviour documented with sources (`docs/mcp-clients.md`); `mcp.client`, `modelChannel`, `modelDuplicatedChars` in metrics.
### P2
- CACHE-01: cross-process atomicity verified (no defect). CACHE-02: cross-process disk quota (lock + shared ledger). CACHE-03: sha256 integrity per entry.
- SCHED-01: devices compared by measured tok/s/TTFT (`metrics.devicePerf`; `KVALAH_SCHED_PERF=0` = old scoring). SCHED-02: aging for background jobs (`KVALAH_SERVICE_AGING_MS`).
- ROUTE-01/02: expected-value routing (failure rate, verification cost, `alreadyRead`, MCP overhead) with `route.expected`.
- UI-01/02/03: dashboard shows agents, queue, device load/speed, errors and cancelled operations; estimated vs measured; Kvalah Compute tab in the patch.
- SKILL-01..09: Skill synced with the API, 2.1 KB, decline/unavailability rules, install for Codex/Claude Code/Cursor, Node = `engines`, Agensi packaging rules checked.
- Hygiene: data dir never relative (a runtime token had been written into the repo by a test); `.config/`, `*.token`, `*.sock` ignored.
- QA: service load/backpressure, Ollama disconnect recovery, end-to-end secret sweep.
### Contract changes
- `KVALAH_SERVICE=auto` now elects a host (old behaviour: `connect`). New service methods `lease`/`release`, hello `scope`, welcome `fingerprint`, new limits → `ServiceOverloadError`/`ProtocolError`.
- Overlay mode uses the guarded lite providers. Regex/URL details removed from error messages. Dashboard/IPC output filtered.
- Bench records need `config` and `snapshot`; `analyze` returns `verdict`; failed runs count in cost. Cache entries carry a checksum (0.3 entries miss once).
- New fields: `metrics.measured`, `savings.overhead`, `metrics.devicePerf`, `route.expected`, `state.agents/errors`; new optional `kvalah_auto.alreadyRead`. The router may now decline marginal tasks it delegated in 0.3.

## 0.3.0 — 2026-11-24 (stabilization; not published)
Each item has a regression test `test/v03-*.test.mjs`; details and evidence in `docs/V03-REPORT.md`.
### Security
- SEC-01: one secret policy for inputs, instruction/query, outputs, cache, logs, dashboard and errors; unquoted `KEY=value`, bearer and basic-auth detection; `KVALAH_SECRET_DENY/ALLOW`.
- SEC-02: case-insensitive deny rules, Windows path checks, lexical check before open, bounded reads with change detection, file-count and scan limits.
- SEC-03: LAN requires `KVALAH_LAN_ALLOW`, private addresses (checked per request), verified https or explicit plaintext opt-in, no redirects; cloud models refused unless `KVALAH_ALLOW_CLOUD_MODELS=1`.
- SEC-04: quote verification per file and line range (`quoteVerified`, `pathMismatch`, `ambiguous`, `partial`), role-tag and command warnings, typed and size-limited output fields.
### Correctness and resources
- CTX-01: budgets include all prompt overhead; refusal instead of truncation; exact-overflow re-planning; bounded map concurrency.
- CTX-02: coverage from merged character ranges (`sourceCoverage`, `selectedCoverage`, `skipped`), line-aligned tails with offsets.
- CPU-01: deterministic ops in a worker thread with timeout, heap limit and terminate-on-cancel; skipped-file reporting; `deps.complete`.
- RUN-01: queue timer re-armed on retry, request deadline, pending-call limit, cancel at every stage, no joining of aborted shared jobs.
- RUN-02: shared Compute Service over authenticated local IPC (fair queues, priority, backpressure, dedupe, cancel, graceful shutdown); MCP uses it with failover (`KVALAH_SERVICE`).
### Cache, routing, economics, MCP
- CACHE-01: versioned key (workspace, policy, model digest, node capability), atomic writes, strict quota, LRU, 0600, per-workspace clear, memory-only sensitive results.
- ROUTE-01: net-token decisions, security → Level 3 first, `contextAlreadyLoaded` (also over Level 1, found by QA-02), overload and minimum-size gates, kind@model stats.
- MET-01: no default prices (USD `null` when unknown), selective baseline, outcomes, per-session crediting, failures in the ledger, `pairedSavings`.
- MCP-01: payload modes and size cap, compact descriptions, stack-free errors.
### UI, skill, QA, docs
- UI-01: dashboard cancel and cache clear (token + Origin checks), queue/limits/coverage/errors, estimated vs measured; token not shown in `kvalah_status`.
- SKILL-01: Skill Lite (`SKILL.md` + `references/ADVANCED.md`), unsupported claims removed.
- QA-01: `engines` `^22.18.0 || >=24.11.0`, CI matrix, syntax-check script. QA-02: 54 paired scenarios, paired harness and gates, mock paired run (no real results).
- DOC-01: README, `docs/INSTALL.md` (install/update/uninstall/rollback/troubleshooting), `docs/THREAT-MODEL.md`.
### Compatibility
- Same 6 MCP tools and SDK; standalone and overlay modes kept. Behaviour changes: prices default to unknown; LAN needs an allow-list; cloud models need opt-in; cache entries from 0.2 miss.

## 0.2.0 — 2026-11-24
### Added
- Smart Context Engine (`compute/context-engine.mjs`, `tokens.mjs`, `chunk.mjs`, `bm25.mjs`): calibrated token counting, exact llama.cpp tokenization, automatic context-window detection, map-reduce and BM25 retrieval, a `coverage` field on every result. Silent truncation is gone.
- Deterministic Executor (`compute/deterministic/`): search, symbols, references, outline (Babel AST for JS/TS, regex for Python/Go/Rust/JVM), dependency graph with cycles, hash, stats, todo. New `kvalah_compute` tool.
- Cost analytics (`compute/cost.mjs`): configurable prices, per-task `cost`, session ledger. Reproducible benchmark (`bench/`).
- Security: fd-based TOCTOU-safe file opening (O_NOFOLLOW, /proc/self/fd, dev/ino), rejection of symlinks, hardlinks and FIFOs, a content secret scanner with redact/block policy, structured JSON output with quotes verified against the source and resolved to `file:line`, injection warnings, separate queue and execution timeouts, per-subscriber cancellation of de-duplicated requests.
- Adaptive Router and `kvalah_auto` tool (Level 1/2/3 with reasons; learns from persisted per-kind stats).
- LAN cluster via kvalah's `devices.json` and node registry (`KVALAH_LAN=1`).
- Compute Dashboard (`KVALAH_DASHBOARD=1`): loopback, token, Host check, CSP.
- Persistent file cache (TTL, size cap) and persisted router stats.
- Standalone npm package (`kvalah-offload` bin) with vendored kvalah scheduler/registry and lite providers. Overlay mode uses kvalah's own modules.
### Changed
- Migrated to the official `@modelcontextprotocol/sdk` (stdio). Input schemas are strict.
- Per-file input limit raised to 2 MB (8 MB total), with chunking instead of truncation.
- Tool results now include `structuredContent`.

## 0.1.1 — review fixes
- Execution timeout starts when a job starts. `think:false`. Cache key includes model and options. In-flight de-duplication. Cancellation. Root-scoped `paths`. `status` no longer throws when offline. Richer tool descriptions.

## 0.1.0
- First MVP: hand-written stdio MCP server, `kvalah_status|delegate|batch|metrics`, in-memory cache.
