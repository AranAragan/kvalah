# Kvalah Offload v0.3: stabilization report

- Working copy: `/workspace/kvalah-offload-v03`, local git branch `fix/offload-v03` (base `main` = 0.2.0 baseline, commit `7f9bdd2`). **Nothing was pushed to GitHub or published to npm**, so there is no PR link.
- Environment: Linux x64, Node v24.22.1, npm 11, 2026-11-24 MSK. Mock providers only; no GPU, no Ollama, no real agents.
- Result: **127/127 tests pass** (v0.2 baseline: 46). 0 failed, 0 skipped on Linux. The `stale socket` test skips itself on Windows by design.
- Other checks: `npm ci` OK, syntax check 58/58 `.mjs` OK, `npm pack --dry-run` OK (45 files, 95.7 kB), `npm audit` 0 vulnerabilities (also with `--omit=dev`).
- Method: for each ID a regression test was written first and run against the code before the fix (`docs/logs/repro-<ID>.log`, failing). Then came the fix (`fixed-<ID>.log`, passing) and the full suite (`npm-test-after-<ID>.log`). One commit per ID.

## ID → status → test → evidence → remaining risk
| ID | Pri | Status | Test | Evidence (repro → fixed) | Remaining risk |
|---|---|---|---|---|---|
| SEC-01 | P0 | Done | `test/v03-sec01-policy.test.mjs` | repro 0/4 → 4/4 | Regex/entropy detection is incomplete by nature; unusual secret formats can pass |
| SEC-02 | P0 | Done | `v03-sec02-workspace` | 0/4 → 4/4 | Windows junction / O_NOFOLLOW-equivalent not checked on a real Windows host (CI configured, not run) |
| SEC-03 | P0 | Done | `v03-sec03-lan` | 0/4 → 4/4 | DNS rebinding window between the address check and connect; no real two-node LAN test |
| SEC-04 | P0 | Done | `v03-sec04-injection` | 0/4 → 4/4 | A verified quote does not make a finding correct; injection heuristics are not complete |
| CTX-01 | P1 | Done | `v03-ctx01-budget` | 0/4 → 4/4 | Ollama has no exact tokenizer (margin 1.2→1.1); peer context known only if the peer reports it |
| CTX-02 | P1 | Done | `v03-ctx02-coverage` | 0/4 → 4/4 | `lineOffset` is null for tails of files >64 MB (reported as `lineInTail`) |
| CPU-01 | P1 | Done | `v03-cpu01-deterministic` | 0/3 → 3/3 | Worker thread rather than RE2: catastrophic regexes are killed by timeout, not prevented |
| RUN-01 | P1 | Done | `v03-run01-cancel` | 2/6 → 7/7 | Whether the GPU stops on HTTP abort is unverified on a real Ollama/llama.cpp |
| RUN-02 | P1 | Done (package side) | `v03-run02-service` + `smoke-RUN-02-stdio.log` | 1/9 → 9/9 (the repro shows peak concurrency 2 with capacity 1) | Electron GUI wiring upstream not done (protocol documented); named-pipe ACL is the OS default; one/two-computer runs on real hardware not done |
| CACHE-01 | P1 | Done | `v03-cache01` | 0/5 → 5/5 | Multi-process tests are in-process concurrency plus atomic rename; not tested on network file systems |
| ROUTE-01 | P1 | Done | `v03-route01` (+ QA-02 case) | 1/4 → 4/4; QA-02 finding 4/5 → 5/5 | Routing thresholds are heuristics until real paired data exists |
| MET-01 | P1 | Done | `v03-met01-economics` | 0/4 → 4/4 | The selective baseline (1500 + 20 %) is a heuristic; measured savings need real runs |
| MCP-01 | P1 | Done | `v03-mcp01-contract` | 1/4 → 4/4 | Default stays `both` for client compatibility (duplication is measured); real client behaviour unverified |
| SKILL-01 | P1 | Done (text) | `v03-skill01` | 1/4 → 4/4 | Client configs not checked against real client versions; Agensi requirements not checked |
| QA-01 | P1 | Done locally | `v03-qa01-package` + `release-*.log` | 0/3 → 3/3 | The CI matrix (Win/macOS/Linux × Node 22.18/22/24.11/24) is written but has not run (no GitHub runner) |
| QA-02 | P1 | Harness done; real runs not done | `v03-qa02-bench` | 0/5 → 5/5; mock paired run of 54 scenarios: 0 errors, recall 1.0, 10/10 small or already-read tasks declined | **No measured results.** All gates (savings, quality, delegation, small tasks, clients) are not evaluated |
| UI-01 | P2 | Done (standalone dashboard) | `v03-ui01-dashboard` | 0/5 → 5/5 | A same-user local process can read the token; Kvalah GUI integration upstream not done |
| DOC-01 | P2/P3 | Done | `v03-doc01` | 0/3 → 3/3 | Docs describe unverified client configs as unverified |

## Gates (spec section 8)
| Gate | Status |
|---|---|
| Security: 0 leaks in the agreed tests, no open P0/P1 | Met in the test suite (SEC-01…04, CACHE-01, UI-01, RUN-02). The residual risks above are documented |
| Regression on the supported CI matrix | Linux/Node 24 only: 127/127. Windows/macOS/Node 22 not run |
| Savings ≥30 %, quality ≥95 %, delegation ≥95 %, small tasks ≤5 % | **Not evaluated**: no real paired runs. Harness and procedure ready (`bench/RESULTS-real.md`) |
| Cancel: no leftover jobs or slots; GPU stop verified | Counters return to 0 in tests (RUN-01, RUN-02, UI-01). GPU stop not verified |
| Clients: live smoke/E2E for Codex, Claude Code, Cursor | Not done. Only the official MCP SDK client over stdio and in-memory |
| Delivery: clean install, reproducible package, separate skill, docs | Met: `npm ci` from the lockfile, pack dry-run, separate skill zip, docs |

**Release recommendation:** the package-level work is done. Do not publish or announce savings before the real paired runs and the CI matrix pass.

## Design decisions
- CPU-01: a persistent worker thread with `resourceLimits` and terminate-on-cancel, instead of a native RE2 dependency.
- SEC-03: LAN always goes through the guarded lite providers (allow-list, private IP + DNS check, https verify, no redirects), in both standalone and overlay mode.
- MCP-01: `KVALAH_MCP_PAYLOAD=both` stays the default for compatibility; the duplicated characters are counted in `kvalah_metrics.mcp`.
- MET-01: no default prices (USD is `null` = unknown). The baseline is selective by default; set `KVALAH_BASELINE=full` for the upper bound.
- RUN-02: one engine per workspace behind local IPC. The MCP server adapts to it (`auto|required|off`) and falls back to in-process in `auto`. Standalone mode is unchanged. No TCP or HTTP is opened, and VRAM of independent nodes is not summed.
- UI-01: the dashboard token is no longer returned by `kvalah_status` (it is printed to stderr only). Mutations need a header token, the same Origin and JSON.

## Commits (`git log main..fix/offload-v03`)
| Commit | ID | Files (without logs) |
|---|---|---|
| bcadf17 | SEC-01 | compute/policy.mjs (new), secrets.mjs, offload.mjs, index.mjs, mcp/server.mjs, test/stage4-security, test/v03-sec01-policy |
| aa53c2b | SEC-02 | compute/files.mjs, deterministic/walk.mjs, test/v03-sec02-workspace |
| 2b7818c | SEC-03 | compute/lan.mjs, providers-lite.mjs, index.mjs, test/stage5-router-lan-dashboard, test/v03-sec03-lan |
| 2b57730 | SEC-04 | compute/checks.mjs, context-engine.mjs, offload.mjs, test/v03-sec04-injection |
| ec7c91f | CTX-01 | compute/context-engine.mjs, tokens.mjs, chunk.mjs, offload.mjs, index.mjs, lan.mjs, test/stage1-context, test/v03-ctx01-budget |
| 2c78734 | CTX-02 | compute/context-engine.mjs, chunk.mjs, files.mjs, checks.mjs, test/stage4-security, test/v03-ctx02-coverage |
| b1404df | CPU-01 | compute/deterministic/pool.mjs (new), worker.mjs (new), index.mjs, ast.mjs, compute/index.mjs, test/v03-cpu01-deterministic |
| f3f894b | RUN-01 | compute/offload.mjs, context-engine.mjs, router.mjs, index.mjs, test/v03-run01-cancel |
| efd6628 | CACHE-01 | compute/cache.mjs, stats.mjs, offload.mjs, tokens.mjs, index.mjs, test/v03-cache01 |
| 77c44c9 | ROUTE-01 | compute/router.mjs, offload.mjs, index.mjs, mcp/server.mjs, test/stage5-…, test/v03-route01 |
| 1b3f9f7 | MET-01 | compute/cost.mjs, offload.mjs, dashboard.mjs, index.mjs, bench/run.mjs, test/stage3-bench-cost, test/v03-met01-economics |
| 6d16eaa | MCP-01 | mcp/server.mjs, test/v03-mcp01-contract |
| cf9cda1 | SKILL-01 | skill/SKILL.md, skill/README.md, skill/references/ADVANCED.md (new), test/v03-skill01 |
| 6dc1bb4 | QA-01 | package.json, package-lock.json, .github/workflows/ci.yml (new), scripts/check-syntax.mjs (new), test/v03-qa01-package, test/v03-sec02-workspace (Windows portability) |
| 2e4ed69 | RUN-02 | compute/service.mjs (new), mcp/server.mjs, package.json (bin `kvalah-offload-service`), test/v03-run02-service |
| f9b4125 | UI-01 | compute/dashboard.mjs, index.mjs, offload.mjs, service.mjs, test/stage5-…, test/v03-ui01-dashboard |
| 2ddc198 | QA-02 | bench/scenarios.mjs (new), paired.mjs (new), RESULTS-real.md (new), RESULTS-mock-paired.md (new), RESULTS-mock.md, run.mjs, compute/router.mjs (contextAlreadyLoaded over L1), test/v03-qa02-bench, test/v03-route01 |
| 86f806a | DOC-01 | README.md, CHANGELOG.md, docs/INSTALL.md (new), docs/THREAT-MODEL.md (new), package.json / lock (0.3.0), compute/index.mjs (VERSION), test/v03-doc01 |
| (this report) | report | docs/V03-REPORT.md |

## Logs (`docs/logs/`)
- `npm-ci-baseline.log`: install on the 0.2 baseline.
- `repro-<ID>.log` / `fixed-<ID>.log` / `npm-test-after-<ID>.log`: one set per item. `repro-QA-02-route-finding.log` is the router defect the benchmark found.
- `smoke-RUN-02-stdio.log`: real processes (service CLI + MCP stdio + SDK client), socket/token permissions and cleanup.
- `qa01-*.log`, `release-npm-ci.log`, `release-syntax-check.log`, `release-npm-test.log` (127/127), `release-npm-pack-dry-run.log`, `release-npm-audit.log`.
- `qa02-mock-paired.json` (raw mock paired run) and `qa02-plan-reps3.json` (324-run schedule for real agents).
- Failed or skipped results are not hidden: every repro log keeps its failures.

## Unavailable checks and what each needs
| Check | Needs |
|---|---|
| Real Ollama `qwen3.5:9b` (actual installed digest, reasoning off, output limit), GPU stop on cancel, RTX 2070 8 GB profile, CPU-only profile | A machine with Ollama and the model, and a GPU. Run the RUN-01 cancel scenario and watch `ollama ps` / `nvidia-smi`. Run `node bench/run.mjs --provider ollama` |
| llama.cpp backend (exact `/tokenize`, `/props` context) | `llama-server` running locally; `KVALAH_PROVIDER=openai` |
| Real paired benchmarks (≥50 scenarios, Codex / Claude Code / Cursor, usage from the agent or API) and the economics/quality gates | Accounts and agents, 2–3 repetitions per `qa02-plan-reps3.json`, usage export. Then `node bench/paired.mjs analyze` (procedure in `bench/RESULTS-real.md`) |
| Live smoke/E2E in Codex, Claude Code, Cursor (config formats in the README and skill) | The installed clients. Confirm each client loads the server and calls the tools |
| Windows and macOS, Node 22.18 / 22.x / 24.11 | Run `.github/workflows/ci.yml` (needs pushing to GitHub with Actions enabled, which was not allowed) or run locally on those OSes |
| LAN with two real nodes (https certs, disconnect, load), service on one and on two computers | Two machines with kvalah paired, `KVALAH_LAN_ALLOW`, certificates |
| Kvalah desktop GUI connected to the Compute Service | Upstream Electron change (client = `connectService` in `compute/service.mjs`, `priority:'interactive'`) |
| GitHub permissions / branch protection / PR | Repository access. Push and PR were explicitly not allowed |
| Agensi listing requirements, licence and product description | The current Agensi rules. Check before publishing (see `skill/README.md`) |

## Deliverables
- `/workspace/kvalah-offload-v0.3.zip`: package for standalone and overlay use (source, tests, docs, logs, `package-lock.json`, `.github`). No `node_modules` and no `.git`.
- `/workspace/kvalah-offload-v0.3-skill.zip`: `SKILL.md`, `references/ADVANCED.md`, `README.md`, `LICENSE` (text only).
- Install, update, uninstall, rollback and troubleshooting: `docs/INSTALL.md`.
- Short rollback: stop agents and the service, put the 0.2 folder back (or unzip v0.2 and run `npm ci --omit=dev`), clear the cache dir, restore the 0.2 skill. In git: `git checkout main`.
