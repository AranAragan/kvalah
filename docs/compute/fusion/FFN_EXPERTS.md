# Full FFN experts

A real FFN uses an independent SiLU gate, up projection and down projection. Residual initialization zeros the down projection. Forward is then equivalent to the base, while the down projection sees a gradient on the first backward pass. The gate and up projections receive a gradient after the down projection moves.

The reference supports full, down-only and low-rank training of this FFN. Replacement can copy compatible dequantized base FFN tensors. Both modes retain the shared frozen base for fallback. The first real-model candidate should use a small FFN on one layer. Large weights require sharding beyond the current single-artifact limit.
