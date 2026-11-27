# Expert registry

SQLite transactions protect expert states, immutable checkpoint versions, checkpoint ancestry, Validation assessments, signed composition versions and the active pointer. Weight blobs are content-addressed. Keys, compatible backbone and tokenizer digests, runtime, layer placement, dataset manifest, training config, tensor shapes and frozen parts are checked before registration or updates.

A clone uses a different Expert ID and can reuse identical CAS bytes. Assessment is pinned to a checkpoint version and a distinct Validation digest. Candidate composition requires every referenced version to have a passing expert assessment. The local administrator supplies these assessment results through the CLI. An assessment is an administrative record, pending a fully integrated trusted evaluator.

Composition export is lightweight manifest assembly. The small Python model separately exports and reloads a complete safetensors state. General streamed monolithic export and arbitrary PEFT export for Fusion layouts remain open. Existing Compute PEFT export is available for its existing architectures.
