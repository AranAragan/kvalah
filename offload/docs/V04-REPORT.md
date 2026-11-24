# Kvalah Offload v0.4 — fix report

Branch `fix/offload-v04` (from `fix/offload-v03`), local only — **not pushed, not published**. Date: 2026-11-24.
Method per ID: regression test written first and run on v0.3 (`docs/logs/v04-repro-<ID>.log`), minimal fix (`v04-fixed-<ID>.log`), full suite (`v04-npm-test-after-<ID>.log`).
Tests: v0.3 had 127; v0.4 has **191, all passing** (`docs/logs/v04-npm-test-final.log`). No test disabled. New dependencies: none.
Environment: Linux x64, Node 24.22.1, no GPU, no display, one machine. "Mock" below = real HTTP/IPC servers that imitate Ollama or a peer, never a stub in place of the code under test.

## Results per ID

| ID | Verified on v0.3 | Status | Test | Evidence | Remaining risk |
|---|---|---|---|---|---|
| SEC-01 | Defect: data nested past the depth limit returned raw (leak at depth 12); IPC/dashboard unfiltered | Fixed | v04-sec01-deep-leak | repro 4 fail → 5 pass | Regex detection can miss unknown secret formats |
| SEC-02 | Defect: overlay providers followed redirects (`/api/show,/api/tags,/api/ps,/api/chat`) | Fixed (unified netpolicy) | v04-sec02-redirects | repro 3 fail | — |
| SEC-03 | Defect: rebinding resolver (private, then public) redirected the LAN connection | Fixed (IP pinning) | v04-sec03-rebinding | repro 1 fail | TLS/SNI with real peers not tested |
| SEC-04 | Defect: tool results/config errors echoed secrets/patterns | Fixed | v04-sec04-config-errors | repro 4 fail | — |
| IPC-01 | Defect: malformed messages crashed handlers (`Cannot read properties of null`) | Fixed (Zod) | v04-ipc01-fuzz (600 malformed msgs) | repro 3 fail | — |
| IPC-02 | Defect: no limits on connections/in-flight/subscribers/pending | Fixed | v04-ipc02-limits | repro 3 fail | Limits are defaults, not tuned on real load |
| COMPUTE-01 | Defect: 3 MCP servers → 3 engines, model concurrency 3 with MAX_PARALLEL 1 | Fixed (host election) | v04-compute01-election (3 real stdio processes, SIGKILL host → re-elect) | repro peak 3 → 1 | Clients with another workspace/config fall back to their own engine (by design, reported) |
| COMPUTE-02 | Gap: Kvalah app had no shared queue | Fixed: service `lease`/`release` + `docs/kvalah-integration.patch` | v04-compute02-shared-queue; kvalah compute-link.test (6) | kvalah `npm run check` 55/55, `npm test` 99/99, cross-repo check script passed; patch applies to kvalah main | **Electron window not run** (no display) |
| COMPUTE-03 | Risk: **did not reproduce** — cancel already stopped generation on v0.3 (engine, service running/queued/dedupe, batch, LAN peer, MCP stdio) | Verified, test-only | v04-compute03-cancel | 5/5 pass on v0.3 worktree | Real GPU memory release: NOT RUN |
| BENCH-01 | Defect: incomplete pairs passed the gates | Fixed (verdict INCOMPLETE, ≥50 complete pairs for PASS) | v04-bench | probe log v04-probe-BENCH-v03.log | — |
| BENCH-02 | Defect: mixed models/agents/configs passed | Fixed (verdict INVALID) | v04-bench | repro fail | — |
| BENCH-03 | Defect: cached tokens billed twice (0.342 USD vs correct 0.072) | Fixed (usage adapters OpenAI/Anthropic/Gemini) | v04-bench | probe log | Adapters follow provider docs (docs/notes/v04-sources.md), not real invoices |
| BENCH-04 | Defect: failed attempts dropped from cost | Fixed | v04-bench | repro fail | — |
| BENCH-05 | Gap: Skill/MCP overhead not counted | Fixed (`savings.overhead`, net after overhead) | v04-bench | repro fail | Overhead tokens are heuristic counts |
| BENCH-06 | Gap: no measured field | Fixed (`metrics.measured` only from measured analysis) | v04-bench | repro fail | — |
| MCP-01 | Risk: duplicate payload per client | Documented per client with sources; default `both` kept; metrics report the channel | v04-mcp01-clients | docs/mcp-clients.md | Not checked with live clients (NOT RUN) |
| CACHE-01 | Risk: **did not reproduce** — 4 (test) and 8 (stress) processes: 0 torn reads, 0 temp files | Verified, test-only | v04-cache | v04-repro-CACHE-01.log | — |
| CACHE-02 | Defect: 4 processes → 231,800 B on a 60,000 B quota | Fixed (lock + shared ledger) | v04-cache | repro fail | Lock timeout (3 s) degrades to unlocked write (counted) |
| CACHE-03 | Defect: modified entries accepted | Fixed (sha256 per entry) | v04-cache | repro fail | — |
| SCHED-01 | Defect: big job sent to the 10× slower device (scored by last job's wall time) | Fixed (measured tok/s + TTFT; `metrics.devicePerf`) | v04-sched01-perf | repro fail | Free VRAM only when reported (kvalah peer `rpc.devices`); Ollama has no free-VRAM API |
| SCHED-02 | Defect: background job hit QueueTimeoutError (1.5 s) under sustained interactive load | Fixed (aging) | v04-sched02-aging | repro fail | — |
| ROUTE-01 | Gap: failure rate/verification/already-read not in the decision (marginal task delegated at 45 % failure) | Fixed (expected value, `alreadyRead`, `route.expected`) | v04-route-econ | repro 3 fail | Heuristic weights (prior 0.1, verification 5 % + 50 % × unverified) not calibrated on real runs |
| ROUTE-02 | Gap: MCP overhead ignored | Fixed (overhead > expected saving → L3) | v04-route-econ | repro fail | Same |
| UI-01 | Gap: no Compute view in Kvalah | Patch (Compute tab, `/api/compute`) | kvalah compute-link.test + check script | logs v04-kvalah-* | Electron UI not run; 8 of 10 locales carry English text |
| UI-02 | Gap: state had no agents/errors blocks | Fixed (agents, queue, load/speed, errors, cancelled) | v04-ui02-dashboard | repro fail | — |
| UI-03 | Estimated vs measured | Done (BENCH-06 + patch shows both and net after overhead) | v04-bench, v04-ui02-dashboard | — | — |
| SKILL-01..09 | Defects: tool `kvalah_status` not covered, no `alreadyRead`, Node "≥ 22.18" ≠ engines, v0.3 archive name, description 450 chars; SKILL-08: no unproven claims found (test added) | Fixed | v04-skill (6) | repro 4 fail | Agensi listing not submitted; live agent behaviour NOT RUN |
| Hygiene | Defect: `defaultDataDir` relative without HOME → a test wrote `.config/kvalah/data/service.token` into the repo | Fixed; file untracked and ignored | v04-hygiene-datadir | repro log | The 64-byte test token is in local commits 8c4faff…ac2761e (never pushed, history not rewritten); not in the archives |

SKILL-09 sources (checked 2026-11-24): https://www.agensi.io/docs/packaging, https://www.agensi.io/docs/review-and-approval, https://www.agensi.io/security, https://www.agensi.io/learn/skill-md-creator-checklist. The skill archive follows them: one top folder `kvalah-offload/` with SKILL.md (`name`, `description`), README, LICENSE, references/; text only, no scripts, no secrets, no symlinks.

## QA

| Check | Status | Evidence |
|---|---|---|
| 127 v0.3 tests | Kept; 3 updated with justification (RUN-02 failover → `KVALAH_SERVICE=connect`; QA-02 records carry config/snapshot; mcp.test uses a temp data dir) | CHANGELOG "Contract changes" |
| Regression tests for every defect | Done | table above |
| IPC fuzz | Done | v04-ipc01-fuzz |
| File-system security | Done (v0.3 suite + v04 hygiene) | v03 file tests |
| Secret leaks, all channels | Done, 0 leaks (MCP, IPC, cache, dashboard, logs, metrics; e2e sweep) | v04-sec01, v04-qa |
| Redirects / DNS rebinding | Done | v04-sec02, v04-sec03 |
| Service load | Done: 240 calls/12 clients all answered, capacity 2 never exceeded; 480-call burst → 256 ok, 224 shed with ServiceOverloadError | v04-qa-run.log |
| Several MCP clients at once | Done (3 real stdio processes) | v04-compute01 |
| Service crash recovery | Done (SIGKILL host → re-election) | v04-compute01, v03-run02 |
| Ollama disconnect recovery | Done (real HTTP mock stopped/restarted) | v04-qa |
| Cancel on a real GPU | **NOT RUN** — needs a machine with a GPU + Ollama/llama.cpp; check VRAM/utilization drop after cancel (nvidia-smi / rocm-smi) |  |
| Several local models | **NOT RUN** — needs ≥2 real models installed |  |
| Distributed (several PCs) | **NOT RUN** — needs ≥2 machines running Kvalah, paired, on one LAN (protocol tested with HTTP mocks only) |  |
| Windows / macOS | **NOT RUN** — needs those machines (CI matrix defined in .github/workflows/ci.yml, not executed here); Linux done |  |
| Real Codex / Claude Code / Cursor | **NOT RUN** — needs the installed clients with accounts |  |
| ≥50 real paired scenarios | **NOT RUN** — needs real agent runs with provider-reported usage; harness ready (`bench/paired.mjs plan/analyze`), verdict today: NOT_MEASURED |  |
| Quality/tokens/cost/time/retries comparison, reproducible report | **NOT RUN** (depends on the paired runs) |  |

## Readiness (v0.4 criteria)

| Criterion | Required | Status |
|---|---|---|
| Open P0 defects | 0 | **0** (met) |
| Open P1 defects | 0 | **0** (met; COMPUTE-02 GUI part delivered as a patch, Electron window not run) |
| Automated tests | 100 % | **191/191** (met) |
| Secret leaks in security tests | 0 | **0** (met) |
| Cloud cost saving | ≥30 % | **NOT MEASURED** |
| Quality vs baseline | ≥95 % | **NOT MEASURED** |
| Delegation success | ≥95 % | **NOT MEASURED** |
| Real comparison scenarios | ≥50 | **0** (harness and 54 scenarios ready) |
| OS | Windows, Linux, macOS | **Linux only** |
| Agents verified | Codex, Claude Code, Cursor | **none live** (configs per current docs) |
| Unified Compute Service | full integration | **partial**: agents share one service; Kvalah app integration as an applied-and-tested patch, not merged, UI not run |
| Skill for Agensi | ready to publish | **package ready, not submitted**; product claims must wait for measured data |

**Overall: INCOMPLETE.** The code-level gates (P0/P1, tests, leaks) are met; the economic and platform gates need real runs.

## Not done / where to look
- Kvalah patch is not merged into the kvalah repo; local worktree `/tmp/kvalah-int` and branch `compute-integration` in `/workspace/kvalah/repo` were used for testing (see cleanup note in the final message).
- Contract changes: CHANGELOG 0.4.0. Architecture: docs/ARCHITECTURE.md. Client behaviour: docs/mcp-clients.md. Sources: docs/notes/v04-sources.md.
