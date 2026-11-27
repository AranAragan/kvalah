# Expert Fusion v1 research branch

Expert Fusion contains a PyTorch causal reference model, versioned expert registry, signed checkpoint composition, authenticated artifact delivery, offline expert aggregation, and an opt-in Compute desktop laboratory.

The local reference run trained three independent low-rank experts, expanded with a genuine gated FFN, trained a sparse router and loop gates, and reloaded the composed model. The test data comprises deterministic synthetic token tasks. A process pipeline implements remote-stage semantics on local subprocess pipes, including gradient exchange and recovery from a failed stage.

Three fresh local CPU worker processes paired with a real HTTPS coordinator, fetched their own signed artifacts, trained separate experts and delivered persistent results. A repeated acknowledgement used the stored result and the coordinator committed a new expert checkpoint. This path uses the reference CPU runtime and has a 64 KiB result limit.

Production Compute Worker runs independent experts with resumable file-backed transport and aggregation. The follow-up adds durable multi-round scheduling, a supervised-token budget and cursor, separate learned Router and Loop stages, signed parameter export and cached inference. The three-device Fusion‑01, inter-host CUDA/MLX backward, regional coordination, peer serving and specialized holdout quality remain open. [Current acceptance and measurements](REACCEPTANCE.md)

- [Architecture and source audit](EXPERT_FUSION_ARCHITECTURE.md)
- [Model sizing](MODEL_ARCHITECTURE.md) · [Registry](EXPERT_REGISTRY.md) · [Router](ROUTER_DESIGN.md) · [FFN](FFN_EXPERTS.md) · [Loop](LOOP_TRANSFORMER.md) · [Expansion](DYNAMIC_EXPANSION.md)
- [Provisioning](AUTO_PROVISIONING.md) · [Pipeline](DISTRIBUTED_PIPELINE.md) · [Aggregation](FEDERATED_MESH.md) · [P2P](P2P_DISTRIBUTION.md)
- [Security](SECURITY_REPORT.md) · [Performance](PERFORMANCE_REPORT.md) · [Quality](QUALITY_REPORT.md) · [Scale](SCALABILITY_REPORT.md) · [Hardware](HARDWARE_COMPATIBILITY.md) · [Tests](TEST_REPORT.md)
- [User guide](USER_GUIDE.md) · [Migration](MIGRATION_GUIDE.md)
