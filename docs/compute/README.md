# Kvalah Compute v0.2 — current state

Volunteer computing + federated LoRA fine-tuning (FFA-LoRA, SFT) inside the Kvalah desktop app, for a LAN of
the owner's devices. **Feature flag off by default.** Branch `feat/compute-v02`.

* Architecture: [ADR-0001](ADR-0001-architecture.md) · Protocol: [protocol.md](protocol.md) ·
  Threat model: [threat-model.md](threat-model.md) · Traceability: [requirements-map.md](requirements-map.md) ·
  Operations: [runbook.md](runbook.md) · Hardware tests: [HW-TEST.md](HW-TEST.md)
* Code: `compute/` (protocol, coordinator, worker, governor, datasets, registry, legacy import, report,
  controller, host, CLI, Python sidecar), UI `public/compute.js` + `public/compute-i18n.js`, routes
  `/api/compute/v2/*` in `server.mjs`, sensors/secret relay in `desktop.cjs`.
* Tests: `test/compute2-*.test.mjs` (protocol, coordinator, governor, e2e over HTTPS, python/backends,
  app routes + headless-Chrome UI, CLI). Python-backed tests need
  `KVALAH_COMPUTE_PYTHON=/path/to/python` (numpy, safetensors, torch, transformers, tokenizers, peft; mlx +
  mlx-vlm for the MLX parity part) and `KVALAH_V01_ZIP=/path/to/experiment-v01.zip` for M01.

## Verified (CPU, build box)
M01 bit-exact v0.1 reproduction; canonical schema/digests; Torch↔MLX parity on tiny Mistral and tiny
Mistral3 (CPU MLX); PEFT round-trip; SFT masking with the real Ministral tokenizer; coordinator fault
cases N01–N10; full app path (server → host → controller → coordinator/worker/sidecar) with a tiny model;
UI in headless Chrome (light/dark, EN/RU, 1024×768).

## Not verified (needs hardware) — see HW-TEST.md
CUDA NF4 on RTX 5070/2070, MLX on Metal (M1 Pro), real 3-device run, memory/throughput figures,
PEFT load of the real model. No measurements from these machines exist yet.
