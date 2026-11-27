# Hardware compatibility

Windows CPU was used for trusted evaluation, signed HTTPS and the local pipeline reference. The MSI RTX 5070 loaded the verified 3B weights and ran the production NF4 path. Ministral has 26 text layers, model width 3072, intermediate width 9216 and 8 key/value heads. [CUDA evidence](measurements/p0-cuda.jsonl)

The GPU tests were isolated from competing Compute, Hybrid and Inference workloads. Physical Fusion‑01, RTX 2070 CUDA execution, M1 Pro Native MLX and CUDA/MLX numerical parity are NOT RUN. See the current acceptance matrix for the scope of each result. [Reacceptance](REACCEPTANCE.md)
