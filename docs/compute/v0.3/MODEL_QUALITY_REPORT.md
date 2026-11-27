# Model quality

Historical independent Test results on 273 held-out examples and 31,004 supervised tokens:

| Model | NLL | Token accuracy |
|---|---:|---:|
| R0 | 2.132783 | 53.75% |
| R10 | 2.080364 | 54.47% |
| R60 | 1.873763 | 57.24% |
| Sequential FedAvg | 1.871097 | 57.28% |
| Central FFA-LoRA | 1.700102 | 60.04% |

The 10-task historical blind comparison gave 29/60, 31/60 and 27/60 for R0, R10 and R60. Sixteen of 30 answers reached the generation cap. These checks did not establish an advantage for R60 on user answers. A 100–200 task evaluation across all seven arms requires final R60 Optimized and algorithm candidates and remains NOT TESTED. Use repeatable test oracles where possible, store truncation separately and keep the key sealed for open-ended rating.
