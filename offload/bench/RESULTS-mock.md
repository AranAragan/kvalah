# Kvalah offload benchmark — MOCK

_Cloud costs are estimates from token counts (baseline: full read of the listed files) at parameter prices, not measured usage. Paired real runs: bench/paired.mjs, bench/RESULTS-real.md._

provider=mock model=mock ctx=16384 seed=2026 prices in/out per 1M=3/15 USD

| task | level | strategy | ok | recall | verified | cloud tokens w/o | cloud in+out with | net tokens saved | saved USD | local tok | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ci-failures | L2 | map-reduce | ✔ | 1 | 12/12 | 57709 | 1219+38 | 56452 | 0.1689 | 0 | 73 |
| doc-summary | L2 | direct | ✔ | 1 | 6/6 | 4104 | 896+48 | 3160 | 0.008904 | 0 | 8 |
| security-review | L2 | retrieve | ✔ | 1 | 2/2 | 39267 | 1137+47 | 38083 | 0.113685 | 0 | 39 |
| who-imports-money | L1 | deterministic | ✔ | 1 | - | 54 | 135+15 | -96 | -0.000468 | 0 | 60 |
| find-definition | L1 | deterministic | ✔ | 1 | - | 48 | 132+14 | -98 | -0.000462 | 0 | 2 |
| tiny-inline-transform | L2 | direct | ✔ | 1 | 0/3 | 0 | 651+32 | -683 | -0.002433 | 0 | 1 |

**Totals:** without offload 0.303546 USD, with offload 0.01542 USD, saved 0.288126 USD (96818 cloud tokens), mean recall 1.

_Mock provider = idealized extractor, so recall measures the pipeline (chunking, retrieval, verification), not model quality. Use --provider ollama for real quality._
