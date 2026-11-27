# Router design

Reference modes are static, domain, learned request-level, token-level, domain-informed, uniform and random. Evaluate a domain label as an oracle control only when its label is unknown to the learned method. Hard Top-1/2/4 uses stable ranking and normalized coefficients. During training a straight-through selected softmax term retains gradients at Top-1, where the derivative of the hard coefficient is zero. Load balance, entropy, per-expert counts and z-loss are computed. The training capacity cap applies in causal order per sequence. Unrouted positions use the shared FFN.

The initial experiment used a token router and supervised first-token domain loss. 100% first-token classification refers to the synthetic fixture's explicit domain markers. Practical routing quality, collapse under skew, and full oracle/random/uniform comparisons remain open.
