# Requirements traceability — Kvalah Compute v0.2

Legend: **DONE** implemented and covered by an automated CPU test on the build box · **DONE (HW NOT RUN)**
implemented, needs the physical GPU/Mac check in HW-TEST.md · **PARTIAL** · **NOT DONE** (with reason).
Priority from the spec (P0 = release blocker for the LAN release).

## Core (spec §3, §6–§9)
| Req | Pri | Status | Where / evidence |
|---|---|---|---|
| Separate compute process, app unaffected when off | P0 | DONE | `compute/host.mjs`, `host-client.mjs`; test `compute2-app` (state `{feature_enabled:false}`, 409 when off) |
| Feature flag OFF by default | P0 | DONE | `settings.computeV2`; test `compute2-app` |
| FFA-LoRA math: canonical A, B-only absolute updates, FP64 FedAvg by token weights, sorted order | P0 | DONE | `protocol/canonical.mjs`, `aggregate.mjs`; `compute2-protocol` (pinned digests) |
| M01 v0.1 bit-exact reproduction 41:38:38 | P0 | DONE | `legacy.mjs`; `compute2-protocol`, `compute2-cli` (needs `KVALAH_V01_ZIP`) |
| M02 52 B keys, exact schema, A digest | P0 | DONE | `schema.mjs`; production frozen-A digest pinned in tests |
| M03/M04 Torch↔MLX math parity | P0 | DONE on CPU (tiny Mistral + tiny Mistral3: logits Δ 1.8e-7, step Δ 7.5e-9) · **real CUDA/Metal NOT RUN** | `python/tests/check_backends.py` via `compute2-python` |
| M05 malformed tensors/headers/NaN/oversize | P0 | DONE | `safetensors.mjs`, `compute2-protocol`, `compute2-coordinator` |
| M06 mixed model / stale adapter | P0 | DONE | files digest at claim, frozen-A + base hash checks |
| M07/M08 weighting, zero-token tasks invalid | P0 | DONE | coordinator token recount, `NO_TARGET_TOKENS` |
| D01–D04 central SFT tokenization, assistant-only mask, split leakage, invalid JSONL | P0 | DONE | `datasets/engine.mjs`, `sft.py`, `tokenize_rows.py`; `compute2-coordinator` D01–D04; real Ministral tokenizer checked (34 rows, 757 targets) |
| Identity per installation, Ed25519, signed requests, nonces, skew | P0 | DONE | `worker/identity.mjs`, `protocol/sign.mjs`, `coordinator/api.mjs`; N01/N02/N10 |
| Pinned TLS, one-time pairing, admin approval, revoke, drain, rename | P0 | DONE | `tls.mjs`, `pair.mjs`; tests pairing / N10 / e2e revoke |
| Leases, quorum all/fault-tolerant, deadline, BLOCKED + retry | P0 | DONE | `coordinator.mjs`; N05–N07 |
| Durable outbox, idempotency, replay | P0 | DONE | `worker/outbox.mjs`; N03, N04, N08, e2e outage |
| Crash-safe commit and recovery | P0 | DONE | N09 |
| N11 VPN/packet loss backoff | P0 | PARTIAL | exponential backoff + outage test; no packet-loss injection test |
| Model registry with pinned revisions, provenance check against HF | P0 | DONE (network check is explicit button/CLI) | `registry.mjs`; MLX community 4-bit stays `unverified` (its card says base is *Base*) |
| Trusted evaluator (validation NLL on coordinator) | P0 | DONE on CPU · GPU NOT RUN | `service.mjs evaluate`; e2e torch + app test |
| Report export + offline verify-report (E02) | P0 | DONE | `report.mjs`; e2e, app, cli tests (incl. tamper detection) |
| PEFT export (E01), adapter_config from profile | P0 | DONE (round-trip on tiny model) · real Ministral load NOT RUN | `peft_export.py`; `compute2-python`, app test |
| CUDA NF4 backend (RTX 5070 BF16 / RTX 2070 FP16) | P0 | DONE (HW NOT RUN) | `backends/torch_backend.py` |
| MLX backend (M1 Pro) | P0 | DONE (HW NOT RUN; CPU-MLX parity only) | `backends/mlx_backend.py` |
| Preflight (load + one fwd/bwd at max_length, memory) | P0 | DONE on CPU · HW NOT RUN | `sidecar.py preflight` |

## Governor & consent (spec §4.1, §10, §11)
| Req | Pri | Status | Evidence |
|---|---|---|---|
| Versioned consent per project/endpoint/fingerprint, remote needs extra consent, revoke | P0 | DONE | `controller.mjs`; app + UI tests |
| GPU share / CPU share (step 5, 0 = no tasks), hours/day budget persisted across restarts/midnight | P0 | DONE | `governor/*`; `compute2-governor` (R02, R04) |
| Idle, AC, games (Windows), local AI broker, full-screen, temperature (NVIDIA), memory, quiet hours, traffic, metered | P0 | DONE (Windows game/full-screen via SHQueryUserNotificationState; macOS/Linux: no game sensor ⇒ pause with reason unless unticked) | `governor/sensors.mjs`, `desktop.cjs` powerMonitor relay |
| Measured vs nominal contribution | P0 | DONE | UI *Participation* (nominal = share × h × 30; measured session/GPU-busy/tasks/tokens/traffic) |
| Stopping shown until GPU released; stop at safe boundary | P0 | DONE | `STOPPING` state; worker stop awaits sidecar exit |
| Background/tray after window close | P1 | NOT DONE — v0.2 stops Compute on close (UI says so) |
| Energy measurement | P1 | NOT DONE — no reliable cross-platform source; shown as unavailable |
| Mac thermal / battery | P1 | PARTIAL — `thermal_state` and battery from Electron powerMonitor; no temperature on Mac |

## UI (spec §4)
| Req | Pri | Status | Evidence |
|---|---|---|---|
| Compute section in navigation, coral accent, light/dark, RU/EN, 1024×768 | P0 | DONE | `public/compute.js`, `compute-i18n.js`, `style.css`; `compute2-app` UI test (headless Chrome, both themes, RU) — screenshots in the handoff notes |
| Participation page with real controls | P0 | DONE | UI test drives slider, checkboxes, toggle → consent → pause/resume |
| Devices: connect / local coordinator, pairing, device list, approve/revoke/drain/rename | P0 | DONE | UI test (start coordinator, pairing string, join self) |
| Lab wizard + dry run + immutable start | P0 | DONE | UI test (fixture import, register model, dry run, create & start) |
| Monitoring: rounds table, blockers, slots progress, validation NLL chart, events, export JSON | P0 | DONE | UI test (COMPLETED run visible) |
| Models & data: runtime check, model verify, provenance, preflight, legacy import, verify report | P0 | DONE | UI test (preflight) + app test |
| Keyboard/ARIA | P0 | PARTIAL — native controls, focus ring, labels; no screen-reader audit |
| QR pairing, LAN auto-discovery | P1 | NOT DONE — manual pairing string only (allowed by spec) |
| Model download/resume from the app | P1 | NOT DONE — user supplies a local folder; provenance check available |

## Runtime & packaging (spec §5, §13)
| Req | Pri | Status | Evidence |
|---|---|---|---|
| `doctor`/probe (versions, GPU, memory, BF16, backend import) | P0 | DONE | `sidecar.py probe`, CLI `doctor` |
| Managed per-user Python 3.12 runtime installer with hashes/rollback | P0/P1 | NOT DONE — instructions + pinned requirements (`compute/runtime/`), app verifies the chosen interpreter | HW-TEST.md |
| CLI sharing controller code | P1 | DONE | `compute/cli.mjs`; `compute2-cli` |
| Installers Linux/Windows | P1 | see handoff report (built unsigned on the box) |
| Signed artifacts | P1 | NOT DONE — no signing secrets on the build box |
| GGUF merge / Ollama import | P2 | NOT DONE (not required for v0.2) |

## Hardware & benchmarks (spec §14 B01–B04, §16)
All **NOT RUN** — require ENVERDASH (RTX 5070), ROG (RTX 2070) and the MacBook M1 Pro. Exact steps:
`docs/compute/HW-TEST.md`. No measurements are reported for them.
