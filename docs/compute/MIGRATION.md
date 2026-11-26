# Upgrade and rollback · Compute 0.10.0-compute.2.dev.1

1. Close Kvalah on the coordinator and workers. Back up their app data and Compute data directories and retain the previous installer. Keep existing runtime/model directories in place.
2. Install the same development build on the coordinator and all workers. The coordinator moves SQLite to schema 2 and writes `coordinator.sqlite.bak-v1` next to the database before migration. The migration retains checkpoints and restores missing run lineage from the old experiment and round records.
3. Reuse the existing device identity, endpoint pin and valid project consent. Rerun model verification and preflight with the intended context. The build keeps the previous output and local model directories. Existing production runs without a model snapshot stay in history. For a new hardware trial, register the verified variants and create a fresh experiment.
4. The new outbox requires a signed task manifest and project scope. Old pending entries lack these fields. They remain on disk for review. The worker will recover entries created by the development build when the identity and scope match and the coordinator recognizes their status or lease.

For rollback, close the candidate, preserve a separate copy of the schema-2 data, reinstall the previous version and restore the pre-upgrade app data backup. Restore SQLite from a consistent backup as a unit with the coordinator CAS. Previous versions cannot open schema 2.
