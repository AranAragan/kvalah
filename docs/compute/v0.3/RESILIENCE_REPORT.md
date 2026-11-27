# Resilience report

The chunk test writes nine chunks, reopens the SQLite database, rejects an invalid final digest, sends only the final chunk and validates identical output bytes. Duplicate chunks and repeated completion are idempotent. Partial upload storage is capped at 32 sessions globally, two per worker and the existing per-update byte cap. Staging is reclaimed at deadline. Complete weights are promoted only after the declared hash and tensor checks pass.

The outbox is durable before the first request. A corrupt current metadata file falls back to the last durable version. Reconciliation keeps acknowledged and committed updates distinct and retries with the same idempotency key. Accepted records without a committed checkpoint are preserved. Other terminal records follow the seven-day retention rule.

The strict-quorum retry test retains two verified accepted updates and leases only the missing slot. The resulting report replays FedAvg bitwise. Expired leases cannot commit new data. Previously accepted results may be referenced again by the coordinator only after verifying the same round and immutable assignment.
