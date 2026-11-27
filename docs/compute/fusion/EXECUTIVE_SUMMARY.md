# Expert Fusion v1 research branch

Expert Fusion contains a PyTorch causal reference model, versioned expert registry, signed checkpoint composition, authenticated artifact delivery, offline expert aggregation, and an opt-in Compute desktop laboratory.

The local reference run trained three independent low-rank experts, expanded with a genuine gated FFN, trained a sparse router and loop gates, and reloaded the composed model. The test data comprises deterministic synthetic token tasks. A process pipeline implements remote-stage semantics on local subprocess pipes, including gradient exchange and recovery from a failed stage.

The complete release acceptance remains open. Fusion-01 on RTX 5070, RTX 2070 and Apple M1 Pro, cross-host CUDA/MLX backward, unattended training from an empty device, public peer discovery, update transport for Fusion jobs, native MLX Fusion execution and the extended quality panel still need implementation or verification. See the scope and checkpoints below.

- [Architecture and source audit](EXPERT_FUSION_ARCHITECTURE.md)
- [Model sizing](MODEL_ARCHITECTURE.md) · [Registry](EXPERT_REGISTRY.md) · [Router](ROUTER_DESIGN.md) · [FFN](FFN_EXPERTS.md) · [Loop](LOOP_TRANSFORMER.md) · [Expansion](DYNAMIC_EXPANSION.md)
- [Provisioning](AUTO_PROVISIONING.md) · [Pipeline](DISTRIBUTED_PIPELINE.md) · [Aggregation](FEDERATED_MESH.md) · [P2P](P2P_DISTRIBUTION.md)
- [Security](SECURITY_REPORT.md) · [Performance](PERFORMANCE_REPORT.md) · [Quality](QUALITY_REPORT.md) · [Scale](SCALABILITY_REPORT.md) · [Hardware](HARDWARE_COMPATIBILITY.md) · [Tests](TEST_REPORT.md)
- [User guide](USER_GUIDE.md) · [Migration](MIGRATION_GUIDE.md)
