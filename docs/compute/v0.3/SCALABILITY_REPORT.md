# Coordinator scalability

MEASURED an isolated SQLite coordinator at 10, 50, 100, 500, 1,000 and 10,000 synthetic registered identities. Each submitted three heartbeats through the coordinator's in-process handler. At 10,000 identities the run processed 30,000 calls at 2,232 calls/s, p95 0.441 ms, p99 0.837 ms, with RSS about 67.5 MiB at end and no observed SQLite errors.

This workload exercises the SQLite heartbeat write path. It excludes network, signature verification, transport concurrency, payload storage and training. Combined TLS/payload throughput and real fleet stability remain NOT TESTED. The separate simulator models bounded slot allocation and transfer interruption. The current measurements do not call for a storage migration.
