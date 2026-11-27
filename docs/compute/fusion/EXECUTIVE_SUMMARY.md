# Expert Fusion v1 research branch

Expert Fusion contains a PyTorch causal reference model, versioned expert registry, signed checkpoint composition, authenticated artifact delivery, offline expert aggregation, and an opt-in Compute desktop laboratory.

The local reference run trained three independent low-rank experts, expanded with a genuine gated FFN, trained a sparse router and loop gates, and reloaded the composed model. The test data comprises deterministic synthetic token tasks. A process pipeline implements remote-stage semantics on local subprocess pipes, including gradient exchange and recovery from a failed stage.

Three fresh local CPU worker processes paired with a real HTTPS coordinator, fetched their own signed artifacts, trained separate experts and delivered persistent results. A repeated acknowledgement used the stored result and the coordinator committed a new expert checkpoint. This path uses the reference CPU runtime and has a 64 KiB result limit.

The follow-up adds production single-expert training through Compute Worker, a visual builder, resumable file-backed transport, an independent queue and trusted Validation. The local hardware smoke ran one FFA-LoRA, one LoRA and one FFN step on the RTX 5070 with Ministral NF4. Real three-device Fusion-01, cross-host CUDA/MLX backward, sharded expert aggregation, public peer serving and the extended quality panel remain open. [Latest acceptance and measurements](P0_ACCEPTANCE.md)

- [Architecture and source audit](EXPERT_FUSION_ARCHITECTURE.md)
- [Model sizing](MODEL_ARCHITECTURE.md) · [Registry](EXPERT_REGISTRY.md) · [Router](ROUTER_DESIGN.md) · [FFN](FFN_EXPERTS.md) · [Loop](LOOP_TRANSFORMER.md) · [Expansion](DYNAMIC_EXPANSION.md)
- [Provisioning](AUTO_PROVISIONING.md) · [Pipeline](DISTRIBUTED_PIPELINE.md) · [Aggregation](FEDERATED_MESH.md) · [P2P](P2P_DISTRIBUTION.md)
- [Security](SECURITY_REPORT.md) · [Performance](PERFORMANCE_REPORT.md) · [Quality](QUALITY_REPORT.md) · [Scale](SCALABILITY_REPORT.md) · [Hardware](HARDWARE_COMPATIBILITY.md) · [Tests](TEST_REPORT.md)
- [User guide](USER_GUIDE.md) · [Migration](MIGRATION_GUIDE.md)
