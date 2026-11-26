# Stability review · Compute 0.10.0-compute.2.dev.1

Baseline `d642625` (`v0.10.0-compute.1`). The supplied handoff and the local round JSON for `smoke-61ec92` show a failed attempt followed by a blocked attempt, with **0 of 2** committed rounds. The prior Mac run reported repeated low-memory abandonment and redundant inbound traffic. The coordinator log does not establish the cause of the ROG transfer failure. A successful health request establishes reachability for that operation at the sampled time.

## Confirmed defects

| Finding | Consequence | Change |
|---|---|---|
| The old renewal timer began after downloads and stopped before GPU cleanup and upload. | A worker could finish computing and lose its lease before the coordinator accepted the update. | A task-scoped manager covers preparation through confirmation, with deadline enforcement and renewal diagnostics. |
| The old governor checked the RAM floor at preflight after claiming and downloading the task. The worker could immediately claim again. | A blocked device could repeatedly receive the same artifacts. | Admission runs before claim and at preparation boundaries. Verified parent and shard bytes are reused by content hash. |
| Retry state lacked a status-first reconciliation path. Session refresh also created a replacement session. | A lost reply could trigger redundant payload traffic, and refreshing approval could interrupt an active worker. | The durable outbox reconciles known IDs by status. Approval refresh reads signed state without starting a session. |
| The worker's traffic counter was separate from the policy ledger. The CPU control still allowed a thread at zero. | Limits displayed in the UI did not reliably reflect enforcement. | Payload accounting feeds the persistent budget, and CPU/GPU zero blocks heavy work. |
| Local checkpoint components used separate writes. Coordinator checkpoint lineage used a hash as the global primary key. | A crash could mix local steps, and a second run could lose its own reference to identical bytes. | Promote complete generations locally. Record shared CAS bytes and run ownership separately in SQLite. |
| Registry edits affected subsequent claims for existing runs. A context-256 preflight could be accepted for context 512. | Workers could train from different model bytes or run beyond the tested context. | New runs snapshot the registry and sign the verified digest. Production admission verifies backend and context, and the sidecar rehashes files before loading. |
| Monitoring fetched the oldest event page repeatedly. | New activity dropped out of view as the event log grew. | Request the recent tail and export allowlisted diagnostics. |

## Remaining weak points

- macOS still needs a validated available-RAM and pressure provider. The current check uses a fresh OS free-RAM sample and can pause conservatively. Per-device VRAM reservations, metered-network detection and profile-based duration admission still require implementation and measurement.
- Client timings track broad RPC stages. Coordinator tensor decode and aggregation still run synchronously. Measure event-loop lag during concurrent transfers and aggregation before increasing concurrency.
- The payload ledger persists attempted upload bytes before sending and updates received bytes when a request settles. A hard kill during download can lose that request's accounting. TLS framing and NIC totals have different semantics.
- Model hashes are checked immediately before load. An immutable staged snapshot would close the race between checking and opening files. Official MLX conversion and provenance remain unverified.
- Context is part of preflight compatibility. Full batch/accumulation/optimizer binding, OS-specific memory controls, calibrated anomaly quarantine and the automated runtime/model onboarding remain open. See [Requirements map](requirements-map.md).
- The candidate requires the three-device hardware checks in [HW-TEST.md](HW-TEST.md). CPU and simulated-device tests cannot establish CUDA NF4, Metal, or the cause of the original ROG failure.
