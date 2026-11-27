# Test report

The targeted Windows run passed 48 protocol, coordinator, governor, transfer, rollback and sidecar tests. It included two actual HTTPS E2E runs: three mock workers with loss and restart, and three tiny CPU-model workers through evaluation and PEFT export. CPU and mock results are marked at source. They do not substitute for CUDA and MLX fleet smoke.

With a local Compute Python runtime and the legacy archive, the final Windows suite reported 161 tests, 150 passed, 11 environment-dependent skips and no failures. The application integration exercised the lab through the server, host and controller. A separate rerun passed all five HTTPS, upload, outbox and resource policy tests. The added coordinator tests verified the minimum-token quorum, fixed budget of adaptive slots and refusal of oversized finite adapter deltas.

Reproduction:

```text
npm run check
npm test
node --test test/compute3-transfer.test.mjs test/compute2-coordinator.test.mjs
python scripts/compute-v03/runtime.py --out runtime-mock.jsonl
node scripts/compute-v03/heartbeat.mjs heartbeat.jsonl
node scripts/compute-v03/scenarios.mjs scenarios.jsonl
```

For Python integration set KVALAH_COMPUTE_PYTHON to a local venv containing the Compute runtime and KVALAH_V01_ZIP to the legacy archive where available. Run HTTPS tests in an environment allowing loopback sockets. The hardware experiment needs the original R60 archive, installed model and a read-only coordinator DB parameter.
