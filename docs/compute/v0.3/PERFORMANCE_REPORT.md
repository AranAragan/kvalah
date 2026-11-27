# Performance report

Historical R60 took 16,599 s. Device-level worker compute summed to 916.18 s and model loading to 1,580.08 s across overlapping devices. These sums are separate from elapsed wall time. The historical 10× target is NOT TESTED on v0.3.

On 30 committed R60 payloads, LZ4 retained a median 99.92% of bytes with 2.68 ms encode and 2.09 ms decode. Zstandard level 3 retained 93.82% with 7.11 ms encode and 3.85 ms decode. Every decoded buffer matched its source. Transport still uses raw canonical B; codec timing plus ideal serialization estimates do not measure full-round speed.

Runtime tests record model starts, hit counts, immutable A, exact update digests, synchronized compute and allocated/reserved memory. Real R60 Optimized requires a fresh three-device run from R10 with the original 50-round schedule and 172,536 supervised tokens. No test modified or upgraded R60.

**MEASURED on RTX 5070.** A fresh Warm process completed 50 one-step FFA-LoRA jobs on archived R60 rows. It loaded the model once in 16.899 s and reused it on the following 49 jobs. The median resident job took 0.358 s, excluding the intentional pacing pause. The repeated input produced exactly the same SHA-256 in a separate Cold process and after a Warm cache hit. Frozen A kept the same SHA-256 on all 50 jobs. Peak CUDA reserved memory was 3.03 GiB. Explicit release succeeded. An earlier attempt stopped between Cold and Warm runs at the free-VRAM pre-load threshold; the Warm retry started in a fresh process. This is a single-device residency test.
