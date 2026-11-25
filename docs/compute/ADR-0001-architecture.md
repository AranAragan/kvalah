# ADR-0001 — Kvalah Compute v0.2 architecture

Status: accepted for v0.2 (LAN, feature flag off by default) · Date: 2026-11-26

## Context
v0.1 (experiment-v01.zip) proved that Federated Freeze-A LoRA (FFA-LoRA) across an RTX 5070, an RTX 2070
and an M1 Pro is mathematically workable: the FP32 aggregation of six updates with token weights 41:38:38
reproduces bit-exactly. Its flaws were architectural: one shared bearer token for all nodes (rog's first update
is not attributable), no model revisions, no SFT mask (loss over prompt tokens), ad-hoc scripts, plain HTTP,
no consent, no resource governor, no recovery. v0.2 must live inside the existing Electron app (chat, hybrid
agent, local/cloud inference, Offload) without breaking any of it.

## Decision
1. **Process layout.** `desktop.cjs` (Electron main) → `server.mjs` (existing Node backend, unchanged
   behaviour) → **`compute/host.mjs`**, a separate forked Node process started *only* when
   `settings.computeV2 === true`. Crash isolation: a compute failure cannot take down chat/agent; the host
   is restarted with backoff (max 5) and exits when its parent disconnects, so closing Kvalah stops Compute.
2. **Node owns control, Python only computes.** Coordinator, worker, governor, protocol, storage, signing
   and aggregation are Node (built-ins only: `node:sqlite`, `node:crypto`, `node:https`). The Python
   **sidecar** (`compute/python/kvalah_compute`) is a stdio JSONL process with no network code: commands
   `probe`, `verify_model`, `tokenize`, `preflight`, `train`, `evaluate`, `export_peft`. Every micro-step of
   training waits for a **permit** from the Governor, so pause/stop/limits are enforced between steps.
3. **Backends.** `cuda` (PyTorch + bitsandbytes NF4 on the BF16 source), `mlx` (mlx-vlm on Apple Silicon),
   test-only `torch-cpu-test` and `mock` (refused unless `KVALAH_COMPUTE_TEST=1`).
4. **Math contract.** Torch layout `A[r,in]`, `B[out,r]`, scale `alpha/r` (r=8, α=16 for Ministral 3 3B,
   q_proj+v_proj of 26 layers = 52 B tensors). A is generated canonically from the experiment seed on the
   coordinator and is frozen; workers upload **absolute B only**; the coordinator verifies A bytes unchanged
   and runs FedAvg in FP64 over updates sorted by task id with weights = coordinator-counted supervised
   tokens, then rounds to FP32. The v0.1 import (`compute/legacy.mjs`) is the regression oracle (M01).
5. **SFT.** Datasets are tokenized **centrally** on the coordinator with the model's own tokenizer
   (`fix_mistral_regex=True`, fixed default system prompt because the Ministral template is date-dependent);
   only assistant tokens are targets; shards are content-addressed and identical for all workers (D01).
6. **Identity & transport.** Each installation creates a random device id + Ed25519 key (not derived from
   hardware/IP/user). Pairing: one-time string `kvalah-compute://pair?e=…&fp=…&c=…` (endpoint, pinned
   self-signed TLS fingerprint, code); the device proves the code with an HMAC, then waits for admin
   approval. Every request is signed (`KC2\nMETHOD\npath\nsha256(body)\nts\nnonce\ndevice`), nonces are
   single-use, clock skew is bounded. TLS is pinned by fingerprint — no CA fallback, no plain HTTP.
7. **Coordinator storage.** SQLite (WAL) for devices/experiments/rounds/assignments/tasks/updates/audit +
   a CAS directory for tensors and shards. Round commit is a single transaction with a crash-safe
   SEALING→COMMITTED transition (recovery re-derives the same checkpoint hash, N09).
8. **Governor.** Local-only resource policy (GPU time share, CPU share, hours/day, idle, AC, games,
   local AI, full-screen, temperature, memory, quiet hours, traffic, metered). A coordinator can never change
   it. Missing sensors pause work with an explicit reason instead of guessing. The existing local inference
   path marks the broker busy (`computeGate.lease`) so chat/agent generation pre-empts Compute.
9. **UI.** `public/compute.js` (+ `compute-i18n.js`, EN/RU) in a separate **Compute** section of the
   sidebar; the existing *Devices → Compute* tab (Offload GPU queue) is untouched. All controls call
   `/api/compute/v2/*`; when the flag is off the server answers `{feature_enabled:false}` / 409.
10. **Secrets.** The device private key is sealed with Electron `safeStorage` (DPAPI/Keychain) relayed
    over IPC; where unavailable (Linux basic_text, CLI) a 0600 file is used and the UI says so.

## Consequences
* Proven parts of the app (server, providers, Offload, devices, updater) are not rewritten; the Compute
  code is additive (`compute/**`, new routes under `/api/compute/v2/`).
* The coordinator binds only to a private address chosen by the user; changing the bind IP regenerates the
  certificate → devices must pair again (documented in the runbook).
* No automatic Python/runtime installer and no automatic model download in v0.2: the user installs the
  runtime from `compute/runtime/requirements-*.txt` and points the app at a local model folder; the app
  verifies both (probe, file digest, architecture, optional pinned-revision check against Hugging Face).
* Mixed quantization (CUDA NF4 vs MLX community 4-bit) is a known confounder and is reported, not hidden.
