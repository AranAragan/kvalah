# Kvalah Compute Offload — architecture (v0.4)

```
 Codex / Claude Code / Cursor          Kvalah desktop (Electron)
        │ MCP stdio                          │ compute-link.mjs (patch)
        ▼                                    ▼
 mcp/server.mjs ──(KVALAH_SERVICE)──► Compute Service (compute/service.mjs)
   tools: status, compute,             NDJSON over Unix socket / named pipe, token + workspace binding,
   delegate, batch, auto, metrics      Zod-validated (ipc-schema.mjs), limits, fair RR queues per client,
                                        interactive > background with aging, dedupe, cancel, leases (device scope)
                                              │
                                              ▼
                                  createKvalahOffload (compute/index.mjs)
     router.mjs (L1/L2/L3, expected value) · offload.mjs (engine, budgets, map-reduce, ledger)
     deterministic/ (worker thread) · cache.mjs (atomic, quota lock+ledger, sha256) · policy.mjs (secrets)
     perf.mjs + kvalah scheduler/registry (vendored or overlay) · lan.mjs (allow-list, pinned IP)
     providers-lite.mjs + netpolicy.mjs (no redirects, loopback/LAN pinning) · dashboard.mjs (loopback, token, Origin)
                                              │
                                   Ollama / llama.cpp / LM Studio (local) · allow-listed LAN kvalah peers
```

## One engine per machine (COMPUTE-01/02)
- `KVALAH_SERVICE=auto`: an MCP server connects to a running service; if none answers it takes `<socket>.lock` (O_EXCL, pid, stale locks broken atomically), re-checks, and hosts the service in-process (sockets unref'd so the host exits with its client). Others connect; when the host dies, a survivor re-elects. A different config fingerprint is refused (`ServiceMismatchError`).
- The Kvalah app connects with `scope:'device'` and wraps its own local generations in `lease`/`release`, so its chat and the agents' jobs share the llm slots. Leases end on release, disconnect, TTL or shutdown.

## Scheduling (SCHED-01/02)
- Service queue: per lane (llm/cpu), round-robin over clients, interactive before background, but a background job waiting ≥ `agingMs` is served first.
- Device choice inside the engine: kvalah's scheduler (unchanged) scores `(inflight+1)/capacity × ms`; `perfScheduler` feeds `ms` = expected time of a reference job from measured tok/s and TTFT per device (falls back to the old value until measured).

## Routing and economics (ROUTE, BENCH)
- `kvalah_auto`: L1 deterministic when exact; L3 for security, already-read input, small input, offline/overloaded, low quality, or non-positive expected saving `(1−pFail)×baseline − (args+result+verification)` and after MCP tool-description overhead. All numbers are estimates (`route.expected.estimated: true`).
- Measured economics only from `bench/paired.mjs analyze` (normalized usage per provider, all attempts billed, verdict with completeness/condition checks); `KVALAH_BENCH_RESULTS` exposes a measured analysis as `metrics.measured`.

## Output safety
Every channel goes through `policy.output/text/error`: MCP results, IPC results/errors, cache writes, dashboard state, logs. Model output is data, never instructions (`checks.warnings`).

## Files and runtime data
Runtime data (service socket, token, lock, cache) lives in the data dir (`KVALAH_DATA_DIR`, else the Kvalah desktop data dir; always absolute). Nothing runtime is written to the package directory.
