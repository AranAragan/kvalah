# Expert Fusion user guide

Open Compute, select Laboratory, open Expert Fusion and enable it. Architecture reads the installed model and estimates parameters, gradients, optimizer state and KV memory. Create an expert with the form and select an audited dataset for that model. In the training dialog choose the worker policy, maximum rounds and epochs, and supervised-token budget. Each round reads Train in manifest order from the current cursor. Resume advances from the last committed checkpoint. An incomplete final optimizer step in an epoch is skipped.

Model versions can schedule learned token routing and Loop adaptation. Choose overlapping validated experts for learned routing and at least two passes for Loop adaptation. The coordinator runs Router Training, Loop Adaptation and trusted Validation in order. A paused stage restarts with its original configuration and retains any earlier completed checkpoint. Publish the candidate after it passes Validation, then use the local inference form. The version is bound to the expert, Router and Loop checkpoint digests.

Run the small reference from the repository with the existing Compute Python environment. On Windows PowerShell:

```powershell
$env:PYTHONPATH = (Resolve-Path compute/python).Path
& $python -m kvalah_compute.fusion_lab research/fusion-cpu-run
& $python compute/python/tests/check_fusion.py
node scripts/fusion-simulate.mjs research/fusion-scale.jsonl 100000
```

Set `$python` to the local Compute Python executable. Use an empty output directory. The reference writes weights and metrics there. `node compute/fusion/cli.mjs ls <fusion-state-dir>` lists expert and composition records. `export-composition-parameters` takes a composition hash and a new output folder. `import-composition-parameters` takes that folder and the trusted signing key. Import requires the exact expert checkpoints and their local Validation records. On another coordinator, the imported candidate must go through local Validation before publication. Use `test/fusion-production.test.mjs` with `KVALAH_COMPUTE_PYTHON` for the coordinator and worker checks. [Current hardware acceptance](REACCEPTANCE.md)
