# Kvalah Offload: advanced rules

## Limits you must respect
- **Workspace.** Files are readable only inside `KVALAH_WORKSPACE`, read-only. `.git`, `.env*`, `.ssh`, keys and credential-like names are refused (case-insensitive). Symlinks and hard links out of the workspace are refused. The root cannot be changed from tool arguments.
- **Sizes.** Up to 32 paths per task, 2 MB per file and 8 MB per task by default. For bigger logs use `tailBytes`; a tail is not the whole file (`sourceCoverage` stays below 1).
- **Context.** Budgets cover the whole prompt (system, instruction, wrappers, schema, output reserve). With llama.cpp the token count is exact; with Ollama it is an **estimated** count with a safety margin (`coverage.tokenCount: "estimated"`). If the instruction alone does not fit, Kvalah refuses instead of truncating.
- **Map-reduce / retrieval.** Large inputs are split. Retrieval reads only the best-matching chunks: check `coverage.skipped` and `notice`. Map-reduce over more than `KVALAH_MAX_CHUNKS` chunks needs a `query`.
- **Deterministic ops** run in a worker thread with a time limit (`KVALAH_DET_TIMEOUT_MS`). `references` is textual, not type-resolved. `deps.complete: false` lists why (dynamic imports, aliases, unresolved paths, parse problems).

## Security and privacy
- Secrets are redacted (or the task is blocked with `KVALAH_SECRET_POLICY=block`) before anything reaches a model, the cache, logs or the dashboard. Answers may miss redacted values on purpose.
- Results of tasks that contained secrets are kept in memory only unless `KVALAH_CACHE_SENSITIVE=1`.
- **LAN** is off by default. With `KVALAH_LAN=1` only nodes listed in `KVALAH_LAN_ALLOW` receive source code, only on private addresses, over verified https (or plaintext with explicit `KVALAH_LAN_ALLOW_PLAINTEXT=1`), without redirects. Cloud-backed models (`:cloud`) are refused unless `KVALAH_ALLOW_CLOUD_MODELS=1`.

## Quote verification
`quoteVerified` is true only if every quote line occurs, in order, in the claimed file. A quote found in another file gives `pathMismatch: true` and `foundIn`. Several matches give `ambiguous: true` with `candidates`. This is not evidence of correctness: `checks.outputAssessment` is always `"unassessed"`.

## Routing details (`kvalah_auto`)
Level 3 is returned for: security decisions (even with `prefer: "local"`), `contextAlreadyLoaded: true` or all `paths` in `alreadyRead`, a non-positive expected saving (`route.expected`: historic failure rate × baseline, verification tokens, MCP tool-description overhead; all estimated), inputs under `KVALAH_ROUTER_MIN_TOKENS` (default 2000), predicted negative token savings, low local quality for this kind and model, an overloaded queue, a long ETA without `query`, or an offline model. Level 1 needs an unambiguous structural question with the parameters it needs.

## Compute service
All agents on a machine share one queue (`KVALAH_SERVICE=auto` elects one host process; `required` = connect only, fails with `ServiceUnavailableError`; `off` = in-process). Background clients are not starved (aging).

## Failure handling
`QueueTimeoutError`, `ExecTimeoutError`, `DeadlineError`, `ContextOverflowError`, `OverloadError`, "Queue full", "maxTokens": at most one retry with a narrower task, then do it yourself. Cancelling a tool call cancels the local work.

## Metrics
`kvalah_metrics` reports `outcomes` (accepted, declined, failed, cancelled, warm, cold), queue and execution time, MCP payload sizes (`mcp.duplicatedChars` when the same JSON is sent as text and structuredContent) and **estimated** savings against a selective-reading baseline. Measured savings need paired real runs (see the package README); none are published for this release.
