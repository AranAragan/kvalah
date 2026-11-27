# Router design

Reference modes are static, domain, learned request-level, token-level, domain-informed, uniform and random. Evaluate a domain label as an oracle control only when its label is unknown to the learned method. Hard Top-1/2/4 uses stable ranking and normalized coefficients. During training a straight-through selected softmax term retains gradients at Top-1, where the derivative of the hard coefficient is zero. Load balance, entropy, per-expert counts and z-loss are computed. The training capacity cap applies in causal order per sequence. Unrouted positions use the shared FFN.

The initial reference experiment used a token router and supervised first-token domain loss. The 100% first-token classification result applies to the synthetic fixture's explicit domain markers.

The trusted Torch coordinator schedules Router training on masked Train rows with frozen verified expert checkpoints. It saves per-layer Router rows as F32 safetensors and pins the digest in the signed composition. Validation and inference load the saved rows and use learned Top‑1, Top‑2 or Top‑4 routing. A candidate can be published after trusted Validation. Routing quality on specialized held-out data and stability under skew remain open. [Reacceptance](REACCEPTANCE.md)
