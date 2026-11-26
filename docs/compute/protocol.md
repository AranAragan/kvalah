# Kvalah Compute protocol v2.0 (as implemented in v0.2)

## Stability development build

- The worker schedules a single outstanding renewal per task from the last coordinator-confirmed expiry. The signed task starts the lease before artifact transfer. The manager lives through sidecar shutdown, local result validation and delivery. It stops at a terminal disposition or the elapsed deadline. A same-device session can renew an existing live lease. A resumed claim comes with an updated signed expiry.
- Updates retain immutable bytes, a signed task, a project/endpoint/certificate/device scope and an idempotency key. An uncertain declare is repeated with the same key. Once the update ID is known, the worker queries status before resending content or commit. A durable ACK closes the outbox entry. A new session supersedes the old one, and the signed PUT query binds the content operation to that session for new production tasks.
- The client uses separate pinned control and payload pools. Heartbeat and renew use control slots. Large responses and attempted outbound bodies count toward the local persistent payload ledger. TLS/HTTP headers and streams outside these operations are outside this ledger.
- The coordinator snapshots registered model variants before new experiments. A new production worker requires the signed digest and the corresponding verified local model. Backend/variant and context length must match. For LAN trials, use the same development build on all devices. Earlier production experiments without snapshots remain available in history.
- SQLite records checkpoint ownership by experiment and round. The CAS can share identical bytes between experiments. Local worker checkpoints promote a single generation pointer after writing the adapter, optimizer and their metadata and hashes.

Transport: HTTPS with a self-signed certificate generated per coordinator; the client pins its SHA-256
fingerprint (from the pairing string). No CA fallback, no plain HTTP. Bodies: JSON (≤ 64 KiB) or
`application/octet-stream` safetensors (≤ 8 MiB). Chunked bodies are refused (Content-Length required).

## Pairing
Pairing string (one device, valid 10 min, 5 attempts):
`kvalah-compute://pair?e=<https endpoint>&fp=<cert sha256>&c=<one-time code>`

1. `POST /v2/pair/start` → `{challenge (2 min), project_id, coordinator_key, protocol_version}`
2. `POST /v2/pair/complete` `{challenge, device_id (dev-<32 hex>), public_key (Ed25519 SPKI b64), alias,
   capabilities, runtime_version, code_mac (HMAC of the challenge keyed by the one-time code — the code
   itself is never sent), signature = Ed25519("KC2-PAIR\nchallenge\ncode_mac\npublic_key\ndevice_id")}`
   → device state `pending`.
3. The administrator approves the device (UI *Devices* or CLI `--approve-all`) → `active`.

## Signed requests
Headers `x-kc-device`, `x-kc-ts` (ms), `x-kc-nonce` (single use), `x-kc-sig` =
Ed25519 over `KC2\n<METHOD>\n<path>\n<sha256(body)>\n<ts>\n<nonce>\n<device_id>`.
Clock skew window ±120 s (`CLOCK_SKEW`), replayed nonce → `REPLAY`, revoked device → `REVOKED`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v2/health/live`, `/v2/health/ready` | liveness, server time (unsigned) |
| POST | `/v2/devices/session` | start a session (supersedes the previous one) |
| POST | `/v2/devices/heartbeat` | status, pause reason, metrics, capabilities |
| POST | `/v2/tasks/claim` | lease a task (or `{task:null, reason, retry_after_s}`) |
| POST | `/v2/tasks/<id>/renew` \| `progress` \| `abandon` | lease renewal, step progress, give back |
| GET | `/v2/artifacts/<sha256>` | base adapter / dataset shard (only those referenced by the device's lease) |
| POST | `/v2/updates` | declare an update `{task_id, lease_id, idempotency_key, payload_sha256, bytes, metrics}` |
| PUT | `/v2/updates/<id>/content` | upload the B-only safetensors |
| POST | `/v2/updates/<id>/commit` | validate & accept/reject |
| GET | `/v2/updates/<id>/status` | idempotent status (outbox resume) |

## Task manifest (signed by the coordinator's Ed25519 key; the worker verifies it with the key pinned at pairing)
```
protocol_version, task_type:'ffa_lora_sft', task_id, lease_id, attempt, project_id, experiment_id, run_id,
round, round_attempt, device_id, model_profile, model_variant_id, base_adapter_hash, frozen_A_hash,
schema_hash, dataset_shard_hash, row_ids, expected_supervised_tokens, mask_checksum, config_hash,
optimizer_hash, local_steps, batch_size, grad_accum, max_length, optimizer, rank, alpha,
update_kind:'absolute_b', lease_ttl_seconds, lease_expires_at, round_deadline_at, issued_at
```
The worker refuses a task whose profile/variant differ from its verified local model, whose artifacts do not hash to the manifest values, or whose base adapter A differs from `frozen_A_hash`; the coordinator only leases tasks to devices whose reported files digest matches the registered variant.


## Update validation (coordinator)
Exact 52 B keys (`layers.<n>.<q_proj|v_proj>.B`), FP32, exact shapes, finite, ≤ 8 MiB, header ≤ 1 MiB,
payload sha256 = declared, task leased to this device, lease not expired (late updates are stored and
quarantined, never applied), supervised-token count = coordinator count (`TOKEN_MISMATCH`), duplicate
idempotency key with different bytes → `DUPLICATE_DIFFERENT` (409), never overwrites an accepted update.

## Round state machine
`OPEN → COLLECTING → SEALING → COMMITTED` (or `BLOCKED` at deadline below quorum; `resume` retries the
round as attempt+1 from the same parent). Quorum modes: `all` (every target device, control experiments)
and `fault_tolerant` (≥ min of target at the deadline). Sealing freezes the accepted list (sorted by task
id); aggregation = FP64 FedAvg weighted by coordinator token counts → FP32; checkpoint stored in CAS;
`experiments.state` → `COMPLETED` after the last round. Crash during SEALING: on restart the same
accepted list is re-aggregated → identical checkpoint hash.

## Error codes
401 `UNAUTHORIZED BAD_SIGNATURE CLOCK_SKEW REPLAY` · 403 `REVOKED FORBIDDEN_SCOPE NOT_OWNER PENDING_APPROVAL
CONSENT_REQUIRED` · 404 `NOT_FOUND` · 409 `STALE CONFLICT DUPLICATE_DIFFERENT SESSION_SUPERSEDED
INVALID_TRANSITION IMMUTABLE` · 410 `LEASE_EXPIRED PAIRING_EXPIRED` · 413 `TOO_LARGE` · 422 `INVALID_SCHEMA
INVALID_TENSOR NONFINITE HASH_MISMATCH TOKEN_MISMATCH FROZEN_A_CHANGED UNSUPPORTED_PROTOCOL DATASET_REQUIRED
DATASET_INVALID MODEL_UNVERIFIED NO_TARGET_TOKENS` · 429 `RATE_LIMITED TOO_MANY_ATTEMPTS` · 503 `UNAVAILABLE`.

## Desktop-internal API (not network-exposed)
`/api/compute/v2/*` on the existing 127.0.0.1 server (local token + origin check), proxied over IPC to the
compute host. `POST /api/compute/v2/feature {enabled}` switches the feature flag; other routes:
`state, events, consent/accept|revoke, participation, pause, resume, policy, runtime, model,
model/provenance, preflight, profile, link/pair|refresh|forget, lab/start|stop|join-self|pairing|approve|
revoke|drain|rename|register-model|import-dataset|dry-run|create|events|report|export-peft,
lab/experiment/start|pause|resume|cancel|finish|status, legacy/import, verify-report`.
