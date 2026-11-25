# Compute fixtures

`smoke-sft-v1.jsonl` — 34 short software-QA / tool-call / decomposition SFT rows written for this project
(CC0-1.0). They are **synthetic smoke data** (`quality_flags: ["synthetic","smoke_only"]`): good for
protocol and pipeline smoke tests and the 2×3 Smoke run, not for research claims. One row is an exact
duplicate on purpose (dedup test). The v0.2 research target (3 000 / 300 / 200 vetted rows) is
`DATASET_REQUIRED`: no such corpus is shipped.

Model weights, v0.1 checkpoints and updates are never committed here. Tests that reproduce v0.1
(M01) read `experiment-v01.zip` from the path in `KVALAH_V01_ZIP`, or are reported as skipped.
