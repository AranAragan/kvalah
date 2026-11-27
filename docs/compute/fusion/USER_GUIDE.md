# Expert Fusion user guide

In the development application open Compute, enable Compute, select Laboratory, open Expert Fusion and enable it. Overview displays the registry and active composition. Architecture estimates parameters, gradients, optimizer state and KV memory. Experts accepts a JSON expert manifest and shows registered versions. Devices displays the current Compute devices. Model versions shows the candidate list and enables approved activation and rollback.

Run the small reference from the repository with the existing Compute Python environment. On Windows PowerShell:

```powershell
$env:PYTHONPATH = (Resolve-Path compute/python).Path
& $python -m kvalah_compute.fusion_lab research/fusion-cpu-run
& $python compute/python/tests/check_fusion.py
node scripts/fusion-simulate.mjs research/fusion-scale.jsonl 100000
```

Set `$python` to the known local Compute Python executable. Use an empty output directory. The reference writes weights and metrics there. `node compute/fusion/cli.mjs ls <fusion-state-dir>` lists installed expert and composition records for the lab. Use a separate scratch Compute root for coordinator tests. The grant CLI uses an existing separately approved device identity. The bounded `worker-train-reference` CLI handles delivery, CPU training and result submission for a signed reference grant. Run `KVALAH_COMPUTE_PYTHON`-enabled `test/fusion.test.mjs` to reproduce fresh identity, provisioning and result retry on three workers. A full clean-machine Fusion-01 procedure depends on still-open automatic runtime and GPU training integration.
