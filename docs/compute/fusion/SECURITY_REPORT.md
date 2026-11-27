# Fusion security

The lab uses paired Compute device identities, pinned TLS, signed timestamps/nonces and the existing rate limit. Artifact grants are authenticated for an approved device, expiring, revocable and limited to digests in that grant. Dataset sealing requires explicit redistribution and rejects overlapping row IDs and groups. The P2P source callback interface attempts no automatic network discovery. The reference pipeline accepts bounded safetensors and JSON; the local model loader requires a verified digest and disables remote model code.

The branch has no public volunteer endpoint. Signatures and digests authenticate scope and bytes. They do not attest that training was honest, detect a backdoor or substitute for independent trusted replay. There is no Sybil-resistance claim. A trusted Validation loop, randomized replay, robust aggregation experiments and security review are still required for volunteer operation.
