# Migration guide

Close the participating worker and coordinator before switching releases. The installer can coexist in a separate user profile for a test. Use the database and model directories already configured in the app. Compute v0.3 creates an additive schema 3 migration and backs up the schema 2 database before migration. Existing adapters keep the same key layout, protocol version and file digests. Models and Python environments are reusable.

The v2 → v3 migration was exercised on an SQLite backup of the actual coordinator. Experiment, checkpoint, dataset, and model-variant records were hashed before and after. SQLite integrity passed. No update was installed over R60. To return to the old executable, restore its pre-migration DB backup on a separate copy; do not open a schema 3 DB with a v2 binary.

The release workflow builds the Windows x64 and macOS ARM64 installers and validates checksums. An in-place update on the original hardware research environment is deliberately outside this test.

For a hardware Smoke use a new state directory per device and pairing codes from a scratch lab. The command uses the same verified runtime and model files and leaves the original database outside its state directory.

```text
node compute/cli.mjs doctor --dir <scratch> --python <python> --backend cuda --model-dir <bf16> --variant cuda-nf4 --preflight
node compute/cli.mjs worker --dir <scratch> --pairing <private-one-time-invite> --python <python> --model-dir <bf16> --variant cuda-nf4 --gpu 10 --runtime-mode warm --runtime-idle 600 --transfer-mode auto --chunk-kib 1024 --i-consent
```

On Mac use the verified local conversion and variant mlx-4bit instead. Configure the ablations with cold/legacy, warm/legacy, and warm/auto. Run the pinned R10 continuation from a separate copied coordinator with its CAS intact. Compare the dry-run token count to the registered 172,536 before committing any new run. Read the consent before supplying the opt-in flag.
