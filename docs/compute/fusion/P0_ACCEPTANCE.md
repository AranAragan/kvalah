# Expert Fusion audit follow-up

This branch extends the independent-expert CPU reference with supported Compute Worker entry points. The 3B GPU smoke, two-worker integration, transport stress test and Electron review are separate experiments. Their results do not establish three-device acceptance.

| Audit items | Status | Evidence and remaining work |
| --- | --- | --- |
| 1–3, 6–8 | IMPLEMENTED · MEASURED | The Compute Worker negotiates Fusion leases, uses the shared sidecar lock, applies the Resource and Traffic Governors, and stores file-based outbox records. CUDA NF4 executed one step each for FFA-LoRA, LoRA and FFN on installed Ministral 3B. The resident model was reused twice. |
| 4–5 | PARTIAL · MEASURED on CUDA | The independent expert MLX backend and conversion eligibility are implemented. Apple Silicon execution and numerical parity were not tested. A real Torch NF4 MoE + Loop probe verified nonzero Router and Loop-gate gradients and an optimizer step on a pinned Train row. The automatic production jobs still train independent experts only. |
| 9–14 | IMPLEMENTED · MEASURED, with a separate checkpoint limit | Chunk hashing, file-backed restart, staging and overall SHA-256 are verified. Pinned HTTPS carried 4,300,000 B, 100,000,000 B, 324 MiB and 1 GiB through an interrupted TCP relay. Each transfer resumed with one verified chunk reused. Fusion aggregation still uses the bounded 64 MiB registry checkpoint and in-memory reducer. Sharded large expert reduction remains open. |
| 15–18, 20–21 | IMPLEMENTED · MEASURED | The production Compute Worker requests signed assignments, renews leases and uploads from its outbox. Automatic selection incorporates existing device heartbeat, policy, traffic and device metrics. A two-worker CPU test verifies idempotent result recovery, distinct devices, FedAvg, frozen A and trusted Validation. The independent run currently executes one round. |
| 19, 22 | PARTIAL | Expert and Train artifacts are delivered automatically to the configured production Worker. Base models and runtime use the existing Compute onboarding path. Trusted local composed-model evaluation uses uniform routing and checks selected experts against their pinned Validation data. Fusion-specific bootstrap from a clean GPU installation and the composed trial on the physical fleet remain open. |
| 23–30 | IMPLEMENTED · MEASURED | The builder reads local model headers and tokenizer fingerprints, displays layer placement and accepts normal forms. The GUI can submit, pause, resume and stop a run, change participation and choose an approved device or automatic assignment. The app test used a CPU fixture and a real coordinator. |
| 31–34 | PARTIAL | The models tab can create and validate a uniform-routing Torch composition with an optional uncached Loop span, then run local generation from the published version. CPU tests cover evaluation and generation. A learned production Router with exported weights and independently scheduled Router/Loop optimization remain open. |
| 35–44 | OPEN | Existing reference backward runs over local subprocess pipes. Cross-host CUDA/MLX forward/backward, regional coordinators, peer discovery, peer serving and multi-peer physical measurements remain open. The existing coordinator remains the source for authenticated transfers. |
| Three-device Fusion‑01 | NOT RUN | The measured device is MSI RTX 5070. ROG RTX 2070 and MacBook M1 Pro did not execute these builds. The GPU smoke uses one pinned archived Train row. It did not retrain R60, include a new specialized corpus, tune with Test or measure conversation quality. |

## Measurements

On the MSI, the cold CUDA NF4 job took 28.76 s including a verified base load of 27.38 s. The subsequent LoRA and FFN commands took 0.578 s and 0.545 s with the base resident. Each job had 150 supervised tokens. The runtime checked frozen tensors and reported a peak CUDA reservation of 3,745,513,472 bytes. These are smoke timings. All three initialized experts begin close to the baseline, so the initial loss is not a measure of domain gains. [Raw CUDA measurements](measurements/p0-cuda.jsonl)

In a second isolated run, a repeated two-layer span executed two passes over the same 150 supervised tokens, with the three fitted expert modules resident. The sparse Router gradient norm was 0.014519 and damping-gate gradient norm was 0.008356. SGD changed both parameter sets. The step took 0.286 s, with peak CUDA reservation of 3,825,205,248 bytes. This validates the real-model gradient path, rather than measuring quality improvement. [Raw Router and Loop measurements](measurements/p0-cuda-loop.jsonl)

The 1 GiB transport case transferred 256 chunks after indexing the fixture. It completed in 12.77 s from first request to verified output, including interruption and resume, with 125,530,112 bytes peak process RSS measured at part boundaries. The sender, relay and receiver ran in the same process. Fixtures are synthetic bytes, and this is a loopback throughput result. [Raw transfer measurements](measurements/p0-stream.jsonl)

## Reproduction

Use a scratch state root and the existing Compute Python runtime. Full stream testing needs two to three GiB temporary space. For CUDA Smoke, supply the local verified model, the archived R60 CAS directory, and the original coordinator DB as a read-only guard. Keep Inference, Hybrid and other Compute work idle. The script checks leases, RAM, temperature, VRAM, mains and active connections on local inference workers.

```powershell
node scripts/fusion-stream-smoke.mjs research/fusion-stream.jsonl full
node --test test/fusion-production.test.mjs
node scripts/fusion-desktop-smoke.mjs path/to/electron.exe research/fusion-desktop .
& $python scripts/fusion-cuda-smoke.py --archive $archive --model $model --coordinator-db $db --out research/fusion-cuda.jsonl --loop-probe
```

This remains a draft review branch. Clean-install acceptance, physical multi-device acceptance and the release are pending.
