# Kvalah Compute v0.3 · development preview

This preview implements the core recovery path requested after R60. It preserves accepted work on compatible round retries, resumes uploads from missing chunks, keeps a model resident under local policy, and records transport and resource diagnostics. The old PUT path, archive format and canonical FFA-LoRA math remain supported.

Recovery, SHA-256 validation, budget controls and HTTPS workers passed targeted software tests. The original R60 database was used read-only. The historical performance target, multi-device optimized Research, strict hardware duty limit, and final algorithm and model-quality claims remain NOT TESTED. The evidence distinguishes simulated outcomes from hardware and software measurements.

[Architecture](ARCHITECTURE.md) · [Implementation](IMPLEMENTATION_REPORT.md) · [Performance](PERFORMANCE_REPORT.md) · [Network](NETWORK_REPORT.md) · [Recovery](RESILIENCE_REPORT.md) · [FedAvg](FEDAVG_OPTIMIZATION_REPORT.md) · [Volunteer 10%](VOLUNTEER_10_PERCENT_REPORT.md) · [Scale](SCALABILITY_REPORT.md) · [Quality](MODEL_QUALITY_REPORT.md) · [Security](SECURITY_REPORT.md) · [Tests](TEST_REPORT.md) · [Migration](MIGRATION_GUIDE.md) · [Changelog](../../../CHANGELOG.md)
