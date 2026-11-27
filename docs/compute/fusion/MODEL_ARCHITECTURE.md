# Model architecture

The reference model uses learned token and position embeddings, pre-normalized causal attention, a frozen gated base FFN and a frozen output head. A token may use the base alone, a fixed expert selection, a fixed weighted combination, or routed experts. Residual and replacement FFNs are separate construction modes. Loop configuration modifies execution order and shares objects and parameters.

The Mistral adapter replaces validated text-layer MLP entry points in the loaded local model and leaves the original attention, causal masking and positions intact. It supports one-pass operation and per-request adapter selection. Multi-pass Ministral and the original model's vision path were not exercised.

For the pinned text config, a 3072 × 9216 × 3 bias-free FFN has 84,934,656 parameters. At 26 layers the added FP32 parameters would occupy about 8.23 GiB before optimizer state or activations. The calculator accepts large virtual layouts without allocation and reports an upper bound on active parameters. The logical layer count is tracked separately. Loop gate scalars are counted as parameters, repeated weights are counted once.
