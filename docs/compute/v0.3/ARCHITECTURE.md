# Compute v0.3

Coordinator keeps signed task manifests, immutable data and commit decisions in SQLite and CAS. The worker uses separate HTTPS agents for control and payloads. Endpoints retain protocol 2.0 and advertise chunk support. When both sides support chunks, the update ID names the transfer, the declared SHA-256 names the complete payload, and every chunk is authenticated by the signed request. Completion runs the same tensor validation and CAS promotion as a legacy PUT.

The Python sidecar keeps one resident model keyed by local path, signed model digest, backend and tensor profile. Each task loads the exact global A and B; optimizer and gradients are cleared at the task boundary. Cold shuts down after a task. Warm holds for the configured idle interval. Adaptive holds for at most 45 seconds. Residency yields to local resource policy. Cold replacement always verifies local files.

Round retry retains original immutable updates through an assignment-to-update mapping. It checks the source attempt, parent, config and optimizer hashes, variant, token mask, active identity and CAS. Sealing retains a stable list of accepted update IDs, and aggregates that list exactly once. Strict quorum still requires the original number of independent participants.
