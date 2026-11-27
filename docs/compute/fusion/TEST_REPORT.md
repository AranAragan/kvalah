# Test report

The reference tests cover LoRA and FFN autograd, Top-1 gradient flow, causal prefix invariance, cached and uncached equivalence, frozen backbone, Mistral attachment, staged gradient equivalence and recovery after terminating a pipeline subprocess. The JS integration covers version conflicts, signing, numerical aggregation, Train isolation, provisioning resume, TLS identity and ACL, and scheduling resource checks.

The initial CPU suite paired three fresh reference worker identities for the authenticated result path. Production tests cover a separate two-worker HTTPS path, a coordinator outage and lost acknowledgement, five sequential rounds and checkpoint/cursor restoration. The composition test performs several optimizer steps per stage, restores the Router after a service restart, rejects a modified parameter bundle and exercises cached generation with restored weights. [Current test and hardware scope](REACCEPTANCE.md)

The Windows Electron workflow uses an isolated profile to exercise opt-in, the architecture calculator at desktop and 450 px widths, expert creation, training and trusted Validation. Test builds and screenshots are recorded separately from physical GPU acceptance.

Use `KVALAH_COMPUTE_PYTHON` to enable the Python tests from the Node suite, and `KVALAH_V01_ZIP` with the legacy fixture where available. The pinned CPU GitHub Actions job includes the Fusion suite. Platform acceptance is documented in the hardware report.
