# Loop Transformer

Prelude, repeated block and coda use a schedule of physical layer indices and logical pass indices. The first pass is unchanged. Later passes interpolate a trainable sigmoid gate toward a candidate clipped to the old residual RMS. The reference can checkpoint activations and bypass KV caching during training.

Causal attention uses absolute position offsets and a distinct KV pair for each logical layer and pass. The CPU reference's sliding window constrains attention while keeping all cached tokens. The production Torch composition uses a distinct Transformers DynamicCache slot for each repeated logical layer and the backbone's cache-layer implementation. Loop Adaptation trains and stores gates separately from the Router and experts. Evaluation and inference verify and load the saved gates. The proposed 4/8/12-layer run matrix has not been measured at equal tokens or equal FLOPs. [Reacceptance](REACCEPTANCE.md)
