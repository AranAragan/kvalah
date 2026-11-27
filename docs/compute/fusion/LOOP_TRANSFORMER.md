# Loop Transformer

Prelude, repeated block and coda use a schedule of physical layer indices and logical pass indices. The first pass is unchanged. Later passes interpolate a trainable sigmoid gate toward a candidate clipped to the old residual RMS. The reference can checkpoint activations and bypass KV caching during training.

Causal attention uses absolute position offsets and a distinct KV pair for each logical layer/pass. Sliding windows currently constrain attention only. They do not prune the allocated reference cache. Cross-loop KV sharing remains an experiment. CPU tests cover one through four passes, future-token perturbation and cached parity. The proposed 4/8/12-layer run matrix has not been measured at equal tokens or equal FLOPs.
