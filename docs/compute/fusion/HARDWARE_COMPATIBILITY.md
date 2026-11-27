# Hardware compatibility

Windows CPU via PyTorch was used for model, routing, signed HTTPS provisioning and pipeline integration. Ministral's production config was inspected. It has 26 text layers, model width 3072, intermediate width 9216 and 8 key/value heads. The pinned CUDA NF4 load entry point was not run against the 3B weights. A tiny in-memory Mistral test exercises the same one-pass attachment API.

No Fusion GPU benchmark ran concurrently with Compute, Hybrid or Inference. Fusion-01 across RTX 5070, RTX 2070 and M1 Pro, native MLX Fusion and CUDA/MLX numerical parity are NOT TESTED. R60 Optimized acceptance remains open. Run a physically supervised experiment only after the outstanding full-stack implementation and the hardware isolation check.
