# Test report

The reference tests cover LoRA and FFN autograd, Top-1 gradient flow, causal prefix invariance, cached and uncached equivalence, frozen backbone, Mistral attachment, staged gradient equivalence and recovery after terminating a pipeline subprocess. The JS integration covers version conflicts, signing, numerical aggregation, Train isolation, provisioning resume, TLS identity and ACL, and scheduling resource checks.

On Windows, the sequential local regression run passed 155 of 168 tests with 13 environment-dependent skips. The isolated run with the legacy archive passed its CLI regression and all targeted Fusion tests. A later focused run passed the seven Fusion tests after the live grant-disable check was added. The concurrent test run was refused by the existing Resource Governor with `low_memory`; the same Compute CLI smoke passed in the sequential run.

An actual Electron session in a separate profile exercised opt-in, the architecture calculator, expert creation and archiving. It also checked the layout at 450 px with no horizontal overflow. This used the development app with Electron 45.4.1. It did not exercise installer migration.

Use `KVALAH_COMPUTE_PYTHON` to enable the Python tests from the Node suite, and `KVALAH_V01_ZIP` with the legacy fixture where available. The pinned CPU GitHub Actions job includes the Fusion suite. Platform acceptance is documented in the hardware report.
