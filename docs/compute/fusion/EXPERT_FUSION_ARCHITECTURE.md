# Expert Fusion architecture

The audited GitHub main was `e7b022d439a403c48d03b9f5aaa4351207046250`. Compute v0.3 already implements signed HTTPS, pinned certificates, nonce replay rejection, registered device states, leases, budget decisions, a persistent outbox, chunked update storage, canonical FFA-LoRA and an optional resident sidecar. Paths appear under `compute/coordinator`, `compute/worker`, `compute/protocol`, and `compute/governor`. The legacy experiment protocol and arithmetic continue to use those paths.

Fusion reuses the signing, device trust, bounded safetensors parser, CAS, cache and HTTPS client. Its registry and grants live separately under `compute-v2/fusion`. The reference runtime is separate from Compute's volunteer workers. Fusion assignment paths are enabled by a local marker and a private bind address. The desktop enables its local registry UI separately.

## Sources and design decisions

- FlexOlmo motivates independent expert training on a shared base and optional composition. This branch borrows that separation and evaluates a locally supervised router. FlexOlmo-scale training and data opt-out at inference require further experiments. [FlexOlmo](https://arxiv.org/abs/2507.07024)
- BTX branches domain models, uses the resulting FFNs as experts and learns a token router. Fusion preserves the common base and adds separately trained FFN branches. [Branch-Train-MiX](https://arxiv.org/abs/2403.07816)
- BAR independently adapts expert domains and learns a lightweight router. This branch implements separate fine-tuning and later routing, with supervised token tasks in its first experiment. The paper's mid-training, SFT and RL curriculum stays outside that experiment. [Branch-Adapt-Route](https://arxiv.org/abs/2604.18473)
- Repeated blocks with shared weights and gated residual updates are the applicable parts of GLM-5.4. Fusion's reference uses bounded RMS interpolation and independent logical KV slots. GLM's hybrid sparse KV and index reuse need separate architecture and parity work. [Z.ai GLM-5.4](https://z.ai/blog/glm-5.4?lang=en)
- Petals motivates stage replacement across unreliable links. This branch validates gradient exchange and failure recovery across processes on one host. [Petals](https://arxiv.org/abs/2312.08361)
- DiLoCo motivates separating the inner optimizer, aggregated pseudo-gradient and outer optimizer. Fusion has an explicit DiLoCo-inspired outer update. Paper-scale low-communication convergence remains unmeasured. [DiLoCo](https://arxiv.org/abs/2311.08105)
- QLoRA motivates a frozen NF4 backbone and higher-precision low-rank updates. Compute's local CUDA NF4 loader is reused for the one-pass Ministral integration entry point. [QLoRA](https://arxiv.org/abs/2305.14314)
