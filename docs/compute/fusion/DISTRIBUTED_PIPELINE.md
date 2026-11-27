# Pipeline forward and backward

The reference pipeline partitions residual gated FFNs into two or more stage subprocesses. It sends bounded length-prefixed JSON metadata and safetensors activations, then sends gradients in reverse order. It enforces a version ID and up to four in-flight microbatches. A frozen middle stage still returns input gradients. Stages have a heartbeat operation and RPC deadline.

The parent commits a complete checkpoint atomically after all gradients have been received and checked. The CPU test terminates a stage and confirms that the prior snapshot survives, then retries the same step and compares gradients and weights with a monolithic computation. This test uses local subprocess pipes. A CUDA device can be selected for reference stages, pending verification. Physical remote stage assignment, cross-host authenticated transport, MLX backward and optimizer-state persistence beyond SGD are open.
