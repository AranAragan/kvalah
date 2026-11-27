# Expert Fusion v0.10.0-fusion.1.dev.3 reacceptance

The experimental branch retains the accepted Compute Worker, large artifact transfer, file-backed FedAvg and visual architecture builder from `d5a49d0`. The table records the evidence and the scope of the remaining hardware acceptance.

| Item | Status | Evidence and scope |
| --- | --- | --- |
| 1. Rounds, epochs and supervision budget | Implemented | A SQLite run records the maximum rounds, epoch boundary, committed supervised-token count and pending round. Five rounds are exercised by the deterministic coordinator test. Each claim carries a signed exact token count and step count. |
| 2. Sampling | Implemented | `sequential` reads the immutable Train manifest in order. A round stays inside one epoch. Incomplete local optimizer steps at epoch boundaries are dropped. A new epoch is the explicit repeat policy. |
| 3. Continuation | Implemented | The checkpoint, committed receipts and cursor advance in the same SQLite transaction. Validation has its own durable state. Tests reopen the registry and resume from the last committed checkpoint, including after a failed quality gate. |
| 4–5. Learned Router | Implemented on Torch | Token routing uses Top‑1, Top‑2 or Top‑4. The scheduled stage trains on masked Train data, signs the SAFETENSORS digest in the composition, and validates and loads those weights for generation. Import checks the trusted signature, tensor schema and matching locally validated experts. |
| 6–7. Loop and automatic stages | Implemented on Torch | Router Training, Loop Adaptation and Validation are separate persisted stages on the trusted coordinator. A completed stage survives restart. The saved Loop hash is required during reload. A stopped in-progress optimizer stage reruns from the original signed inputs. |
| 8. Scheduler admission | Implemented | Automatic and manual claims share registration, heartbeat, preflight, model compatibility, policy, temperature, memory, traffic and disk checks. An empty plan issues no lease. The test exercises both claim modes and a constrained manual worker. |
| 9. FFN admission | Implemented, modelled sizing | Admission accounts for detected model parameters, measured preflight or resident weights, F32 expert weights and gradients, AdamW state, context-dependent activations and temporary buffers. Workers recheck local memory before download and training. Full-sized production FFN training on the physical fleet remains open. |
| 10. Outbox and receipt recovery | Implemented | The HTTPS test stops and restarts the coordinator before an upload and then loses an acknowledgement. A late result can be accepted within 24 hours when the lease still targets the same parent and slot and no replacement won. A superseded result is rejected. `ACCEPTED` is staging and `COMMITTED` includes the checkpoint digest and version. |
| 11. GUI | Implemented | Expert round limits, progress, controls and Validation are in Experts. Model versions exposes learned routing, Loop adaptation, pause/resume/stop, Validation, approved publication and inference. |
| 12. Loop KV cache | Implemented on Torch | Each logical layer/pass gets a distinct KV entry. The miniature Torch integration checks cached/uncached generation after fitting and reloading. Physical model coverage is recorded in the measurement below. |
| 13–14. Native MLX and RTX 2070 | NOT RUN | The MacBook M1 Pro and ROG RTX 2070 did not have recent coordinator heartbeats during this acceptance window. |
| 15. Inter-host forward/backward | Open | The reference verifies gradient equivalence over local subprocess pipes. Physical cross-host transport and numerical verification remain open. |
| 16. Autonomous hierarchical aggregation | Open | Grouped weighted aggregation exists in the reference. Independent regional coordinator scheduling and failure recovery remain open. |
| 17. Peer-to-peer serving | Open | The production coordinator remains the authoritative source. Physical peer discovery, serving, replication and multi-source measurements remain open. |
| 18. Candidate expansion | Implemented | Successful final expert Validation can queue a new candidate based on the active composition. Exact checkpoint digests for unchanged experts are kept. The current published composition stays active until approval. |
| 19. Beyond eight experts | CPU measured, fleet open | The production Torch sidecar accepts up to sixteen selected experts and checks CUDA memory for weights, activations and KV. The fixture generates with ten small experts. Full-size placement and throughput remain open. |
| 20. Documentation | Updated | The hardware, provisioning, Router, Loop, expansion, tests and user guides describe the current production path and the remaining measurements. The previous acceptance report is historical. |

## Hardware experiment

Physical Fusion‑01, five federated rounds per expert across the three laptops and specialized independent holdout quality are NOT RUN. The five-round coordinator regression uses deterministic fixture updates. The isolated MSI sidecar test uses verified Ministral 3B NF4 with archived Train data read only. It exercises multiple optimizer steps per stage on a single physical GPU. See the raw measurements for the observed completion and abort conditions. The original R60 is untouched.

At a 128-token context, the MSI finished five actual optimizer steps for FFA‑LoRA, LoRA and FFN with 327, 226 and 281 supervised tokens, respectively. The same verified backbone stayed resident for the second and third expert. An attempted 256-token run stopped at the free-VRAM floor. The 128-token expert pass stopped before the integration stage when free system RAM fell below the minimum. [Raw independent expert measurements](measurements/dev2-cuda-experts.jsonl)

A subsequent serial process trial completed five Router and five Loop optimizer steps on the MSI. Reload then exposed MistralCommon's mandatory serving-mode model identifier. The dev.3 inference path uses the same central user-ended prefix encoder as dataset preparation. The native tokenizer regression covers English and Russian one-turn and multi-turn prefixes.

## Reproduction

```powershell
node --test --test-concurrency=1 test/fusion-production.test.mjs test/fusion.test.mjs
node scripts/fusion-desktop-smoke.mjs path/to/kvalah.exe research/fusion-dev2-desktop
& $python scripts/fusion-cuda-smoke.py --composition-trial --archive $archive --model $model --coordinator-db $db --out research/fusion-dev2-cuda.jsonl
node scripts/fusion-audit.mjs research/fusion-dev2-audit.zip
```

Use an isolated state directory and an existing verified model. The CUDA check requires mains power, idle competing runtimes and sufficient free memory. It reads the coordinator database and original Train artifacts without changing either. The audit tag uses the `fusion-audit/` prefix so it can identify the installer sources without triggering the `v*` production release workflow.
